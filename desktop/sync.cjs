'use strict';

/*
 * Folder sync intentionally uses Google Drive for desktop, rather than storing
 * OAuth credentials. connect(root) manages only root/notes (or an already
 * marked notes folder). No file outside that managed folder is changed.
 * The protocol is append-only content-addressed JSON, so two computers never
 * overwrite one another's workspace. Polling remains active when fs.watch is
 * unavailable and after the drive is temporarily disconnected.
 *
 * Public: connect(root), sync(), disconnect(), close() -> Promise<status>.
 * .status is a defensive copy; onStatus(status) and 'status' events are emitted.
 * Optional assets.syncFolder(folder, descriptors) synchronizes attachment blobs.
 * ready means every known revision and attachment is available in that folder.
 * It does NOT assert that the Google Drive client has uploaded to the cloud.
 */
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateRevision, atomicWrite, readJSON } = require('./storage.cjs');

const MARKER = '.notes-sync.json';
const MARKER_DATA = { format: 'notes-sync', version: 1 };
const FILE = /^([a-f0-9]{64})(?: \(\d+\))?\.json$/;
const OFFLINE = new Set(['ENOENT', 'ENOTDIR', 'ENODEV', 'EIO', 'ENOTCONN', 'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTUNREACH']);
const copy = value => JSON.parse(JSON.stringify(value));
const validAttachment = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
  && typeof value.name === 'string' && typeof value.mime === 'string' && typeof value.relativePath === 'string'
  && Number.isSafeInteger(value.size) && value.size >= 0;

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Bound concurrency to avoid exhausting handles on large notebooks/virtual disks.
async function batches(items, action, width = 8) {
  for (let start = 0; start < items.length; start += width) {
    const results = await Promise.allSettled(items.slice(start, start + width).map(action));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

class SyncEngine extends EventEmitter {
  constructor({ store, assets, onStatus, pollIntervalMs = 5000, debounceMs = 200, watch = true, closeTimeoutMs = 3000 } = {}) {
    super();
    if (!store || typeof store.mergeRevisions !== 'function') throw new TypeError('SyncEngine requer um WorkspaceStore.');
    if (assets !== undefined && (!assets || typeof assets.syncFolder !== 'function')) throw new TypeError('assets deve fornecer syncFolder().');
    this.store = store;
    this.assets = assets;
    this._onStatus = onStatus;
    this._pollIntervalMs = Math.max(50, pollIntervalMs);
    this._debounceMs = Math.max(10, debounceMs);
    this._watchEnabled = watch;
    this._closeTimeoutMs = Math.max(50, closeTimeoutMs);
    this._status = { state: 'disconnected', folder: null, lastSync: null, error: null, pending: 0 };
    this._root = null;
    this._folder = null;
    this._generation = 0;
    this._selectionResolved = false;
    this._syncing = null;
    this._again = false;
    this._cache = new Map();
    this._storeListener = () => this._schedule();
    store.on('change', this._storeListener);
  }

  get status() { return copy(this._status); }

  _setStatus(values) {
    this._status = { ...this._status, ...values };
    const snapshot = this.status;
    this.emit('status', snapshot);
    if (this._onStatus) this._onStatus(this.status);
    return this.status;
  }

  async connect(selectedRoot) {
    if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot)) throw new TypeError('Selecione uma pasta com caminho absoluto.');
    await this.disconnect();
    await this.store.init();
    this._root = path.resolve(selectedRoot);
    // A marked folder may be selected directly, useful for shared Drive folders.
    let directlyManaged = false;
    try { directlyManaged = await exists(path.join(this._root, MARKER)); }
    catch { /* _run reports inaccessible/offline roots as status. */ }
    // The offline path is provisional. Resolve the marker only after the root
    // becomes available, otherwise selecting notes itself could create an
    // unintended notes/notes journal on the next startup.
    this._folder = directlyManaged || path.basename(this._root).toLowerCase() === 'notes' ? this._root : path.join(this._root, 'notes');
    this._selectionResolved = false;
    this._cache.clear();
    this._knownManaged = false;
    this._setStatus({ state: 'syncing', folder: this._folder, error: null, lastSync: null, pending: this.store.exportRevisions().length });
    this._poll = setInterval(() => { void this.sync(); }, this._pollIntervalMs);
    this._poll.unref?.();
    return this.sync();
  }

  _schedule() {
    if (!this._folder || this._scheduled) return;
    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      void this.sync();
    }, this._debounceMs);
    this._scheduled.unref?.();
  }

  async _ensureManaged(root, folder) {
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) {
      const error = new Error('A pasta selecionada está indisponível.');
      error.code = 'ENOTDIR';
      throw error;
    }
    const marker = path.join(folder, MARKER);
    if (!(await exists(folder))) {
      try { await fs.mkdir(folder); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const folderStat = await fs.lstat(folder);
    if (!folderStat.isDirectory() || (folder !== root && folderStat.isSymbolicLink())) throw new Error('A pasta notes deve ser uma pasta regular.');
    if (await exists(marker)) {
      const value = await readJSON(marker);
      if (value.format !== MARKER_DATA.format || value.version !== MARKER_DATA.version) throw new Error('Esta pasta usa um formato notes incompatível.');
    } else {
      const entries = (await fs.readdir(folder)).filter(name => !/^\.notes-sync\.json\.[a-f0-9-]+\.tmp$/.test(name));
      if (await exists(marker)) {
        const value = await readJSON(marker);
        if (value.format !== MARKER_DATA.format || value.version !== MARKER_DATA.version) throw new Error('Esta pasta usa um formato notes incompatível.');
      } else {
        if (entries.length && !this._knownManaged) throw new Error('A pasta notes já contém arquivos sem o marcador do aplicativo. Selecione outra pasta.');
        await atomicWrite(marker, MARKER_DATA);
      }
    }
    const revisions = path.join(folder, 'revisions');
    try { await fs.mkdir(revisions); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const revisionStat = await fs.lstat(revisions);
    if (!revisionStat.isDirectory() || revisionStat.isSymbolicLink()) throw new Error('A pasta de revisões deve ser uma pasta regular.');
    this._knownManaged = true;
    return revisions;
  }

  _watch(revisions) {
    if (!this._watchEnabled || this._watcher) return;
    try {
      this._watcher = nativeFs.watch(revisions, () => this._schedule());
      this._watcher.unref?.();
      this._watcher.on('error', () => {
        this._watcher?.close();
        this._watcher = null;
      });
    } catch { /* Some Drive virtual file systems only support polling. */ }
  }

  sync() {
    if (!this._folder) return Promise.resolve(this.status);
    if (this._syncing) {
      this._again = true;
      return this._syncing;
    }
    const generation = this._generation;
    this._syncing = (async () => {
      // One additional pass handles a save received while the first was writing.
      for (let pass = 0; pass < 2; pass++) {
        this._again = false;
        await this._run(generation);
        if (!this._again || generation !== this._generation || !this._folder) break;
      }
      return this.status;
    })().finally(() => { this._syncing = null; });
    return this._syncing;
  }

  async _run(generation) {
    const root = this._root;
    let folder = this._folder;
    if (!root || !folder || generation !== this._generation) return;
    this._setStatus({ state: 'syncing', error: null });
    try {
      if (!this._selectionResolved) {
        // Never infer an absent marker from an unavailable Drive mount.
        const rootStat = await fs.stat(root);
        if (!rootStat.isDirectory()) {
          const error = new Error('A pasta selecionada está indisponível.');
          error.code = 'ENOTDIR';
          throw error;
        }
        folder = await exists(path.join(root, MARKER)) ? root : path.join(root, 'notes');
        this._folder = folder;
        this._setStatus({ folder });
      }
      const revisions = await this._ensureManaged(root, folder);
      if (generation !== this._generation) return;
      this._selectionResolved = true;
      const filenames = (await fs.readdir(revisions)).filter(name => FILE.test(name)).sort();
      const incoming = [], remoteIds = new Set(), errors = [];
      await batches(filenames, async name => {
        const file = path.join(revisions, name);
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('A revisão deve ser um arquivo regular.');
          const cached = this._cache.get(name);
          let record;
          if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) record = cached.record;
          else {
            record = validateRevision(await readJSON(file));
            if (record.id !== FILE.exec(name)[1]) throw new Error('Nome da revisão não corresponde ao conteúdo.');
            this._cache.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, record });
          }
          remoteIds.add(record.id);
          incoming.push(record);
        } catch (error) {
          this._cache.delete(name);
          errors.push(name + ': ' + error.message);
        }
      });
      if (generation !== this._generation) return;
      await this.store.mergeRevisions(incoming);
      const outgoing = this.store.exportRevisions().filter(record => !remoteIds.has(record.id));
      this._setStatus({ pending: outgoing.length });
      let remaining = outgoing.length;
      await batches(outgoing, async record => {
        if (generation !== this._generation) return;
        const file = path.join(revisions, record.id + '.json');
        // An existing malformed revision is preserved for recovery; do not
        // overwrite it and pretend that synchronization succeeded.
        if (await exists(file)) {
          const existing = validateRevision(await readJSON(file));
          if (existing.id !== record.id) throw new Error('Revisão remota com checksum inválido.');
        } else await atomicWrite(file, record);
        remoteIds.add(record.id);
        remaining--;
      });
      if (generation !== this._generation) return;
      let attachmentPending = 0;
      if (this.assets) {
        const descriptors = this.store.snapshot.notes.flatMap(note => Array.isArray(note.attachments) ? note.attachments : []).filter(validAttachment);
        const assetsResult = await this.assets.syncFolder(folder, descriptors);
        if (generation !== this._generation) return;
        if (!assetsResult || !Number.isSafeInteger(assetsResult.pending) || assetsResult.pending < 0) throw new Error('Resultado inválido da sincronização de anexos.');
        attachmentPending = assetsResult.pending;
      }
      const revisionPending = this.store.exportRevisions().filter(record => !remoteIds.has(record.id)).length;
      remaining = revisionPending + attachmentPending;
      if (errors.length) {
        this._setStatus({ state: 'error', pending: remaining, error: 'Há revisões inválidas na pasta. Os dados locais foram preservados. ' + errors.slice(0, 3).join(' | ') });
      } else if (remaining) {
        // Metadata may arrive before its binary. Wait for the next poll for
        // missing blobs, rather than spinning immediate repeated sync passes.
        if (revisionPending) this._again = true;
        this._setStatus({ state: 'syncing', pending: remaining, error: null });
      } else {
        this._setStatus({ state: 'ready', pending: 0, error: null, lastSync: new Date().toISOString() });
      }
      this._watch(revisions);
    } catch (error) {
      if (generation !== this._generation) return;
      this._watcher?.close();
      this._watcher = null;
      this._setStatus({ state: OFFLINE.has(error.code) ? 'offline' : 'error', error: error.message });
    }
  }

  async disconnect({ wait = true } = {}) {
    this._generation++;
    clearInterval(this._poll);
    clearTimeout(this._scheduled);
    this._scheduled = null;
    this._watcher?.close();
    this._watcher = null;
    this._folder = null;
    this._root = null;
    this._selectionResolved = false;
    if (wait && this._syncing) await this._syncing;
    return this._setStatus({ state: 'disconnected', folder: null, error: null, pending: 0 });
  }

  async close() {
    // Flush a last debounced edit before clearing timers. The local journal is
    // always drained; an unavailable network/virtual disk cannot hold exit open.
    await this.store.close();
    let timedOut = false, timer;
    if (this._folder) {
      await Promise.race([
        this.sync(),
        new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, this._closeTimeoutMs); })
      ]).finally(() => clearTimeout(timer));
    }
    await this.disconnect({ wait: !timedOut });
    this.store.off('change', this._storeListener);
    return this.status;
  }
}

module.exports = { SyncEngine };
