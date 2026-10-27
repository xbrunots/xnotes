'use strict';

/* Desktop OAuth Authorization Code + S256 PKCE, system browser and a random
 * 127.0.0.1 loopback listener. Configuration is BYO Google Desktop client JSON.
 * Endpoints never come from that JSON. No client/token is synchronized.
 * Refresh tokens and client configuration are encrypted with Electron
 * safeStorage (DPAPI on Windows); unavailable/plaintext storage is refused.
 * https://developers.google.com/identity/protocols/oauth2/native-app
 * https://www.electronjs.org/docs/latest/api/safe-storage
 * Public API/status documented in the parent integration contract.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { readLimited, failure } = require('./drive-api.cjs');

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const MAX_VAULT = 128 * 1024;

function configuration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (!input.installed && input.web)) throw failure('Importe um cliente OAuth do tipo Aplicativo para computador.', 'AUTH_CONFIGURATION');
  const candidate = input.installed || input;
  const client_id = candidate.client_id || candidate.clientId;
  const client_secret = candidate.client_secret ?? candidate.clientSecret;
  if (typeof client_id !== 'string' || client_id.length > 512 || !CLIENT_ID.test(client_id)) throw failure('O client_id OAuth para computador é inválido.', 'AUTH_CONFIGURATION');
  if (client_secret !== undefined && (typeof client_secret !== 'string' || client_secret.length > 8192)) throw failure('O client_secret OAuth é inválido.', 'AUTH_CONFIGURATION');
  return { client_id, ...(client_secret ? { client_secret } : {}) };
}

class GoogleDriveOAuth extends EventEmitter {
  constructor({ dataDir, safeStorage, openExternal, config, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, authTimeoutMs = 300000, now = Date.now } = {}) {
    super();
    if (!path.isAbsolute(dataDir || '')) throw new TypeError('dataDir deve ser absoluto.');
    this.dataDir = dataDir; this.safeStorage = safeStorage; this.openExternal = openExternal; this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs; this.authTimeoutMs = authTimeoutMs; this.now = now;
    this._file = path.join(dataDir, 'google-drive-credentials.enc'); this._providedConfig = config;
    this._vault = {}; this._access = null; this._generation = 0; this._queue = Promise.resolve();
    this._controller = new AbortController(); this._error = null;
  }
  get status() {
    return { configured: !!this._vault.config, connected: !!this._vault.refreshToken, requiresAuth: !this._vault.refreshToken,
      connectionId: this._vault.connectionId || null, scope: SCOPE, error: this._error };
  }
  _emit() { this.emit('change', this.status); return this.status; }
  async _secure() {
    const safe = this.safeStorage;
    if (!safe || safe.getSelectedStorageBackend?.() === 'basic_text') throw failure('O armazenamento seguro do Windows está indisponível. Nenhum token foi salvo em texto simples.', 'AUTH_STORAGE_UNAVAILABLE');
    const available = safe.isAsyncEncryptionAvailable ? await safe.isAsyncEncryptionAvailable() : safe.isEncryptionAvailable?.();
    if (!available) throw failure('O armazenamento seguro do sistema está indisponível. Conecte novamente quando ele estiver disponível.', 'AUTH_STORAGE_UNAVAILABLE');
    return safe;
  }
  async _encrypt(text) { const safe = await this._secure(); return safe.encryptStringAsync ? safe.encryptStringAsync(text) : safe.encryptString(text); }
  async _decrypt(bytes) {
    const safe = await this._secure();
    if (!safe.decryptStringAsync) return safe.decryptString(bytes);
    const decoded = await safe.decryptStringAsync(bytes);
    return typeof decoded === 'string' ? decoded : decoded.result;
  }
  async init() {
    if (!this._initializing) this._initializing = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      try {
        const stat = await fs.lstat(this._file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VAULT) throw new Error('Invalid vault');
        const decoded = JSON.parse(await this._decrypt(await fs.readFile(this._file)));
        if (decoded.schema !== 1 || !decoded.config) throw new Error('Invalid vault');
        const config = configuration(decoded.config);
        if (decoded.refreshToken !== undefined && (typeof decoded.refreshToken !== 'string' || decoded.refreshToken.length > 16384)) throw new Error('Invalid token');
        this._vault = { schema: 1, config, ...(decoded.refreshToken ? { refreshToken: decoded.refreshToken } : {}),
          ...(typeof decoded.connectionId === 'string' ? { connectionId: decoded.connectionId } : {}) };
      } catch (error) {
        if (error.code !== 'ENOENT') this._error = 'A autorização local não pôde ser aberta neste Windows. Os dados foram preservados; importe o cliente OAuth e conecte novamente.';
      }
      if (this._providedConfig) {
        try {
          const config = configuration(this._providedConfig);
          if (JSON.stringify(config) !== JSON.stringify(this._vault.config)) {
            this._vault = { schema: 1, config }; this._error = null;
            await this._persist();
          }
        } catch (error) { this._error = error.code === 'AUTH_CONFIGURATION' ? error.message : 'O armazenamento seguro está indisponível. As notas locais continuam acessíveis; conecte novamente mais tarde.'; }
      }
      return this._emit();
    })();
    await this._initializing; return this.status;
  }
  _persist() {
    const operation = this._queue.then(async () => {
      const encrypted = Buffer.from(await this._encrypt(JSON.stringify({ schema: 1, ...this._vault })));
      if (encrypted.length > MAX_VAULT) throw failure('A configuração OAuth excedeu o limite.', 'AUTH_CONFIGURATION');
      const temporary = this._file + '.' + crypto.randomUUID() + '.tmp';
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, this._file);
      } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    });
    this._queue = operation.catch(() => {}); return operation;
  }
  async configure(input) {
    const config = configuration(input); await this.init(); await this._secure();
    if (JSON.stringify(config) === JSON.stringify(this._vault.config)) return this.status;
    this._cancel(); this._vault = { schema: 1, config }; this._access = null; this._error = null;
    await this._persist(); return this._emit();
  }
  _cancel() {
    this._generation++; this._controller.abort(); this._controller = new AbortController();
    this._cancelFlow?.();
  }
  async _tokenRequest(parameters, signal) {
    const combined = AbortSignal.any([this._controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters).toString(), redirect: 'error', signal: combined });
    const bytes = await readLimited(response, 64 * 1024, combined);
    let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { throw failure('Resposta inválida da autenticação Google.', 'AUTH_PROTOCOL'); }
    if (!response.ok) {
      if (result.error === 'invalid_grant') throw failure('A autorização do Google expirou ou foi revogada. Conecte novamente.', 'AUTH_REQUIRED');
      throw failure('O Google não concluiu a autenticação (HTTP ' + response.status + ').', response.status >= 500 || response.status === 429 ? 'DRIVE_TEMPORARY' : 'AUTH_CONFIGURATION');
    }
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16384 || !Number.isFinite(result.expires_in) || result.expires_in <= 0
      || (result.token_type && (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer')) || (result.scope && !String(result.scope).split(' ').includes(SCOPE))) throw failure('O Google não concedeu o acesso solicitado aos dados de notes.', 'AUTH_REQUIRED');
    if (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || result.refresh_token.length > 16384)) throw failure('Resposta inválida de autorização Google.', 'AUTH_PROTOCOL');
    return result;
  }
  async _accept(result, generation, { newConnection = false } = {}) {
    if (generation !== this._generation) throw failure('Conexão cancelada.', 'AUTH_CANCELLED');
    // A new browser authorization may select another Google account. Its
    // access token must never be paired with the previous account's refresh
    // token. Refresh responses alone may legitimately omit a rotated token.
    const refreshToken = newConnection ? result.refresh_token : result.refresh_token || this._vault.refreshToken;
    if (!refreshToken) {
      const error = failure('O Google não forneceu autorização offline. Conecte novamente e confirme o consentimento.', 'AUTH_REQUIRED');
      if (newConnection) {
        this._vault = { schema: 1, config: this._vault.config }; this._access = null; this._error = error.message;
        await this._persist(); this._emit();
      }
      throw error;
    }
    const previous = this._vault;
    this._vault = { ...this._vault, refreshToken, connectionId: newConnection ? crypto.randomUUID() : this._vault.connectionId || crypto.randomUUID() };
    try { await this._persist(); }
    catch (error) {
      if (generation === this._generation) { this._vault = previous; this._error = 'Não foi possível guardar a autorização no armazenamento seguro. Conecte novamente.'; this._emit(); }
      throw error;
    }
    if (generation !== this._generation) throw failure('Conexão cancelada.', 'AUTH_CANCELLED');
    this._access = { token: result.access_token, expiresAt: this.now() + result.expires_in * 1000 };
    this._error = null; this._emit(); return this._access.token;
  }
  async connect({ signal } = {}) {
    await this.init(); await this._secure();
    if (!this._vault.config) throw failure('Importe o JSON do cliente OAuth Google para computador antes de conectar.', 'AUTH_NOT_CONFIGURED');
    if (this._flow) return this._flow;
    if (typeof this.openExternal !== 'function') throw failure('O navegador do sistema está indisponível.', 'AUTH_CONFIGURATION');
    const generation = this._generation;
    this._flow = this._authorize(generation, signal).finally(() => { this._flow = null; });
    return this._flow;
  }
  async _authorize(generation, signal) {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let server, timer, abortListener, rejectCallback, settled = false;
    try {
      const codePromise = new Promise((resolve, reject) => {
        rejectCallback = reject;
        server = http.createServer((request, response) => {
          const port = server.address()?.port;
          const allowedHost = '127.0.0.1:' + port;
          const reply = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", Connection: 'close' }); response.end(text); };
          if (request.method !== 'GET' || request.headers.host !== allowedHost || (request.url || '').length > 16384) { reply(400, 'Solicitação inválida.'); return; }
          let callback; try { callback = new URL(request.url, 'http://' + allowedHost); } catch { reply(400, 'Solicitação inválida.'); return; }
          if (callback.origin !== 'http://' + allowedHost || callback.pathname !== '/oauth2/callback' || settled) { reply(404, 'Não encontrado.'); return; }
          const returned = callback.searchParams.get('state') || '';
          const bytes = Buffer.from(returned), expected = Buffer.from(state);
          if (bytes.length !== expected.length || !crypto.timingSafeEqual(bytes, expected) || callback.searchParams.getAll('state').length !== 1) { reply(403, 'Esta resposta não pertence à conexão solicitada.'); return; }
          if (callback.searchParams.has('error')) { settled = true; reply(200, 'Conexão cancelada. Volte ao notes.'); reject(failure('A conexão com Google foi cancelada.', 'AUTH_CANCELLED')); return; }
          const code = callback.searchParams.get('code');
          if (!code || code.length > 8192 || callback.searchParams.getAll('code').length !== 1) { reply(400, 'Código inválido.'); return; }
          settled = true; reply(200, 'Conexão autorizada. Volte ao notes para concluir.'); resolve(code);
        });
        server.on('error', () => reject(failure('Não foi possível iniciar a conexão local segura.', 'AUTH_LOOPBACK')));
      });
      // Attach rejection immediately so cancellation while listening cannot
      // create an unhandled promise rejection.
      codePromise.catch(() => {});
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect_uri = 'http://127.0.0.1:' + server.address().port + '/oauth2/callback';
      const parameters = new URLSearchParams({ client_id: this._vault.config.client_id, redirect_uri, response_type: 'code', scope: SCOPE,
        state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' });
      this._cancelFlow = () => rejectCallback(failure('Conexão cancelada.', 'AUTH_CANCELLED'));
      abortListener = this._cancelFlow;
      signal?.addEventListener('abort', abortListener, { once: true }); signal?.throwIfAborted();
      timer = setTimeout(() => rejectCallback(failure('O tempo para entrar no Google terminou. Tente conectar novamente.', 'AUTH_CANCELLED')), this.authTimeoutMs);
      await Promise.race([Promise.resolve(this.openExternal(AUTHORIZATION_URL + '?' + parameters)), codePromise.then(() => undefined)]);
      const code = await codePromise;
      const result = await this._tokenRequest({ ...this._vault.config, grant_type: 'authorization_code', code, redirect_uri, code_verifier: verifier }, signal);
      await this._accept(result, generation, { newConnection: true }); return this.status;
    } finally {
      clearTimeout(timer); if (abortListener) signal?.removeEventListener('abort', abortListener); this._cancelFlow = null;
      if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    }
  }
  invalidateAccessToken() { this._access = null; }
  async getAccessToken({ forceRefresh = false, signal } = {}) {
    await this.init(); signal?.throwIfAborted();
    if (!this._vault.config || !this._vault.refreshToken) throw failure('Conecte sua conta Google para sincronizar.', 'AUTH_REQUIRED');
    if (!forceRefresh && this._access && this._access.expiresAt > this.now() + 60000) return this._access.token;
    if (this._refreshing) return this._refreshing;
    const generation = this._generation;
    this._refreshing = (async () => {
      try {
        const result = await this._tokenRequest({ ...this._vault.config, grant_type: 'refresh_token', refresh_token: this._vault.refreshToken }, signal);
        return await this._accept(result, generation);
      } catch (error) {
        if (error.code === 'AUTH_REQUIRED' && generation === this._generation) {
          this._vault = { schema: 1, config: this._vault.config }; this._access = null; this._error = error.message;
          await this._persist(); this._emit();
        }
        throw error;
      }
    })().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }
  async disconnect() {
    await this.init(); this._cancel(); this._access = null; this._error = null;
    this._vault = { schema: 1, ...(this._vault.config ? { config: this._vault.config } : {}) };
    if (this._vault.config) await this._persist();
    else await fs.unlink(this._file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return this._emit();
  }
  async close() { this._cancel(); await this._queue; }
}

module.exports = { GoogleDriveOAuth, SCOPE, configuration };
