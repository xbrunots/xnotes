'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { importWorkspace, IMPORT_LIMITS } = require('../desktop/importers.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const seed = () => ({ groups: [{ id: 'existing-group', name: 'Existente', sessions: [{ id: 'existing-session', name: 'Minha sessão' }] }], notes: [{ id: 'existing-note', s: 'existing-session', title: 'Original', body: 'Conservar exatamente.', t: 'Agora' }], customPreference: { nested: [1, 'preservar'] }, openBy: { 'existing-session': ['existing-note'] }, focusBy: { 'existing-session': 'existing-note' } });
const contentNotes = snapshot => snapshot.notes.filter(note => note.imported && !note.imported.archive);
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'notes-import-test-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), parent);
    assert.match(path.basename(absolute), /^notes-import-test-[A-Za-z0-9]+$/);
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const blobs = new Map(), descriptors = [];
  const assets = { async addFile(file, metadata) {
    const bytes = await fs.readFile(file), hash = sha(bytes);
    blobs.set(hash, bytes);
    const descriptor = { hash, ...metadata, size: bytes.length };
    descriptors.push(descriptor);
    return descriptor;
  } };
  const write = async (relative, bytes) => { const file = path.join(directory, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); return file; };
  return { directory, assets, blobs, descriptors, write };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal stored ZIP writer keeps hostile-name fixtures independent of any ZIP
