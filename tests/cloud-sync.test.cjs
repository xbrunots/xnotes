'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const { AssetStore } = require('../desktop/assets.cjs');
const { DriveApi } = require('../desktop/drive-api.cjs');
const { CloudSync } = require('../desktop/cloud-sync.cjs');
const { fakeDrive, fakeAuth, hash } = require('./helpers/fake-drive.cjs');

const seed = () => ({ groups: [{ id: 'g', name: 'Pessoal', sessions: [{ id: 's', name: 'Notas' }] }], notes: [{ id: 'n', s: 's', title: 'Primeira', body: 'Texto inicial', t: 'Agora' }], theme: 'dark', layout: 'split', openBy: { s: ['n'] }, focusBy: { s: 'n' } });
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-cloud-'));
  const drive = fakeDrive({ pageSize: 3 }), instances = [];
  const create = async (name, options = {}) => {
    const dataDir = path.join(directory, name);
    const store = new WorkspaceStore({ dataDir, seed: seed(), deviceId: name }); await store.init();
    const assets = await new AssetStore({ dataDir }).init();
    const auth = options.auth || fakeAuth();
    const api = new DriveApi({ auth, fetch: drive.fetch, maxAttempts: 1, retryBaseMs: 0 });
    const sync = new CloudSync({ store, assets, auth, api, ...options });
    const instance = { store, assets, auth, api, sync, dataDir }; instances.push(instance); return instance;
  };
  t.after(async () => { for (const instance of instances) await instance.sync.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, drive, create };
}

test('Google API sync exchanges immutable revisions and caches every attachment offline before ready', async t => {
  const { directory, drive, create } = await setup(t);
  const a = await create('pc-a');
  const bytes = Buffer.from([0, 1, 127, 255, 32, 10]), original = path.join(directory, 'asset.bin'); await fs.writeFile(original, bytes);
  const descriptor = await a.assets.addFile(original, { relativePath: 'Anexos/asset.bin' });
  const state = a.store.snapshot; state.notes[0].body = 'Anexo importado'; state.notes[0].attachments = [descriptor]; state.theme = 'light';
  await a.store.save(state);
  assert.equal((await a.sync.init()).state, 'ready');
  assert.equal(a.sync.status.provider, 'google-drive'); assert.equal(a.sync.status.authConfigured, true);
  const files = [...drive.files.values()];
  assert.ok(files[0].name.startsWith('notes-v1-asset-'), 'blob is published before metadata references it');
  const b = await create('pc-b');
  assert.equal((await b.sync.init()).state, 'ready');
  assert.deepEqual(b.store.snapshot, a.store.snapshot);
  assert.deepEqual(await fs.readFile(await b.assets.file(descriptor.hash)), bytes);
  assert.ok(b.sync.status.lastSuccessfulSync); assert.equal(b.sync.status.pending, 0);
});

test('concurrent offline edits converge and preserve both texts through the Drive API', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'), b = await create('pc-b');
  await a.sync.init(); await b.sync.init();
  const one = a.store.snapshot, two = b.store.snapshot;
  one.notes[0].body = 'Trabalho offline A'; two.notes[0].body = 'Trabalho offline B';
  await a.store.save(one); await b.store.save(two);
  await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
  assert.deepEqual(a.store.snapshot, b.store.snapshot);
  assert.deepEqual(new Set(a.store.snapshot.notes.map(note => note.body)), new Set([one.notes[0].body, two.notes[0].body]));
  const count = drive.files.size; await b.sync.sync(); await a.sync.sync(); assert.equal(drive.files.size, count);
});

