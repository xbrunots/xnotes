'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadDesktopClient } = require('../desktop/drive-client.cjs');
const { stageDesktopClient } = require('../scripts/package-portable.cjs');

const identity = name => ({ client_id: name + '.apps.googleusercontent.com', client_secret: 'desktop-identity-' + name });
const installed = name => ({ installed: { ...identity(name), project_id: 'notes-fixture', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', redirect_uris: ['http://localhost'] } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-client-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return target;
  };
  return { root, write, load: env => loadDesktopClient({ appRoot: root, env: env || {} }) };
}

test('absence returns undefined without inventing a client or creating files', async t => {
  const { root, load } = await fixture(t);
  assert.equal(await load(), undefined); assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await stageDesktopClient({ appRoot: root, env: {} }), false); assert.deepEqual(await fs.readdir(root), []);
});

test('application identity priority is environment, explicit file, local build, then packaged resource', async t => {
  const { write, load } = await fixture(t);
  await write('app/google-client.json', identity('packaged'));
  assert.deepEqual(await load(), identity('packaged'));
  await write('build/google-oauth.local.json', installed('local'));
  assert.deepEqual(await load(), identity('local'));
  const file = await write('developer/desktop.json', installed('explicit'));
  assert.deepEqual(await load({ NOTES_GOOGLE_CLIENT_FILE: file }), identity('explicit'));
  assert.deepEqual(await load({ NOTES_GOOGLE_CLIENT_ID: identity('env').client_id, NOTES_GOOGLE_CLIENT_SECRET: identity('env').client_secret, NOTES_GOOGLE_CLIENT_FILE: 'ignored-because-lower-priority' }), identity('env'));
  assert.deepEqual(await load({ NOTES_GOOGLE_CLIENT_ID: identity('public-no-secret').client_id }), { client_id: identity('public-no-secret').client_id });
});

test('provided invalid environment or file configuration fails rather than falling back to another identity', async t => {
  const { root, write, load } = await fixture(t);
  await write('app/google-client.json', identity('valid-fallback'));
  for (const env of [
    { NOTES_GOOGLE_CLIENT_ID: '' }, { NOTES_GOOGLE_CLIENT_SECRET: 'do-not-echo-private-value' },
    { NOTES_GOOGLE_CLIENT_ID: 'not-a-client' }, { NOTES_GOOGLE_CLIENT_ID: identity('env').client_id, NOTES_GOOGLE_CLIENT_SECRET: 42 },
    { NOTES_GOOGLE_CLIENT_FILE: '' }, { NOTES_GOOGLE_CLIENT_FILE: 'relative.json' }, { NOTES_GOOGLE_CLIENT_FILE: path.join(root, 'missing.json') }
  ]) await assert.rejects(load(env), error => error.code === 'AUTH_CLIENT_CONFIGURATION' && !error.message.includes('do-not-echo-private-value'));
  await write('build/google-oauth.local.json', '{ "client_id": "private-unparseable-value" ');
  await assert.rejects(load(), error => error.code === 'AUTH_CLIENT_CONFIGURATION' && error.source === 'local-build' && !error.message.includes('private-unparseable-value'));
});

test('web clients, tokens, account data, private keys and arbitrary endpoints are rejected', async t => {
  const { root, write, load } = await fixture(t);
  const cases = [
    { web: identity('web') }, { installed: identity('desktop'), web: identity('web') },
    { ...identity('flat'), refresh_token: 'PRIVATE_REFRESH_TOKEN' },
    { ...identity('flat'), access_token: 'PRIVATE_ACCESS_TOKEN' },
    { ...identity('flat'), email: 'private@example.invalid' },
    { type: 'service_account', client_id: identity('service').client_id, private_key: 'PRIVATE_KEY' },
    { installed: { ...identity('desktop'), refresh_token: 'PRIVATE_REFRESH_TOKEN' } },
    { installed: { ...identity('desktop'), auth_uri: 'https://attacker.invalid/auth' } },
    { installed: { ...identity('desktop'), token_uri: 'http://oauth2.googleapis.com/token' } },
    { installed: { ...identity('desktop'), redirect_uris: ['https://attacker.invalid/callback'] } },
    { installed: { ...identity('desktop'), redirect_uris: ['http://localhost.attacker.invalid/callback'] } },
    { ...identity('first'), clientId: identity('second').client_id }
  ];
  for (const value of cases) {
    const file = await write('provided.json', value);
    await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: file }), error => error.code === 'AUTH_CLIENT_CONFIGURATION' && !/PRIVATE_|private@example/.test(error.message));
  }
  assert.equal(await fs.stat(path.join(root, 'app/google-client.json')).then(() => true, () => false), false);
});

