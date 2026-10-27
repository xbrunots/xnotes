'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { WorkspaceStore } = require('../desktop/storage.cjs');
const { AssetStore } = require('../desktop/assets.cjs');
const { GitHubTools } = require('../desktop/github-tools.cjs');
const { GitHubSync, DAY } = require('../desktop/github-sync.cjs');
const { MARKER, CHUNK_BYTES, sha } = require('../desktop/github-repo.cjs');

process.env.NOTES_TEST = '1';
const exec = promisify(execFile);
const seed = () => ({ groups: [{ id: 'g', name: 'Pessoal', sessions: [{ id: 's', name: 'Ideias' }] }], notes: [{ id: 'n', s: 's', title: 'Primeira', body: 'Linha inicial\n\nLinha do meio\n\nLinha final', t: 'Agora' }], appearance: 'islands', noteDisplay: 'grid', theme: 'dark' });
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-github-')), remote = path.join(directory, 'remote.git'), instances = [];
  await exec('git', ['init', '--bare', '--initial-branch=main', remote], { windowsHide: true });
  const create = async (name, override = {}) => {
    const dataDir = path.join(directory, name, 'notes-data'), repoDir = path.join(directory, name, 'notes-repository'), toolsDir = path.join(directory, name, 'tools');
    await fs.mkdir(path.join(toolsDir, 'gh', 'bin'), { recursive: true });
    const ghFile = path.join(toolsDir, 'gh', 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh');
    await fs.writeFile(ghFile, 'fixture; never executed');
    const store = new WorkspaceStore({ dataDir, seed: seed(), deviceId: name }); await store.init();
    const assets = await new AssetStore({ dataDir }).init(), calls = [], faults = {};
    let tools;
    tools = new GitHubTools({ toolsDir, trustedFileProtocol: true, runner: async (executable, args, runOptions) => {
      if (executable === ghFile) {
        if (args[0] === '--version') return { stdout: 'gh version 2.103.3', stderr: '', code: 0 };
        if (args[0] === 'auth' && args[1] === 'status') return { stdout: '{"state":"success","tokenSource":"keyring"}', stderr: '', code: 0 };
        if (args[0] === 'api' && args[1] === 'user') return { stdout: '{"login":"notes-test","id":42}', stderr: '', code: 0 };
        if (override.gh) return override.gh(args, runOptions);
        throw new Error('Unexpected gh fixture command: ' + args.slice(0, 2));
      }
      const command = args.find(arg => ['fetch', 'push', 'commit', 'stash', 'merge', 'add'].includes(arg));
      if (command) calls.push({ command, args: [...args] });
      if (faults[command]) { const fault = faults[command]; delete faults[command]; if (typeof fault === 'function') return fault(executable, args, runOptions); return { stdout: '', stderr: fault, code: 1 }; }
      return tools.spawn(executable, args, runOptions);
    } });
    tools.paths.gh = ghFile;
    const sync = new GitHubSync({ store, assets, tools, repoDir, testRemote: remote, ...options, ...override.sync });
    const instance = { store, assets, tools, sync, repoDir, dataDir, calls, faults, ghFile }; instances.push(instance); return instance;
  };
  t.after(async () => {
    for (const instance of instances) { await instance.sync.close(); await instance.tools.close(); await instance.store.close(); }
    const absolute = path.resolve(directory); assert.ok(path.basename(absolute).startsWith('notes-github-')); await fs.rm(absolute, { recursive: true, force: true });
  });
  return { directory, remote, create };
}
async function save(instance, edit) { const snapshot = instance.store.snapshot; edit(snapshot); return instance.store.save(snapshot); }
async function ready(instance) { const status = await instance.sync.connect(); assert.equal(status.state, 'ready', status.error); return status; }
async function syncReady(instance) { const status = await instance.sync.sync(); assert.equal(status.state, 'ready', status.error); return status; }
async function resolve(instance, choice = 'both', session) {
  session ||= await instance.sync.getConflicts();
  return instance.sync.resolveConflicts({ sessionId: session.sessionId, remoteCommit: session.remoteCommit, expectedHeadIds: session.expectedHeadIds,
    choices: session.items.map(item => ({ id: item.id, choice: typeof choice === 'function' ? choice(item) : choice })) });
}

