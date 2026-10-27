'use strict';

// This is a native client of Notion's hosted MCP service, not a REST integration.
// Discovery and PKCE: https://developers.notion.com/guides/mcp/build-mcp-client
// Credentials are kept outside workspace snapshots and require OS encryption.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ORIGIN = 'https://mcp.notion.com';
const RESOURCE = ORIGIN;
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CALLBACK_PATH = '/oauth/notion/callback';
const MAX_VAULT = 128 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_REQUEST = 2 * 1024 * 1024;
const READ_TOOLS = new Set(['fetch', 'search', 'list_private_pages', 'list_shared_pages', 'get_comments', 'get_file_download_urls', 'get_tool_access', 'query_data_sources', 'get_self']);
const TOOL_ERRORS = new Set(['object_not_found', 'validation_error', 'unauthorized', 'restricted_resource', 'permission_error', 'rate_limited', 'not_enabled', 'not_available', 'unsupported', 'service_unavailable', 'internal_server_error']);

function failure(code, message, details) { return Object.assign(new Error(message), { code }, details); }
function protocol() { return failure('NOTION_PROTOCOL', 'O Notion enviou uma resposta incompatível. Tente novamente ou importe o ZIP completo.'); }
function cancelled(signal) { return signal?.reason?.name === 'TimeoutError' ? failure('NOTION_TIMEOUT', 'A conexão com o Notion excedeu o tempo de espera. Tente novamente.') : failure('NOTION_CANCELLED', 'A conexão com o Notion foi cancelada.'); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function token(value, max = 32768) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value); }
function nameOf(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) ? value.replace(/^notion[-_]/, '').replace(/-/g, '_') : ''; }
function safeLabel(value, max = 200) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : null; }
function safeAccount(value) {
  if (!object(value)) return null;
  const account = {};
  for (const key of ['workspaceId', 'workspaceName', 'userId', 'userName']) {
    const label = safeLabel(value[key], key.endsWith('Id') ? 128 : 200);
    if (label) account[key] = label;
  }
  return Object.keys(account).length ? account : null;
}
function trustedEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw protocol(); }
  if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw protocol();
  return url.href;
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled(signal)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function check(signal) { if (signal?.aborted) throw cancelled(signal); }
function pause(ms, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function retryAfter(response) {
  const raw = response.headers.get('retry-after');
  if (raw && /^\d+$/.test(raw)) return Math.min(Number(raw), 86400);
  const timestamp = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(86400, Math.ceil((timestamp - Date.now()) / 1000))) : 1;
}
function closeBody(response) { try { response.body?.cancel()?.catch(() => {}); } catch {} }

