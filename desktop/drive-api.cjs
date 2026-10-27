'use strict';

/* Google Drive v3, appDataFolder only. Official protocol references:
 * https://developers.google.com/workspace/drive/api/guides/appdata
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
 * https://developers.google.com/workspace/drive/api/guides/manage-uploads
 * Pre-generated IDs make retries idempotent. Different computers may still
 * create the same immutable filename; CloudSync validates every duplicate.
 * Public: listFiles, downloadBuffer, downloadTo, verifyFile, uploadImmutable,
 * cancel, reset. All operations accept {signal}; fetch is injectable in tests.
 */
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const HASH = /^[a-f0-9]{64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const FIELDS = 'id,name,size,version,sha256Checksum,md5Checksum,appProperties';
const MAX_ASSET = 256 * 1024 * 1024;

function failure(message, code, status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}
function assertId(id) { if (typeof id !== 'string' || !FILE_ID.test(id)) throw failure('Identificador do Google Drive inválido.', 'DRIVE_PROTOCOL'); return id; }
function assertURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== 'https://www.googleapis.com' || url.username || url.password
    || !(url.pathname.startsWith('/drive/v3/') || url.pathname.startsWith('/upload/drive/v3/'))) throw failure('Endpoint do Google Drive não autorizado.', 'DRIVE_PROTOCOL');
  return url;
}
async function readLimited(response, maxBytes, signal, onChunk) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel().catch(() => {}); throw failure('Resposta do Google Drive excede o limite permitido.', 'DRIVE_SIZE_LIMIT'); }
  let size = 0;
  const chunks = [];
  try {
    if (response.body) for await (const chunk of response.body) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maxBytes) throw failure('Resposta do Google Drive excede o limite permitido.', 'DRIVE_SIZE_LIMIT');
      if (onChunk) await onChunk(bytes); else chunks.push(bytes);
    }
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return onChunk ? size : Buffer.concat(chunks, size);
}