test('client source is bounded UTF-8 JSON and must be a regular file', async t => {
  const { root, write, load } = await fixture(t);
  const large = await write('large.json', ' '.repeat(64 * 1024 + 1));
  await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: large }), /64 KiB/);
  const invalidUTF8 = await write('invalid-utf8.json', Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: invalidUTF8 }), /UTF-8/);
  const directory = path.join(root, 'directory.json'); await fs.mkdir(directory);
  await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: directory }), /arquivo regular/);
  const valid = JSON.stringify(identity('exact-boundary'));
  const exact = await write('exact.json', valid + ' '.repeat(64 * 1024 - Buffer.byteLength(valid)));
  assert.deepEqual(await load({ NOTES_GOOGLE_CLIENT_FILE: exact }), identity('exact-boundary'));
});

test('file symlinks or parent junctions cannot redirect the identity loader', async t => {
  const { root, write, load } = await fixture(t);
  const target = await write('real/client.json', installed('real'));
  const link = path.join(root, 'linked.json');
  try {
    await fs.symlink(target, link, 'file');
    await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: link }), /Links simbólicos/);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Windows junction creation is available even when file symlink privileges
    // are not enabled. It exercises the parent-link boundary independently.
  }
  const linkedDirectory = path.join(root, 'linked-directory');
  await fs.symlink(path.dirname(target), linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(load({ NOTES_GOOGLE_CLIENT_FILE: path.join(linkedDirectory, 'client.json') }), /Links simbólicos/);
});

test('portable stamping embeds only sanitized application identity and preserves UI output and user data', async t => {
  const { root, write, load } = await fixture(t);
  await write('build/google-oauth.local.json', installed('registered-fixture'));
  const renderer = await write('app/renderer.js', 'existing compiled renderer');
  const userData = await write('notes-data/workspace.json', '{"notes":["do not alter"]}');
  assert.equal(await stageDesktopClient({ appRoot: root, env: {} }), true);
  const staged = JSON.parse(await fs.readFile(path.join(root, 'app/google-client.json'), 'utf8'));
  assert.deepEqual(staged, identity('registered-fixture'));
  assert.deepEqual(Object.keys(staged).sort(), ['client_id', 'client_secret']);
  assert.equal(await fs.readFile(renderer, 'utf8'), 'existing compiled renderer');
  assert.equal(await fs.readFile(userData, 'utf8'), '{"notes":["do not alter"]}');
  // The UI build can recreate renderer files without removing this independent
  // stamp. A packaged runtime resolves the sanitized resource without build/.
  await fs.rm(path.join(root, 'build'), { recursive: true });
  assert.deepEqual(await load(), staged);
  assert.ok(!(await fs.readdir(path.join(root, 'app'))).some(name => name.endsWith('.tmp')));
});

test('invalid build input fails before changing a previously staged identity', async t => {
  const { root, write } = await fixture(t);
  const resource = await write('app/google-client.json', identity('existing'));
  await write('build/google-oauth.local.json', { installed: { ...identity('bad'), refresh_token: 'PRIVATE_MUST_NOT_SHIP' } });
  const previous = await fs.readFile(resource, 'utf8');
  await assert.rejects(stageDesktopClient({ appRoot: root, env: {} }), { code: 'AUTH_CLIENT_CONFIGURATION' });
  assert.equal(await fs.readFile(resource, 'utf8'), previous);
});
