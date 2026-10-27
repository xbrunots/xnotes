'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const { SyncEngine } = require('../desktop/sync.cjs');

function seed() {
  return {
    groups: [{ id: 'g1', name: 'Pessoal', color: '#ffd36e', sessions: [{ id: 's1', name: 'Notas' }] }],
    notes: [{ id: 'n1', s: 's1', title: 'Original', body: 'Texto inicial', t: 'Agora' }],
    openBy: { s1: ['n1'] }, focusBy: { s1: 'n1' }, session: 's1', view: 'session', tag: null,
    expanded: { g1: true }, layout: 'split', sidebar: true, theme: 'dark', accent: 'Azul', motion: true, blur: 22
  };
}

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-sync-'));
  const drive = path.join(dir, 'fake-google-drive');
  await fs.mkdir(drive);
  const stores = [], engines = [];
  const create = async id => {
    const store = new WorkspaceStore({ dataDir: path.join(dir, id), seed: seed(), deviceId: id });
    await store.init();
    const engine = new SyncEngine({ store, pollIntervalMs: 60_000, debounceMs: 60_000, ...options });
    stores.push(store);
    engines.push(engine);
    return { store, engine };
  };
  t.after(async () => {
    await Promise.all(engines.map(engine => engine.close()));
    await Promise.all(stores.map(store => store.close()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, drive, create };
}

async function converge(...engines) {
  for (let i = 0; i < 3; i++) for (const engine of engines) await engine.sync();
}

async function eventually(predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'automatic synchronization did not complete before timeout');
}

test('two PCs exchange every note, group, session and preference through only the selected managed folder', async t => {
  const { drive, create } = await setup(t);
  await fs.writeFile(path.join(drive, 'unrelated.txt'), 'não modificar');
  const a = await create('pc-a'), b = await create('pc-b');
  const statuses = await Promise.all([a.engine.connect(drive), b.engine.connect(drive)]);
  assert.ok(statuses.every(status => status.state === 'ready'), JSON.stringify(statuses));
  const sa = a.store.snapshot;
  sa.notes.push({ id: 'a-note', s: 's1', title: 'A', body: 'Conteúdo A', t: 'Agora' });
  sa.theme = 'light';
  sa.openBy.s1.push('a-note');
  const sb = b.store.snapshot;
  sb.groups[0].sessions.push({ id: 's2', name: 'Outra sessão' });
  sb.notes.push({ id: 'b-note', s: 's2', title: 'B', body: 'Conteúdo B', t: 'Agora' });
  sb.accent = 'Verde';
  sb.blur = 17;
  await Promise.all([a.store.save(sa), b.store.save(sb)]);
  await converge(a.engine, b.engine);
  assert.deepEqual(a.store.snapshot, b.store.snapshot);
  assert.equal(a.store.snapshot.notes.length, 3);
  assert.equal(a.store.snapshot.groups[0].sessions.length, 2);
  assert.equal(a.store.snapshot.theme, 'light');
  assert.equal(a.store.snapshot.accent, 'Verde');
  assert.equal(a.store.snapshot.blur, 17);
  assert.deepEqual(a.store.snapshot.openBy.s1, ['n1', 'a-note']);
  assert.equal(await fs.readFile(path.join(drive, 'unrelated.txt'), 'utf8'), 'não modificar');
  assert.equal(a.engine.status.folder, path.join(drive, 'notes'));
  assert.equal(a.engine.status.state, 'ready');
  assert.ok(a.engine.status.lastSync);
  assert.equal(a.engine.status.pending, 0);
});

test('concurrent offline edits converge without overwriting either PC text and create stable conflict IDs', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'), b = await create('pc-b');
  await a.engine.connect(drive);
  await b.engine.connect(drive);
  const sa = a.store.snapshot, sb = b.store.snapshot;
  sa.notes[0].body = 'Texto offline digitado no computador A';
  sb.notes[0].body = 'Texto offline digitado no computador B';
  await Promise.all([a.store.save(sa), b.store.save(sb)]);
  await Promise.all([a.engine.sync(), b.engine.sync()]);
  await converge(a.engine, b.engine);
  assert.deepEqual(a.store.snapshot, b.store.snapshot);
  assert.deepEqual(new Set(a.store.snapshot.notes.map(note => note.body)), new Set([sa.notes[0].body, sb.notes[0].body]));
  const ids = a.store.snapshot.notes.map(note => note.id);
  const journalCount = (await fs.readdir(path.join(drive, 'notes', 'revisions'))).length;
  await converge(a.engine, b.engine);
  assert.deepEqual(a.store.snapshot.notes.map(note => note.id), ids);
  assert.equal((await fs.readdir(path.join(drive, 'notes', 'revisions'))).length, journalCount, 'sync loops must not create new revisions');
});