// writer's sanitization. The importer still reads them with production yauzl.
function zipBuffer(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8'), data = Buffer.from(item.data || '');
    const size = item.declaredSize ?? data.length, crc = item.declaredCRC ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x5000, 10); local.writeUInt16LE(0x5821, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(0x5000, 12); record.writeUInt16LE(0x5821, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((item.mode || 0o100644) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('official Notion app and workspace URLs resolve imported page IDs while unrelated domains and code stay literal', async t => {
  const { directory, assets, write } = await fixture(t);
  const parentId='11111111222243338444555555555555',childId='aaaaaaaabbbb4ccc8dddeeeeeeeeeeee';
  const target='https://app.notion.com/p/'+childId;
  const source='# Entrada\n\n[Filha]('+target+')\n\n[Outra referência](https://equipe.notion.site/'+childId+')\n\n[Externo](https://notion.com.example.invalid/'+childId+')\n\n```text\n[Literal]('+target+')\n```';
  await write('Entrada '+parentId+'.md',source);await write('Filha '+childId+'.md','# Filha\n\nConteúdo da filha.');
  const {snapshot}=await importWorkspace({source:'notion',inputPath:directory,snapshot:seed(),assets});
  const notes=contentNotes(snapshot),parent=notes.find(note=>note.title==='Entrada'),child=notes.find(note=>note.title==='Filha');
  assert.equal(parent.imported.links.length,2);assert.ok(parent.imported.links.every(link=>link.noteId===child.id));
  assert.ok(parent.body.includes('https://notion.com.example.invalid/'+childId));
  assert.ok(parent.body.includes('```text\n[Literal]('+target+')\n```'));
});

test('Obsidian preserves raw files, YAML, Unicode hierarchy, aliases, links, duplicate titles and orphan assets', async t => {
  const { directory, assets, blobs, descriptors, write } = await fixture(t);
  const yaml = '---\ncreated: 2024-02-03\nupdated: 2025-04-05\ntags: [pessoal, "ação"]\naliases:\n  - Entrada\n---\n';
  const start = yaml + '# Início\n[[Projetos/Árvore#Seção|outra legenda]] e [[Raiz]].\n[Plano](Projetos/Plano.md#Detalhe)\n![[assets/foto.png|foto]]\n[Binário](assets/raw.bin), [PDF](Relatório.pdf) e [CSV](Relatório.csv)\n[Perdida](Não-existe.md)\n[Por referência][p]\n[p]: Projetos/Plano.md\n\n`[[Não alterar]]`\n```md\n[[Também não alterar]]\n```\n';
  const files = new Map([
    ['Início.md', Buffer.from(start)], ['Projetos/Árvore.md', Buffer.from('---\naliases: [Raiz]\n---\n# Árvore\nConteúdo português 🌳')],
    ['Projetos/Plano.md', Buffer.from('Plano do projeto')], ['Pessoal/Plano.md', Buffer.from('Plano pessoal')],
    ['Relatório.md', Buffer.from('Nota distinta do PDF')], ['Relatório.pdf', Buffer.from('%PDF-1.7\noriginal')], ['Relatório.csv', Buffer.from('Tabela,original\n1,2')],
    ['assets/foto.png', Buffer.from([137, 80, 78, 71, 0, 255])], ['assets/raw.bin', Buffer.from([0, 1, 255])], ['assets/órfão.bin', Buffer.from([2, 0, 4])],
    ['Quadro.canvas', Buffer.from('{"nodes":[{"id":"a","text":"[[Início]]"}],"edges":[]}')], ['Consultas.base', Buffer.from('filters:\n  and:\n    - file.ext == "md"\n')],
    ['.obsidian/config.json', Buffer.from('{"theme":"moonstone"}')], ['.obsidian/plugins/foo/main.js', Buffer.from('throw new Error("Não executar");')]
  ]);
  for (const [name, bytes] of files) await write(name, bytes);
  await write('.git/objects/ignored', 'git'); await write('node_modules/package/index.js', 'npm'); await write('.trash/Removida.md', 'lixeira');
  const outside = path.join(directory, '.git');
  await fs.symlink(outside, path.join(directory, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = freeze(seed()), before = structuredClone(original), progress = [];
  const { snapshot, report } = await importWorkspace({ source: 'obsidian', inputPath: directory, snapshot: original, assets, onProgress: event => progress.push(event.stage) });
  assert.deepEqual(original, before);
  assert.deepEqual(snapshot.notes.find(note => note.id === 'existing-note'), before.notes[0]);
  assert.deepEqual(snapshot.customPreference, before.customPreference);
  assert.equal(report.files, files.size); assert.equal(report.notes, 7); assert.equal(report.archiveNotes, 1);
  assert.ok(progress.includes('scan') && progress.includes('convert') && progress.includes('assets') && progress.at(-1) === 'complete');
  const notes = contentNotes(snapshot), imported = notes.find(note => note.imported.path === 'Início.md');
  const tree = notes.find(note => note.imported.path === 'Projetos/Árvore.md'), plan = notes.find(note => note.imported.path === 'Projetos/Plano.md');
  assert.ok(imported.body.startsWith(yaml)); assert.deepEqual(imported.tags, ['pessoal', 'ação']);
  assert.equal(imported.imported.frontmatter, yaml); assert.equal(imported.imported.createdAt, '2024-02-03T00:00:00.000Z'); assert.equal(imported.imported.modifiedAt, '2025-04-05T00:00:00.000Z');
  assert.ok(imported.body.includes('[[' + tree.title + ']]')); assert.ok(imported.body.includes('[[' + plan.title + ']]'));
  assert.ok(imported.body.includes('`[[Não alterar]]`')); assert.ok(imported.body.includes('```md\n[[Também não alterar]]\n```'));
  assert.ok(imported.body.includes('[Perdida](Não-existe.md)')); assert.equal(report.unresolvedLinkCount, 1);
  assert.ok(imported.imported.links.some(link => link.label === 'outra legenda' && link.fragment === 'Seção'));
  assert.ok(plan.title.includes('Projetos/Plano')); assert.equal(new Set(snapshot.notes.map(note => note.title)).size, snapshot.notes.length);
  assert.ok(snapshot.groups.at(-1).sessions.some(session => session.name === 'Projetos'));
  assert.deepEqual(new Set(imported.attachments.map(item => item.relativePath)), new Set(['assets/foto.png', 'assets/raw.bin', 'Relatório.pdf', 'Relatório.csv']));
  const image = imported.attachments.find(item => item.relativePath.endsWith('.png'));
  assert.ok(imported.body.includes('![foto](notes-asset:' + image.hash + ')'));
  const manifest = snapshot.notes.find(note => note.imported?.archive);
  assert.equal(manifest.attachments.length, files.size); assert.equal(descriptors.length, files.size);
  for (const [name, bytes] of files) {
    assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes, 'source bytes are unchanged: ' + name);
    const descriptor = manifest.attachments.find(item => item.relativePath === name);
    assert.ok(descriptor, name + ' exists in manifest'); assert.deepEqual(blobs.get(descriptor.hash), bytes);
  }
  assert.ok(report.excluded.some(item => item.path === '.git'));
  assert.ok(report.excluded.some(item => item.path === 'node_modules'));
  assert.ok(report.excluded.some(item => item.path === '.trash'));
  assert.ok(report.excluded.some(item => item.path === 'linked-folder' && item.reason === 'symbolic-link-or-junction'));
});

test('Notion recursively converts Markdown, safe HTML and quoted multiline CSV, stripping UUID suffixes', async t => {
  const { directory, assets, blobs, write } = await fixture(t);
  const pageId = '0123456789abcdef0123456789abcdef', childId = 'abcdef0123456789abcdef0123456789';
  const topPath = 'Projeto ' + pageId + '.md', childPath = 'Projeto ' + pageId + '/Subpágina ' + childId + '.html';
  const top = '# Projeto\n[Subpágina](' + encodeURI(childPath) + '#item)';
  const html = '<!doctype html><html><head><style>hide</style></head><body><h1>Subpágina</h1><p>Ação &amp; contexto</p><a href="../' + encodeURI(topPath) + '">Pai</a><script>globalThis.__notesImportedScript = true;</script><iframe src="https://example.invalid"></iframe><a href="javascript:alert(1)">Link perigoso</a><table><thead><tr><th>Coluna</th></tr></thead><tbody><tr><td>valor</td></tr></tbody></table></body></html>';
  const csv = '"Título","Detalhes","Vazio"\r\n"Item","linha 1\nlinha 2 | x, ""aspas""",""\r\n';
  await write(topPath, top); await write(childPath, html); await write('Banco ' + childId + '_all.csv', csv); await write('resources/órfão.dat', Buffer.from([0, 255]));
  const { snapshot, report } = await importWorkspace({ source: 'notion', inputPath: directory, snapshot: seed(), assets });
  const notes = contentNotes(snapshot), parent = notes.find(note => note.imported.path === topPath), child = notes.find(note => note.imported.path === childPath), database = notes.find(note => note.imported.format === 'csv');
  assert.equal(report.notes, 3); assert.equal(report.files, 4); assert.equal(report.unresolvedLinkCount, 0);
  assert.equal(parent.title, 'Projeto'); assert.equal(child.title, 'Subpágina'); assert.equal(database.title, 'Banco');
  assert.ok(parent.body.includes('[[Subpágina]]')); assert.ok(child.body.includes('[[Projeto]]'));
  assert.ok(child.body.includes('Ação & contexto')); assert.ok(child.body.includes('| Coluna |'));
  assert.ok(!child.body.includes('<script') && !child.body.includes('__notesImportedScript') && !child.body.includes('javascript:'));
  assert.equal(globalThis.__notesImportedScript, undefined);
  assert.ok(database.body.includes('linha 1<br>linha 2 \\| x, "aspas"'));
  assert.deepEqual(blobs.get(database.imported.originalHash), Buffer.from(csv));
  assert.equal(await fs.readFile(path.join(directory, childPath), 'utf8'), html);
  assert.ok(snapshot.groups.at(-1).sessions.some(session => session.name === 'Projeto'));
});

test('Notion ZIP parts expand recursively and retain the raw internal archive and binary resources', async t => {
  const { assets, blobs, write } = await fixture(t);
  const inner = zipBuffer([{ name: 'Página 0123456789abcdef0123456789abcdef.md', data: '# Olá\n[Recurso](resources/dado.bin)' }, { name: 'resources/dado.bin', data: Buffer.from([1, 0, 255]) }]);
  const outer = zipBuffer([{ name: 'Parte 1.zip', data: inner }]), file = await write('Notion.zip', outer);
  const { snapshot, report } = await importWorkspace({ source: 'notion', inputPath: file, snapshot: seed(), assets });
  assert.equal(report.nestedArchives, 1); assert.equal(report.notes, 1); assert.equal(report.files, 3); assert.equal(report.unresolvedLinkCount, 0);
  const note = contentNotes(snapshot)[0]; assert.equal(note.title, 'Página'); assert.match(note.body, /notes-asset:[a-f0-9]{64}/);
  const archive = snapshot.notes.find(note => note.imported?.archive).attachments.find(item => item.relativePath === 'Parte 1.zip');
  assert.deepEqual(blobs.get(archive.hash), inner); assert.deepEqual(await fs.readFile(file), outer);
});

test('Notion HTML and Markdown ZIP exports import both pages and the database inside a wrapper folder', async t => {
  const { assets, blobs, write } = await fixture(t);
  const pageId = '0123456789abcdef0123456789abcdef', databaseId = '11111111222233334444555555555555', rowId = 'abcdef0123456789abcdef0123456789';
  for (const format of ['html', 'md']) {
    const wrapper = 'Export-99999999888877776666555555555555';
    const pageName = 'Projeto ' + pageId, databaseName = 'Tarefas ' + databaseId, rowName = 'Entrega ' + rowId;
    const pagePath = wrapper + '/' + pageName + '.' + format;
    const databasePath = wrapper + '/' + pageName + '/' + databaseName + '_all.csv';
    const rowPath = wrapper + '/' + pageName + '/' + databaseName + '/' + rowName + '.' + format;
    const databaseLink = encodeURI(pageName + '/' + databaseName + '_all.csv');
    const pageLink = encodeURI('../../' + pageName + '.' + format);
    const html = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>.page { color: black; }</style></head><body><article class="page sans"><header><h1 class="page-title">' + title + '</h1></header><div class="page-body">' + body + '</div></article></body></html>';
    const page = format === 'html' ? html('Projeto', '<p>Contexto completo da página principal.</p><a href="' + databaseLink + '">Tarefas</a>') : '# Projeto\n\nContexto completo da página principal.\n\n[Tarefas](' + databaseLink + ')';
    const row = format === 'html' ? html('Entrega', '<table class="properties"><tbody><tr><th>Status</th><td>Pronto</td></tr></tbody></table><p>Conteúdo completo da página do banco.</p><a href="' + pageLink + '">Projeto</a>') : '# Entrega\n\nStatus: Pronto\n\nConteúdo completo da página do banco.\n\n[Projeto](' + pageLink + ')';
    const csv = 'Nome,Status\r\nEntrega,Pronto\r\n';
    const entries = [{ name: pagePath, data: page }, { name: databasePath, data: csv }, { name: rowPath, data: row }];
    const archiveBytes = zipBuffer(entries), file = await write('notion-' + format + '.zip', archiveBytes);
    const original = freeze(seed()), before = structuredClone(original);
    const { snapshot, report } = await importWorkspace({ source: 'notion', inputPath: file, snapshot: original, assets });
    const notes = contentNotes(snapshot), byPath = new Map(notes.map(note => [note.imported.path, note]));
    assert.equal(report.notes, 3, format + ': both pages and the CSV become notes');
    assert.equal(report.files, 3); assert.equal(report.unresolvedLinkCount, 0);
    assert.deepEqual(new Set(notes.map(note => note.title)), new Set(['Projeto', 'Tarefas', 'Entrega']));
    assert.match(byPath.get(pagePath).body, /Contexto completo da página principal\./);
    assert.ok(byPath.get(pagePath).body.includes('[[Tarefas]]'));
    assert.match(byPath.get(rowPath).body, /Conteúdo completo da página do banco\./);
    assert.ok(byPath.get(rowPath).body.includes('[[Projeto]]'));
    assert.ok(byPath.get(databasePath).body.includes('| Entrega | Pronto |'));
    assert.equal(new Set(notes.map(note => note.s)).size, 3, 'each exported directory has its own session');
    const selected = notes.find(note => note.s === snapshot.session && snapshot.focusBy[snapshot.session] === note.id);
    assert.ok(selected, 'the selected session and note exist in the imported content');
    assert.ok(snapshot.expanded[report.groupId]);
    const manifest = snapshot.notes.find(note => note.imported?.archive);
    assert.equal(manifest.attachments.length, 3);
    for (const entry of entries) {
      const descriptor = manifest.attachments.find(item => item.relativePath === entry.name);
      assert.deepEqual(blobs.get(descriptor.hash), Buffer.from(entry.data));
    }
    assert.deepEqual(original, before); assert.deepEqual(await fs.readFile(file), archiveBytes);
  }
});

test('ZIP nesting depth is bounded and deeper raw archives remain recoverable', async t => {
  const { assets, write } = await fixture(t);
  let data = zipBuffer([{ name: 'Final.md', data: 'preservar' }]);
  for (let index = 0; index < 4; index++) data = zipBuffer([{ name: 'nível-' + index + '.zip', data }]);
  const file = await write('nested.zip', data);
  const { snapshot, report } = await importWorkspace({ source: 'notion', inputPath: file, snapshot: seed(), assets });
  assert.equal(report.nestedArchives, 2); assert.equal(report.files, 3); assert.equal(report.notes, 0);
  assert.ok(report.warnings.some(warning => warning.includes('profundidade máxima')));
  assert.equal(snapshot.notes.find(note => note.imported?.archive).attachments.length, 3);
});

test('ZIP traversal, absolute paths, ADS, reserved Windows names and symlinks are rejected without mutation', async t => {
  const { write } = await fixture(t);
  const names = ['../escape.md', '/absolute.md', 'C:/drive.md', 'notes:stream.md', '\\server\\share.md', 'folder/../escape.md', 'NUL.md', 'trailing./file.md'];
  for (const [index, name] of names.entries()) {
    const original = freeze(seed()), before = structuredClone(original);
    const bytes = zipBuffer([{ name: 'valid.md', data: 'antes do erro' }, { name, data: 'invalid' }]);
    const file = await write('bad-' + index + '.zip', bytes);
    let calls = 0;
    await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: file, snapshot: original, assets: { addFile() { calls++; throw new Error('Não deve armazenar antes da validação'); } } }));
    assert.equal(calls, 0); assert.deepEqual(original, before); assert.deepEqual(await fs.readFile(file), bytes);
  }
  const symlink = await write('symlink.zip', zipBuffer([{ name: 'shortcut', data: '../outside', mode: 0o120777 }]));
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: symlink, snapshot: seed(), assets: { addFile() { throw new Error('unexpected'); } } }), { code: 'NOTES_IMPORT_UNSAFE_ZIP' });
});