test('local changes, resume before deadline, restart before deadline and close do not upload immediately', async t => {
  let now = 100000;
  const { drive, create } = await setup(t);
  const a = await create('pc-a', { now: () => now });
  await a.sync.init();
  const previousNext = a.sync.status.nextSync, calls = drive.requests.length;
  const state = a.store.snapshot; state.notes[0].body = 'Aguardar uma hora ou botão manual'; await a.store.save(state);
  assert.ok(a.sync.status.pending > 0); assert.equal(drive.requests.length, calls);
  now += 30 * 60000; await a.sync.syncIfDue(); assert.equal(drive.requests.length, calls);
  await a.sync.close(); assert.equal(drive.requests.length, calls);
  const restarted = await create('pc-a', { now: () => now });
  await restarted.sync.init(); assert.equal(drive.requests.length, calls);
  assert.equal(restarted.sync.status.nextSync, previousNext); assert.ok(restarted.sync.status.pending > 0);
  now = Date.parse(previousNext); await restarted.sync.syncIfDue(); assert.ok(drive.requests.length > calls); assert.equal(restarted.sync.status.pending, 0);
});

test('manual sync works before the hourly deadline and timer schedules the next hour', async t => {
  let now = 100000;
  const { drive, create } = await setup(t);
  const a = await create('pc-a', { now: () => now });
  await a.sync.init(); const first = a.sync.status.lastSuccessfulSync;
  now += 10000;
  const state = a.store.snapshot; state.notes[0].body = 'Sincronização manual'; await a.store.save(state);
  await a.sync.sync();
  assert.notEqual(a.sync.status.lastSuccessfulSync, first);
  assert.equal(Date.parse(a.sync.status.nextSync), now + 3600000);
  assert.equal(a.sync.status.pending, 0);
  assert.ok(drive.files.size > 0);
});

test('offline API failures preserve edits and a later manual sync resumes without a desktop Drive client', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  const state = a.store.snapshot; state.notes[0].body = 'Cache local continua editável'; await a.store.save(state);
  drive.hook = () => { throw new TypeError('simulated offline'); };
  assert.equal((await a.sync.sync()).state, 'offline'); assert.equal(a.store.snapshot.notes[0].body, state.notes[0].body);
  drive.hook = null;
  assert.equal((await a.sync.sync()).state, 'ready');
  const b = await create('pc-b'); await b.sync.init(); assert.equal(b.store.snapshot.notes[0].body, state.notes[0].body);
});

test('every duplicate remote revision is validated before merging any incoming changes or writing cloud files', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  const state = a.store.snapshot; state.notes[0].body = 'Versão remota válida ainda não importada'; await a.store.save(state); await a.sync.sync();
  const original = a.store.exportRevisions().find(record => record.kind === 'note' && record.device === 'seed');
  const bad = structuredClone(original); bad.value.data.body = 'Bad checksum';
  drive.seed('notes-v1-rev-' + original.id + '.json', JSON.stringify(bad));
  const b = await create('pc-b'), before = b.store.snapshot, ids = b.store.exportRevisions().map(record => record.id), count = drive.files.size;
  const result = await b.sync.init();
  assert.equal(result.state, 'error'); assert.match(result.error, /revisão inválida/);
  assert.deepEqual(b.store.snapshot, before); assert.deepEqual(b.store.exportRevisions().map(record => record.id), ids); assert.equal(drive.files.size, count);
});

test('missing remote blob prevents metadata-only success and retries only on the next requested pass', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'), bytes = Buffer.from('Conteúdo do arquivo que ainda vai chegar');
  const descriptor = { hash: hash(bytes), size: bytes.length, name: 'arquivo.txt', mime: 'text/plain', relativePath: 'Anexos/arquivo.txt' };
  const state = a.store.snapshot; state.notes[0].body = 'Metadados com anexo'; state.notes[0].attachments = [descriptor]; await a.store.save(state);
  for (const record of a.store.exportRevisions()) drive.seed('notes-v1-rev-' + record.id + '.json', JSON.stringify(record));
  const b = await create('pc-b'), before = b.store.snapshot;
  const result = await b.sync.init();
  assert.equal(result.state, 'syncing'); assert.ok(result.pending > 0); assert.equal(result.lastSuccessfulSync, null); assert.equal(result.error, null);
  assert.deepEqual(b.store.snapshot, before, 'notes are exposed only once their offline bytes are available');
  const calls = drive.requests.length; await b.sync.syncIfDue(); assert.equal(drive.requests.length, calls);
  drive.seed('notes-v1-asset-' + hash(bytes), bytes);
  assert.equal((await b.sync.sync()).state, 'ready');
  assert.equal(b.store.snapshot.notes[0].body, state.notes[0].body); assert.deepEqual(await fs.readFile(await b.assets.file(descriptor.hash)), bytes);
});