test('onboarding uses a private marked repository; real Git exchanges complete notes and arbitrary files', async t => {
  const { create } = await setup(t), a = await create('pc-a');
  assert.equal((await a.sync.init()).state, 'disconnected'); assert.equal(a.calls.length, 0);
  const status = await ready(a); assert.equal(status.provider, 'github'); assert.equal(status.repository.localPath, a.repoDir);
  const mark = JSON.parse(await fs.readFile(path.join(a.repoDir, MARKER), 'utf8')); assert.equal(mark.format, 'notes-github-library');
  await fs.writeFile(path.join(a.repoDir, 'arquivo local.txt'), 'Texto criado diretamente na pasta');
  await save(a, state => { state.notes[0].title = 'Vive no GitHub'; state.notes[0].noteTheme = 'oceano'; state.customPreference = { keep: true }; });
  await syncReady(a);
  const b = await create('pc-b'); await ready(b);
  assert.deepEqual(b.store.snapshot, a.store.snapshot);
  assert.equal(await fs.readFile(path.join(b.repoDir, 'arquivo local.txt'), 'utf8'), 'Texto criado diretamente na pasta');
  assert.equal(b.sync.status.pending, 0); assert.equal(b.sync.status.conflictCount, 0);
  assert.equal(JSON.stringify(b.sync.status).includes('token'), false);
  assert.equal(JSON.stringify(b.sync.status).includes('credential'), false);
});