test('ZIP file, total, entry and text limits abort before blobs or snapshot can be committed', async t => {
  const { write } = await fixture(t);
  const file = await write('limits.zip', zipBuffer([{ name: 'one.md', data: '12345678' }, { name: 'two.md', data: '12345678' }]));
  for (const limits of [{ fileBytes: 4 }, { totalBytes: 4 }, { entries: 1 }, { textBytes: 4 }]) {
    const snapshot = freeze(seed()), before = structuredClone(snapshot);
    let calls = 0;
    await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: file, snapshot, limits, assets: { addFile() { calls++; throw new Error('unexpected'); } } }), { code: 'NOTES_IMPORT_LIMIT' });
    assert.equal(calls, 0); assert.deepEqual(snapshot, before);
  }
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: file, snapshot: seed(), assets: { addFile() {} }, limits: { entries: IMPORT_LIMITS.entries + 1 } }), /Limite de importação inválido/);
});

test('ZIP duplicate Windows paths and inconsistent entry lengths fail atomically', async t => {
  const { write, assets } = await fixture(t);
  const duplicate = await write('duplicate.zip', zipBuffer([{ name: 'Folder/Note.md', data: 'one' }, { name: 'folder/note.MD', data: 'two' }]));
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: duplicate, snapshot: seed(), assets }), { code: 'NOTES_IMPORT_DUPLICATE_PATH' });
  const mismatch = await write('mismatch.zip', zipBuffer([{ name: 'Note.md', data: '12345678', declaredSize: 9 }]));
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: mismatch, snapshot: seed(), assets }));
  const corrupt = await write('corrupt.zip', zipBuffer([{ name: 'Note.md', data: '12345678', declaredCRC: 1 }]));
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: corrupt, snapshot: seed(), assets }), { code: 'NOTES_IMPORT_CORRUPT_ZIP' });
});

