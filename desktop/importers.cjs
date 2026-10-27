'use strict';

// Imports are prepared in a private staging directory. No source is written to,
// no exported script/plugin is executed, and the caller commits the returned
// snapshot only after every file has been read, converted and stored as a blob.
const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const { validateSnapshot } = require('./storage.cjs');

const IMPORT_LIMITS = Object.freeze({ entries: 20000, totalBytes: 1024 ** 3, fileBytes: 256 * 1024 ** 2, textBytes: 16 * 1024 ** 2, archiveDepth: 3 });
const IGNORED = new Set(['.git', 'node_modules', '.trash']);
const MARKDOWN = new Set(['.md', '.markdown']);
const NOTE_FORMATS = { '.md': 'markdown', '.markdown': 'markdown', '.html': 'html', '.htm': 'html', '.csv': 'csv', '.canvas': 'canvas', '.base': 'base' };
const MIME = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.canvas': 'application/json', '.base': 'text/yaml', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip' };
const UUID_SUFFIX = /[ _-]([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:_all)?$/i;
const UUID_ANY = /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?=[^a-f0-9]|$)/i;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const normalized = value => String(value).normalize('NFC').toLocaleLowerCase('en-US');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const withoutExtension = name => name.slice(0, name.length - path.posix.extname(name).length);
const readablePath = (value, source) => source === 'notion' ? value.split('/').map(part => part.replace(UUID_SUFFIX, '').trim() || part).join('/') : value;
const errorWith = (code, message) => Object.assign(new Error(message), { code });
const tooLarge = message => errorWith('NOTES_IMPORT_LIMIT', message);
const isoDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined; };
const safeDecode = value => { try { return decodeURIComponent(value); } catch { return value; } };

function limitsOf(options) {
  const limits = { ...IMPORT_LIMITS };
  // A host/test may lower a limit, but cannot remove the import safety bounds.
  for (const [key, value] of Object.entries(options || {})) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new TypeError('Limite de importação inválido: ' + key);
    limits[key] = value;
  }
  return limits;
}

function zipPath(name) {
  if (typeof name !== 'string' || !name || /[\\\u0000-\u001f\u007f:]/.test(name) || name.startsWith('/')) throw errorWith('NOTES_IMPORT_UNSAFE_ZIP', 'Caminho inseguro no ZIP: ' + JSON.stringify(name));
  const directory = name.endsWith('/'), parts = (directory ? name.slice(0, -1) : name).split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw errorWith('NOTES_IMPORT_UNSAFE_ZIP', 'Caminho inseguro no ZIP: ' + JSON.stringify(name));
  return { name: parts.join('/'), directory, parts };
}

function exclude(ctx, relativePath, reason) {
  ctx.report.excluded.push({ path: relativePath, reason });
}

function countEntry(ctx) {
  if (++ctx.entries > ctx.limits.entries) throw tooLarge('A importação excede o limite de ' + ctx.limits.entries + ' entradas.');
}

function reserveFile(ctx, relativePath, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > ctx.limits.fileBytes) throw tooLarge('Arquivo excede o limite permitido: ' + relativePath);
  if (ctx.bytes + size > ctx.limits.totalBytes) throw tooLarge('A importação excede o limite total de bytes.');
  const key = normalized(relativePath);
  if (ctx.paths.has(key)) throw errorWith('NOTES_IMPORT_DUPLICATE_PATH', 'O arquivo aparece mais de uma vez na exportação: ' + relativePath);
  ctx.paths.add(key);
  ctx.bytes += size;
}