test('deletions are synchronized and stay deleted when a third PC brings an older seed', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'), b = await create('pc-b');
  await a.engine.connect(drive);
  await b.engine.connect(drive);
  const state = a.store.snapshot;
  state.notes = [];
  await a.store.save(state);
  await converge(a.engine, b.engine);
  assert.equal(b.store.snapshot.notes.length, 0);
  const c = await create('pc-c');
  assert.equal(c.store.snapshot.notes.length, 1);
  await c.engine.connect(drive);
  await converge(a.engine, b.engine, c.engine);
  assert.equal(c.store.snapshot.notes.length, 0);
  assert.equal(a.store.snapshot.notes.length, 0);
});

test('drive disconnection leaves local saves available and reconnect resumes automatically', async t => {
  const { dir, drive, create } = await setup(t, { watch: false });
  const a = await create('pc-a'), b = await create('pc-b');
  await a.engine.connect(drive);
  await b.engine.connect(drive);
  const detached = path.join(dir, 'drive-detached');
  await fs.rename(drive, detached);
  assert.equal((await a.engine.sync()).state, 'offline');
  assert.equal(await fs.stat(drive).then(() => true, () => false), false, 'do not recreate a disconnected root');
  const state = a.store.snapshot;
  state.notes[0].body = 'Trabalho salvo localmente durante indisponibilidade';
  state.layout = 'focus';
  await a.store.save(state);
  assert.equal(a.store.snapshot.notes[0].body, state.notes[0].body);
  await fs.rename(detached, drive);
  await converge(a.engine, b.engine);
  assert.equal(b.store.snapshot.notes[0].body, state.notes[0].body);
  assert.equal(b.store.snapshot.layout, 'focus');
  assert.equal(a.engine.status.state, 'ready');
});

test('restart reuses immutable revisions and preserves IDs, tombstones and preferences', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a');
  await a.engine.connect(drive);
  const state = a.store.snapshot;
  state.notes.push({ id: 'keep-id', s: 's1', title: 'Persistente', body: 'Não mudar identidade', t: 'Agora' });
  state.notes = state.notes.filter(note => note.id !== 'n1');
  state.motion = false;
  await a.store.save(state);
  await a.engine.sync();
  const oldCount = (await fs.readdir(path.join(drive, 'notes', 'revisions'))).length;
  await a.engine.close();
  const reopened = new WorkspaceStore({ dataDir: a.store.dataDir, seed: seed() });
  await reopened.init();
  const engine = new SyncEngine({ store: reopened });
  t.after(() => engine.close());
  await engine.connect(path.join(drive, 'notes'));
  assert.deepEqual(reopened.snapshot, a.store.snapshot);
  assert.equal(reopened.snapshot.notes[0].id, 'keep-id');
  assert.equal(reopened.snapshot.motion, false);
  assert.equal((await fs.readdir(path.join(drive, 'notes', 'revisions'))).length, oldCount);
});

