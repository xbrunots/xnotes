'use strict';
// Real Electron -> preload -> IPC -> typed actions -> journal -> visual editor.
// Inference is a synthetic in-memory fixture; no CLI/auth/model is contacted.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {waitPage}=require('./helpers/wait-page.cjs');
const root=path.resolve(__dirname,'..');
const artifacts=path.join(os.tmpdir(),'notes-qa');

async function main(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-ai-ui-'));
  const env={...process.env,NOTES_TEST:'1',NOTES_TEST_DATA_DIR:dataDir};delete env.ELECTRON_RUN_AS_NODE;
  const checks=[],errors=[],requests=[];let app,page;
  const passed=label=>{checks.push(label);console.log('PASS: '+label);};
  try{
    await fs.mkdir(artifacts,{recursive:true});
    app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/i.test(request.url()))requests.push(request.url());});
    await page.waitForSelector('article[data-pane]');
    const titleSearch=page.getByRole('button',{name:'Buscar ou pedir à IA',exact:true});
    for(const width of [1440,960]){
      await page.setViewportSize({width,height:900});
      const bounds=await titleSearch.boundingBox();assert.ok(Math.abs(bounds.x+bounds.width/2-width/2)<1,'Searchbox fica exatamente no centro');
      const tools=await page.locator('.titlebar-actions').boundingBox();assert.ok(bounds.x+bounds.width<tools.x,'Searchbox não sobrepõe controles');
    }
    await page.setViewportSize({width:1440,height:900});passed('Busca central em 1440 e 960 px, sem sobrepor controles Windows ou ações');
    const blocked=await page.evaluate(async()=>{try{await window.notes.runAi({prompt:'Pedido sintético'});return false;}catch(error){return /bloqueia CLIs reais/.test(error.message);}});
    assert.equal(blocked,true);passed('QA bloqueia execução real de CLI mesmo por IPC');

    await app.evaluate(async()=>{
      const runtime=global.__notesTest.createAiRuntime();await runtime.init();
      const fixture={calls:[],discoveryCalls:[],mode:'create',cancelled:false,failDiscovery:false};global.__aiFixture=fixture;
      const providers=[{id:'codex',label:'Codex CLI',available:true,version:'fixture',command:'C:\\AI Fixture\\codex.exe',agents:[],efforts:['default','low','medium','high'],models:[{value:'fixture-balanced',label:'Codex Example Balanced',supportedEfforts:['low','medium'],isDefault:true},{value:'fixture-deep',label:'Codex Example Deep',supportedEfforts:['high','xhigh']}]},{id:'claude',label:'Claude Code',available:true,version:'fixture',command:'C:\\AI Fixture\\claude.exe',agents:[{value:'writer',label:'writer'}],efforts:['default','low','medium','high'],models:[{value:'fixture-model',label:'Claude Example Writer',supportedEfforts:['low','medium','high'],isDefault:true},{value:'fixture-fast',label:'Claude Example Fast',supportedEfforts:['low']}]},{id:'acp',label:'Agente ACP',available:false,agents:[],efforts:['default'],models:[]}];
      runtime.discover=async draft=>{
        fixture.discoveryCalls.push(structuredClone(draft));if(fixture.failDiscovery)throw new Error('Falha sintética ao atualizar o catálogo.');
        const result=structuredClone(providers);
        if(fixture.holdDiscovery){fixture.discoveryWaiting=true;await new Promise(resolve=>{fixture.releaseDiscovery=resolve;});fixture.discoveryWaiting=false;result.find(p=>p.id===draft.provider).models=[{value:'old-model',label:'Catálogo antigo'}];}
        if(fixture.manyModels)result.find(p=>p.id===draft.provider).models.push(...Array.from({length:24},(_,index)=>({value:'fixture-extra-'+index,label:'Extra Model '+index,supportedEfforts:['low']})));
        runtime.providers=result;return {providers:result};
      };
      runtime.run=async payload=>{
        fixture.calls.push({prompt:payload.prompt,context:JSON.parse(payload.context)});fixture.cancelled=false;
        if(fixture.mode==='hold')await new Promise((resolve,reject)=>{fixture.release=resolve;payload.signal.addEventListener('abort',()=>{fixture.cancelled=true;reject(new Error('Cancelado sintético'));},{once:true});});
        if(payload.signal.aborted)throw new Error('Cancelado sintético');
        const context=JSON.parse(payload.context);let actions,message;
        if(fixture.mode==='create'){
          actions=[{type:'create_group',ref:'new:g',name:'Projeto Aurora'},{type:'create_session',ref:'new:s',groupId:'new:g',name:'Planejamento'},{type:'create_note',sessionId:'new:s',title:'Plano de lançamento',body:'# Próximos passos\n\n- [ ] Validar a ideia\n- [ ] Escrever a documentação'}];message='Criei o projeto Aurora, a sessão Planejamento e o plano de lançamento.';
        }else if(fixture.mode==='edit'||fixture.mode==='hold'){
          actions=[{type:'update_note',id:context.currentNoteId,body:'# Plano revisado\n\nConteúdo atualizado pela IA.'}];message='Atualizei o plano.';
        }else if(fixture.mode==='trash'){
          actions=[{type:'trash_note',id:context.currentNoteId}];message='Enviei a nota para a lixeira.';
        }else{actions=[{type:'exec',body:'não executar'}];message='Inválido';}
        return {text:JSON.stringify({message,readNotes:[],actions}),provider:runtime.settings().provider};
      };
      runtime.cancel=async()=>({cancelled:true});runtime.close=async()=>{};
      await global.__notesTest.setAiRuntime(runtime);
    });

    await titleSearch.click();const palette=page.getByRole('dialog',{name:'Buscar ou pedir à IA',exact:true});await palette.waitFor();
    const search=palette.getByRole('combobox',{name:'Buscar notas, grupos, sessões ou comandos',exact:true});await search.fill('Atlas');assert.ok(await palette.getByRole('option').count()>0);await search.press('ArrowDown');await search.press('ArrowUp');
    await palette.getByRole('button',{name:'Configurar IA',exact:true}).click();
    const settings=page.getByRole('dialog',{name:'Configurações',exact:true});await settings.waitFor();assert.ok(await settings.locator('#settings-ai').isVisible());assert.equal(await settings.getByRole('radiogroup',{name:'Tema da interface'}).count(),0);passed('Configuração dentro da busca abre diretamente a seção IA');
    const model=settings.getByRole('combobox',{name:'Modelo de IA',exact:true});await model.waitFor();
    await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));
    assert.equal(await settings.getByRole('button',{name:'Configuração avançada',exact:true}).getAttribute('aria-expanded'),'false');
    assert.ok((await app.evaluate(()=>global.__aiFixture.discoveryCalls)).length>0);assert.equal((await page.evaluate(()=>window.notes.aiStatus())).settings.model,'');
    await model.click();const modelSearch=settings.getByRole('combobox',{name:'Buscar modelos de IA',exact:true});await modelSearch.pressSequentially('Example Deep');await settings.getByRole('option',{name:'Codex Example Deep',exact:true}).waitFor();await modelSearch.press('Enter');assert.ok((await model.innerText()).includes('Codex Example Deep'));
    await settings.getByRole('combobox',{name:'Esforço da IA'}).click();assert.equal(await settings.getByRole('option',{name:'Médio',exact:true}).count(),0);await settings.getByRole('option',{name:'Alto',exact:true}).click();
    await model.click();await modelSearch.fill('Balanced');await modelSearch.press('Enter');assert.ok((await settings.getByRole('combobox',{name:'Esforço da IA'}).innerText()).includes('Padrão'));passed('Modelos são listados ao abrir, pesquisam nomes com espaços e filtram esforços compatíveis');
    const provider=settings.getByRole('combobox',{name:'Provedor de IA'});await provider.click();await settings.getByRole('option',{name:'Claude Code',exact:false}).click();
    await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));
    await model.click();await modelSearch.fill('Writer');await modelSearch.press('Enter');assert.ok((await model.innerText()).includes('Claude Example Writer'));
    await settings.getByRole('combobox',{name:'Agente de IA'}).fill('writer');await settings.getByRole('combobox',{name:'Agente de IA'}).press('Escape');
    await settings.getByRole('combobox',{name:'Esforço da IA'}).click();await settings.getByRole('option',{name:'Alto',exact:true}).click();
    await settings.getByRole('button',{name:'Salvar IA',exact:true}).click();await settings.getByRole('status').filter({hasText:'Configurações de IA salvas'}).waitFor();
    const prefs=await page.evaluate(()=>window.notes.aiStatus());assert.equal(prefs.settings.provider,'claude');assert.equal(prefs.settings.agent,'writer');assert.equal(prefs.settings.effort,'high');assert.equal(prefs.settings.model,'fixture-model');
    assert.equal(await page.locator('select,input[type=checkbox],input[type=range]').count(),0);passed('Provedor, agente, modelo e esforço salvos com controles próprios');
    await settings.getByRole('button',{name:'Configuração avançada',exact:true}).click();const command=settings.getByRole('textbox',{name:'Executável do CLI',exact:true});await command.fill('C:\\AI Fixture\\alternate.exe');await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();
    await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));assert.equal(await app.evaluate(()=>global.__aiFixture.discoveryCalls.at(-1).command),'C:\\AI Fixture\\alternate.exe');assert.equal((await page.evaluate(()=>window.notes.aiStatus())).settings.command,'');await command.fill('');await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));
    await app.evaluate(()=>{global.__aiFixture.failDiscovery=true;});await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await settings.getByRole('status').filter({hasText:'Falha sintética ao atualizar o catálogo.'}).waitFor();assert.ok((await model.innerText()).includes('Claude Example Writer'));await app.evaluate(()=>{global.__aiFixture.failDiscovery=false;});await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));passed('Atualizar usa o executável ainda não salvo e preserva o catálogo se a consulta falhar');
    await app.evaluate(()=>{global.__aiFixture.holdDiscovery=true;});await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();
    while(!await app.evaluate(()=>global.__aiFixture.discoveryWaiting))await new Promise(resolve=>setTimeout(resolve,20));
    await command.fill('C:\\AI Fixture\\latest.exe');await app.evaluate(()=>{global.__aiFixture.holdDiscovery=false;global.__aiFixture.releaseDiscovery();});await new Promise(resolve=>setTimeout(resolve,80));
    await model.click();assert.equal(await settings.getByRole('option',{name:'Catálogo antigo',exact:true}).count(),0);await modelSearch.press('Escape');
    await command.fill('');await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));passed('Resposta atrasada de outro executável não substitui o catálogo atual');
    await app.evaluate(()=>{global.__aiFixture.manyModels=true;});await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('26 modelos'));
    await page.setViewportSize({width:960,height:640});await model.click();
    await waitPage(page,()=>{const popup=document.querySelector('.ai-combobox-popup.is-searchable')?.getBoundingClientRect(),dialog=document.querySelector('.dialog')?.getBoundingClientRect();return popup&&dialog&&popup.top>=dialog.top&&popup.bottom<=dialog.bottom;});
    await settings.getByRole('option',{name:'Extra Model 23',exact:true}).click();assert.ok((await model.innerText()).includes('Extra Model 23'));
    await page.setViewportSize({width:1440,height:900});await model.click();await modelSearch.fill('Writer');await modelSearch.press('Enter');await app.evaluate(()=>{global.__aiFixture.manyModels=false;});await settings.getByRole('button',{name:'Atualizar modelos',exact:true}).click();await waitPage(page,()=>document.querySelector('#settings-ai')?.innerText.includes('2 modelos'));passed('Lista longa mantém busca e último modelo acessíveis em 960×640');
    await settings.getByRole('button',{name:'Concluir',exact:true}).click();

    await titleSearch.click();await palette.getByRole('tab',{name:'Pedir à IA',exact:true}).click();
    const input=palette.getByRole('textbox',{name:'Pedido para a IA',exact:true});await input.fill('Crie um projeto Aurora com sessão e plano.');await input.press('Enter');
    await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'Criei o projeto Aurora'}).waitFor();
    const created=await waitPage(page,async()=>{const state=(await window.notes.bootstrap()).snapshot;const note=state.notes.find(n=>n.title==='Plano de lançamento');return note?{note,group:state.groups.find(g=>g.name==='Projeto Aurora'),state}:null;});
    assert.equal(created.group.sessions[0].name,'Planejamento');assert.equal(created.note.s,created.group.sessions[0].id);assert.equal(created.state.aiStatus,undefined);
    await palette.screenshot({path:path.join(artifacts,'notes-ai-search.png')});
    await palette.getByRole('button',{name:'Fechar busca',exact:true}).click();await page.getByRole('heading',{name:'Próximos passos',exact:true}).waitFor();await page.keyboard.press('Control+s');
    const beforeEdit=await page.evaluate(async id=>(await window.notes.bootstrap()).snapshot.notes.find(n=>n.id===id),created.note.id);passed('Pedido cria grupo, sessão e nota formatada pelo editor visual e journal reais');

    await app.evaluate(()=>{global.__aiFixture.mode='edit';});await titleSearch.click();await input.fill('Reescreva a nota aberta.');await input.press('Enter');await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'Atualizei o plano'}).waitFor();
    await palette.getByRole('button',{name:'Desfazer alterações',exact:true}).click();await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'desfeitas'}).waitFor();
    assert.equal((await page.evaluate(async id=>(await window.notes.bootstrap()).snapshot.notes.find(n=>n.id===id),created.note.id)).body,beforeEdit.body);passed('Edição e desfazer restauram o conteúdo anterior da nota');

    await app.evaluate(()=>{global.__aiFixture.mode='hold';});await input.fill('Atualize o plano enquanto eu continuo editando.');await input.press('Enter');await palette.getByRole('status').filter({hasText:'A IA está trabalhando'}).waitFor();await palette.getByRole('button',{name:'Fechar busca',exact:true}).click();
    const editor=page.locator('[data-editor="'+created.note.id+'"]');await editor.fill('Minha edição durante a resposta.');
    await page.keyboard.press('Control+s');await waitPage(page,async id=>(await window.notes.bootstrap()).snapshot.notes.find(n=>n.id===id)?.body.includes('Minha edição durante a resposta.'),created.note.id);
    await app.evaluate(()=>global.__aiFixture.release());await titleSearch.click();await palette.getByRole('alert').filter({hasText:'editada durante a resposta'}).waitFor();
    assert.ok((await page.evaluate(async id=>(await window.notes.bootstrap()).snapshot.notes.find(n=>n.id===id).body,created.note.id)).includes('Minha edição durante a resposta.'));passed('Editar durante a geração preserva o texto e rejeita a proposta desatualizada');

    await input.fill('Pedido que será cancelado.');await input.press('Enter');await palette.getByRole('status').filter({hasText:'A IA está trabalhando'}).waitFor();await palette.getByRole('button',{name:'Cancelar',exact:true}).click();await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'cancelado'}).waitFor();assert.equal(await app.evaluate(()=>global.__aiFixture.cancelled),true);passed('Cancelar encerra o pedido sem aplicar ações');
    await app.evaluate(()=>{global.__aiFixture.mode='invalid';});await input.fill('Resposta inválida de teste.');await input.press('Enter');await palette.getByRole('alert').filter({hasText:'não reconhecida'}).waitFor();passed('Ação fora do contrato é recusada pela API principal');

    await palette.getByRole('button',{name:'Limpar resposta',exact:true}).click();await palette.getByRole('heading',{name:'Suas ideias, organizadas.',exact:true}).waitFor();assert.equal(await input.inputValue(),'');passed('Limpar resposta reinicia o contexto de conversa');
    await app.evaluate(()=>{global.__aiFixture.mode='create';});await input.fill('Crie outra estrutura para verificar o desfazer.');await input.press('Enter');await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'Criei o projeto Aurora'}).waitFor();
    await palette.getByRole('button',{name:'Fechar busca',exact:true}).click();await page.keyboard.press('Control+s');await titleSearch.click();await palette.getByRole('button',{name:'Limpar resposta',exact:true}).click();await palette.getByRole('heading',{name:'Suas ideias, organizadas.',exact:true}).waitFor();
    await palette.getByRole('button',{name:'Desfazer alterações',exact:true}).click();await palette.getByRole('region',{name:'Resposta da IA'}).filter({hasText:'desfeitas'}).waitFor();passed('Desfazer a criação permanece disponível depois de limpar a resposta');
    await palette.getByRole('button',{name:'Configurar IA',exact:true}).click();await page.locator('.toast').waitFor({state:'hidden'});await settings.screenshot({path:path.join(artifacts,'notes-ai-settings.png')});
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);passed('Renderer sem erros e sem requisições HTTP de modelo');
    const exited=new Promise(resolve=>app.process().once('exit',resolve));await page.evaluate(()=>window.notes.window('close'));await exited;await app.close().catch(()=>{});app=null;
    app=await electron.launch({args:[root],env,timeout:30000});page=await app.firstWindow();await page.waitForSelector('article[data-pane]');
    const restored=await page.evaluate(()=>window.notes.aiStatus());assert.equal(restored.settings.provider,'claude');assert.equal(restored.settings.agent,'writer');assert.equal(restored.settings.effort,'high');passed('Preferências de IA persistem após reiniciar e não iniciam modelo automaticamente');
    console.log(JSON.stringify({checks:checks.length,artifacts,dataDir}));
  }catch(error){if(page){await page.screenshot({path:path.join(artifacts,'notes-ai-failure.png')}).catch(()=>{});await fs.writeFile(path.join(artifacts,'notes-ai-failure.json'),JSON.stringify(await page.evaluate(async()=>({text:document.body.innerText,snapshot:(await window.notes.bootstrap()).snapshot,status:await window.notes.aiStatus()})).catch(()=>({closed:true})),null,2));}throw error;}
  finally{if(app)await app.close().catch(()=>{});await fs.rm(dataDir,{recursive:true,force:true}).catch(()=>{});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
