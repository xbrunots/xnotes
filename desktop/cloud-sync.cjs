'use strict';

/* Hourly/manual Google Drive API sync. No Drive desktop client, directory
 * watcher, focus event, local save event or close event starts an upload.
 * init()/syncIfDue() run only when the persisted hourly deadline is due;
 * connect() performs the initial synchronization; sync() is the manual button.
 * appDataFolder is private to this OAuth application: every PC MUST use the
 * same Google account AND the same Desktop OAuth client ID.
 *
 * Constructor {store,assets,auth,api?,onStatus?,intervalMs=3600000,now?}.
 * Methods init({syncIfDue=true}), configure(client), connect(), sync(), syncIfDue(), disconnect(),
 * close(). status/getStatus() never contain credentials. Local state/cache files
 * are device-only, outside the immutable revision/blob protocol.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DriveApi, failure, HASH } = require('./drive-api.cjs');
const { validateRevision, atomicWrite, readJSON } = require('./storage.cjs');

const REVISION = /^notes-v1-rev-([a-f0-9]{64})\.json$/;
const ASSET = /^notes-v1-asset-([a-f0-9]{64})$/;
const copy = value => JSON.parse(JSON.stringify(value));
const stamp = file => [file.version || '', file.size || '', file.sha256Checksum || '', file.md5Checksum || '', file.name].join(':');

class CloudSync extends EventEmitter {
  constructor({ store, assets, auth, api, onStatus, intervalMs = 3600000, now = Date.now } = {}) {
    super();
    if (!store?.mergeRevisions || !auth?.getAccessToken || !assets?.file || !path.isAbsolute(assets.folder || '')) throw new TypeError('CloudSync requer armazenamento, anexos locais e autenticação Google.');
    this.store = store; this.assets = assets; this.auth = auth; this.api = api || new DriveApi({ auth });
    this.onStatus = onStatus; this.intervalMs = Math.max(50, intervalMs); this.now = now;
    this._file = path.join(store.dataDir, 'google-drive-sync-state.json');
    this._controller = new AbortController(); this._generation = 0; this._enabled = true; this._closed = false;
    this._verified = new Map(); this._remoteRevisionIds = new Set(); this._stateQueue = Promise.resolve();
    this._status = { state: 'disconnected', provider: 'google-drive', authConfigured: false, lastSync: null, lastSuccessfulSync: null, nextSync: null, pending: 0, error: null };
    this._storeListener = () => {
      if (this._closed) return;
      this._setStatus({ pending: this._localPending() });
      // Deliberately no sync/debounce here: edits wait for the hourly deadline
      // or the explicit manual button.
    };
    store.on('change', this._storeListener);
  }
  get status() { return copy({ ...this._status, authConfigured: !!this.auth.status?.configured }); }
  getStatus() { return this.status; }
  _setStatus(fields) {
    this._status = { ...this._status, ...fields };
    const status = this.status; this.emit('status', status); this.onStatus?.(this.status); return this.status;
  }
  _localPending() {
    try { return this.store.exportRevisions().filter(record => !this._remoteRevisionIds.has(record.id)).length + (this._blobPending || 0); }
    catch { return this._status.pending; }
  }
  _ensureInit() {
    if (!this._initializing) this._initializing = (async () => {
      await this.store.init(); await this.assets.init?.(); await this.auth.init?.();
      let state;
      try { state = await readJSON(this._file); }
      catch (error) { if (error.code !== 'ENOENT') this._status.error = 'O histórico local de sincronização foi ignorado; suas notas foram preservadas.'; }
      const connectionId = this.auth.status?.connectionId || null;
      if (state?.schema === 1 && state.connectionId === connectionId) {
        this._enabled = state.enabled !== false;
        for (const field of ['lastSync', 'lastSuccessfulSync', 'nextSync']) if (typeof state[field] === 'string' && Number.isFinite(Date.parse(state[field]))) this._status[field] = state[field];
        if (Array.isArray(state.verified)) this._verified = new Map(state.verified.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'));
        if (Array.isArray(state.remoteRevisionIds)) this._remoteRevisionIds = new Set(state.remoteRevisionIds.filter(id => HASH.test(id)));
      }
      this._connectionId = connectionId;
      this._status.pending = this._localPending();
      this._status.state = !this._enabled ? 'disconnected' : this.auth.status?.connected ? 'ready' : 'auth-required';
      if (this._enabled && this.auth.status?.connected && !this._status.nextSync) this._status.nextSync = new Date(this.now()).toISOString();
      return this._setStatus({});
    })();
    return this._initializing;
  }
  async init({ syncIfDue = true } = {}) {
    await this._ensureInit();
    if (syncIfDue) await this.syncIfDue(); else this._schedule();
    return this.status;
  }
  _saveState() {
    const operation = this._stateQueue.then(() => atomicWrite(this._file, {
      schema: 1, enabled: this._enabled, connectionId: this.auth.status?.connectionId || null,
      lastSync: this._status.lastSync, lastSuccessfulSync: this._status.lastSuccessfulSync, nextSync: this._status.nextSync,
      verified: [...this._verified], remoteRevisionIds: [...this._remoteRevisionIds]
    }));
    this._stateQueue = operation.catch(() => {}); return operation;
  }
  _schedule() {
    clearTimeout(this._timer);
    if (this._closed || !this._enabled || !this.auth.status?.connected) return;
    const next = this._status.nextSync ? Date.parse(this._status.nextSync) : this.now();
    this._timer = setTimeout(() => { void this.syncIfDue(); }, Math.max(1, Math.min(2147483647, next - this.now())));
    this._timer.unref?.();
  }
  async syncIfDue() {
    await this._ensureInit();
    if (this._closed || !this._enabled || !this.auth.status?.connected) return this.status;
    if (!this._status.nextSync || this.now() >= Date.parse(this._status.nextSync)) return this.sync();
    this._schedule(); return this.status;
  }
  async connect() {
    await this._ensureInit();
    if (this._closed) throw failure('A sincronização já foi encerrada.', 'DRIVE_CLOSED');
    if (!this.auth.status?.connected) await this.auth.connect();
    this._enabled = true; this.api.reset?.(); this._controller.abort(); this._controller = new AbortController();
    if (this._connectionId !== (this.auth.status?.connectionId || null)) {
      this._verified.clear(); this._remoteRevisionIds.clear(); this._connectionId = this.auth.status?.connectionId || null;
      this._status.lastSync = null; this._status.lastSuccessfulSync = null;
    }
    return this.sync();
  }
  async configure(input) {
    await this._ensureInit();
    if (this._closed) throw failure('A sincronização já foi encerrada.', 'DRIVE_CLOSED');
    const previousId = this.auth.status?.connectionId || null, wasEnabled = this._enabled;
    this._generation++; this._enabled = false; clearTimeout(this._timer);
    this._controller.abort(); this.api.cancel?.();
    if (this._syncing) await this._syncing;
    try {
      await this.auth.configure(input);
      const connected = !!this.auth.status?.connected, connectionId = this.auth.status?.connectionId || null;
      const preserved = connected && connectionId === previousId;
      if (preserved) this._enabled = wasEnabled;
      else {
        this._verified.clear(); this._remoteRevisionIds.clear(); this._blobPending = 0;
        this._status.lastSync = null; this._status.lastSuccessfulSync = null; this._status.nextSync = null;
      }
      this._connectionId = connectionId;
      this._setStatus({ state: preserved && this._enabled ? 'ready' : 'auth-required', pending: this._localPending(), error: this.auth.status?.error || null });
    } catch (error) {
      this._enabled = wasEnabled;
      this._setStatus({ state: this.auth.status?.connected ? 'ready' : 'auth-required', error: error.message });
      throw error;
    } finally {
      this._controller = new AbortController(); this.api.reset?.();
      await this._saveState(); this._schedule();
    }
    return this.status;
  }
  sync() {
    if (this._syncing) return this._syncing;
    this._syncing = (async () => {
      await this._ensureInit();
      if (this._closed || !this._enabled) return this.status;
      if (!this.auth.status?.connected) return this._setStatus({ state: 'auth-required', error: this.auth.status?.error || 'Conecte sua conta Google para sincronizar.' });
      const generation = this._generation, signal = this._controller.signal;
      clearTimeout(this._timer); this._setStatus({ state: 'syncing', error: null, pending: this._localPending() });
      try {
        await this.auth.getAccessToken({ signal });
        const files = await this.api.listFiles({ signal });
        if (generation !== this._generation) return this.status;
        const revisions = [], remoteRevisionIds = new Set(), assetFiles = new Map(), verifiedThisPass = new Map();
        const local = new Map(this.store.exportRevisions().map(record => [record.id, record]));
        for (const file of files) {
          const revisionMatch = REVISION.exec(file.name), assetMatch = ASSET.exec(file.name);
          if (assetMatch) {
            const group = assetFiles.get(assetMatch[1]) || []; group.push(file); assetFiles.set(assetMatch[1], group); continue;
          }
          if (!revisionMatch) continue;
          const id = revisionMatch[1], fileStamp = stamp(file);
          let record = local.get(id);
          if (!record || this._verified.get(file.id) !== fileStamp) {
            const bytes = await this.api.downloadBuffer(file.id, { maxBytes: 64 * 1024 * 1024, signal });
            if (file.sha256Checksum && crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256Checksum) throw failure('Checksum inválido em uma revisão do Google Drive.', 'DRIVE_INTEGRITY');
            try { record = validateRevision(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
            catch { throw failure('Há uma revisão inválida no Google Drive. Os dados locais foram preservados.', 'DRIVE_INTEGRITY'); }
            if (record.id !== id) throw failure('O nome de uma revisão não corresponde ao seu conteúdo.', 'DRIVE_INTEGRITY');
          }
          revisions.push(record); remoteRevisionIds.add(id); verifiedThisPass.set(file.id, fileStamp);
        }
        // All remote revisions, including duplicate filenames, have passed the
        // schema/hash boundary before any merge or cloud write can take place.
        const descriptors = new Map();
        for (const record of [...local.values(), ...revisions]) {
          if (record.kind !== 'note' || record.deleted) continue;
          for (const descriptor of record.value.data.attachments || []) {
            const previous = descriptors.get(descriptor.hash);
            if (previous && previous.size !== descriptor.size) throw failure('Há metadados incompatíveis para o mesmo anexo.', 'DRIVE_INTEGRITY');
            descriptors.set(descriptor.hash, descriptor);
          }
        }
        let missing = 0;
        const availableHashes = new Set();
        for (const [hash, descriptor] of descriptors) {
          signal.throwIfAborted();
          const destination = path.join(this.assets.folder, hash);
          let hasLocal = false;
          try {
            const stat = await fs.lstat(destination);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== descriptor.size) throw failure('O anexo local não corresponde aos metadados e foi preservado.', 'DRIVE_INTEGRITY');
            await this.assets.file(hash); hasLocal = true;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const candidates = assetFiles.get(hash) || [];
          if (!hasLocal && !candidates.length) { missing++; continue; }
          for (const file of candidates) {
            if (Number(file.size) !== descriptor.size || (file.sha256Checksum && file.sha256Checksum !== hash)) throw failure('Checksum ou tamanho de anexo inválido no Google Drive.', 'DRIVE_INTEGRITY');
            const fileStamp = stamp(file);
            if (!hasLocal) {
              await this.api.downloadTo(file.id, destination, { sha256: hash, size: descriptor.size, signal }); hasLocal = true;
              await this.assets.file(hash);
            } else if (this._verified.get(file.id) !== fileStamp) {
              // A server checksum validates a previously uploaded immutable
              // duplicate; otherwise stream and hash the remote bytes.
              if (!file.sha256Checksum) await this.api.verifyFile(file.id, { sha256: hash, size: descriptor.size, signal });
            }
            verifiedThisPass.set(file.id, fileStamp);
          }
          if (hasLocal && !candidates.length) {
            const uploaded = await this.api.uploadImmutable({ name: 'notes-v1-asset-' + hash, filePath: await this.assets.file(hash), sha256: hash, kind: 'asset', signal });
            verifiedThisPass.set(uploaded.id, stamp(uploaded));
          }
          if (hasLocal) availableHashes.add(hash);
        }
        this._blobPending = missing;
        if (generation !== this._generation) return this.status;
        if (missing) {
          // Never advertise metadata-only success or merge notes whose blobs
          // cannot yet be kept in the offline cache. The next hourly/manual
          // pass retries; there is no realtime/busy retry loop.
          this._setStatus({ state: 'syncing', pending: missing + this.store.exportRevisions().filter(record => !remoteRevisionIds.has(record.id)).length, error: null });
        } else {
          await this.store.mergeRevisions(revisions);
          if (generation !== this._generation) return this.status;
          for (const record of this.store.exportRevisions()) {
            if (remoteRevisionIds.has(record.id)) continue;
            // A local edit/import can finish while an hourly transfer is in
            // flight. Its new blobs wait for the next scheduled/manual pass.
            if (record.kind === 'note' && !record.deleted && (record.value.data.attachments || []).some(file => !availableHashes.has(file.hash))) continue;
            const bytes = Buffer.from(JSON.stringify(record));
            const uploaded = await this.api.uploadImmutable({ name: 'notes-v1-rev-' + record.id + '.json', buffer: bytes, kind: 'revision', maxBytes: 64 * 1024 * 1024, signal });
            remoteRevisionIds.add(record.id); verifiedThisPass.set(uploaded.id, stamp(uploaded));
          }
          if (generation !== this._generation) return this.status;
          this._remoteRevisionIds = remoteRevisionIds;
          this._verified = verifiedThisPass;
          const pending = this._localPending();
          this._setStatus({ state: 'ready', pending, error: null, ...(pending ? {} : { lastSuccessfulSync: new Date(this.now()).toISOString() }) });
        }
      } catch (error) {
        if (generation !== this._generation || this._closed) return this.status;
        const authRequired = /^AUTH_/.test(error.code || '') && !['AUTH_CANCELLED', 'AUTH_PROTOCOL'].includes(error.code);
        const offline = ['DRIVE_OFFLINE', 'DRIVE_TEMPORARY', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(error.code) || ['TypeError', 'TimeoutError'].includes(error.name);
        this._setStatus({ state: authRequired ? 'auth-required' : offline ? 'offline' : 'error', error: error.message || 'A sincronização não foi concluída. Os dados locais foram preservados.', pending: this._localPending() });
      } finally {
        if (generation === this._generation && !this._closed) {
          this._setStatus({ lastSync: new Date(this.now()).toISOString(), nextSync: new Date(this.now() + this.intervalMs).toISOString() });
          try { await this._saveState(); }
          catch { this._setStatus({ state: 'error', error: 'Não foi possível salvar o histórico local de sincronização. As notas continuam salvas.' }); }
          this._schedule();
        }
      }
      return this.status;
    })().finally(() => { this._syncing = null; });
    return this._syncing;
  }
  async disconnect() {
    await this._ensureInit(); this._generation++; this._enabled = false;
    clearTimeout(this._timer); this._controller.abort(); this.api.cancel?.();
    await this.auth.disconnect?.();
    if (this._syncing) await this._syncing;
    this._verified.clear(); this._remoteRevisionIds.clear(); this._blobPending = 0;
    this._controller = new AbortController();
    this._setStatus({ state: 'disconnected', nextSync: null, pending: this._localPending(), error: null });
    await this._saveState(); return this.status;
  }
  async close() {
    this._closed = true; this._generation++; clearTimeout(this._timer);
    this._controller.abort(); this.api.cancel?.(); this.store.off('change', this._storeListener);
    await this.store.close();
    if (this._syncing) await this._syncing;
    await this._stateQueue; await this.auth.close?.();
    // Authorization remains encrypted for the next launch. Closing never
    // starts a cloud upload or an OAuth revocation.
    return this.status;
  }
}

module.exports = { CloudSync };
