'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WorkspaceStore, validateSnapshot, validateRevision } = require('../desktop/storage.cjs');

const attachment = () => ({ hash: 'a'.repeat(64), name: 'arquivo.pdf', mime: 'application/pdf', size: 123, relativePath: 'Anexos/arquivo.pdf' });
// Produce correctly checksummed but structurally invalid external revisions.
// These exercise the schema boundary rather than only checksum rejection.
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const signed = record => {
  const { id, ...fields } = record;
  return { ...fields, id: crypto.createHash('sha256').update(canonical(fields)).digest('hex') };
};

function seed() {
  return {
    groups: [{ id: 'g1', name: 'Pessoal', color: '#ffbb00', sessions: [{ id: 's1', name: 'Ideias' }] }],
    notes: [{ id: 'n1', s: 's1', title: 'Primeira', body: '# Olá\nTexto original', t: 'Agora' }],
    openBy: { s1: ['n1'] }, focusBy: { s1: 'n1' }, session: 's1', view: 'session', tag: null,
    expanded: { g1: true }, layout: 'split', sidebar: true, theme: 'dark', accent: 'Azul', motion: true, blur: 22,
    futurePreference: { nested: [1, 'preservar'] }
  };
}

async function fixture(t, deviceId = 'pc-a', options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-store-'));
  const store = new WorkspaceStore({ dataDir: dir, seed: seed(), deviceId, ...options });
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await store.init();
  return { store, dir };
}

test('persists the exact reference shape and extra JSON fields across restart', async t => {
  const { store, dir } = await fixture(t);
  assert.deepEqual(store.snapshot, seed());
  const snapshot = store.snapshot;
  snapshot.notes[0].body = 'Alterado antes de salvar\n😀';
  snapshot.groups[0].sessions[0].name = 'Renomeada';
  snapshot.groups[0].extra = { custom: true };
  snapshot.theme = 'light';
  snapshot.futurePreference.nested.push('novo');
  const saved = await store.save(snapshot);
  assert.deepEqual(saved, snapshot);
  saved.notes[0].body = 'mutação fora do armazenamento';
  assert.equal(store.snapshot.notes[0].body, snapshot.notes[0].body);
  const reopened = new WorkspaceStore({ dataDir: dir, seed: { groups: [], notes: [] } });
  await reopened.init();
  assert.equal(reopened.deviceId, 'pc-a');
  assert.deepEqual(reopened.snapshot, snapshot);
  await reopened.close();
});

