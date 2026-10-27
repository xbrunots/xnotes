'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { NotionMigration, officialDownload } = require('../desktop/notion-migration.cjs');
const { notionMarkdown, contentOf, referencesIn } = require('../desktop/notion-content.cjs');

// Every name, page, property and byte in this file is synthetic. No real
// credentials, workspace connection, browser profile or user archive is used.
const id = number => number.toString(16).padStart(32, '0');
const url = number => 'https://www.notion.so/' + id(number);
const collection = number => 'collection://' + id(number);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const schema = properties => ({ type: 'object', properties: Object.fromEntries(properties.map(key => [key, key === 'mode' ? { type: 'string', enum: ['rows', 'view'] } : {}])), additionalProperties: false });
const tool = (name, keys) => ({ name, inputSchema: schema(keys) });
const tools = () => [tool('notion-list-private-pages', ['limit', 'cursor']), tool('notion_list_shared_pages', ['limit', 'cursor']), tool('fetch', ['id', 'include_file_urls']), tool('notion-get-comments', ['page_id', 'include_resolved', 'include_all_blocks', 'include_content']), tool('notion-query-data-sources', ['mode', 'data_source_url', 'limit']), tool('notion-get-file-download-urls', ['references'])];
const seed = () => ({ groups: [{ id: 'old-group', name: 'Existente', sessions: [{ id: 'old-session', name: 'Anterior' }] }], notes: [{ id: 'old-note', s: 'old-session', title: 'Nota anterior', body: 'Preservar byte por byte.', t: '2024-01-01' }], preference: { nested: [1, 'conservar'] }, openBy: { 'old-session': ['old-note'] }, focusBy: { 'old-session': 'old-note' } });
const normalize = name => name.replace(/^notion[-_]/, '').replace(/-/g, '_');
function page(number, title, body = '', extras = {}) { return { id: id(number), title, text: '<page url="' + url(number) + '">\n<properties>' + JSON.stringify({ title }) + '</properties>\n<content>\n' + body + '\n</content>\n</page>', ...extras }; }
function fake(overrides = {}, available = tools()) {
  const calls = [];
  return { calls, status() { return { connected: true, account: { workspaceId: id(900), userId: id(901) } }; }, async listTools({ signal } = {}) { assert.equal(signal?.aborted || false, false); return available; }, async callTool(name, args, options) {
    const definition = available.find(item => item.name === name); assert.ok(definition, 'only discovered tools are called');
    for (const key of Object.keys(args)) assert.ok(Object.hasOwn(definition.inputSchema.properties, key), 'schema argument exists: ' + key);
    const base = normalize(name); calls.push({ name: base, args: structuredClone(args) });
    const handler = overrides[base];
    if (handler) return handler(args, options, calls);
    if (base === 'list_private_pages') return response({ pages: [{ id: id(1), title: 'Raiz', type: 'page' }] });
    if (base === 'list_shared_pages') return response({ pages: [] });
    if (base === 'fetch') return response(page(1, 'Raiz', 'Conteúdo sintético.'));
    if (base === 'get_comments') return response({ comments: [] });
    if (base === 'query_data_sources') return response({ results: [], has_more: false });
    if (base === 'get_file_download_urls') return response({ files: [], unresolved: [] });
    throw new Error('unexpected tool');
  } };
}
async function fixture(t, client = fake(), fetchImpl) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'notes-notion-migration-test-'));
  t.after(async () => {
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^notes-notion-migration-test-[A-Za-z\d]+$/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const blobs = new Map(), descriptors = [];
  const assets = { async addFile(filename, metadata) { const bytes = await fs.readFile(filename), hash = sha(bytes); blobs.set(hash, bytes); const descriptor = { ...metadata, size: bytes.length, hash }; descriptors.push(descriptor); return descriptor; } };
  const migration = new NotionMigration({ client, dataDir: directory, assets, ...(fetchImpl ? { fetchImpl } : {}) });
  return { directory, migration, assets, blobs, descriptors, client };
}

test('all roots, empty cursor pages, child pages, schemas and rows are traversed and archived without exposing content', async t => {
  const sentinel = 'SYNTHETIC-BODY-PRIVATE-42';
  const client = fake({
    list_private_pages(args) {
      if (!args.cursor) return response({ pages: [{ id: id(1), title: 'Raiz', type: 'page' }], nextCursor: 'empty' });
      if (args.cursor === 'empty') return response({ pages: [], nextCursor: 'last' });
      return response({ pages: [{ id: id(4), title: 'Documentação', type: 'database' }] });
    },
    list_shared_pages() { return response({ pages: [{ id: id(2), title: 'Compartilhada', type: 'page' }] }); },
    fetch(args) {
      if (args.id === url(1)) return response(page(1, 'Raiz', sentinel + '\n<page url="' + url(3) + '">Filha</page>'));
      if (args.id === url(2)) return response(page(2, 'Compartilhada', 'Texto compartilhado.'));
      if (args.id === url(3)) return response(page(3, 'Filha', 'Código e links.'));
      if (args.id === url(4)) return response(page(4, 'Documentação', '<database url="' + url(4) + '">Documentação</database>\n<data-source url="' + collection(5) + '">Registros</data-source>'));
      if (args.id === collection(5).replace(id(5), '00000000-0000-0000-0000-000000000005')) return response({ title: 'Registros', text: '<data-source url="' + collection(5) + '"><schema>{"Documento":"title","Obs":"text"}</schema></data-source>' });
      if (args.id === url(6)) return response(page(6, 'Registro', 'Corpo do registro.'));
      throw new Error('Unknown synthetic item: ' + args.id);
    },
    query_data_sources(args, _options, calls) {
      assert.equal(args.mode, 'rows'); assert.equal(args.limit, 100);
      assert.ok(calls.some(call => call.name === 'fetch' && call.args.id.startsWith('collection://')), 'schema was fetched first');
      return response({ results: [{ id: id(6), url: url(6), properties: { Documento: 'Registro', Observação: 'Propriedade sintética.' } }], has_more: false });
    },
    get_comments(args) { return response(args.page_id.replace(/-/g, '') === id(3) ? { comments: [{ text: 'Comentário sintético.' }] } : { comments: [] }); }
  });
  const { migration, blobs } = await fixture(t, client), progress = [];
  const summary = await migration.scan({ onProgress: event => progress.push(event) });
  assert.equal(summary.state, 'ready'); assert.equal(summary.complete, true); assert.equal(summary.workspaceComplete, false); assert.equal(summary.scope, 'accessible-private-shared');
  assert.equal(summary.pages, 4); assert.equal(summary.databases, 1); assert.equal(summary.canImport, true);
  assert.equal(client.calls.filter(call => call.name === 'list_private_pages').length, 3);
  assert.ok(progress.every(event => !JSON.stringify(event).includes(sentinel)), 'renderer receives counts, never bodies');
  const original = seed(), before = structuredClone(original);
  const imported = await migration.import({ planId: summary.id, snapshot: original });
  assert.deepEqual(original, before); assert.deepEqual(imported.snapshot.notes.find(note => note.id === 'old-note'), before.notes[0]);
  assert.deepEqual(imported.snapshot.preference, before.preference);
  assert.equal(imported.snapshot.groups.at(-1).imported.notionMigrationId, summary.id);
  const row = imported.snapshot.notes.find(note => note.imported?.notionId?.replace(/-/g, '') === id(6));
  assert.match(row.body, /Propriedade sintética/); assert.match(row.body, /Corpo do registro/);
  const child = imported.snapshot.notes.find(note => note.imported?.notionId?.replace(/-/g, '') === id(3));
  assert.match(child.imported.notionBreadcrumbs, /Raiz/); assert.match(child.body, /Comentário sintético/);
  const archive = imported.snapshot.notes.find(note => note.imported?.archive);
  assert.ok(archive.attachments.some(item => item.relativePath.endsWith('tools-list.json')));
  assert.ok([...blobs.values()].some(bytes => bytes.toString('utf8').includes(sentinel)));
  const done = await migration.finish(summary.id); assert.equal(done.state, 'applied');
});

for (const hasMore of [true, false]) test('100-row cap never claims a complete database even when has_more is ' + hasMore, async t => {
  const client = fake({
    fetch(args) { return response(args.id.startsWith('collection://') ? { title: 'Registros', text: '<schema>{"Name":"title"}</schema>' } : page(1, 'Banco', '<data-source url="' + collection(2) + '">Registros</data-source>')); },
    query_data_sources(args) { assert.equal(args.cursor, undefined); return response({ results: Array.from({ length: 100 }, (_, index) => ({ id: id(index + 100), Name: 'Linha ' + index })), has_more: hasMore }); }
  });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, false); assert.ok(summary.issues.some(issue => issue.code === 'DATABASE_ROW_LIMIT'));
  assert.equal(client.calls.filter(call => call.name === 'query_data_sources').length, 1);
  assert.equal(summary.canImport, true);
});

