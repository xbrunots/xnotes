'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yazl = require('yazl');
const { GitHubTools, RELEASES, extractArchive, sanitize } = require('../desktop/github-tools.cjs');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-gh-tools-'));
  const calls = [], events = []; let secure = true, signedIn = false;
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.length === 1 && args[0] === '--version') return { stdout: path.basename(file) === 'git.exe' ? 'git version 2.56.0.windows.4\n' : 'gh version 2.103.3 (2026-10-26)\n', stderr: '', code: 0 };
    if (args[0] === 'auth' && args[1] === 'status') return { stdout: signedIn ? JSON.stringify({ state: 'success', tokenSource: secure ? 'keyring' : 'C:/private/hosts.yml' }) : '', stderr: '', code: signedIn ? 0 : 1 };
    if (args[0] === 'api' && args[1] === 'user') return { stdout: JSON.stringify({ login: 'notes-user', id: 18 }), stderr: '', code: 0 };
    if (args[0] === 'auth' && args[1] === 'login') {
      options.onStderr('! First copy your one-time co'); options.onStderr('de: ABCD-EFGH\n');
      options.onStderr('Open this URL to continue in your web browser: https://github.com/login/device\n');
      signedIn = true; return { stdout: '', stderr: '', code: 0 };
    }
    if (args.includes('--local')) return { stdout: 'core.repositoryformatversion\n0\0core.bare\nfalse\0', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const tools = new GitHubTools({ toolsDir: path.join(root, 'notes-tools'), platform: 'win32', env: {}, runner, onProgress: event => events.push(event), ...overrides });
  t.after(async () => { tools.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function installed(kind) {
    const target = path.join(tools.toolsDir, kind, kind === 'git' ? 'cmd' : 'bin', kind + '.exe');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'fixture-executable'); return target;
  }
  return { root, tools, installed, calls, events, runner, setSignedIn(value) { signedIn = value; }, setSecure(value) { secure = value; } };
}
async function archive(entries) {
  const zip = new yazl.ZipFile(), chunks = [];
  const promise = new Promise((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.content || 'fixture'), entry.name, entry.options || {});
  zip.end(); return promise;
}
function release(kind, buffer) {
  return { ...RELEASES[kind], size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

test('inspect detects portable tools, returns only safe account fields, and does not install or prompt', async t => {
  const { tools, installed, calls, setSignedIn } = await fixture(t);
  assert.deepEqual(await tools.inspect(), { git: { installed: false, path: null, version: null }, gh: { installed: false, path: null, version: null }, account: { loggedIn: false } });
  const git = await installed('git'), gh = await installed('gh'); setSignedIn(true);
  const state = await tools.inspect();
  assert.equal(state.git.path, git); assert.equal(state.gh.path, gh);
  assert.deepEqual(state.account, { loggedIn: true, login: 'notes-user', id: 18 });
  assert.equal(calls.some(call => call.args.includes('login')), false);
  const user = calls.find(call => call.args[0] === 'api');
  assert.equal(user.args.at(-1), '{login: .login, id: .id}');
  assert.equal(calls.every(call => call.options.shell === false && call.options.windowsHide === true && path.isAbsolute(call.file)), true);
});

test('detect searches common absolute paths without PATH refresh and ignores relative PATH entries', async t => {
  const { tools, root } = await fixture(t);
  const programs = path.join(root, 'Program Files');
  await fs.mkdir(path.join(programs, 'GitHub CLI'), { recursive: true });
  await fs.writeFile(path.join(programs, 'GitHub CLI', 'gh.exe'), 'fixture');
  tools.env = { ProgramFiles: programs, PATH: '.;relative' };
  assert.equal((await tools.inspect()).gh.path, path.join(programs, 'GitHub CLI', 'gh.exe'));
});

test('missing tools install only verified official portable archives into notes-tools', async t => {
  const git = await archive([{ name: 'cmd/git.exe' }]), gh = await archive([{ name: 'bin/gh.exe' }]);
  const downloads = [];
  const { tools, events, calls } = await fixture(t, { releases: { git: release('git', git), gh: release('gh', gh) }, fetch: async (url, options) => {
    downloads.push({ url, options }); return new Response(url.includes('MinGit-') ? git : gh, { headers: { 'Content-Type': 'application/zip' } });
  } });
  const state = await tools.ensureInstalled();
  assert.equal(state.git.installed, true); assert.equal(state.gh.installed, true); assert.equal(downloads.length, 2);
  assert.equal(downloads.every(item => item.options.redirect === 'manual' && item.options.headers.Authorization === undefined), true);
  assert.equal(events.some(event => event.step === 'installed-git'), true); assert.equal(events.some(event => event.step === 'installed-gh'), true);
  assert.equal(calls.some(call => /winget|powershell|cmd\.exe/i.test(call.file)), false);
  assert.equal((await fs.readdir(tools.toolsDir)).some(name => name.startsWith('.git-') || name.startsWith('.gh-')), false);
});

test('a checksum mismatch, wrong size or untrusted redirect never executes the downloaded archive', async t => {
  const buffer = await archive([{ name: 'cmd/git.exe' }]);
  for (const mode of ['hash', 'size', 'redirect']) {
    const releaseInfo = release('git', buffer); if (mode === 'hash') releaseInfo.sha256 = 'a'.repeat(64);
    if (mode === 'size') releaseInfo.size++;
    const requests = [];
    const { tools, calls } = await fixture(t, { releases: { git: releaseInfo }, fetch: async url => {
      requests.push(url); return mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/program.zip' } }) : new Response(buffer);
    } });
    await assert.rejects(tools.ensureInstalled(), error => ['GITHUB_INTEGRITY', 'GITHUB_DOWNLOAD_URL'].includes(error.code));
    assert.equal(calls.length, 0); assert.equal(requests.length, 1);
    assert.equal(await fs.stat(path.join(tools.toolsDir, 'git')).then(() => true, () => false), false);
    assert.equal((await fs.readdir(tools.toolsDir)).some(name => name.startsWith('.git-')), false);
  }
});

test('archive rejects links, Windows special paths and case-insensitive duplicates', async t => {
  const { root } = await fixture(t);
  const cases = [
    [{ name: 'bin/link', options: { mode: 0o120777 } }], [{ name: 'bin/CON.txt' }], [{ name: 'bin/file.' }],
    [{ name: 'bin/duplicate.exe' }, { name: 'bin/DUPLICATE.exe' }]
  ];
  for (let index = 0; index < cases.length; index++) {
    const zip = path.join(root, index + '.zip'), target = path.join(root, 'extract-' + index);
    await fs.writeFile(zip, await archive(cases[index])); await fs.mkdir(target);
    await assert.rejects(extractArchive(zip, target), error => error.code === 'GITHUB_ARCHIVE');
  }
  // Mutate equal-length ZIP entry names, since yazl correctly refuses traversal.
  const traversing = await archive([{ name: 'aa/a.exe' }]);
  const altered = Buffer.from(traversing.toString('latin1').replaceAll('aa/a.exe', '../a.exe'), 'latin1');
  const zip = path.join(root, 'traversal.zip'), target = path.join(root, 'traversal');
  await fs.writeFile(zip, altered); await fs.mkdir(target);
  await assert.rejects(extractArchive(zip, target), error => error.code === 'GITHUB_ARCHIVE');
  assert.equal(await fs.stat(path.join(root, 'a.exe')).then(() => true, () => false), false);
});

test('tool directory junctions cannot redirect downloads or empty Git configuration', async t => {
  const { tools, root } = await fixture(t);
  const target = path.join(root, 'outside'); await fs.mkdir(target);
  await fs.symlink(target, tools.toolsDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.ensureInstalled(), error => error.code === 'GITHUB_UNSAFE_PATH');
  assert.deepEqual(await fs.readdir(target), []);
});

test('login reuses a secure account and new login supplies browser device code without terminal prompts', async t => {
  const { tools, installed, setSignedIn, calls, events } = await fixture(t);
  await installed('git'); await installed('gh'); setSignedIn(true);
  assert.deepEqual(await tools.login(), { loggedIn: true, login: 'notes-user', id: 18 });
  assert.equal(calls.some(call => call.args[1] === 'login'), false);
  setSignedIn(false);
  assert.equal((await tools.login()).loggedIn, true);
  const login = calls.find(call => call.args[1] === 'login');
  assert.deepEqual(login.args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
  assert.equal(login.options.env.GH_PROMPT_DISABLED, '1'); assert.equal(login.options.input, '');
  assert.equal(login.options.windowsHide, true); assert.equal(login.options.shell, false);
  assert.equal(events.some(event => event.deviceCode === 'ABCD-EFGH' && event.verificationUri === 'https://github.com/login/device'), true);
  assert.equal(events.some(event => /token|oauth|ghp_/i.test(event.message)), false);
});

test('plaintext credential fallback is explicit and cannot be reported as a secure login', async t => {
  const { tools, installed, setSignedIn, setSecure } = await fixture(t);
  await installed('git'); await installed('gh'); setSignedIn(true); setSecure(false);
  assert.deepEqual((await tools.inspect()).account, { loggedIn: false, secureStorageUnavailable: true });
  await assert.rejects(tools.login(), error => error.code === 'GITHUB_SECURE_STORAGE' && !error.message.includes('hosts.yml'));
});

test('Git is isolated from shell/environment/config attacks while input and binary blobs survive', async t => {
  const { tools, installed, calls, root, runner } = await fixture(t);
  await installed('git'); await installed('gh');
  tools.env = { PATH: '.', GITHUB_TOKEN: 'ghp_do_not_expose_this_value', GH_DEBUG: 'api', GH_CONFIG_DIR: 'attacker', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'evil', NODE_OPTIONS: '--inspect', OTHER: 'allowed' };
  const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
  tools.runner = async (file, args, options) => {
    const result = await runner(file, args, options);
    return args.includes('cat-file') ? { stdout: bytes, stderr: '', code: 0 } : result;
  };
  const input = Buffer.from('literal $(do-not-execute) & echo private');
  const result = await tools.git(['cat-file', 'blob', 'HEAD:a & b.txt'], { cwd: root, input, binary: true, env: { GIT_AUTHOR_NAME: 'notes' } });
  assert.deepEqual(result.stdout, bytes);
  const call = calls.find(value => value.args.includes('cat-file'));
  assert.deepEqual(call.args.slice(-3), ['cat-file', 'blob', 'HEAD:a & b.txt']); assert.deepEqual(call.options.input, input);
  for (const key of ['GITHUB_TOKEN', 'GH_DEBUG', 'GH_CONFIG_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'NODE_OPTIONS']) assert.equal(call.options.env[key], undefined);
  assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(call.options.env.GIT_AUTHOR_NAME, 'notes');
  assert.equal(call.args.includes('protocol.file.allow=never'), true); assert.equal(call.args.includes('core.fsmonitor=false'), true);
  assert.equal(call.args.some(arg => arg.startsWith('credential.https://github.com.helper=!')), true);
  assert.equal(call.args.some(arg => arg.includes('--global')), false);
  await assert.rejects(tools.git(['status'], { env: { GIT_SSH_COMMAND: 'evil' } }), error => error.code === 'GITHUB_ENVIRONMENT');
  await assert.rejects(tools.gh(['api', 'a\0b']), error => error.code === 'GITHUB_ARGUMENTS');
});

test('a local repository cannot enable executable filters, include files, external merge tools or credentials', async t => {
  const { tools, installed, runner, root } = await fixture(t);
  await installed('git'); await installed('gh');
  for (const key of ['filter.malicious.smudge', 'include.path', 'includeif.gitdir:x.path', 'core.fsmonitor', 'merge.custom.driver', 'diff.custom.textconv', 'credential.helper', 'remote.origin.uploadpack']) {
    let executed = false;
    tools.runner = async (file, args, options) => args.includes('--local') ? { stdout: key + '\nevil-command\0', stderr: '', code: 0 } : args.includes('checkout') ? (executed = true, { stdout: '', stderr: '', code: 0 }) : runner(file, args, options);
    await assert.rejects(tools.git(['checkout', 'main'], { cwd: root }), error => error.code === 'GITHUB_UNSAFE_CONFIG');
    assert.equal(executed, false);
  }
});

test('errors never echo command arguments, stderr tokens, URLs with credentials or injected runner exceptions', async t => {
  const { tools, installed } = await fixture(t); await installed('gh');
  tools.paths.gh = path.join(tools.toolsDir, 'gh', 'bin', 'gh.exe');
  tools.runner = async () => ({ stdout: 'ghp_private_token', stderr: 'Authorization: Bearer private-secret https://user:secret@github.com/test', code: 1 });
  const output = await tools.gh(['api', 'private-secret'], { allowFailure: true });
  assert.equal(/ghp_private|private-secret|user:secret/.test(JSON.stringify(output)), false);
  await assert.rejects(tools.gh(['api', 'private-secret']), error => !/private|Bearer|secret/.test(error.message));
  tools.runner = async () => { throw new Error('ghp_private_token'); };
  await assert.rejects(tools.gh(['api', 'user']), error => error.code === 'GITHUB_PROCESS' && !error.message.includes('ghp_'));
  assert.equal(sanitize('gho_123456789 Authorization: token xyz'), '[credencial removida] Authorization: token [credencial removida]');
});

test('real subprocesses have bounded output, timeout and cancellation; close only stops owned children', async t => {
  const { tools } = await fixture(t); tools.runner = undefined;
  const result = await tools.execute(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,65]))'], { binary: true });
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 65]));
  await assert.rejects(tools.execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { outputLimit: 128 }), error => error.code === 'GITHUB_OUTPUT_LIMIT');
  await assert.rejects(tools.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), error => error.code === 'GITHUB_TIMEOUT');
  const controller = new AbortController();
  const operation = tools.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(operation, error => error.code === 'GITHUB_CANCELLED');
  const closed = tools.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  tools.close(); await assert.rejects(closed, error => error.code === 'GITHUB_CANCELLED');
  assert.equal(tools.children.size, 0);
  await assert.rejects(tools.inspect(), error => error.code === 'GITHUB_CANCELLED');
});

