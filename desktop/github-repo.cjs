'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, validateRevision } = require('./storage.cjs');

const MARKER = '.notes-repository.json';
const FORMAT = 'notes-github-library';
const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40,64}$/;
const MAX_FILE = 100 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_ASSET = 256 * 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const utf8 = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } };
function failure(message, code = 'GITHUB_REPOSITORY') { const error = new Error(message); error.code = code; return error; }
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || value.includes('\0')) throw failure('Caminho inválido no repositório.', 'GITHUB_UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part) || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || Buffer.byteLength(part) > 255)) throw failure('O repositório contém um caminho incompatível com o Windows.', 'GITHUB_UNSAFE_PATH');
  const basename = parts.at(-1).toLowerCase();
  if (['.gitmodules', '.git-credentials', '.npmrc', '.env', 'hosts.yml', 'device.json', 'github-sync-state.json', 'google-drive-sync-state.json', 'google-drive-auth.json', 'tokens.json', 'token.json', 'credentials.json', 'credentials.yml', 'id_rsa', 'id_ed25519'].includes(basename)
    || /^(?:\.notes-tools|notes-tools|notes-data|\.notes-device)$/i.test(parts[0]) || /\.(?:pem|key)$/i.test(basename)) {
    throw failure('Um arquivo reservado a credenciais ou configurações do dispositivo está na pasta da biblioteca. Mova-o para fora antes de sincronizar.', 'GITHUB_SENSITIVE_FILE');
  }
  return value;
}
async function rejectLinks(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute); let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw failure('A biblioteca não pode conter links simbólicos ou junções.', 'GITHUB_UNSAFE_PATH');
  }
}
function marker(value) {
  if (!value || value.format !== FORMAT || value.version !== 1 || typeof value.libraryId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.libraryId)
    || Object.keys(value).some(key => !['format', 'version', 'libraryId'].includes(key))) throw failure('O repositório não é uma biblioteca notes válida.', 'GITHUB_INVALID_MARKER');
  return value;
}
function parseJSON(bytes, label) {
  const text = utf8(bytes); if (text === null) throw failure(label + ' não usa texto UTF-8 válido.', 'GITHUB_INVALID_DATA');
  try { return JSON.parse(text); } catch { throw failure(label + ' contém JSON inválido.', 'GITHUB_INVALID_DATA'); }
}
async function writeBytes(file, content) {
  await rejectLinks(file); await fs.mkdir(path.dirname(file), { recursive: true }); await rejectLinks(file);
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, content, { flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

class GitRepository {
  constructor({ directory, tools, signal }) { this.directory = directory; this.tools = tools; this.signal = signal; this._blobs = new Map(); this._blobBytes = 0; }
  git(args, options = {}) { return this.tools.git(args, { cwd: this.directory, signal: this.signal, ...options }); }
  async ensureDirectory() {
    await rejectLinks(this.directory); await fs.mkdir(this.directory, { recursive: true });
    const stat = await fs.lstat(this.directory); if (!stat.isDirectory()) throw failure('A pasta da biblioteca não é um diretório.', 'GITHUB_UNSAFE_PATH');
    for (const name of ['.git', '.git/config', '.git/objects', '.git/refs']) await rejectLinks(path.join(this.directory, name));
    const dotGit = await fs.lstat(path.join(this.directory, '.git')).catch(() => null);
    if (dotGit && !dotGit.isDirectory()) throw failure('A biblioteca não pode usar um worktree ou Git externo.', 'GITHUB_UNSAFE_PATH');
    for (const name of ['commondir', 'gitdir']) if (await fs.lstat(path.join(this.directory, '.git', name)).catch(() => null)) throw failure('O repositório usa arquivos Git externos não permitidos.', 'GITHUB_UNSAFE_PATH');
    if (dotGit) {
      let metadataEntries = 0;
      const check = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (++metadataEntries > 200000) throw failure('Os metadados Git excedem o limite de segurança.', 'GITHUB_UNSAFE_PATH');
          const filename = path.join(directory, entry.name), stat = await fs.lstat(filename);
          if (stat.isSymbolicLink()) throw failure('Os metadados Git não podem conter links ou junções.', 'GITHUB_UNSAFE_PATH');
          if (stat.isDirectory()) await check(filename);
          else if (!stat.isFile()) throw failure('Os metadados Git precisam ser arquivos regulares.', 'GITHUB_UNSAFE_PATH');
        }
      };
      await check(path.join(this.directory, '.git'));
      const alternates = await fs.readFile(path.join(this.directory, '.git', 'objects', 'info', 'alternates')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (alternates?.length) throw failure('A biblioteca não pode usar objetos de outro repositório.', 'GITHUB_UNSAFE_PATH');
    }
  }
  async head(ref = 'HEAD') {
    const result = await this.git(['rev-parse', '--verify', ref], { allowFailure: true });
    const oid = result.stdout.trim(); return result.code === 0 && OID.test(oid) ? oid : null;
  }
  async read(entry) {
    if (!entry) return null;
    if (entry.content !== undefined) return entry.content;
    if (!OID.test(entry.oid)) throw failure('Identificador Git inválido.', 'GITHUB_INVALID_DATA');
    if (this._blobs.has(entry.oid)) { entry.content = this._blobs.get(entry.oid); return entry.content; }
    const size = entry.size === undefined ? Number((await this.git(['cat-file', '-s', entry.oid])).stdout.trim()) : entry.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw failure('O arquivo ' + entry.path + ' excede 100 MiB. Seus dados foram preservados.', 'GITHUB_FILE_TOO_LARGE');
    const result = await this.git(['cat-file', 'blob', entry.oid], { binary: true, outputLimit: MAX_FILE + 1 });
    if (result.stdout.length !== size) throw failure('Um arquivo Git está incompleto.', 'GITHUB_INVALID_DATA');
    entry.content = result.stdout;
    if (size <= 262144 && this._blobBytes + size <= 32 * 1024 * 1024) { this._blobs.set(entry.oid, entry.content); this._blobBytes += size; }
    return entry.content;
  }
  async tree(ref) {
    const result = new Map(); if (!ref) return result;
    if (!OID.test(ref)) throw failure('Referência Git inválida.', 'GITHUB_INVALID_DATA');
    const listing = await this.git(['ls-tree', '-rzl', '--full-tree', ref], { binary: true });
    const text = utf8(listing.stdout); if (text === null) throw failure('Um caminho Git não usa UTF-8 válido.', 'GITHUB_UNSAFE_PATH');
    const lower = new Set();
    for (const row of text.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\s+([0-9]+|-)\t([\s\S]+)$/.exec(row);
      if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw failure('Links simbólicos e submódulos não são aceitos na biblioteca.', 'GITHUB_UNSAFE_TREE');
      const name = relativePath(match[5]), size = Number(match[4]);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) throw failure('O arquivo ' + name + ' excede 100 MiB. Seus dados foram preservados.', 'GITHUB_FILE_TOO_LARGE');
      if (result.size >= 100000 || lower.has(name.toLowerCase())) throw failure('O repositório contém caminhos duplicados ou arquivos demais.', 'GITHUB_UNSAFE_TREE');
      lower.add(name.toLowerCase()); result.set(name, { path: name, mode: match[1], oid: match[3], size });
    }
    return result;
  }
  async working() {
    await this.ensureDirectory(); const result = new Map(), lower = new Set();
    const walk = async (directory, prefix = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') continue;
        const name = relativePath(prefix + entry.name), file = path.join(directory, entry.name), stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw failure('Links simbólicos e junções não são aceitos na biblioteca.', 'GITHUB_UNSAFE_TREE');
        if (stat.isDirectory()) await walk(file, name + '/');
        else {
          if (!stat.isFile()) throw failure('A biblioteca aceita somente arquivos regulares.', 'GITHUB_UNSAFE_TREE');
          if (stat.size > MAX_FILE) throw failure('O arquivo ' + name + ' excede 100 MiB. Seus dados foram preservados.', 'GITHUB_FILE_TOO_LARGE');
          if (result.size >= 100000 || lower.has(name.toLowerCase())) throw failure('Há caminhos duplicados ou arquivos demais na biblioteca.', 'GITHUB_UNSAFE_TREE');
          lower.add(name.toLowerCase()); result.set(name, { path: name, mode: '100644', content: await fs.readFile(file) });
        }
      }
    };
    await walk(this.directory); return result;
  }
  async writeTree(desired, current) {
    const check = async (name, file) => {
      await rejectLinks(file);
      const actual = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), expected = current.get(name)?.content || null;
      if (actual === null ? expected !== null : expected === null || !actual.equals(expected)) throw failure('Um arquivo local mudou durante a sincronização: ' + name + '. A nova versão foi preservada.', 'GITHUB_CONFLICT_STALE');
    };
    for (const name of current.keys()) if (!desired.has(name)) { const file = path.join(this.directory, ...relativePath(name).split('/')); await check(name, file); await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    for (const [name, entry] of desired) {
      const file = path.join(this.directory, ...relativePath(name).split('/')), content = await this.read(entry);
      if (current.get(name)?.content?.equals(content)) continue;
      await check(name, file);
      await writeBytes(file, content);
    }
  }
  async mergeText(base, local, remote, scratch) {
    const folder = path.join(scratch, 'merge-' + crypto.randomUUID()); await fs.mkdir(folder, { recursive: true });
    try {
      const files = ['local', 'base', 'remote'].map(name => path.join(folder, name));
      for (const [index, content] of [local, base, remote].entries()) await fs.writeFile(files[index], content, { flag: 'wx' });
      const result = await this.git(['merge-file', '-p', '--diff3', ...files], { allowFailure: true, binary: true, outputLimit: MAX_FILE + 1 });
      if (result.code === 0) return result.stdout;
      if (result.code > 0 && result.code <= 127) return null;
      throw failure('Não foi possível comparar as versões do arquivo.', 'GITHUB_DIFF_FAILED');
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  }
}

