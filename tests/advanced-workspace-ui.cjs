// Real Electron regression for resizable panels and live masonry editors.
// Every workspace, attachment and write belongs to an isolated temporary profile.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {PNG}=require('pngjs');
const seed=require('../desktop/seed.json');
const root=path.join(__dirname,'..'),artifacts=process.env.NOTES_QA_DIR || path.join(os.tmpdir(),'notes-qa');
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

async function main(){
  await fs.mkdir(artifacts,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-advanced-ui-'));
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;
  const snapshot=async()=>(await page.evaluate(()=>window.notes.bootstrap())).snapshot;
  const settle=async()=>{await page.evaluate(async()=>{await document.fonts.ready;for(const animation of document.getAnimations()){try{animation.finish();}catch{animation.cancel();}}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});};
  const dimensions=locator=>locator.evaluate(element=>{const rect=element.getBoundingClientRect();return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};});
  const panelValue=(sizes,kind,key)=>key?sizes?.[kind]?.[key]:sizes?.[kind];
  const waitSnapshot=async predicate=>{const deadline=Date.now()+10000;let current;do{current=await snapshot();if(predicate(current))return current;await pause(40);}while(Date.now()<deadline);throw Error('O workspace não atingiu o estado esperado: '+JSON.stringify({panelSizes:current?.panelSizes,noteDisplay:current?.noteDisplay}));};
  const waitSaved=async(kind,key,expected)=>waitSnapshot(current=>{const value=panelValue(current.panelSizes,kind,key);return typeof value==='number'&&Math.abs(value-expected)<1;});
  const point=async locator=>{
    await locator.scrollIntoViewIfNeeded();const rect=await locator.boundingBox(),viewport=page.viewportSize();assert.ok(rect,'o separador precisa estar visível');
    return {x:Math.max(2,Math.min(viewport.width-2,rect.x+rect.width/2)),y:Math.max(45,Math.min(viewport.height-8,rect.y+rect.height/2))};
  };
  async function resize(label,kind,key,delta,axis='x'){
    await page.keyboard.press('Control+s');
    const before=(await snapshot()).panelSizes || {},handle=page.getByRole('separator',{name:label,exact:true}),origin=await point(handle);
    const initial=Number(await handle.getAttribute('aria-valuenow'));
    await page.mouse.move(origin.x,origin.y);await page.mouse.down();
    await page.mouse.move(origin.x+(axis==='x'?delta:0),origin.y+(axis==='y'?delta:0),{steps:6});
    await settle();await pause(240);
    const preview=Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(Math.abs(preview-initial)>=Math.min(5,Math.abs(delta)),label+' precisa atualizar durante o arraste');
    const savedDuringDrag=(await snapshot()).panelSizes || {};
    assert.deepEqual(savedDuringDrag,before,'o arraste não pode salvar a cada pointermove');
    await page.mouse.up();await waitSaved(kind,key,preview);
    assert.equal(await page.locator('html[data-panel-resizing]').count(),0,'o cursor global precisa ser restaurado');
    return {before:panelValue(before,kind,key),value:preview};
  }
  async function gridState(){
    return page.evaluate(()=>{
      const workspace=document.querySelector('[data-editor-workspace]'),outer=workspace.getBoundingClientRect();
      return {clientWidth:workspace.clientWidth,scrollWidth:workspace.scrollWidth,clientHeight:workspace.clientHeight,scrollHeight:workspace.scrollHeight,scrollTop:workspace.scrollTop,left:outer.left,top:outer.top,
        cards:[...workspace.querySelectorAll(':scope>article[data-pane]')].map(card=>{const rect=card.getBoundingClientRect(),body=card.querySelector('.note-editor-scroll'),bodyStyle=getComputedStyle(body);return {id:card.dataset.pane,x:rect.left-outer.left+workspace.scrollLeft,y:rect.top-outer.top+workspace.scrollTop,width:rect.width,height:rect.height,bodyClient:body.clientHeight,bodyScroll:body.scrollHeight,bodyOverflow:bodyStyle.overflowY,placed:card.hasAttribute('data-masonry-placed')};})};
    });
  }
  function noCross(grid){
    assert.equal(grid.cards.length,8);assert.ok(grid.cards.every(card=>card.placed));
    assert.ok(grid.scrollWidth<=grid.clientWidth+1,'o mosaico não pode criar rolagem horizontal');
    for(let first=0;first<grid.cards.length;first++)for(let second=first+1;second<grid.cards.length;second++){
      const a=grid.cards[first],b=grid.cards[second],intersects=a.x<b.x+b.width-1&&a.x+a.width>b.x+1&&a.y<b.y+b.height-1&&a.y+a.height>b.y+1;
      assert.equal(intersects,false,`os cartões ${a.id}/${b.id} não podem se sobrepor`);
    }
  }
  async function packed(){
    await page.waitForFunction(()=>[...document.querySelectorAll('article[data-pane]')].every(card=>card.hasAttribute('data-masonry-placed')));await settle();
    const deadline=Date.now()+5000;let previous='',last,error;
    do{
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      last=await gridState();const signature=JSON.stringify(last);
      try{noCross(last);if(signature===previous)return last;}catch(failure){error=failure;}
      previous=signature;
    }while(Date.now()<deadline);
    if(error){console.log('MASONRY DEBUG: '+JSON.stringify(last));throw error;}throw Error('O mosaico não estabilizou após o recálculo.');
  }

  try{
    app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setViewportSize({width:1440,height:900});await page.waitForSelector('[data-app-shell]');
    const paragraph='Um parágrafo com conteúdo suficiente para medir a altura natural do editor e preservar todas as linhas da nota.';
    const notes=[
      {id:'n-short',title:'Curta',body:'Uma ideia curta. #ideias'},
      {id:'n-medium',title:'Média',body:Array(5).fill(paragraph).join('\n\n')+'\n\n[[Curta]]'},
      {id:'n-long',title:'Longa',body:Array(32).fill(paragraph).join('\n\n')},
      {id:'n-image',title:'Imagem',body:'A imagem será adicionada durante o teste.'},
      {id:'n-list',title:'Lista',body:'- [ ] Primeira tarefa\n- [x] Segunda tarefa\n- [ ] Terceira tarefa'},
      {id:'n-links',title:'Links',body:'Uma referência para [[Curta]] e [a documentação](https://example.com). #trabalho'},
      {id:'n-minimal',title:'Mínima',body:'Uma linha.'},
      {id:'n-essay',title:'Ensaio',body:Array(12).fill(paragraph).join('\n\n')},
    ].map(note=>({...note,s:'sa',t:'Agora'}));
    const fixture={...seed,appearance:'islands',noteDisplay:'split',layout:'split',sidebar:true,panelSizes:{sidebar:244,list:300,sections:{groups:240}},
      groups:[{id:'ga',name:'Grupo Alfa',color:'#7D7AFF',sessions:[{id:'sa',name:'Sessão Alfa'},{id:'sb',name:'Sessão Beta'}]},{id:'gb',name:'Grupo Beta',color:'#30D158',sessions:[{id:'sc',name:'Sessão Gama'}]}],
      notes,session:'sa',view:'session',tag:null,expanded:{ga:true,gb:true},openBy:{sa:notes.map(note=>note.id),sb:[],sc:[]},focusBy:{sa:'n-short',sb:null,sc:null},
    };
    await app.evaluate(async(_electron,initial)=>{await global.__notesTest.store.save(initial);},fixture);
    await page.getByRole('tab',{name:'Curta',exact:true}).waitFor();await settle();
    assert.equal(await page.getByRole('tab').count(),8);assert.equal(await page.getByRole('textbox',{name:'Conteúdo da nota',exact:true}).count(),8);
    const island=await page.evaluate(()=>{
      const sidebar=document.querySelector('[data-side-panel]').getBoundingClientRect(),list=document.querySelector('[data-note-list]').getBoundingClientRect(),main=document.querySelector('[data-note-main]'),mainRect=main.getBoundingClientRect(),tabs=main.querySelector('.workspace-tabs'),tabRect=tabs.getBoundingClientRect();
      return {sideTop:sidebar.top,listTop:list.top,mainTop:mainRect.top,mainLeft:mainRect.left,mainRight:mainRect.right,radius:parseFloat(getComputedStyle(main).borderTopLeftRadius),tabTop:tabRect.top,tabLeft:tabRect.left,tabRight:tabRect.right,tabsInside:main.contains(tabs)};
    });
    assert.ok(island.tabsInside&&island.radius>=12);assert.ok(Math.abs(island.sideTop-island.mainTop)<=1&&Math.abs(island.listTop-island.mainTop)<=1,'as três ilhas começam na mesma altura');
    assert.ok(island.tabTop>=island.mainTop&&island.tabLeft>=island.mainLeft&&island.tabRight<=island.mainRight+1,'as abas pertencem ao painel arredondado do editor');
    assert.equal(await page.locator('[data-side-panel]').getByRole('button',{name:/^(Claro|Escuro)$/}).count(),0);
    console.log('PASS: Ilha contém abas no mesmo painel e altura da sidebar/lista, sem toggle de tema fora das configurações.');

    await resize('Redimensionar barra lateral','sidebar',null,52);
    await resize('Redimensionar lista de notas','list',null,40);
    await resize('Redimensionar grupos e tags','sections','groups',35,'y');
    await resize('Redimensionar nota Curta','notes','n-short',70);
    const persisted=(await snapshot()).panelSizes;
    await page.reload();await page.getByRole('tab',{name:'Curta',exact:true}).waitFor();await settle();
    assert.deepEqual((await snapshot()).panelSizes,persisted);
    assert.ok(Math.abs((await dimensions(page.locator('[data-side-panel]'))).width-persisted.sidebar)<1);
    assert.ok(Math.abs((await dimensions(page.locator('[data-note-list]'))).width-persisted.list)<1);
    console.log('PASS: sidebar, lista, seções e notas split mudam ao arrastar, salvam no mouseup e sobrevivem ao reload.');

    const cancelBefore=(await snapshot()).panelSizes,sideHandle=page.getByRole('separator',{name:'Redimensionar barra lateral',exact:true}),origin=await point(sideHandle),sideBefore=(await dimensions(page.locator('[data-side-panel]'))).width;
    await page.mouse.move(origin.x,origin.y);await page.mouse.down();await page.mouse.move(origin.x-35,origin.y,{steps:5});await settle();
    await page.keyboard.press('Escape');await page.mouse.up();await settle();await pause(220);
    assert.deepEqual((await snapshot()).panelSizes,cancelBefore);assert.ok(Math.abs((await dimensions(page.locator('[data-side-panel]'))).width-sideBefore)<1);assert.equal(await page.locator('html[data-panel-resizing]').count(),0);
    await sideHandle.dblclick();await waitSaved('sidebar',null,244);
    const listHandle=page.getByRole('separator',{name:'Redimensionar lista de notas',exact:true}),listBefore=(await snapshot()).panelSizes.list;
    await listHandle.focus();await page.keyboard.down('Shift');await page.keyboard.down('ArrowRight');await settle();
    assert.equal((await snapshot()).panelSizes.list,listBefore,'a tecla ainda pressionada é somente um preview');
    await page.keyboard.up('ArrowRight');await page.keyboard.up('Shift');await waitSaved('list',null,listBefore+10);
    console.log('PASS: Escape cancela sem alterar preferências; duplo clique restaura e Shift+seta só salva ao soltar a tecla.');

    await page.evaluate(()=>{window.__advancedEditors=new Map([...document.querySelectorAll('[data-editor]')].map(editor=>[editor.dataset.editor,editor]));});
    await page.getByRole('button',{name:'Grid',exact:true}).click();
    await page.waitForSelector('[data-editor-workspace][data-note-display="grid"]');
    let grid=await packed();assert.ok(grid.scrollHeight>grid.clientHeight,'notas longas usam rolagem vertical do mosaico');
    assert.ok(Math.max(...grid.cards.map(card=>card.height))-Math.min(...grid.cards.map(card=>card.height))>400,'as alturas vêm do conteúdo e não de uma linha fixa');
    assert.ok(grid.cards.every(card=>card.bodyOverflow==='visible'&&card.bodyScroll<=card.bodyClient+1),'os corpos completos não podem ter rolagem/truncamento interno');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-editor]')].every(editor=>window.__advancedEditors.get(editor.dataset.editor)===editor)),true,'mudar split para grid preserva as instâncias dos editores');
    const smallWidth=grid.cards.find(card=>card.id==='n-short').width;
    await resize('Redimensionar nota Curta','notes','n-short',Math.round(smallWidth*.7));
    grid=await packed();assert.ok(grid.cards.find(card=>card.id==='n-short').width>smallWidth*1.5,'uma nota mais larga ocupa várias colunas');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-editor]')].every(editor=>window.__advancedEditors.get(editor.dataset.editor)===editor)),true);
    console.log('PASS: Grid usa masonry real, alturas naturais, scroll vertical e largura por nota sem recriar editores.');

    const shortCard=page.locator('article[data-pane="n-short"]'),shortBefore=(await dimensions(shortCard)).height;
    const editor=shortCard.getByRole('textbox',{name:'Conteúdo da nota',exact:true});
    await editor.fill('Edição visual preservada.\n\n'+Array(16).fill(paragraph).join('\n\n'));
    await page.waitForFunction(height=>document.querySelector('article[data-pane="n-short"]').getBoundingClientRect().height>height+200,shortBefore);
    await packed();await page.keyboard.press('Control+s');
    await waitSnapshot(current=>current.notes.find(note=>note.id==='n-short').body.includes('Edição visual preservada.'));

    const imageFile=path.join(dataDir,'test-image.png'),png=new PNG({width:320,height:640});
    for(let index=0;index<png.data.length;index+=4){png.data[index]=70;png.data[index+1]=115;png.data[index+2]=180;png.data[index+3]=255;}
    await fs.writeFile(imageFile,PNG.sync.write(png));
    const imageBefore=(await dimensions(page.locator('article[data-pane="n-image"]'))).height;
    await app.evaluate(async(_electron,filename)=>{
      const file=await global.__notesTest.assets.addFile(filename),current=global.__notesTest.store.snapshot;
      const next={...current,notes:current.notes.map(note=>{if(note.id!=='n-image')return note;const result={...note,body:'Imagem local carregada.\n\n![Teste de imagem](notes-asset:'+file.hash+')',attachments:[file]};delete result.richText;return result;})};
      await global.__notesTest.store.save(next,{base:current});
    },imageFile);
    const image=page.locator('article[data-pane="n-image"] img[data-source]');await image.waitFor({state:'attached'});await page.locator('article[data-pane="n-image"]').scrollIntoViewIfNeeded();await image.waitFor();
    await image.evaluate(element=>element.complete&&element.naturalHeight>0?Promise.resolve():new Promise((resolve,reject)=>{element.addEventListener('load',resolve,{once:true});element.addEventListener('error',()=>reject(Error('imagem local não carregou')),{once:true});}));
    await page.waitForFunction(height=>document.querySelector('article[data-pane="n-image"]').getBoundingClientRect().height>height+200,imageBefore);
    grid=await packed();assert.ok(grid.cards.find(card=>card.id==='n-long').height>1000);
    await page.screenshot({path:path.join(artifacts,'notes-advanced-grid.png')});
    console.log('PASS: editar texto e substituir corpo com imagem local recalcula o mosaico sem sobreposição ou truncagem.');

    await page.keyboard.press('Control+s');const sizesBeforeSmall=(await snapshot()).panelSizes;
    await page.reload();await page.waitForSelector('[data-editor-workspace][data-note-display="grid"]');await packed();
    assert.equal((await snapshot()).noteDisplay,'grid');assert.deepEqual((await snapshot()).panelSizes,sizesBeforeSmall);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,720));await page.setViewportSize({width:1024,height:720});
    await settle();grid=await packed();assert.ok(grid.scrollWidth<=grid.clientWidth+1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok((await dimensions(page.locator('[data-note-main]'))).width>=320);
    assert.deepEqual((await snapshot()).panelSizes,sizesBeforeSmall,'encolher a janela não destrói os tamanhos preferidos');
    await page.keyboard.press('Control+,');await page.getByRole('radio',{name:'Padrão',exact:true}).click();await page.getByRole('dialog',{name:'Configurações',exact:true}).getByRole('button',{name:'Concluir',exact:true}).click();
    await page.waitForSelector('[data-app-shell][data-appearance="standard"]');await packed();
    const footer=await page.locator('article[data-pane="n-short"] [data-note-backlinks]').evaluate(element=>{const style=getComputedStyle(element);return {background:style.backgroundColor,border:parseFloat(style.borderTopWidth)};});
    assert.equal(footer.background,'rgba(0, 0, 0, 0)');assert.equal(footer.border,0);
    assert.equal(await page.locator('select,input[type=radio],input[type=checkbox],input[type=range],textarea').count(),0);
    assert.deepEqual(errors,[],'o renderer não pode gerar erros');
    await page.screenshot({path:path.join(artifacts,'notes-advanced-small.png')});
    console.log('PASS: Grid e tamanhos persistem; 1024×720 adapta sem scroll global; rodapé Padrão transparente sem borda.');
    console.log('EVIDENCE: '+artifacts);
  }finally{
    if(app){await app.evaluate(async({app})=>{await global.__notesTest?.store.close();await global.__notesTest?.sync.close();app.exit(0);}).catch(()=>{});await app.close().catch(()=>{});}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