test('daily deadline persists; typing, local exports, startup, disconnect and close never upload', async t => {
  let now = 1700000000000;
  const { create } = await setup(t, { now: () => now }), a = await create('pc-a'); await ready(a);
  const initial = a.calls.filter(call => call.command === 'push' || call.command === 'fetch').length, next = a.sync.status.nextSync;
  await save(a, state => { state.notes[0].body = 'Somente amanhã ou pelo botão'; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok((await fs.readdir(path.join(a.repoDir, 'revisions'))).length > 4);
  assert.equal(a.calls.filter(call => call.command === 'push' || call.command === 'fetch').length, initial);
  assert.equal(Date.parse(next) - now, DAY);
  now += DAY / 2; await a.sync.syncIfDue(); assert.equal(a.calls.filter(call => call.command === 'push' || call.command === 'fetch').length, initial);
  await a.sync.close(); await a.tools.close();
  const restarted = await create('pc-a'); await restarted.sync.init({ syncIfDue: true });
  assert.equal(restarted.sync.status.nextSync, next); assert.equal(restarted.calls.length, 0);
  now = Date.parse(next); await restarted.sync.syncIfDue(); assert.equal(restarted.sync.status.state, 'ready', restarted.sync.status.error);
  assert.ok(restarted.calls.some(call => call.command === 'push'));
  const count = restarted.calls.length; await restarted.sync.disconnect(); await restarted.sync.close(); assert.equal(restarted.calls.length, count);
});

test('independent note fields, compatible lines and ordinary file edits auto-merge without duplicate notes', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  await fs.writeFile(path.join(a.repoDir, 'texto.txt'), 'Primeira\n\nMeio\n\nÚltima\n'); await syncReady(a);
  const b = await create('pc-b'); await ready(b);
  await save(a, state => { state.notes[0].title = 'Título do PC A'; state.notes[0].body = state.notes[0].body.replace('Linha inicial', 'Começo no PC A'); });
  await save(b, state => { state.notes[0].noteTheme = 'ameixa'; state.notes[0].body = state.notes[0].body.replace('Linha final', 'Final no PC B'); });
  await fs.writeFile(path.join(a.repoDir, 'texto.txt'), 'Primeira A\n\nMeio\n\nÚltima\n');
  await fs.writeFile(path.join(b.repoDir, 'texto.txt'), 'Primeira\n\nMeio\n\nÚltima B\n');
  await syncReady(a); await syncReady(b); await syncReady(a);
  assert.equal(a.store.snapshot.notes.length, 1); assert.deepEqual(a.store.snapshot, b.store.snapshot);
  assert.equal(a.store.snapshot.notes[0].title, 'Título do PC A'); assert.equal(a.store.snapshot.notes[0].noteTheme, 'ameixa');
  assert.match(a.store.snapshot.notes[0].body, /Começo no PC A/); assert.match(a.store.snapshot.notes[0].body, /Final no PC B/);
  assert.equal(await fs.readFile(path.join(a.repoDir, 'texto.txt'), 'utf8'), 'Primeira A\n\nMeio\n\nÚltima B\n');
  assert.equal((await a.tools.git(['stash', 'list'], { cwd: a.repoDir })).stdout, '');
});

test('incompatible note, text and binary conflicts pause before merging; both choices preserve all versions', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  await fs.writeFile(path.join(a.repoDir, 'texto.txt'), 'Base\n'); await fs.writeFile(path.join(a.repoDir, 'imagem.bin'), Buffer.from([0, 1])); await syncReady(a);
  const b = await create('pc-b'); await ready(b);
  await save(a, state => { state.notes[0].body = 'Nota do PC A'; }); await save(b, state => { state.notes[0].body = 'Nota do PC B'; });
  await fs.writeFile(path.join(a.repoDir, 'texto.txt'), 'Texto A\n'); await fs.writeFile(path.join(b.repoDir, 'texto.txt'), 'Texto B\n');
  await fs.writeFile(path.join(a.repoDir, 'imagem.bin'), Buffer.from([0, 2])); await fs.writeFile(path.join(b.repoDir, 'imagem.bin'), Buffer.from([0, 3]));
  await syncReady(a); const before = b.store.snapshot;
  const status = await b.sync.sync(); assert.equal(status.state, 'conflict', status.error); assert.equal(status.conflictCount, 3);
  assert.deepEqual(b.store.snapshot, before, 'remote text cannot replace the library before a choice');
  const session = await b.sync.getConflicts(); assert.ok(session.items.some(item => item.kind === 'note' && item.local.body === 'Nota do PC B' && item.remote.body === 'Nota do PC A'));
  assert.ok(session.items.some(item => item.path === 'imagem.bin' && item.local.binary && item.remote.binary));
  assert.equal((await resolve(b, 'both', session)).state, 'ready'); await syncReady(a);
  assert.deepEqual(new Set(a.store.snapshot.notes.map(note => note.body)), new Set(['Nota do PC A', 'Nota do PC B']));
  assert.equal(a.store.snapshot.notes.length, 2); assert.ok(a.store.snapshot.notes.every(note => !/<<<<<<<|=======|>>>>>>>/.test(note.body)));
  assert.equal(await fs.readFile(path.join(b.repoDir, 'texto.txt'), 'utf8'), 'Texto B\n');
  assert.equal(await fs.readFile(path.join(b.repoDir, 'texto (GitHub).txt'), 'utf8'), 'Texto A\n');
  assert.deepEqual(await fs.readFile(path.join(b.repoDir, 'imagem (GitHub).bin')), Buffer.from([0, 2]));
  assert.deepEqual(a.store.snapshot, b.store.snapshot);
});

test('stale conflict choices cannot overwrite autosave or a newer remote commit; persisted diff reopens after restart', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a); const b = await create('pc-b'); await ready(b);
  await save(a, state => { state.notes[0].body = 'Remota'; }); await save(b, state => { state.notes[0].body = 'Local'; }); await syncReady(a);
  assert.equal((await b.sync.sync()).state, 'conflict'); const old = await b.sync.getConflicts();
  await save(b, state => { state.notes[0].body = 'Local digitada com diff aberto'; });
  await assert.rejects(resolve(b, 'remote', old), { code: 'GITHUB_CONFLICT_STALE' });
  assert.equal(b.store.snapshot.notes[0].body, 'Local digitada com diff aberto');
  const current = await b.sync.getConflicts(); assert.notEqual(current.sessionId, old.sessionId);
  await b.sync.close(); await b.tools.close(); const reopened = await create('pc-b'); await reopened.sync.init();
  assert.equal(reopened.sync.status.state, 'conflict'); assert.equal((await reopened.sync.getConflicts()).sessionId, current.sessionId);
  await save(a, state => { state.notes[0].body = 'Remota mais nova'; }); await syncReady(a);
  await assert.rejects(resolve(reopened, 'remote', current), { code: 'GITHUB_CONFLICT_STALE' });
  const latest = await reopened.sync.getConflicts(); assert.equal(latest.items[0].remote.body, 'Remota mais nova');
  const result = await resolve(reopened, 'local', latest); assert.equal(result.state, 'ready', result.error);
  await syncReady(a); assert.equal(a.store.snapshot.notes[0].body, 'Local digitada com diff aberto'); assert.equal(a.store.snapshot.notes.length, 1);
});