test('sparse CSV expansion is bounded before blobs are written', async t => {
  const { directory, assets, descriptors, write } = await fixture(t);
  await write('Sparse.csv', 'a,b,c,d,e,f,g,h,i,j\n' + 'x\n'.repeat(100));
  const snapshot = freeze(seed()), before = structuredClone(snapshot);
  await assert.rejects(importWorkspace({ source: 'notion', inputPath: directory, snapshot, assets, limits: { textBytes: 1000 } }), { code: 'NOTES_IMPORT_LIMIT' });
  assert.equal(descriptors.length, 0); assert.deepEqual(snapshot, before);
});

test('invalid UTF-8 and malformed CSV fail without changing the caller snapshot', async t => {
  for (const [name, bytes, source, code] of [['Note.md', Buffer.from([0xff, 0xfe, 0x00]), 'obsidian', 'NOTES_IMPORT_ENCODING'], ['Database.csv', Buffer.from('a,b\n"unterminated,b'), 'notion', 'NOTES_IMPORT_INVALID_CSV']]) {
    const { directory, assets, descriptors, write } = await fixture(t);
    await write(name, bytes);
    const snapshot = freeze(seed()), before = structuredClone(snapshot);
    await assert.rejects(importWorkspace({ source, inputPath: directory, snapshot, assets }), { code });
    assert.deepEqual(snapshot, before); assert.equal(descriptors.length, 0); assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes);
  }
});

