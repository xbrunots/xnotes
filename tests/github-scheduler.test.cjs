'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GitHubScheduler, decodeXML } = require('../desktop/github-scheduler.cjs');
const SID = 'S-1-5-21-100-200-300-1001';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-scheduler-test-'));
  const executable = path.join(root, 'notes & family portable.exe'), dataDir = path.join(root, 'notes-data');
  await fs.writeFile(executable, 'portable-fixture');
  const calls = [], xmlFiles = []; let task = null, deny = false, failCreate = false;
  const runner = async (file, args, runOptions) => {
    calls.push({ file, args, options: runOptions });
    if (path.basename(file).toLowerCase() === 'whoami.exe') return { stdout: '"desktop\\notes-user","' + SID + '"\r\n', stderr: '', code: 0 };
    if (args[0] === '/Query') return deny ? { stdout: '', stderr: 'sensitive denied diagnostic', code: 0x80070005 } : task === null ? { stdout: '', stderr: 'not found', code: 0x80070002 } : { stdout: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(task, 'utf16le')]), stderr: '', code: 0 };
    if (args[0] === '/Create') {
      const filename = args[args.indexOf('/XML') + 1], bytes = await fs.readFile(filename), xml = decodeXML(bytes);
      xmlFiles.push({ filename, xml, bytes });
      if (failCreate) return { stdout: '', stderr: 'sensitive create diagnostic', code: 0x80070005 };
      task = xml; return { stdout: 'success', stderr: '', code: 0 };
    }
    if (args[0] === '/Delete') { task = null; return { stdout: 'success', stderr: '', code: 0 }; }
    throw new Error('Unexpected scheduler fixture operation');
  };
  const scheduler = new GitHubScheduler({ executable, dataDir, taskKey: 'daily', platform: 'win32', runner, ...options });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, executable, dataDir, scheduler, runner, calls, xmlFiles, get task() { return task; }, setTask(value) { task = value; }, setDeny(value) { deny = value; }, setFailCreate(value) { failCreate = value; } };
}