test('captures saves immediately, serializes keystrokes, emits only durable snapshots', async t => {
  const { store, dir } = await fixture(t);
  const base = store.snapshot;
  const changes = [];
  store.on('change', snapshot => changes.push(snapshot.notes[0].body));
  const one = store.snapshot;
  one.notes[0].body = 'A';
  const first = store.save(one, { base });
  one.notes[0].body = 'AB';
  const second = store.save(one, { base });
  one.notes[0].body = 'Não deve entrar na fila';
  await Promise.all([first, second]);
  assert.equal(store.snapshot.notes[0].body, 'AB');
  assert.equal(store.snapshot.notes.length, 1, 'successive saves on the same device are not conflicts');
  assert.deepEqual(changes, ['A', 'AB']);
  const reopened = new WorkspaceStore({ dataDir: dir });
  assert.equal((await reopened.init()).notes[0].body, 'AB');
  const checkpoint = JSON.parse(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'));
  assert.ok(checkpoint.heads.some(record => record.value?.data?.body === 'AB'));
});

test('no-op saves do not create journal revisions or change events', async t => {
  const { store } = await fixture(t);
  let changes = 0;
  store.on('change', () => changes++);
  const count = store.exportRevisions().length;
  await store.save(store.snapshot);
  assert.equal(store.exportRevisions().length, count);
  assert.equal(changes, 0);
});

test('an old autosave cannot tombstone notes or preferences received from another PC', async t => {
  const { store } = await fixture(t);
  const { store: remote } = await fixture(t, 'pc-b');
  const base = store.snapshot;
  const remoteState = remote.snapshot;
  remoteState.notes.push({ id: 'n2', s: 's1', title: 'Remota', body: 'Nota criada no PC B', t: 'Agora' });
  remoteState.theme = 'light';
  remoteState.accent = 'Verde';
  await remote.save(remoteState);
  await store.mergeRevisions(remote.exportRevisions());
  const editing = structuredClone(base);
  editing.notes[0].body = 'Digitação ainda não confirmada no PC A';
  const merged = await store.save(editing, { base });
  assert.equal(merged.notes.length, 2);
  assert.equal(merged.notes.find(note => note.id === 'n2').body, 'Nota criada no PC B');
  assert.equal(merged.theme, 'light');
  assert.equal(merged.accent, 'Verde');
});

test('text received while typing against an old base remains a visible recovery copy', async t => {
  const { store } = await fixture(t);
  const { store: remote } = await fixture(t, 'pc-b');
  const base = store.snapshot;
  const remoteState = remote.snapshot;
  remoteState.notes[0].body = 'Trabalho remoto que chegou durante a digitação';
  await remote.save(remoteState);
  await store.mergeRevisions(remote.exportRevisions());
  const editing = structuredClone(base);
  editing.notes[0].body = 'Trabalho local digitado';
  await store.save(editing, { base });
  assert.equal(store.snapshot.notes.find(note => note.id === 'n1').body, 'Trabalho local digitado');
  const copy = store.snapshot.notes.find(note => note._notesConflict);
  assert.equal(copy.body, remoteState.notes[0].body);
  assert.equal(copy.s, 's1');
  assert.equal(copy._notesConflict.noteId, 'n1');
});

test('concurrent note edits converge deterministically and preserve both texts', async t => {
  const { store: a } = await fixture(t, 'pc-a');
  const { store: b } = await fixture(t, 'pc-b');
  const sa = a.snapshot, sb = b.snapshot;
  sa.notes[0].body = 'Texto independente A';
  sb.notes[0].body = 'Texto independente B';
  await a.save(sa);
  await b.save(sb);
  const ar = a.exportRevisions(), br = b.exportRevisions();
  await Promise.all([a.mergeRevisions(br), b.mergeRevisions(ar)]);
  await a.mergeRevisions(b.exportRevisions());
  await b.mergeRevisions(a.exportRevisions());
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.deepEqual(new Set(a.snapshot.notes.map(note => note.body)), new Set(['Texto independente A', 'Texto independente B']));
  const ids = a.snapshot.notes.map(note => note.id);
  await a.mergeRevisions(br);
  assert.deepEqual(a.snapshot.notes.map(note => note.id), ids, 'reimport keeps IDs stable and does not duplicate conflicts');
  const copy = a.snapshot.notes.find(note => note._notesConflict);
  const withoutCopy = a.snapshot;
  withoutCopy.notes = withoutCopy.notes.filter(note => note.id !== copy.id);
  await a.save(withoutCopy);
  await a.mergeRevisions(br);
  assert.ok(!a.snapshot.notes.some(note => note.id === copy.id), 'deleting a conflict copy is durable');
});

test('delete/edit conflicts retain edited work and stale imports never resurrect tombstones', async t => {
  const { store: a, dir } = await fixture(t, 'pc-a');
  const { store: b } = await fixture(t, 'pc-b');
  const original = a.exportRevisions();
  const deleted = a.snapshot;
  deleted.notes = [];
  await a.save(deleted);
  const edited = b.snapshot;
  edited.notes[0].body = 'Edição feita offline enquanto a outra máquina excluiu';
  await b.save(edited);
  await a.mergeRevisions(b.exportRevisions());
  await b.mergeRevisions(a.exportRevisions());
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.ok(!a.snapshot.notes.some(note => note.id === 'n1'));
  assert.equal(a.snapshot.notes.length, 1);
  assert.equal(a.snapshot.notes[0].body, edited.notes[0].body);
  const reopened = new WorkspaceStore({ dataDir: dir });
  await reopened.init();
  await reopened.mergeRevisions(original);
  assert.ok(!reopened.snapshot.notes.some(note => note.id === 'n1'));
  assert.equal(reopened.snapshot.notes.length, 1);
});

test('merges group/session changes and individual preferences independently', async t => {
  const { store: a } = await fixture(t, 'pc-a');
  const { store: b } = await fixture(t, 'pc-b');
  const sa = a.snapshot, sb = b.snapshot;
  sa.groups[0].name = 'Grupo renomeado';
  sa.sidebar = false;
  delete sa.futurePreference;
  sb.groups[0].sessions[0].name = 'Sessão renomeada';
  sb.accent = 'Rosa';
  sb.blur = 12;
  await a.save(sa);
  await b.save(sb);
  await a.mergeRevisions(b.exportRevisions());
  await b.mergeRevisions(a.exportRevisions());
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.equal(a.snapshot.groups[0].name, 'Grupo renomeado');
  assert.equal(a.snapshot.groups[0].sessions[0].name, 'Sessão renomeada');
  assert.equal(a.snapshot.sidebar, false);
  assert.equal(a.snapshot.accent, 'Rosa');
  assert.equal(a.snapshot.blur, 12);
  assert.ok(!Object.hasOwn(a.snapshot, 'futurePreference'));
});

test('orphaned notes stay accessible when their session is deleted concurrently', async t => {
  const { store: a } = await fixture(t, 'pc-a');
  const { store: b } = await fixture(t, 'pc-b');
  const sa = a.snapshot;
  sa.groups = [];
  sa.notes = [];
  await a.save(sa);
  const sb = b.snapshot;
  sb.notes.push({ id: 'offline-note', s: 's1', title: 'Offline', body: 'Preservar mesmo sem grupo', t: 'Agora' });
  await b.save(sb);
  await a.mergeRevisions(b.exportRevisions());
  const snapshot = a.snapshot;
  assert.equal(snapshot.notes[0].id, 'offline-note');
  assert.ok(snapshot.groups.some(group => group.sessions.some(session => session.id === 's1')));
});

test('corrupt checkpoint recovers the newest keystrokes from the journal and preserves corruption evidence', async t => {
  const { store, dir } = await fixture(t);
  for (const body of ['um', 'dois', 'último texto completo']) {
    const state = store.snapshot;
    state.notes[0].body = body;
    await store.save(state);
  }
  await fs.writeFile(path.join(dir, 'workspace.json'), '{ invalid checkpoint');
  const reopened = new WorkspaceStore({ dataDir: dir, seed: seed() });
  const state = await reopened.init();
  assert.equal(state.notes[0].body, 'último texto completo');
  assert.ok(reopened.recovery);
  assert.ok(reopened.recovery.preserved.length);
  assert.equal(await fs.readFile(reopened.recovery.preserved[0], 'utf8'), '{ invalid checkpoint');
  assert.ok(await fs.stat(path.join(dir, 'workspace.json.bak3')));
});

test('checkpoint heads restore a corrupt journal file without dropping the note', async t => {
  const { store, dir } = await fixture(t);
  const state = store.snapshot;
  state.notes[0].body = 'O checkpoint tem a segunda cópia';
  await store.save(state);
  const record = store.exportRevisions().find(record => record.value?.data?.body === state.notes[0].body);
  const file = path.join(dir, 'revisions', record.id + '.json');
  await fs.writeFile(file, 'broken record');
  const reopened = new WorkspaceStore({ dataDir: dir });
  assert.equal((await reopened.init()).notes[0].body, state.notes[0].body);
  assert.ok(reopened.recovery);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).id, record.id);
});