test('explicit disconnect cancels HTTP; revoked authorization requires reconnect', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  drive.hook = request => new Promise((resolve, reject) => request.options.signal.addEventListener('abort', () => reject(request.options.signal.reason), { once: true }));
  const running = a.sync.sync(); await new Promise(resolve => setImmediate(resolve)); await a.sync.disconnect(); await running;
  assert.equal(a.sync.status.state, 'disconnected'); assert.equal(a.auth.status.connected, false);
  drive.hook = null; await a.sync.connect();
  a.auth.getAccessToken = async () => { a.auth.status.connected = false; throw Object.assign(new Error('Conecte novamente.'), { code: 'AUTH_REQUIRED' }); };
  assert.equal((await a.sync.sync()).state, 'auth-required');
});

test('matching duplicate immutable filenames are harmless and never create extra uploads', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  const record = a.store.exportRevisions().find(record => record.kind === 'note');
  drive.seed('notes-v1-rev-' + record.id + '.json', JSON.stringify(record));
  const count = drive.files.size;
  const b = await create('pc-b'); assert.equal((await b.sync.init()).state, 'ready'); assert.equal(drive.files.size, count);
});

test('the periodic timer initiates a pass without a save, focus event or user click', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a', { intervalMs: 100 }); await a.sync.init();
  const first = a.sync.status.lastSync, firstCalls = drive.requests.length;
  const start = Date.now();
  while ((a.sync.status.lastSync === first || drive.requests.length === firstCalls) && Date.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(drive.requests.length > firstCalls);
  assert.notEqual(a.sync.status.lastSync, first);
});

test('configure preserves connection/deadline for the same client and blocks uploads for a changed client until connect', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  const first = a.sync.status, calls = drive.requests.length;
  const state = a.store.snapshot; state.notes[0].body = 'Editar continua disponível'; await a.store.save(state);
  const same = await a.sync.configure({ client_id: 'test-client' });
  assert.equal(same.state, 'ready'); assert.equal(a.auth.status.connected, true);
  assert.equal(same.lastSuccessfulSync, first.lastSuccessfulSync); assert.equal(same.nextSync, first.nextSync); assert.ok(same.pending > 0);
  assert.equal(drive.requests.length, calls);
  const changed = await a.sync.configure({ client_id: 'different-client' });
  assert.equal(changed.state, 'auth-required'); assert.equal(changed.authConfigured, true); assert.equal(changed.nextSync, null); assert.equal(changed.lastSuccessfulSync, null);
  await a.sync.syncIfDue(); await a.sync.sync(); assert.equal(drive.requests.length, calls);
  const edited = a.store.snapshot; edited.notes[0].body += ' mesmo após trocar o cliente'; await a.store.save(edited);
  assert.equal((await a.sync.connect()).state, 'ready'); assert.ok(drive.requests.length > calls);
});

test('configure cancels an in-flight request before replacing credentials and keeps the local store open', async t => {
  const { drive, create } = await setup(t);
  const a = await create('pc-a'); await a.sync.init();
  drive.hook = request => new Promise((resolve, reject) => request.options.signal.addEventListener('abort', () => reject(request.options.signal.reason), { once: true }));
  const running = a.sync.sync(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await a.sync.configure({ client_id: 'new-client' })).state, 'auth-required'); await running;
  const state = a.store.snapshot; state.notes[0].body = 'O armazenamento local permanece aberto'; await a.store.save(state);
  assert.equal(a.store.snapshot.notes[0].body, state.notes[0].body);
});
