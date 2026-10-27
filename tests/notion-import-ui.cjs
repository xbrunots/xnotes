'use strict';

// Real Electron, synthetic Notion exports and isolated temporary profiles.
// Only the native file picker is replaced; conversion, persistence, links and
// the rendered editor run through the application's production code paths.
const { _electron: electron } = require('playwright');
const MarkdownIt = require('markdown-it');
const yazl = require('yazl');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { waitPage } = require('./helpers/wait-page.cjs');

const project = path.resolve(__dirname, '..');
const markdown = new MarkdownIt({ html: true, breaks: true });

function markdownMeaning(source) {
  const describe = token => ({ type: token.type, tag: token.tag, nesting: token.nesting, content: token.content, attrs: token.attrs, ...(token.children ? { children: token.children.map(describe) } : {}) });
  return markdown.parse(source, {}).map(describe);
}

async function makeExport(directory, format) {
  const label = format === 'html' ? 'HTML' : 'Markdown';
  const wrapper = 'Export-99999999888877776666555555555555';
  const page = 'Z portal ' + label + ' 0123456789abcdef0123456789abcdef';
  const database = 'A tarefas ' + label + ' 11111111222233334444555555555555';
  const row = 'Entrega ' + label + ' abcdef0123456789abcdef0123456789';
  const extension = format === 'html' ? 'html' : 'md';
  const paths = {
    page: wrapper + '/' + page + '.' + extension,
    database: wrapper + '/' + database + '_all.csv',
    row: wrapper + '/' + database + '/' + row + '.' + extension,
  };
  const pageBody = 'Conteúdo da página principal em ' + label + '.';
  const rowBody = 'Conteúdo completo da entrega em ' + label + '.';
  const databaseHref = encodeURI(database + '_all.csv');
  const pageHref = encodeURI('../' + page + '.' + extension);
  const html = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>.page { color: black; }</style></head><body><article class="page sans"><header><h1 class="page-title">' + title + '</h1></header><div class="page-body">' + body + '</div></article></body></html>';
  const entries = [
    [paths.page, format === 'html' ? html('Z portal ' + label, '<p>' + pageBody + '</p><a href="' + databaseHref + '">A tarefas ' + label + '</a>') : '# Z portal ' + label + '\n\n' + pageBody + '\n\n[A tarefas ' + label + '](' + databaseHref + ')'],
    [paths.database, 'Nome,Status\r\nEntrega ' + label + ',Pronto\r\n'],
    [paths.row, format === 'html' ? html('Entrega ' + label, '<p>Status: Pronto</p><p>' + rowBody + '</p><a href="' + pageHref + '">Z portal ' + label + '</a>') : '# Entrega ' + label + '\n\nStatus: Pronto\n\n' + rowBody + '\n\n[Z portal ' + label + '](' + pageHref + ')'],
  ];
  const zip = new yazl.ZipFile(), chunks = [];
  const bytes = new Promise((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, body] of entries) zip.addBuffer(Buffer.from(body), name);
  zip.end();
  const filename = path.join(directory, 'notion-' + format + '.zip');
  await fs.writeFile(filename, await bytes);
  return { filename, paths, originals: new Map(entries), pageBody, rowBody, format, label };
}