test('unrecoverable storage throws rather than silently replacing notes with seed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'workspace.json');
  await fs.writeFile(file, '{ irrecuperável');
  const store = new WorkspaceStore({ dataDir: dir, seed: seed() });
  await assert.rejects(store.init(), { code: 'NOTES_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(file, 'utf8'), '{ irrecuperável');
});

test('invalid snapshots and tampered sync revisions are rejected without changing the workspace', async t => {
  const { store } = await fixture(t);
  const original = store.snapshot;
  const invalid = store.snapshot;
  invalid.notes.push({ ...invalid.notes[0] });
  await assert.rejects(store.save(invalid), /duplicado/);
  const record = store.exportRevisions().find(record => record.kind === 'note');
  record.value.data.body = 'conteúdo com checksum adulterado';
  await assert.rejects(store.mergeRevisions([record]), /Checksum/);
  assert.deepEqual(store.snapshot, original);
});

test('a copied portable data directory gets a new device identity in another environment', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-clone-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstDir = path.join(directory, 'original'), copiedDir = path.join(directory, 'copy');
  const first = new WorkspaceStore({ dataDir: firstDir, seed: seed(), machineFingerprint: 'computer-a' });
  await first.init();
  const prepared = first.snapshot;
  prepared.notes[0].body = 'Estado comum no portable original';
  await first.save(prepared);
  await fs.cp(firstDir, copiedDir, { recursive: true });
  const copied = new WorkspaceStore({ dataDir: copiedDir, seed: seed(), machineFingerprint: 'computer-b' });
  await copied.init();
  assert.notEqual(copied.deviceId, first.deviceId);
  assert.equal(copied.identityChanged, true);
  assert.deepEqual(copied.snapshot, first.snapshot);
  const restarted = new WorkspaceStore({ dataDir: copiedDir, machineFingerprint: 'computer-b' });
  await restarted.init();
  assert.equal(restarted.deviceId, copied.deviceId);
  assert.equal(restarted.identityChanged, false);
  const one = first.snapshot, two = copied.snapshot;
  one.notes[0].body = 'Edição A após copiar';
  two.notes[0].body = 'Edição B após copiar';
  await first.save(one);
  await copied.save(two);
  // B has another edit to prove differing counters cannot hide the A branch.
  const secondEdit = copied.snapshot;
  secondEdit.notes[0].body += ' e continuar escrevendo';
  await copied.save(secondEdit);
  await first.mergeRevisions(copied.exportRevisions());
  await copied.mergeRevisions(first.exportRevisions());
  assert.deepEqual(first.snapshot, copied.snapshot);
  assert.deepEqual(new Set(first.snapshot.notes.map(note => note.body)), new Set([one.notes[0].body, secondEdit.notes[0].body]));
  const metadata = await fs.readFile(path.join(copiedDir, 'device.json'), 'utf8');
  assert.ok(!metadata.includes('computer-b'), 'only the fingerprint hash is persisted');
});

test('checkpoint reads use the larger checkpoint limit and every accepted save remains readable', async t => {
  const limits = { revisionBytes: 2048, checkpointBytes: 64 * 1024 };
  const { store, dir } = await fixture(t, 'pc-a', { limits });
  const state = store.snapshot;
  for (let index = 0; index < 12; index++) state.notes.push({ id: 'many-' + index, s: 's1', title: 'Nota ' + index, body: 'x'.repeat(700), t: 'Agora' });
  await store.save(state);
  assert.ok((await fs.stat(path.join(dir, 'workspace.json'))).size > limits.revisionBytes);
  for (const file of await fs.readdir(path.join(dir, 'revisions'))) assert.ok((await fs.stat(path.join(dir, 'revisions', file))).size <= limits.revisionBytes);
  const restarted = new WorkspaceStore({ dataDir: dir, limits });
  assert.deepEqual(await restarted.init(), state);
  assert.equal(restarted.recovery, null);
});

test('oversized checkpoint rejects the whole save before any journal or backup write', async t => {
  const limits = { revisionBytes: 2048, checkpointBytes: 16 * 1024 };
  const { store, dir } = await fixture(t, 'pc-a', { limits });
  const original = store.snapshot;
  const before = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
  const journal = await fs.readdir(path.join(dir, 'revisions'));
  const state = store.snapshot;
  for (let index = 0; index < 30; index++) state.notes.push({ id: 'rejected-' + index, s: 's1', title: 'Não importar parcialmente', body: 'y'.repeat(700), t: 'Agora' });
  await assert.rejects(store.save(state), { code: 'NOTES_SIZE_LIMIT', kind: 'checkpoint', maxBytes: limits.checkpointBytes });
  assert.deepEqual(store.snapshot, original);
  assert.deepEqual(await fs.readdir(path.join(dir, 'revisions')), journal);
  assert.equal(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), before);
  assert.ok(!(await fs.readdir(dir)).some(file => /\.bak|\.tmp$/.test(file)), 'preflight failure must not modify backups or leave temporary files');
  const restarted = new WorkspaceStore({ dataDir: dir, limits });
  assert.deepEqual(await restarted.init(), original, 'rejected notes must not be replayed from a partial journal');
  const accepted = store.snapshot;
  accepted.notes[0].body = 'Edição menor continua funcionando depois da rejeição';
  await store.save(accepted);
  const reopened = new WorkspaceStore({ dataDir: dir, limits });
  assert.equal((await reopened.init()).notes[0].body, accepted.notes[0].body);
});

