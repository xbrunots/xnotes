'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const FORMAT = 'notes-github-scheduler';
const SOURCE = 'notes.github-sync.v1:';
const MAX_OUTPUT = 1024 * 1024;
const MISSING = new Set([0x80070002, 0x80070003]);
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function xmlEscape(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]); }
function decodeXML(value) {
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '');
  const bytes = Buffer.from(value || '');
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0)) return bytes.toString('utf16le').replace(/^\uFEFF/, '');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}
function xmlUnescape(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);
}
function singleElement(xml, name) {
  const matches = [...xml.matchAll(new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '\\s*>', 'g'))];
  return matches.length === 1 ? xmlUnescape(matches[0][1].trim()) : null;
}
function singleBlock(xml, name) {
  const matches = [...xml.matchAll(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '\\s*>', 'g'))];
  return matches.length === 1 ? matches[0][1] : null;
}
function samePath(left, right) { return typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
async function noLinks(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw failure('GITHUB_SCHEDULER_PATH', 'A configuração da sincronização em segundo plano contém um link ou uma junção.');
  }
}

class GitHubScheduler {
  /** runner(absoluteExecutable, argv, {windowsHide:true,shell:false,...}) */
  constructor({ executable, taskKey = 'daily', dataDir, runner, platform = process.platform } = {}) {
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\x00-\x1f]/.test(executable)
      || typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || /[\x00-\x1f]/.test(dataDir)
      || typeof taskKey !== 'string' || taskKey.length > 256 || /[\x00-\x1f]/.test(taskKey)) {
      throw failure('GITHUB_SCHEDULER_ARGUMENTS', 'A configuração da sincronização em segundo plano é inválida.');
    }
    this.executable = path.resolve(executable); this.dataDir = path.resolve(dataDir); this.taskKey = taskKey;
    this.platform = platform; this.runner = runner; this.pending = null; this.userSid = null;
    const hash = crypto.createHash('sha256').update(this.executable.toLowerCase() + '\0' + this.dataDir.toLowerCase() + '\0' + taskKey).digest('hex').slice(0, 24);
    this.name = 'notes-github-sync-' + hash;
    this.stateFile = path.join(this.dataDir, 'github-scheduler.json');
    const windows = process.env.SystemRoot || 'C:\\Windows';
    this.schtasks = path.join(windows, 'System32', 'schtasks.exe'); this.whoami = path.join(windows, 'System32', 'whoami.exe');
  }

  result(installed, extra = {}) { return { available: this.platform === 'win32', installed, name: this.name, ...extra }; }
  error(error) {
    const own = typeof error.code === 'string' && error.code.startsWith('GITHUB_SCHEDULER_');
    return this.result(false, { error: own ? error.code : 'GITHUB_SCHEDULER_UNAVAILABLE',
      message: own ? error.message : 'A sincronização em segundo plano está indisponível. Você pode sincronizar pelo botão do notes.' });
  }
  supportedExecutable() {
    return /\.exe$/i.test(this.executable) && !/^(?:electron|node|cmd|powershell|pwsh|wscript|cscript)\.exe$/i.test(path.basename(this.executable))
      && !this.executable.split(/[\\/]/).some(part => /^(?:win-unpacked|node_modules|app\.asar)$/i.test(part));
  }

  async state(create = false) {
    await noLinks(this.stateFile);
    let bytes;
    try {
      const stat = await fs.lstat(this.stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw failure('GITHUB_SCHEDULER_STATE', 'O registro da sincronização em segundo plano não pôde ser validado.');
      bytes = await fs.readFile(this.stateFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      await noLinks(this.dataDir); await fs.mkdir(this.dataDir, { recursive: true });
      const value = { format: FORMAT, version: 1, owner: crypto.randomUUID(), name: this.name,
        executable: this.executable, dataDir: this.dataDir, taskKey: this.taskKey };
      try { await fs.writeFile(this.stateFile, JSON.stringify(value, null, 2), { flag: 'wx' }); return value; }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; return this.state(false); }
    }
    let value;
    try { value = JSON.parse(bytes); } catch { throw failure('GITHUB_SCHEDULER_STATE', 'O registro da sincronização em segundo plano está ilegível e foi preservado.'); }
    if (value.format !== FORMAT || value.version !== 1 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.owner)
      || value.name !== this.name || !samePath(value.executable, this.executable) || !samePath(value.dataDir, this.dataDir) || value.taskKey !== this.taskKey) {
      throw failure('GITHUB_SCHEDULER_STATE', 'O registro da sincronização em segundo plano pertence a outra instalação e foi preservado.');
    }
    return value;
  }

  async sid() {
    if (this.userSid) return this.userSid;
    const output = await this.run(this.whoami, ['/user', '/fo', 'csv', '/nh']);
    const matches = decodeXML(output.stdout).match(/\bS-1-\d+(?:-\d+){1,15}\b/g);
    if (output.code !== 0 || matches?.length !== 1) throw failure('GITHUB_SCHEDULER_USER', 'Não foi possível identificar a sessão Windows para a sincronização em segundo plano.');
    this.userSid = matches[0]; return this.userSid;
  }

  async query() {
    const result = await this.run(this.schtasks, ['/Query', '/TN', this.name, '/XML', '/HRESULT']);
    if (result.code === 0) return { exists: true, xml: decodeXML(result.stdout) };
    if (MISSING.has(result.code >>> 0)) return { exists: false };
    throw failure('GITHUB_SCHEDULER_UNAVAILABLE', 'O Windows não permitiu consultar a sincronização em segundo plano. O notes continuará salvando normalmente.');
  }

  owned(xml, state, userSid) {
    if (typeof xml !== 'string' || xml.length > MAX_OUTPUT || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) return false;
    const clean = xml.replace(/<!--[\s\S]*?-->/g, '');
    const registration = singleBlock(clean, 'RegistrationInfo'), actions = singleBlock(clean, 'Actions'), principal = singleBlock(clean, 'Principals');
    if (!registration || !actions || !principal || (actions.match(/<Exec(?:\s|>)/g) || []).length !== 1 || /<(?:ComHandler|SendEmail|ShowMessage)\b/.test(actions)) return false;
    return singleElement(registration, 'Source') === SOURCE + state.owner
      && samePath(singleElement(actions, 'Command'), this.executable)
      && singleElement(actions, 'Arguments') === '--sync-only'
      && samePath(singleElement(actions, 'WorkingDirectory'), path.dirname(this.executable))
      && singleElement(principal, 'UserId') === userSid
      && singleElement(principal, 'LogonType') === 'InteractiveToken'
      && singleElement(principal, 'RunLevel') === 'LeastPrivilege';
  }

  compliant(xml) {
    const clean = xml.replace(/<!--[\s\S]*?-->/g, ''); const settings = singleBlock(clean, 'Settings'), triggers = singleBlock(clean, 'Triggers');
    return Boolean(settings && triggers && singleElement(settings, 'Hidden') === 'true'
      && singleElement(settings, 'Enabled') === 'true' && singleElement(settings, 'StartWhenAvailable') === 'true'
      && singleElement(settings, 'MultipleInstancesPolicy') === 'IgnoreNew'
      && singleElement(triggers, 'Interval') === 'PT1H');
  }

  xml(state, userSid, now = new Date()) {
    const start = new Date(now.getTime() + 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-16"?>\r\n'
      + '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n'
      + '  <RegistrationInfo><Source>' + xmlEscape(SOURCE + state.owner) + '</Source><Author>notes</Author><Description>notes: verifica a sincronização diária do GitHub em segundo plano.</Description></RegistrationInfo>\r\n'
      + '  <Triggers><TimeTrigger><Enabled>true</Enabled><StartBoundary>' + start + '</StartBoundary><Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers>\r\n'
      + '  <Principals><Principal id="notes-user"><UserId>' + xmlEscape(userSid) + '</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\r\n'
      + '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT20M</ExecutionTimeLimit></Settings>\r\n'
      + '  <Actions Context="notes-user"><Exec><Command>' + xmlEscape(this.executable) + '</Command><Arguments>--sync-only</Arguments><WorkingDirectory>' + xmlEscape(path.dirname(this.executable)) + '</WorkingDirectory></Exec></Actions>\r\n'
      + '</Task>\r\n';
  }

  async status() {
    if (this.platform !== 'win32') return this.result(false);
    if (!this.supportedExecutable()) return this.result(false, { available: false, error: 'GITHUB_SCHEDULER_PORTABLE', message: 'A sincronização em segundo plano está disponível no portable.' });
    try {
      const state = await this.state(false); if (!state) return this.result(false);
      const [userSid, task] = await Promise.all([this.sid(), this.query()]);
      if (!task.exists) return this.result(false);
      if (!this.owned(task.xml, state, userSid)) throw failure('GITHUB_SCHEDULER_OWNERSHIP', 'A tarefa existente não pertence a esta instalação. Ela foi preservada.');
      return this.result(true, { enabled: this.compliant(task.xml) });
    } catch (error) { return this.error(error); }
  }

  async ensure() {
    if (this.pending) return this.pending;
    this.pending = this.ensureTask();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async ensureTask() {
    if (this.platform !== 'win32') return this.result(false);
    if (!this.supportedExecutable()) return this.result(false, { available: false, error: 'GITHUB_SCHEDULER_PORTABLE', message: 'A sincronização em segundo plano está disponível no portable.' });
    try {
      await noLinks(this.executable); const executableStat = await fs.lstat(this.executable);
      if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw failure('GITHUB_SCHEDULER_PORTABLE', 'O portable não está disponível para a sincronização em segundo plano.');
      const state = await this.state(true), userSid = await this.sid(), previous = await this.query();
      if (previous.exists && !this.owned(previous.xml, state, userSid)) throw failure('GITHUB_SCHEDULER_OWNERSHIP', 'A tarefa existente não pertence a esta instalação. Ela foi preservada.');
      if (previous.exists && this.compliant(previous.xml)) return this.result(true, { enabled: true });
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-scheduler-'));
      try {
        const filename = path.join(temporary, 'task.xml');
        await fs.writeFile(filename, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(this.xml(state, userSid), 'utf16le')]), { flag: 'wx' });
        const args = ['/Create', '/TN', this.name, '/XML', filename, '/HRESULT'];
        if (previous.exists) args.push('/F'); // A matching owner, command, arguments and user were checked first.
        const created = await this.run(this.schtasks, args);
        if (created.code !== 0) throw failure('GITHUB_SCHEDULER_UNAVAILABLE', 'O Windows não permitiu ativar a sincronização em segundo plano. Você pode sincronizar pelo botão do notes.');
        const registered = await this.query();
        if (!registered.exists || !this.owned(registered.xml, state, userSid) || !this.compliant(registered.xml)) {
          // Never delete or replace an unverified task, even after registration.
          throw failure('GITHUB_SCHEDULER_VERIFY', 'A tarefa do Windows não pôde ser confirmada. As notas continuam disponíveis.');
        }
        return this.result(true, { enabled: true });
      } finally {
        const resolved = path.resolve(temporary), relative = path.relative(path.resolve(os.tmpdir()), resolved);
        if (relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && path.basename(resolved).startsWith('notes-scheduler-')) await fs.rm(resolved, { recursive: true, force: true });
      }
    } catch (error) { return this.error(error); }
  }

  async remove() {
    if (this.platform !== 'win32') return this.result(false);
    if (this.pending) await this.pending;
    try {
      const state = await this.state(false); if (!state) return this.result(false);
      const userSid = await this.sid(), task = await this.query();
      if (!task.exists) { await fs.unlink(this.stateFile); return this.result(false); }
      if (!this.owned(task.xml, state, userSid)) throw failure('GITHUB_SCHEDULER_OWNERSHIP', 'A tarefa existente não pertence a esta instalação. Ela foi preservada.');
      const removed = await this.run(this.schtasks, ['/Delete', '/TN', this.name, '/F', '/HRESULT']);
      if (removed.code !== 0) throw failure('GITHUB_SCHEDULER_UNAVAILABLE', 'O Windows não permitiu desativar a sincronização em segundo plano.');
      const remaining = await this.query();
      if (remaining.exists) throw failure('GITHUB_SCHEDULER_VERIFY', 'O Windows não confirmou a remoção da tarefa.');
      await fs.unlink(this.stateFile); return this.result(false);
    } catch (error) { return this.error(error); }
  }

  async run(executable, args) {
    const options = { windowsHide: true, shell: false, timeoutMs: 15000, outputLimit: MAX_OUTPUT, input: '', binary: true };
    let result;
    try { result = this.runner ? await this.runner(executable, [...args], options) : await runProcess(executable, args, options); }
    catch { throw failure('GITHUB_SCHEDULER_UNAVAILABLE', 'O agendador do Windows está indisponível. Você pode sincronizar pelo botão do notes.'); }
    if (!result || !Number.isInteger(result.code) || Buffer.byteLength(result.stdout || '') + Buffer.byteLength(result.stderr || '') > MAX_OUTPUT) {
      throw failure('GITHUB_SCHEDULER_UNAVAILABLE', 'O agendador do Windows retornou uma resposta inválida.');
    }
    return result;
  }
}

function runProcess(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let size = 0, stopped = false, done = false;
    const stop = () => { stopped = true; child.kill(); };
    const timer = setTimeout(stop, options.timeoutMs); timer.unref?.();
    const receive = target => chunk => { size += chunk.length; if (size > options.outputLimit) stop(); else target.push(chunk); };
    child.stdout.on('data', receive(stdout)); child.stderr.on('data', receive(stderr)); child.stdin.on('error', () => {}); child.stdin.end();
    const finish = (error, code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error || stopped) reject(error || new Error('scheduler timeout')); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
    };
    child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
  });
}

module.exports = { GitHubScheduler, xmlEscape, decodeXML };