test('remote-only files pull automatically; deletion versus editing asks before removing data', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  await fs.writeFile(path.join(a.repoDir, 'apagar.txt'), 'Base'); await syncReady(a); const b = await create('pc-b'); await ready(b);
  await fs.unlink(path.join(a.repoDir, 'apagar.txt')); await fs.mkdir(path.join(a.repoDir, 'nova pasta')); await fs.writeFile(path.join(a.repoDir, 'nova pasta', 'novo.txt'), 'Só remoto');
  await save(a, state => { state.notes = []; }); await save(b, state => { state.notes[0].body = 'Edição preservada'; });
  await fs.writeFile(path.join(b.repoDir, 'apagar.txt'), 'Edição local'); await syncReady(a);
  assert.equal((await b.sync.sync()).state, 'conflict'); const session = await b.sync.getConflicts();
  assert.ok(session.items.some(item => item.kind === 'note' && item.remote.deleted)); assert.ok(session.items.some(item => item.path === 'apagar.txt' && item.remote.deleted));
  assert.equal((await resolve(b, 'local', session)).state, 'ready');
  assert.equal(await fs.readFile(path.join(b.repoDir, 'nova pasta', 'novo.txt'), 'utf8'), 'Só remoto');
  assert.equal(await fs.readFile(path.join(b.repoDir, 'apagar.txt'), 'utf8'), 'Edição local'); assert.equal(b.store.snapshot.notes[0].body, 'Edição preservada');
});

test('rejected push and interrupted stash preserve recovery copies and retry without force or hard reset', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  await save(a, state => { state.notes[0].body = 'Commit local mesmo offline'; }); await fs.writeFile(path.join(a.repoDir, 'arquivo.txt'), 'Não perder');
  a.faults.push = '! [rejected] main -> main (fetch first)'; const rejected = await a.sync.sync(); assert.equal(rejected.state, 'offline');
  assert.equal(a.store.snapshot.notes[0].body, 'Commit local mesmo offline'); assert.equal(await fs.readFile(path.join(a.repoDir, 'arquivo.txt'), 'utf8'), 'Não perder');
  assert.ok((await fs.readdir(path.join(a.dataDir, 'github-recovery'))).length);
  await syncReady(a);
  await fs.writeFile(path.join(a.repoDir, 'arquivo.txt'), 'Texto que ficou no stash');
  a.faults.merge = 'Simular interrupção após stash'; const interrupted = await a.sync.sync(); assert.equal(interrupted.state, 'offline');
  const recovery = JSON.parse(await fs.readFile(path.join(a.dataDir, 'github-operation.json'), 'utf8')); assert.ok(recovery.stashOid); assert.equal(recovery.stashApplied, false);
  await a.sync.close(); await a.tools.close(); const restarted = await create('pc-a'); await restarted.sync.init(); await syncReady(restarted);
  assert.equal(await fs.readFile(path.join(restarted.repoDir, 'arquivo.txt'), 'utf8'), 'Texto que ficou no stash');
  assert.equal(restarted.calls.some(call => call.args.includes('--force') && call.command === 'push'), false);
  assert.equal(restarted.calls.some(call => call.args.includes('--hard') || call.args.includes('clean')), false);
});

