'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const { AssetStore } = require('../desktop/assets.cjs');
const { GitHubSync } = require('../desktop/github-sync.cjs');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, pause) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-github-cancel-'));
  const store = new WorkspaceStore({ dataDir: path.join(directory, 'data'), seed: { groups: [], notes: [] } }); await store.init();
  const assets = await new AssetStore({ dataDir: store.dataDir }).init(), reached = deferred(), released = deferred(), calls = [];
  const tools = {
    onProgress() {}, async ensureInstalled() {
      if (pause === 'install') { reached.resolve(); await released.promise; }
      return { git: { installed: true }, gh: { installed: true }, account: { loggedIn: pause !== 'login', login: 'notes-test', id: 42 } };
    },
    async login() { reached.resolve(); await released.promise; return { loggedIn: true, login: 'notes-test', id: 42 }; },
    async gh(args) { calls.push(args); if (args[0] === 'repo' && args[1] === 'list') { if (pause === 'list') { reached.resolve(); await released.promise; } return { stdout: '[]', code: 0, stderr: '' }; } if (args[0] === 'repo' && args[1] === 'create') { reached.resolve(); await released.promise; return { stdout: '', code: 0, stderr: '' }; } throw new Error('Unexpected fixture command'); },
    async git(args) { calls.push(args); throw new Error('No Git command is authorized after cancellation'); },
    async cancel() { released.resolve(); }
  };
  const sync = new GitHubSync({ store, assets, tools, repoDir: path.join(directory, 'notes-repository') });
  t.after(async () => { await sync.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { sync, tools, reached, calls };
}
for (const pause of ['install', 'login', 'list', 'create']) test('cancel onboarding during ' + pause + ' cannot create a repository or push afterward', async t => {
  const { sync, reached, calls } = await fixture(t, pause), connecting = sync.connect(); await reached.promise;
  const before = calls.length; await sync.disconnect(); const status = await connecting;
  assert.equal(status.state, 'disconnected'); assert.equal(status.connected, false); assert.equal(calls.length, before);
  if (pause !== 'create') assert.equal(calls.some(args => args[0] === 'repo' && args[1] === 'create'), false);
  assert.equal(calls.some(args => args[0] === 'push' || args[0] === 'init'), false);
});
test('close while waiting for browser login drains the obsolete operation without creating a repository', async t => {
  const { sync, reached, calls } = await fixture(t, 'login'), connecting = sync.connect(); await reached.promise;
  await sync.close(); assert.equal((await connecting).state, 'disconnected'); assert.deepEqual(calls, []);
});