class DriveApi {
  constructor({ auth, fetch: fetchImpl = globalThis.fetch, timeoutMs = 45000, maxAttempts = 3, retryBaseMs = 500, maxRetryMs = 10000, maxFiles = 200000, testBaseURL } = {}) {
    if (!auth?.getAccessToken || typeof fetchImpl !== 'function') throw new TypeError('DriveApi requer autenticação e fetch.');
    this.auth = auth; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.maxAttempts = Math.max(1, Math.min(5, maxAttempts)); this.retryBaseMs = retryBaseMs; this.maxRetryMs = maxRetryMs; this.maxFiles = maxFiles;
    this._controller = new AbortController(); this._uploadIds = new Map();
    if (testBaseURL !== undefined) {
      const test = new URL(testBaseURL);
      if (process.env.NOTES_TEST !== '1' || test.protocol !== 'http:' || test.hostname !== '127.0.0.1' || test.username || test.password) throw new TypeError('Endpoints alternativos são permitidos apenas em testes locais.');
      this._testBaseURL = test.origin;
    }
  }
  cancel() { this._controller.abort(); }
  reset() { this._controller.abort(); this._controller = new AbortController(); this._uploadIds.clear(); }
  async _request(value, { method = 'GET', body, headers = {}, signal, accept = [], retry = true } = {}) {
    const url = assertURL(value);
    const maxAttempts = retry ? this.maxAttempts : 1;
    let refreshed = false, lastError;
    for (let attempt = 0; attempt < maxAttempts + 1; attempt++) {
      const combined = AbortSignal.any([this._controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]);
      combined.throwIfAborted();
      try {
        const token = await this.auth.getAccessToken({ forceRefresh: refreshed, signal: combined });
        combined.throwIfAborted();
        const destination = this._testBaseURL ? this._testBaseURL + url.pathname + url.search : url.href;
        const response = await this.fetch(destination, { method, headers: { ...headers, Authorization: 'Bearer ' + token }, body, signal: combined, redirect: 'error' });
        if (response.status === 401 && !refreshed) {
          await response.body?.cancel().catch(() => {}); this.auth.invalidateAccessToken?.(); refreshed = true; continue;
        }
        if (response.ok || accept.includes(response.status)) return { response, signal: combined };
        const bytes = await readLimited(response, 1024 * 1024, combined);
        let reasons = [];
        try { reasons = JSON.parse(bytes.toString('utf8')).error?.errors?.map(error => error.reason) || []; } catch {}
        const throttled = response.status === 429 || (response.status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)));
        const retryable = throttled || response.status >= 500;
        lastError = failure('Google Drive respondeu com HTTP ' + response.status + '.', response.status === 401 ? 'AUTH_REQUIRED' : retryable ? 'DRIVE_TEMPORARY' : 'DRIVE_HTTP', response.status);
        if (!retryable || attempt >= maxAttempts - 1) throw lastError;
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        const backoff = Math.min(this.maxRetryMs, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : this.retryBaseMs * 2 ** attempt);
        await delay(backoff, undefined, { signal: AbortSignal.any([this._controller.signal, ...(signal ? [signal] : [])]) });
      } catch (error) {
        if (this._controller.signal.aborted || signal?.aborted || error.code === 'AUTH_REQUIRED') throw error;
        const networkCode = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code);
        if (!networkCode && !['TypeError', 'TimeoutError'].includes(error.name)) throw error;
        lastError = failure('Não foi possível alcançar o Google Drive. Os dados locais continuam salvos.', 'DRIVE_OFFLINE');
        if (attempt >= maxAttempts - 1) throw lastError;
        await delay(Math.min(this.maxRetryMs, this.retryBaseMs * 2 ** attempt), undefined, { signal: AbortSignal.any([this._controller.signal, ...(signal ? [signal] : [])]) });
      }
    }
    throw lastError;
  }
  async _json(url, options) {
    const { response, signal } = await this._request(url, options);
    const bytes = await readLimited(response, 4 * 1024 * 1024, signal);
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw failure('Resposta JSON inválida do Google Drive.', 'DRIVE_PROTOCOL'); }
  }
  async listFiles({ signal } = {}) {
    const files = new Map(), seenPages = new Set();
    let pageToken, restarted = false;
    for (let page = 0; page < 10000; page++) {
      const url = new URL(API + '/files');
      url.search = new URLSearchParams({ spaces: 'appDataFolder', q: "'appDataFolder' in parents and trashed = false", pageSize: '1000', fields: 'nextPageToken,incompleteSearch,files(' + FIELDS + ')' });
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let result;
      try { result = await this._json(url, { signal }); }
      catch (error) {
        if (pageToken && error.status === 400 && !restarted) { restarted = true; pageToken = undefined; seenPages.clear(); files.clear(); continue; }
        throw error;
      }
      if (!Array.isArray(result.files) || result.incompleteSearch) throw failure('A listagem do Google Drive ficou incompleta.', 'DRIVE_PROTOCOL');
      for (const file of result.files) {
        assertId(file.id);
        if (typeof file.name !== 'string') throw failure('Metadados inválidos no Google Drive.', 'DRIVE_PROTOCOL');
        files.set(file.id, file);
        if (files.size > this.maxFiles) throw failure('A conta excede o limite de arquivos de sincronização.', 'DRIVE_SIZE_LIMIT');
      }
      if (!result.nextPageToken) return [...files.values()];
      if (typeof result.nextPageToken !== 'string' || seenPages.has(result.nextPageToken)) throw failure('Paginação repetida do Google Drive.', 'DRIVE_PROTOCOL');
      seenPages.add(result.nextPageToken); pageToken = result.nextPageToken;
    }
    throw failure('A listagem do Google Drive excedeu o limite de páginas.', 'DRIVE_SIZE_LIMIT');
  }
  metadata(id, { signal } = {}) { return this._json(API + '/files/' + assertId(id) + '?fields=' + encodeURIComponent(FIELDS), { signal }); }
  async downloadBuffer(id, { maxBytes = 64 * 1024 * 1024, signal } = {}) {
    const result = await this._request(API + '/files/' + assertId(id) + '?alt=media', { signal });
    return readLimited(result.response, maxBytes, result.signal);
  }
  async _downloadChecked(id, { sha256, size, maxBytes = MAX_ASSET, signal, destination } = {}) {
    if (!HASH.test(sha256) || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw failure('Descritor de anexo inválido.', 'DRIVE_INTEGRITY');
    let temporary, handle;
    if (destination) {
      temporary = destination + '.' + crypto.randomUUID() + '.partial';
      handle = await fs.open(temporary, 'wx');
    }
    try {
      const result = await this._request(API + '/files/' + assertId(id) + '?alt=media', { signal });
      const hash = crypto.createHash('sha256');
      const actualSize = await readLimited(result.response, Math.min(maxBytes, size), result.signal, async chunk => { hash.update(chunk); if (handle) await handle.write(chunk); });
      if (actualSize !== size || hash.digest('hex') !== sha256) throw failure('A integridade de um anexo do Google Drive não pôde ser confirmada. Os arquivos existentes foram preservados.', 'DRIVE_INTEGRITY');
      if (handle) {
        await handle.sync(); await handle.close(); handle = null;
        // CloudSync has already checked whether a local blob exists. Refuse a
        // replacement if another operation created a different local file.
        try {
          const existing = await fs.lstat(destination);
          if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== size) throw failure('O anexo local mudou durante a sincronização.', 'DRIVE_INTEGRITY');
          const existingHash = crypto.createHash('sha256');
          for await (const chunk of nativeFs.createReadStream(destination)) { signal?.throwIfAborted(); existingHash.update(chunk); }
          if (existingHash.digest('hex') !== sha256) throw failure('O anexo local mudou durante a sincronização.', 'DRIVE_INTEGRITY');
          await fs.unlink(temporary); temporary = null;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await fs.rename(temporary, destination); temporary = null;
        }
      }
      return { size: actualSize, sha256 };
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
  downloadTo(id, destination, options) { if (!path.isAbsolute(destination)) throw new TypeError('Destino deve ser absoluto.'); return this._downloadChecked(id, { ...options, destination }); }
  verifyFile(id, options) { return this._downloadChecked(id, options); }
  async uploadImmutable({ name, buffer, filePath, sha256, kind, signal, maxBytes = MAX_ASSET } = {}) {
    if (typeof name !== 'string' || !/^notes-v1-(?:rev-[a-f0-9]{64}\.json|asset-[a-f0-9]{64})$/.test(name)) throw failure('Nome imutável inválido.', 'DRIVE_PROTOCOL');
    let size, handle;
    if (buffer !== undefined) {
      buffer = Buffer.from(buffer); size = buffer.length;
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (sha256 && actual !== sha256) throw failure('Checksum local inválido.', 'DRIVE_INTEGRITY');
      sha256 = actual;
    } else {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure('O anexo local deve ser um arquivo regular.', 'DRIVE_INTEGRITY');
      size = stat.size;
      if (size > maxBytes) throw failure('Arquivo excede o limite de transferência.', 'DRIVE_SIZE_LIMIT');
      const hash = crypto.createHash('sha256');
      for await (const chunk of nativeFs.createReadStream(filePath)) { signal?.throwIfAborted(); hash.update(chunk); }
      const actual = hash.digest('hex');
      if (sha256 && actual !== sha256) throw failure('Checksum local inválido.', 'DRIVE_INTEGRITY');
      sha256 = actual;
    }
    if (size > maxBytes || !HASH.test(sha256)) throw failure('Arquivo excede o limite de transferência.', 'DRIVE_SIZE_LIMIT');
    let id = this._uploadIds.get(name);
    if (!id) {
      const generated = await this._json(API + '/files/generateIds?count=1&space=appDataFolder&type=files', { signal });
      id = assertId(generated.ids?.[0]); this._uploadIds.set(name, id);
    }
    const mimeType = kind === 'revision' ? 'application/json' : 'application/octet-stream';
    const metadata = { id, name, parents: ['appDataFolder'], mimeType, appProperties: { notesFormat: '1', kind: kind || 'asset', sha256 } };
    const verify = async file => {
      if (file.id !== id || file.name !== name || Number(file.size) !== size) throw failure('Upload retornou metadados inconsistentes.', 'DRIVE_INTEGRITY');
      if (file.sha256Checksum) {
        if (file.sha256Checksum !== sha256) throw failure('Checksum do upload não corresponde ao arquivo local.', 'DRIVE_INTEGRITY');
      } else await this.verifyFile(id, { sha256, size, maxBytes, signal });
      return file;
    };
    try {
      const started = await this._request(UPLOAD + '/files?uploadType=resumable&fields=' + encodeURIComponent(FIELDS), {
        method: 'POST', body: JSON.stringify(metadata), signal,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(size) }
      });
      const location = assertURL(started.response.headers.get('location'));
      if (!location.pathname.startsWith('/upload/drive/v3/files') || location.searchParams.get('uploadType') !== 'resumable') throw failure('Sessão de upload inválida.', 'DRIVE_PROTOCOL');
      await started.response.body?.cancel().catch(() => {});
      if (filePath) handle = await fs.open(filePath, 'r');
      let offset = 0, resumptions = 0, stalls = 0;
      do {
        const length = Math.min(8 * 1024 * 1024, size - offset);
        let bytes;
        if (buffer) bytes = buffer.subarray(offset, offset + length);
        else { bytes = Buffer.alloc(length); const read = await handle.read(bytes, 0, length, offset); if (read.bytesRead !== length) throw failure('O arquivo local mudou durante o upload.', 'DRIVE_INTEGRITY'); }
        let sent, recovering = false;
        try {
          // A failed chunk may have been partially accepted. Retrying the same
          // Content-Range blindly is unsafe; query the committed server offset.
          sent = await this._request(location, { method: 'PUT', body: bytes, signal, accept: [308], retry: false, headers: {
            'Content-Type': mimeType, 'Content-Length': String(bytes.length), 'Content-Range': size ? 'bytes ' + offset + '-' + (offset + length - 1) + '/' + size : 'bytes */0'
          } });
        } catch (error) {
          if (!['DRIVE_OFFLINE', 'DRIVE_TEMPORARY'].includes(error.code) || ++resumptions > this.maxAttempts) throw error;
          recovering = true;
          sent = await this._request(location, { method: 'PUT', body: Buffer.alloc(0), signal, accept: [308], headers: {
            'Content-Length': '0', 'Content-Range': 'bytes */' + size
          } });
        }
        if (sent.response.status !== 308) {
          const responseBytes = await readLimited(sent.response, 1024 * 1024, sent.signal);
          let file; try { file = JSON.parse(responseBytes.toString('utf8')); } catch { throw failure('Resposta inválida ao concluir upload.', 'DRIVE_PROTOCOL'); }
          return verify(file);
        }
        const range = /^bytes=0-(\d+)$/.exec(sent.response.headers.get('range') || '');
        await sent.response.body?.cancel().catch(() => {});
        const next = range ? Number(range[1]) + 1 : 0;
        if (!Number.isSafeInteger(next) || next < 0 || next > offset + length || next >= size) throw failure('O upload não avançou conforme o esperado.', 'DRIVE_PROTOCOL');
        if (next <= offset) {
          if (!recovering || ++stalls > this.maxAttempts) throw failure('O upload não avançou conforme o esperado.', 'DRIVE_PROTOCOL');
        } else stalls = 0;
        offset = next;
      } while (offset < size);
      throw failure('Upload incompleto.', 'DRIVE_PROTOCOL');
    } catch (error) {
      // A completion response may have been lost. Reuse the generated ID and
      // verify the existing file instead of creating a duplicate on retry.
      if (signal?.aborted || this._controller.signal.aborted) throw error;
      if ([404, 409].includes(error.status) || ['DRIVE_OFFLINE', 'DRIVE_TEMPORARY'].includes(error.code)) {
        try { return await verify(await this.metadata(id, { signal })); }
        catch (checkError) { if (checkError.code === 'DRIVE_INTEGRITY') throw checkError; }
      }
      throw error;
    } finally { if (handle) await handle.close(); }
  }
}

module.exports = { DriveApi, readLimited, failure, HASH };