async function importViaDialog(app, page, fixture) {
  const existing = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot.groups.map(group => group.id));
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, fixture.filename);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Buscar notas, grupos, sessões ou comandos', exact: true });
  await search.fill('Importar do Notion');
  await search.press('Enter');
  const chooser = page.getByRole('dialog', { name: 'Importar do Notion', exact: true });
  await chooser.waitFor();
  await chooser.getByRole('button', { name: 'Selecionar ZIP…', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Importação concluída', exact: true });
  await report.waitFor();
  const totals = await report.locator('.import-stats strong').allTextContents();
  assert.equal(totals[0], '3', 'the report counts both pages and the CSV');
  assert.equal(totals[2], '3', 'the report counts all preserved originals');
  const snapshot = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
  const group = snapshot.groups.find(item => !existing.includes(item.id) && item.imported?.source === 'notion');
  assert.ok(group, 'import creates an independent, visible group');
  const sessions = new Set(group.sessions.map(session => session.id));
  const imported = snapshot.notes.filter(note => sessions.has(note.s) && note.imported && !note.imported.archive);
  assert.equal(imported.length, 3);
  const notes = Object.fromEntries(Object.entries(fixture.paths).map(([key, relativePath]) => [key, imported.find(note => note.imported.path === relativePath)]));
  assert.ok(notes.page && notes.database && notes.row, 'all exported paths become notes');
  return { report, snapshot, group, notes };
}

function editor(page, note) {
  return page.locator('[data-editor="' + note.id + '"]');
}

async function assertRendered(page, note, body) {
  const pane = page.locator('article[data-pane="' + note.id + '"]');
  await pane.waitFor();
  assert.equal(await pane.getByRole('textbox', { name: 'Título da nota', exact: true }).inputValue(), note.title);
  assert.ok(await editor(page, note).isVisible(), 'the imported note has a visible editor');
  assert.ok((await editor(page, note).innerText()).includes(body), 'the expected imported content is rendered');
  assert.equal(await page.getByRole('textbox', { name: 'Conteúdo da nota', exact: true }).count(), 1, 'one visual editor is mounted');
}

async function assertTable(page, note, fixture) {
  const table = editor(page, note).locator('table');
  await table.waitFor();
  const text = await table.innerText();
  assert.ok(text.includes('Nome') && text.includes('Status') && text.includes('Pronto'));
  assert.ok(text.includes('Entrega ' + fixture.label), 'the original database row is visible in the table');
}

async function assertNoUpload(app, page) {
  const commands = await app.evaluate(() => ({
    git: global.__notesTest.tools.fixtureState.gitCommands,
    github: global.__notesTest.tools.fixtureState.commands,
  }));
  assert.equal(commands.git.filter(args => args.includes('fetch') || args.includes('push')).length, 0, 'importing, opening and saving do not fetch or push');
  assert.equal(commands.github.filter(args => ['auth', 'api', 'repo'].includes(args[0])).length, 0, 'the flow does not log in or create a real GitHub repository');
  assert.equal((await page.evaluate(() => window.notes.bootstrap())).sync.connected, false);
}

async function saveAndReload(page, note, body) {
  await page.keyboard.press('Control+s');
  await waitPage(page, async id => {
    const { snapshot } = await window.notes.bootstrap();
    return snapshot.focusBy[snapshot.session] === id;
  }, note.id);
  await page.reload();
  await assertRendered(page, note, body);
}

async function runFormat(directory, format) {
  const fixture = await makeExport(directory, format);
  const dataDir = path.join(directory, format + '-profile');
  await fs.mkdir(dataDir);
  const evidence = path.join(directory, format + '-evidence');
  await fs.mkdir(evidence);
  const env = { ...process.env, NOTES_TEST: '1', NOTES_TEST_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const errors = [], externalRequests = [];
  try {
    app = await electron.launch({ args: [project], env, timeout: 30000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:\/\//i.test(request.url())) externalRequests.push(request.url()); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    await page.waitForSelector('article[data-pane]');
    const first = await importViaDialog(app, page, fixture);
    const selected = first.snapshot.notes.find(note => note.id === first.snapshot.focusBy[first.snapshot.session]);
    const buttons = await first.report.getByRole('button').allTextContents();
    const observation = {
      format,
      contentNotes: 3,
      initialTitle: selected?.title,
      initialFormat: selected?.imported?.format,
      startsOnPage: selected?.id === first.notes.page.id,
      reportEntries: await first.report.getByRole('button', { name: /^Abrir (?:nota|tabela) / }).count(),
      reportButtons: buttons,
    };
    await page.screenshot({ path: path.join(evidence, 'import-report.png') });
    console.log('OBSERVED: ' + JSON.stringify(observation));
    await first.report.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click();
    // Use the existing session/list navigation as well as actual editor links.
    // A CSV row remains data unless the export itself supplies a page link.
    await page.locator('[data-session-id="' + first.notes.page.s + '"]').click();
    await page.locator('[data-note-row][data-note-id="' + first.notes.page.id + '"]').click();
    await assertRendered(page, first.notes.page, fixture.pageBody);
    await editor(page, first.notes.page).locator('a[data-note]').filter({ hasText: first.notes.database.title }).click();
    await assertTable(page, first.notes.database, fixture);
    await page.locator('[data-session-id="' + first.notes.row.s + '"]').click();
    await page.locator('[data-note-row][data-note-id="' + first.notes.row.id + '"]').click();
    await assertRendered(page, first.notes.row, fixture.rowBody);
    await saveAndReload(page, first.notes.row, fixture.rowBody);
    await editor(page, first.notes.row).locator('a[data-note]').filter({ hasText: first.notes.page.title }).click();
    await assertRendered(page, first.notes.page, fixture.pageBody);
    await page.keyboard.press('Control+s');
    const final = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
    for (const note of Object.values(first.notes)) {
      const current = final.notes.find(item => item.id === note.id);
      assert.ok(current, 'all imported documents remain present');
      // Tiptap can add a trailing paragraph and serialize a Markdown table with
      // aligned columns on focus. Compare the complete parsed content rather
      // than treating that equivalent serialization as a lost document.
      assert.deepEqual(markdownMeaning(current.body), markdownMeaning(note.body), 'navigation preserves text, links and table structure');
      const { body: _body, richText: _richText, t: _time, ...metadata } = current;
      const { body: _originalBody, t: _originalTime, ...originalMetadata } = note;
      assert.deepEqual(metadata, originalMetadata, 'navigation preserves IDs, sessions and import metadata');
      if (current.richText) assert.equal(current.richText.source, current.body, 'rich content tracks the current compatible body');
      const originalFile = await app.evaluate(async (_electron, hash) => global.__notesTest.assets.file(hash), current.imported.originalHash);
      assert.deepEqual(await fs.readFile(originalFile), Buffer.from(fixture.originals.get(current.imported.path)), 'the archived source bytes remain exact');
    }
    assert.deepEqual(errors, [], 'the renderer emits no unhandled errors');
    assert.deepEqual(externalRequests, [], 'the synthetic import is entirely offline');
    await assertNoUpload(app, page);
    await page.screenshot({ path: path.join(evidence, 'notion-navigation.png') });
    console.log('PASS: Notion ' + fixture.label + ' → 3 imported notes → page/database link → row session → reload; no upload.');
    return { ...observation, passed: true };
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (page && !page.isClosed()) await page.context().tracing.stop({ path: path.join(evidence, 'trace.zip') }).catch(() => {});
    if (app) {
      await app.evaluate(async ({ app }) => {
        await global.__notesTest?.sync.close();
        await global.__notesTest?.tools.close();
        await global.__notesTest?.store.close();
        app.exit(0);
      }).catch(() => {});
      await app.close().catch(() => {});
    }
  }
}

async function main() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'notes-notion-ui-'));
  console.log('EVIDENCE: ' + directory);
  const results = [];
  for (const format of ['html', 'markdown']) results.push(await runFormat(directory, format));
  await fs.writeFile(path.join(directory, 'validation.json'), JSON.stringify({ results }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
