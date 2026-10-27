'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

// Pinned official, immutable releases, checked against their published GitHub
// release-asset SHA-256 digests on 2026-10-27. Only portable archives are used.
const RELEASES = Object.freeze({
  gh: Object.freeze({ version: '2.103.3', size: 15197187,
    url: 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.zip',
    sha256: '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0', executable: 'bin/gh.exe' }),
  git: Object.freeze({ version: '2.56.0.4', size: 39846926,
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip',
    sha256: 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877', executable: 'cmd/git.exe' })
});
const LIMITS = Object.freeze({ downloadBytes: 128 * 1024 * 1024, extractedBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024, entries: 20000, outputBytes: 101 * 1024 * 1024, inputBytes: 101 * 1024 * 1024 });
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const USER_QUERY = '{login: .login, id: .id}';
const ACCOUNT_QUERY = '.hosts["github.com"][] | select(.active) | {state,tokenSource}';

function toolError(code, message, exitCode) {
  const error = new Error(message); error.code = code;
  if (Number.isInteger(exitCode)) error.exitCode = exitCode;
  return error;
}
function sanitize(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[credencial removida]')
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s"']+/ig, '$1[credencial removida]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/ig, '$1[credencial removida]@');
}
function checkedArguments(args) {
  if (!Array.isArray(args) || args.length > 4096 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 32768)) {
    throw toolError('GITHUB_ARGUMENTS', 'Argumentos inválidos para a sincronização.');
  }
  return [...args];
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function rejectLinks(target) {
  const absolute = path.resolve(target); const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw toolError('GITHUB_UNSAFE_PATH', 'A pasta de ferramentas contém um link ou uma junção.');
  }
}
function posixQuote(absolute) { return "'" + absolute.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'"; }
function isExecutableStat(stat) { return stat?.isFile() && !stat.isSymbolicLink(); }

/**
 * Runner injection follows (absoluteExecutable, argv, options) =>
 * Promise<{stdout, stderr, code}>. options include input, signal, onStdout and
 * onStderr. Only the normal runner spawns processes; fixtures never install.
 */
class GitHubTools {
  constructor({ toolsDir, onProgress = () => {}, runner, fetch: fetchImpl = globalThis.fetch,
    env = process.env, platform = process.platform, releases = RELEASES, trustedFileProtocol = false } = {}) {
    if (typeof toolsDir !== 'string' || !path.isAbsolute(toolsDir)) throw toolError('GITHUB_TOOLS_DIRECTORY', 'A pasta de ferramentas precisa ser absoluta.');
    this.toolsDir = path.resolve(toolsDir); this.onProgress = onProgress; this.runner = runner;
    this.fetchImpl = fetchImpl; this.env = { ...env }; this.platform = platform; this.releases = releases;
    this.trustedFileProtocol = trustedFileProtocol; this.paths = {}; this.children = new Set();
    this.controllers = new Set(); this.closed = false; this.installing = null; this.loggingIn = null; this.generation = 0;
    this.emptyConfig = path.join(this.toolsDir, 'empty-git-config'); this.noHooks = path.join(this.toolsDir, 'empty-hooks');
  }

  progress(value) { this.onProgress({ ...value, message: sanitize(value.message) }); }
  assertOpen() { if (this.closed) throw toolError('GITHUB_CANCELLED', 'A operação foi cancelada.'); }
  assertCurrent(generation) {
    this.assertOpen();
    if (generation !== this.generation) throw toolError('GITHUB_CANCELLED', 'A operação foi cancelada.');
  }

  async detect(kind) {
    const generation = this.generation; this.assertCurrent(generation);
    const executable = kind + (this.platform === 'win32' ? '.exe' : '');
    const candidates = [this.paths[kind], path.join(this.toolsDir, kind, kind === 'git' ? 'cmd' : 'bin', executable),
      path.join(this.toolsDir, kind, 'bin', executable)];
    if (this.platform === 'win32') {
      const programRoots = [this.env.ProgramW6432, this.env.ProgramFiles, this.env['ProgramFiles(x86)']].filter(Boolean);
      for (const root of programRoots) candidates.push(path.join(root, kind === 'git' ? 'Git' : 'GitHub CLI', kind === 'git' ? 'cmd' : '', executable));
      if (this.env.LOCALAPPDATA) candidates.push(path.join(this.env.LOCALAPPDATA, 'Programs', kind === 'git' ? 'Git' : 'GitHub CLI', kind === 'git' ? 'cmd' : '', executable));
    }
    for (let directory of String(this.env.PATH || this.env.Path || '').split(this.platform === 'win32' ? ';' : ':')) {
      directory = directory.replace(/^"|"$/g, '');
      if (path.isAbsolute(directory)) candidates.push(path.join(directory, executable));
    }
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      if (!path.isAbsolute(candidate)) continue;
      const stat = await fs.lstat(candidate).catch(() => null);
      this.assertCurrent(generation);
      if (!isExecutableStat(stat)) continue;
      if (inside(this.toolsDir, candidate)) await rejectLinks(candidate);
      this.assertCurrent(generation);
      let result;
      try { result = await this.execute(candidate, ['--version'], { timeoutMs: 10000, allowFailure: true, outputLimit: 65536 }); }
      catch (error) { this.assertCurrent(generation); if (error.code === 'GITHUB_CANCELLED') throw error; continue; }
      this.assertCurrent(generation);
      const version = new RegExp(kind === 'git' ? '^git version ([0-9][^\\r\\n ]*)' : '^gh version ([0-9][^\\r\\n ]*)').exec(result.stdout.trim())?.[1];
      if (result.code === 0 && version) { this.paths[kind] = candidate; return { installed: true, path: candidate, version }; }
    }
    this.assertCurrent(generation); delete this.paths[kind]; return { installed: false, path: null, version: null };
  }

  async inspect() {
    const generation = this.generation; this.assertCurrent(generation);
    const [git, gh] = await Promise.all([this.detect('git'), this.detect('gh')]);
    this.assertCurrent(generation);
    const account = gh.installed ? await this.account() : { loggedIn: false };
    this.assertCurrent(generation);
    return { git, gh, account };
  }

  async account() {
    const generation = this.generation; this.assertCurrent(generation);
    const state = await this.gh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts', '--jq', ACCOUNT_QUERY], { allowFailure: true, timeoutMs: 30000 });
    this.assertCurrent(generation);
    if (state.code !== 0 || !state.stdout.trim()) return { loggedIn: false };
    let status;
    try { status = JSON.parse(state.stdout); } catch { return { loggedIn: false }; }
    if (status.state !== 'success') return { loggedIn: false };
    if (!['keyring', 'keychain'].includes(status.tokenSource)) return { loggedIn: false, secureStorageUnavailable: true };
    const user = await this.gh(['api', 'user', '--hostname', 'github.com', '--jq', USER_QUERY], { allowFailure: true, timeoutMs: 30000 });
    this.assertCurrent(generation);
    if (user.code !== 0) return { loggedIn: false };
    let account;
    try { account = JSON.parse(user.stdout); } catch { return { loggedIn: false }; }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account.login) || !Number.isSafeInteger(account.id) || account.id <= 0) return { loggedIn: false };
    return { loggedIn: true, login: account.login, id: account.id };
  }

  async prepareDirectories(generation = this.generation) {
    this.assertCurrent(generation);
    await rejectLinks(this.toolsDir);
    this.assertCurrent(generation);
    await fs.mkdir(this.toolsDir, { recursive: true });
    await rejectLinks(this.noHooks); await fs.mkdir(this.noHooks, { recursive: true });
    if ((await fs.readdir(this.noHooks)).length) throw toolError('GITHUB_UNSAFE_PATH', 'A pasta reservada para desativar hooks não está vazia.');
    await rejectLinks(this.emptyConfig);
    const stat = await fs.lstat(this.emptyConfig).catch(() => null);
    this.assertCurrent(generation);
    if (stat && (!isExecutableStat(stat) || stat.size !== 0)) throw toolError('GITHUB_UNSAFE_PATH', 'A configuração isolada do Git foi alterada.');
    try { await fs.writeFile(this.emptyConfig, '', { flag: stat ? 'r+' : 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.lstat(this.emptyConfig);
      if (!isExecutableStat(existing) || existing.size !== 0) throw toolError('GITHUB_UNSAFE_PATH', 'A configuração isolada do Git foi alterada.');
    }
    this.assertCurrent(generation);
  }

  async ensureInstalled() {
    if (this.installing) return this.installing;
    const generation = this.generation;
    const operation = (async () => {
      this.assertCurrent(generation); await this.prepareDirectories(generation);
      for (const kind of ['git', 'gh']) {
        const detected = await this.detect(kind); this.assertCurrent(generation);
        if (detected.installed) continue;
        if (this.platform !== 'win32') throw toolError('GITHUB_PLATFORM', 'A instalação automática das ferramentas está disponível no Windows.');
        await this.install(kind);
        this.assertCurrent(generation);
      }
      const state = await this.inspect();
      this.assertCurrent(generation);
      this.progress({ step: 'tools-ready', message: 'Git e GitHub prontos.' }); this.assertCurrent(generation); return state;
    })();
    this.installing = operation;
    try { return await operation; } finally { if (this.installing === operation) this.installing = null; }
  }

  async install(kind) {
    const generation = this.generation; this.assertCurrent(generation); const release = this.releases[kind];
    if (!release || !/^https:\/\/github\.com\/(?:cli\/cli|git-for-windows\/git)\/releases\/download\/[^?#]+\.zip$/.test(release.url)
      || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > LIMITS.downloadBytes) {
      throw toolError('GITHUB_RELEASE', 'A versão oficial da ferramenta não pôde ser verificada.');
    }
    const stage = await fs.mkdtemp(path.join(this.toolsDir, '.' + kind + '-'));
    const archive = path.join(stage, 'download.zip'); const unpacked = path.join(stage, 'unpacked');
    try {
      this.assertCurrent(generation);
      this.progress({ step: 'install-' + kind, message: kind === 'git' ? 'Baixando Git oficial…' : 'Baixando GitHub oficial…' });
      await this.download(release, archive);
      this.assertCurrent(generation);
      await fs.mkdir(unpacked); await extractArchive(archive, unpacked);
      this.assertCurrent(generation);
      const expected = path.resolve(unpacked, ...release.executable.split('/'));
      if (!inside(unpacked, expected) || !isExecutableStat(await fs.lstat(expected).catch(() => null))) throw toolError('GITHUB_ARCHIVE', 'A ferramenta oficial está incompleta.');
      const version = await this.execute(expected, ['--version'], { timeoutMs: 15000, allowFailure: true, outputLimit: 65536 });
      this.assertCurrent(generation);
      if (version.code !== 0 || !(kind === 'git' ? /^git version \d/ : /^gh version \d/).test(version.stdout)) throw toolError('GITHUB_INSTALL', 'A ferramenta baixada não iniciou corretamente.');
      const destination = path.join(this.toolsDir, kind); await rejectLinks(destination);
      if (await fs.lstat(destination).catch(() => null)) throw toolError('GITHUB_INSTALL_DIRECTORY', 'A pasta da ferramenta existente precisa ser preservada. Libere a pasta antes de tentar novamente.');
      this.assertCurrent(generation);
      await fs.rename(unpacked, destination); this.assertCurrent(generation); this.paths[kind] = path.join(destination, ...release.executable.split('/'));
      this.progress({ step: 'installed-' + kind, message: kind === 'git' ? 'Git instalado.' : 'GitHub instalado.' });
      this.assertCurrent(generation);
    } finally {
      const absolute = path.resolve(stage);
      if (inside(this.toolsDir, absolute) && path.basename(absolute).startsWith('.' + kind + '-')) await fs.rm(absolute, { recursive: true, force: true });
    }
  }

  async download(release, destination) {
    const generation = this.generation; this.assertCurrent(generation);
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 180000); timeout.unref?.();
    try {
      let url = release.url, response;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.username || target.password || target.port || !DOWNLOAD_HOSTS.has(target.hostname)) throw toolError('GITHUB_DOWNLOAD_URL', 'O download não veio de uma origem oficial.');
        response = await this.fetchImpl(target.href, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'notes', Accept: 'application/octet-stream' } });
        this.assertCurrent(generation);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); if (!location || redirects === 5) throw toolError('GITHUB_DOWNLOAD_URL', 'O download oficial redirecionou de forma inválida.');
          await response.body?.cancel?.().catch(() => {}); url = new URL(location, target).href; continue;
        }
        break;
      }
      if (!response?.ok) throw toolError('GITHUB_DOWNLOAD', 'Não foi possível baixar a ferramenta oficial. Verifique a conexão e tente novamente.');
      const length = Number(response.headers.get('content-length'));
      if (length && length !== release.size) throw toolError('GITHUB_INTEGRITY', 'O tamanho da ferramenta oficial não confere.');
      const handle = await fs.open(destination, 'wx'); const hash = crypto.createHash('sha256'); let bytes = 0;
      try {
        if (!response.body || !response.body[Symbol.asyncIterator]) throw toolError('GITHUB_DOWNLOAD', 'O download oficial retornou conteúdo inválido.');
        for await (const value of response.body) {
          this.assertCurrent(generation); const chunk = Buffer.from(value); bytes += chunk.length;
          if (bytes > release.size || bytes > LIMITS.downloadBytes) throw toolError('GITHUB_INTEGRITY', 'O tamanho da ferramenta oficial excedeu o limite.');
          hash.update(chunk); await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      this.assertCurrent(generation);
      if (bytes !== release.size || hash.digest('hex') !== release.sha256) throw toolError('GITHUB_INTEGRITY', 'A ferramenta falhou na verificação SHA-256. Nenhum programa foi instalado.');
    } catch (error) {
      if (this.closed || generation !== this.generation || controller.signal.aborted) throw toolError('GITHUB_CANCELLED', 'O download foi cancelado ou excedeu o tempo de espera.');
      if (error.code?.startsWith('GITHUB_')) throw error;
      throw toolError('GITHUB_DOWNLOAD', 'Não foi possível baixar a ferramenta oficial. Verifique a conexão e tente novamente.');
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }

  async login() {
    if (this.loggingIn) return this.loggingIn;
    const generation = this.generation;
    const operation = (async () => {
      const initial = await this.ensureInstalled(); this.assertCurrent(generation); if (initial.account.loggedIn) return initial.account;
      this.progress({ step: 'login', message: 'Entre na sua conta GitHub pelo navegador.' });
      let output = '', deviceCode, verificationUri, insecure = false;
      const receive = chunk => {
        if (this.closed || generation !== this.generation) return;
        output = (output + String(chunk)).slice(-32768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        insecure ||= /credentials saved in plain text/i.test(output);
        const code = /(?:one-time code(?:\s*\(|\s*:)\s*)([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(output)?.[1]?.toUpperCase();
        const uri = /https:\/\/github\.com\/login\/device\b/.test(output) ? 'https://github.com/login/device' : null;
        if (code && (code !== deviceCode || (uri && !verificationUri))) {
          deviceCode = code; verificationUri = uri || verificationUri;
          this.progress({ step: 'login', message: 'Autorize o notes no GitHub.', deviceCode, verificationUri: verificationUri || 'https://github.com/login/device' });
        }
      };
      await this.gh(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
        { timeoutMs: 15 * 60 * 1000, onStdout: receive, onStderr: receive, input: '', outputLimit: 1024 * 1024 });
      this.assertCurrent(generation);
      const account = await this.account();
      this.assertCurrent(generation);
      if (insecure || account.secureStorageUnavailable) throw toolError('GITHUB_SECURE_STORAGE', 'O GitHub não conseguiu proteger o login no cofre do Windows. Ative o Gerenciador de Credenciais e conecte novamente.');
      if (!account.loggedIn) throw toolError('GITHUB_LOGIN', 'O login não foi confirmado. Conecte novamente ao GitHub.');
      this.progress({ step: 'logged-in', message: 'Conta GitHub conectada.' }); this.assertCurrent(generation); return account;
    })();
    this.loggingIn = operation;
    try { return await operation; } finally { if (this.loggingIn === operation) this.loggingIn = null; }
  }

  environment(extra = {}) {
    const env = { ...this.env };
    for (const key of Object.keys(env)) {
      if (/^(?:GIT_|GH_|GITHUB_|BROWSER$|SSH_ASKPASS|DISPLAY$|GCM_|NODE_OPTIONS$)/i.test(key)) delete env[key];
    }
    // Only commit identity/date and locale may be supplied per operation.
    for (const [key, value] of Object.entries(extra || {})) {
      if (!/^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|LC_ALL|LANG)$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw toolError('GITHUB_ENVIRONMENT', 'Ambiente inválido para a sincronização.');
      env[key] = value;
    }
    const additions = [this.paths.git && path.dirname(this.paths.git), this.paths.gh && path.dirname(this.paths.gh)].filter(Boolean);
    const separator = this.platform === 'win32' ? ';' : ':';
    const original = String(env.PATH || env.Path || '').split(separator).filter(part => path.isAbsolute(part.replace(/^"|"$/g, '')));
    delete env.Path; env.PATH = [...additions, ...original].join(separator);
    return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.emptyConfig, GIT_CONFIG_SYSTEM: this.emptyConfig,
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_PAGER: '', PAGER: '', GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_TELEMETRY: 'false', GH_HOST: 'github.com', NO_COLOR: '1', TERM: 'dumb', LC_ALL: 'C' };
  }

  async git(args, options = {}) {
    const generation = this.generation;
    checkedArguments(args); this.assertCurrent(generation); await this.prepareDirectories(generation);
    if (!this.paths.git && !(await this.detect('git')).installed) throw toolError('GITHUB_MISSING_GIT', 'O Git ainda não está instalado. Inicie a conexão com o GitHub.');
    this.assertCurrent(generation);
    if (!this.paths.gh) await this.detect('gh');
    this.assertCurrent(generation);
    const safe = ['-c', 'core.hooksPath=' + this.noHooks.replace(/\\/g, '/'), '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=' + this.emptyConfig.replace(/\\/g, '/'), '-c', 'credential.helper=', '-c', 'credential.interactive=false',
      '-c', 'core.askPass=', '-c', 'core.pager=', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'diff.external=',
      '-c', 'diff.trustExitCode=false', '-c', 'merge.autoStash=false', '-c', 'submodule.recurse=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ext.allow=never',
      '-c', 'protocol.file.allow=' + (this.trustedFileProtocol ? 'always' : 'never')];
    if (this.paths.gh) safe.push('-c', 'credential.https://github.com.helper=!' + posixQuote(this.paths.gh) + ' auth git-credential');
    if (options.cwd) await this.checkLocalConfig(options.cwd, safe, options.signal);
    this.assertCurrent(generation);
    return this.execute(this.paths.git, [...safe, ...args], options);
  }

  async checkLocalConfig(cwd, safe, signal) {
    const generation = this.generation;
    const config = await this.execute(this.paths.git, [...safe, 'config', '--local', '--no-includes', '--null', '--list'], { cwd, signal, allowFailure: true, outputLimit: 1024 * 1024 });
    this.assertCurrent(generation);
    if (config.code !== 0) return; // git init / clone destination is not a repository yet.
    for (const record of config.stdout.split('\0').filter(Boolean)) {
      const key = record.split('\n', 1)[0].toLowerCase();
      if (/^(?:include\.|includeif\.|filter\.|mergetool\.|difftool\.|credential\.)/.test(key)
        || /^diff\..*\.(?:command|textconv)$/.test(key) || /^merge\..*\.driver$/.test(key)
        || /^(?:core\.(?:sshcommand|fsmonitor)|remote\..*\.(?:vcs|uploadpack|receivepack)|core\.gitproxy)$/.test(key)) {
        throw toolError('GITHUB_UNSAFE_CONFIG', 'A pasta de sincronização contém uma configuração externa não permitida. Nenhum comando externo foi executado.');
      }
    }
  }

  async gh(args, options = {}) {
    const generation = this.generation;
    checkedArguments(args); this.assertCurrent(generation);
    if (!this.paths.gh && !(await this.detect('gh')).installed) throw toolError('GITHUB_MISSING_CLI', 'O GitHub ainda não está instalado. Inicie a conexão com o GitHub.');
    this.assertCurrent(generation);
    return this.execute(this.paths.gh, args, options);
  }

  async execute(executable, args, options = {}) {
    const generation = this.generation;
    this.assertCurrent(generation); checkedArguments(args);
    if (!path.isAbsolute(executable)) throw toolError('GITHUB_EXECUTABLE', 'O caminho da ferramenta precisa ser absoluto.');
    const { cwd, allowFailure = false, signal, input, binary = false, onStdout, onStderr,
      timeoutMs = 120000, outputLimit = LIMITS.outputBytes, env: extraEnv } = options;
    if (cwd && !path.isAbsolute(cwd)) throw toolError('GITHUB_DIRECTORY', 'A pasta de sincronização precisa ser absoluta.');
    if (input !== undefined && !(typeof input === 'string' || Buffer.isBuffer(input))) throw toolError('GITHUB_ARGUMENTS', 'Entrada inválida para a sincronização.');
    if (Buffer.byteLength(input || '') > LIMITS.inputBytes) throw toolError('GITHUB_ARGUMENTS', 'A entrada de sincronização excedeu o limite.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60 * 1000) throw toolError('GITHUB_ARGUMENTS', 'Tempo de espera inválido.');
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw toolError('GITHUB_ARGUMENTS', 'Limite de resposta inválido.');
    const outputBound = Math.min(LIMITS.outputBytes, Math.max(1, outputLimit));
    const env = this.environment(extraEnv), controller = new AbortController();
    const abort = () => controller.abort();
    this.controllers.add(controller);
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
    const progress = callback => callback ? chunk => { if (!this.closed && generation === this.generation && !controller.signal.aborted) callback(chunk); } : undefined;
    const runOptions = { cwd, env, input, signal: controller.signal, timeoutMs, outputLimit: outputBound,
      binary, onStdout: progress(onStdout), onStderr: progress(onStderr), windowsHide: true, shell: false };
    let result;
    try {
      if (controller.signal.aborted) throw toolError('GITHUB_CANCELLED', 'A operação foi cancelada.');
      result = this.runner ? await this.runner(executable, [...args], runOptions) : await this.spawn(executable, args, runOptions);
      this.assertCurrent(generation);
      if (controller.signal.aborted) throw toolError('GITHUB_CANCELLED', 'A operação foi cancelada.');
    }
    catch (error) {
      if (this.closed || generation !== this.generation || controller.signal.aborted) throw toolError('GITHUB_CANCELLED', 'A operação foi cancelada.');
      if (error.code?.startsWith('GITHUB_')) throw error;
      throw toolError('GITHUB_PROCESS', 'Não foi possível executar a ferramenta de sincronização.');
    } finally {
      signal?.removeEventListener('abort', abort); this.controllers.delete(controller);
    }
    const stdoutBuffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
    const stderrBuffer = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
    if (stdoutBuffer.length + stderrBuffer.length > outputBound) throw toolError('GITHUB_OUTPUT_LIMIT', 'A resposta da sincronização excedeu o limite.');
    const value = { stdout: binary ? stdoutBuffer : sanitize(stdoutBuffer.toString('utf8')), stderr: sanitize(stderrBuffer.toString('utf8')), code: Number.isInteger(result.code) ? result.code : 1 };
    if (value.code !== 0 && !allowFailure) throw toolError('GITHUB_COMMAND_FAILED', 'A operação do GitHub não foi concluída. Verifique a conexão ou conecte sua conta novamente.', value.code);
    return value;
  }

  spawn(executable, args, options) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(toolError('GITHUB_CANCELLED', 'A operação foi cancelada.')); return; }
      const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child); const stdout = [], stderr = []; let bytes = 0, failure, settled = false;
      const stop = error => { failure ||= error; child.kill(); };
      const abort = () => stop(toolError('GITHUB_CANCELLED', 'A operação foi cancelada.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop(toolError('GITHUB_TIMEOUT', 'A sincronização excedeu o tempo de espera. Tente novamente.')), options.timeoutMs); timer.unref?.();
      const receive = (target, callback) => chunk => {
        bytes += chunk.length;
        if (bytes > options.outputLimit) { stop(toolError('GITHUB_OUTPUT_LIMIT', 'A resposta da sincronização excedeu o limite.')); return; }
        target.push(chunk); if (callback) { try { callback(chunk.toString('utf8')); } catch { stop(toolError('GITHUB_PROGRESS', 'A conexão foi interrompida.')); } }
      };
      child.stdout.on('data', receive(stdout, options.onStdout)); child.stderr.on('data', receive(stderr, options.onStderr));
      child.stdin.on('error', () => {}); child.stdin.end(options.input);
      const finish = (error, code) => {
        if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.children.delete(child);
        if (this.closed) failure ||= toolError('GITHUB_CANCELLED', 'A operação foi cancelada.');
        if (failure || error) reject(failure || error); else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
      };
      child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
    });
  }

  cancel() {
    this.generation++;
    // A new onboarding may begin while cancelled processes finish closing.
    // Their own guards/finally blocks cannot clear the new operation's handle.
    this.installing = null; this.loggingIn = null;
    const controllers = [...this.controllers], children = [...this.children];
    for (const controller of controllers) controller.abort();
    for (const child of children) child.kill();
  }

  close() { this.cancel(); this.closed = true; }
}

async function extractArchive(filename, directory) {
  await rejectLinks(directory); const root = path.resolve(directory); const seen = new Set(); let count = 0, bytes = 0, zip;
  try {
    zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
    await new Promise((resolve, reject) => {
      const fail = () => { zip.close(); reject(toolError('GITHUB_ARCHIVE', 'O arquivo oficial contém uma entrada inválida ou excede os limites.')); };
      zip.once('error', fail); zip.once('end', resolve);
      zip.on('entry', entry => { (async () => {
        const name = entry.fileName;
        if (++count > LIMITS.entries || !name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || /[:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
          || entry.uncompressedSize > LIMITS.fileBytes || (bytes += entry.uncompressedSize) > LIMITS.extractedBytes) throw new Error('archive');
        const target = path.resolve(root, ...name.split('/')); const key = target.toLowerCase();
        if (!inside(root, target) || seen.has(key)) throw new Error('archive'); seen.add(key);
        await rejectLinks(target);
        if (name.endsWith('/')) { await fs.mkdir(target, { recursive: true }); zip.readEntry(); return; }
        await fs.mkdir(path.dirname(target), { recursive: true }); let actual = 0;
        const stream = await new Promise((accept, decline) => zip.openReadStream(entry, (error, value) => error ? decline(error) : accept(value)));
        await pipeline(stream, new Transform({ transform(chunk, encoding, callback) {
          actual += chunk.length; callback(actual > entry.uncompressedSize ? new Error('archive') : null, chunk);
        } }), nativeFs.createWriteStream(target, { flags: 'wx' }));
        if (actual !== entry.uncompressedSize) throw new Error('archive'); zip.readEntry();
      })().catch(fail); });
      zip.readEntry();
    });
  } catch (error) {
    if (error.code?.startsWith('GITHUB_')) throw error;
    throw toolError('GITHUB_ARCHIVE', 'O arquivo oficial está corrompido ou contém uma entrada inválida.');
  } finally { zip?.close(); }
}

module.exports = { GitHubTools, RELEASES, LIMITS, extractArchive, sanitize };