test('crash between recording merge ancestry and writing the combined tree cannot delete remote-only files', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a); const b = await create('pc-b'); await ready(b);
  await fs.writeFile(path.join(a.repoDir, 'remote-only.txt'), 'Arquivo remoto que precisa sobreviver'); await syncReady(a);
  const writeTree = b.sync.repository.writeTree.bind(b.sync.repository);
  let once = true; b.sync.repository.writeTree = async (...args) => { if (once) { once = false; throw new Error('Fixture: interrupção antes de escrever a árvore combinada'); } return writeTree(...args); };
  assert.equal((await b.sync.sync()).state, 'error');
  assert.ok(await fs.lstat(path.join(b.repoDir, '.git', 'MERGE_HEAD')));
  await b.sync.close(); await b.tools.close();
  const recovered = await create('pc-b'); await recovered.sync.init(); await syncReady(recovered); await syncReady(a);
  assert.equal(await fs.readFile(path.join(recovered.repoDir, 'remote-only.txt'), 'utf8'), 'Arquivo remoto que precisa sobreviver');
  assert.equal(await fs.readFile(path.join(a.repoDir, 'remote-only.txt'), 'utf8'), 'Arquivo remoto que precisa sobreviver');
});

test('crash after stash creation before its OID is persisted restores uncommitted and untracked files', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  await fs.writeFile(path.join(a.repoDir, 'novo-local.txt'), 'Ainda não estava em nenhum commit');
  const git = a.tools.git.bind(a.tools); let once = true;
  a.tools.git = async (args, options) => {
    const result = await git(args, options);
    if (once && args[0] === 'stash' && args[1] === 'push') { once = false; throw new Error('Fixture: crash depois do stash antes da gravação do OID'); }
    return result;
  };
  assert.equal((await a.sync.sync()).state, 'error');
  const interrupted = JSON.parse(await fs.readFile(path.join(a.dataDir, 'github-operation.json'), 'utf8')); assert.equal(interrupted.stage, 'stashing'); assert.equal(interrupted.stashOid, null);
  await a.sync.close(); await a.tools.close(); const restored = await create('pc-a'); await restored.sync.init(); await syncReady(restored);
  assert.equal(await fs.readFile(path.join(restored.repoDir, 'novo-local.txt'), 'utf8'), 'Ainda não estava em nenhum commit');
  const remote = await create('pc-b'); await ready(remote); assert.equal(await fs.readFile(path.join(remote.repoDir, 'novo-local.txt'), 'utf8'), 'Ainda não estava em nenhum commit');
});

test('stash recovery with new notes, groups and sessions suppresses exports and accepts identical re-exported revisions', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a); const b = await create('pc-b'); await ready(b); await syncReady(a);
  await save(a, state => { state.groups.push({ id: 'new-group', name: 'Novo grupo', sessions: [{ id: 'new-session', name: 'Nova sessão' }] }); state.notes.push({ id: 'new-note', s: 'new-session', title: 'Nova nota', body: 'Criada antes da interrupção' }); });
  const newRecords = a.store.exportRevisions().filter(record => !a.sync._remoteRevisionIds.has(record.id));
  a.faults.merge = 'Fixture: falha após stash com novas revisões'; assert.equal((await a.sync.sync()).state, 'offline'); await a.sync._exportQueue;
  assert.equal(a.sync._operation.stashApplied, false);
  for (const record of newRecords) await assert.rejects(fs.access(path.join(a.repoDir, 'revisions', record.id + '.json')), { code: 'ENOENT' });
  // Recover a state left by an older process that did re-export these exact
  // immutable files. This must not wedge stash apply after upgrading/restart.
  for (const record of newRecords) await fs.writeFile(path.join(a.repoDir, 'revisions', record.id + '.json'), JSON.stringify(record) + '\n');
  await a.sync.close(); await a.tools.close(); const restored = await create('pc-a'); await restored.sync.init();
  await save(restored, state => { state.notes.find(note => note.id === 'new-note').body = 'Editada após reiniciar, antes de recuperar o stash'; });
  await new Promise(resolve => setTimeout(resolve, 200)); await restored.sync._exportQueue;
  const afterRestart = restored.store.exportRevisions().filter(record => !newRecords.some(previous => previous.id === record.id) && !restored.sync._remoteRevisionIds.has(record.id));
  assert.ok(afterRestart.length); for (const record of afterRestart) await assert.rejects(fs.access(path.join(restored.repoDir, 'revisions', record.id + '.json')), { code: 'ENOENT' });
  await syncReady(restored); await syncReady(b);
  assert.equal(restored.store.snapshot.notes.find(note => note.id === 'new-note').body, 'Editada após reiniciar, antes de recuperar o stash');
  assert.equal(b.store.snapshot.groups.find(group => group.id === 'new-group').sessions[0].id, 'new-session');
  assert.deepEqual(restored.store.snapshot, b.store.snapshot);
});

