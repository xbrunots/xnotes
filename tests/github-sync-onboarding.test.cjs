'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const { AssetStore } = require('../desktop/assets.cjs');
const { GitHubSync } = require('../desktop/github-sync.cjs');
const { GitRepository, FORMAT, MARKER } = require('../desktop/github-repo.cjs');

async function setup(t, repos, markers = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-github-onboarding-'));
  const store = new WorkspaceStore({ dataDir: path.join(directory, 'data'), seed: { groups: [], notes: [] } }); await store.init();
  const assets = await new AssetStore({ dataDir: store.dataDir }).init(), calls = [];
  const tools = { onProgress() {}, async ensureInstalled() { return { git: { installed: true }, gh: { installed: true }, account: { loggedIn: true, login: 'notes-test', id: 42 } }; },
    async gh(args) {
      calls.push(args);
      if (args[0] === 'repo' && args[1] === 'list') return { stdout: JSON.stringify(repos), stderr: '', code: 0 };
      if (args[0] === 'api') { const name = args[1].split('/').slice(1, 3).join('/'); const value = markers[name]; return value ? { stdout: Buffer.from(JSON.stringify(value)).toString('base64'), stderr: '', code: 0 } : { stdout: '', stderr: '404', code: 1 }; }
      if (args[0] === 'repo' && args[1] === 'create') return { stdout: '', stderr: '', code: 0 };
      throw new Error('Unexpected fixture command');
    }, async git() { throw new Error('Git must not run in onboarding-only fixture'); }, async cancel() {} };
  const sync = new GitHubSync({ store, assets, tools, repoDir: path.join(directory, 'notes-repository') });
  sync._ensureRepository = async () => {}; sync.sync = async () => sync._setStatus({ state: 'ready' });
  t.after(async () => { await sync.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { sync, calls };
}
test('onboarding adopts an existing private library only when its application marker is valid', async t => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const { sync, calls } = await setup(t, [{ nameWithOwner: 'notes-test/notes-library', isPrivate: true, defaultBranchRef: { name: 'library' } }], { 'notes-test/notes-library': { format: FORMAT, version: 1, libraryId: id } });
  const status = await sync.connect(); assert.equal(status.state, 'ready'); assert.equal(status.repository.nameWithOwner, 'notes-test/notes-library');
  assert.equal(sync._config.libraryId, id); assert.equal(sync._config.branch, 'library'); assert.equal(calls.some(args => args[1] === 'create'), false);
});
test('colliding public, unmarked and incompatible repositories are preserved and a new private name is created', async t => {
  const { sync, calls } = await setup(t, [
    { nameWithOwner: 'notes-test/notes-library', isPrivate: false },
    { nameWithOwner: 'notes-test/notes-library-2', isPrivate: true },
    { nameWithOwner: 'notes-test/notes-library-3', isPrivate: true }
  ], { 'notes-test/notes-library-3': { format: 'unrelated-application', version: 1 } });
  const status = await sync.connect(); assert.equal(status.repository.nameWithOwner, 'notes-test/notes-library-4');
  const creation = calls.find(args => args[1] === 'create'); assert.ok(creation.includes('--private')); assert.equal(creation[2], 'notes-test/notes-library-4');
  assert.equal(calls.some(args => args[0] === 'api' && args[1] === 'repos/notes-test/notes-library/contents/' + MARKER), false, 'public repositories cannot be adopted');
});
test('repository suffixes beyond nine remain valid after restarting a persisted connection', async t => {
  const { sync } = await setup(t, Array.from({ length: 9 }, (_, index) => ({ nameWithOwner: 'notes-test/notes-library' + (index ? '-' + (index + 1) : ''), isPrivate: false })));
  await sync.connect(); assert.equal(sync.status.repository.nameWithOwner, 'notes-test/notes-library-10');
  const persisted = JSON.parse(await fs.readFile(sync._stateFile, 'utf8')); assert.equal(persisted.repository.nameWithOwner, 'notes-test/notes-library-10');
  const reopened = new GitHubSync({ store: sync.store, assets: sync.assets, tools: sync.tools, repoDir: sync.repoDir });
  await reopened.init(); assert.equal(reopened.status.repository.nameWithOwner, 'notes-test/notes-library-10'); await reopened.close();
});
test('hostile remote symlinks, submodules, Windows paths and oversized blobs are rejected before reading contents', async () => {
  let row = '', reads = 0;
  const repository = new GitRepository({ directory: path.resolve(os.tmpdir(), 'never-created-notes'), tools: { async git(args) { assert.equal(args[0], 'ls-tree'); reads++; return { stdout: Buffer.from(row + '\0'), code: 0 }; } } });
  const oid = 'a'.repeat(40);
  for (const value of [
    '120000 blob ' + oid + ' 12\tlink.txt', '160000 commit ' + oid + ' -\tmodule',
    '100644 blob ' + oid + ' 4\t../outside.txt', '100644 blob ' + oid + ' 4\t.git/config',
    '100644 blob ' + oid + ' 4\taux.txt', '100644 blob ' + oid + ' 4\tfolder/hosts.yml',
    '100644 blob ' + oid + ' 104857601\tlarge.bin'
  ]) { row = value; await assert.rejects(repository.tree('b'.repeat(40)), /Links simbólicos|caminho|credenciais|100 MiB/i); }
  assert.equal(reads, 7);
});
