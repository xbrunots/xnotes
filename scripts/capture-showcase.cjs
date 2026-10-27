// Public product screenshots, rendered by the actual app with synthetic data.
// Never opens a real profile, connects an account or registers a Windows task.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const seed = require('../desktop/seed.json');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'assets');

function showcase() {
  return {
    ...seed,
    theme: 'dark', themePreset: 'carbon', appearance: 'islands',
    noteDisplay: 'grid', layout: 'split', sidebar: true,
    motion: false, blur: 28, accent: 'Violeta',
    groups: [
      { id: 'g-showcase', name: 'Meu espaço', color: '#9C91F4', sessions: [
        { id: 's-showcase', name: 'Ideias em movimento' },
        { id: 's-reading', name: 'Leituras e referências' },
        { id: 's-journal', name: 'Diário de bordo' },
      ] },
      { id: 'g-projects', name: 'Projetos', color: '#83D5DB', sessions: [
        { id: 's-projects', name: 'Próximo lançamento' },
      ] },
    ],
    notes: [
      { id: 'n-welcome', s: 's-showcase', title: 'Espaço para pensar', t: 'Hoje', noteTheme: 'indigo',
        body: '# Suas ideias merecem espaço.\n\nUm pensamento solto. Um trecho de código. A próxima grande ideia. Tudo começa com uma nota.\n\n## Menos ruído, mais clareza\n- [x] Organizar ideias em sessões\n- [x] Escrever sem depender da internet\n- [ ] Conectar os próximos pontos\n\nContinue em [[Pequenas decisões]]. #ideias #produto' },
      { id: 'n-code', s: 's-showcase', title: 'Ideia em código', t: 'Hoje', noteTheme: 'petrol',
        body: '## Uma ideia que também é código\n\nGuarde a explicação junto do trecho que importa.\n\n```javascript\nconst ideas = ["escrever", "conectar", "criar"];\n\nfunction nextStep(idea) {\n  return { idea, status: "em movimento" };\n}\n\nideas.map(nextStep);\n```\n\nEditor Monaco local. O código fica como conteúdo e não é executado. #desenvolvimento' },
      { id: 'n-decisions', s: 's-showcase', title: 'Pequenas decisões', t: 'Ontem', noteTheme: 'sand',
        body: '## Fazer o essencial muito bem\n\n> Uma boa ferramenta deixa espaço para o trabalho.\n\n1. Escrever primeiro, organizar depois.\n2. Manter o contexto por perto.\n3. Transformar intenção em um próximo passo.\n\nVeja também [[Espaço para pensar]]. #design #produto' },
      { id: 'n-flow', s: 's-showcase', title: 'No seu ritmo', t: 'Ontem',
        body: '## Capturar → conectar → criar\n\nAnote antes de esquecer. Encontre relações entre ideias. Escolha o próximo passo.\n\nAs notas ficam neste computador. Conecte o GitHub quando quiser sincronizar. #foco' },
    ],
    session: 's-showcase', view: 'session', tag: null,
    expanded: { 'g-showcase': true, 'g-projects': true },
    openBy: { 's-showcase': ['n-welcome', 'n-code', 'n-decisions', 'n-flow'] },
    focusBy: { 's-showcase': 'n-welcome' },
  };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-showcase-'));
  const env = { ...process.env, NOTES_TEST: '1', NOTES_TEST_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [root], env, timeout: 30000 });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForSelector('[data-app-shell]');
    await app.evaluate(async (_electron, snapshot) => global.__notesTest.store.save(snapshot), showcase());
    await page.getByRole('tab', { name: 'Espaço para pensar', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-masonry-placed]').length === 4);
    await page.waitForFunction(() => document.querySelector('[data-code-widget]')?.dataset.codeReady === 'true');
    await page.waitForFunction(() => new Set([...document.querySelectorAll('[data-code-widget] .view-lines span[class^="mtk"]')].map(element => getComputedStyle(element).color)).size > 1);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, 'notes-dark.png'), animations: 'disabled' });

    await page.keyboard.press('Control+,');
    await page.getByRole('radio', { name: 'Neve', exact: true }).click();
    await page.getByRole('button', { name: 'Concluir', exact: true }).click();
    await page.locator('.dialog-backdrop').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-app-shell]')).getPropertyValue('--wall').trim().toLowerCase() === '#edf0f5');
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, 'notes-light.png'), animations: 'disabled' });
    assert.deepEqual(errors, [], 'Public screenshots must render without page errors.');
    console.log('Capturas reais: docs/assets/notes-dark.png e notes-light.png. Perfil temporário e conteúdo fictício.');
  } finally {
    if (app) await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