test('an alternate push URL is rejected before fetch or push and cannot leak a private library', async t => {
  const { create, directory } = await setup(t), a = await create('pc-a'); await ready(a);
  const wrongRemote = path.join(directory, 'wrong-remote.git'); await exec('git', ['init', '--bare', '--initial-branch=main', wrongRemote], { windowsHide: true });
  await a.tools.git(['remote', 'set-url', '--push', 'origin', wrongRemote], { cwd: a.repoDir });
  await save(a, state => { state.notes[0].body = 'Não enviar para outro destino'; });
  const before = a.calls.filter(call => ['fetch', 'push'].includes(call.command)).length, result = await a.sync.sync();
  assert.equal(result.state, 'error'); assert.match(result.error, /endereço|envio/i);
  assert.equal(a.calls.filter(call => ['fetch', 'push'].includes(call.command)).length, before);
  await assert.rejects(exec('git', ['--git-dir=' + wrongRemote, 'rev-parse', '--verify', 'refs/heads/main']));
});

test('an external file edit made after the recovery snapshot is rebased instead of overwritten', async t => {
  const { create } = await setup(t), a = await create('pc-a'); await ready(a);
  const filename = path.join(a.repoDir, 'editando.txt'); await fs.writeFile(filename, 'Antes da edição externa'); await syncReady(a);
  const snapshot = a.sync._snapshot.bind(a.sync); let once = true;
  a.sync._snapshot = async (...args) => { const result = await snapshot(...args); if (once) { once = false; await fs.writeFile(filename, 'Edição externa DURANTE a sincronização'); } return result; };
  await syncReady(a); assert.equal(await fs.readFile(filename, 'utf8'), 'Edição externa DURANTE a sincronização');
  const b = await create('pc-b'); await ready(b); assert.equal(await fs.readFile(path.join(b.repoDir, 'editando.txt'), 'utf8'), 'Edição externa DURANTE a sincronização');
});

test('tracked encoding, ident and filter attributes cannot transform files or execute a configured command', async t => {
  const { create, directory } = await setup(t), a = await create('pc-a'); await ready(a);
  const bytes = Buffer.from('Texto UTF-8 ç\r\n$Id$\r\n');
  await fs.writeFile(path.join(a.repoDir, '.gitattributes'), '* text eol=lf working-tree-encoding=UTF-16 ident filter=notes-fixture\n');
  await fs.writeFile(path.join(a.repoDir, 'exato.txt'), bytes); await syncReady(a);
  const committed = await a.tools.git(['show', 'HEAD:exato.txt'], { cwd: a.repoDir, binary: true }); assert.deepEqual(committed.stdout, bytes);
  const sentinel = path.join(directory, 'must-not-run.txt');
  await a.tools.git(['config', '--local', 'filter.notes-fixture.clean', process.execPath + ' -e "require(\'fs\').writeFileSync(\'' + sentinel.replace(/\\/g, '/') + '\',\'unsafe\')"'], { cwd: a.repoDir });
  const status = await a.sync.sync(); assert.equal(status.state, 'error'); assert.match(status.error, /configuração externa/);
  await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });
});

