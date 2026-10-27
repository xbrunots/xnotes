'use strict';

/*
 * Public contract: await init(); snapshot is a defensive JSON copy. save(next,
 * { base }) diffs against the editor's acknowledged base, so an old autosave
 * cannot delete entities just received from another PC. Saves are serialized,
 * journaled and fsynced before 'change' is emitted. close() drains the queue.
 *
 * The sync protocol is a content-addressed, immutable revision journal. Each
 * entity (note, group, session, individual root preference) has a vector clock.
 * Dominated versions cannot resurrect deleted entities. Concurrent versions are
 * resolved deterministically; losing note text becomes a normal, visible note.
 * Checkpoints contain all current heads, including tombstones; the journal also
 * retains historical versions. Neither clock ordering nor conflict detection
 * depends on the PCs having correctly synchronized wall clocks.
 *
 * Limits: individual revisions are at most 64 MiB; the current-head checkpoint
 * is at most 512 MiB. All new records and the complete checkpoint are checked
 * BEFORE any journal/backup write. Rejected imports therefore cannot reappear
 * partially after restart. Optional limits:{revisionBytes,checkpointBytes} is a
 * test hook; reads and writes always enforce the same configured limits.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const FORMAT = 1;
const MAX_REVISION_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const validDevice = value => typeof value === 'string' && DEVICE.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const KINDS = new Set(['note', 'group', 'session', 'pref']);
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
};
const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const equal = (a, b) => stable(a) === stable(b);
const entityKey = (kind, key) => kind + ':' + key;
const idKey = id => JSON.stringify(id);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = id => (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isSafeInteger(id));

function assertJSON(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && !plain(value))) throw new TypeError('O estado deve conter somente dados JSON válidos.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) throw new TypeError('Listas JSON não podem conter posições vazias.');
      assertJSON(value[index], seen);
    }
  } else for (const child of Object.values(value)) assertJSON(child, seen);
  seen.delete(value);
}

function validateAttachments(value) {
  if (!Array.isArray(value) || value.some(file => !plain(file) || typeof file.hash !== 'string' || !HASH.test(file.hash)
    || typeof file.name !== 'string' || typeof file.mime !== 'string' || typeof file.relativePath !== 'string'
    || !Number.isSafeInteger(file.size) || file.size < 0)) throw new TypeError('Anexos inválidos: use uma lista de descritores de arquivo completos.');
}

function validateNoteData(note) {
  if (!plain(note) || !validId(note.id) || !validId(note.s) || typeof note.title !== 'string' || typeof note.body !== 'string') throw new TypeError('Nota inválida: ID, sessão, título e texto são obrigatórios.');
  if (own(note, 'attachments')) validateAttachments(note.attachments);
  if (own(note, 'tags') && (!Array.isArray(note.tags) || note.tags.some(tag => typeof tag !== 'string'))) throw new TypeError('Tags inválidas: use uma lista de textos.');
  for (const key of ['t', 'dailyKey']) if (own(note, key) && typeof note[key] !== 'string') throw new TypeError('Campo de nota inválido: ' + key + '.');
  if (own(note, 'deletedAt') && note.deletedAt !== null && typeof note.deletedAt !== 'string') throw new TypeError('Data de exclusão inválida.');
}

function validateGroupData(group) {
  if (!plain(group) || !validId(group.id) || typeof group.name !== 'string') throw new TypeError('Grupo inválido: ID e nome são obrigatórios.');
  if (own(group, 'color') && typeof group.color !== 'string') throw new TypeError('Cor de grupo inválida.');
}

function validateSessionData(session) {
  if (!plain(session) || !validId(session.id) || typeof session.name !== 'string') throw new TypeError('Sessão inválida: ID e nome são obrigatórios.');
}

function validPanelSizes(value) {
  if(!plain(value)||Object.keys(value).some(key=>!['sidebar','list','notes','sections'].includes(key)))return false;
  const inRange=(size,min,max)=>typeof size==='number'&&Number.isFinite(size)&&size>=min&&size<=max;
  for(const [key,min,max] of [['sidebar',180,420],['list',220,520]])if(own(value,key)&&!inRange(value[key],min,max))return false;
  for(const [key,maxEntries,min,max] of [['notes',512,260,1600],['sections',64,80,1600]])if(own(value,key)){
    if(!plain(value[key]))return false;
    const entries=Object.entries(value[key]);
    if(entries.length>maxEntries||entries.some(([id,size])=>!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,255}$/u.test(id)||['__proto__','prototype','constructor'].includes(id)||!inRange(size,min,max)))return false;
  }
  return true;
}
const PREFERENCE_VALIDATORS = {
  panelSizes: validPanelSizes,
  openBy: value => plain(value) && Object.values(value).every(ids => Array.isArray(ids) && ids.every(validId)),
  focusBy: value => plain(value) && Object.values(value).every(id => id === null || validId(id)),
  expanded: value => plain(value) && Object.values(value).every(expanded => typeof expanded === 'boolean'),
  layout: value => value === 'split' || value === 'focus',
  appearance: value => value === 'standard' || value === 'islands',
  noteDisplay: value => value === 'single' || value === 'split' || value === 'grid',
  sidebar: value => typeof value === 'boolean',
  theme: value => value === null || value === 'dark' || value === 'light',
  accent: value => typeof value === 'string',
  motion: value => typeof value === 'boolean',
  blur: value => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  session: value => value === null || validId(value),
  view: value => ['session', 'all', 'tag'].includes(value),
  tag: value => value === null || typeof value === 'string'
};

function validatePreference(key, value) {
  if (own(PREFERENCE_VALIDATORS, key) && !PREFERENCE_VALIDATORS[key](value)) throw new TypeError('Preferência inválida: ' + key + '.');
}

function validateSnapshot(input) {
  assertJSON(input);
  if (!plain(input) || !Array.isArray(input.groups) || !Array.isArray(input.notes)) throw new TypeError('Estado inválido: groups e notes devem ser listas.');
  const groups = new Set(), sessions = new Set(), notes = new Set();
  for (const group of input.groups) {
    validateGroupData(group);
    if (!Array.isArray(group.sessions) || groups.has(idKey(group.id))) throw new TypeError('Grupo inválido ou ID duplicado.');
    groups.add(idKey(group.id));
    for (const session of group.sessions) {
      validateSessionData(session);
      if (sessions.has(idKey(session.id))) throw new TypeError('Sessão inválida ou ID duplicado.');
      sessions.add(idKey(session.id));
    }
  }
  for (const note of input.notes) {
    validateNoteData(note);
    if (notes.has(idKey(note.id))) throw new TypeError('Nota inválida ou ID duplicado.');
    notes.add(idKey(note.id));
  }
  for (const [key, value] of Object.entries(input)) validatePreference(key, value);
  return clone(input);
}

function entitiesOf(snapshot) {
  const result = new Map();
  snapshot.groups.forEach((group, order) => {
    const { sessions, ...data } = group;
    result.set(entityKey('group', idKey(group.id)), { kind: 'group', key: idKey(group.id), value: { data, order } });
    sessions.forEach((session, sessionOrder) => result.set(entityKey('session', idKey(session.id)), {
      kind: 'session', key: idKey(session.id), value: { data: session, groupId: group.id, order: sessionOrder }
    }));
  });
  snapshot.notes.forEach((note, order) => result.set(entityKey('note', idKey(note.id)), { kind: 'note', key: idKey(note.id), value: { data: note, order } }));
  for (const [key, value] of Object.entries(snapshot)) {
    if (key !== 'groups' && key !== 'notes') result.set(entityKey('pref', key), { kind: 'pref', key, value });
  }
  return result;
}

function revision(fields) {
  return { ...fields, id: digest(fields) };
}

function validateRevision(record) {
  assertJSON(record);
  if (!plain(record) || record.schema !== FORMAT || !HASH.test(record.id) || !KINDS.has(record.kind) || typeof record.key !== 'string' || !validDevice(record.device) || !plain(record.clock) || typeof record.deleted !== 'boolean' || typeof record.createdAt !== 'string') throw new Error('Revisão inválida.');
  const components = Object.entries(record.clock);
  if (!components.length || components.some(([device, count]) => !validDevice(device) || !Number.isSafeInteger(count) || count < 1)) throw new Error('Relógio de revisão inválido.');
  if (record.deleted ? own(record, 'value') : !own(record, 'value')) throw new Error('Conteúdo da revisão inválido.');
  if (record.kind !== 'pref') {
    let decoded;
    try { decoded = JSON.parse(record.key); } catch { throw new Error('ID de revisão inválido.'); }
    if (!validId(decoded)) throw new Error('ID de revisão inválido.');
    if (!record.deleted) {
      const value = record.value;
      if (!plain(value) || !plain(value.data) || !equal(value.data.id, decoded) || !Number.isFinite(value.order)) throw new Error('Entidade da revisão inválida.');
      if (record.kind === 'note') validateNoteData(value.data);
      if (record.kind === 'group') validateGroupData(value.data);
      if (record.kind === 'session') {
        validateSessionData(value.data);
        if (!validId(value.groupId)) throw new Error('Grupo da sessão inválido.');
      }
    }
  } else {
    if (record.key === 'groups' || record.key === 'notes') throw new Error('Preferência reservada.');
    if (!record.deleted) validatePreference(record.key, record.value);
  }
  const { id, ...fields } = record;
  if (digest(fields) !== id) throw new Error('Checksum da revisão inválido.');
  return record;
}

function dominates(a, b) {
  let greater = false;
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[device] || 0, bv = b[device] || 0;
    if (av < bv) return false;
    if (av > bv) greater = true;
  }
  return greater;
}

function headsOf(records) {
  const result = new Map();
  for (const record of records.values()) {
    const key = entityKey(record.kind, record.key), heads = result.get(key) || [];
    if (heads.some(head => head.id === record.id || dominates(head.clock, record.clock))) continue;
    result.set(key, heads.filter(head => !dominates(record.clock, head.clock)).concat(record));
  }
  return result;
}

// A concurrent deletion removes the original; any concurrent edited text is
// retained in a conflict copy. Other concurrent choices have a stable winner.
function compareRevisions(a, b) {
  if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
  const ac = Math.max(...Object.values(a.clock)), bc = Math.max(...Object.values(b.clock));
  return ac - bc || a.device.localeCompare(b.device, 'en') || a.id.localeCompare(b.id, 'en');
}
const winnerOf = heads => heads.reduce((best, item) => !best || compareRevisions(item, best) > 0 ? item : best, null);

function conflictCopy(source) {
  const data = clone(source.value.data);
  data.id = String(data.id) + '--conflict-' + source.id.slice(0, 20);
  data.title = (data.title || 'Sem título') + ' (cópia em conflito)';
  data._notesConflict = { noteId: source.value.data.id, revision: source.id, device: source.device, createdAt: source.createdAt };
  return revision({ schema: FORMAT, kind: 'note', key: idKey(data.id), device: 'conflict', clock: { conflict: 1 }, deleted: false,
    value: { data, order: source.value.order + 0.0001 }, createdAt: source.createdAt });
}

function preserveConflicts(records) {
  for (const heads of headsOf(records).values()) {
    if (heads.length < 2 || heads[0].kind !== 'note') continue;
    const winner = winnerOf(heads);
    for (const head of heads) {
      if (head.id === winner.id || head.deleted || (!winner.deleted && equal(head.value.data, winner.value.data))) continue;
      const copy = conflictCopy(head);
      if (!records.has(copy.id)) records.set(copy.id, copy);
    }
  }
}

function project(records) {
  const active = [...headsOf(records).values()].map(winnerOf).filter(record => !record.deleted);
  const ordered = kind => active.filter(record => record.kind === kind).sort((a, b) => a.value.order - b.value.order || a.key.localeCompare(b.key, 'en'));
  const snapshot = Object.fromEntries(active.filter(record => record.kind === 'pref').map(record => [record.key, clone(record.value)]));
  const groups = ordered('group').map(record => ({ ...clone(record.value.data), sessions: [] }));
  const groupMap = new Map(groups.map(group => [idKey(group.id), group]));
  const sessionMap = new Map();
  let recoveryGroup;
  const getRecoveryGroup = () => {
    if (!recoveryGroup) {
      let id = 'notes-recovered';
      while (groupMap.has(idKey(id))) id += '-';
      recoveryGroup = { id, name: 'Notas recuperadas', color: '#F2B225', sessions: [] };
      groups.push(recoveryGroup);
    }
    return recoveryGroup;
  };
  for (const record of ordered('session')) {
    const session = clone(record.value.data), group = groupMap.get(idKey(record.value.groupId)) || getRecoveryGroup();
    group.sessions.push(session);
    sessionMap.set(idKey(session.id), session);
  }
  const notes = ordered('note').map(record => clone(record.value.data));
  for (const note of notes) {
    if (validId(note.s) && !sessionMap.has(idKey(note.s))) {
      const session = { id: note.s, name: 'Notas recuperadas' };
      getRecoveryGroup().sessions.push(session);
      sessionMap.set(idKey(note.s), session);
    }
  }
  snapshot.groups = groups;
  snapshot.notes = notes;
  return snapshot;
}

function sizeError(maxBytes, kind) {
  const error = new Error((kind === 'checkpoint' ? 'O checkpoint local' : 'O arquivo de revisão') + ' excede o limite de ' + maxBytes + ' bytes. Os dados anteriores foram preservados.');
  error.code = 'NOTES_SIZE_LIMIT';
  error.maxBytes = maxBytes;
  error.kind = kind;
  return error;
}

function encodeJSON(value, maxBytes, kind = 'revision') {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) {
    if (error instanceof RangeError) throw sizeError(maxBytes, kind);
    throw error;
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw sizeError(maxBytes, kind);
  return encoded;
}

async function readJSON(file, { maxBytes = MAX_REVISION_BYTES, kind = 'revision' } = {}) {
  const stat = await fs.stat(file);
  if (stat.size > maxBytes) throw sizeError(maxBytes, kind);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function atomicWrite(file, value, { maxBytes = MAX_REVISION_BYTES, kind = 'revision' } = {}) {
  return atomicWriteEncoded(file, encodeJSON(value, maxBytes, kind));
}

async function atomicWriteEncoded(file, encoded) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = null;
    // A short retry also accommodates Windows virus scanners holding a handle.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

class WorkspaceStore extends EventEmitter {
  constructor({ dataDir, seed, deviceId, machineFingerprint, limits = {} } = {}) {
    super();
    if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('dataDir deve ser um caminho absoluto.');
    if (deviceId !== undefined && (!validDevice(deviceId) || ['seed', 'conflict'].includes(deviceId))) throw new TypeError('deviceId inválido.');
    const revisionBytes = limits.revisionBytes ?? MAX_REVISION_BYTES, checkpointBytes = limits.checkpointBytes ?? MAX_CHECKPOINT_BYTES;
    if (!Number.isSafeInteger(revisionBytes) || revisionBytes < 1 || !Number.isSafeInteger(checkpointBytes) || checkpointBytes < 1) throw new TypeError('Os limites de armazenamento devem ser inteiros positivos em bytes.');
    this._limits = Object.freeze({ revisionBytes, checkpointBytes });
    this.dataDir = dataDir;
    this.deviceId = deviceId;
    // Portable folders may be copied with device.json. Only a hash is stored;
    // neither the machine name nor any hardware identifier leaves this process.
    // The optional override makes environment migration reproducibly testable.
    this._machineFingerprint = digest(machineFingerprint === undefined
      ? { hostname: os.hostname(), platform: process.platform, arch: process.arch, directory: path.resolve(dataDir).toLowerCase() }
      : { testEnvironment: String(machineFingerprint) });
    this.identityChanged = false;
    this._seed = seed;
    this._records = new Map();
    this._snapshot = null;
    this._clock = 0;
    this._queue = Promise.resolve();
    this._initializing = null;
    this._ready = false;
    this.recovery = null;
  }

  get snapshot() {
    if (!this._ready) throw new Error('Inicialize o armazenamento antes de ler o estado.');
    return clone(this._snapshot);
  }

  init() {
    if (!this._initializing) this._initializing = this._initialize();
    return this._initializing.then(() => this.snapshot);
  }

  async _initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const archive = path.join(this.dataDir, 'revisions');
    await fs.mkdir(archive, { recursive: true });
    const checkpoint = path.join(this.dataDir, 'workspace.json');
    const warnings = [], invalidFiles = [];
    let envelope = null, envelopeSource = null, foundCheckpoint = false;
    for (const file of [checkpoint, checkpoint + '.bak1', checkpoint + '.bak2', checkpoint + '.bak3']) {
      try {
        const value = await readJSON(file, { maxBytes: this._limits.checkpointBytes, kind: 'checkpoint' });
        foundCheckpoint = true;
        const { checksum, ...payload } = value;
        if (payload.schema !== FORMAT || !validDevice(payload.deviceId) || !Array.isArray(payload.heads) || checksum !== digest(payload)) throw new Error('Checkpoint inválido.');
        payload.heads.forEach(validateRevision);
        envelope = payload;
        envelopeSource = file;
        break;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        foundCheckpoint = true;
        warnings.push(path.basename(file) + ': ' + error.message);
        invalidFiles.push(file);
      }
    }
    let metadata = null;
    const metadataFile = path.join(this.dataDir, 'device.json');
    try {
      metadata = await readJSON(metadataFile);
      if (metadata.schema !== FORMAT || !validDevice(metadata.deviceId)) throw new Error('Identidade local inválida.');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        warnings.push('device.json: ' + error.message);
        invalidFiles.push(metadataFile);
      }
      metadata = null;
    }
    const entries = await fs.readdir(archive);
    let archiveCount = 0;
    for (const name of entries.filter(name => HASH.test(name.slice(0, -5)) && name.endsWith('.json'))) {
      const file = path.join(archive, name);
      try {
        const record = validateRevision(await readJSON(file, { maxBytes: this._limits.revisionBytes }));
        if (name !== record.id + '.json') throw new Error('Nome da revisão não corresponde ao conteúdo.');
        this._records.set(record.id, record);
        (this._persisted ||= new Set()).add(record.id);
        archiveCount++;
      } catch (error) {
        warnings.push(name + ': ' + error.message);
        invalidFiles.push(file);
      }
    }
    if (envelope) for (const record of envelope.heads) this._records.set(record.id, record);
    // Never silently replace an existing, unrecoverable workspace with demos.
    if (!envelope && !this._records.size && (foundCheckpoint || invalidFiles.length || metadata)) {
      const error = new Error('Não foi possível recuperar os dados locais. Os arquivos foram preservados em ' + this.dataDir + '.');
      error.code = 'NOTES_RECOVERY_REQUIRED';
      throw error;
    }
    const previousFingerprint = metadata?.machineFingerprint || envelope?.machineFingerprint;
    if (!this.deviceId && previousFingerprint && previousFingerprint !== this._machineFingerprint) {
      this.deviceId = crypto.randomUUID();
      this.identityChanged = true;
    }
    this.deviceId ||= metadata?.deviceId || envelope?.deviceId || crypto.randomUUID();
    for (const record of this._records.values()) this._clock = Math.max(this._clock, record.clock[this.deviceId] || 0);
    if (!this._records.size && !envelope) {
      const seed = validateSnapshot(typeof this._seed === 'function' ? this._seed() : this._seed || { groups: [], notes: [] });
      for (const entity of entitiesOf(seed).values()) {
        const record = revision({ schema: FORMAT, ...entity, device: 'seed', clock: { seed: 1 }, deleted: false, createdAt: '1970-01-01T00:00:00.000Z' });
        this._records.set(record.id, record);
      }
    }
    if (warnings.length || (envelopeSource && envelopeSource !== checkpoint) || (!envelope && archiveCount)) {
      const recoveryDir = path.join(this.dataDir, 'recovery');
      await fs.mkdir(recoveryDir, { recursive: true });
      const preserved = [];
      for (const file of invalidFiles) {
        const target = path.join(recoveryDir, path.basename(file) + '.' + Date.now() + '.' + crypto.randomUUID() + '.corrupt');
        await fs.copyFile(file, target);
        preserved.push(target);
        // Corrupt archives are quarantined; a valid checkpoint may restore them.
        if (path.dirname(file) === archive) await fs.unlink(file);
      }
      this.recovery = { source: envelopeSource || 'journal', preserved, warnings, recoveredAt: new Date().toISOString() };
    }
    preserveConflicts(this._records);
    const initializedSnapshot = validateSnapshot(project(this._records));
    await this._persist(this._records, false);
    await atomicWrite(metadataFile, { schema: FORMAT, deviceId: this.deviceId, machineFingerprint: this._machineFingerprint });
    this._snapshot = initializedSnapshot;
    this._ready = true;
  }

  _enqueue(operation) {
    const result = this._queue.then(operation);
    this._queue = result.catch(() => {});
    return result;
  }

  async _persist(records, rotate = true) {
    // Validate the complete transaction before writing any new immutable file.
    // Otherwise a rejected oversized checkpoint could leave journal entries that
    // would be replayed on restart despite save() having failed.
    const checked = [];
    for (const record of records.values()) {
      if (this._validated?.has(record.id)) continue;
      encodeJSON(record, this._limits.revisionBytes);
      checked.push(record.id);
    }
    const payload = { schema: FORMAT, deviceId: this.deviceId, machineFingerprint: this._machineFingerprint, heads: [...headsOf(records).values()].flat().sort((a, b) => a.id.localeCompare(b.id, 'en')) };
    let checkpoint;
    try { checkpoint = { ...payload, checksum: digest(payload) }; }
    catch (error) {
      if (error instanceof RangeError) throw sizeError(this._limits.checkpointBytes, 'checkpoint');
      throw error;
    }
    const encodedCheckpoint = encodeJSON(checkpoint, this._limits.checkpointBytes, 'checkpoint');
    for (const id of checked) (this._validated ||= new Set()).add(id);
    const archive = path.join(this.dataDir, 'revisions');
    for (const record of records.values()) {
      if (this._persisted?.has(record.id)) continue;
      const file = path.join(archive, record.id + '.json');
      try {
        const existing = validateRevision(await readJSON(file, { maxBytes: this._limits.revisionBytes }));
        if (existing.id !== record.id) throw new Error('Colisão de ID no histórico local.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(file, record, { maxBytes: this._limits.revisionBytes });
      }
      (this._persisted ||= new Set()).add(record.id);
    }
    const file = path.join(this.dataDir, 'workspace.json');
    if (rotate) {
      for (let i = 3; i >= 1; i--) {
        try { await fs.copyFile(i === 1 ? file : file + '.bak' + (i - 1), file + '.bak' + i); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    await atomicWriteEncoded(file, encodedCheckpoint);
  }

  async save(next, { base } = {}) {
    // Capture now, before await/queue: callers may keep typing into their object.
    const captured = validateSnapshot(next);
    const capturedBase = base === undefined ? null : validateSnapshot(base);
    return this._enqueue(async () => {
      await this.init();
      const before = entitiesOf(capturedBase || this._snapshot), after = entitiesOf(captured);
      const current = entitiesOf(this._snapshot), heads = headsOf(this._records);
      const candidate = new Map(this._records);
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(key), updated = after.get(key);
        if (equal(old, updated)) continue;
        const entity = updated || old, activeHeads = heads.get(key) || [];
        if (capturedBase && entity.kind === 'note') {
          const currentValue = current.get(key);
          if (currentValue && !equal(old?.value?.data, currentValue.value.data) && !equal(updated?.value?.data, currentValue.value.data)) {
            const source = winnerOf(activeHeads);
            if (source && !source.deleted && source.device !== this.deviceId) {
              const copy = conflictCopy(source);
              candidate.set(copy.id, copy);
            }
          }
        }
        const clock = Object.fromEntries([...new Set(activeHeads.flatMap(head => Object.keys(head.clock)))].map(device => [device, Math.max(...activeHeads.map(head => head.clock[device] || 0))]));
        clock[this.deviceId] = ++this._clock;
        const fields = { schema: FORMAT, kind: entity.kind, key: entity.key, device: this.deviceId, clock, deleted: !updated, createdAt: new Date().toISOString() };
        if (updated) fields.value = updated.value;
        const record = revision(fields);
        candidate.set(record.id, record);
      }
      if (candidate.size === this._records.size) return this.snapshot;
      preserveConflicts(candidate);
      const nextSnapshot = validateSnapshot(project(candidate));
      await this._persist(candidate);
      this._records = candidate;
      this._snapshot = nextSnapshot;
      const snapshot = this.snapshot;
      this.emit('change', snapshot);
      return this.snapshot;
    });
  }

  exportRevisions() {
    if (!this._ready) throw new Error('Inicialize o armazenamento antes de exportar.');
    return [...this._records.values()].map(clone);
  }

  async mergeRevisions(incoming) {
    const captured = incoming.map(record => clone(validateRevision(record)));
    return this._enqueue(async () => {
      await this.init();
      const candidate = new Map(this._records);
      for (const record of captured) candidate.set(record.id, record);
      preserveConflicts(candidate);
      if (candidate.size === this._records.size) return this.snapshot;
      const nextSnapshot = validateSnapshot(project(candidate));
      await this._persist(candidate);
      this._records = candidate;
      for (const record of candidate.values()) this._clock = Math.max(this._clock, record.clock[this.deviceId] || 0);
      const previous = this._snapshot;
      this._snapshot = nextSnapshot;
      if (!equal(previous, this._snapshot)) this.emit('change', this.snapshot);
      return this.snapshot;
    });
  }

  // GitHub presents concurrent heads before changing the library. The compare
  // happens inside the same queue as autosave, so a choice made against an old
  // diff can never overwrite typing that completed while the dialog was open.
  async mergeResolvedRevisions(incoming, { expectedHeadIds, resolutions = [] } = {}) {
    const captured = incoming.map(record => clone(validateRevision(record)));
    if (!Array.isArray(expectedHeadIds) || expectedHeadIds.some(id => typeof id !== 'string' || !HASH.test(id))) throw new TypeError('As revisões esperadas são obrigatórias.');
    const expected = [...expectedHeadIds].sort();
    const choices = new Map();
    for (const resolution of resolutions) {
      assertJSON(resolution);
      if (!plain(resolution) || !KINDS.has(resolution.kind) || typeof resolution.key !== 'string' || !['local', 'remote', 'both', 'merged'].includes(resolution.choice)) throw new TypeError('Resolução de conflito inválida.');
      const key = entityKey(resolution.kind, resolution.key);
      if (choices.has(key)) throw new TypeError('Resolução de conflito duplicada.');
      choices.set(key, clone(resolution));
    }
    return this._enqueue(async () => {
      await this.init();
      const localHeads = headsOf(this._records);
      const actual = [...localHeads.values()].flat().map(record => record.id).sort();
      if (!equal(actual, expected)) {
        const error = new Error('As notas mudaram enquanto o conflito estava aberto. Revise a comparação atualizada.');
        error.code = 'GITHUB_CONFLICT_STALE'; throw error;
      }
      const remoteHeads = headsOf(new Map(captured.map(record => [record.id, record])));
      const candidate = new Map(this._records);
      for (const record of captured) candidate.set(record.id, record);
      let clockValue = this._clock;
      // Restoring an older portable backup can receive revisions authored by
      // this same device. Future autosaves must advance past every such clock,
      // even when the pull has no concurrent heads requiring a successor.
      for (const record of candidate.values()) clockValue = Math.max(clockValue, record.clock[this.deviceId] || 0);
      for (const [key, heads] of headsOf(candidate)) {
        if (heads.length < 2) continue;
        const local = winnerOf(localHeads.get(key) || []), remote = winnerOf(remoteHeads.get(key) || []);
        const same = heads.every(head => head.deleted === heads[0].deleted && equal(head.value, heads[0].value));
        const choice = choices.get(key) || (same ? { choice: 'local' } : null);
        if (!choice) { const error = new Error('Há conflitos que ainda precisam ser resolvidos.'); error.code = 'GITHUB_CONFLICT_UNRESOLVED'; throw error; }
        const selected = choice.choice === 'remote' ? remote : local || remote;
        if (!selected) throw new Error('A versão escolhida não está disponível.');
        const clock = {};
        for (const head of heads) for (const [device, count] of Object.entries(head.clock)) clock[device] = Math.max(clock[device] || 0, count);
        clockValue = Math.max(clockValue, clock[this.deviceId] || 0) + 1;
        clock[this.deviceId] = clockValue;
        const fields = { schema: FORMAT, kind: selected.kind, key: selected.key, device: this.deviceId, clock, deleted: selected.deleted, createdAt: new Date().toISOString() };
        if (choice.choice === 'merged') { fields.deleted = false; fields.value = choice.value; }
        else if (!selected.deleted) fields.value = selected.value;
        const successor = validateRevision(revision(fields));
        candidate.set(successor.id, successor);
        if (choice.choice === 'both') {
          if (selected.kind !== 'note') throw new TypeError('Manter ambas está disponível para notas.');
          if (remote && !remote.deleted && (selected.deleted || !equal(selected.value.data, remote.value.data))) {
            const data = clone(remote.value.data);
            data.id = String(data.id) + '--github-' + remote.id.slice(0, 20);
            data.title = (data.title || 'Sem título') + ' (cópia do GitHub)';
            const duplicate = revision({ schema: FORMAT, kind: 'note', key: idKey(data.id), device: this.deviceId,
              clock: { [this.deviceId]: ++clockValue }, deleted: false, value: { data, order: remote.value.order + 0.0001 }, createdAt: fields.createdAt });
            validateRevision(duplicate); candidate.set(duplicate.id, duplicate);
          }
        }
      }
      const nextSnapshot = validateSnapshot(project(candidate));
      if (candidate.size === this._records.size) return this.snapshot;
      await this._persist(candidate);
      this._records = candidate; this._clock = clockValue;
      const previous = this._snapshot; this._snapshot = nextSnapshot;
      if (!equal(previous, nextSnapshot)) this.emit('change', this.snapshot);
      return this.snapshot;
    });
  }

  exportHeadIds() {
    if (!this._ready) throw new Error('Inicialize o armazenamento antes de exportar.');
    return [...headsOf(this._records).values()].flat().map(record => record.id).sort();
  }

  async close() {
    if (this._initializing) await this._initializing;
    await this._queue;
  }
}

module.exports = { WorkspaceStore, validateRevision, validateSnapshot, atomicWrite, readJSON };