test('a single oversized UTF-8 revision is rejected before earlier valid candidate records are journaled', async t => {
  const limits = { revisionBytes: 2048, checkpointBytes: 64 * 1024 };
  const { store, dir } = await fixture(t, 'pc-a', { limits });
  const original = store.snapshot;
  const journal = await fs.readdir(path.join(dir, 'revisions'));
  const checkpoint = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
  const state = store.snapshot;
  state.notes.push({ id: 'would-be-partial', s: 's1', title: 'Nota pequena', body: 'Não pode vazar de um save rejeitado', t: 'Agora' });
  state.notes.push({ id: 'too-large', s: 's1', title: 'UTF-8', body: '📝'.repeat(600), t: 'Agora' });
  await assert.rejects(store.save(state), { code: 'NOTES_SIZE_LIMIT', kind: 'revision', maxBytes: limits.revisionBytes });
  assert.deepEqual(store.snapshot, original);
  assert.deepEqual(await fs.readdir(path.join(dir, 'revisions')), journal);
  assert.equal(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), checkpoint);
  const restarted = new WorkspaceStore({ dataDir: dir, limits });
  assert.deepEqual(await restarted.init(), original);
});

test('an oversized remote merge cannot leave partially imported revisions for the next startup', async t => {
  const limits = { revisionBytes: 2048, checkpointBytes: 16 * 1024 };
  const { store, dir } = await fixture(t, 'pc-a', { limits });
  const { store: remote } = await fixture(t, 'pc-b');
  const original = store.snapshot;
  const journal = await fs.readdir(path.join(dir, 'revisions'));
  const remoteState = remote.snapshot;
  for (let index = 0; index < 30; index++) remoteState.notes.push({ id: 'remote-' + index, s: 's1', title: 'Remota', body: 'z'.repeat(700), t: 'Agora' });
  await remote.save(remoteState);
  await assert.rejects(store.mergeRevisions(remote.exportRevisions()), { code: 'NOTES_SIZE_LIMIT', kind: 'checkpoint' });
  assert.deepEqual(store.snapshot, original);
  assert.deepEqual(await fs.readdir(path.join(dir, 'revisions')), journal);
  const restarted = new WorkspaceStore({ dataDir: dir, limits });
  assert.deepEqual(await restarted.init(), original);
});