async function readBody(response, { signal, limit = MAX_RESPONSE, rpcId, notification = false } = {}) {
  if (Number(response.headers.get('content-length')) > limit) { closeBody(response); throw protocol(); }
  if (!response.body) return notification ? undefined : Promise.reject(protocol());
  const reader = response.body.getReader(), chunks = [], decoder = new TextDecoder('utf-8', { fatal: true });
  const isSSE = /(?:^|;)\s*text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || '');
  let bytes = 0, pending = '', data = [], events = 0;
  const parseEvent = () => {
    if (!data.length) return undefined;
    const text = data.join('\n'); data = [];
    let message; try { message = JSON.parse(text); } catch { throw protocol(); }
    if (++events > 2048 || !object(message) || message.jsonrpc !== '2.0') throw protocol();
    return message.id === rpcId && rpcId !== undefined ? message : undefined;
  };
  const consume = (text, eof = false) => {
    pending += text;
    // SSE allows CR, LF and CRLF. Keep a terminal CR until the next chunk.
    while (pending.length) {
      const match = /[\r\n]/.exec(pending);
      if (!match) break;
      const index = match.index;
      if (!eof && pending[index] === '\r' && index === pending.length - 1) break;
      const width = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
      const line = pending.slice(0, index); pending = pending.slice(index + width);
      if (!line) { const result = parseEvent(); if (result) return result; }
      else if (line === 'data' || line.startsWith('data:')) data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
    }
    if (eof) {
      if (pending === 'data' || pending.startsWith('data:')) data.push(pending === 'data' ? '' : pending.slice(5).replace(/^ /, ''));
      pending = '';
      return parseEvent();
    }
    return undefined;
  };
  try {
    while (true) {
      check(signal);
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw protocol();
      if (isSSE) {
        const result = consume(decoder.decode(chunk.value, { stream: true }));
        if (result) return result;
      } else chunks.push(Buffer.from(chunk.value));
    }
    check(signal);
    if (isSSE) { const result = consume(decoder.decode(), true); if (result) return result; if (notification && !bytes) return; throw protocol(); }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length && notification) return;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { throw protocol(); }
  } catch (error) {
    if (signal?.aborted) throw cancelled(signal);
    if (error.code?.startsWith('NOTION_')) throw error;
    throw protocol();
  } finally {
    try { reader.cancel().catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

class NotionClient {
  constructor({ dataDir, openExternal, secureStorage, fetchImpl = globalThis.fetch, timeoutMs = 20000, authTimeoutMs = 300000, now = Date.now } = {}) {
    if (!path.isAbsolute(dataDir || '')) throw new TypeError('dataDir deve ser um caminho absoluto.');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl deve ser uma função.');
    this.dataDir = dataDir; this.openExternal = openExternal; this.secureStorage = secureStorage; this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs; this.authTimeoutMs = authTimeoutMs; this.now = now;
    this._file = path.join(dataDir, 'notion-credentials.enc');
    this._state = 'disconnected'; this._vault = null; this._generation = 0;
    this._lifetime = new AbortController(); this._writes = Promise.resolve(); this._nextId = 1;
    this._metadata = null; this._restored = false; this._restoring = null; this._connecting = null; this._refreshing = null;
    this._resetSession();
  }
  status() { return { connected: this._state === 'connected' && !!this._vault?.tokens?.accessToken, state: this._state, account: safeAccount(this._vault?.account) }; }
  _resetSession() { this._initialized = false; this._initializing = null; this._sessionId = null; this._protocol = PROTOCOLS[0]; this._tools = null; }
  _current(generation, signal) { check(signal); if (generation !== this._generation) throw cancelled(); }
  _signal(signal, timeout = this.timeoutMs) { return AbortSignal.any([this._lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeout)]); }
  async _secure() {
    const storage = this.secureStorage;
    if (!storage || typeof storage.isAvailable !== 'function' || typeof storage.encrypt !== 'function' || typeof storage.decrypt !== 'function' || !await storage.isAvailable()) throw failure('NOTION_SECURE_STORAGE', 'O cofre seguro do Windows está indisponível. A autorização não será salva em texto simples.');
    return storage;
  }
  async restore() {
    if (this._restoring) return this._restoring;
    if (this._restored) return this.status();
    this._restored = true;
    const generation = this._generation;
    this._restoring = (async () => {
      let stat;
      try { stat = await fs.lstat(this._file); } catch (error) { if (error.code === 'ENOENT') return this.status(); throw failure('NOTION_CREDENTIALS', 'Não foi possível abrir a autorização local do Notion. Os dados foram preservados.'); }
      try {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT || !stat.size) throw protocol();
        const storage = await this._secure();
        const clear = await storage.decrypt(await fs.readFile(this._file));
        if (typeof clear !== 'string' || Buffer.byteLength(clear) > MAX_VAULT) throw protocol();
        const vault = JSON.parse(clear);
        if (vault.version !== 1 || !object(vault.clientInfo) || !token(vault.clientInfo.clientId, 4096)) throw protocol();
        const restored = { version: 1, clientInfo: { clientId: vault.clientInfo.clientId }, account: safeAccount(vault.account) };
        if (vault.tokens) {
          if (!token(vault.tokens.accessToken) || (vault.tokens.refreshToken !== undefined && !token(vault.tokens.refreshToken)) || !Number.isFinite(vault.tokens.expiresAt) || vault.tokens.expiresAt <= 0) throw protocol();
          restored.tokens = { accessToken: vault.tokens.accessToken, ...(vault.tokens.refreshToken ? { refreshToken: vault.tokens.refreshToken } : {}), expiresAt: vault.tokens.expiresAt };
        }
        this._current(generation);
        this._vault = restored; this._state = restored.tokens ? 'connected' : 'reauth_required';
        return this.status();
      } catch (error) {
        if (error.code === 'NOTION_CANCELLED') throw error;
        if (generation === this._generation) this._state = 'reauth_required';
        if (error.code === 'NOTION_SECURE_STORAGE') throw error;
        throw failure('NOTION_CREDENTIALS', 'Não foi possível decifrar a autorização do Notion neste Windows. O arquivo foi preservado; conecte novamente.');
      }
    })().finally(() => { this._restoring = null; });
    return this._restoring;
  }
  _persist(vault, generation, signal) {
    const serialized = JSON.stringify(vault);
    const operation = this._writes.then(async () => {
      this._current(generation, signal);
      const storage = await this._secure();
      let encrypted;
      try { encrypted = await storage.encrypt(serialized); } catch { throw failure('NOTION_SECURE_STORAGE', 'O Windows não conseguiu proteger a autorização do Notion.'); }
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_VAULT || encrypted.equals(Buffer.from(serialized))) throw failure('NOTION_SECURE_STORAGE', 'O armazenamento seguro não devolveu uma autorização criptografada.');
      this._current(generation, signal);
      const temporary = this._file + '.' + crypto.randomUUID() + '.tmp';
      let handle;
      try {
        await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
        this._current(generation, signal);
        await fs.rename(temporary, this._file);
      } catch (error) {
        if (error.code?.startsWith('NOTION_')) throw error;
        throw failure('NOTION_CREDENTIALS', 'Não foi possível guardar a autorização criptografada do Notion.');
      } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    });
    this._writes = operation.catch(() => {});
    return operation;
  }
  async _accept(vault, generation, signal) {
    this._current(generation, signal);
    await this._persist(vault, generation, signal);
    this._current(generation, signal);
    this._vault = vault; this._state = vault.tokens ? 'connected' : 'reauth_required';
  }
  async _request(url, init, { signal, limit = 128 * 1024, rpcId, notification = false } = {}) {
    const target = trustedEndpoint(url), combined = this._signal(signal);
    let response;
    try {
      check(combined);
      const pendingResponse = Promise.resolve(this.fetch(target, { ...init, headers: { 'User-Agent': 'notes-Notion-Migration/1.0', ...init?.headers }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: combined }));
      // A test transport (or a stalled adapter) may resolve after abort. Do not
      // leave its unread response streaming when its original waiter is gone.
      pendingResponse.then(value => { if (combined.aborted) closeBody(value); }, () => {});
      response = await abortable(pendingResponse, combined);
      check(combined);
      if (response.url && trustedEndpoint(response.url) !== target) { closeBody(response); throw protocol(); }
      if (response.status === 401) { closeBody(response); return { status: 401 }; }
      if (response.status === 429 || response.status === 529) { const seconds = retryAfter(response); closeBody(response); return { status: response.status, retryAfterSeconds: seconds }; }
      if (!response.ok && init?.method !== 'POST') { closeBody(response); throw failure('NOTION_NETWORK', 'Não foi possível consultar o serviço oficial do Notion. Tente novamente.'); }
      const payload = await readBody(response, { signal: combined, limit, rpcId, notification });
      return { status: response.status, payload, sessionId: response.headers.get('mcp-session-id') };
    } catch (error) {
      if (combined.aborted) { if (response) closeBody(response); throw cancelled(combined); }
      if (error.code?.startsWith('NOTION_')) throw error;
      throw failure('NOTION_NETWORK', 'Não foi possível alcançar o serviço oficial do Notion. Verifique sua conexão e tente novamente.');
    }
  }
  async _discover(signal) {
    if (this._metadata) return this._metadata;
    const resource = (await this._request(ORIGIN + '/.well-known/oauth-protected-resource', { headers: { Accept: 'application/json' } }, { signal })).payload;
    if (!object(resource) || resource.resource !== RESOURCE || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(ORIGIN)) throw protocol();
    const metadata = (await this._request(ORIGIN + '/.well-known/oauth-authorization-server', { headers: { Accept: 'application/json' } }, { signal })).payload;
    if (!object(metadata) || metadata.issuer !== ORIGIN || !metadata.code_challenge_methods_supported?.includes('S256') || !metadata.token_endpoint_auth_methods_supported?.includes('none')) throw protocol();
    const discovered = { authorization: trustedEndpoint(metadata.authorization_endpoint), token: trustedEndpoint(metadata.token_endpoint), registration: trustedEndpoint(metadata.registration_endpoint) };
    this._metadata = discovered;
    return discovered;
  }
  async _formToken(parameters, signal) {
    const metadata = await this._discover(signal);
    const result = await this._request(metadata.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...parameters, resource: RESOURCE }).toString() }, { signal });
    if (result.status === 429 || result.status === 529) throw failure('NOTION_RATE_LIMIT', 'O Notion está limitando os pedidos. Aguarde e tente novamente.', { retryAfterSeconds: result.retryAfterSeconds });
    if (result.status === 401 || result.payload?.error === 'invalid_grant') throw failure('NOTION_AUTH_REQUIRED', 'A autorização do Notion expirou ou foi revogada. Conecte novamente.');
    if (result.status < 200 || result.status >= 300) throw failure('NOTION_AUTH_FAILED', 'O Notion não concluiu a autorização. Conecte novamente.');
    const value = result.payload;
    if (!object(value) || !token(value.access_token) || typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' || (value.refresh_token !== undefined && !token(value.refresh_token)) || (value.expires_in !== undefined && (!Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 366 * 86400)) || (value.scope !== undefined && (typeof value.scope !== 'string' || !value.scope.split(' ').includes('default')))) throw protocol();
    return value;
  }
  _tokens(result, previous) {
    return { accessToken: result.access_token, ...(result.refresh_token || previous?.refreshToken ? { refreshToken: result.refresh_token || previous.refreshToken } : {}),
      // A missing lifetime is not treated as an indefinitely valid bearer.
      expiresAt: this.now() + (result.expires_in === undefined ? 300 : result.expires_in) * 1000 };
  }
  async connect({ signal, onProgress } = {}) {
    check(signal);
    if (this._connecting) return abortable(this._connecting, signal);
    this._connecting = this._connect({ signal, onProgress }).finally(() => { this._connecting = null; });
    return this._connecting;
  }
  async _connect({ signal, onProgress }) {
    const generation = this._generation, combined = this._signal(signal, this.authTimeoutMs);
    // A corrupt vault must be preserved, but an explicit reconnect can replace
    // it only after a complete new authorization has succeeded.
    try { await this.restore(); } catch (error) { if (!['NOTION_CREDENTIALS', 'NOTION_SECURE_STORAGE'].includes(error.code)) throw error; }
    await this._secure(); this._current(generation, combined);
    if (this.status().connected) return this.status();
    if (typeof this.openExternal !== 'function') throw failure('NOTION_BROWSER', 'Não foi possível abrir o navegador do sistema.');
    this._state = 'connecting';
    let loopback;
    const progress = message => { if (typeof onProgress === 'function') { try { onProgress({ stage: 'notion-auth', message }); } catch {} } };
    try {
      progress('Preparando a conexão segura com o Notion.');
      const metadata = await this._discover(combined);
      const verifier = crypto.randomBytes(48).toString('base64url'), state = crypto.randomBytes(32).toString('base64url');
      loopback = await this._loopback(state, combined);
      const registration = await this._request(metadata.registration, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_name: 'notes', client_uri: 'https://brunobrito.org', redirect_uris: [loopback.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }, { signal: combined });
      const registered = registration.payload;
      if (registration.status < 200 || registration.status >= 300 || !object(registered) || !token(registered.client_id, 4096) || (registered.token_endpoint_auth_method && registered.token_endpoint_auth_method !== 'none') || (registered.redirect_uris && (!Array.isArray(registered.redirect_uris) || !registered.redirect_uris.includes(loopback.redirectUri)))) throw failure('NOTION_REGISTRATION', 'O Notion não aceitou a conexão automática. Você pode importar o ZIP completo enquanto isso.');
      this._current(generation, combined);
      const authorization = new URL(metadata.authorization);
      authorization.search = new URLSearchParams({ client_id: registered.client_id, redirect_uri: loopback.redirectUri, response_type: 'code', scope: 'default', resource: RESOURCE, state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' }).toString();
      progress('Autorize o notes no navegador para importar seu Notion.');
      const opening = Promise.resolve().then(() => this.openExternal(authorization.href)).catch(() => { throw failure('NOTION_BROWSER', 'Não foi possível abrir o navegador do sistema.'); });
      await abortable(Promise.race([opening, loopback.code.then(() => undefined)]), combined);
      const code = await abortable(loopback.code, combined);
      await loopback.close(); loopback = null;
      const result = await this._formToken({ grant_type: 'authorization_code', code, client_id: registered.client_id, redirect_uri: authorization.searchParams.get('redirect_uri'), code_verifier: verifier }, combined);
      const vault = { version: 1, clientInfo: { clientId: registered.client_id }, tokens: this._tokens(result), account: safeAccount({ workspaceId: result.workspace_id, workspaceName: result.workspace_name, userId: result.user_id }) };
      await this._accept(vault, generation, combined);
      this._resetSession(); progress('Notion conectado. Preparando a leitura da biblioteca.');
      return this.status();
    } catch (error) {
      if (generation === this._generation) this._state = this._vault?.tokens ? 'connected' : this._vault ? 'reauth_required' : 'disconnected';
      if (combined.aborted) throw cancelled(combined);
      if (error.code?.startsWith('NOTION_')) throw error;
      throw failure('NOTION_AUTH_FAILED', 'Não foi possível concluir a conexão com o Notion. Tente novamente.');
    } finally { await loopback?.close(); }
  }
  async _loopback(state, signal) {
    check(signal);
    let resolveCode, rejectCode, settled = false, closed = false;
    const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    code.catch(() => {});
    const server = http.createServer((request, response) => {
      const authority = '127.0.0.1:' + server.address()?.port;
      const reply = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', Connection: 'close' }); response.end(text); };
      if (request.method !== 'GET' || request.headers.host !== authority || typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 16384) { reply(400, 'Solicitação inválida.'); return; }
      let url; try { url = new URL(request.url, 'http://' + authority); } catch { reply(400, 'Solicitação inválida.'); return; }
      if (url.origin !== 'http://' + authority || url.pathname !== CALLBACK_PATH) { reply(404, 'Não encontrado.'); return; }
      if (settled) { reply(409, 'Esta autorização já foi recebida.'); return; }
      const received = Buffer.from(url.searchParams.get('state') || ''), expected = Buffer.from(state);
      if (url.searchParams.getAll('state').length !== 1 || received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) { reply(403, 'Esta resposta não pertence à conexão solicitada.'); return; }
      if (url.searchParams.has('iss') && (url.searchParams.getAll('iss').length !== 1 || url.searchParams.get('iss') !== ORIGIN)) { reply(403, 'Origem inválida.'); return; }
      if (url.searchParams.has('error')) { settled = true; reply(200, 'A autorização foi cancelada. Volte ao notes.'); rejectCode(failure('NOTION_AUTH_DENIED', 'A autorização do Notion foi recusada ou cancelada.')); return; }
      const value = url.searchParams.get('code');
      if (url.searchParams.getAll('code').length !== 1 || !token(value, 8192)) { reply(400, 'Código inválido.'); return; }
      settled = true; reply(200, 'Autorização recebida. Volte ao notes para concluir.'); resolveCode(value);
    });
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 32;
    const abort = () => { rejectCode(cancelled(signal)); close().catch(() => {}); };
    const close = async () => {
      if (closed) return;
      closed = true; signal.removeEventListener('abort', abort);
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
    };
    try {
      await abortable(new Promise((resolve, reject) => { server.once('error', () => reject(failure('NOTION_LOOPBACK', 'Não foi possível preparar a conexão local com o navegador.'))); server.listen(0, '127.0.0.1', resolve); }), signal);
      check(signal); signal.addEventListener('abort', abort, { once: true }); check(signal);
      return { code, redirectUri: 'http://127.0.0.1:' + server.address().port + CALLBACK_PATH, close };
    } catch (error) { rejectCode(error); await close(); throw error; }
  }
  async disconnect() {
    const active = [this._connecting, this._refreshing].filter(Boolean);
    this._generation++; this._lifetime.abort(); this._lifetime = new AbortController();
    this._vault = null; this._state = 'disconnected'; this._restored = true; this._metadata = null; this._resetSession();
    await this._writes;
    await Promise.allSettled(active);
    try { await fs.unlink(this._file); } catch (error) { if (error.code !== 'ENOENT') throw failure('NOTION_CREDENTIALS', 'Não foi possível remover a autorização local do Notion.'); }
    return this.status();
  }
  async _access({ signal, rejectedToken } = {}) {
    check(signal);
    await this.restore(); check(signal);
    const generation = this._generation, stored = this._vault?.tokens;
    if (!stored) throw failure('NOTION_AUTH_REQUIRED', 'Conecte ao Notion para iniciar a importação.');
    if (stored.expiresAt > this.now() + 60000 && (!rejectedToken || stored.accessToken !== rejectedToken)) return stored.accessToken;
    if (!this._refreshing) {
      if (!stored.refreshToken) { this._state = 'reauth_required'; throw failure('NOTION_AUTH_REQUIRED', 'A autorização do Notion expirou. Conecte novamente.'); }
      const lifetime = this._lifetime.signal;
      const refreshing = (async () => {
        try {
          const result = await this._formToken({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: this._vault.clientInfo.clientId }, lifetime);
          await this._accept({ ...this._vault, tokens: this._tokens(result, stored) }, generation, lifetime);
          return this._vault.tokens.accessToken;
        } catch (error) {
          if (['NOTION_AUTH_REQUIRED', 'NOTION_SECURE_STORAGE', 'NOTION_CREDENTIALS'].includes(error.code) && generation === this._generation) {
            const vault = { version: 1, clientInfo: this._vault.clientInfo, account: this._vault.account };
            this._vault = vault; this._state = 'reauth_required'; this._resetSession();
            await this._persist(vault, generation);
          }
          throw error;
        }
      })();
      this._refreshing = refreshing;
      refreshing.finally(() => { if (this._refreshing === refreshing) this._refreshing = null; }).catch(() => {});
    }
    return abortable(this._refreshing, signal);
  }
  async _rpc(method, params, { signal, notification = false } = {}) {
    const generation = this._generation, id = notification ? undefined : this._nextId++;
    let body; try { body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }); } catch { throw failure('NOTION_ARGUMENTS', 'O pedido de leitura do Notion é inválido.'); }
    if (Buffer.byteLength(body) > MAX_REQUEST) throw failure('NOTION_REQUEST_LIMIT', 'O pedido de leitura do Notion excedeu o limite seguro.');
    let renewed = false, retries = 0;
    while (true) {
      this._current(generation, signal);
      const accessToken = await this._access({ signal });
      const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this._protocol };
      if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
      const result = await this._request(ORIGIN + '/mcp', { method: 'POST', headers, body }, { signal, limit: MAX_RESPONSE, rpcId: id, notification });
      this._current(generation, signal);
      if (result.status === 401 && !renewed) { await this._access({ signal, rejectedToken: accessToken }); renewed = true; continue; }
      if (result.status === 401) {
        const vault = { version: 1, clientInfo: this._vault.clientInfo, account: this._vault.account };
        this._vault = vault; this._state = 'reauth_required'; this._resetSession();
        await this._persist(vault, generation, signal);
        throw failure('NOTION_AUTH_REQUIRED', 'O Notion recusou a autorização. Conecte novamente.');
      }
      if (result.status === 429 || result.status === 529) {
        if (retries++ < 2 && result.retryAfterSeconds <= 10) { await pause(result.retryAfterSeconds * 1000, this._signal(signal)); continue; }
        throw failure('NOTION_RATE_LIMIT', 'O Notion está limitando os pedidos. Aguarde para continuar.', { retryAfterSeconds: result.retryAfterSeconds });
      }
      if (result.status < 200 || result.status >= 300) throw failure('NOTION_SERVICE', 'O Notion não concluiu o pedido de leitura. Tente novamente.');
      if (result.sessionId !== null && result.sessionId !== undefined) { if (!token(result.sessionId, 2048)) throw protocol(); this._sessionId = result.sessionId; }
      if (notification) return;
      const message = result.payload;
      if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw protocol();
      if (message.error) throw failure(message.error.code === -32601 ? 'NOTION_TOOL_UNAVAILABLE' : 'NOTION_TOOL_FAILED', 'O Notion não conseguiu atender a esta leitura. Consulte o relatório de cobertura.');
      return message.result;
    }
  }
  async _ensureSession(signal) {
    if (this._initialized) return;
    if (!this._initializing) {
      const generation = this._generation;
      const initializing = (async () => {
        const result = await this._rpc('initialize', { protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: 'notes', version: '1.0.0' } }, { signal });
        if (!object(result) || !PROTOCOLS.includes(result.protocolVersion) || !object(result.capabilities)) throw protocol();
        this._current(generation, signal); this._protocol = result.protocolVersion;
        await this._rpc('notifications/initialized', undefined, { signal, notification: true });
        this._current(generation, signal); this._initialized = true;
      })();
      this._initializing = initializing;
      initializing.finally(() => { if (this._initializing === initializing) this._initializing = null; }).catch(() => {});
    }
    await abortable(this._initializing, signal);
  }
  async listTools({ signal } = {}) {
    await this._ensureSession(signal);
    const tools = new Map(), cursors = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this._rpc('tools/list', cursor ? { cursor } : {}, { signal });
      if (!object(result) || !Array.isArray(result.tools) || result.tools.length > 1024) throw protocol();
      for (const tool of result.tools) {
        if (!object(tool) || typeof tool.name !== 'string' || !object(tool.inputSchema)) throw protocol();
        if (READ_TOOLS.has(nameOf(tool.name))) tools.set(tool.name, tool);
      }
      if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === '') { this._tools = [...tools.values()]; return structuredClone(this._tools); }
      if (!token(result.nextCursor, 16384) || cursors.has(result.nextCursor)) throw protocol();
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw failure('NOTION_COVERAGE', 'A lista de recursos do Notion não terminou. A importação não pode ser considerada completa.');
  }
  async _rememberAccount(result, signal) {
    if (this._vault?.account?.workspaceId && this._vault?.account?.userId) return;
    const candidates = [];
    if (object(result.structuredContent)) candidates.push(result.structuredContent);
    for (const block of result.content || []) if (block.type === 'text') { try { candidates.push(JSON.parse(block.text)); } catch {} }
    const find = (value, depth = 0) => {
      if (!object(value) || depth > 5) return null;
      if (token(value.workspace?.id,128) && token(value.user?.id,128)) return safeAccount({workspaceId:value.workspace.id,workspaceName:value.workspace.name,userId:value.user.id,userName:value.user.name});
      for (const key of ['data','result','response']) { const account = find(value[key],depth+1); if (account) return account; }
      return null;
    };
    const resolved = candidates.map(value=>find(value)).find(Boolean);
    if (!resolved) return;
    const previous=this._vault?.account;
    // OAuth may identify the authorizing person while get_self represents a
    // bot. Never replace an identity that the token exchange already supplied.
    const account=safeAccount({...resolved,...previous});
    if (JSON.stringify(account) === JSON.stringify(previous)) return;
    const generation = this._generation;
    // Do not queue an old access/refresh pair behind a rotation already in
    // flight. Future rotations see the resolved identity in the current vault.
    if (this._refreshing) await abortable(this._refreshing,signal);
    this._current(generation,signal);
    if (!this._vault?.tokens) throw failure('NOTION_AUTH_REQUIRED','Conecte novamente ao Notion para continuar.');
    this._vault = {...this._vault,account};
    await this._persist(this._vault,generation,signal);
    this._current(generation,signal);
  }
  async callTool(name, args = {}, { signal } = {}) {
    const normalized = nameOf(name);
    if (!READ_TOOLS.has(normalized)) throw failure('NOTION_READ_ONLY', 'A importação permite apenas ferramentas de leitura do Notion.');
    if (!object(args)) throw failure('NOTION_ARGUMENTS', 'O pedido de leitura do Notion é inválido.');
    if (normalized === 'query_data_sources') {
      const query = Object.hasOwn(args, 'data') ? args.data : args;
      if (!object(query) || !['rows', 'view'].includes(query.mode) || (query !== args && args.mode !== undefined && args.mode !== query.mode) || Object.hasOwn(args, 'query') || Object.hasOwn(args, 'sql') || Object.hasOwn(query, 'query') || Object.hasOwn(query, 'sql')) throw failure('NOTION_READ_ONLY', 'A importação consulta somente linhas ou visualizações, sem executar SQL.');
    }
    await this._ensureSession(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this._rpc('tools/call', { name, arguments: args }, { signal });
      if (!object(result) || (!Array.isArray(result.content) && !object(result.structuredContent))) throw protocol();
      if (!result.isError) { if (normalized === 'get_self') await this._rememberAccount(result,signal); return result; }
      const reported = result.structuredContent?.error;
      const errorCode = TOOL_ERRORS.has(reported?.code) ? reported.code : 'tool_error';
      const retry = reported?.retry_after_seconds;
      if (errorCode === 'rate_limited' && attempt === 0 && Number.isFinite(retry) && retry >= 0 && retry <= 10) { await pause(retry * 1000, this._signal(signal)); continue; }
      // Raw provider errors can echo page text, authorization codes or URLs.
      return { isError: true, content: [{ type: 'text', text: 'O Notion não concluiu esta leitura. A pendência deve constar no relatório de cobertura.' }], structuredContent: { error: { code: errorCode, ...(Number.isFinite(retry) && retry >= 0 && retry <= 86400 ? { retry_after_seconds: retry } : {}) } } };
    }
    throw protocol();
  }
}

module.exports = { NotionClient };