test('ensure creates only a per-user hidden portable task, with escaped XML and hourly due checks', async t => {
  const { scheduler, calls, xmlFiles, root } = await fixture(t);
  assert.deepEqual(await scheduler.ensure(), { available: true, installed: true, enabled: true, name: scheduler.name });
  const create = calls.find(call => call.args[0] === '/Create');
  assert.deepEqual(create.args.filter(arg => /^\/(?:RU|RP|RL|F)$/i.test(arg)), []);
  assert.equal(calls.every(call => call.options.windowsHide === true && call.options.shell === false && path.isAbsolute(call.file)), true);
  assert.equal(calls.every(call => call.options.timeoutMs === 15000 && call.options.input === ''), true);
  assert.match(xmlFiles[0].xml, /notes &amp; family portable\.exe/);
  assert.match(xmlFiles[0].xml, /<Arguments>--sync-only<\/Arguments>/);
  assert.match(xmlFiles[0].xml, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xmlFiles[0].xml, /<UserId>S-1-5-21-100-200-300-1001<\/UserId>/);
  assert.match(xmlFiles[0].xml, /<Hidden>true<\/Hidden>/); assert.match(xmlFiles[0].xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xmlFiles[0].xml, /<Interval>PT1H<\/Interval>/); assert.match(xmlFiles[0].xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.equal(xmlFiles[0].bytes[0], 0xff); assert.equal(xmlFiles[0].bytes[1], 0xfe);
  assert.equal(path.relative(root, xmlFiles[0].filename).startsWith('..'), true);
  assert.equal(await fs.stat(path.dirname(xmlFiles[0].filename)).then(() => true, () => false), false);
});

test('registration is idempotent, survives process restart and serializes concurrent ensure calls', async t => {
  const { scheduler, executable, dataDir, runner, calls } = await fixture(t);
  const results = await Promise.all([scheduler.ensure(), scheduler.ensure(), scheduler.ensure()]);
  assert.equal(results.every(result => result.installed), true);
  assert.equal(calls.filter(call => call.args[0] === '/Create').length, 1);
  const reopened = new GitHubScheduler({ executable, dataDir, runner, platform: 'win32' });
  assert.equal((await reopened.status()).installed, true);
  assert.equal((await reopened.ensure()).installed, true);
  assert.equal(calls.filter(call => call.args[0] === '/Create').length, 1);
});

test('task names are stable and isolated by app path, data profile and task key', async t => {
  const { scheduler, root, executable, dataDir, runner } = await fixture(t);
  assert.match(scheduler.name, /^notes-github-sync-[a-f0-9]{24}$/);
  for (const change of [{ executable: path.join(root, 'other.exe') }, { dataDir: path.join(root, 'other-data') }, { taskKey: 'other' }]) {
    const other = new GitHubScheduler({ executable, dataDir, runner, platform: 'win32', ...change });
    assert.notEqual(scheduler.name, other.name);
  }
});

test('foreign source, executable, action, user or login mode cannot be overwritten or deleted', async t => {
  const context = await fixture(t); const { scheduler, calls } = context;
  await scheduler.ensure(); const valid = context.task;
  const changes = [
    valid.replace(/notes\.github-sync\.v1:[a-f0-9-]+/, 'someone-else'),
    valid.replace(/<Command>[^<]+<\/Command>/, '<Command>C:\\foreign.exe</Command>'),
    valid.replace('--sync-only', '--different-action'), valid.replace(SID, 'S-1-5-18'),
    valid.replace('InteractiveToken', 'Password'), valid.replace('</Actions>', '<ComHandler><ClassId>foreign</ClassId></ComHandler></Actions>')
  ];
  for (const xml of changes) {
    context.setTask(xml); const before = calls.length;
    assert.equal((await scheduler.ensure()).error, 'GITHUB_SCHEDULER_OWNERSHIP');
    assert.equal((await scheduler.remove()).error, 'GITHUB_SCHEDULER_OWNERSHIP');
    assert.equal(calls.slice(before).some(call => ['/Create', '/Delete'].includes(call.args[0])), false);
    assert.equal(context.task, xml);
  }
});

test('own disabled settings can be repaired but an unsuccessful repair preserves the prior task', async t => {
  const context = await fixture(t); const { scheduler, calls, xmlFiles } = context;
  await scheduler.ensure();
  const disabled = context.task.replace('<Hidden>true</Hidden>', '<Hidden>false</Hidden>'); context.setTask(disabled);
  assert.equal((await scheduler.status()).enabled, false);
  context.setFailCreate(true);
  assert.equal((await scheduler.ensure()).error, 'GITHUB_SCHEDULER_UNAVAILABLE'); assert.equal(context.task, disabled);
  context.setFailCreate(false);
  assert.equal((await scheduler.ensure()).enabled, true);
  assert.equal(calls.filter(call => call.args[0] === '/Create').slice(1).every(call => call.args.includes('/F')), true);
  for (const item of xmlFiles) assert.equal(await fs.stat(item.filename).then(() => true, () => false), false);
});

test('remove deletes only the verified owned task and then its local ownership marker', async t => {
  const context = await fixture(t); const { scheduler, calls } = context;
  await scheduler.ensure(); assert.equal(await fs.stat(scheduler.stateFile).then(() => true), true);
  assert.equal((await scheduler.remove()).installed, false); assert.equal(context.task, null);
  assert.equal(await fs.stat(scheduler.stateFile).then(() => true, () => false), false);
  assert.equal(calls.filter(call => call.args[0] === '/Delete').length, 1);
  await scheduler.remove(); assert.equal(calls.filter(call => call.args[0] === '/Delete').length, 1);
});

test('scheduler permissions, service failure and missing portable degrade to status, never block local notes', async t => {
  const context = await fixture(t); const { scheduler, calls, executable } = context;
  context.setDeny(true);
  const denied = await scheduler.ensure();
  assert.equal(denied.installed, false); assert.equal(denied.error, 'GITHUB_SCHEDULER_UNAVAILABLE');
  assert.equal(/sensitive/.test(denied.message), false); assert.equal(calls.some(call => call.args[0] === '/Create'), false);
  context.setDeny(false); await fs.unlink(executable);
  assert.equal((await scheduler.ensure()).installed, false);
  scheduler.runner = async () => { throw new Error('sensitive system diagnostic'); };
  assert.equal((await scheduler.status()).error, 'GITHUB_SCHEDULER_UNAVAILABLE');
});

test('non-Windows and development executables register nothing and create no marker', async t => {
  const { root, dataDir, executable, runner, calls } = await fixture(t);
  for (const options of [{ platform: 'linux', executable }, { platform: 'win32', executable: path.join(root, 'electron.exe') }, { platform: 'win32', executable: path.join(root, 'win-unpacked', 'notes.exe') }]) {
    const scheduler = new GitHubScheduler({ dataDir, runner, ...options });
    assert.equal((await scheduler.ensure()).available, false); assert.equal((await scheduler.status()).available, false);
  }
  assert.equal(calls.length, 0); assert.equal(await fs.stat(dataDir).then(() => true, () => false), false);
});

test('invalid local markers, junctions or task XML entities preserve existing files and tasks', async t => {
  const context = await fixture(t); const { scheduler, calls, root } = context;
  await scheduler.ensure(); const original = context.task, state = await fs.readFile(scheduler.stateFile, 'utf8');
  context.setTask(original.replace('<Task ', '<!DOCTYPE Task [<!ENTITY x SYSTEM "file:///private">]><Task '));
  assert.equal((await scheduler.status()).error, 'GITHUB_SCHEDULER_OWNERSHIP');
  context.setTask(original); await fs.writeFile(scheduler.stateFile, 'not valid json');
  const count = calls.length; assert.equal((await scheduler.ensure()).error, 'GITHUB_SCHEDULER_STATE');
  assert.equal(calls.length, count); assert.equal(await fs.readFile(scheduler.stateFile, 'utf8'), 'not valid json');
  await fs.unlink(scheduler.stateFile); const target = path.join(root, 'preserved.json'); await fs.writeFile(target, state);
  try {
    await fs.symlink(target, scheduler.stateFile, 'file');
    assert.equal((await scheduler.remove()).error, 'GITHUB_SCHEDULER_PATH');
    assert.equal(await fs.readFile(target, 'utf8'), state);
  } catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
});