test('an oversized initial seed leaves no committed identity or journal and can be retried safely', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-initial-limit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const limits = { revisionBytes: 2048, checkpointBytes: 64 * 1024 };
  const tooLarge = seed();
  tooLarge.notes[0].body = 't'.repeat(4096);
  const store = new WorkspaceStore({ dataDir: directory, seed: tooLarge, limits });
  await assert.rejects(store.init(), { code: 'NOTES_SIZE_LIMIT', kind: 'revision' });
  assert.deepEqual(await fs.readdir(path.join(directory, 'revisions')), []);
  assert.deepEqual(await fs.readdir(directory), ['revisions']);
  const retried = new WorkspaceStore({ dataDir: directory, seed: seed(), limits });
  assert.deepEqual(await retried.init(), seed());
});

test('valid attachments, tags and unknown JSON metadata survive save, merge and restart unchanged', async t => {
  const { store, dir } = await fixture(t);
  const { store: remote } = await fixture(t, 'pc-b');
  const state = store.snapshot;
  state.notes[0].attachments = [attachment()];
  state.notes[0].tags = ['pesquisa', 'ação', ''];
  state.notes[0].custom = { nullable: null, arrays: [true, 2, 'texto'] };
  state.groups[0].custom = { nested: ['preservar'] };
  state.groups[0].sessions[0].custom = ['também'];
  state.unknownPreference = { futureShape: ['continua', { supported: true }] };
  state.focusBy.s1 = null;
  state.theme = null;
  assert.deepEqual(validateSnapshot(state), state);
  await store.save(state);
  for (const record of store.exportRevisions()) assert.doesNotThrow(() => validateRevision(record));
  await remote.mergeRevisions(store.exportRevisions());
  assert.deepEqual(remote.snapshot, state);
  const restarted = new WorkspaceStore({ dataDir: dir });
  assert.deepEqual(await restarted.init(), state);
  assert.equal(restarted.recovery, null);
});