test('polling imports changes without user interaction and disconnect stops synchronization', async t => {
  const { drive, create } = await setup(t, { pollIntervalMs: 60, debounceMs: 20 });
  const a = await create('pc-a'), b = await create('pc-b');
  await a.engine.connect(drive);
  await b.engine.connect(drive);
  const state = a.store.snapshot;
  state.notes[0].body = 'Alteração automática';
  await a.store.save(state);
  await eventually(() => b.store.snapshot.notes[0].body === 'Alteração automática');
  await b.engine.disconnect();
  const second = a.store.snapshot;
  second.notes[0].body = 'Após desconectar B';
  await a.store.save(second);
  await a.engine.sync();
  assert.equal((await b.engine.sync()).state, 'disconnected');
  assert.equal(b.store.snapshot.notes[0].body, 'Alteração automática');
});

test('invalid remote revision is reported and preserved without replacing good local data', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a');
  await a.engine.connect(drive);
  const revision = a.store.exportRevisions().find(record => record.kind === 'note');
  const file = path.join(drive, 'notes', 'revisions', revision.id + '.json');
  await fs.writeFile(file, 'corrupt shared revision');
  const result = await a.engine.sync();
  assert.equal(result.state, 'error');
  assert.match(result.error, /JSON|revis|Unexpected/i);
  assert.equal(a.store.snapshot.notes[0].body, 'Texto inicial');
  assert.equal(await fs.readFile(file, 'utf8'), 'corrupt shared revision');
});

test('selection cannot claim an unrelated existing notes folder', async t => {
  const { drive, create } = await setup(t);
  await fs.mkdir(path.join(drive, 'notes'));
  const existing = path.join(drive, 'notes', 'important.txt');
  await fs.writeFile(existing, 'arquivo do usuário');
  const a = await create('pc-a');
  const status = await a.engine.connect(drive);
  assert.equal(status.state, 'error');
  assert.match(status.error, /sem o marcador/);
  assert.equal(await fs.readFile(existing, 'utf8'), 'arquivo do usuário');
  assert.deepEqual(await fs.readdir(path.join(drive, 'notes')), ['important.txt']);
});

test('close flushes the final local edit even before the scheduled sync debounce', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'), b = await create('pc-b');
  await a.engine.connect(drive);
  await b.engine.connect(drive);
  const state = a.store.snapshot;
  state.notes[0].body = 'Última digitação antes de fechar imediatamente';
  const saving = a.store.save(state);
  await a.engine.close();
  await saving;
  await b.engine.sync();
  assert.equal(b.store.snapshot.notes[0].body, state.notes[0].body);
  assert.equal(a.engine.status.state, 'disconnected');
});

test('close remains bounded if the Drive filesystem stops responding', async t => {
  const { drive, create } = await setup(t, { closeTimeoutMs: 50 });
  const a = await create('pc-a');
  await a.engine.connect(drive);
  // Replace only the filesystem-bound operation, simulating an unresponsive
  // virtual mount without starting network requests or touching a real drive.
  const ensure = a.engine._ensureManaged;
  let release;
  a.engine._ensureManaged = () => new Promise(resolve => { release = () => resolve(path.join(drive, 'notes', 'revisions')); });
  const started = Date.now();
  await a.engine.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(a.engine.status.state, 'disconnected');
  release();
  await a.engine._syncing;
  a.engine._ensureManaged = ensure;
});

test('reopening a directly selected notes folder offline reconnects to that folder without nesting', async t => {
  const { dir, drive, create } = await setup(t, { watch: false });
  const original = await create('pc-a');
  await original.engine.connect(drive);
  await original.engine.close();
  const selected = path.join(drive, 'notes');
  const detached = path.join(dir, 'drive-detached');
  await fs.rename(drive, detached);
  const restarted = await create('pc-b');
  assert.equal((await restarted.engine.connect(selected)).state, 'offline');
  assert.equal(await fs.stat(drive).then(() => true, () => false), false);
  const offlineEdit = restarted.store.snapshot;
  offlineEdit.notes[0].body = 'Texto salvo antes de o Drive retornar';
  await restarted.store.save(offlineEdit);
  await fs.rename(detached, drive);
  const result = await restarted.engine.sync();
  assert.equal(result.state, 'ready');
  assert.equal(result.folder, selected);
  assert.equal(await fs.stat(path.join(selected, 'notes')).then(() => true, () => false), false, 'must not split the journal into notes/notes');
  const third = await create('pc-c');
  await third.engine.connect(drive);
  assert.equal(third.store.snapshot.notes[0].body, offlineEdit.notes[0].body);
});

