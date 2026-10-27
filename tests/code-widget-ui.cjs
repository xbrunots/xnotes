// Browser plugin not available. Exercise the actual Electron editor offline,
// using a temporary profile and real mouse/clipboard/keyboard input.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {waitPage}=require('./helpers/wait-page.cjs');
const root=path.resolve(__dirname,'..'),evidence=path.join(os.tmpdir(),'notes-qa');

async function main(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-code-ui-'));await fs.mkdir(evidence,{recursive:true});
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const errors=[],workers=[];
  try{
    app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('worker',worker=>workers.push(worker.url()));
    await page.setViewportSize({width:1600,height:950});await page.waitForSelector('article[data-pane]');assert.equal(await page.title(),'notes');
    await app.evaluate(async()=>{
      const store=global.__notesTest.store;
      await store.save({...store.snapshot,groups:[{id:'cg',name:'Código',color:'#7D7AFF',sessions:[{id:'cs',name:'Monaco'}]}],notes:[
        {id:'ca',s:'cs',title:'Código colado',body:'',noteTheme:'mint'},
        {id:'cb',s:'cs',title:'Python',body:'```py\ndef dobro(valor):\n    return valor * 2\n```',noteTheme:'plum'},
        {id:'cc',s:'cs',title:'Seleção',body:'Antes código Depois'},
      ],session:'cs',view:'session',tag:null,openBy:{cs:['ca','cb','cc']},focusBy:{cs:'ca'},expanded:{cg:true},appearance:'islands',noteDisplay:'split',layout:'split',themePreset:'carbon',theme:'dark',motion:false,panelSizes:{}});
    });
    const card=page.locator('[data-pane="ca"]'),editor=card.locator('[data-editor="ca"]'),widget=card.locator('[data-code-widget]');
    const source='const answer = 42;\nconsole.log(answer);\n';
    await page.evaluate(text=>window.notes.copyText(text),source);await editor.focus();await page.keyboard.press('Control+v');
    await widget.locator('[data-code-editor]').waitFor();await widget.locator('.monaco-editor').waitFor({timeout:30000});
    await page.waitForFunction(()=>document.querySelector('[data-pane="ca"] [data-code-widget]')?.dataset.codeReady==='true');
    assert.equal(await widget.getAttribute('data-language'),'javascript');
    await page.waitForFunction(()=>document.querySelector('[data-pane="cb"] [data-code-widget]')?.dataset.codeReady==='true');
    assert.equal(await page.locator('[data-pane="cb"] [data-code-widget]').getAttribute('data-language'),'python');
    assert.equal(await widget.locator('[data-code-editor]').evaluate(element=>element.__notesCodeEditor.getValue()),source);
    assert.equal(await widget.locator('[data-code-editor]').evaluate(element=>element.__notesCodeEditor.getSupportedActions().some(action=>action.id==='editor.action.toggleHighContrast')),false);
    await widget.locator('.view-lines').click({position:{x:70,y:10}});await page.keyboard.press('Control+End');await page.keyboard.insertText('// digitado no Monaco');
    await page.waitForFunction(()=>document.querySelector('[data-editor="ca"]').__notesEditor.state.doc.textContent.includes('// digitado no Monaco'));
    await page.keyboard.press('Control+z');await page.waitForFunction(()=>!document.querySelector('[data-editor="ca"]').__notesEditor.state.doc.textContent.includes('// digitado no Monaco'));
    await page.keyboard.press('Control+y');await page.waitForFunction(()=>document.querySelector('[data-editor="ca"]').__notesEditor.state.doc.textContent.includes('// digitado no Monaco'));
    await page.keyboard.press('Control+s');
    await waitPage(page,async()=>(await window.notes.bootstrap()).snapshot.notes.find(note=>note.id==='ca').body.includes('// digitado no Monaco'));

    await widget.click({button:'right',position:{x:50,y:60}});
    const menu=page.getByRole('dialog',{name:'Opções do bloco de código',exact:true});await menu.waitFor();
    assert((await menu.getByRole('option').count())>=80);assert.equal(await page.getByRole('menu',{name:'Opções da nota'}).count(),0);
    assert(!/tema|cor do código/i.test(await menu.innerText()));
    await menu.getByRole('combobox',{name:'Buscar linguagem de programação',exact:true}).fill('Python');
    await menu.getByRole('option',{name:'Python',exact:true}).click();assert.equal(await widget.getAttribute('data-language'),'python');
    await widget.click({button:'right',position:{x:50,y:60}});await menu.getByRole('button',{name:'Copiar código',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.notes.readClipboard()),source+'// digitado no Monaco');await page.keyboard.press('Escape');
    const colors=await page.locator('[data-code-widget]').evaluateAll(elements=>elements.map(element=>({ink:getComputedStyle(element).getPropertyValue('--ink').trim(),token:getComputedStyle(element.querySelector('.mtk1') || element.querySelector('.view-line span')).color})));
    assert.notEqual(colors[0].token,colors[1].token,'cada Monaco herda a cor da sua própria nota');
    await page.screenshot({path:path.join(evidence,'notes-monaco.png')});

    const selectionEditor=page.locator('[data-editor="cc"]');
    const word=await selectionEditor.locator('p').evaluate(element=>{const text=element.firstChild,start=text.textContent.indexOf('código'),range=document.createRange();range.setStart(text,start);range.setEnd(text,start+6);const rect=range.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};});
    await page.mouse.dblclick(word.x,word.y);
    const selectedText=await page.evaluate(()=>document.getSelection().toString());assert.equal(selectedText.trim(),'código');
    const toolbar=page.getByRole('toolbar',{name:'Formatar texto selecionado',exact:true});await toolbar.waitFor();
    await toolbar.getByRole('button',{name:'Transformar em código (Monaco)',exact:true}).click();
    const converted=page.locator('[data-pane="cc"] [data-code-widget]');await converted.waitFor();
    assert.equal(await selectionEditor.evaluate(element=>element.__notesEditor.state.doc.textContent),'Antes código Depois');
    const json=await selectionEditor.evaluate(element=>element.__notesEditor.getJSON());assert.equal(json.content.find(node=>node.type==='codeBlock').content[0].text,selectedText);
    await converted.getByRole('button',{name:'Linguagem do código: Texto simples',exact:true}).click();await menu.getByRole('button',{name:'Transformar em texto',exact:true}).click();
    assert.equal(await converted.count(),0);assert.equal(await selectionEditor.evaluate(element=>element.__notesEditor.state.doc.textContent),'Antes código Depois');

    await app.evaluate(async()=>{const store=global.__notesTest.store,current=store.snapshot;await store.save({...current,notes:current.notes.map(note=>{if(note.id!=='ca')return note;const next={...note,body:'```python\nprint("recebido de outro PC")\n```'};delete next.richText;return next;})});});
    await page.waitForFunction(()=>document.querySelector('[data-pane="ca"] [data-code-editor]')?.__notesCodeEditor?.getValue().includes('recebido de outro PC'));
    await widget.locator('.view-lines').click({position:{x:70,y:10}});await page.keyboard.press('Control+z');
    assert((await widget.locator('[data-code-editor]').evaluate(element=>element.__notesCodeEditor.getValue())).includes('recebido de outro PC'));
    await page.keyboard.press('Control+s');
    await page.reload();await page.waitForFunction(()=>document.querySelector('[data-pane="ca"] [data-code-widget]')?.dataset.codeReady==='true');
    assert.equal(await widget.getAttribute('data-language'),'python');assert((await widget.locator('[data-code-editor]').evaluate(element=>element.__notesCodeEditor.getValue())).includes('recebido de outro PC'));
    assert.equal(await page.locator('select,input[type=color]').count(),0);assert.deepEqual(errors,[]);
    console.log('PASS: Monaco real offline; código colado/importado, edição, Undo/Redo, 80+ linguagens, menu custom, temas independentes, seleção parcial, conteúdo remoto e reinício preservados.');
    console.log('WORKERS:',JSON.stringify(workers));
  }catch(error){if(page){await page.screenshot({path:path.join(evidence,'notes-code-failure.png')}).catch(()=>{});await fs.writeFile(path.join(evidence,'notes-code-failure.json'),JSON.stringify({errors,text:await page.locator('body').innerText().catch(()=>''),widgets:await page.locator('[data-code-widget]').evaluateAll(elements=>elements.map(element=>element.outerHTML.slice(0,1500))).catch(()=>[])},null,2));}throw error;}
  finally{if(app){await app.evaluate(async({app})=>{await global.__notesTest.sync.close();await global.__notesTest.tools.close();await global.__notesTest.store.close();app.exit(0);}).catch(()=>{});await app.close().catch(()=>{});}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