test('attachments are chunked below the GitHub limit and corrupt remote chunks fail before applying notes', async t => {
  const { create, directory } = await setup(t), a = await create('pc-a'); await ready(a);
  const filename = path.join(directory, 'asset.bin'), bytes = Buffer.alloc(CHUNK_BYTES + 17, 27); bytes[0] = 13; bytes[1] = 10; await fs.writeFile(filename, bytes);
  await fs.writeFile(path.join(a.repoDir, '.gitattributes'), 'assets/** text eol=crlf\nrevisions/** text eol=crlf\n');
  const descriptor = await a.assets.addFile(filename, { relativePath: 'Anexos/arquivo.bin' }); await save(a, state => { state.notes[0].attachments = [descriptor]; }); await syncReady(a);
  const manifest = JSON.parse(await fs.readFile(path.join(a.repoDir, 'assets', 'manifests', descriptor.hash + '.json'), 'utf8'));
  assert.equal(manifest.chunks.length, 2); assert.ok(manifest.chunks.every(chunk => chunk.size <= CHUNK_BYTES));
  const b = await create('pc-b'); await ready(b); assert.deepEqual(await fs.readFile(await b.assets.file(descriptor.hash)), bytes); await syncReady(a);
  const badChunk = path.join(a.repoDir, 'assets', 'chunks', manifest.chunks[0].hash); await fs.writeFile(badChunk, 'corrompido');
  await a.tools.git(['add', '--all', '--', '.'], { cwd: a.repoDir });
  await a.tools.git(['commit', '-m', 'fixture remote corruption'], { cwd: a.repoDir, env: { GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  await a.tools.git(['push', 'origin', 'HEAD:main'], { cwd: a.repoDir });
  const before = b.store.snapshot, failed = await b.sync.sync(); assert.equal(failed.state, 'error'); assert.match(failed.error, /checksum/i); assert.deepEqual(b.store.snapshot, before);
  assert.deepEqual(await fs.readFile(await b.assets.file(descriptor.hash)), bytes);
});

test('malformed revisions, credential files, oversized arbitrary files and hostile Git trees never enter the library', async t => {
  const { create, remote } = await setup(t), a = await create('pc-a'); await ready(a); const b = await create('pc-b'); await ready(b); await syncReady(a);
  await fs.writeFile(path.join(a.repoDir, 'credentials.json'), '{"token":"fixture"}');
  const sensitive = await a.sync.sync(); assert.equal(sensitive.state, 'error'); assert.match(sensitive.error, /credenciais/); await fs.unlink(path.join(a.repoDir, 'credentials.json'));
  const filename = path.join(a.repoDir, 'grande.bin'), handle = await fs.open(filename, 'w'); await handle.truncate(100 * 1024 * 1024 + 1); await handle.close();
  const huge = await a.sync.sync(); assert.equal(huge.state, 'error'); assert.match(huge.error, /100 MiB/); await fs.unlink(filename);
  const before = b.store.snapshot;
  await fs.writeFile(path.join(a.repoDir, 'revisions', 'a'.repeat(64) + '.json'), '{}');
  await a.tools.git(['add', '--all', '--', '.'], { cwd: a.repoDir }); await a.tools.git(['commit', '-m', 'fixture malformed revision'], { cwd: a.repoDir, env: { GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }); await a.tools.git(['push', 'origin', 'HEAD:main'], { cwd: a.repoDir });
  assert.equal((await b.sync.sync()).state, 'error'); assert.deepEqual(b.store.snapshot, before);
  // A gitlink can be created in the bare index without Windows symlink rights.
  const head = (await exec('git', ['--git-dir=' + remote, 'rev-parse', 'main'])).stdout.trim();
  await a.tools.git(['update-index', '--add', '--cacheinfo', '160000,' + head + ',hostile-submodule'], { cwd: a.repoDir });
  await a.tools.git(['commit', '-m', 'fixture hostile tree'], { cwd: a.repoDir, env: { GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }); await a.tools.git(['push', 'origin', 'HEAD:main'], { cwd: a.repoDir });
  const hostile = await b.sync.sync(); assert.equal(hostile.state, 'error'); assert.match(hostile.error, /submódulos/); assert.deepEqual(b.store.snapshot, before);
});