async function captureStream(ctx, stream, metadata) {
  const absolutePath = path.join(ctx.staging, 'payload', String(++ctx.sequence));
  let bytes = 0, crc = 0xffffffff;
  const guard = new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    if (bytes > metadata.size || bytes > ctx.limits.fileBytes) done(tooLarge('O tamanho real do arquivo excede o permitido: ' + metadata.relativePath));
    else {
      if (metadata.crc32 !== undefined) for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
      done(null, chunk);
    }
  } });
  await pipeline(stream, guard, createWriteStream(absolutePath, { flags: 'wx' }));
  if (bytes !== metadata.size) throw errorWith('NOTES_IMPORT_SOURCE_CHANGED', 'O arquivo mudou durante a importação: ' + metadata.relativePath);
  if (metadata.crc32 !== undefined && ((crc ^ 0xffffffff) >>> 0) !== metadata.crc32) throw errorWith('NOTES_IMPORT_CORRUPT_ZIP', 'Checksum do arquivo ZIP inválido: ' + metadata.relativePath);
  const file = { ...metadata, absolutePath };
  ctx.files.push(file);
  ctx.progress('scan', metadata.relativePath);
  return file;
}

async function captureDirectory(ctx, root) {
  const visit = async (directory, relativeDirectory) => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      countEntry(ctx);
      const absolutePath = path.join(directory, entry.name), relativePath = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name;
      if (IGNORED.has(entry.name.toLowerCase())) { exclude(ctx, relativePath, 'ignored-directory'); continue; }
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) { exclude(ctx, relativePath, 'symbolic-link-or-junction'); continue; }
      const realPath = await fs.realpath(absolutePath);
      if (!samePath(realPath, absolutePath)) throw errorWith('NOTES_IMPORT_SOURCE_CHANGED', 'Um caminho foi redirecionado durante a importação: ' + relativePath);
      if (stat.isDirectory()) { await visit(absolutePath, relativePath); continue; }
      if (!stat.isFile()) { exclude(ctx, relativePath, 'unsupported-file-type'); continue; }
      reserveFile(ctx, relativePath, stat.size);
      const handle = await fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || !samePath(await fs.realpath(absolutePath), absolutePath)) throw errorWith('NOTES_IMPORT_SOURCE_CHANGED', 'O arquivo mudou durante a importação: ' + relativePath);
        await captureStream(ctx, handle.createReadStream({ autoClose: false }), { relativePath, size: stat.size, modifiedAt: isoDate(stat.mtime), createdAt: isoDate(stat.birthtime), depth: 0 });
        const afterRead = await handle.stat();
        if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) throw errorWith('NOTES_IMPORT_SOURCE_CHANGED', 'O arquivo mudou durante a importação: ' + relativePath);
      } finally { await handle.close(); }
    }
  };
  await visit(root, '');
}

