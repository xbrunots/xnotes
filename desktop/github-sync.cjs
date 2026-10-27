'use strict';

/* Daily/manual GitHub synchronization. All network, authentication and Git
 * commands stay in the main process. Saves export only immutable local files;
 * they never fetch, commit or push. A normal push is the sole acknowledgement
 * of success. No force push, hard reset, clean, external merge tool or hook is
 * used. Recovery snapshots and conflict sessions are device-local, outside the
 * repository. The GitHub CLI owns authentication in the Windows credential
 * vault; status and the repository never contain its tokens.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { atomicWrite, readJSON } = require('./storage.cjs');
const { heads, planRevisions, same } = require('./github-merge.cjs');
const { GitRepository, exportLibrary, readRevisions, importAssets, relativePath, rejectLinks, marker, parseJSON, writeBytes,
  MARKER, FORMAT, HASH, OID, MAX_FILE, sha, utf8, failure } = require('./github-repo.cjs');

const DAY = 86400000;
const copy = value => JSON.parse(JSON.stringify(value));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validOwner = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
const validRepo = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/notes-library(?:-(?:[2-9]|[1-9][0-9]+))?$/.test(value);
const validBranch = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$/.test(value) && !value.includes('..') && !value.endsWith('/') && !value.includes('//');
const preview = bytes => {
  if (bytes === null) return { deleted: true, binary: false, text: '', size: 0, hash: null };
  const text = bytes.includes(0) ? null : utf8(bytes), binary = text === null;
  return { deleted: false, binary, text: binary ? '' : text.slice(0, 262144), truncated: !binary && text.length > 262144, size: bytes.length, hash: sha(bytes) };
};
const stampTree = tree => [...tree].map(([name, entry]) => [name, sha(entry.content)]).sort((a, b) => a[0].localeCompare(b[0], 'en'));
const stampsEqual = (left, right) => same(left, right);

class GitHubSync extends EventEmitter {
  constructor({ store, assets, tools, repoDir, onStatus, now = Date.now, intervalMs = DAY, testRemote } = {}) {
    super();
    if (!store?.mergeResolvedRevisions || !assets?.file || !tools?.git || !tools?.gh || typeof repoDir !== 'string' || !path.isAbsolute(repoDir)) throw new TypeError('GitHubSync requer armazenamento, anexos, ferramentas e uma pasta absoluta.');
    if (testRemote !== undefined && (process.env.NOTES_TEST !== '1' || typeof testRemote !== 'string' || !path.isAbsolute(testRemote))) throw new TypeError('O remoto de testes exige NOTES_TEST=1 e caminho absoluto.');
    if (!Number.isFinite(intervalMs) || intervalMs < 50) throw new TypeError('Intervalo de sincronização inválido.');
    this.store = store; this.assets = assets; this.tools = tools; this.repoDir = path.resolve(repoDir); this.onStatus = onStatus;
    this.now = now; this.intervalMs = intervalMs; this.testRemote = testRemote;
    this._stateFile = path.join(store.dataDir, 'github-sync-state.json'); this._conflictFile = path.join(store.dataDir, 'github-conflicts.json');
    this._recoveryDir = path.join(store.dataDir, 'github-recovery'); this._operationFile = path.join(store.dataDir, 'github-operation.json');
    this._controller = new AbortController(); this._exportQueue = Promise.resolve(); this._stateQueue = Promise.resolve();
    this._enabled = false; this._closed = false; this._generation = 0; this._remoteRevisionIds = new Set();
    this._status = { provider: 'github', state: 'disconnected', configured: false, connected: false, account: null, repository: null,
      onboarding: null, conflictCount: 0, pending: 0, lastSync: null, lastSuccessfulSync: null, nextSync: null, error: null };
    this.repository = new GitRepository({ directory: this.repoDir, tools, signal: this._controller.signal });
    this._storeListener = () => {
      if (this._closed) return;
      this._dirtyExport = true; this._setStatus({ pending: this._pending() });
      // This timer writes the local clone only. There is no network debounce.
      if (!this._busy && !this._awaitingStash() && this._config && !this._exportTimer) {
        this._exportTimer = setTimeout(() => { this._exportTimer = null; void this._exportLocal().catch(error => this._setStatus({ state: 'error', error: error.message })); }, 140);
        this._exportTimer.unref?.();
      }
    };
    store.on('change', this._storeListener);
    this._previousProgress = tools.onProgress;
    this._progress = value => {
      if (this._closed || this._controller.signal.aborted) return;
      this._previousProgress?.(value);
      const step = String(value?.step || 'checking');
      const state = step.startsWith('install-') || step.startsWith('installed-') ? 'installing' : step === 'login' ? 'authenticating' : 'checking';
      const onboarding = { step, message: typeof value?.message === 'string' ? value.message : '' };
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value?.deviceCode || '')) onboarding.deviceCode = value.deviceCode;
      if (value?.verificationUri === 'https://github.com/login/device') onboarding.verificationUri = value.verificationUri;
      this._setStatus({ state, onboarding });
    };
    tools.onProgress = this._progress;
  }
  get status() { return copy({ ...this._status, configured: !!this._config, connected: !!this._config && this._enabled }); }
  getStatus() { return this.status; }
  _setStatus(fields) { this._status = { ...this._status, ...fields }; const status = this.status; this.emit('status', status); this.onStatus?.(this.status); return status; }
  _pending() { try { return this.store.exportRevisions().filter(record => !this._remoteRevisionIds.has(record.id)).length; } catch { return this._status.pending; } }
  _awaitingStash() { return !!this._operation && !this._operation.stashApplied && ['stashing', 'stashed'].includes(this._operation.stage); }
  _git(args, options) { return this.repository.git(args, options); }
  _guard(generation = this._generation) {
    if (this._closed || this._controller.signal.aborted || generation !== this._generation) throw failure('A conexão foi cancelada.', 'GITHUB_CANCELLED');
  }
  _identity() {
    const { login = 'notes', id } = this._status.account || {};
    const email = (Number.isSafeInteger(id) ? id + '+' : '') + login + '@users.noreply.github.com';
    return { GIT_AUTHOR_NAME: login, GIT_COMMITTER_NAME: login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
  }
  async _ensureInit() {
    if (!this._initializing) this._initializing = (async () => {
      await this.store.init(); await this.assets.init?.(); await rejectLinks(this.repoDir);
      await rejectLinks(this._recoveryDir); await fs.mkdir(this._recoveryDir, { recursive: true });
      let state;
      try { state = await readJSON(this._stateFile, { maxBytes: 16 * 1024 * 1024 }); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('O estado GitHub local está ilegível. Ele foi preservado; suas notas continuam salvas.', 'GITHUB_STATE_INVALID'); }
      if (state) {
        if (state.version !== 1 || !validRepo(state.repository?.nameWithOwner) || !validOwner(state.account?.login) || !validBranch(state.branch)
          || !/^[a-f0-9-]{36}$/.test(state.libraryId || '') || state.localPath !== this.repoDir || typeof state.enabled !== 'boolean') throw failure('O estado GitHub local é inválido e foi preservado.', 'GITHUB_STATE_INVALID');
        this._config = { repository: state.repository, account: state.account, branch: state.branch, libraryId: state.libraryId };
        this._enabled = state.enabled;
        for (const field of ['lastSync', 'lastSuccessfulSync', 'nextSync']) if (date(state[field])) this._status[field] = state[field];
        if (Array.isArray(state.remoteRevisionIds)) this._remoteRevisionIds = new Set(state.remoteRevisionIds.filter(id => HASH.test(id)));
        this._status.account = state.account; this._status.repository = { ...state.repository, localPath: this.repoDir };
      }
      try {
        const session = await readJSON(this._conflictFile, { maxBytes: 512 * 1024 * 1024, kind: 'checkpoint' });
        if (!session || typeof session.sessionId !== 'string' || !OID.test(session.remoteCommit || '') || !Array.isArray(session.expectedHeadIds) || session.expectedHeadIds.some(id => !HASH.test(id)) || !Array.isArray(session.items)) throw new Error('invalid');
        this._session = session;
      } catch (error) { if (error.code !== 'ENOENT') throw failure('A comparação pendente está ilegível. Seus arquivos foram preservados.', 'GITHUB_STATE_INVALID'); }
      try { this._operation = await readJSON(this._operationFile); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('O registro de recuperação é ilegível e foi preservado.', 'GITHUB_RECOVERY_REQUIRED'); }
      this._setStatus({ state: this._enabled && this._config ? this._session ? 'conflict' : 'ready' : 'disconnected', conflictCount: this._session?.items.length || 0, pending: this._pending() });
      return this.status;
    })();
    return this._initializing;
  }
  async init({ syncIfDue = false } = {}) {
    await this._ensureInit();
    if (syncIfDue) await this.syncIfDue(); else this._schedule();
    return this.status;
  }
  _saveState() {
    const state = this._config && { version: 1, enabled: this._enabled, ...this._config, localPath: this.repoDir,
      lastSync: this._status.lastSync, lastSuccessfulSync: this._status.lastSuccessfulSync, nextSync: this._status.nextSync,
      remoteRevisionIds: [...this._remoteRevisionIds] };
    if (!state) return Promise.resolve();
    const operation = this._stateQueue.then(() => atomicWrite(this._stateFile, state, { maxBytes: 16 * 1024 * 1024 }));
    this._stateQueue = operation.catch(() => {}); return operation;
  }
  _schedule() {
    clearTimeout(this._timer);
    if (this._closed || !this._enabled || !this._config || this._session) return;
    const due = this._status.nextSync ? Date.parse(this._status.nextSync) : this.now() + this.intervalMs;
    this._timer = setTimeout(() => { void this.syncIfDue(); }, Math.max(1, Math.min(2147483647, due - this.now()))); this._timer.unref?.();
  }
  async syncIfDue() {
    await this._ensureInit();
    if (!this._enabled || !this._config || this._closed || this._session) return this.status;
    if (!this._status.nextSync || this.now() >= Date.parse(this._status.nextSync)) return this.sync();
    this._schedule(); return this.status;
  }
  async inspect() {
    await this._ensureInit(); this._setStatus({ state: 'checking', error: null, onboarding: { step: 'checking', message: 'Verificando Git e GitHub neste computador.' } });
    try {
      const inspection = await this.tools.inspect();
      this._setStatus({ state: inspection.account?.loggedIn && this._config && this._enabled ? 'ready' : inspection.git?.installed && inspection.gh?.installed ? 'auth-required' : 'disconnected',
        account: inspection.account?.loggedIn ? { login: inspection.account.login, ...(Number.isSafeInteger(inspection.account.id) ? { id: inspection.account.id } : {}) } : null,
        onboarding: { step: !inspection.git?.installed || !inspection.gh?.installed ? 'tools-missing' : inspection.account?.loggedIn ? 'tools-ready' : 'login',
          message: !inspection.git?.installed || !inspection.gh?.installed ? 'O notes instalará as ferramentas oficiais ao conectar.' : inspection.account?.loggedIn ? 'GitHub pronto para conectar.' : 'Entre na conta GitHub para continuar.' } });
      return { ...this.status, tools: { git: inspection.git, gh: inspection.gh } };
    } catch (error) { this._setStatus({ state: 'error', error: error.message }); return this.status; }
  }
  connect() {
    if (this._connecting) return this._connecting;
    if (this._controller.signal.aborted && !this._closed) { this._controller = new AbortController(); this.repository.signal = this._controller.signal; }
    const generation = this._generation;
    this._connecting = (async () => {
      await this._ensureInit();
      if (this._closed || generation !== this._generation || this._controller.signal.aborted) return this._setStatus({ state: 'disconnected', error: null, onboarding: null });
      this._setStatus({ state: 'checking', error: null, onboarding: { step: 'checking', message: 'Preparando sua biblioteca no GitHub.' } });
      try {
        let inspection = await this.tools.ensureInstalled(), account = inspection.account; this._guard(generation);
        if (!account?.loggedIn) { this._setStatus({ state: 'authenticating', onboarding: { step: 'login', message: 'Entre no GitHub pelo navegador para continuar.' } }); account = await this.tools.login(); this._guard(generation); }
        if (!account?.loggedIn || !validOwner(account.login)) throw failure('A conta GitHub não foi confirmada.', 'GITHUB_LOGIN');
        if (this._config && this._config.account.login.toLowerCase() !== account.login.toLowerCase()) throw failure('Esta biblioteca pertence a outra conta GitHub. Reconecte a conta original para preservar seus dados.', 'GITHUB_ACCOUNT_CHANGED');
        this._status.account = { login: account.login, ...(Number.isSafeInteger(account.id) ? { id: account.id } : {}) };
        if (!this._config) await this._selectRepository(account, generation);
        else if (!this.testRemote) await this._checkRepository();
        this._guard(generation);
        this._enabled = true; this._setStatus({ repository: { ...this._config.repository, localPath: this.repoDir }, account: this._status.account, onboarding: null });
        await this._saveState(); this._guard(generation); return this.sync();
      } catch (error) {
        if (error.code === 'GITHUB_CANCELLED' || generation !== this._generation || this._closed) return this._setStatus({ state: 'disconnected', error: null, onboarding: null });
        this._setStatus({ state: error.code === 'GITHUB_LOGIN' ? 'auth-required' : 'error', error: error.message }); return this.status;
      }
    })();
    return this._connecting.finally(() => { this._connecting = null; });
  }
  async _selectRepository(account, generation) {
    this._guard(generation);
    this._setStatus({ state: 'creating-repo', onboarding: { step: 'repository', message: 'Preparando o repositório privado das suas notas.' } });
    let selected, libraryId, branch = 'main';
    if (this.testRemote) selected = { nameWithOwner: 'notes-test/notes-library', url: 'https://github.com/notes-test/notes-library', private: true };
    else {
      const listing = await this.tools.gh(['repo', 'list', account.login, '--limit', '1000', '--json', 'nameWithOwner,isPrivate,url,defaultBranchRef']);
      this._guard(generation);
      let repos; try { repos = JSON.parse(listing.stdout); } catch { throw failure('O GitHub não retornou uma lista válida de repositórios.'); }
      if (!Array.isArray(repos)) throw failure('O GitHub não retornou uma lista válida de repositórios.');
      const occupied = new Set(repos.map(repo => String(repo.nameWithOwner).toLowerCase()));
      for (const repo of repos.filter(repo => validRepo(repo.nameWithOwner) && repo.isPrivate && repo.nameWithOwner.split('/')[0].toLowerCase() === account.login.toLowerCase()).sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner, 'en', { numeric: true }))) {
        const result = await this.tools.gh(['api', 'repos/' + repo.nameWithOwner + '/contents/' + MARKER, '--hostname', 'github.com', '--jq', '.content'], { allowFailure: true });
        this._guard(generation);
        if (result.code !== 0) continue;
        try {
          const contents = result.stdout.replace(/\s/g, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contents) || contents.length > 4096) continue;
          libraryId = marker(parseJSON(Buffer.from(contents, 'base64'), 'O marcador')).libraryId;
          selected = { nameWithOwner: repo.nameWithOwner, url: 'https://github.com/' + repo.nameWithOwner, private: true };
          if (validBranch(repo.defaultBranchRef?.name)) branch = repo.defaultBranchRef.name;
          break;
        } catch { /* A name collision is never adopted or overwritten. */ }
      }
      if (!selected) {
        let number = 1, name;
        do { name = account.login + '/notes-library' + (number === 1 ? '' : '-' + number); number++; } while (occupied.has(name.toLowerCase()));
        this._guard(generation); await this.tools.gh(['repo', 'create', name, '--private', '--description', 'Biblioteca privada do notes']); this._guard(generation);
        selected = { nameWithOwner: name, url: 'https://github.com/' + name, private: true };
      }
    }
    this._config = { repository: selected, account: this._status.account, libraryId: libraryId || crypto.randomUUID(), branch };
    await this._ensureRepository(); this._guard(generation);
    if (this.testRemote) {
      const remote = await this._fetch(); this._guard(generation);
      if (remote) this._config.libraryId = await this._remoteMarker(await this.repository.tree(remote));
    }
  }
  async _checkRepository() {
    const result = await this.tools.gh(['repo', 'view', this._config.repository.nameWithOwner, '--json', 'nameWithOwner,isPrivate,url,defaultBranchRef']);
    let repo; try { repo = JSON.parse(result.stdout); } catch { throw failure('O repositório GitHub não pôde ser verificado.'); }
    if (repo.nameWithOwner?.toLowerCase() !== this._config.repository.nameWithOwner.toLowerCase() || repo.isPrivate !== true) throw failure('A biblioteca precisa continuar em um repositório privado. Nenhuma nota foi enviada.', 'GITHUB_REPOSITORY_NOT_PRIVATE');
  }
  async _ensureRepository() {
    await this.repository.ensureDirectory();
    const dotGit = await fs.lstat(path.join(this.repoDir, '.git')).catch(() => null), entries = await fs.readdir(this.repoDir);
    if (!dotGit) {
      if (entries.length) throw failure('A pasta notes-repository já contém arquivos de outra biblioteca. Eles foram preservados.', 'GITHUB_DIRECTORY_IN_USE');
      await this._git(['init', '--initial-branch=' + this._config.branch]);
    } else {
      const markPath = path.join(this.repoDir, MARKER), content = await fs.readFile(markPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const currentHead = await this.repository.head();
      if (content && marker(parseJSON(content, 'O marcador')).libraryId !== this._config.libraryId) throw failure('A pasta pertence a outra biblioteca notes.', 'GITHUB_DIRECTORY_IN_USE');
      if (!content && currentHead) throw failure('A pasta contém um repositório sem marcador notes.', 'GITHUB_DIRECTORY_IN_USE');
    }
    // Highest-precedence attributes keep the exact bytes of arbitrary files
    // and content-addressed chunks. A tracked .gitattributes must not activate
    // filters, keyword expansion, encodings or newline conversion on save.
    const attributes = Buffer.from('# notes: preserve exact library bytes\n* -text -filter -ident -working-tree-encoding\n');
    const attributesFile = path.join(this.repoDir, '.git', 'info', 'attributes');
    const previousAttributes = await fs.readFile(attributesFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!previousAttributes?.equals(attributes)) await writeBytes(attributesFile, attributes);
    const remoteUrl = this.testRemote || 'https://github.com/' + this._config.repository.nameWithOwner + '.git';
    const existing = await this._git(['remote', 'get-url', 'origin'], { allowFailure: true });
    if (existing.code === 0 && existing.stdout.trim() !== remoteUrl) throw failure('O endereço Git da biblioteca foi alterado. Seus arquivos foram preservados.', 'GITHUB_REMOTE_CHANGED');
    if (existing.code !== 0) await this._git(['remote', 'add', 'origin', remoteUrl]);
    await this._validateRemote();
    const worktree = await this._git(['rev-parse', '--show-toplevel']);
    const actualRoot = path.resolve(worktree.stdout.trim()), expectedRoot = path.resolve(this.repoDir);
    if ((process.platform === 'win32' ? actualRoot.toLowerCase() !== expectedRoot.toLowerCase() : actualRoot !== expectedRoot)) throw failure('A configuração Git aponta para uma pasta externa. Nenhum arquivo externo foi acessado.', 'GITHUB_UNSAFE_CONFIG');
    const branch = await this._git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    if (branch.code === 0 && branch.stdout.trim() !== this._config.branch) throw failure('A pasta está em outra branch. Retorne à branch da biblioteca para sincronizar.', 'GITHUB_BRANCH_CHANGED');
  }
  async _validateRemote() {
    const expected = this.testRemote || 'https://github.com/' + this._config.repository.nameWithOwner + '.git';
    // Explicit push URLs and rewrite rules can redirect a normal-looking
    // origin to another repository. Verify both directions before any network
    // operation and immediately before publishing private library contents.
    const settings = await this._git(['config', '--local', '--no-includes', '--null', '--list']);
    for (const record of settings.stdout.split('\0').filter(Boolean)) {
      const key = record.split('\n', 1)[0].toLowerCase();
      if (/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key) || /^remote\..*\.pushurl$/.test(key) || /^(?:core\.worktree|extensions\.worktreeconfig)$/.test(key)) throw failure('O endereço de envio ou a pasta de trabalho do Git foi alterado. Nenhuma nota foi enviada.', 'GITHUB_REMOTE_CHANGED');
    }
    for (const args of [['remote', 'get-url', '--all', 'origin'], ['remote', 'get-url', '--push', '--all', 'origin']]) {
      const result = await this._git(args), urls = result.stdout.trim().split(/\r?\n/);
      if (urls.length !== 1 || urls[0] !== expected) throw failure('O endereço de envio do Git não corresponde à biblioteca privada. Nenhuma nota foi enviada.', 'GITHUB_REMOTE_CHANGED');
    }
  }
  async _fetch() {
    await this._validateRemote();
    await this._git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    return this.repository.head('refs/remotes/origin/' + this._config.branch);
  }
  async _remoteMarker(tree) {
    const entry = tree.get(MARKER); if (!entry) throw failure('O repositório remoto não possui marcador notes.', 'GITHUB_INVALID_MARKER');
    const bytes = await this.repository.read(entry); if (bytes.length > 4096) throw failure('O marcador remoto é inválido.', 'GITHUB_INVALID_MARKER');
    return marker(parseJSON(bytes, 'O marcador remoto')).libraryId;
  }
  _exportLocal() {
    const operation = this._exportQueue.then(async () => {
      if (!this._config || this._awaitingStash()) return;
      await this.store.close();
      const records = await exportLibrary({ repository: this.repository, store: this.store, assets: this.assets, libraryId: this._config.libraryId });
      this._dirtyExport = this._pending() > 0; return records;
    });
    this._exportQueue = operation.catch(() => {}); return operation;
  }
  async _verifyManagedTree(tree) {
    const records = await readRevisions(this.repository, tree), manifests = [];
    for (const [name, entry] of tree) {
      if (!name.startsWith('assets/')) continue;
      let match = /^assets\/chunks\/([a-f0-9]{64})$/.exec(name);
      if (match) {
        const bytes = await this.repository.read(entry);
        if (bytes.length > 32 * 1024 * 1024 || sha(bytes) !== match[1]) throw failure('O checksum de um bloco do anexo é inválido.', 'GITHUB_INTEGRITY');
        continue;
      }
      match = /^assets\/manifests\/([a-f0-9]{64})\.json$/.exec(name);
      if (!match) throw failure('Há um arquivo desconhecido na pasta reservada de anexos.', 'GITHUB_INVALID_DATA');
      const manifest = parseJSON(await this.repository.read(entry), 'Um manifesto');
      if (manifest.hash !== match[1] || !Number.isSafeInteger(manifest.size) || manifest.size < 0) throw failure('Um manifesto de anexo é inválido.', 'GITHUB_INTEGRITY');
      manifests.push({ hash: manifest.hash, size: manifest.size, name: manifest.hash, relativePath: manifest.hash, mime: 'application/octet-stream' });
    }
    // Include orphaned historical assets too: deleting a note does not make its
    // archived attachment bytes exempt from integrity checks.
    await importAssets(this.repository, tree, [...records, { kind: 'note', deleted: false, value: { data: { attachments: manifests } } }], this.assets, this._recoveryDir);
    return records;
  }
  async _plan(remoteCommit) {
    const remoteTree = await this.repository.tree(remoteCommit), localHead = await this.repository.head();
    if (remoteCommit && await this._remoteMarker(remoteTree) !== this._config.libraryId) throw failure('O remoto pertence a outra biblioteca notes.', 'GITHUB_INVALID_MARKER');
    const records = await this._verifyManagedTree(remoteTree);
    const localRecords = this.store.exportRevisions(), expectedHeadIds = this.store.exportHeadIds();
    const revisions = await planRevisions(localRecords, records, async (base, local, remote) => {
      const result = await this.repository.mergeText(Buffer.from(base), Buffer.from(local), Buffer.from(remote), this._recoveryDir);
      return result === null ? null : utf8(result);
    });
    let baseCommit = null;
    if (localHead && remoteCommit) {
      const result = await this._git(['merge-base', localHead, remoteCommit], { allowFailure: true });
      if (result.code === 0 && OID.test(result.stdout.trim())) baseCommit = result.stdout.trim();
    }
    const baseTree = await this.repository.tree(baseCommit), localTree = await this.repository.working(), desired = new Map(), fileConflicts = [];
    await this._verifyManagedTree(localTree);
    for (const name of new Set([...baseTree.keys(), ...localTree.keys(), ...remoteTree.keys()])) {
      const [base, local, remote] = await Promise.all([baseTree.get(name), localTree.get(name), remoteTree.get(name)].map(entry => this.repository.read(entry)));
      const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
      let value;
      if (equal(local, remote)) value = local;
      else if (equal(local, base)) value = remote;
      else if (equal(remote, base)) value = local;
      else if (/^(?:revisions\/|assets\/)/.test(name)) throw failure('Um arquivo imutável remoto tem conteúdo incompatível: ' + name, 'GITHUB_INTEGRITY');
      else if (base !== null && local !== null && remote !== null && ![base, local, remote].some(bytes => bytes.includes(0) || utf8(bytes) === null)) {
        value = await this.repository.mergeText(base, local, remote, this._recoveryDir);
        if (value === null) fileConflicts.push({ id: 'file-' + sha(name), path: name, local: preview(local), remote: preview(remote), canKeepBoth: true });
      } else fileConflicts.push({ id: 'file-' + sha(name), path: name, local: preview(local), remote: preview(remote), canKeepBoth: true });
      if (value !== undefined && value !== null) desired.set(name, { path: name, content: value, mode: '100644' });
    }
    const entityItems = revisions.conflicts.map(conflict => {
      const note = conflict.kind === 'note';
      const side = record => note ? record.deleted ? { deleted: true, binary: false } : { ...copy(record.value.data), deleted: false, binary: false }
        : { ...preview(record.deleted ? null : Buffer.from(JSON.stringify(record.value, null, 2))), label: conflict.kind };
      return { id: conflict.id, kind: note ? 'note' : 'file', entityKind: conflict.kind, entityKey: conflict.key,
        title: note ? conflict.local.value?.data.title || conflict.remote.value?.data.title || 'Nota excluída' : (conflict.kind === 'pref' ? 'Preferência: ' : conflict.kind === 'group' ? 'Grupo: ' : 'Sessão: ') + (conflict.local.value?.data?.name || conflict.remote.value?.data?.name || conflict.key),
        ...(note ? {} : { path: 'Biblioteca/' + conflict.kind + '/' + conflict.key }), local: side(conflict.local), remote: side(conflict.remote), canKeepBoth: note };
    });
    return { localHead, remoteCommit, baseCommit, remoteTree, localTree, desired, records, revisions, expectedHeadIds,
      items: [...entityItems, ...fileConflicts.map(conflict => ({ ...conflict, kind: 'file', title: conflict.path }))], localStamp: stampTree(localTree) };
  }
  async _publishConflicts(plan) {
    if (!plan.remoteCommit) throw failure('Um conflito precisa ter uma revisão remota.', 'GITHUB_INVALID_DATA');
    const session = { sessionId: crypto.randomUUID(), remoteCommit: plan.remoteCommit, expectedHeadIds: plan.expectedHeadIds,
      items: plan.items, localStamp: plan.localStamp, createdAt: new Date(this.now()).toISOString() };
    await atomicWrite(this._conflictFile, session, { maxBytes: 512 * 1024 * 1024, kind: 'checkpoint' });
    this._session = session; return this._setStatus({ state: 'conflict', conflictCount: session.items.length, error: null, onboarding: null, pending: this._pending() });
  }
  async getConflicts() { await this._ensureInit(); return this._session ? copy(this._session) : { sessionId: null, remoteCommit: null, expectedHeadIds: [], items: [] }; }
  sync() {
    if (this._syncing) return this._syncing;
    this._syncing = this._run().finally(() => { this._syncing = null; this._schedule(); }); return this._syncing;
  }
  async _run(resolution, retry = 0) {
    await this._ensureInit();
    if (this._closed || !this._enabled || !this._config) return this.status;
    const generation = this._generation;
    clearTimeout(this._timer); clearTimeout(this._exportTimer); this._exportTimer = null; this._busy = true;
    this._setStatus({ state: 'syncing', error: null, onboarding: null });
    try {
      await this._ensureRepository();
      this._guard(generation);
      if (!this.testRemote) await this._checkRepository();
      this._guard(generation); await this._recoverOperation(); this._guard(generation); await this._exportLocal(); this._guard(generation);
      const remoteCommit = await this._fetch(); this._guard(generation); const plan = await this._plan(remoteCommit); this._guard(generation);
      if (resolution) {
        const original = resolution.session;
        if (original.remoteCommit !== remoteCommit || !same(original.expectedHeadIds, plan.expectedHeadIds) || !stampsEqual(original.localStamp, plan.localStamp)
          || !same(original.items.map(item => item.id).sort(), plan.items.map(item => item.id).sort())) {
          if (plan.items.length) await this._publishConflicts(plan); else { this._session = null; await fs.unlink(this._conflictFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          if (!this._session) this._setStatus({ state: 'error', conflictCount: 0, error: 'As versões mudaram. Sincronize novamente para combinar a biblioteca atual.' });
          throw failure('As versões mudaram enquanto a comparação estava aberta. Revise a comparação atualizada.', 'GITHUB_CONFLICT_STALE');
        }
        const selections = new Map(resolution.choices.map(choice => [choice.id, choice.choice]));
        for (const item of plan.items) {
          const choice = selections.get(item.id);
          if (!choice || choice === 'both' && !item.canKeepBoth) throw failure('Escolha uma versão para cada conflito.', 'GITHUB_CONFLICT_CHOICES');
          if (item.entityKind) plan.revisions.resolutions.push({ kind: item.entityKind, key: item.entityKey, choice });
          else {
            const local = plan.localTree.get(item.path), remote = plan.remoteTree.get(item.path);
            if (choice !== 'remote' && local) plan.desired.set(item.path, local);
            if (choice === 'remote' && remote) plan.desired.set(item.path, remote);
            if (choice === 'both' && remote) {
              let suffix = 1, name;
              const extension = path.posix.extname(item.path), stem = item.path.slice(0, item.path.length - extension.length);
              do { name = stem.slice(0, Math.max(1, 220 - extension.length)) + ' (GitHub' + (suffix === 1 ? '' : ' ' + suffix) + ')' + extension; suffix++; }
              while (plan.localTree.has(name) || plan.remoteTree.has(name) || plan.desired.has(name));
              relativePath(name); plan.desired.set(name, { path: name, content: await this.repository.read(remote), mode: '100644' });
            }
          }
        }
      } else if (plan.items.length) return await this._publishConflicts(plan);
      await this.store.mergeResolvedRevisions(plan.records, { expectedHeadIds: plan.expectedHeadIds, resolutions: plan.revisions.resolutions });
      this._guard(generation); await this._commitPlan(plan, generation); this._guard(generation);
      await this._validateRemote(); this._guard(generation);
      const pushed = await this._git(['push', '--porcelain', 'origin', 'HEAD:refs/heads/' + this._config.branch], { allowFailure: true });
      this._guard(generation);
      if (pushed.code !== 0) throw failure(/rejected|non-fast-forward|fetch first/i.test(pushed.stderr + pushed.stdout)
        ? 'O GitHub recebeu outra alteração durante o envio. Suas alterações estão salvas; sincronize novamente para combiná-las.'
        : 'O envio ao GitHub não foi concluído. Suas alterações estão salvas neste computador; tente novamente quando estiver online.', 'GITHUB_PUSH_REJECTED');
      const committedTree = await this.repository.tree(await this.repository.head());
      this._remoteRevisionIds = new Set([...committedTree.keys()].map(name => /^revisions\/([a-f0-9]{64})\.json$/.exec(name)?.[1]).filter(Boolean));
      const stamp = new Date(this.now()).toISOString();
      this._setStatus({ state: 'ready', conflictCount: 0, lastSync: stamp, lastSuccessfulSync: stamp,
        nextSync: new Date(this.now() + this.intervalMs).toISOString(), pending: this._pending(), error: null, onboarding: null });
      await this._saveState(); this._session = null; await fs.unlink(this._conflictFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await this._finishOperation(); return this.status;
    } catch (error) {
      if (error.code === 'GITHUB_CANCELLED' || generation !== this._generation || this._closed) return this._setStatus({ state: 'disconnected', error: null, onboarding: null, pending: this._pending() });
      if (error.code === 'GITHUB_CONFLICT_STALE' && resolution) throw error;
      if (error.code === 'GITHUB_CONFLICT_STALE' && retry < 2) return await this._run(undefined, retry + 1);
      const offline = ['GITHUB_PUSH_REJECTED', 'GITHUB_COMMAND_FAILED', 'GITHUB_TIMEOUT', 'GITHUB_PROCESS', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(error.code);
      this._setStatus({ state: this._session ? 'conflict' : offline ? 'offline' : 'error', error: error.message, pending: this._pending(),
        nextSync: new Date(this.now() + this.intervalMs).toISOString() });
      await this._saveState(); return this.status;
    } finally {
      this._busy = false;
      if (this._dirtyExport && !this._awaitingStash() && !this._closed && !this._controller.signal.aborted && this._config) void this._exportLocal().catch(error => this._setStatus({ state: 'error', error: error.message }));
    }
  }
  async resolveConflicts({ sessionId, remoteCommit, expectedHeadIds, choices } = {}) {
    await this._ensureInit();
    const session = this._session;
    if (!session || session.sessionId !== sessionId || session.remoteCommit !== remoteCommit || !same(session.expectedHeadIds, expectedHeadIds)) throw failure('Esta comparação não é mais atual. Abra os conflitos novamente.', 'GITHUB_CONFLICT_STALE');
    if (!Array.isArray(choices) || choices.length !== session.items.length || new Set(choices.map(choice => choice.id)).size !== choices.length
      || choices.some(choice => !choice || !session.items.some(item => item.id === choice.id) || !['local', 'remote', 'both'].includes(choice.choice))) throw failure('Escolha uma versão para cada conflito.', 'GITHUB_CONFLICT_CHOICES');
    if (this._syncing) throw failure('Aguarde a sincronização em andamento.', 'GITHUB_BUSY');
    this._syncing = this._run({ session: copy(session), choices: copy(choices) }).finally(() => { this._syncing = null; this._schedule(); });
    return this._syncing;
  }
  async _snapshot(tree) {
    const id = crypto.randomUUID(), directory = path.join(this._recoveryDir, id); await fs.mkdir(directory, { recursive: true });
    const files = [];
    for (const [name, entry] of tree) {
      const content = await this.repository.read(entry), hash = sha(content);
      const file = path.join(directory, hash);
      await fs.writeFile(file, content, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; }); files.push({ path: name, hash, size: content.length });
    }
    await atomicWrite(path.join(directory, 'snapshot.json'), { version: 1, files, createdAt: new Date(this.now()).toISOString() });
    return id;
  }
  async _commitPlan(plan, generation) {
    this._guard(generation);
    const current = await this.repository.working();
    if (!stampsEqual(stampTree(current), plan.localStamp)) throw failure('Um arquivo local mudou durante a comparação. Sincronize novamente para preservá-lo.', 'GITHUB_CONFLICT_STALE');
    const snapshotId = await this._snapshot(current), desiredSnapshotId = await this._snapshot(plan.desired); this._guard(generation);
    const retainedStashes = [...new Set([...(this._operation?.retainedStashes || []), this._operation?.stashOid].filter(Boolean))];
    this._operation = { version: 1, snapshotId, desiredSnapshotId, retainedStashes, remoteCommit: plan.remoteCommit, stage: 'snapshot', stashOid: null, stashApplied: false, startedAt: new Date(this.now()).toISOString() };
    await atomicWrite(this._operationFile, this._operation);
    if (!await this.repository.head()) {
      await this._git(['add', '--all', '--force', '--', '.']);
      await this._git(['commit', '--no-gpg-sign', '-m', 'notes: iniciar biblioteca local'], { env: this._identity() });
      this._guard(generation);
    }
    const before = await this.repository.head('refs/stash');
    this._operation.stashBaseOid = before; this._operation.stage = 'stashing'; await atomicWrite(this._operationFile, this._operation); this._guard(generation);
    await this._git(['stash', 'push', '--include-untracked', '--message', 'notes recovery ' + snapshotId]);
    const after = await this.repository.head('refs/stash');
    if (after && after !== before) this._operation.stashOid = after;
    this._operation.stage = 'stashed'; await atomicWrite(this._operationFile, this._operation);
    this._guard(generation);
    if (plan.remoteCommit) await this._git(['merge', '--no-ff', '--no-commit', '--allow-unrelated-histories', '--strategy=ours', plan.remoteCommit], { env: this._identity() });
    this._guard(generation);
    if (this._operation.stashOid) {
      const applied = await this._git(['stash', 'apply', this._operation.stashOid], { allowFailure: true });
      if (applied.code !== 0) throw failure('A recuperação local precisa de revisão. O stash e a cópia de segurança foram preservados.', 'GITHUB_RECOVERY_REQUIRED');
    }
    this._operation.stashApplied = true; this._operation.stage = 'applied'; await atomicWrite(this._operationFile, this._operation);
    this._guard(generation);
    const afterStash = await this.repository.working();
    if (!stampsEqual(stampTree(afterStash), plan.localStamp)) { await this._replanOperation(); throw failure('Um arquivo mudou durante a sincronização. A comparação será recalculada sem substituir a nova edição.', 'GITHUB_CONFLICT_STALE'); }
    try { await this.repository.writeTree(plan.desired, afterStash); }
    catch (error) { if (error.code === 'GITHUB_CONFLICT_STALE') await this._replanOperation(); throw error; }
    await this._exportLocal(); const exactTree = await this.repository.working(); await this._verifyManagedTree(exactTree);
    this._operation.stage = 'tree-written'; await atomicWrite(this._operationFile, this._operation); this._guard(generation);
    await this._git(['add', '--all', '--force', '--', '.']);
    const staged = await this._git(['diff', '--cached', '--quiet'], { allowFailure: true });
    if (staged.code > 1) throw failure('O índice Git não pôde ser verificado.');
    const merging = await fs.lstat(path.join(this.repoDir, '.git', 'MERGE_HEAD')).catch(() => null);
    if (staged.code === 1 || merging) await this._git(['commit', '--no-gpg-sign', '-m', 'notes: sincronizar biblioteca'], { env: this._identity() });
    this._guard(generation);
    await this._verifyCommittedTree(exactTree);
    this._operation.stage = 'committed'; await atomicWrite(this._operationFile, this._operation);
  }
  async _replanOperation() {
    const merging = await fs.lstat(path.join(this.repoDir, '.git', 'MERGE_HEAD')).catch(() => null);
    if (merging) await this._git(['merge', '--quit']);
    this._operation.stage = 'replan'; await atomicWrite(this._operationFile, this._operation);
  }
  async _verifyCommittedTree(expected) {
    const actual = await this.repository.tree(await this.repository.head());
    if (actual.size !== expected.size) throw failure('O commit Git não corresponde à biblioteca verificada. Nenhuma nota foi enviada.', 'GITHUB_INTEGRITY');
    for (const [name, entry] of expected) {
      const committed = actual.get(name);
      if (!committed || !(await this.repository.read(entry)).equals(await this.repository.read(committed))) throw failure('Um filtro ou transformação alterou os bytes do commit: ' + name + '. Nenhuma nota foi enviada.', 'GITHUB_INTEGRITY');
    }
    await this._verifyManagedTree(actual);
  }
  async _recoverOperation() {
    if (!this._operation) {
      try { this._operation = await readJSON(this._operationFile); }
      catch (error) { if (error.code !== 'ENOENT') throw failure('O registro de recuperação é ilegível e foi preservado.', 'GITHUB_RECOVERY_REQUIRED'); }
    }
    const operation = this._operation; if (!operation) return;
    if (operation.version !== 1 || !/^[a-f0-9-]{36}$/.test(operation.snapshotId || '') || operation.stashOid && !OID.test(operation.stashOid)) throw failure('O registro de recuperação é inválido e foi preservado.', 'GITHUB_RECOVERY_REQUIRED');
    if (operation.retainedStashes && (!Array.isArray(operation.retainedStashes) || operation.retainedStashes.length > 1000 || operation.retainedStashes.some(id => !OID.test(id)))) throw failure('O registro de stashes de recuperação é inválido.', 'GITHUB_RECOVERY_REQUIRED');
    if (!operation.stashOid && ['snapshot', 'stashing'].includes(operation.stage)) {
      // A process may stop after Git created the stash and before its OID was
      // fsynced to our state file. Its unique recovery message is the durable
      // handshake; never interpret the resulting clean tree as user deletion.
      const stashes = await this._git(['stash', 'list', '--format=%H%x00%gs']);
      const suffix = 'notes recovery ' + operation.snapshotId;
      const own = stashes.stdout.split(/\r?\n/).map(line => /^([a-f0-9]{40,64})\0([\s\S]*)$/.exec(line)).find(match => match && match[2].endsWith(suffix) && match[1] !== operation.stashBaseOid);
      if (own) { operation.stashOid = own[1]; operation.stage = 'stashed'; await atomicWrite(this._operationFile, operation); }
      else {
        const original = await this._readSnapshot(operation.snapshotId), current = await this.repository.working();
        if (!stampsEqual(stampTree(original), stampTree(current))) throw failure('A interrupção deixou alterações locais que precisam de revisão. A cópia completa anterior foi preservada.', 'GITHUB_RECOVERY_REQUIRED');
      }
    }
    if (operation.stashOid && !operation.stashApplied) {
      await this._prepareStashRecovery(operation.stashOid);
      const applied = await this._git(['stash', 'apply', operation.stashOid], { allowFailure: true });
      if (applied.code !== 0) throw failure('O stash de recuperação precisa de revisão. A cópia de segurança continua disponível.', 'GITHUB_RECOVERY_REQUIRED');
      operation.stashApplied = true; operation.stage = 'applied'; await atomicWrite(this._operationFile, operation);
    }
    const unmerged = await this._git(['ls-files', '--unmerged'], { allowFailure: true });
    if (unmerged.stdout.trim()) throw failure('Existem arquivos em conflito deixados por uma operação Git externa. Resolva-os antes de sincronizar.', 'GITHUB_RECOVERY_REQUIRED');
    const merging = await fs.lstat(path.join(this.repoDir, '.git', 'MERGE_HEAD')).catch(() => null);
    if (merging) {
      // The "ours" merge records ancestry before its combined tree is written.
      // Committing the unfinished local tree would turn remote-only files into
      // deletions on the next pull. Reconstruct the verified intended tree
      // first, retaining any subsequent compatible local file changes.
      if (!operation.desiredSnapshotId) throw failure('A recuperação não tem uma árvore combinada verificável. Os arquivos e o stash foram preservados.', 'GITHUB_RECOVERY_REQUIRED');
      const original = await this._readSnapshot(operation.snapshotId), intended = await this._readSnapshot(operation.desiredSnapshotId), current = await this.repository.working();
      const recovered = new Map();
      const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
      for (const name of new Set([...original.keys(), ...intended.keys(), ...current.keys()])) {
        const base = original.get(name)?.content || null, local = current.get(name)?.content || null, remote = intended.get(name)?.content || null;
        let value;
        if (equal(local, remote) || equal(remote, base)) value = local;
        else if (equal(local, base)) value = remote;
        else if (base !== null && local !== null && remote !== null && ![base, local, remote].some(bytes => bytes.includes(0) || utf8(bytes) === null)) value = await this.repository.mergeText(base, local, remote, this._recoveryDir);
        else throw failure('Um arquivo foi alterado depois da interrupção: ' + name + '. As cópias foram preservadas para revisão.', 'GITHUB_RECOVERY_REQUIRED');
        if (value === null && local !== null && remote !== null) throw failure('Um arquivo precisa de revisão durante a recuperação: ' + name, 'GITHUB_RECOVERY_REQUIRED');
        if (value !== null) recovered.set(name, { path: name, content: value, mode: '100644' });
      }
      await this._snapshot(current); await this.repository.writeTree(recovered, current); await this._exportLocal();
      const exactTree = await this.repository.working(); await this._verifyManagedTree(exactTree); await this._git(['add', '--all', '--force', '--', '.']);
      await this._git(['commit', '--no-gpg-sign', '-m', 'notes: recuperar sincronização interrompida'], { env: this._identity() });
      await this._verifyCommittedTree(exactTree);
      operation.stage = 'committed'; await atomicWrite(this._operationFile, operation);
    }
  }
  async _prepareStashRecovery(stashOid) {
    const untrackedCommit = await this.repository.head(stashOid + '^3');
    if (!untrackedCommit) return;
    const stashed = await this.repository.tree(untrackedCommit), current = await this.repository.working(), withoutDuplicates = new Map(current);
    for (const [name, entry] of stashed) {
      const existing = current.get(name); if (!existing) continue;
      if (!(await this.repository.read(entry)).equals(existing.content)) throw failure('Um arquivo novo mudou após a interrupção: ' + name + '. A versão atual e o stash foram preservados.', 'GITHUB_RECOVERY_REQUIRED');
      // A previous process may have re-exported an immutable revision while
      // the worktree was stashed. Git refuses to restore an untracked file
      // even when its bytes are identical. Remove only verified duplicates;
      // the durable stash and recovery snapshots retain the exact same bytes.
      withoutDuplicates.delete(name);
    }
    if (withoutDuplicates.size !== current.size) await this.repository.writeTree(withoutDuplicates, current);
  }
  async _readSnapshot(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw failure('Identificador de recuperação inválido.', 'GITHUB_RECOVERY_REQUIRED');
    const directory = path.join(this._recoveryDir, id); await rejectLinks(directory);
    const manifest = await readJSON(path.join(directory, 'snapshot.json'));
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw failure('A cópia de recuperação é inválida.', 'GITHUB_RECOVERY_REQUIRED');
    const result = new Map();
    for (const file of manifest.files) {
      relativePath(file.path);
      if (!HASH.test(file.hash || '') || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE || result.has(file.path)) throw failure('A cópia de recuperação é inválida.', 'GITHUB_RECOVERY_REQUIRED');
      const filename = path.join(directory, file.hash); await rejectLinks(filename);
      const bytes = await fs.readFile(filename);
      if (bytes.length !== file.size || sha(bytes) !== file.hash) throw failure('O checksum da recuperação é inválido.', 'GITHUB_RECOVERY_REQUIRED');
      result.set(file.path, { path: file.path, content: bytes, mode: '100644' });
    }
    return result;
  }
  async _finishOperation() {
    const operation = this._operation;
    for (const stashOid of new Set([...(operation?.retainedStashes || []), operation?.stashOid].filter(Boolean))) {
      const result = await this._git(['stash', 'list', '--format=%gd %H']);
      const row = result.stdout.split(/\r?\n/).map(line => /^(stash@\{\d+\}) ([a-f0-9]{40,64})$/.exec(line)).find(match => match?.[2] === stashOid);
      if (row) await this._git(['stash', 'drop', row[1]]);
    }
    this._operation = null; await fs.unlink(this._operationFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // Snapshots deliberately survive a successful sync as recovery copies.
  }
  async disconnect() {
    await this._ensureInit(); this._enabled = false; this._generation++; clearTimeout(this._timer); clearTimeout(this._exportTimer); this._exportTimer = null;
    this._controller.abort(); await this.tools.cancel?.();
    await Promise.allSettled([this._connecting, this._syncing].filter(Boolean));
    this._setStatus({ state: 'disconnected', onboarding: null, error: null }); await this._saveState(); return this.status;
  }
  async close() {
    this._closed = true; this._generation++; clearTimeout(this._timer); clearTimeout(this._exportTimer); this.store.off('change', this._storeListener);
    this._controller.abort(); await this.tools.cancel?.();
    await Promise.allSettled([this._connecting, this._syncing].filter(Boolean));
    await this._exportQueue; await this._stateQueue;
    if (this.tools.onProgress === this._progress) this.tools.onProgress = this._previousProgress;
  }
}

module.exports = { GitHubSync, DAY };
