'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const seed = () => ({ groups: [{ id: 'g', name: 'Grupo', sessions: [{ id: 's', name: 'Sessão' }] }], notes: [{ id: 'n', s: 's', title: 'Título', body: 'Base' }] });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-github-transaction-')), stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return async (name, deviceId = name) => { const store = new WorkspaceStore({ dataDir: path.join(directory, name), seed: seed(), deviceId }); await store.init(); stores.push(store); return store; };
}
async function edit(store, body) { const value = store.snapshot; value.notes[0].body = body; return store.save(value); }

test('GitHub resolved merge advances own device clocks received after restoring an older backup', async t => {
  const create = await fixture(t), source = await create('newer', 'same-device'), restored = await create('restored', 'same-device');
  for (let index = 1; index <= 5; index++) await edit(source, 'Remoto ' + index);
  await restored.mergeResolvedRevisions(source.exportRevisions(), { expectedHeadIds: restored.exportHeadIds() });
  assert.equal(restored.snapshot.notes[0].body, 'Remoto 5');
  await edit(restored, 'Edição depois da restauração');
  assert.equal(restored.snapshot.notes[0].body, 'Edição depois da restauração');
  assert.equal(Math.max(...restored.exportRevisions().map(record => record.clock['same-device'] || 0)), 6);
  await source.mergeResolvedRevisions(restored.exportRevisions(), { expectedHeadIds: source.exportHeadIds() });
  assert.deepEqual(source.snapshot, restored.snapshot);
});

test('stale GitHub conflict resolution is checked inside the autosave queue and makes no partial writes', async t => {
  const create = await fixture(t), local = await create('a'), remote = await create('b');
  await edit(local, 'Local'); await edit(remote, 'Remoto'); const before = local.exportHeadIds();
  const saving = edit(local, 'Digitação posterior ao diff');
  const resolving = local.mergeResolvedRevisions(remote.exportRevisions(), { expectedHeadIds: before, resolutions: [{ kind: 'note', key: '"n"', choice: 'remote' }] });
  await saving; await assert.rejects(resolving, { code: 'GITHUB_CONFLICT_STALE' });
  assert.equal(local.snapshot.notes[0].body, 'Digitação posterior ao diff');
  assert.equal(local.exportRevisions().some(record => record.device === 'b'), false);
});

test('explicit choices dominate both heads without generating an involuntary recovery note', async t => {
  const create = await fixture(t), local = await create('a'), remote = await create('b');
  await edit(local, 'Local'); await edit(remote, 'Remoto');
  await local.mergeResolvedRevisions(remote.exportRevisions(), { expectedHeadIds: local.exportHeadIds(), resolutions: [{ kind: 'note', key: '"n"', choice: 'remote' }] });
  assert.equal(local.snapshot.notes.length, 1); assert.equal(local.snapshot.notes[0].body, 'Remoto');
  await edit(local, 'Mais tarde');
  await remote.mergeResolvedRevisions(local.exportRevisions(), { expectedHeadIds: remote.exportHeadIds() });
  assert.equal(remote.snapshot.notes.length, 1); assert.equal(remote.snapshot.notes[0].body, 'Mais tarde');
});

test('both choices preserve each note and all attachment descriptors; unresolved heads remain untouched', async t => {
  const create = await fixture(t), local = await create('a'), remote = await create('b');
  await edit(local, 'Local'); await edit(remote, 'Remoto'); const before = local.snapshot;
  await assert.rejects(local.mergeResolvedRevisions(remote.exportRevisions(), { expectedHeadIds: local.exportHeadIds() }), { code: 'GITHUB_CONFLICT_UNRESOLVED' });
  assert.deepEqual(local.snapshot, before);
  await local.mergeResolvedRevisions(remote.exportRevisions(), { expectedHeadIds: local.exportHeadIds(), resolutions: [{ kind: 'note', key: '"n"', choice: 'both' }] });
  assert.deepEqual(new Set(local.snapshot.notes.map(note => note.body)), new Set(['Local', 'Remoto']));
  assert.equal(local.snapshot.notes.length, 2);
});
