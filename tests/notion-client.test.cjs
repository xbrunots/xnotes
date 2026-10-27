'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { NotionClient } = require('../desktop/notion-client.cjs');

const ORIGIN = 'https://mcp.notion.com';
const PRIVATE = 'fixture-private-notion-';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function storage() {
  const key = crypto.randomBytes(32);
  return {
    isAvailable() { return true; },
    encrypt(clear) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decrypt(bytes) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); }
  };
}
async function callback(authorization, options = {}) {
  const auth = new URL(authorization), url = new URL(auth.searchParams.get('redirect_uri'));
  url.searchParams.set('state', options.state ?? auth.searchParams.get('state'));
  if (options.error) url.searchParams.set('error', options.error);
  else url.searchParams.set('code', PRIVATE + 'authorization-code');
  if (options.path) url.pathname = options.path;
  if (options.duplicateState) url.searchParams.append('state', auth.searchParams.get('state'));
  if (options.duplicateCode) url.searchParams.append('code', 'duplicate');
  if (options.issuer) url.searchParams.set('iss', options.issuer);
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || 'GET', headers: { Connection: 'close', ...(options.host ? { Host: options.host } : {}) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
}
function sse(message, { hanging = false, onCancel } = {}) {
  const text = ': heartbeat\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) + '\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(message) + '\r\n\r\n';
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({
    start(controller) { if (hanging) { controller.enqueue(Buffer.from(': waiting\n\n')); return; } for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7)); controller.close(); },
    cancel() { onCancel?.(); }
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-notion-client-'));
  const fixture = { directory, clock: 1700000000000, safe: storage(), requests: [], registrations: [], tokens: [], rpc: [], version: 0, rejectToken: null, tokenError: null, rpcHandler: null, metadataHandler: null };
  fixture.fetch = async (url, request = {}) => {
    assert.equal(new URL(url).origin, ORIGIN, 'credentials must never leave the official Notion origin');
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    fixture.requests.push({ url, request });
    const endpoint = new URL(url).pathname;
    if (endpoint.startsWith('/.well-known/')) {
      assert.equal(request.headers.Authorization, undefined);
      if (fixture.metadataHandler) return fixture.metadataHandler(url, request);
      if (endpoint === '/.well-known/oauth-protected-resource') return json({ resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: ['default'] });
      return json({ issuer: ORIGIN, authorization_endpoint: ORIGIN + '/authorize', token_endpoint: ORIGIN + '/token', registration_endpoint: ORIGIN + '/register', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['default', 'ema_issuer:manage'] });
    }
    if (endpoint === '/register') {
      assert.equal(request.headers.Authorization, undefined);
      const registration = JSON.parse(request.body); fixture.registrations.push(registration);
      assert.equal(new URL(registration.redirect_uris[0]).hostname, '127.0.0.1');
      // Registration cannot begin until the callback port is already reserved.
      const checkListener = await fetch(registration.redirect_uris[0], { headers: { Connection: 'close' } });
      assert.equal(checkListener.status, 403); await checkListener.text();
      return json({ client_id: PRIVATE + 'client-id', redirect_uris: registration.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
    }
    if (endpoint === '/token') {
      assert.equal(request.headers.Authorization, undefined);
      const parameters = new URLSearchParams(request.body); fixture.tokens.push(parameters);
      assert.equal(parameters.get('resource'), ORIGIN); assert.equal(parameters.has('client_secret'), false);
      if (fixture.tokenError) return json({ error: fixture.tokenError, error_description: PRIVATE + 'never-echo-provider-details' }, 400);
      fixture.version++;
      return json({ access_token: PRIVATE + 'access-' + fixture.version, refresh_token: PRIVATE + 'refresh-' + fixture.version, token_type: 'Bearer', expires_in: 3600, scope: 'default', ...(parameters.get('grant_type') === 'authorization_code' && !fixture.omitIdentity ? { workspace_id: 'workspace-test', workspace_name: 'Workspace de teste', user_id: 'user-test' } : {}) });
    }
    assert.equal(endpoint, '/mcp');
    const message = JSON.parse(request.body); fixture.rpc.push({ message, request });
    if (request.headers.Authorization === 'Bearer ' + fixture.rejectToken) return json({ error: 'unauthorized', message: PRIVATE + 'never-echo' }, 401);
    if (fixture.rpcHandler) { const response = await fixture.rpcHandler(message, request); if (response) return response; }
    if (message.method === 'notifications/initialized') { assert.equal(message.id, undefined); return new Response(null, { status: 202 }); }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-notion', version: 'test' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'notion-fetch', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }, { name: 'notion-create-pages', inputSchema: { type: 'object' } }] };
    else { assert.equal(message.method, 'tools/call'); result = { content: [{ type: 'text', text: JSON.stringify({ title: 'Página sintética', id: message.params.arguments.id || 'page-test' }) }] }; }
    return json({ jsonrpc: '2.0', id: message.id, result }, 200, message.method === 'initialize' ? { 'Mcp-Session-Id': 'fixture-session' } : {});
  };
  fixture.client = new NotionClient({ dataDir: directory, secureStorage: fixture.safe, fetchImpl: fixture.fetch, now: () => fixture.clock, openExternal: async url => { assert.equal(await callback(url), 200); }, ...options });
  fixture.vaultPath = path.join(directory, 'notion-credentials.enc');
  t.after(async () => {
    await fixture.client.disconnect();
    // This fixture owns only the explicitly allocated temporary directory.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^notes-notion-client-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

test('native Notion OAuth reserves loopback, rejects forged callbacks and exchanges one S256 code into an encrypted vault', async t => {
  let authorization;
  const f = await setup(t, { openExternal: async url => {
    authorization = new URL(url);
    assert.equal(authorization.origin + authorization.pathname, ORIGIN + '/authorize');
    assert.equal(authorization.searchParams.get('scope'), 'default');
    assert.equal(authorization.searchParams.get('resource'), ORIGIN);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(await callback(url, { state: 'forged' }), 403);
    assert.equal(await callback(url, { host: 'attacker.invalid' }), 400);
    assert.equal(await callback(url, { path: '/unrelated' }), 404);
    assert.equal(await callback(url, { method: 'POST' }), 400);
    assert.equal(await callback(url, { duplicateState: true }), 403);
    assert.equal(await callback(url, { duplicateCode: true }), 400);
    assert.equal(await callback(url, { issuer: 'https://attacker.invalid' }), 403);
    assert.equal(await callback(url), 200);
  } });
  const status = await f.client.connect();
  assert.deepEqual(status, { connected: true, state: 'connected', account: { workspaceId: 'workspace-test', workspaceName: 'Workspace de teste', userId: 'user-test' } });
  assert.equal(f.registrations[0].token_endpoint_auth_method, 'none');
  assert.equal(f.tokens.length, 1);
  const exchange = f.tokens[0];
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(crypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  const vault = await fs.readFile(f.vaultPath);
  assert.equal(vault.includes(Buffer.from(PRIVATE)), false);
  assert.equal(JSON.stringify(status).includes(PRIVATE), false);
  assert.deepEqual(await fs.readdir(f.directory), ['notion-credentials.enc']);
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')));
});

test('get_self resolves missing OAuth identity into the encrypted grant for local-only status after restart', async t => {
  const f = await setup(t); f.omitIdentity = true;
  assert.equal((await f.client.connect()).account,null);
  f.rpcHandler = async message => message.method === 'tools/call' && message.params.name === 'notion-get-self' ? json({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify({workspace:{id:'workspace-resolved',name:'Workspace de exemplo'},user:{id:'user-resolved',name:'Pessoa de exemplo',email:'unused-private-field@example.invalid'}})}]}}) : null;
  await f.client.callTool('notion-get-self',{});
  const expected={workspaceId:'workspace-resolved',workspaceName:'Workspace de exemplo',userId:'user-resolved',userName:'Pessoa de exemplo'};
  assert.deepEqual(f.client.status().account,expected);
  const clear=f.safe.decrypt(await fs.readFile(f.vaultPath));
  assert.equal(clear.includes('unused-private-field'),false,'unneeded profile fields are not persisted');
  const requests=f.requests.length;
  const restored=new NotionClient({dataDir:f.directory,secureStorage:f.safe,fetchImpl:f.fetch});
  assert.deepEqual((await restored.restore()).account,expected);
  assert.equal(f.requests.length,requests,'restore does not contact Notion');
  f.clock+=2*60*60*1000;
  await Promise.all([f.client.listTools(),f.client.callTool('notion-get-self',{})]);
  const vault=JSON.parse(f.safe.decrypt(await fs.readFile(f.vaultPath)));
  assert.equal(vault.tokens.accessToken,PRIVATE+'access-2');
  assert.equal(vault.tokens.refreshToken,PRIVATE+'refresh-2');
  assert.deepEqual(vault.account,expected,'identity resolution preserves the rotated token pair');
});

test('get_self bot identity cannot replace the person and workspace established by OAuth', async t => {
  const f=await setup(t);await f.client.connect();const account=f.client.status().account;
  f.rpcHandler=async message=>message.method==='tools/call'?json({jsonrpc:'2.0',id:message.id,result:{structuredContent:{workspace:{id:'bot-workspace'},user:{id:'bot-id',type:'bot',name:'Bot'}}}}):null;
  await f.client.callTool('notion-get-self',{});
  assert.deepEqual(f.client.status().account,account);
  assert.deepEqual(JSON.parse(f.safe.decrypt(await fs.readFile(f.vaultPath))).account,account);
});

test('restart restores locally without registration; concurrent expiry refresh rotates and persists one token', async t => {
  const f = await setup(t); await f.client.connect();
  const restart = new NotionClient({ dataDir: f.directory, secureStorage: f.safe, fetchImpl: f.fetch, now: () => f.clock });
  const before = f.requests.length;
  assert.equal((await restart.restore()).connected, true); assert.equal(f.requests.length, before);
  await restart.listTools();
  f.clock += 3601000;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => restart.callTool('notion-fetch', { id: 'page-' + index })));
  assert.equal(results.length, 8); assert.equal(f.tokens.length, 2); assert.equal(f.registrations.length, 1);
  assert.equal(f.tokens[1].get('grant_type'), 'refresh_token');
  assert.equal(f.tokens[1].get('refresh_token'), PRIVATE + 'refresh-1');
  const saved = JSON.parse(f.safe.decrypt(await fs.readFile(f.vaultPath)));
  assert.equal(saved.tokens.refreshToken, PRIVATE + 'refresh-2');
  assert.equal(saved.clientInfo.clientId, PRIVATE + 'client-id');
  assert.equal(restart.status().account.workspaceId, 'workspace-test');
  assert.equal(restart.status().account.userId, 'user-test');
  assert.equal(f.rpc.some(entry => entry.message.method === 'tools/call' && /get.self/.test(entry.message.params.name)), false);
});

test('simultaneous HTTP 401 responses renew once, retry with the new token and retain session/protocol headers', async t => {
  const f = await setup(t); await f.client.connect(); await f.client.listTools();
  f.rejectToken = PRIVATE + 'access-1';
  const results = await Promise.all(Array.from({ length: 10 }, () => f.client.callTool('notion-fetch', { id: 'page' })));
  assert.equal(results.length, 10); assert.equal(f.tokens.length, 2);
  const requests = f.rpc.filter(entry => entry.message.method === 'tools/call');
  assert.ok(requests.some(entry => entry.request.headers.Authorization === 'Bearer ' + PRIVATE + 'access-2'));
  assert.ok(requests.every(entry => entry.request.headers['Mcp-Session-Id'] === 'fixture-session'));
  assert.ok(requests.every(entry => entry.request.headers['MCP-Protocol-Version'] === '2025-06-18'));
});

test('invalid_grant requires reconnect and removes revoked tokens without echoing provider secrets', async t => {
  const f = await setup(t); await f.client.connect(); await f.client.listTools();
  f.clock += 3601000; f.tokenError = 'invalid_grant';
  await assert.rejects(f.client.callTool('notion-fetch', { id: 'page' }), error => error.code === 'NOTION_AUTH_REQUIRED' && !error.message.includes(PRIVATE));
  assert.equal(f.client.status().connected, false); assert.equal(f.client.status().state, 'reauth_required');
  const saved = JSON.parse(f.safe.decrypt(await fs.readFile(f.vaultPath)));
  assert.equal(saved.tokens, undefined);
  const restart = new NotionClient({ dataDir: f.directory, secureStorage: f.safe, fetchImpl: f.fetch });
  assert.equal((await restart.restore()).state, 'reauth_required');
});

test('unavailable or plaintext secure storage cannot save credentials; unreadable ciphertext stays intact', async t => {
  const unavailable = await setup(t, { secureStorage: { isAvailable: () => false, encrypt: () => { throw new Error('must not encrypt'); }, decrypt: () => '' } });
  await assert.rejects(unavailable.client.connect(), { code: 'NOTION_SECURE_STORAGE' });
  assert.equal(unavailable.requests.length, 0); assert.deepEqual(await fs.readdir(unavailable.directory), []);
  const identity = await setup(t, { secureStorage: { isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() } });
  await assert.rejects(identity.client.connect(), { code: 'NOTION_SECURE_STORAGE' });
  assert.deepEqual(await fs.readdir(identity.directory), []);
  const f = await setup(t); await f.client.connect(); const before = await fs.readFile(f.vaultPath);
  const otherWindowsUser = new NotionClient({ dataDir: f.directory, secureStorage: storage(), fetchImpl: f.fetch });
  await assert.rejects(otherWindowsUser.restore(), { code: 'NOTION_CREDENTIALS' });
  assert.deepEqual(await fs.readFile(f.vaultPath), before); assert.equal(otherWindowsUser.status().connected, false);
});

test('untrusted OAuth metadata is rejected before any credential or registration request', async t => {
  const f = await setup(t);
  f.metadataHandler = url => new URL(url).pathname.endsWith('oauth-protected-resource') ? json({ resource: ORIGIN, authorization_servers: [ORIGIN] }) : json({ issuer: ORIGIN, authorization_endpoint: ORIGIN + '/authorize', token_endpoint: 'https://attacker.invalid/token', registration_endpoint: ORIGIN + '/register', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  await assert.rejects(f.client.connect(), { code: 'NOTION_PROTOCOL' });
  assert.equal(f.registrations.length, 0); assert.equal(f.tokens.length, 0);
});

test('aborting browser authorization closes the callback server and cannot exchange or persist a code', async t => {
  const opened = deferred(), controller = new AbortController();
  const f = await setup(t, { openExternal: url => { opened.resolve(url); } });
  const connecting = f.client.connect({ signal: controller.signal });
  const rejected = assert.rejects(connecting, { code: 'NOTION_CANCELLED' });
  const authorization = new URL(await opened.promise); controller.abort(); await rejected;
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')));
  assert.equal(f.tokens.length, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('browser authorization has a bounded timeout and a provider rejection never echoes its description', async t => {
  const opened = deferred();
  const f = await setup(t, { authTimeoutMs: 2000, openExternal: url => { opened.resolve(url); } });
  const connecting = f.client.connect(); const rejected = assert.rejects(connecting, { code: 'NOTION_TIMEOUT' });
  const authorization = new URL(await opened.promise); await rejected;
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')));
  const denied = await setup(t, { openExternal: url => callback(url, { error: PRIVATE + 'secret-description' }) });
  await assert.rejects(denied.client.connect(), error => error.code === 'NOTION_AUTH_DENIED' && !error.message.includes(PRIVATE));
  assert.equal(denied.tokens.length, 0);
});

test('MCP parses split UTF-8 SSE events and paginates tool schemas while hiding all write tools', async t => {
  const f = await setup(t); await f.client.connect();
  f.rpcHandler = message => {
    if (message.method === 'tools/list') return sse({ jsonrpc: '2.0', id: message.id, result: message.params.cursor ? { tools: [{ name: 'notion-get-comments', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'notion-fetch', inputSchema: { type: 'object' } }, { name: 'notion-update-page', inputSchema: { type: 'object' } }], nextCursor: 'tool-page-2' } });
    if (message.method === 'tools/call') return sse({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Olá: café, ação e 📝.' }] } });
  };
  assert.deepEqual((await f.client.listTools()).map(tool => tool.name), ['notion-fetch', 'notion-get-comments']);
  const result = await f.client.callTool('notion-fetch', { id: 'page' });
  assert.equal(result.content[0].text, 'Olá: café, ação e 📝.');
  assert.equal(f.rpc.filter(entry => entry.message.method === 'initialize').length, 1);
  const ids = f.rpc.filter(entry => entry.message.id !== undefined).map(entry => entry.message.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('SSE reads remain abortable even if an injected stream ignores the fetch signal', async t => {
  const f = await setup(t); await f.client.connect(); await f.client.listTools();
  const started = deferred(), controller = new AbortController(); let streamCancelled = false;
  f.rpcHandler = message => { if (message.method === 'tools/call') { started.resolve(); return sse(null, { hanging: true, onCancel: () => { streamCancelled = true; } }); } };
  const reading = f.client.callTool('notion-fetch', { id: 'page' }, { signal: controller.signal });
  const rejected = assert.rejects(reading, { code: 'NOTION_CANCELLED' });
  await started.promise; controller.abort(); await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(streamCancelled, true);
});

test('write tools and SQL are rejected before network access; tool errors and rate limits are bounded and sanitized', async t => {
  const f = await setup(t);
  await assert.rejects(f.client.callTool('notion-create-pages', {}), { code: 'NOTION_READ_ONLY' });
  await assert.rejects(f.client.callTool('notion-query-data-sources', { mode: 'sql', query: 'DELETE FROM pages' }), { code: 'NOTION_READ_ONLY' });
  await assert.rejects(f.client.callTool('notion-query-data-sources', { mode: 'rows', sql: 'SELECT 1' }), { code: 'NOTION_READ_ONLY' });
  await assert.rejects(f.client.callTool('notion-query-data-sources', { mode: 'rows', data: { mode: 'sql', query: 'DELETE FROM pages' } }), { code: 'NOTION_READ_ONLY' });
  assert.equal(f.requests.length, 0);
  await f.client.connect(); await f.client.listTools();
  let calls = 0;
  f.rpcHandler = message => {
    if (message.method !== 'tools/call') return;
    if (++calls === 1) return json({ private_message: PRIVATE }, 429, { 'Retry-After': '0' });
    return json({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: PRIVATE }], structuredContent: { error: { code: 'permission_error', message: PRIVATE } } } });
  };
  const result = await f.client.callTool('notion-query-data-sources', { mode: 'rows', data_source_url: 'collection://fixture', limit: 100 });
  assert.equal(calls, 2); assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'permission_error');
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  const wrapped = await f.client.callTool('notion-query-data-sources', { data: { mode: 'view', view_url: 'view://fixture', page_size: 100 } });
  assert.equal(wrapped.isError, true);
  f.rpcHandler = () => json({ private_message: PRIVATE }, 429, { 'Retry-After': '3600' });
  await assert.rejects(f.client.callTool('notion-fetch', { id: 'page' }), error => error.code === 'NOTION_RATE_LIMIT' && error.retryAfterSeconds === 3600 && !error.message.includes(PRIVATE));
});

test('mismatched RPC ids, oversized responses and repeating cursors fail instead of claiming coverage', async t => {
  const f = await setup(t); await f.client.connect(); await f.client.listTools();
  f.rpcHandler = message => json({ jsonrpc: '2.0', id: message.id + 1, result: { content: [] } });
  await assert.rejects(f.client.callTool('notion-fetch', { id: 'page' }), { code: 'NOTION_PROTOCOL' });
  let cancelledStream = false;
  f.rpcHandler = () => new Response(new ReadableStream({ cancel() { cancelledStream = true; } }), { headers: { 'Content-Length': String(9 * 1024 * 1024), 'Content-Type': 'application/json' } });
  await assert.rejects(f.client.callTool('notion-fetch', { id: 'page' }), { code: 'NOTION_PROTOCOL' });
  assert.equal(cancelledStream, true);
  f.rpcHandler = message => json({ jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: 'same-cursor' } });
  await assert.rejects(f.client.listTools(), { code: 'NOTION_PROTOCOL' });
});

test('disconnect during an in-flight encrypted write cannot resurrect credentials afterward', async t => {
  const writing = deferred(), release = deferred(), secure = storage();
  const f = await setup(t, { secureStorage: { ...secure, async encrypt(clear) { writing.resolve(); await release.promise; return secure.encrypt(clear); } } });
  const connecting = f.client.connect(); const rejected = assert.rejects(connecting, { code: 'NOTION_CANCELLED' });
  await writing.promise;
  const disconnecting = f.client.disconnect(); release.resolve(); await Promise.all([disconnecting, rejected]);
  assert.equal(f.client.status().state, 'disconnected'); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('disconnect drains the browser listener before returning so a new connection can start immediately', async t => {
  const opened = deferred(); let attempts = 0;
  const f = await setup(t, { openExternal: async url => { if (++attempts === 1) opened.resolve(url); else assert.equal(await callback(url), 200); } });
  const connecting = f.client.connect(); const rejected = assert.rejects(connecting, { code: 'NOTION_CANCELLED' });
  const authorization = new URL(await opened.promise);
  await f.client.disconnect(); await rejected;
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')));
  assert.equal((await f.client.connect()).connected, true);
  assert.equal(f.tokens.length, 1);
});