test('invalid UI fields, descriptor lists and tags fail before any save writes', async t => {
  const { store, dir } = await fixture(t);
  const original = store.snapshot;
  const before = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
  const journal = await fs.readdir(path.join(dir, 'revisions'));
  const cases = [
    state => { state.notes[0].attachments = 'broken'; },
    state => { state.notes[0].attachments = null; },
    state => { state.notes[0].attachments = [null]; },
    state => { state.notes[0].attachments = [{ ...attachment(), hash: 'g'.repeat(64) }]; },
    state => { state.notes[0].attachments = [{ ...attachment(), name: 42 }]; },
    state => { state.notes[0].attachments = [{ ...attachment(), mime: {} }]; },
    state => { state.notes[0].attachments = [{ ...attachment(), relativePath: [] }]; },
    state => { state.notes[0].attachments = [{ ...attachment(), size: -1 }]; },
    state => { state.notes[0].attachments = [{ ...attachment(), size: 1.5 }]; },
    state => { state.notes[0].attachments = [{ hash: 'a'.repeat(64) }]; },
    state => { state.notes[0].tags = 'broken'; },
    state => { state.notes[0].tags = ['valid', 2]; },
    state => { state.notes[0].tags = new Array(1); },
    state => { state.notes[0].s = {}; },
    state => { state.notes[0].t = {}; },
    state => { state.notes[0].deletedAt = 4; },
    state => { state.groups[0].name = {}; },
    state => { delete state.groups[0].name; },
    state => { state.groups[0].sessions[0].name = []; },
    state => { delete state.groups[0].sessions[0].name; },
    state => { state.groups[0].color = {}; },
    state => { state.openBy = []; },
    state => { state.openBy.s1 = 'broken'; },
    state => { state.openBy.s1 = [{}]; },
    state => { state.focusBy.s1 = []; },
    state => { state.expanded.g1 = 'yes'; },
    state => { state.layout = 'invalid'; },
    state => { state.sidebar = 1; },
    state => { state.theme = 'invalid'; },
    state => { state.accent = {}; },
    state => { state.motion = 'yes'; },
    state => { state.blur = '28'; },
    state => { state.blur = -1; },
    state => { state.session = {}; },
    state => { state.view = []; },
    state => { state.tag = {}; }
  ];
  for (const [index, mutate] of cases.entries()) {
    const state = store.snapshot;
    mutate(state);
    assert.throws(() => validateSnapshot(state), TypeError, 'schema case ' + index);
    await assert.rejects(store.save(state), TypeError, 'save case ' + index);
  }
  assert.deepEqual(store.snapshot, original);
  assert.deepEqual(await fs.readdir(path.join(dir, 'revisions')), journal);
  assert.equal(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), before);
  const restarted = new WorkspaceStore({ dataDir: dir });
  assert.deepEqual(await restarted.init(), original);
});