test('cancel aborts an active login without closing the tools and stale login cannot replace a successful reconnect', async t => {
  const { tools, installed, runner, events } = await fixture(t);
  await installed('git'); await installed('gh');
  let begin, finish, oldOptions, count = 0;
  const started = new Promise(resolve => { begin = resolve; });
  tools.runner = async (file, args, options) => {
    if (args[0] === 'auth' && args[1] === 'login' && ++count === 1) {
      oldOptions = options; begin();
      // Deliberately non-cooperative fixture: a late successful result must
      // still be rejected by the generation guard, without account lookup.
      return new Promise(resolve => { finish = resolve; });
    }
    return runner(file, args, options);
  };
  const first = tools.login(), rejected = assert.rejects(first, error => error.code === 'GITHUB_CANCELLED');
  await started; tools.cancel(); assert.equal(oldOptions.signal.aborted, true); assert.equal(tools.closed, false);
  assert.equal((await tools.login()).loggedIn, true);
  const completed = events.filter(event => event.step === 'logged-in').length;
  oldOptions.onStderr('! First copy your one-time code: WXYZ-1234\n');
  finish({ stdout: '', stderr: '', code: 0 }); await rejected;
  assert.equal(events.some(event => event.deviceCode === 'WXYZ-1234'), false);
  assert.equal(events.filter(event => event.step === 'logged-in').length, completed);
  assert.equal(completed, 1); assert.equal((await tools.inspect()).account.loggedIn, true);
});