async function captureZip(ctx, inputPath, prefix = '', depth = 1) {
  const zip = await new Promise((resolve, reject) => yauzl.open(inputPath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  return new Promise((resolve, reject) => {
    let settled = false, activeStream;
    const fail = error => {
      if (settled) return;
      settled = true;
      activeStream?.destroy(error);
      zip.close();
      reject(error);
    };
    zip.on('error', fail);
    zip.on('entry', entry => {
      Promise.resolve().then(async () => {
        countEntry(ctx);
        const item = zipPath(entry.fileName), relativePath = prefix ? prefix + '/' + item.name : item.name;
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000 || (entry.externalFileAttributes & 0x400)) throw errorWith('NOTES_IMPORT_UNSAFE_ZIP', 'Link simbólico ou junction não permitido no ZIP: ' + relativePath);
        if (entry.generalPurposeBitFlag & 1) throw errorWith('NOTES_IMPORT_ENCRYPTED_ZIP', 'O ZIP contém arquivos criptografados. Exporte sem senha para importar.');
        if (item.parts.some(part => IGNORED.has(part.toLowerCase()))) { exclude(ctx, relativePath, 'ignored-directory'); zip.readEntry(); return; }
        if (item.directory) { zip.readEntry(); return; }
        if ((mode & 0xf000) && (mode & 0xf000) !== 0x8000) throw errorWith('NOTES_IMPORT_UNSAFE_ZIP', 'Tipo de arquivo não permitido no ZIP: ' + relativePath);
        reserveFile(ctx, relativePath, entry.uncompressedSize);
        activeStream = await new Promise((yes, no) => zip.openReadStream(entry, (error, stream) => error ? no(error) : yes(stream)));
        const modifiedAt = isoDate(entry.getLastModDate());
        await captureStream(ctx, activeStream, { relativePath, size: entry.uncompressedSize, modifiedAt, depth, crc32: entry.crc32 });
        activeStream = null;
        if (!settled) zip.readEntry();
      }).catch(fail);
    });
    zip.on('end', () => { if (!settled) { settled = true; zip.close(); resolve(); } });
    zip.readEntry();
  });
}

function simpleYamlValue(value) {
  value = value.trim().replace(/\s+#.*$/, '');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function frontmatterOf(text) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  if (!match) return { raw: '', tags: [], aliases: [], values: {} };
  const values = {}, lists = { tags: [], aliases: [] };
  let active;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      active = Object.hasOwn(lists, field[1]) ? field[1] : null;
      values[field[1]] = simpleYamlValue(field[2]);
      if (active && field[2].trim()) lists[active].push(...field[2].trim().replace(/^\[|\]$/g, '').split(',').map(simpleYamlValue).filter(Boolean));
    } else if (active) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item) lists[active].push(simpleYamlValue(item[1]));
      else if (line.trim() && !/^\s*#/.test(line)) active = null;
    }
  }
  return { raw: match[0], tags: [...new Set(lists.tags.map(tag => tag.replace(/^#/, '')))], aliases: [...new Set(lists.aliases)], values };
}

function csvRows(text) {
  text = text.replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows = [], row = [];
  let field = '', quoted = false, closed = false;
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => { endField(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && !field && !closed) quoted = true;
    else if (char === ',') endField();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else if (closed && !/[ \t]/.test(char)) throw errorWith('NOTES_IMPORT_INVALID_CSV', 'CSV inválido: conteúdo depois de aspas de fechamento.');
    else if (!closed) field += char;
  }
  if (quoted) throw errorWith('NOTES_IMPORT_INVALID_CSV', 'CSV inválido: campo com aspas não terminadas.');
  if (field || row.length || closed || !/[\r\n]$/.test(text)) endRow();
  return rows;
}

function csvMarkdown(text, textLimit) {
  const rows = csvRows(text);
  if (!rows.length) return '';
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 1);
  // A sparse, very wide CSV could otherwise expand quadratically when padded
  // into a rectangular Markdown table. Check its minimum size before padding.
  if ((rows.length + 1) * (3 * width + 1) > textLimit) throw tooLarge('A tabela CSV convertida excede o limite de texto.');
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  const render = row => '| ' + Array.from({ length: width }, (_, index) => escape(row[index] || '')).join(' | ') + ' |';
  return [render(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(render)].join('\n');
}

function htmlMarkdown(html) {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  service.use(gfm);
  service.remove(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base', 'noscript', 'template']);
  service.addRule('unsafeLinks', { filter: node => node.nodeName === 'A' && /^(?:javascript|vbscript|data|file):/i.test((node.getAttribute('href') || '').trim()), replacement: content => content });
  service.addRule('unsafeImages', { filter: node => node.nodeName === 'IMG' && /^(?:javascript|vbscript|data|file):/i.test((node.getAttribute('src') || '').trim()), replacement: () => '' });
  return service.turndown(html);
}

function noteFormat(file, source) {
  const extension = path.posix.extname(file.relativePath).toLowerCase();
  if (source === 'obsidian' && file.relativePath.split('/').some(part => part.toLowerCase() === '.obsidian')) return undefined;
  if (source === 'obsidian' && !MARKDOWN.has(extension) && !['.canvas', '.base'].includes(extension)) return undefined;
  if (source === 'notion' && ['.canvas', '.base'].includes(extension)) return undefined;
  return NOTE_FORMATS[extension];
}

function fenced(text, language) {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return fence + language + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence;
}

function addIndex(index, key, value) {
  key = normalized(key);
  if (!key) return;
  const values = index.get(key) || [];
  if (!values.includes(value)) values.push(value);
  index.set(key, values);
}

function indexesOf(notes, files, source) {
  const exact = new Map(), generic = new Map(), assets = new Map(), assetNames = new Map(), uuids = new Map();
  const noteFiles = new Set(notes.map(note => note.file));
  for (const note of notes) {
    const relativePath = note.file.relativePath, noExtension = withoutExtension(relativePath), clean = readablePath(noExtension, source);
    for (const key of [relativePath, noExtension, clean]) addIndex(exact, key, note);
    for (const key of [path.posix.basename(noExtension), path.posix.basename(clean), note.baseTitle, note.title, ...note.frontmatter.aliases]) addIndex(generic, key, note);
    const uuid = path.posix.basename(noExtension).match(UUID_ANY)?.[1];
    if (uuid) addIndex(uuids, uuid.replace(/-/g, ''), note);
  }
  for (const file of files) { addIndex(assets, file.relativePath, file); addIndex(assetNames, path.posix.basename(file.relativePath), file); }
  return { exact, generic, assets, assetNames, uuids, noteFiles };
}

function one(index, keys) {
  for (const key of keys) { const found = index.get(normalized(key)); if (found?.length === 1) return found[0]; }
}

function resolveTarget(value, current, indexes) {
  value = value.trim().replace(/\\([ ()\[\]#|])/g, '$1');
  if (/^notes-asset:/i.test(value)) return { external: true };
  if (/^obsidian:\/\/open\?/i.test(value)) {
    try { value = new URL(value).searchParams.get('file') || value; } catch {}
  }
  if (/^https?:\/\/(?:www\.)?notion\.(?:so|site)\//i.test(value)) {
    const uuid = value.match(UUID_ANY)?.[1];
    const note = uuid && one(indexes.uuids, [uuid.replace(/-/g, '')]);
    return note ? { note, fragment: '', path: value } : { external: true };
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return { external: true };
  const hashAt = value.indexOf('#'), queryAt = value.indexOf('?');
  const boundary = Math.min(...[hashAt, queryAt, value.length].filter(number => number >= 0));
  const fragment = hashAt >= 0 ? safeDecode(value.slice(hashAt + 1)) : '';
  const target = safeDecode(value.slice(0, boundary)).replace(/\\/g, '/').normalize('NFC');
  if (!target) return { note: current, fragment, path: target };
  if (target.startsWith('/') || target.includes('\u0000')) return { missing: true, path: target, fragment };
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(current.file.relativePath), target));
  const root = path.posix.normalize(target);
  const keys = [relative, withoutExtension(relative), root, withoutExtension(root)];
  const exactFile = one(indexes.assets, [relative, root]);
  const extension = path.posix.extname(target).toLowerCase();
  if (exactFile && extension && !indexes.noteFiles.has(exactFile)) return { file: exactFile, fragment, path: target };
  let note = one(indexes.exact, keys);
  if (!note) {
    const uuid = path.posix.basename(target).match(UUID_ANY)?.[1];
    note = uuid && one(indexes.uuids, [uuid.replace(/-/g, '')]);
  }
  if (!note) note = one(indexes.generic, [withoutExtension(target), target, path.posix.basename(withoutExtension(target))]);
  if (note) return { note, fragment, path: target };
  const file = exactFile || one(indexes.assetNames, [path.posix.basename(target)]);
  return file ? { file, fragment, path: target } : { missing: true, path: target, fragment };
}

// Keep frontmatter, fenced code and inline code byte-for-byte while adapting
// actual links. Labels/fragments are retained in imported.links and the raw file.
function rewriteMarkdown(text, note, indexes, ctx) {
  const references = new Map();
  for (const match of text.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[^\r\n]*)$/gm)) references.set(normalized(match[1]), match[2] || match[3]);
  const noteLinks = [], attachments = new Map();
  const adapt = (target, label, image, original) => {
    const resolved = resolveTarget(target, note, indexes);
    if (resolved.external) return original;
    if (resolved.note) {
      noteLinks.push({ target, label, fragment: resolved.fragment, noteId: resolved.note.id, embed: image });
      if (image) ctx.report.embedsConverted++;
      return '[[' + resolved.note.title + ']]';
    }
    if (resolved.file) {
      attachments.set(resolved.file.relativePath, resolved.file);
      return (image ? '!' : '') + '[' + label.replace(/\]/g, '\\]') + '](notes-asset:' + resolved.file.descriptor.hash + ')';
    }
    ctx.report.unresolvedLinkCount++;
    if (ctx.report.unresolvedLinks.length < 1000) ctx.report.unresolvedLinks.push({ from: note.file.relativePath, target, label });
    return original;
  };
  let output = '', offset = 0, fencedMarker = null;
  const lines = text.split(/(?<=\n)/);
  for (const line of lines) {
    if (offset < note.frontmatter.raw.length) { output += line; offset += line.length; continue; }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fencedMarker) {
      output += line;
      if (fence && fence[1][0] === fencedMarker[0] && fence[1].length >= fencedMarker.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fencedMarker = null;
      offset += line.length;
      continue;
    }
    if (fence) { fencedMarker = fence[1]; output += line; offset += line.length; continue; }
    if (/^(?: {4}|\t)/.test(line) || /^ {0,3}\[[^\]]+\]:/.test(line)) { output += line; offset += line.length; continue; }
    let at = 0;
    while (at < line.length) {
      if (line[at] === '\\' && at + 1 < line.length) { output += line.slice(at, at + 2); at += 2; continue; }
      if (line[at] === '`') {
        let endMarker = at + 1;
        while (line[endMarker] === '`') endMarker++;
        const marker = line.slice(at, endMarker), end = line.indexOf(marker, endMarker);
        if (end >= 0) { output += line.slice(at, end + marker.length); at = end + marker.length; continue; }
      }
      const start = at, image = line[at] === '!' && line[at + 1] === '[';
      const bracket = image ? at + 1 : at;
      if (line[bracket] !== '[') { output += line[at++]; continue; }
      if (line[bracket + 1] === '[') {
        const end = line.indexOf(']]', bracket + 2);
        if (end >= 0) {
          const inner = line.slice(bracket + 2, end), pipe = inner.indexOf('|'), target = pipe < 0 ? inner : inner.slice(0, pipe), label = pipe < 0 ? inner : inner.slice(pipe + 1);
          output += adapt(target, label, image, line.slice(start, end + 2)); at = end + 2; continue;
        }
      }
      let close = bracket + 1, nested = 0;
      for (; close < line.length; close++) {
        if (line[close] === '\\') { close++; continue; }
        if (line[close] === '[') nested++;
        if (line[close] === ']' && nested-- === 0) break;
      }
      if (close >= line.length) { output += line[at++]; continue; }
      const label = line.slice(bracket + 1, close);
      if (line[close + 1] === '(') {
        let end = close + 2, balance = 0;
        for (; end < line.length; end++) {
          if (line[end] === '\\') { end++; continue; }
          if (line[end] === '(') balance++;
          if (line[end] === ')' && balance-- === 0) break;
        }
        if (end < line.length) {
          let target = line.slice(close + 2, end).trim();
          if (target.startsWith('<')) target = target.slice(1, target.indexOf('>') < 0 ? undefined : target.indexOf('>'));
          else target = target.replace(/\s+(?:"[^"\r\n]*"|'[^'\r\n]*')\s*$/, '');
          output += adapt(target, label, image, line.slice(start, end + 1)); at = end + 1; continue;
        }
      }
      let end = close + 1, reference = label;
      if (line[end] === '[') { const final = line.indexOf(']', end + 1); if (final >= 0) { reference = line.slice(end + 1, final) || label; end = final + 1; } }
      const target = references.get(normalized(reference));
      if (target !== undefined) { output += adapt(target, label, image, line.slice(start, end)); at = end; continue; }
      output += line.slice(start, close + 1); at = close + 1;
    }
    offset += line.length;
  }
  note.links = noteLinks;
  note.attachments = [...attachments.values()].map(file => file.descriptor);
  return output;
}

async function removeStaging(staging, tempParent) {
  const absolute = path.resolve(staging), parent = path.resolve(tempParent);
  if (!path.isAbsolute(staging) || !samePath(path.dirname(absolute), parent) || !/^notes-import-[A-Za-z0-9]+$/.test(path.basename(absolute))) throw new Error('Diretório temporário inválido; limpeza recusada.');
  const stat = await fs.lstat(absolute).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return;
  if (stat.isSymbolicLink()) { await fs.unlink(absolute); return; }
  if (!samePath(await fs.realpath(absolute), absolute)) throw new Error('O diretório temporário foi redirecionado; limpeza recusada.');
  await fs.rm(absolute, { recursive: true, force: true });
}

async function importWorkspace({ source, inputPath, snapshot, assets, onProgress, limits: customLimits } = {}) {
  if (!['notion', 'obsidian'].includes(source)) throw new TypeError('Escolha Notion ou Obsidian para importar.');
  if (typeof inputPath !== 'string' || !inputPath || !path.isAbsolute(inputPath)) throw new TypeError('Selecione um diretório ou ZIP com caminho absoluto.');
  if (!assets || typeof assets.addFile !== 'function') throw new TypeError('O armazenamento de anexos é obrigatório.');
  const next = validateSnapshot(snapshot), limits = limitsOf(customLimits);
  const inputStat = await fs.lstat(inputPath);
  if (inputStat.isSymbolicLink()) throw errorWith('NOTES_IMPORT_UNSAFE_SOURCE', 'Selecione a pasta original; links e junctions não são seguidos.');
  const absoluteInput = await fs.realpath(inputPath);
  if (!inputStat.isDirectory() && !(inputStat.isFile() && path.extname(inputPath).toLowerCase() === '.zip')) throw new TypeError('Selecione uma pasta exportada ou um arquivo ZIP.');
  if (inputStat.isFile() && inputStat.size > limits.totalBytes) throw tooLarge('O ZIP excede o limite total da importação.');
  const tempParent = await fs.realpath(os.tmpdir()), staging = await fs.mkdtemp(path.join(tempParent, 'notes-import-'));
  const importedAt = new Date().toISOString();
  const report = { source, notes: 0, sessions: 0, files: 0, bytes: 0, archiveNotes: 0, nestedArchives: 0, embedsConverted: 0, warnings: [], excluded: [], unresolvedLinks: [], unresolvedLinkCount: 0, importedAt };
  const ctx = { staging, source, limits, report, files: [], paths: new Set(), entries: 0, bytes: 0, sequence: 0, progress(stage, current) { if (typeof onProgress === 'function') onProgress({ stage, files: this.files.length, current: current || '', total: stage === 'scan' ? null : this.files.length }); } };
  try {
    await fs.mkdir(path.join(staging, 'payload'));
    if (inputStat.isDirectory()) await captureDirectory(ctx, absoluteInput);
    else await captureZip(ctx, absoluteInput);
    if (source === 'notion') {
      for (let index = 0; index < ctx.files.length; index++) {
        const file = ctx.files[index];
        if (path.posix.extname(file.relativePath).toLowerCase() !== '.zip') continue;
        if (file.depth >= limits.archiveDepth) { report.warnings.push('ZIP interno preservado sem expansão por atingir a profundidade máxima: ' + file.relativePath); continue; }
        report.nestedArchives++;
        await captureZip(ctx, file.absolutePath, file.relativePath + ' (conteúdo)', file.depth + 1);
      }
    }
    ctx.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en', { numeric: true }));
    const prepared = [];
    for (const file of ctx.files) {
      const format = noteFormat(file, source);
      if (!format) continue;
      if (file.size > limits.textBytes) throw tooLarge('Nota excede o limite de texto de ' + limits.textBytes + ' bytes: ' + file.relativePath);
      const buffer = await fs.readFile(file.absolutePath);
      // Reject invalid encodings instead of replacing characters in a note.
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
      catch { throw errorWith('NOTES_IMPORT_ENCODING', 'O arquivo deve estar em UTF-8: ' + file.relativePath); }
      const frontmatter = frontmatterOf(format === 'markdown' ? text : '');
      let body = text;
      if (format === 'html') body = htmlMarkdown(text);
      if (format === 'csv') body = csvMarkdown(text, limits.textBytes);
      if (format === 'canvas' || format === 'base') body = fenced(text, format === 'canvas' ? 'json' : 'yaml');
      if (Buffer.byteLength(body, 'utf8') > limits.textBytes) throw tooLarge('A nota convertida excede o limite de texto: ' + file.relativePath);
      const baseTitle = readablePath(withoutExtension(path.posix.basename(file.relativePath)), source).trim() || 'Sem título';
      const item = { file, format, frontmatter, body, baseTitle, id: 'import-note-' + crypto.randomUUID() };
      prepared.push(item);
      ctx.progress('convert', file.relativePath);
    }
    const titleCounts = new Map(), takenTitles = new Set(next.notes.map(note => normalized(note.title)));
    for (const item of prepared) titleCounts.set(normalized(item.baseTitle), (titleCounts.get(normalized(item.baseTitle)) || 0) + 1);
    for (const item of prepared) {
      const suffix = readablePath(withoutExtension(item.file.relativePath), source);
      let title = titleCounts.get(normalized(item.baseTitle)) > 1 || takenTitles.has(normalized(item.baseTitle)) ? item.baseTitle + ' · ' + suffix : item.baseTitle;
      let count = 2, candidate = title;
      while (takenTitles.has(normalized(candidate))) candidate = title + ' (' + count++ + ')';
      item.title = candidate; takenTitles.add(normalized(candidate));
    }
    // Store original bytes for *every* file, including config, unknown formats,
    // orphan resources and nested ZIPs. Existing content hashes can be reused.
    for (const file of ctx.files) {
      file.descriptor = await assets.addFile(file.absolutePath, { name: path.posix.basename(file.relativePath), relativePath: file.relativePath, mime: MIME[path.posix.extname(file.relativePath).toLowerCase()] || 'application/octet-stream' });
      if (!file.descriptor || !/^[a-f0-9]{64}$/.test(file.descriptor.hash)) throw new Error('O armazenamento devolveu um anexo inválido.');
      ctx.progress('assets', file.relativePath);
    }
    const indexes = indexesOf(prepared, ctx.files, source), sessionMap = new Map();
    const sourceName = source === 'notion' ? 'Notion' : 'Obsidian';
    const inputName = path.basename(inputPath).replace(/\.zip$/i, '') || sourceName;
    const groupBase = sourceName + ' · ' + inputName;
    let groupName = groupBase, groupCount = 2;
    while (next.groups.some(group => normalized(group.name) === normalized(groupName))) groupName = groupBase + ' (' + groupCount++ + ')';
    const group = { id: 'import-group-' + crypto.randomUUID(), name: groupName, color: source === 'notion' ? '#A9A9B3' : '#A78BFA', sessions: [], imported: { source, importedAt } };
    const getSession = directory => {
      if (!sessionMap.has(directory)) {
        const session = { id: 'import-session-' + crypto.randomUUID(), name: directory === '.' ? 'Notas' : readablePath(directory, source).replace(/\//g, ' / '), imported: { source, path: directory } };
        group.sessions.push(session); sessionMap.set(directory, session);
      }
      return sessionMap.get(directory);
    };
    const importedNotes = [];
    for (const item of prepared) {
      const body = ['markdown', 'html', 'csv'].includes(item.format) ? rewriteMarkdown(item.body, item, indexes, ctx) : item.body;
      if (Buffer.byteLength(body, 'utf8') > limits.textBytes) throw tooLarge('A nota convertida excede o limite de texto: ' + item.file.relativePath);
      const modifiedAt = isoDate(item.frontmatter.values.updated || item.frontmatter.values.modified || item.frontmatter.values.updated_at) || item.file.modifiedAt;
      const createdAt = isoDate(item.frontmatter.values.created || item.frontmatter.values.created_at || item.frontmatter.values.date) || item.file.createdAt;
      const imported = { source, path: item.file.relativePath, format: item.format, importedAt, originalHash: item.file.descriptor.hash, ...(modifiedAt ? { modifiedAt } : {}), ...(createdAt ? { createdAt } : {}), ...(item.frontmatter.raw ? { frontmatter: item.frontmatter.raw } : {}), ...(item.frontmatter.aliases.length ? { aliases: item.frontmatter.aliases } : {}), ...(item.links?.length ? { links: item.links } : {}) };
      importedNotes.push({ id: item.id, s: getSession(path.posix.dirname(item.file.relativePath)).id, title: item.title, body, t: (modifiedAt || importedAt).slice(0, 10), imported, ...(item.frontmatter.tags.length ? { tags: item.frontmatter.tags } : {}), ...(item.attachments?.length ? { attachments: item.attachments } : {}) });
    }
    const archiveSession = { id: 'import-session-' + crypto.randomUUID(), name: 'Arquivos da importação', imported: { source, archive: true } };
    group.sessions.push(archiveSession);
    const manifest = { id: 'import-note-' + crypto.randomUUID(), s: archiveSession.id, title: 'Arquivos da importação · ' + groupName, body: '# Arquivos da importação\n\nOriginais preservados de ' + sourceName + '. Os anexos mantêm os bytes e os caminhos da exportação, incluindo configurações e recursos sem referências. Plugins e scripts são guardados como arquivos, sem execução.\n\n' + ctx.files.map(file => '- [' + file.relativePath.replace(/[\[\]\\]/g, '\\$&') + '](notes-asset:' + file.descriptor.hash + ')').join('\n'), t: importedAt.slice(0, 10), imported: { source, archive: true, importedAt, files: ctx.files.map(file => ({ path: file.relativePath, hash: file.descriptor.hash, ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}), ...(file.createdAt ? { createdAt: file.createdAt } : {}) })) }, attachments: ctx.files.map(file => file.descriptor) };
    next.groups.push(group);
    next.notes.push(...importedNotes, manifest);
    next.expanded = { ...(next.expanded || {}), [group.id]: true };
    if (importedNotes.length) {
      next.session = importedNotes[0].s; next.view = 'session'; next.tag = null;
      next.openBy = { ...(next.openBy || {}), [importedNotes[0].s]: [importedNotes[0].id] };
      next.focusBy = { ...(next.focusBy || {}), [importedNotes[0].s]: importedNotes[0].id };
    }
    report.notes = importedNotes.length; report.sessions = group.sessions.length; report.files = ctx.files.length; report.bytes = ctx.bytes; report.archiveNotes = 1; report.groupId = group.id;
    if (report.excluded.length) report.warnings.push(report.excluded.length + ' caminhos ignorados (.git, node_modules, .trash, links/junctions ou tipos especiais). Consulte a lista de exclusões.');
    if (report.unresolvedLinkCount) report.warnings.push(report.unresolvedLinkCount + ' links locais não puderam ser resolvidos. O texto original e os arquivos foram preservados.');
    if (report.embedsConverted) report.warnings.push(report.embedsConverted + ' incorporações de notas foram convertidas em links internos. Os originais preservam a sintaxe completa.');
    manifest.imported.report = structuredClone(report);
    if (report.warnings.length || report.excluded.length || report.unresolvedLinkCount) {
      manifest.body += '\n\n## Relatório da importação\n\n' + report.warnings.map(text => '- ' + text).join('\n');
      if (report.excluded.length) manifest.body += '\n\n### Caminhos não importados\n' + report.excluded.map(item => '- ' + item.path + ': ' + item.reason).join('\n');
      if (report.unresolvedLinks.length) manifest.body += '\n\n### Links não resolvidos\n```json\n' + JSON.stringify(report.unresolvedLinks, null, 2) + '\n```';
    }
    const result = { snapshot: validateSnapshot(next), report };
    ctx.progress('complete');
    return result;
  } finally { await removeStaging(staging, tempParent); }
}

module.exports = { importWorkspace, IMPORT_LIMITS };