test('repeated imports add an independent group, preserve existing notes and resolve links to their new peers', async t => {
  const { directory, assets, write } = await fixture(t);
  await write('One.md', '[[Two]]'); await write('Two.md', '[[One]]');
  const original = seed(), first = await importWorkspace({ source: 'obsidian', inputPath: directory, snapshot: original, assets });
  const firstCopy = structuredClone(first.snapshot), second = await importWorkspace({ source: 'obsidian', inputPath: directory, snapshot: first.snapshot, assets });
  assert.deepEqual(first.snapshot, firstCopy); assert.deepEqual(original, seed());
  assert.equal(second.snapshot.groups.length, 3); assert.equal(second.report.notes, 2);
  assert.notEqual(first.report.groupId, second.report.groupId); assert.notEqual(second.snapshot.groups.at(-1).name, first.snapshot.groups.at(-1).name);
  assert.equal(new Set(second.snapshot.notes.map(note => note.id)).size, second.snapshot.notes.length);
  const secondSessionIds = new Set(second.snapshot.groups.at(-1).sessions.map(session => session.id));
  const newNotes = contentNotes(second.snapshot).filter(note => secondSessionIds.has(note.s));
  assert.equal(newNotes.length, 2);
  assert.ok(newNotes[0].body.includes('[[' + newNotes[1].title + ']]'));
  assert.ok(newNotes[1].body.includes('[[' + newNotes[0].title + ']]'));
  for (const note of first.snapshot.notes) assert.deepEqual(second.snapshot.notes.find(item => item.id === note.id), note);
});