test('cancel during an official download prevents old installation and permits immediate retry', async t => {
  const git = await archive([{ name: 'cmd/git.exe' }]), gh = await archive([{ name: 'bin/gh.exe' }]);
  let begin, finish, originalSignal, requests = 0;
  const started = new Promise(resolve => { begin = resolve; });
  const { tools, events } = await fixture(t, { releases: { git: release('git', git), gh: release('gh', gh) }, fetch: async (url, options) => {
    if (++requests === 1) {
      originalSignal = options.signal; begin();
      return new Promise(resolve => { finish = resolve; });
    }
    return new Response(url.includes('MinGit-') ? git : gh);
  } });
  const first = tools.ensureInstalled(), rejected = assert.rejects(first, error => error.code === 'GITHUB_CANCELLED');
  await started; tools.cancel(); assert.equal(originalSignal.aborted, true);
  const second = await tools.ensureInstalled(); assert.equal(second.git.installed && second.gh.installed, true);
  finish(new Response(git)); await rejected;
  assert.equal(events.filter(event => event.step === 'tools-ready').length, 1);
  assert.equal(events.filter(event => event.step === 'installed-git').length, 1);
  assert.equal((await fs.readdir(tools.toolsDir)).some(name => name.startsWith('.git-') || name.startsWith('.gh-')), false);
});

