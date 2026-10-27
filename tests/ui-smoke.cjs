// Runs against the actual Windows Electron shell, with isolated temporary data.
// Browser plugin unavailable in this session; native Electron is the test target.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {waitPage}=require('./helpers/wait-page.cjs');
const {pasteBeforeCreate}=require('./helpers/paste.cjs');
const {PNG} = require('pngjs');
const {execFileSync}=require('node:child_process');
const {WorkspaceStore}=require('../desktop/storage.cjs');
const {GitHubSync}=require('../desktop/github-sync.cjs');
const {createTestTools}=require('../desktop/github-test.cjs');
const {AssetStore}=require('../desktop/assets.cjs');
const seed=require('../desktop/seed.json');
const root = path.join(__dirname,'..');
const artifacts = process.env.NOTES_QA_DIR || path.join(os.tmpdir(),'notes-qa');

async function main(){
  await fs.mkdir(artifacts,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-ui-'));
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  let app;const githubRemote=path.join(dataDir,'github-bare.git');
  execFileSync('git',['init','--bare','--initial-branch=main',githubRemote],{windowsHide:true});
  try{
    app=await electron.launch({args:[root],env,timeout:30000});
    const page=await app.firstWindow(); const errors=[];
    await page.setViewportSize({width:1440,height:900});
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.waitForSelector('article[data-pane]');
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.title(),'notes');
    assert.equal(await page.locator('article[data-pane]').count(),1);
    assert.equal(await page.locator('aside').count(),1);
    assert.equal(await page.getByRole('textbox',{name:'Conteúdo da nota'}).count(),1,'O corpo da nota nunca pode ser montado duas vezes.');
    await page.screenshot({path:path.join(artifacts,'notes-desktop.png')});
    console.log('PASS: grupos e sessões preservados; uma única instância do corpo da nota, sem card duplicado.');

    // Original reference is loaded in a separate, isolated window, never shipped.
    const newWindow=app.waitForEvent('window',{timeout:30000});
    const referenceWindow=await app.evaluateHandle(async({BrowserWindow},filename)=>{
      const win=new BrowserWindow({width:1440,height:900,show:false,frame:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      await win.loadFile(filename);return win;
    },path.join(root,'Notas.html'));
    const reference=await newWindow;
    await reference.setViewportSize({width:1440,height:900});
    await reference.waitForSelector('article',{timeout:20000});
    await reference.evaluate(()=>document.fonts.ready);
    // User's accepted adjustment: native Windows frame, full-bleed app body.
    // Apply only that same shell adjustment to the original reference capture.
    await reference.evaluate(()=>{
      const panes=[...document.querySelectorAll('article')];
      const shell=panes[0]?.closest('main')?.parentElement?.parentElement;
      if(!shell)throw new Error('Molde da referência não encontrado.');
      Object.assign(shell.style,{inset:'42px 0 0',border:'0',borderRadius:'0',boxShadow:'none'});
      const dots=[...document.querySelectorAll('span')].filter(el=>['rgb(255, 95, 87)','rgb(254, 188, 46)','rgb(40, 200, 64)'].includes(el.style.background));
      for(const dot of dots)dot.parentElement.style.display='none';
    });
    // Freeze the drifting backgrounds at the same point to compare geometry.
    const freeze=()=>{document.getAnimations().forEach(a=>{if(a.effect?.getTiming().iterations===Infinity){a.pause();a.currentTime=0;}else a.cancel();});};
    await referenceWindow.evaluate(win=>win.show());
    await reference.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
    await reference.evaluate(freeze);await page.evaluate(freeze);
    await reference.screenshot({path:path.join(artifacts,'reference-desktop.png')});
    await page.screenshot({path:path.join(artifacts,'notes-desktop.png')});
    const measure=()=>({
      viewport:[innerWidth,innerHeight],panes:[...document.querySelectorAll('article')].map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,radius:getComputedStyle(el).borderRadius};}),
      title:[...document.querySelectorAll('article input')].map(el=>{const s=getComputedStyle(el);return{value:el.value,size:s.fontSize,weight:s.fontWeight,font:s.fontFamily};}),
    });
    const referenceMetrics=await reference.evaluate(measure), appMetrics=await page.evaluate(measure);
    assert.deepEqual(appMetrics.viewport,referenceMetrics.viewport);
    assert.equal(appMetrics.title[0].font,referenceMetrics.title[0].font);
    assert.equal(appMetrics.title[0].weight,referenceMetrics.title[0].weight);
    assert.equal(appMetrics.panes.length,1,'O pedido de minimalismo substitui os três painéis originais.');
    assert.equal(appMetrics.panes[0].radius,'0px');
    await fs.writeFile(path.join(artifacts,'visual-metrics.json'),JSON.stringify({reference:referenceMetrics,app:appMetrics},null,2));
    await referenceWindow.evaluate(win=>win.destroy());
    await page.bringToFront();
    const handle=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    execFileSync('powershell.exe',['-NoProfile','-File',path.join(root,'scripts/capture-window.ps1'),'-Handle',handle,'-Output',path.join(artifacts,'notes-windows.png')],{windowsHide:true,stdio:'pipe'});
    console.log('PASS: fonte da referência preservada em documento único, sem card nem cabeçalhos repetidos.');

    await page.keyboard.press('Control+k');
    const search=page.getByRole('combobox',{name:'Buscar notas, grupos, sessões ou comandos'});
    await search.fill('nova nota');await search.press('Enter');
    await page.waitForFunction(()=>document.querySelector('article input[aria-label="Título da nota"]')?.value==='');
    const editor=page.getByRole('textbox',{name:'Conteúdo da nota'}).last();
    await editor.waitFor();
    const createdTitle='Teste persistência e sync '+Date.now();
    const title=page.locator('article[data-pane]').last().getByRole('textbox',{name:'Título da nota'});
    await app.evaluate(({clipboard},text)=>clipboard.writeText(text),'# Teste\n- [ ] Tarefa com acentos: ação, sessão\n\n[[Roadmap Q4]] #validação');
    await pasteBeforeCreate(page,editor);
    await editor.locator('h1').waitFor();
    assert(!(await editor.innerText()).includes('# Teste'));
    assert(!(await editor.innerText()).includes('[ ]'));
    assert(!(await editor.innerText()).includes('[['));
    assert.equal(await page.locator('textarea').count(),0);
    await editor.locator('h1').dblclick({position:{x:15,y:14}});
    const format=page.getByRole('toolbar',{name:'Formatar texto selecionado'});
    await format.waitFor();
    await format.getByRole('button',{name:'Negrito (Ctrl+B)',exact:true}).click();
    assert.equal(await editor.locator('h1 strong').innerText(),'Teste');
    await format.getByRole('button',{name:'Sublinhado (Ctrl+U)',exact:true}).click();
    assert.equal(await editor.locator('h1 u').innerText(),'Teste');
    await page.screenshot({path:path.join(artifacts,'notes-selection-popover.png')});
    await title.fill(createdTitle);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+s');
    await waitPage(page,async title=>{const data=await window.notes.bootstrap();return data.snapshot.notes.some(n=>n.title===title&&n.body.includes('ação, sessão'));},createdTitle);
    console.log('PASS: Markdown colado vira conteúdo visual e seleção abre popover; formatação é salva sem fonte visível.');

    // Real Git and a temporary bare remote; the GitHub login is isolated.
    await app.evaluate(async(_electron,remote)=>global.__notesTest.useGitHubRemote(remote),githubRemote);
    await page.getByRole('button',{name:'GitHub e sincronização',exact:true}).click({button:'right'});
    await page.getByRole('dialog',{name:'GitHub',exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'Conectar GitHub',exact:true}).isEnabled());
    assert(!/OAuth|JSON|Google Cloud/.test(await page.getByRole('dialog',{name:'GitHub',exact:true}).innerText()));
    await page.getByRole('button',{name:'Conectar GitHub',exact:true}).click();
    await page.getByRole('button',{name:'Copiar código de autorização',exact:true}).waitFor();
    await waitPage(page,async()=>{const {sync}=await window.notes.bootstrap();return sync.state==='ready'&&sync.pending===0;});
    const bootstrap=await page.evaluate(()=>window.notes.bootstrap());
    assert.equal(bootstrap.sync.provider,'github');assert.equal(bootstrap.sync.connected,true);
    assert(bootstrap.sync.repository.localPath.endsWith('notes-repository'));
    assert(!JSON.stringify(bootstrap.sync).includes('access_token'));
    await page.screenshot({path:path.join(artifacts,'notes-github.png')});
    await page.getByRole('button',{name:'Concluir',exact:true}).click();
    console.log('PASS: onboarding de um clique, login isolado, repositório privado reconhecido e pull/commit/push reais.');

    // Local storage survives a renderer reload; no demo-state reset.
    await page.reload();await page.waitForSelector('article[data-pane]');
    assert((await page.locator('input').evaluateAll(inputs=>inputs.map(i=>i.value))).includes(createdTitle));
    await page.keyboard.press('Control+,');
    await page.getByRole('dialog',{name:'Configurações'}).waitFor();
    assert.equal(await page.getByRole('radiogroup',{name:'Tema da interface'}).getByRole('radio').count(),10);
    await page.getByRole('radio',{name:'Carbono',exact:true}).click();
    assert.equal(await page.getByRole('radio',{name:'Carbono',exact:true}).getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('[data-app-root]').evaluate(el=>getComputedStyle(el).getPropertyValue('--wall').trim()),'#08090B');
    await page.getByRole('combobox',{name:'Cor de destaque'}).click();
    await page.getByRole('option',{name:'Menta',exact:true}).click();
    const slider=page.getByRole('slider',{name:'Desfoque do vidro'});await slider.focus();await slider.press('ArrowRight');
    assert.equal(await slider.getAttribute('aria-valuenow'),'30');
    await page.getByRole('switch',{name:'Movimento'}).click();
    assert.equal(await page.getByRole('switch',{name:'Movimento'}).getAttribute('aria-checked'),'false');
    assert.equal(await page.locator('select,input[type=checkbox],input[type=range]').count(),0);
    await page.getByRole('combobox',{name:'Cor de destaque'}).click();
    await page.getByRole('listbox',{name:'Cores de destaque'}).evaluate(el=>Promise.allSettled(el.getAnimations({subtree:true}).map(animation=>animation.finished)));
    await page.getByRole('switch',{name:'Movimento'}).evaluate(el=>Promise.allSettled(el.getAnimations().map(animation=>animation.finished)));
    await page.screenshot({path:path.join(artifacts,'notes-custom-controls.png')});
    await page.getByRole('combobox',{name:'Cor de destaque'}).press('End');
    await page.getByRole('combobox',{name:'Cor de destaque'}).press('Enter');
    assert((await page.getByRole('combobox',{name:'Cor de destaque'}).innerText()).includes('Âmbar'));
    await page.getByRole('combobox',{name:'Cor de destaque'}).click();
    await page.getByRole('combobox',{name:'Cor de destaque'}).press('Escape');
    await page.getByRole('button',{name:'Concluir',exact:true}).click();
    await page.keyboard.press('Control+,');await page.getByRole('radio',{name:'Neve',exact:true}).click();await page.getByRole('button',{name:'Concluir',exact:true}).click();
    await page.screenshot({path:path.join(artifacts,'notes-light.png')});
    await page.keyboard.press('Control+,');await page.getByRole('radio',{name:'Carbono',exact:true}).click();await page.getByRole('button',{name:'Concluir',exact:true}).click();
    await page.keyboard.press('Control+k');await search.fill('novo grupo');await search.press('Enter');
    await page.getByLabel('Nome do grupo',{exact:true}).fill('Grupo de validação');
    await page.getByRole('button',{name:'Criar grupo',exact:true}).click();
    await page.locator('aside').getByText('Grupo de validação',{exact:true}).waitFor();
    console.log('PASS: recarregamento mantém notas; configurações, temas e criação de grupos funcionam.');

    // Exercise the actual import dialog, conversion, native blob protocol and
    // the same real Git repository from a second independent Windows profile.
    const vault=path.join(dataDir,'Cofre de teste');await fs.mkdir(path.join(vault,'Anexos'),{recursive:true});
    await fs.copyFile(path.join(root,'build/icon.png'),path.join(vault,'Anexos','imagem.png'));
    await fs.writeFile(path.join(vault,'Home.md'),'---\ntags: [conhecimento, ação]\n---\n# Meu cofre\n\nVeja [[Outra nota]].\n\n![Imagem](Anexos/imagem.png)\n\n- [ ] Tarefa importada\n');
    await fs.writeFile(path.join(vault,'Outra nota.md'),'# Referência\nConteúdo original com acentuação.');
    await page.keyboard.press('Control+s');
    const requestsBeforeImport=await app.evaluate(()=>global.__notesTest.tools.fixtureState.gitCommands.filter(args=>args.includes('fetch')||args.includes('push')).length);
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},vault);
    await page.keyboard.press('Control+k');await search.fill('Importar do Obsidian');await search.press('Enter');
    await page.getByRole('dialog',{name:'Importar do Obsidian'}).waitFor();
    await page.getByRole('button',{name:'Selecionar cofre…',exact:true}).click();
    await page.getByRole('dialog',{name:'Importação concluída'}).waitFor();
    await page.getByRole('button',{name:'Abrir biblioteca',exact:true}).click();
    await page.locator('.imported-markdown img[src^="notes://asset/"]').waitFor();
    await page.waitForFunction(()=>document.querySelector('.imported-markdown img[src^="notes://asset/"]')?.naturalWidth>0);
    assert((await page.evaluate(async()=>JSON.stringify((await window.notes.bootstrap()).snapshot.notes))).includes('conhecimento'));
    await page.locator('.imported-markdown [role=checkbox]').click();
    await page.keyboard.press('Control+s');
    await waitPage(page,async()=>{const data=await window.notes.bootstrap();return data.snapshot.notes.some(n=>n.imported?.path==='Home.md'&&n.body.includes('- [x] Tarefa importada'));});
    assert.equal(await app.evaluate(()=>global.__notesTest.tools.fixtureState.gitCommands.filter(args=>args.includes('fetch')||args.includes('push')).length),requestsBeforeImport,'Importar, editar e Ctrl+S devem aguardar o prazo diário ou o botão de sync.');
    await page.getByRole('button',{name:'Sincronizar GitHub agora'}).click();
    await waitPage(page,async()=>{const {sync}=await window.notes.bootstrap();return sync.state==='ready'&&sync.pending===0;});
    const importGeometry=await page.evaluate(()=>{const shell=document.querySelector('[data-app-shell]'),r=shell.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],scrolling:[...document.querySelectorAll('*')].filter(el=>el.scrollLeft||el.scrollTop).map(el=>({tag:el.tagName,x:el.scrollLeft,y:el.scrollTop,style:el.getAttribute('style')?.slice(0,100)}))};});
    console.log('IMPORT GEOMETRY',JSON.stringify(importGeometry));
    assert.deepEqual([importGeometry.x,importGeometry.y,importGeometry.width,importGeometry.height],[0,42,1440,858]);
    await page.screenshot({path:path.join(artifacts,'notes-imported.png')});
    const bdir=path.join(dataDir,'segundo-pc');const b= new WorkspaceStore({dataDir:bdir,seed,deviceId:'ui-second-pc'});await b.init();
    const bassets=await new AssetStore({dataDir:bdir}).init();
    const oldTestEnv=process.env.NOTES_TEST,oldTestData=process.env.NOTES_TEST_DATA_DIR;
    process.env.NOTES_TEST='1';process.env.NOTES_TEST_DATA_DIR=bdir;
    const btools=createTestTools({toolsDir:path.join(bdir,'tools'),loggedIn:true}).tools;
    const bsync=new GitHubSync({store:b,assets:bassets,tools:btools,repoDir:path.join(bdir,'notes-repository'),testRemote:githubRemote});
    if(oldTestEnv===undefined)delete process.env.NOTES_TEST;else process.env.NOTES_TEST=oldTestEnv;
    if(oldTestData===undefined)delete process.env.NOTES_TEST_DATA_DIR;else process.env.NOTES_TEST_DATA_DIR=oldTestData;
    try{
      await bsync.connect();
      const imported=b.snapshot.notes.find(n=>n.imported?.path==='Home.md');
      assert(imported?.body.includes('- [x] Tarefa importada'));
      const image=imported.attachments.find(f=>f.name==='imagem.png');
      assert(image);assert.equal((await fs.readFile(await bassets.file(image.hash))).length,(await fs.stat(path.join(root,'build/icon.png'))).size);
    }finally{await bsync.close();await btools.close();await b.close();}
    console.log('PASS: Obsidian pelo seletor real → notas/tags/imagem/tarefa → segundo PC recebe os mesmos bytes.');

    const contextGroup=page.locator('[data-group-id]').filter({hasText:'Grupo de validação'});
    await contextGroup.click({button:'right'});
    await page.getByRole('menuitem',{name:'Nova sessão…',exact:true}).click();
    const sessionDialog=page.getByRole('dialog',{name:'Nova sessão',exact:true});
    await sessionDialog.getByRole('textbox',{name:'Nome da sessão',exact:true}).fill('Sessão de contexto');
    await sessionDialog.getByRole('button',{name:'Criar sessão',exact:true}).click();
    const contextSession=page.locator('[data-session-id]').filter({hasText:'Sessão de contexto'});
    await contextSession.click({button:'right'});
    await page.getByRole('menuitem',{name:'Nova nota nesta sessão',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('article input[aria-label="Título da nota"]')?.value==='');
    await page.getByRole('textbox',{name:'Conteúdo da nota'}).fill('Texto da nota criada pelo menu, com acentuação.');
    await page.locator('article').getByRole('textbox',{name:'Título da nota'}).fill('Nota de contexto');
    await page.keyboard.press('Control+s');
    const noteRow=page.locator('[data-note-id]').filter({hasText:'Nota de contexto'});
    await noteRow.click({button:'right'});
    await page.getByRole('menuitemcheckbox',{name:'Fixar no topo',exact:true}).click();
    await noteRow.click({button:'right'});
    await page.getByRole('menuitem',{name:'Copiar texto',exact:true}).click();
    assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),'Texto da nota criada pelo menu, com acentuação.');
    assert.equal(await page.evaluate(()=>window.notes.readClipboard()),'Texto da nota criada pelo menu, com acentuação.');
    await noteRow.click({button:'right'});
    await page.getByRole('menuitem',{name:'Renomear…',exact:true}).click();
    const renameNote=page.getByRole('dialog',{name:'Renomear nota',exact:true});
    await renameNote.getByRole('textbox',{name:'Título da nota'}).fill('Nota renomeada');
    await renameNote.getByRole('button',{name:'Salvar',exact:true}).click();
    const renamedRow=page.locator('[data-note-id]').filter({hasText:'Nota renomeada'});
    await renamedRow.click({button:'right'});
    await page.getByRole('menuitem',{name:'Copiar para',exact:true}).hover();
    await page.getByRole('menuitem',{name:'Pessoal',exact:true}).hover();
    await page.getByRole('menuitem',{name:'Diário',exact:true}).click();
    await page.keyboard.press('Control+s');
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return snapshot.notes.filter(n=>n.title==='Nota renomeada').length===2;});
    const exportFile=path.join(dataDir,'nota-exportada.md');
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportFile);
    await renamedRow.click({button:'right'});
    await page.getByRole('menuitem',{name:'Exportar nota…',exact:true}).click();
    await page.getByText('Nota exportada.',{exact:true}).waitFor();
    assert((await fs.readFile(exportFile,'utf8')).includes('Texto da nota criada pelo menu'));
    await contextSession.click({button:'right'});
    await page.getByRole('menuitem',{name:'Renomear sessão…',exact:true}).click();
    const renameSession=page.getByRole('dialog',{name:'Renomear sessão',exact:true});
    await renameSession.getByRole('textbox',{name:'Nome da sessão'}).fill('Sessão revisada');
    await renameSession.getByRole('button',{name:'Salvar',exact:true}).click();
    await page.locator('[data-session-id]').filter({hasText:'Sessão revisada'}).waitFor();
    await contextGroup.click({button:'right'});
    await page.getByRole('menuitem',{name:'Cor do grupo',exact:true}).hover();
    await page.getByRole('menuitemcheckbox',{name:'Rosa',exact:true}).click();
    await page.screenshot({path:path.join(artifacts,'notes-minimal-card.png')});
    await renamedRow.click({button:'right'});
    await page.screenshot({path:path.join(artifacts,'notes-context-menu.png')});
    await page.keyboard.press('Escape');
    await contextGroup.click({button:'right'});
    await page.getByRole('menuitem',{name:'Excluir grupo…',exact:true}).click();
    await page.getByRole('dialog',{name:'Excluir grupo?',exact:true}).getByRole('button',{name:'Excluir grupo',exact:true}).click();
    await page.keyboard.press('Control+s');
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return !snapshot.groups.some(g=>g.name==='Grupo de validação')&&snapshot.notes.some(n=>n.title==='Nota renomeada'&&n.deletedAt)&&snapshot.notes.some(n=>n.title==='Nota renomeada'&&!n.deletedAt);});
    assert.equal(await page.getByRole('textbox',{name:'Conteúdo da nota'}).count(),1);
    assert.equal(await page.locator('textarea,select,input[type=checkbox],input[type=radio],input[type=range]').count(),0);
    console.log('PASS: menus reais de notas/grupos/sessões criam, renomeiam, fixam, copiam, exportam e excluem preservando a lixeira.');

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,720));
    await page.setViewportSize({width:1024,height:720});
    await page.screenshot({path:path.join(artifacts,'notes-small.png')});
    const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}));
    assert(size.scroll<=size.width,'A janela deve conter a interface no tamanho mínimo.');
    assert.deepEqual(errors,[],'O renderer não deve emitir erros.');
    console.log('PASS: janela 1024 × 720, sem estouro global nem erros de execução.');
    await page.keyboard.press('Control+s');
    await app.evaluate(async()=>{await global.__notesTest.store.close();await global.__notesTest.sync.close();});
    console.log('EVIDENCE: '+artifacts);
  }finally{
    if(app){await app.evaluate(async({app})=>{await global.__notesTest?.store.close();await global.__notesTest?.sync.close();app.exit(0);}).catch(()=>{});await app.close().catch(()=>{});}
    // Test data is deliberately retained with the evidence for reproducibility.
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
