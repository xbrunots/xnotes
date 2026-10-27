// Focused Electron check for the reusable custom menu; no workspace or Drive data.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const esbuild=require('esbuild');
const {_electron}=require('playwright');

(async()=>{
  const root=path.join(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'notes-context-menu-'));
  const entry=path.join(root,'src/context-menu.jsx').replaceAll('\\','/'),css=path.join(root,'src/context-menu.css').replaceAll('\\','/');
  const source=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ContextMenu}from'${entry}';import'${css}';
    function Fixture(){const[m,setM]=useState(null),[result,setResult]=useState('');const action=text=>()=>setResult(text);
      const items=[{id:'disabled',label:'Indisponível',disabled:true},{id:'open',label:'Abrir nota',action:action('Abrir')},{id:'rename',label:'Renomear nota',action:action('Renomear')},{id:'move',label:'Mover para',children:[{id:'group',label:'Grupo Pessoal',children:[{id:'daily',label:'Sessão diária',action:action('Diário')},{id:'study',label:'Estudos',action:action('Estudos')}]},{id:'long',label:'Lista extensa',children:Array.from({length:35},(_,i)=>({id:'n'+i,label:'Destino '+(i+1),action:action('Destino '+(i+1))}))}]},{separator:true},{id:'delete',label:'Excluir nota',danger:true,action:action('Excluir')}];
      return <><input id="outside" aria-label="Outro campo"/><button id="open" onContextMenu={e=>{e.preventDefault();setM({x:e.clientX,y:e.clientY});}}>Abrir menu</button><button id="edge" style={{position:'fixed',right:1,bottom:1}} onContextMenu={e=>{e.preventDefault();setM({x:e.clientX,y:e.clientY});}}>Canto</button><output id="result">{result}</output>{m&&<ContextMenu items={items} x={m.x} y={m.y} label="Nota de teste" style={{'--ink':'#f4f4f8','--ink-2':'#bfbfc9','--ink-3':'#8d8d98','--glass-strong':'#202026','--line':'#35353d','--line-strong':'#474750','--hover-2':'#34343c','--acc-ink':'#80b1ff','--pane-shadow':'0 8px 24px #0004'}} onClose={()=>setM(null)}/>}</>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
  await esbuild.build({stdin:{contents:source,resolveDir:root,sourcefile:'context-fixture.jsx',loader:'jsx'},bundle:true,outfile:path.join(temp,'fixture.js'),platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await fs.writeFile(path.join(temp,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{background:#101014;color:white;font-family:Arial}#outside{margin:20px}button{margin:5px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  await fs.writeFile(path.join(temp,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({width:900,height:650,useContentSize:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(temp,'index.html'))});});`);
  let app;
  try {
    app=await _electron.launch({args:[path.join(temp,'main.cjs')],cwd:root});
    const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#outside').waitFor();await page.locator('#outside').focus();
    await page.locator('#edge').click({button:'right'});await page.getByRole('menu',{name:'Nota de teste',exact:true}).waitFor();
    await page.waitForTimeout(170);
    const bounds=await page.getByRole('menu',{name:'Nota de teste',exact:true}).boundingBox(),viewport=page.viewportSize() || await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    assert.ok(bounds.x>=7&&bounds.y>=7);assert.ok(bounds.x+bounds.width<=viewport.width-7);assert.ok(bounds.y+bounds.height<=viewport.height-7);
    assert.equal(await page.locator(':focus').textContent(),'Abrir nota');
    await page.keyboard.press('End');assert.equal(await page.locator(':focus').textContent(),'Excluir nota');
    await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');assert.equal(await page.locator(':focus').textContent(),'Renomear nota');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowRight');await page.getByRole('menu',{name:'Mover para',exact:true}).waitFor();await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('menu').count(),3);assert.equal(await page.locator(':focus').textContent(),'Sessão diária');
    for(const menu of await page.getByRole('menu').all()){const box=await menu.boundingBox();assert.ok(box.x>=7&&box.x+box.width<=viewport.width-7);}
    await page.keyboard.press('Enter');await page.getByRole('menu').waitFor({state:'detached'});assert.equal(await page.locator('#result').textContent(),'Diário');
    await page.locator('#open').click({button:'right'});await page.keyboard.press('End');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('menu').count(),3);
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),2);await page.keyboard.press('ArrowLeft');assert.equal(await page.getByRole('menu').count(),1);await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'detached'});
    await page.locator('#open').click({button:'right'});await page.keyboard.press('r');assert.equal(await page.locator(':focus').textContent(),'Renomear nota');await page.keyboard.press('Enter');assert.equal(await page.locator('#result').textContent(),'Renomear');
    await page.locator('#open').click({button:'right'});await page.getByRole('menuitem',{name:'Mover para',exact:true}).hover();await page.getByRole('menuitem',{name:'Lista extensa',exact:true}).hover();await page.getByRole('menu',{name:'Lista extensa',exact:true}).waitFor();
    await page.getByRole('menuitem',{name:'Destino 1',exact:true}).focus();await page.keyboard.press('End');assert.equal(await page.locator(':focus').textContent(),'Destino 35');
    const visible=await page.locator(':focus').evaluate(element=>{const a=element.getBoundingClientRect(),b=element.parentElement.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;});assert.equal(visible,true);
    await page.keyboard.press('Enter');assert.equal(await page.locator('#result').textContent(),'Destino 35');
    await page.locator('#open').click({button:'right'});await page.locator('#outside').click();assert.equal(await page.getByRole('menu').count(),0);assert.equal(await page.locator(':focus').getAttribute('id'),'outside');
    await page.locator('#open').click({button:'right'});await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));await page.getByRole('menu').waitFor({state:'detached'});
    assert.equal(await page.locator('select,input[type=checkbox],input[type=radio],input[type=range]').count(),0);assert.deepEqual(errors,[]);
    console.log('Menus customizados: 3 níveis, teclado, ações, scroll, foco e limites da janela validados no Electron.');
  } finally {if(app)await app.evaluate(({app})=>app.exit(0));}
})().catch(error=>{console.error(error);process.exitCode=1;});