test('cancel stops owned processes and resets neither executables nor future operations', async t => {
  const { tools } = await fixture(t); tools.runner = undefined;
  const running = tools.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const rejected = assert.rejects(running, error => error.code === 'GITHUB_CANCELLED');
  assert.equal(tools.children.size, 1); tools.cancel(); await rejected;
  assert.equal(tools.children.size, 0); assert.equal(tools.closed, false);
  const result = await tools.execute(process.execPath, ['-e', 'process.stdout.write("ready")']);
  assert.equal(result.stdout, 'ready');
  tools.close(); await assert.rejects(tools.execute(process.execPath, ['-e', 'process.stdout.write("late")']), error => error.code === 'GITHUB_CANCELLED');
});

test('cancel while preparing Git prevents a later command from starting under a fresh generation', async t => {
  const { tools, installed, calls } = await fixture(t);
  await installed('git'); await installed('gh'); await tools.inspect();
  const prepare = tools.prepareDirectories.bind(tools); let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  tools.prepareDirectories = async generation => { await prepare(generation); begin(); await new Promise(resolve => { finish = resolve; }); };
  const operation = tools.git(['push', 'origin', 'main']), rejected = assert.rejects(operation, error => error.code === 'GITHUB_CANCELLED');
  await started; tools.cancel(); finish(); await rejected;
  assert.equal(calls.some(call => call.args.includes('push')), false);
});