test('asset hook receives only valid descriptors and pending blobs delay ready until the next sync', async t => {
  const descriptor = { hash: 'a'.repeat(64), name: 'manual.pdf', mime: 'application/pdf', size: 123, relativePath: 'Docs/manual.pdf' };
  const calls = [];
  let pending = 1;
  const assets = { async syncFolder(folder, descriptors) { calls.push({ folder, descriptors }); return { pending, uploaded: 0, downloaded: 0 }; } };
  const { drive, create } = await setup(t, { assets, watch: false });
  const a = await create('pc-a');
  const state = a.store.snapshot;
  state.notes[0].attachments = [descriptor];
  state.notes.push({ id: 'no-list', s: 's1', title: 'Sem lista de anexos', body: '', t: 'Agora' });
  await a.store.save(state);
  const connecting = await a.engine.connect(drive);
  assert.equal(connecting.state, 'syncing');
  assert.equal(connecting.pending, 1);
  assert.equal(connecting.error, null);
  assert.equal(connecting.lastSync, null);
  assert.equal(calls.length, 1, 'pending binaries must not cause a busy retry loop');
  assert.equal(calls[0].folder, path.join(drive, 'notes'));
  assert.deepEqual(calls[0].descriptors, [descriptor]);
  pending = 0;
  const result = await a.engine.sync();
  assert.equal(result.state, 'ready');
  assert.equal(result.pending, 0);
  assert.ok(result.lastSync);
  assert.equal(calls.length, 2);
});

test('asset hook sees attachment metadata imported from the other PC before ready', async t => {
  const descriptor = { hash: 'c'.repeat(64), name: 'foto.png', mime: 'image/png', size: 3, relativePath: 'Assets/foto.png' };
  const calls = [];
  const assets = { async syncFolder(folder, descriptors) { calls.push(descriptors); return { pending: 0, uploaded: 0, downloaded: descriptors.length }; } };
  const { drive, create } = await setup(t, { assets, watch: false });
  const a = await create('pc-a');
  const state = a.store.snapshot;
  state.notes[0].attachments = [descriptor];
  await a.store.save(state);
  await a.engine.connect(drive);
  calls.length = 0;
  const b = await create('pc-b');
  assert.equal((await b.engine.connect(drive)).state, 'ready');
  assert.deepEqual(b.store.snapshot.notes[0].attachments, [descriptor]);
  assert.deepEqual(calls[0], [descriptor]);
});

test('asset corruption reports sync error without replacing local note contents', async t => {
  const assets = { async syncFolder() { throw new Error('Checksum do anexo não corresponde ao hash.'); } };
  const { drive, create } = await setup(t, { assets, watch: false });
  const a = await create('pc-a');
  const original = a.store.snapshot;
  const status = await a.engine.connect(drive);
  assert.equal(status.state, 'error');
  assert.match(status.error, /Checksum do anexo/);
  assert.equal(status.lastSync, null);
  assert.deepEqual(a.store.snapshot, original);
});

test('close flushes the asset hook for the last saved attachment metadata', async t => {
  const descriptor = { hash: 'd'.repeat(64), name: 'arquivo.txt', mime: 'text/plain', size: 9, relativePath: 'arquivo.txt' };
  const calls = [];
  const assets = { async syncFolder(folder, descriptors) { calls.push(descriptors); return { pending: 0, uploaded: descriptors.length, downloaded: 0 }; } };
  const { drive, create } = await setup(t, { assets, watch: false });
  const a = await create('pc-a');
  await a.engine.connect(drive);
  calls.length = 0;
  const state = a.store.snapshot;
  state.notes[0].attachments = [descriptor];
  const saving = a.store.save(state);
  await a.engine.close();
  await saving;
  assert.ok(calls.some(descriptors => descriptors.some(item => item.hash === descriptor.hash)));
  assert.equal(a.engine.status.state, 'disconnected');
});