test('correctly checksummed invalid remote entities and preferences reject the entire merge without partial journal', async t => {
  const { store, dir } = await fixture(t);
  const { store: remote } = await fixture(t, 'pc-b');
  const original = store.snapshot;
  const journal = await fs.readdir(path.join(dir, 'revisions'));
  const checkpoint = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8');
  const validState = remote.snapshot;
  validState.notes[0].body = 'Esta versão válida também não deve ser persistida num lote rejeitado';
  await remote.save(validState);
  const good = remote.exportRevisions().find(record => record.kind === 'note' && record.device === 'pc-b');
  const exported = store.exportRevisions();
  const invalid = [
    ['note', null, record => { record.value.data.attachments = 'broken'; }],
    ['note', null, record => { record.value.data.attachments = [{ ...attachment(), size: -1 }]; }],
    ['note', null, record => { record.value.data.tags = 'broken'; }],
    ['group', null, record => { record.value.data.name = {}; }],
    ['session', null, record => { record.value.data.name = 2; }],
    ['pref', 'openBy', record => { record.value.s1 = 'broken'; }],
    ['pref', 'focusBy', record => { record.value.s1 = []; }],
    ['pref', 'expanded', record => { record.value.g1 = 'yes'; }],
    ['pref', 'layout', record => { record.value = 'invalid'; }],
    ['pref', 'sidebar', record => { record.value = {}; }],
    ['pref', 'theme', record => { record.value = []; }]
  ];
  for (const [kind, key, mutate] of invalid) {
    const record = structuredClone(exported.find(record => record.kind === kind && (key === null || record.key === key)));
    mutate(record);
    const bad = signed(record);
    assert.throws(() => validateRevision(bad), TypeError);
    await assert.rejects(store.mergeRevisions([good, bad]), TypeError);
  }
  assert.deepEqual(store.snapshot, original);
  assert.deepEqual(await fs.readdir(path.join(dir, 'revisions')), journal);
  assert.equal(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'), checkpoint);
  const restarted = new WorkspaceStore({ dataDir: dir });
  assert.deepEqual(await restarted.init(), original);
});

test('a malformed attachment already on disk is preserved for recovery and never reaches the reopened UI snapshot', async t => {
  const { store, dir } = await fixture(t);
  const original = store.snapshot;
  const base = structuredClone(store.exportRevisions().find(record => record.kind === 'note'));
  base.device = 'external';
  base.clock.external = 100;
  base.value.data.attachments = 'broken';
  const bad = signed(base);
  const file = path.join(dir, 'revisions', bad.id + '.json');
  await fs.writeFile(file, JSON.stringify(bad));
  const restarted = new WorkspaceStore({ dataDir: dir });
  assert.deepEqual(await restarted.init(), original);
  assert.ok(restarted.recovery);
  const preserved = restarted.recovery.preserved.find(file => path.basename(file).startsWith(bad.id));
  assert.ok(preserved);
  assert.equal(JSON.parse(await fs.readFile(preserved, 'utf8')).value.data.attachments, 'broken');
  assert.ok(!restarted.exportRevisions().some(record => record.id === bad.id));
});