test('asset storage errors propagate without changing the source or caller snapshot', async t => {
  const { directory, write } = await fixture(t);
  const bytes = '# Conteúdo original'; await write('Note.md', bytes); await write('other.bin', 'binary');
  const snapshot = freeze(seed()), before = structuredClone(snapshot);
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: directory, snapshot, assets: { addFile() { throw new Error('disco indisponível'); } } }), /disco indisponível/);
  assert.deepEqual(snapshot, before); assert.equal(await fs.readFile(path.join(directory, 'Note.md'), 'utf8'), bytes);
});

test('root symlinks/junctions are rejected and Obsidian ZIP keeps config scripts as inert attachments', async t => {
  const { directory, write, assets, blobs } = await fixture(t);
  const vault = path.join(directory, 'Vault'); await fs.mkdir(vault);
  const alias = path.join(directory, 'alias'); await fs.symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importWorkspace({ source: 'obsidian', inputPath: alias, snapshot: seed(), assets }), { code: 'NOTES_IMPORT_UNSAFE_SOURCE' });
  const code = 'globalThis.__notesImportPluginExecuted = true;';
  const archive = await write('Vault.zip', zipBuffer([{ name: 'Vault/Note.md', data: '[[Note#heading|alias]]' }, { name: 'Vault/.obsidian/plugins/test/main.js', data: code }, { name: 'Vault/.obsidian/plugins/test/README.md', data: 'preservar como arquivo' }]));
  const { snapshot, report } = await importWorkspace({ source: 'obsidian', inputPath: archive, snapshot: seed(), assets });
  assert.equal(report.notes, 1); assert.equal(report.files, 3); assert.equal(globalThis.__notesImportPluginExecuted, undefined);
  assert.equal(contentNotes(snapshot)[0].body, '[[Note]]');
  const descriptor = snapshot.notes.find(note => note.imported?.archive).attachments.find(item => item.relativePath.endsWith('main.js'));
  assert.equal(blobs.get(descriptor.hash).toString(), code);
});
