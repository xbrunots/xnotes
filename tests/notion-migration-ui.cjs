'use strict';

// Real Electron/preload/IPC/migration/store/editor. The account and all MCP
// replies are synthetic; QA cannot open a browser login or reach Notion.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { waitPage } = require('./helpers/wait-page.cjs');

async function openImport(page) {
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Buscar notas, grupos, sessões ou comandos', exact: true });
  await search.fill('Importar do Notion'); await search.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Importar do Notion', exact: true });
  await dialog.waitFor(); return dialog;
}

async function main() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'notes-notion-connected-ui-'));
  console.log('EVIDENCE: ' + directory);
  const env = { ...process.env, NOTES_TEST: '1', NOTES_TEST_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  let application, page;
  const errors = [], requests = [];
  try {
    application = await electron.launch({ args: [path.resolve(__dirname, '..')], env, timeout: 30000 });
    page = await application.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForSelector('article[data-pane]');
    await application.evaluate(async () => {
      const ROOT = '11111111-2222-4333-8444-555555555555', CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const state = { mode: 'complete', connected: false, calls: [], connects: 0 };
      global.__notionFixture = state;
      const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      const client = {
        status: () => ({ connected: state.connected, state: state.connected ? 'connected' : 'disconnected', account: state.connected ? { workspaceId: 'qa-workspace', userId: 'qa-user', workspaceName: 'Workspace de exemplo' } : null }),
        connect: async () => { state.connected = true; state.connects++; return client.status(); },
        disconnect: async () => { state.connected = false; return client.status(); },
        listTools: async () => {
          state.calls.push('tools/list');
          return [
            { name: 'notion-list-private-pages', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, cursor: { type: 'string' } } } },
            { name: 'notion-list-shared-pages', inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, cursor: { type: 'string' } } } },
            { name: 'notion-fetch', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
            { name: 'notion-get-comments', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, include_resolved: { type: 'boolean' }, include_all_blocks: { type: 'boolean' } } } },
          ];
        },
        callTool: async (name, args, { signal } = {}) => {
          state.calls.push(name);
          if (name === 'notion-list-private-pages') return reply({ results: [{ type: 'page', url: 'https://app.notion.com/p/' + ROOT, title: 'Projeto de exemplo' }], has_more: false });
          if (name === 'notion-list-shared-pages') return reply({ results: [], has_more: false });
          if (name === 'notion-get-comments') return reply({ comments: [] });
          if (name !== 'notion-fetch') throw new Error('Unexpected synthetic tool');
          if (state.mode === 'waiting') await new Promise((resolve, reject) => {
            if (signal.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
          });
          const child = args.id.replace(/-/g, '').includes(CHILD.replace(/-/g, ''));
          if (child && state.mode === 'partial') throw new Error('permission_error');
          const title = child ? 'Detalhes da entrega' : 'Projeto de exemplo';
          const body = child ? 'Conteúdo completo da página filha.\n\n[Projeto](https://app.notion.com/p/' + ROOT + ')' : 'Uma biblioteca sintética para validar a migração.\n\n<page url="https://app.notion.com/p/' + CHILD + '">Detalhes da entrega</page>\n\n```javascript\nfunction exemplo() {\n\treturn 42;\n}\n```';
          return reply({ title, text: '<page url="' + args.id + '"><properties>{"title":"' + title + '"}</properties><content>\n' + body + '\n</content></page>', ...(state.mode === 'gap' && !child ? { truncated: true, unknown_block_count: 1 } : {}) });
        },
      };
      await global.__notesTest.setNotionClient(client);
    });
    const original = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot.notes.map(note => note.id));
    let dialog = await openImport(page);
    assert.equal(await application.evaluate(() => global.__notionFixture.calls.length), 0, 'opening the chooser does not read Notion');
    await dialog.getByRole('button', { name: 'Conectar ao Notion', exact: true }).click();
    await dialog.getByText('Conteúdo acessível conferido', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Selecionar ZIP…', exact: true }).count(), 1);
    assert.deepEqual(await dialog.locator('.import-stats strong').allTextContents(), ['2', '0', '0']);
    assert.equal((await page.evaluate(async () => (await window.notes.bootstrap()).snapshot.notes)).length, original.length, 'the inventory does not mutate the workspace');
    const plan = await page.evaluate(async () => (await window.notes.notionStatus()).migration.id);
    await page.screenshot({ path: path.join(directory, 'inventory.png') });
    await dialog.getByRole('button', { name: 'Importar biblioteca', exact: true }).click();
    const report = page.getByRole('dialog', { name: 'Importação concluída', exact: true });
    await report.waitFor();
    assert.equal(await report.getByRole('button', { name: 'Abrir nota Projeto de exemplo', exact: true }).count(), 1);
    let snapshot = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
    const group = snapshot.groups.find(item => item.imported?.notionMigrationId === plan);
    assert.ok(group, 'the committed group identifies its migration plan');
    const imported = snapshot.notes.filter(note => note.imported?.notionMigrationId === plan && !note.imported.archive);
    assert.equal(imported.length, 2);
    for (const id of original) assert.ok(snapshot.notes.some(note => note.id === id), 'existing notes remain intact');
    const duplicate = await page.evaluate(id => window.notes.importNotion(id), plan);
    assert.equal(duplicate.alreadyImported, true, 'retrying a committed plan is idempotent');
    assert.equal((await page.evaluate(async () => (await window.notes.bootstrap()).snapshot.notes)).length, snapshot.notes.length);
    await report.getByRole('button', { name: 'Abrir nota Projeto de exemplo', exact: true }).click();
    const parent = imported.find(note => note.title === 'Projeto de exemplo');
    const editor = page.locator('[data-editor="' + parent.id + '"]');
    await editor.waitFor();
    assert.ok((await editor.innerText()).includes('Uma biblioteca sintética'));
    await editor.locator('a[data-note]').filter({ hasText: 'Detalhes da entrega' }).click();
    const child = imported.find(note => note.title === 'Detalhes da entrega');
    await page.locator('[data-editor="' + child.id + '"]').waitFor();
    assert.ok((await page.locator('[data-editor="' + child.id + '"]').innerText()).includes('Conteúdo completo da página filha.'));

    // Cancellation persists a resumable plan, not a partially committed group.
    await application.evaluate(() => { global.__notionFixture.mode = 'waiting'; });
    dialog = await openImport(page);
    await dialog.getByRole('button', { name: 'Localizar biblioteca', exact: true }).click();
    await waitPage(page, () => document.querySelector('.migration-progress strong')?.textContent === 'Localizando páginas e bancos');
    await dialog.getByRole('button', { name: 'Interromper', exact: true }).click();
    await dialog.getByRole('button', { name: 'Retomar verificação', exact: true }).waitFor();
    assert.equal((await page.evaluate(async () => (await window.notes.notionStatus()).migration.state)), 'cancelled');
    await application.evaluate(() => { global.__notionFixture.mode = 'complete'; });
    await dialog.getByRole('button', { name: 'Retomar verificação', exact: true }).click();
    await dialog.getByText('Conteúdo acessível conferido', { exact: true }).waitFor();

    // Truncated provider replies must never offer a silently complete import.
    await application.evaluate(() => { global.__notionFixture.mode = 'gap'; });
    await dialog.getByRole('button', { name: 'Conferir novamente', exact: true }).click();
    await dialog.getByText('Há pendências para uma migração completa', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Importar biblioteca', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Importar conteúdo encontrado', exact: true }).count(), 1);
    assert.ok(await dialog.locator('.migration-issues').innerText());
    await page.screenshot({ path: path.join(directory, 'coverage-gap.png') });
    await dialog.getByRole('button', { name: 'Importar conteúdo encontrado', exact: true }).click();
    await report.waitFor();
    assert.ok((await report.locator('.import-warning').innerText()).includes('omitiu blocos'));
    await report.getByRole('button', { name: 'Abrir biblioteca', exact: true }).click();

    // A partial import can be completed later, through the same UI and store,
    // while retaining local edits and links to the already imported page.
    await application.evaluate(() => { global.__notionFixture.mode = 'partial'; });
    dialog = await openImport(page);
    await dialog.getByRole('button', { name: 'Localizar biblioteca', exact: true }).click();
    await dialog.getByText('Há pendências para uma migração completa', { exact: true }).waitFor();
    const partialPlan = await page.evaluate(async () => (await window.notes.notionStatus()).migration.id);
    await dialog.getByRole('button', { name: 'Importar conteúdo encontrado', exact: true }).click();
    await report.waitFor();
    snapshot = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
    const partialParent = snapshot.notes.find(note => note.imported?.notionMigrationId === partialPlan && note.imported?.notionId && !note.imported.archive);
    const partialGroup = snapshot.groups.find(item => item.imported?.notionMigrationId === partialPlan);
    await report.getByRole('button', { name: 'Abrir nota '+partialParent.title, exact: true }).click();
    await page.locator('article[data-pane="' + partialParent.id + '"]').getByRole('textbox', { name: 'Título da nota', exact: true }).fill('Título local preservado');
    await page.keyboard.press('Control+s');
    await waitPage(page, async id => (await window.notes.bootstrap()).snapshot.notes.find(note => note.id === id)?.title === 'Título local preservado', partialParent.id);
    await application.evaluate(() => { global.__notionFixture.mode = 'complete'; });
    dialog = await openImport(page);
    await dialog.getByRole('button', { name: 'Retomar verificação', exact: true }).click();
    await dialog.getByText('Conteúdo acessível conferido', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Importar biblioteca', exact: true }).click();
    await report.waitFor();
    snapshot = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
    assert.equal(snapshot.groups.filter(item => item.imported?.notionMigrationId === partialPlan).length, 1, 'resume reuses the same committed group');
    assert.equal(snapshot.groups.find(item => item.id === partialGroup.id)?.id, partialGroup.id);
    assert.equal(snapshot.notes.find(note => note.id === partialParent.id).title, 'Título local preservado', 'resume preserves the local title edit');
    const appended = snapshot.notes.find(note => note.imported?.notionMigrationId === partialPlan && note.id !== partialParent.id && note.imported?.notionId);
    assert.ok(appended, 'the previously inaccessible child is appended');
    assert.ok(snapshot.openBy[partialParent.s].includes(partialParent.id), 'resume keeps the previous tab');
    await report.getByRole('button', { name: 'Abrir nota '+appended.title, exact: true }).click();
    await page.locator('[data-editor="' + appended.id + '"] a[data-note]').filter({ hasText: 'Título local preservado' }).click();
    assert.equal(await page.locator('article[data-pane="' + partialParent.id + '"]').getByRole('textbox', { name: 'Título da nota', exact: true }).inputValue(), 'Título local preservado');
    await page.keyboard.press('Control+s'); await page.reload();
    await page.waitForSelector('article[data-pane]');
    snapshot = await page.evaluate(async () => (await window.notes.bootstrap()).snapshot);
    assert.ok(snapshot.groups.some(item => item.imported?.notionMigrationId === plan), 'the import survives reload');
    assert.deepEqual(errors, [], 'there are no unhandled renderer errors');
    assert.deepEqual(requests, [], 'the renderer makes no external requests');
    const commands = await application.evaluate(() => global.__notesTest.tools.fixtureState.gitCommands);
    assert.equal(commands.filter(args => args.includes('fetch') || args.includes('push')).length, 0, 'migration does not upload to GitHub');
    console.log('PASS: connected inventory, explicit commit, links, idempotence, cancel/resume, gaps, partial append with local edits/tabs, reload and no upload.');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (application) {
      await application.evaluate(async ({ app }) => { await global.__notesTest?.sync.close(); await global.__notesTest?.tools.close(); await global.__notesTest?.store.close(); app.exit(0); }).catch(() => {});
      await application.close().catch(() => {});
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
