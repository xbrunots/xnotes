'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { GoogleDriveOAuth, SCOPE } = require('../desktop/drive-oauth.cjs');
const { json } = require('./helpers/fake-drive.cjs');

const config = { installed: { client_id: 'test-desktop.apps.googleusercontent.com', client_secret: 'test-desktop-public-client-secret', auth_uri: 'https://attacker.invalid', token_uri: 'https://attacker.invalid' } };
function secureStorage() {
  const key = crypto.randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    }
  };
}
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-oauth-'));
  const safeStorage = secureStorage(), requests = [];
  let mode = 'success';
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(request.body); requests.push(params);
    if (mode === 'invalid_grant') return json({ error: 'invalid_grant', error_description: 'do not echo server secrets' }, 400);
    return json({ access_token: 'test-access-token-private', refresh_token: 'test-refresh-token-private', expires_in: 3600, token_type: 'Bearer', scope: SCOPE });
  };
  const auth = new GoogleDriveOAuth({ dataDir: dir, safeStorage, fetch: fetchImpl, ...options });
  t.after(async () => { await auth.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, auth, safeStorage, requests, fetch: fetchImpl, setMode: value => { mode = value; } };
}
async function callback(value, { badState = false } = {}) {
  const authURL = new URL(value), redirect = new URL(authURL.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state', badState ? 'wrong-state' : authURL.searchParams.get('state')); redirect.searchParams.set('code', 'test-code');
  const response = await fetch(redirect, { headers: { Connection: 'close' } });
  await response.text(); return response.status;
}

test('Desktop OAuth uses fixed HTTPS Google endpoints, random loopback, state validation and S256 PKCE', async t => {
  let opened;
  const fixture = await setup(t, { openExternal: async url => {
    opened = new URL(url);
    assert.equal(opened.origin + opened.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(opened.searchParams.get('scope'), SCOPE);
    assert.equal(opened.searchParams.get('prompt'), 'consent select_account');
    assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(new URL(opened.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
    assert.equal(await callback(url, { badState: true }), 403);
    const redirect = new URL(opened.searchParams.get('redirect_uri'));
    await new Promise((resolve, reject) => {
      const request = http.get(redirect, { headers: { Host: 'attacker.invalid' } }, response => { assert.equal(response.statusCode, 400); response.resume(); response.on('end', resolve); }); request.on('error', reject);
    });
    assert.equal(await callback(url), 200);
  } });
  await fixture.auth.configure(config);
  const status = await fixture.auth.connect();
  assert.equal(status.connected, true); assert.equal(status.configured, true);
  const exchange = fixture.requests[0];
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('redirect_uri'), opened.searchParams.get('redirect_uri'));
  assert.equal(crypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), opened.searchParams.get('code_challenge'));
  const vault = await fs.readFile(path.join(fixture.dir, 'google-drive-credentials.enc'));
  assert.ok(!vault.includes(Buffer.from('test-refresh-token-private')));
  assert.ok(!vault.includes(Buffer.from('test-desktop-public-client-secret')));
  assert.ok(!JSON.stringify(status).includes('test-access-token-private'));
});

test('encrypted credentials survive restart with the same configured client and refresh without another browser login', async t => {
  const fixture = await setup(t, { openExternal: callback });
  await fixture.auth.configure(config); await fixture.auth.connect();
  const connectionId = fixture.auth.status.connectionId;
  const restarted = new GoogleDriveOAuth({ dataDir: fixture.dir, safeStorage: fixture.safeStorage, fetch: fixture.fetch, config });
  await restarted.init();
  assert.equal(restarted.status.connected, true); assert.equal(restarted.status.connectionId, connectionId);
  assert.equal(await restarted.getAccessToken(), 'test-access-token-private');
  assert.equal(fixture.requests.at(-1).get('grant_type'), 'refresh_token');
  assert.equal(fixture.requests.at(-1).has('code'), false);
  await restarted.configure(config); assert.equal(restarted.status.connected, true);
  await restarted.close();
});

test('refresh is single-flight and invalid_grant explicitly requires reconnect without exposing server details', async t => {
  let now = 1000;
  const fixture = await setup(t, { openExternal: callback, now: () => now });
  await fixture.auth.configure(config); await fixture.auth.connect();
  const calls = fixture.requests.length;
  assert.equal(await fixture.auth.getAccessToken(), 'test-access-token-private'); assert.equal(fixture.requests.length, calls);
  now += 3601000;
  await Promise.all([fixture.auth.getAccessToken(), fixture.auth.getAccessToken()]);
  assert.equal(fixture.requests.length, calls + 1);
  fixture.setMode('invalid_grant'); fixture.auth.invalidateAccessToken();
  await assert.rejects(fixture.auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
  assert.equal(fixture.auth.status.connected, false); assert.match(fixture.auth.status.error, /Conecte novamente/);
  assert.ok(!fixture.auth.status.error.includes('server secrets'));
  const reopened = new GoogleDriveOAuth({ dataDir: fixture.dir, safeStorage: fixture.safeStorage });
  await reopened.init(); assert.equal(reopened.status.connected, false); assert.equal(reopened.status.configured, true);
  await reopened.close();
});

test('unavailable or plaintext safeStorage never persists credentials; web OAuth clients are rejected', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.auth.configure({ web: { client_id: config.installed.client_id } }), { code: 'AUTH_CONFIGURATION' });
  await assert.rejects(fixture.auth.connect(), { code: 'AUTH_NOT_CONFIGURED' });
  const auth = new GoogleDriveOAuth({ dataDir: fixture.dir, safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(auth.configure(config), { code: 'AUTH_STORAGE_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(fixture.dir), []);
  await auth.close();
});

test('DPAPI/decryption failure preserves encrypted bytes and leaves offline notes usable', async t => {
  const fixture = await setup(t, { openExternal: callback });
  await fixture.auth.configure(config); await fixture.auth.connect();
  const file = path.join(fixture.dir, 'google-drive-credentials.enc'), before = await fs.readFile(file);
  const otherWindowsUser = new GoogleDriveOAuth({ dataDir: fixture.dir, safeStorage: secureStorage() });
  const status = await otherWindowsUser.init();
  assert.equal(status.connected, false); assert.equal(status.requiresAuth, true); assert.match(status.error, /preservados/);
  assert.deepEqual(await fs.readFile(file), before); await otherWindowsUser.close();
});

test('disconnect cancels the pending loopback flow and retains only encrypted client configuration', async t => {
  let browserOpened;
  const opened = new Promise(resolve => { browserOpened = resolve; });
  const fixture = await setup(t, { openExternal: async url => { browserOpened(url); } });
  await fixture.auth.configure(config);
  const connecting = fixture.auth.connect();
  await opened;
  const rejected = assert.rejects(connecting, { code: 'AUTH_CANCELLED' });
  await fixture.auth.disconnect(); await rejected;
  assert.equal(fixture.requests.length, 0); assert.equal(fixture.auth.status.connected, false); assert.equal(fixture.auth.status.configured, true);
});

test('initial embedded client configuration with unavailable secure storage does not block offline startup', async t => {
  const fixture = await setup(t);
  const auth = new GoogleDriveOAuth({ dataDir: fixture.dir, config, safeStorage: { isAsyncEncryptionAvailable: async () => false } });
  const status = await auth.init();
  assert.equal(status.configured, true); assert.equal(status.connected, false); assert.match(status.error, /notas locais/);
  assert.deepEqual(await fs.readdir(fixture.dir), []);
  await auth.close();
});

test('OAuth browser wait has a bounded timeout and closes its loopback server', async t => {
  let redirect;
  const fixture = await setup(t, { authTimeoutMs: 30, openExternal: async url => { redirect = new URL(url).searchParams.get('redirect_uri'); } });
  await fixture.auth.configure(config);
  await assert.rejects(fixture.auth.connect(), { code: 'AUTH_CANCELLED' });
  await assert.rejects(fetch(redirect));
  assert.equal(fixture.requests.length, 0);
});
