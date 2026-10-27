// Actual Electron, actual Git, temporary profiles and a private-service fixture.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {waitPage}=require('./helpers/wait-page.cjs');
const {WorkspaceStore}=require('../desktop/storage.cjs');
const {AssetStore}=require('../desktop/assets.cjs');
const {GitHubSync}=require('../desktop/github-sync.cjs');
const {createTestTools}=require('../desktop/github-test.cjs');
const seed=require('../desktop/seed.json');
const root=path.resolve(__dirname,'..'),artifacts=path.join(os.tmpdir(),'notes-qa');

async function main(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-github-ui-'));await fs.mkdir(artifacts,{recursive:true});
  const remote=path.join(dataDir,'remote.git');execFileSync('git',['init','--bare','--initial-branch=main',remote],{windowsHide:true});
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir,NOTES_TEST_SHOW_ONBOARDING:'1'};delete env.ELECTRON_RUN_AS_NODE;
  let app,b,btools,bsync;
  try{
    app=await electron.launch({args:[root],env,timeout:30000});const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('dialog',{name:'GitHub',exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'Conectar GitHub',exact:true}).isEnabled());
    assert.equal(await app.evaluate(()=>global.__notesTest.tools.fixtureState.commands.filter(args=>args.includes('login')||args.includes('create')).length),0);
    await page.getByRole('button',{name:'Concluir',exact:true}).click();
    await app.evaluate(async()=>{
      const current=global.__notesTest.store.snapshot;
      await global.__notesTest.store.save({...current,groups:[{id:'cg',name:'Cores',color:'#7D7AFF',sessions:[{id:'cs',name:'Paleta'}]}],notes:[{id:'color-note',s:'cs',title:'Nota colorida',body:'## Título\n\nLinha base.'},{id:'reference-note',s:'cs',title:'Referência',body:'Veja [[Nota colorida]].'}],session:'cs',view:'session',tag:null,openBy:{cs:['color-note','reference-note']},focusBy:{cs:'color-note'},expanded:{cg:true},appearance:'islands',noteDisplay:'grid',layout:'split',panelSizes:{}});
    });
    await page.locator('article[data-pane="color-note"]').waitFor();
    const card=page.locator('article[data-pane="color-note"]');
    const colorButton=card.getByRole('button',{name:'Cor e tema da nota',exact:true});
    await page.mouse.move(10,50);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-pane="color-note"] .note-theme-trigger')).opacity==='0');
    await card.hover({position:{x:12,y:12}});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-pane="color-note"] .note-theme-trigger')).opacity==='1');
    const triggerBounds=await colorButton.boundingBox(),cardBounds=await card.boundingBox();
    assert(triggerBounds.x>cardBounds.x+cardBounds.width-45&&triggerBounds.y<cardBounds.y+20,'bolinha no canto superior direito');
    await colorButton.click();
    const popover=page.getByRole('dialog',{name:'Cor e tema da nota',exact:true});await popover.waitFor();
    assert.equal(await popover.getAttribute('aria-modal'),null);assert.equal(await page.locator('.dialog-backdrop').count(),0);
    const popupBounds=await popover.boundingBox();assert(Math.abs(popupBounds.y-(triggerBounds.y+triggerBounds.height+8))<=2,'popover ancorado na bolinha');
    const picker=page.getByRole('radiogroup',{name:'20 temas da nota',exact:true}),radios=picker.getByRole('radio');
    assert.equal(await radios.count(),20);assert.equal(await page.locator('input[type=color],select').count(),0);
    const backgrounds=new Set();
    for(let index=0;index<20;index++){
      await radios.nth(index).click();
      const material=await card.evaluate(element=>{const style=getComputedStyle(element),body=element.querySelector('.visual-document');return {background:style.backgroundColor,ink:style.getPropertyValue('--ink').trim(),body:getComputedStyle(body).color,border:style.borderColor};});
      backgrounds.add(material.background);assert(material.ink&&material.body&&material.border);
      assert.equal(await radios.nth(index).getAttribute('aria-checked'),'true');
    }
    assert.equal(backgrounds.size,20,'todos os temas precisam alterar o cartão real');
    await picker.getByRole('radio',{name:'Menta',exact:true}).click();
    await page.screenshot({path:path.join(artifacts,'notes-note-palette.png')});
    const dotColor=await colorButton.locator('span').evaluate(element=>getComputedStyle(element).backgroundColor);
    assert.equal(dotColor,await card.evaluate(element=>getComputedStyle(element).backgroundColor));
    await page.keyboard.press('Escape');await popover.waitFor({state:'hidden'});assert(await colorButton.evaluate(element=>element===document.activeElement));
    await colorButton.press('Enter');await popover.waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Menta');
    await page.keyboard.press('ArrowRight');assert.equal(await card.getAttribute('data-note-theme'),'pistachio');
    await popover.getByRole('button',{name:'Usar tema do aplicativo',exact:true}).click();assert.equal(await card.getAttribute('data-note-theme'),null);
    await picker.getByRole('radio',{name:'Menta',exact:true}).click();
    await page.locator('.app-brand').click();await popover.waitFor({state:'hidden'});
    await page.keyboard.press('Control+s');
    await waitPage(page,async()=>(await window.notes.bootstrap()).snapshot.notes.find(note=>note.id==='color-note').noteTheme==='mint');
    const bottom=await card.evaluate(element=>element.getBoundingClientRect().bottom-element.querySelector('[data-note-backlinks]').getBoundingClientRect().bottom);
    assert(Math.abs(bottom)<=1,'não pode haver faixa vazia abaixo do rodapé');
    await page.screenshot({path:path.join(artifacts,'notes-note-colors.png')});
    await page.reload();await card.waitFor();assert.equal(await card.getAttribute('data-note-theme'),'mint');
    const chosenBackground=await card.evaluate(element=>getComputedStyle(element).backgroundColor);
    for(const appearance of ['standard','islands']){
      await app.evaluate(async(_electron,appearance)=>{await global.__notesTest.store.save({...global.__notesTest.store.snapshot,appearance});},appearance);
      for(const display of ['Uma nota','Lado a lado','Grid']){
        await page.getByRole('button',{name:display,exact:true}).click();assert.equal(await card.evaluate(element=>getComputedStyle(element).backgroundColor),chosenBackground);
        await card.hover({position:{x:12,y:12}});await colorButton.click();await popover.waitFor();
        const geometry=await popover.boundingBox();assert(geometry.x>=9&&geometry.y>=9&&geometry.x+geometry.width<=1440-9&&geometry.y+geometry.height<=900-9);
        await page.keyboard.press('Escape');await popover.waitFor({state:'hidden'});
      }
    }
    await page.setViewportSize({width:1024,height:720});
    const referenceCard=page.locator('[data-pane="reference-note"]');await referenceCard.hover();
    await referenceCard.getByRole('button',{name:'Cor e tema da nota',exact:true}).click();await popover.waitFor();
    const compact=await popover.boundingBox(),compactViewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert(compact.x>=9&&compact.y>=9&&compact.x+compact.width<=compactViewport.width-9&&compact.y+compact.height<=compactViewport.height-9,JSON.stringify({compact,compactViewport}));
    await page.keyboard.press('Escape');await popover.waitFor({state:'hidden'});
    await card.hover({position:{x:12,y:12}});await colorButton.click();assert.equal(await page.locator('.note-theme-popover').count(),1);
    await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:900});
    await page.locator('[data-note-row][data-note-id="color-note"]').click({button:'right'});
    await page.getByRole('menuitem',{name:'Cor e tema da nota…',exact:true}).click();await popover.waitFor();
    await popover.getByRole('button',{name:'Fechar paleta',exact:true}).click();await popover.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('dialog',{name:'GitHub',exact:true}).count(),0,'onboarding dispensado não reabre a cada reload');
    console.log('PASS: bolinha aparece no hover; popover ancorado e sem modal, teclado/reset/clique fora funcionam nas seis combinações e em 1024×720. Os 20 temas persistem sem cor livre ou faixa abaixo do footer.');

    await app.evaluate(async(_electron,directory)=>global.__notesTest.useGitHubRemote(directory,{loggedIn:true}),remote);
    await page.getByRole('button',{name:'GitHub e sincronização',exact:true}).click();
    await waitPage(page,async()=>(await window.notes.bootstrap()).sync.state==='ready');
    await page.getByRole('dialog',{name:'GitHub',exact:true}).getByRole('button',{name:'Concluir',exact:true}).click();
    const bdir=path.join(dataDir,'second-pc');b=new WorkspaceStore({dataDir:bdir,seed,deviceId:'github-ui-second'});await b.init();
    const bassets=await new AssetStore({dataDir:bdir}).init();
    const priorTest=process.env.NOTES_TEST,priorData=process.env.NOTES_TEST_DATA_DIR;process.env.NOTES_TEST='1';process.env.NOTES_TEST_DATA_DIR=bdir;
    btools=createTestTools({toolsDir:path.join(bdir,'tools'),loggedIn:true}).tools;
    bsync=new GitHubSync({store:b,assets:bassets,tools:btools,repoDir:path.join(bdir,'notes-repository'),testRemote:remote});
    if(priorTest===undefined)delete process.env.NOTES_TEST;else process.env.NOTES_TEST=priorTest;
    if(priorData===undefined)delete process.env.NOTES_TEST_DATA_DIR;else process.env.NOTES_TEST_DATA_DIR=priorData;
    assert.equal((await bsync.connect()).state,'ready');
    assert.equal(b.snapshot.notes.find(note=>note.id==='color-note').noteTheme,'mint');
    const remoteSnapshot=b.snapshot;remoteSnapshot.notes=remoteSnapshot.notes.map(note=>note.id==='color-note'?{...note,body:'## Título\n\nTexto do GitHub.'}:note);await b.save(remoteSnapshot);
    assert.equal((await bsync.sync()).state,'ready');
    await app.evaluate(async()=>{const current=global.__notesTest.store.snapshot;await global.__notesTest.store.save({...current,notes:current.notes.map(note=>note.id==='color-note'?{...note,body:'## Título\n\nTexto deste computador.'}:note)});});
    await page.getByRole('button',{name:'Sincronizar GitHub agora',exact:true}).click();
    const diff=page.getByRole('dialog',{name:'Comparar versões',exact:true});await diff.waitFor();
    assert((await diff.getByRole('region',{name:'Versão local'}).innerText()).includes('Texto deste computador.'));
    assert((await diff.getByRole('region',{name:'Versão do GitHub'}).innerText()).includes('Texto do GitHub.'));
    assert(!(await diff.innerText()).includes('## Título'));
    await diff.evaluate(async element=>{for(const animation of element.parentElement.getAnimations({subtree:true}))try{animation.finish();}catch{animation.cancel();}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    await page.screenshot({path:path.join(artifacts,'notes-github-diff.png')});
    await diff.getByRole('button',{name:'Manter GitHub',exact:true}).click();
    await diff.getByRole('button',{name:'Aplicar e sincronizar',exact:true}).click();
    await waitPage(page,async()=>{const result=await window.notes.bootstrap();return result.sync.state==='ready'&&result.snapshot.notes.find(note=>note.id==='color-note').body.includes('Texto do GitHub.');});
    assert.equal((await page.evaluate(()=>window.notes.bootstrap())).snapshot.notes.find(note=>note.id==='color-note').noteTheme,'mint');
    assert.equal((await bsync.sync()).state,'ready');assert(b.snapshot.notes.find(note=>note.id==='color-note').body.includes('Texto do GitHub.'));
    assert.deepEqual(errors,[]);
    console.log('PASS: tema sincroniza entre PCs; conflito abre diff visual Local/GitHub, decisão é versionada e propagada sem Markdown visível.');
  }finally{
    if(bsync)await bsync.close();if(btools)await btools.close();if(b)await b.close();
    if(app){await app.evaluate(async({app})=>{await global.__notesTest.sync.close();await global.__notesTest.tools.close();await global.__notesTest.store.close();app.exit(0);}).catch(()=>{});await app.close().catch(()=>{});}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