test('truncated pages recover known subtrees while omitted subtree IDs remain an explicit gap', async t => {
  const client = fake({ fetch(args) {
    if (args.id.replace(/-/g, '') === id(2)) return response({ title: 'Trecho', text: 'Conteúdo recuperado sintético.' });
    return response(page(1, 'Grande', 'Parte disponível.', { truncated: true, unknown_block_ids: [id(2)], unknown_block_count: 2 }));
  } });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, false); assert.ok(summary.issues.some(issue => issue.code === 'TRUNCATED_CONTENT'));
  const { snapshot } = await migration.import({ planId: summary.id, snapshot: seed() });
  assert.ok(snapshot.notes.some(note => note.body.includes('Conteúdo recuperado sintético.')));
});

test('a truncated page is reconciled only after every reported omitted subtree has been fetched', async t => {
  const client = fake({ fetch(args) {
    if (args.id.replace(/-/g, '') === id(2)) return response({ title: 'Trecho', text: 'Trecho integral.' });
    return response(page(1, 'Grande', 'Parte disponível.', { truncated: true, unknown_block_ids: [id(2)], unknown_block_count: 1 }));
  } });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, true); assert.ok(!summary.issues.some(issue => issue.code === 'TRUNCATED_CONTENT'));
});

test('file references resolve to official HTTPS URLs without forwarding credentials, preserving exact bytes and hashes', async t => {
  const reference = 'notion-file-block://' + id(1) + '/' + id(2) + '/' + id(3), bytes = Buffer.from([0, 255, 2, 128, 20]);
  let downloads = 0;
  const literalCode = '```text\n\t' + reference + '\n\n```';
  const client = fake({ fetch() { return response(page(1, 'Arquivo', '![Anexo](' + reference + ')\n\n' + literalCode + '\n\n`' + reference + '`')); }, get_file_download_urls(args) { assert.deepEqual(args.references, [reference]); return response({ files: [{ reference, url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/synthetic/raw.bin', expiry_time: new Date(Date.now() + 60000).toISOString() }] }); } });
  const { migration, blobs } = await fixture(t, client, async (target, options) => { downloads++; assert.match(target, /^https:\/\/prod-files-secure/); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); });
  const summary = await migration.scan(); assert.equal(summary.complete, true); assert.equal(summary.files, 1); assert.equal(downloads, 1);
  const { snapshot } = await migration.import({ planId: summary.id, snapshot: seed() });
  assert.deepEqual(blobs.get(sha(bytes)), bytes);
  const note = snapshot.notes.find(item => item.imported?.notionId); assert.match(note.body, new RegExp('notes-asset:' + sha(bytes)));
  assert.ok(note.body.includes(literalCode)); assert.ok(note.body.includes('`' + reference + '`'));
  assert.ok(note.attachments.some(item => item.hash === sha(bytes)));
});

test('failed attachments remain explicit and can be resumed with refreshed signed URLs', async t => {
  const reference = 'notion-file-block://' + id(1) + '/' + id(2), bytes = Buffer.from('synthetic bytes'); let succeed = false, resolutions = 0;
  const client = fake({ fetch() { return response(page(1, 'Arquivo', '[Arquivo](' + reference + ')')); }, get_file_download_urls() { resolutions++; return response({ files: [{ reference, url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/synthetic/file.txt', expiry_time: new Date(Date.now() + 60000).toISOString() }] }); } });
  const { migration } = await fixture(t, client, async () => succeed ? new Response(bytes) : new Response('not available', { status: 403 }));
  const partial = await migration.scan(); assert.equal(partial.complete, false); assert.equal(partial.files, 0); assert.equal(partial.canResume, true); assert.ok(partial.issues.some(issue => issue.code === 'FILE_DOWNLOAD_FAILED'));
  succeed = true; const complete = await migration.scan({ resume: true });
  assert.equal(complete.id, partial.id); assert.equal(complete.complete, true); assert.equal(complete.files, 1); assert.equal(resolutions, 2);
});

test('cancellation checkpoints the queue and resumes the same plan without enumerating completed roots twice', async t => {
  const controller = new AbortController(); let firstFetch = true;
  const client = fake({ fetch() { if (firstFetch) { firstFetch = false; controller.abort(); } return response(page(1, 'Raiz', 'Texto sintético.')); } });
  const { migration } = await fixture(t, client), cancelled = await migration.scan({ signal: controller.signal });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.complete, false); assert.equal(cancelled.canResume, true);
  const resumed = await migration.scan({ resume: true });
  assert.equal(resumed.id, cancelled.id); assert.equal(resumed.complete, true); assert.equal(resumed.pages, 1);
  assert.equal(client.calls.filter(call => call.name === 'list_private_pages').length, 1);
  assert.equal(client.calls.filter(call => call.name === 'fetch').length, 2);
});

test('reapplying an imported plan never duplicates notes or replaces existing data', async t => {
  const { migration, descriptors } = await fixture(t), summary = await migration.scan();
  const first = await migration.import({ planId: summary.id, snapshot: seed() }), count = descriptors.length;
  const second = await migration.import({ planId: summary.id, snapshot: first.snapshot });
  assert.equal(second.report.alreadyImported, true); assert.deepEqual(second.snapshot, first.snapshot); assert.equal(descriptors.length, count);
});

test('fenced code including tabs, XML-looking strings and blank lines is preserved literally', () => {
  const code = '```javascript\n\tconst tag = "<page url=\\"' + url(99) + '\\">";\n\n\t\treturn "<span color=\\"red\\">x</span>";\n```';
  const converted = notionMarkdown('<callout icon="💡">\n\t**Conteúdo**\n</callout>\n\n' + code + '\n\n<page url="' + url(2) + '">Filha</page>');
  assert.ok(converted.includes(code)); assert.match(converted, /\[Filha\]\(https:/); assert.ok(!referencesIn(code).some(item => item.id.replace(/-/g, '') === id(99)));
  const content = contentOf(response(page(1, 'Raiz', code))); assert.ok(content.body.includes(code));
});

test('repeated cursors terminate with a coverage gap rather than looping or claiming completeness', async t => {
  const client = fake({ list_private_pages() { return response({ pages: [], nextCursor: 'repeated' }); } });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(client.calls.filter(call => call.name === 'list_private_pages').length, 2); assert.equal(summary.complete, false); assert.ok(summary.issues.some(issue => issue.code === 'REPEATED_CURSOR'));
});

test('quota and permissions are surfaced without including server content in renderer progress', async t => {
  const privateMarker = 'SYNTHETIC-SERVER-PRIVATE';
  const client = fake({ fetch() { return { isError: true, content: [{ type: 'text', text: 'quota exceeded ' + privateMarker }] }; } });
  const { migration } = await fixture(t, client), progress = [], summary = await migration.scan({ onProgress: event => progress.push(event) });
  assert.equal(summary.complete, false); assert.ok(summary.issues.some(issue => issue.message.includes('cota')));
  assert.ok(!JSON.stringify(progress).includes(privateMarker));
});

test('download hosts and redirects are bounded to official Notion HTTPS storage', async t => {
  for (const target of ['http://file.notion.so/a', 'https://user:pass@file.notion.so/a', 'https://file.notion.so:123/a', 'https://127.0.0.1/a', 'https://example.s3.us-west-2.amazonaws.com/a', 'https://prod-files-secure.s3.us-west-2.amazonaws.com.evil.example/a', 'https://s3.us-west-2.amazonaws.com/other-bucket/a']) assert.equal(officialDownload(target), null, target);
  assert.ok(officialDownload('https://s3.us-west-2.amazonaws.com/secure.notion-static.com/synthetic/a'));
  const reference = 'notion-file-block://' + id(1) + '/' + id(2); let calls = 0;
  const client = fake({ fetch() { return response(page(1, 'Arquivo', '[Arquivo](' + reference + ')')); }, get_file_download_urls() { return response({ files: [{ reference, url: 'https://file.notion.so/synthetic.bin' }] }); } });
  const { migration } = await fixture(t, client, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); });
  const summary = await migration.scan(); assert.equal(calls, 1); assert.equal(summary.files, 0); assert.ok(summary.issues.some(issue => issue.code === 'FILE_DOWNLOAD_FAILED'));
});

test('source checksum changes prevent preparation and leave the caller snapshot intact', async t => {
  const { migration, directory } = await fixture(t), summary = await migration.scan(), original = seed(), before = structuredClone(original);
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'notion-import', summary.id, 'plan.json'), 'utf8'));
  await fs.appendFile(path.join(directory, 'notion-import', summary.id, 'sources', plan.rawFiles[0].name), 'tamper');
  await assert.rejects(migration.import({ planId: summary.id, snapshot: original }), error => error.code === 'NOTES_NOTION_FILE_INTEGRITY');
  assert.deepEqual(original, before); assert.equal((await migration.status()).state, 'ready');
});

test('cancellation during blob preparation never returns a partially changed workspace', async t => {
  const { migration, assets } = await fixture(t), summary = await migration.scan(), original = seed(), before = structuredClone(original), controller = new AbortController();
  const addFile = assets.addFile; assets.addFile = async (...args) => { const value = await addFile(...args); controller.abort(); return value; };
  await assert.rejects(migration.import({ planId: summary.id, snapshot: original, signal: controller.signal }), error => error.name === 'AbortError');
  assert.deepEqual(original, before); assert.equal((await migration.status()).state, 'cancelled');
});

test('real union schemas keep the required data envelope and only arguments accepted by the chosen mode', async t => {
  const available = tools(), query = available.find(item => normalize(item.name) === 'query_data_sources');
  query.inputSchema = { type: 'object', required: ['data'], properties: { data: { anyOf: [
    { type: 'object', required: ['mode', 'data_source_url'], properties: { mode: { const: 'rows' }, data_source_url: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false },
    { type: 'object', required: ['mode', 'view_url'], properties: { mode: { const: 'view' }, view_url: { type: 'string' }, page_size: { type: 'integer' }, start_cursor: { type: 'string' } }, additionalProperties: false }
  ] } }, additionalProperties: false };
  const client = fake({
    fetch(args) { return response(args.id.startsWith('collection://') ? { title: 'Registros', text: '<schema>{"Name":"title"}</schema>' } : page(1, 'Banco', '<data-source url="' + collection(2) + '">Registros</data-source>')); },
    query_data_sources(args) { assert.deepEqual(args, { data: { mode: 'rows', data_source_url: 'collection://00000000-0000-0000-0000-000000000002', limit: 100 } }); return response({ results: [], has_more: false }); }
  }, available);
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, true); assert.equal(client.calls.filter(call => call.name === 'query_data_sources').length, 1);
});

test('account and workspace ownership is checked before status, resume or import and leaves the old plan unchanged', async t => {
  const { migration, client, directory } = await fixture(t), summary = await migration.scan();
  const file = path.join(directory, 'notion-import', summary.id, 'plan.json'), before = await fs.readFile(file, 'utf8');
  client.status = () => ({ connected: true, account: { workspaceId: id(999), userId: id(901) } });
  for (const action of [() => migration.status(), () => migration.scan({ resume: true }), () => migration.import({ planId: summary.id, snapshot: seed() })]) await assert.rejects(action(), error => error.code === 'NOTES_NOTION_ACCOUNT_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('ephemeral file grants stay in the private resume plan and never enter imported source archives', async t => {
  const reference = 'notion-file-block://' + id(1) + '/' + id(2), secret = 'SYNTHETIC-EPHEMERAL-GRANT', signed = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/synthetic/file.bin?X-Amz-Signature=' + secret;
  const client = fake({ fetch() { return response(page(1, 'Arquivo', '[Arquivo](' + reference + ')')); }, get_file_download_urls() { return response({ files: [{ reference, url: signed }] }); } });
  const { migration, blobs, directory } = await fixture(t, client, async target => { assert.equal(target, signed); return new Response(Buffer.from('synthetic file')); });
  const summary = await migration.scan(); assert.equal(summary.complete, true);
  assert.ok((await fs.readFile(path.join(directory, 'notion-import', summary.id, 'plan.json'), 'utf8')).includes(secret), 'resume URL is only cached privately');
  await migration.import({ planId: summary.id, snapshot: seed() });
  for (const bytes of blobs.values()) assert.ok(!bytes.toString('utf8').includes(secret), 'no transient grants in content-addressed blobs or Git-bound archives');
});

test('pagination uses only a verified unfiltered view and follows empty pages with a cursor', async t => {
  const available = tools(), query = available.find(item => normalize(item.name) === 'query_data_sources');
  query.inputSchema = { type: 'object', required: ['data'], properties: { data: { anyOf: [
    { properties: { mode: { const: 'rows' }, data_source_url: {}, limit: {} } },
    { properties: { mode: { const: 'view' }, view_url: {}, page_size: {}, start_cursor: {} } }
  ] } } };
  const client = fake({
    fetch(args) {
      if (args.id.startsWith('collection://')) return response({ title: 'Registros', text: '<schema>{"Name":"title"}</schema>' });
      if (args.id.startsWith('view://')) return response({ title: 'Todos', filters: [], text: '<data-source url="' + collection(2) + '">Registros</data-source>' });
      return response(page(1, 'Banco', '<data-source url="' + collection(2) + '">Registros</data-source>\n<view url="view://' + id(3) + '">Todos</view>'));
    },
    query_data_sources(args) {
      assert.equal(args.data.mode, 'view'); assert.equal(args.data.limit, undefined); assert.equal(args.data.page_size, 100);
      return response(args.data.start_cursor ? { results: [], has_more: false } : { results: [], has_more: true, next_cursor: 'next-empty' });
    }
  }, available);
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, true); assert.equal(client.calls.filter(call => call.name === 'query_data_sources').length, 2);
});

test('a rows-mode cursor without has_more is still a visible coverage gap', async t => {
  const client = fake({ fetch(args) { return response(args.id.startsWith('collection://') ? { title: 'Registros', text: 'Esquema.' } : page(1, 'Banco', '<data-source url="' + collection(2) + '">Registros</data-source>')); }, query_data_sources() { return response({ results: [], nextCursor: 'not-supported-by-rows' }); } });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.complete, false); assert.ok(summary.issues.some(issue => issue.code === 'DATABASE_ROW_LIMIT'));
});

test('get_self identity fallback works for explicit operations while local status never contacts the provider', async t => {
  const available = [...tools(), tool('notion-get-self', [])], client = fake({ get_self() { return response({ workspace: { id: id(900) }, user: { id: id(901) } }); } }, available);
  client.status = () => ({ connected: true, account: null });
  const { migration } = await fixture(t, client), summary = await migration.scan(), calls = client.calls.length;
  assert.equal(summary.complete, true); const status = await migration.status(); assert.equal(status.state, 'identity-unverified'); assert.equal(status.canImport, false); assert.equal(client.calls.length, calls);
  const imported = await migration.import({ planId: summary.id, snapshot: seed() }); assert.ok(imported.report.notes > 0);
});

test('safe permission and quota codes returned by NotionClient remain classifiable without exposing provider text', async t => {
  for (const [code, expected] of [['permission_error', 'permitiu'], ['rate_limited', 'cota']]) {
    const client = fake({ fetch() { return { isError: true, content: [{ type: 'text', text: 'Falha segura na ferramenta.' }], structuredContent: { error: { code } } }; } });
    const { migration } = await fixture(t, client), summary = await migration.scan();
    assert.ok(summary.issues.some(issue => issue.message.includes(expected)), code);
  }
});

test('NOTION_CANCELLED on the final queued task is cancellation rather than a successful ready state', async t => {
  const client = fake({ fetch() { throw Object.assign(new Error('Cancelado'), { code: 'NOTION_CANCELLED' }); } });
  const { migration } = await fixture(t, client), summary = await migration.scan();
  assert.equal(summary.state, 'cancelled'); assert.equal(summary.complete, false); assert.equal(summary.canResume, true);
});

test('a new engine exposes crash checkpoints as interrupted and can resume the same private plan', async t => {
  const { migration, client, directory, assets } = await fixture(t), summary = await migration.scan(), file = path.join(directory, 'notion-import', summary.id, 'plan.json');
  const plan = JSON.parse(await fs.readFile(file, 'utf8')); plan.state = 'scanning'; plan.tasks.find(task => task.type === 'fetch').state = 'running'; await fs.writeFile(file, JSON.stringify(plan));
  const restarted = new NotionMigration({ client, dataDir: directory, assets }), status = await restarted.status();
  assert.equal(status.state, 'interrupted'); assert.equal(status.canResume, true); assert.equal(status.canImport, false);
  const resumed = await restarted.scan({ resume: true }); assert.equal(resumed.id, summary.id); assert.equal(resumed.complete, true);
});

test('resuming a partially imported plan appends new IDs and keeps every previously saved note exactly intact', async t => {
  let failChild = true;
  const client = fake({ fetch(args) {
    if (args.id === url(1)) return response(page(1, 'Raiz', 'Corpo original.\n<page url="' + url(2) + '">Filha</page>'));
    if (failChild) throw new Error('permission_error');
    return response(page(2, 'Filha', 'Corpo recuperado.'));
  } });
  const { migration } = await fixture(t, client), partial = await migration.scan(); assert.equal(partial.complete, false);
  const first = await migration.import({ planId: partial.id, snapshot: seed() }); await migration.finish(partial.id);
  const rootNote = first.snapshot.notes.find(note => note.imported?.notionId?.replace(/-/g, '') === id(1)); rootNote.body += '\nEdição local posterior.';
  const oldNotes = structuredClone(first.snapshot.notes); failChild = false;
  const resumed = await migration.scan({ resume: true }); assert.equal(resumed.id, partial.id); assert.equal(resumed.complete, true);
  const second = await migration.import({ planId: resumed.id, snapshot: first.snapshot });
  assert.equal(second.snapshot.groups.length, first.snapshot.groups.length, 'same migration group is reused');
  for (const old of oldNotes) assert.deepEqual(second.snapshot.notes.find(note => note.id === old.id), old, 'previously stored note remains unchanged: ' + old.id);
  assert.equal(second.snapshot.notes.filter(note => note.imported?.notionId?.replace(/-/g, '') === id(1)).length, 1);
  assert.equal(second.snapshot.notes.filter(note => note.imported?.notionId?.replace(/-/g, '') === id(2)).length, 1);
  const third = await migration.import({ planId: resumed.id, snapshot: second.snapshot }); assert.equal(third.report.alreadyImported, true); assert.deepEqual(third.snapshot, second.snapshot);
});

test('independent plans with identical source paths never annotate or mutate notes from an earlier import', async t => {
  const { migration } = await fixture(t), planA = await migration.scan();
  const first = await migration.import({ planId: planA.id, snapshot: seed() }); await migration.finish(planA.id);
  const before = structuredClone(first.snapshot.notes), planB = await migration.scan();
  const second = await migration.import({ planId: planB.id, snapshot: first.snapshot });
  for (const old of before) assert.deepEqual(second.snapshot.notes.find(note => note.id === old.id), old);
  const firstPage = second.snapshot.notes.find(note => note.imported?.notionMigrationId === planA.id && note.imported?.notionId);
  const secondPage = second.snapshot.notes.find(note => note.imported?.notionMigrationId === planB.id && note.imported?.notionId);
  assert.ok(firstPage && secondPage); assert.notEqual(firstPage.id, secondPage.id);
});

test('new IDs recovered before a resumed round is cancelled can still be appended to an imported partial plan', async t => {
  let stage = 0;
  const client = fake({
    fetch(args) { if (args.id === url(1)) return response(page(1, 'Raiz', '<page url="' + url(2) + '">Filha</page>')); if (stage === 0) throw new Error('permission_error'); return response(page(2, 'Filha', 'Recuperada antes de cancelar.')); },
    get_comments(args) { if (stage === 1 && args.page_id.replace(/-/g, '') === id(2)) throw Object.assign(new Error('Cancelado'), { code: 'NOTION_CANCELLED' }); return response({ comments: [] }); }
  });
  const { migration } = await fixture(t, client), partial = await migration.scan();
  const first = await migration.import({ planId: partial.id, snapshot: seed() }); await migration.finish(partial.id); const before = structuredClone(first.snapshot.notes);
  stage = 1; const cancelled = await migration.scan({ resume: true }); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.pages, 2); assert.equal(cancelled.canImport, true);
  const second = await migration.import({ planId: cancelled.id, snapshot: first.snapshot }); assert.notEqual(second.report.alreadyImported, true);
  assert.ok(second.snapshot.notes.some(note => note.imported?.notionId?.replace(/-/g, '') === id(2)));
  for (const note of before) assert.deepEqual(second.snapshot.notes.find(item => item.id === note.id), note);
});

test('append preserves existing tabs and focus and resolves new links to previously imported notes without touching code', async t => {
  let failSecond = true;
  const literal = '```text\n[Primeira](' + url(1) + ')\n```';
  const client = fake({
    list_private_pages() { return response({ pages: [{ id: id(1), title: 'Primeira', type: 'page' }, { id: id(2), title: 'Segunda', type: 'page' }] }); },
    fetch(args) { if (args.id === url(1)) return response(page(1, 'Primeira', 'Conteúdo anterior.')); if (failSecond) throw new Error('permission_error'); return response(page(2, 'Segunda', '[Primeira](' + url(1) + ')\n\n' + literal)); }
  });
  const { migration } = await fixture(t, client), partial = await migration.scan(), first = await migration.import({ planId: partial.id, snapshot: seed() });
  await migration.finish(partial.id); const old = first.snapshot.notes.find(note => note.imported?.notionId?.replace(/-/g, '') === id(1)), before = structuredClone(old);
  assert.deepEqual(first.snapshot.openBy[old.s], [old.id]); failSecond = false;
  const resumed = await migration.scan({ resume: true }), second = await migration.import({ planId: resumed.id, snapshot: first.snapshot });
  const added = second.snapshot.notes.find(note => note.imported?.notionId?.replace(/-/g, '') === id(2));
  assert.equal(added.s, old.s); assert.deepEqual(second.snapshot.openBy[old.s], [old.id, added.id]); assert.equal(second.snapshot.focusBy[old.s], old.id);
  assert.ok(added.body.includes('[[' + old.title + ']]')); assert.ok(added.body.includes(literal)); assert.ok(added.imported.links.some(link => link.noteId === old.id));
  assert.deepEqual(second.snapshot.notes.find(note => note.id === old.id), before); assert.equal(second.report.unresolvedLinkCount, 0);
});
