// Real Electron integration for the two appearances, independent editor tabs and
// HTML drag-and-drop. All state lives in a fresh temporary workspace.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {waitPage}=require('./helpers/wait-page.cjs');
const seed=require('../desktop/seed.json');
const root=path.join(__dirname,'..');
const artifacts=process.env.NOTES_QA_DIR || path.join(os.tmpdir(),'notes-qa');

async function main(){
  await fs.mkdir(artifacts,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-layout-ui-'));
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({args:[root],env,timeout:30000});
    const page=await app.firstWindow(),errors=[];
    const settle=()=>page.evaluate(async()=>{await document.fonts.ready;for(const animation of document.getAnimations()){try{animation.finish();}catch{animation.cancel();}}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.setViewportSize({width:1440,height:900});
    await page.waitForSelector('[data-app-shell]');
    const fixture={...seed,appearance:'standard',noteDisplay:'single',sidebar:true,layout:'focus',
      groups:[{id:'ga',name:'Grupo Alfa',color:'#7D7AFF',sessions:[{id:'sa',name:'Sessão Alfa'},{id:'sb',name:'Sessão Beta'}]},{id:'gb',name:'Grupo Beta',color:'#30D158',sessions:[{id:'sc',name:'Sessão Gama'}]}],
      notes:[{id:'na',s:'sa',title:'Alfa',body:'Corpo alfa sem repetição.'},{id:'nb',s:'sa',title:'Beta',body:'Corpo beta independente.'},{id:'nc',s:'sa',title:'Gama',body:'Corpo gama independente.'},{id:'nd',s:'sb',title:'Delta',body:'Corpo delta preservado.'}],
      session:'sa',view:'session',tag:null,expanded:{ga:true,gb:true},openBy:{sa:['na','nb','nc'],sb:['nd'],sc:[]},focusBy:{sa:'na',sb:'nd',sc:null},
    };
    await app.evaluate(async(_electron,snapshot)=>{await global.__notesTest.store.save(snapshot);},fixture);
    await page.getByRole('tab',{name:'Alfa',exact:true}).waitFor();
    assert.equal(await page.getByRole('tab').count(),3);
    assert.equal(await page.locator('article[data-pane]').count(),1);
    assert.equal(await page.locator('article[data-pane]').getAttribute('data-pane'),'na');
    await page.getByRole('button',{name:'Lado a lado',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('article[data-pane]').length===3);
    assert.equal(await page.getByRole('textbox',{name:'Conteúdo da nota',exact:true}).count(),3);
    assert.deepEqual(await page.locator('article[data-pane]').evaluateAll(elements=>elements.map(element=>element.dataset.pane)),['na','nb','nc']);
    for(const content of ['Corpo alfa sem repetição.','Corpo beta independente.','Corpo gama independente.'])assert.equal(await page.getByRole('textbox',{name:'Conteúdo da nota',exact:true}).filter({hasText:content}).count(),1);
    await settle();await page.screenshot({path:path.join(artifacts,'notes-layout-split.png')});
    await page.getByRole('button',{name:'Grid',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Grid',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByRole('button',{name:'Uma nota',exact:true}).getAttribute('aria-pressed'),'false');
    assert.equal(await page.getByRole('button',{name:'Lado a lado',exact:true}).getAttribute('aria-pressed'),'false');
    await page.waitForFunction(()=>document.querySelectorAll('[data-masonry-placed]').length===3);
    await page.getByRole('button',{name:'Uma nota',exact:true}).click();
    await page.getByRole('tab',{name:'Beta',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('article[data-pane]').length===1&&document.querySelector('article[data-pane]')?.dataset.pane==='nb');
    console.log('PASS: três abas alternam uma nota ou três editores distintos, sem duplicação dos corpos.');

    const alphaTab=page.getByRole('tab',{name:'Alfa',exact:true}),gammaTab=page.getByRole('tab',{name:'Gama',exact:true});
    const gammaBounds=await gammaTab.boundingBox();
    await alphaTab.dragTo(gammaTab,{targetPosition:{x:gammaBounds.width-2,y:gammaBounds.height/2}});
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return JSON.stringify(snapshot.openBy.sa)===JSON.stringify(['nb','nc','na']);});
    console.log('PASS: arrastar uma aba muda somente a ordem das notas abertas.');

    const noteA=page.locator('[data-note-row][data-note-id="na"]'),noteC=page.locator('[data-note-row][data-note-id="nc"]');
    const aBounds=await noteA.boundingBox();
    await noteC.dragTo(noteA,{targetPosition:{x:aBounds.width/2,y:2}});
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return snapshot.notes.filter(note=>note.s==='sa').map(note=>note.id).join(',')==='nc,na,nb';});
    await page.locator('[data-note-row][data-note-id="nc"]').dragTo(page.locator('[data-session-id="sb"]'));
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return snapshot.notes.find(note=>note.id==='nc')?.s==='sb'&&!snapshot.openBy.sa.includes('nc');});
    await page.locator('[data-session-id="sb"]').dragTo(page.locator('[data-group-id="gb"]'));
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return snapshot.groups.find(group=>group.id==='gb')?.sessions.some(session=>session.id==='sb');});
    const groupA=page.locator('[data-group-id="ga"]'),groupBounds=await groupA.boundingBox();
    await page.locator('[data-group-id="gb"]').dragTo(groupA,{targetPosition:{x:groupBounds.width/2,y:2}});
    await waitPage(page,async()=>{const {snapshot}=await window.notes.bootstrap();return snapshot.groups[0].id==='gb';});
    const saved=await page.evaluate(async()=>(await window.notes.bootstrap()).snapshot);
    assert.equal(saved.notes.length,4);assert.equal(saved.notes.find(note=>note.id==='nc').body,'Corpo gama independente.');
    console.log('PASS: drag-and-drop real reordena notas, move para sessão, move sessão de grupo e reordena grupos.');

    await page.keyboard.press('Control+,');
    await page.getByRole('radio',{name:'Ilha',exact:true}).click();
    await page.getByRole('dialog',{name:'Configurações',exact:true}).getByRole('button',{name:'Concluir',exact:true}).click();
    await page.waitForSelector('[data-app-shell][data-appearance="islands"]');
    const island=await page.evaluate(()=>{
      const bounds=selector=>{const element=document.querySelector(selector),rect=element.getBoundingClientRect(),style=getComputedStyle(element);return {left:rect.left,right:rect.right,top:rect.top,radius:parseFloat(style.borderTopLeftRadius),background:style.backgroundColor};};
      return {sidebar:bounds('[data-side-panel]'),list:bounds('[data-note-list]'),editor:bounds('[data-note-main]')};
    });
    assert.ok(island.sidebar.left>=8);assert.ok(island.list.left-island.sidebar.right>=8);assert.ok(island.editor.left-island.list.right>=8);
    for(const panel of Object.values(island))assert.ok(panel.radius>=12,'Ilha precisa separar os painéis com bordas arredondadas.');
    await settle();await page.screenshot({path:path.join(artifacts,'notes-layout-islands.png')});
    await page.getByRole('button',{name:'Alternar barra lateral',exact:true}).click();
    await page.waitForSelector('[data-app-shell][data-sidebar-open="false"]');
    assert.equal(await page.locator('[data-side-panel]').isVisible(),false);
    assert.ok(await page.locator('[data-note-list]').evaluate(element=>element.getBoundingClientRect().left<=20),'Ilha recolhida não deve reservar uma coluna ou um gap extra.');
    await page.getByRole('button',{name:'Alternar barra lateral',exact:true}).click();
    await page.waitForSelector('[data-app-shell][data-sidebar-open="true"]');
    await page.keyboard.press('Control+,');
    await page.getByRole('radio',{name:'Padrão',exact:true}).click();
    await page.getByRole('dialog',{name:'Configurações',exact:true}).getByRole('button',{name:'Concluir',exact:true}).click();
    await page.waitForSelector('[data-app-shell][data-appearance="standard"]');
    assert.equal(await page.locator('article[data-pane]').evaluate(element=>parseFloat(getComputedStyle(element).borderRadius)),0);
    assert.equal(await page.locator('select,input[type=radio],input[type=checkbox],input[type=range],textarea').count(),0);
    await settle();await page.screenshot({path:path.join(artifacts,'notes-layout-standard.png')});
    console.log('PASS: aparências Padrão e Ilha trocam geometria real sem widgets nativos.');

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,720));
    await page.setViewportSize({width:1024,height:720});
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(size.scroll<=size.width);assert.deepEqual(errors,[]);
    await page.keyboard.press('Control+s');
    console.log('PASS: 1024×720 sem estouro global ou erros do renderer.');
    console.log('EVIDENCE: '+artifacts);
  }finally{
    if(app){await app.evaluate(async({app})=>{await global.__notesTest?.store.close();await global.__notesTest?.sync.close();app.exit(0);}).catch(()=>{});await app.close().catch(()=>{});}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