async function putImmutable(file, content) {
  await rejectLinks(file);
  const existing = await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) { if (!existing.equals(content)) throw failure('Um arquivo imutável da biblioteca foi alterado. Nenhum dado foi sobrescrito.', 'GITHUB_INTEGRITY'); return; }
  await writeBytes(file, content);
}
async function exportLibrary({ repository, store, assets, libraryId }) {
  await repository.ensureDirectory(); const root = repository.directory;
  const mark = { format: FORMAT, version: 1, libraryId };
  const previous = await fs.readFile(path.join(root, MARKER)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous && marker(parseJSON(previous, 'O marcador')).libraryId !== libraryId) throw failure('A pasta pertence a outra biblioteca notes.', 'GITHUB_INVALID_MARKER');
  if (!previous) await writeBytes(path.join(root, MARKER), Buffer.from(JSON.stringify(mark, null, 2) + '\n'));
  const records = store.exportRevisions(), descriptors = new Map();
  for (const record of records) if (!record.deleted && record.kind === 'note') for (const file of record.value.data.attachments || []) {
    const previous = descriptors.get(file.hash);
    if (previous && previous.size !== file.size) throw failure('Metadados incompatíveis para o mesmo anexo.', 'GITHUB_INTEGRITY');
    descriptors.set(file.hash, file);
  }
  // Blobs are complete and verified before their revisions are exported.
  for (const [hash, descriptor] of descriptors) {
    const source = await assets.file(hash), stat = await fs.stat(source);
    if (stat.size !== descriptor.size || stat.size > MAX_ASSET) throw failure('O tamanho do anexo não corresponde à biblioteca.', 'GITHUB_INTEGRITY');
    const chunks = [], handle = await fs.open(source, 'r');
    try {
      let offset = 0;
      do {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, stat.size - offset)));
        let bytes = 0;
        while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, offset + bytes); if (!read.bytesRead) throw failure('Um anexo está incompleto.', 'GITHUB_INTEGRITY'); bytes += read.bytesRead; }
        const chunk = { hash: sha(buffer), size: buffer.length }; chunks.push(chunk);
        await putImmutable(path.join(root, 'assets', 'chunks', chunk.hash), buffer); offset += buffer.length;
      } while (offset < stat.size);
    } finally { await handle.close(); }
    await putImmutable(path.join(root, 'assets', 'manifests', hash + '.json'), Buffer.from(JSON.stringify({ format: 'notes-asset', version: 1, hash, size: descriptor.size, chunks }) + '\n'));
  }
  for (const record of records) await putImmutable(path.join(root, 'revisions', record.id + '.json'), Buffer.from(JSON.stringify(record) + '\n'));
  return records;
}
async function readRevisions(repository, tree) {
  const records = [];
  for (const [name, entry] of tree) {
    if (!name.startsWith('revisions/')) continue;
    const match = /^revisions\/([a-f0-9]{64})\.json$/.exec(name);
    if (!match) throw failure('Há um arquivo desconhecido na pasta reservada de revisões.', 'GITHUB_INVALID_DATA');
    const record = validateRevision(parseJSON(await repository.read(entry), 'Uma revisão'));
    if (record.id !== match[1]) throw failure('O nome e o checksum de uma revisão não correspondem.', 'GITHUB_INTEGRITY');
    records.push(record);
  }
  return records;
}
async function importAssets(repository, tree, records, assets, scratch) {
  const descriptors = new Map();
  for (const record of records) if (!record.deleted && record.kind === 'note') for (const file of record.value.data.attachments || []) {
    const previous = descriptors.get(file.hash);
    if (previous && previous.size !== file.size) throw failure('Metadados incompatíveis para o mesmo anexo remoto.', 'GITHUB_INTEGRITY');
    descriptors.set(file.hash, file);
  }
  for (const [hash, descriptor] of descriptors) {
    let local = false; try { const filename = await assets.file(hash); local = (await fs.stat(filename)).size === descriptor.size; } catch (error) { if (!/ainda não está disponível/.test(error.message)) throw error; }
    // Even cached assets must validate a supplied remote manifest/chunks. A
    // corrupted remote tree must not be acknowledged as fully synchronized.
    const entry = tree.get('assets/manifests/' + hash + '.json');
    if (!entry) { if (local) continue; throw failure('Um anexo remoto está incompleto.', 'GITHUB_INTEGRITY'); }
    const manifest = parseJSON(await repository.read(entry), 'O manifesto de anexo');
    if (manifest.format !== 'notes-asset' || manifest.version !== 1 || manifest.hash !== hash || manifest.size !== descriptor.size || manifest.size > MAX_ASSET
      || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 8
      || manifest.chunks.some(chunk => !chunk || !HASH.test(chunk.hash) || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || chunk.size > CHUNK_BYTES)
      || manifest.chunks.reduce((sum, chunk) => sum + chunk.size, 0) !== manifest.size) throw failure('O manifesto de anexo é inválido.', 'GITHUB_INTEGRITY');
    const temporary = path.join(scratch, 'asset-' + crypto.randomUUID()), handle = await fs.open(temporary, 'wx'), digest = crypto.createHash('sha256');
    try {
      for (const chunk of manifest.chunks) {
        const part = tree.get('assets/chunks/' + chunk.hash);
        if (!part) throw failure('Um bloco de anexo está ausente.', 'GITHUB_INTEGRITY');
        const content = await repository.read(part);
        if (content.length !== chunk.size || sha(content) !== chunk.hash) throw failure('O checksum de um bloco do anexo é inválido.', 'GITHUB_INTEGRITY');
        digest.update(content); if (!local) await handle.writeFile(content);
      }
      if (digest.digest('hex') !== hash) throw failure('O checksum do anexo completo é inválido.', 'GITHUB_INTEGRITY');
      await handle.close();
      if (!local) { const result = await assets.addFile(temporary, { name: descriptor.name, relativePath: descriptor.relativePath, mime: descriptor.mime }); if (result.hash !== hash || result.size !== descriptor.size) throw failure('O anexo reconstruído é inválido.', 'GITHUB_INTEGRITY'); }
    } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
}

module.exports = { GitRepository, exportLibrary, readRevisions, importAssets, relativePath, rejectLinks, marker, parseJSON, writeBytes,
  MARKER, FORMAT, HASH, OID, MAX_FILE, CHUNK_BYTES, MAX_ASSET, sha, utf8, failure };
