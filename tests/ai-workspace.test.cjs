'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {WorkspaceStore}=require('../desktop/storage.cjs');
const {AiWorkspace,applyActions,assertFresh,parseResponse,contextFor}=require('../desktop/ai-workspace.cjs');
const seed=()=>({groups:[{id:'g1',name:'Projetos de exemplo',color:'#7D7AFF',sessions:[{id:'s1',name:'Ideias'}]}],notes:[{id:'n1',s:'s1',title:'Planejamento sintético',body:'# Objetivo\nPreservar esta introdução.\n\n```js\n\tconst value = 1;\n\n```',richText:{version:1,source:'antigo',doc:{type:'doc'}},attachments:[{hash:'a'.repeat(64),name:'exemplo.txt',relativePath:'exemplo.txt',mime:'text/plain',size:4}],extra:{keep:true},t:'Ontem'},{id:'n2',s:'s1',title:'Outra nota',body:'Conteúdo independente.',t:'Ontem'}],openBy:{s1:['n1']},focusBy:{s1:'n1'},expanded:{g1:true},session:'s1',view:'session',tag:null});
const response=(actions=[],message='Concluído.',readNotes=[])=>({text:JSON.stringify({message,readNotes,actions})});
async function setup(t,answers){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-ai-workspace-'));const store=new WorkspaceStore({dataDir,seed:seed()});await store.init();t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});const calls=[];const runtime={async run(payload){calls.push(payload);return typeof answers==='function'?answers(payload,calls):answers.shift();},async cancel(){},async close(){}};return {store,calls,runtime,ai:new AiWorkspace({store,runtime})};}

test('typed AI actions create group, session and notes using local references',()=>{
  let number=0;const before=seed(),actions=[{type:'create_group',ref:'new:project',name:'Novo projeto'},{type:'create_session',ref:'new:session',groupId:'new:project',name:'Próximos passos'},{type:'create_note',sessionId:'new:session',title:'Roteiro',body:'## Fazer\n- [ ] Testar',tags:['planejamento'],pinned:true}];
  const result=applyActions(before,actions,{makeId:prefix=>prefix+'-'+(++number)});
  assert.equal(result.snapshot.groups[1].sessions[0].name,'Próximos passos');assert.equal(result.snapshot.notes[0].s,'s-2');assert.equal(result.snapshot.notes[0].pinned,true);assert.equal(before.groups.length,1);assert.equal(result.changes.length,3);
});
test('AI body replacement removes stale richText and preserves attachments and metadata',()=>{
  const result=applyActions(seed(),[{type:'update_note',id:'n1',body:'## Revisado\n\n```js\n\tconst value = 2;\n\n```'}]);const note=result.snapshot.notes.find(n=>n.id==='n1');assert.equal(note.richText,undefined);assert.deepEqual(note.attachments,seed().notes[0].attachments);assert.deepEqual(note.extra,{keep:true});assert.match(note.body,/\tconst value = 2;\n\n/);
});
test('group removal preserves every note and attachment in a valid trash session',()=>{
  const result=applyActions(seed(),[{type:'trash_group',id:'g1'}]);const ids=new Set(result.snapshot.groups.flatMap(g=>g.sessions.map(s=>s.id)));assert.equal(result.snapshot.notes.length,2);assert.ok(result.snapshot.notes.every(n=>n.deletedAt&&ids.has(n.s)));assert.deepEqual(result.snapshot.notes.find(n=>n.id==='n1').attachments,seed().notes[0].attachments);
});
test('unknown operation, invalid fields and mixed reads never enter a transaction',()=>{
  for(const actions of [[{type:'exec',body:'anything'}],[{type:'update_note',id:'n1',attachments:[]}],[{type:'update_group',id:'g1',color:'url(test)'}],[{type:'create_note',sessionId:'s1',pinned:'yes'}]])assert.throws(()=>parseResponse(response(actions).text));
  assert.throws(()=>parseResponse(response([{type:'trash_note',id:'n1'}],'x',['n1']).text));assert.throws(()=>parseResponse('not-json'));
});
test('nullable strict-schema fields are ignored and duplicate references are rejected',()=>{
  assert.deepEqual(parseResponse(response([{type:'update_note',id:'n1',title:'Novo',body:null,groupId:null}]).text).actions,[{type:'update_note',id:'n1',title:'Novo'}]);
  assert.throws(()=>applyActions(seed(),[{type:'create_group',name:'A',ref:'new:g'},{type:'create_group',name:'B',ref:'new:g'}]),/duplicada/);
});
test('freshness rejects a changed target but permits unrelated note edits',()=>{
  const base=seed(),current=seed();current.notes[1].body='Mudança independente';assert.doesNotThrow(()=>assertFresh(base,current,[{type:'update_note',id:'n1',title:'Novo'}]));current.notes[0].body='Minha edição';assert.throws(()=>assertFresh(base,current,[{type:'update_note',id:'n1',body:'Velho'}]),/editada/);
});
test('removing a session never trashes a new note created during model generation',()=>{
  const current=seed();current.notes.push({id:'n3',s:'s1',title:'Recente',body:'Nova'});assert.throws(()=>assertFresh(seed(),current,[{type:'trash_session',id:'s1'}]),/mudaram/);
});
test('model context carries hierarchy and selected content without attachment bytes',()=>{
  const context=contextFor(seed(),{prompt:'Criar algo',focusedNoteId:'n1'});assert.equal(context.contents.length,1);assert.equal(context.notes[0].bodyIncluded,true);assert.equal(JSON.stringify(context).includes('a'.repeat(64)),false);assert.equal(context.groups[0].sessions[0].id,'s1');
});
test('AI creation is applied through the durable store and can be undone',async t=>{
  const {store,ai}=await setup(t,[response([{type:'create_note',sessionId:'s1',title:'Criada pela IA',body:'Exemplo'}])]);const answer=await ai.run({prompt:'Crie uma nota de exemplo',sessionId:'s1'});assert.equal(store.snapshot.notes.length,2);const applied=await ai.apply(answer.planId);assert.equal(applied.canUndo,true);assert.equal(store.snapshot.notes.length,3);await ai.undo();assert.deepEqual(store.snapshot.notes,seed().notes);
});
test('AI reads missing content in a second bounded request before editing',async t=>{
  const {ai,calls,store}=await setup(t,[response([],'Lendo',['n2']),response([{type:'update_note',id:'n2',body:'Resumo do conteúdo independente.'}])]);const answer=await ai.run({prompt:'Resuma o documento indicado pelo ID n2',sessionId:'s1'});assert.equal(calls.length,2);assert.ok(JSON.parse(calls[1].context).contents.some(n=>n.id==='n2'));await ai.apply(answer.planId);assert.equal(store.snapshot.notes[1].body,'Resumo do conteúdo independente.');
});
test('editing a body without reading it is rejected without touching disk state',async t=>{
  const {ai,store}=await setup(t,[response([{type:'update_note',id:'n2',body:'Inventado'}])]);await assert.rejects(ai.run({prompt:'Faça algo',sessionId:'s1'}),/sem ler/);assert.deepEqual(store.snapshot,seed());
});
test('edits made while the model answers survive and stale proposal is discarded',async t=>{
  const {ai,store}=await setup(t,[response([{type:'update_note',id:'n1',body:'Texto da IA'}])]);const answer=await ai.run({prompt:'Reescreva a nota aberta',focusedNoteId:'n1'});const before=store.snapshot,next=structuredClone(before);next.notes[0].body='Texto digitado enquanto esperava';await store.save(next,{base:before});await assert.rejects(ai.apply(answer.planId),/editada/);assert.equal(store.snapshot.notes[0].body,next.notes[0].body);
});
test('undo preserves unrelated edits and refuses to overwrite the AI note if edited',async t=>{
  const {ai,store}=await setup(t,[response([{type:'update_note',id:'n1',title:'Título da IA'}])]);const answer=await ai.run({prompt:'Renomeie a nota aberta',focusedNoteId:'n1'});await ai.apply(answer.planId);let before=store.snapshot,next=structuredClone(before);next.notes[1].body='Edição independente';await store.save(next,{base:before});await ai.undo();assert.equal(store.snapshot.notes[0].title,seed().notes[0].title);assert.equal(store.snapshot.notes[1].body,'Edição independente');
  const second=await setup(t,[response([{type:'update_note',id:'n1',title:'Título da IA'}])]);const answer2=await second.ai.run({prompt:'Renomeie',focusedNoteId:'n1'});await second.ai.apply(answer2.planId);before=second.store.snapshot;next=structuredClone(before);next.notes[0].body='Edição posterior';await second.store.save(next,{base:before});await assert.rejects(second.ai.undo(),/mudou/);assert.equal(second.store.snapshot.notes[0].body,'Edição posterior');
});
test('an invalid action in a batch prevents every write',async t=>{
  const {ai,store}=await setup(t,[response([{type:'create_group',name:'Não salvar'},{type:'create_note',sessionId:'missing',title:'Inválida',body:''}])]);await assert.rejects(ai.run({prompt:'Organize a biblioteca'}),/sessão/);assert.deepEqual(store.snapshot,seed());
});
test('cancellation invalidates prepared proposals without writing notes',async t=>{
  const {ai,store}=await setup(t,[response([{type:'trash_note',id:'n1'}])]);const result=await ai.run({prompt:'Envie a nota para a lixeira'});await ai.cancel();await assert.rejects(ai.apply(result.planId),/não está mais/);assert.deepEqual(store.snapshot,seed());
});
test('serialized commit guard rejects stale writes before changing journal records',async t=>{
  const {store}=await setup(t,[]),before=store.snapshot,next=structuredClone(before),records=store.exportRevisions().length;next.notes[0].body='Não deve entrar';await assert.rejects(store.save(next,{base:before,assertCurrent:()=>{throw new Error('stale');}}),/stale/);assert.deepEqual(store.snapshot,before);assert.equal(store.exportRevisions().length,records);
});
test('undo excludes unrelated edits that entered the storage queue ahead of AI apply',async t=>{
  const {ai,store}=await setup(t,[response([{type:'update_note',id:'n1',title:'Nome da IA'}])]);
  const answer=await ai.run({prompt:'Renomeie a nota aberta',focusedNoteId:'n1'});
  const before=store.snapshot,edited=structuredClone(before);edited.notes[1].body='Edição legítima enfileirada';
  const writing=store.save(edited,{base:before});const applying=ai.apply(answer.planId);await Promise.all([writing,applying]);
  await ai.undo();assert.equal(store.snapshot.notes.find(n=>n.id==='n1').title,before.notes[0].title);assert.equal(store.snapshot.notes.find(n=>n.id==='n2').body,'Edição legítima enfileirada');
});
test('numeric legacy IDs preserve tabs, focus, context and deletion freshness',()=>{
  const before={groups:[{id:1,name:'Legado',sessions:[{id:10,name:'Sessão'}]}],notes:[{id:100,s:10,title:'Nota',body:'Conteúdo'}],session:10,openBy:{10:[100]},focusBy:{10:100}};
  const updated=applyActions(before,[{type:'update_note',id:'100',title:'Atualizada'}]);assert.deepEqual(updated.snapshot.openBy,{'10':[100]});assert.deepEqual(updated.snapshot.focusBy,{'10':100});assert.equal(contextFor(before,{prompt:'Editar',focusedNoteId:'100'}).notes[0].bodyIncluded,true);
  const current=structuredClone(before);current.notes.push({id:101,s:10,title:'Nova',body:'Preservar'});assert.throws(()=>assertFresh(before,current,[{type:'trash_group',id:'1'}]),/mudaram/);assert.throws(()=>assertFresh(before,current,[{type:'trash_session',id:'10'}]),/mudaram/);
});
test('undoing an edit to a middle note preserves note order',async t=>{
  const {ai,store}=await setup(t,[response([{type:'update_note',id:'n2',title:'Título temporário'}])]);
  const before=store.snapshot;const result=await ai.run({prompt:'Renomeie a outra nota'});await ai.apply(result.planId);await ai.undo();assert.deepEqual(store.snapshot.notes.map(n=>n.id),before.notes.map(n=>n.id));
});
test('follow-up prompts receive only bounded in-memory conversation and can clear it',async t=>{
  const {ai,calls}=await setup(t,[response([],'Qual título você prefere?'),response([],'Entendido.')]);await ai.run({prompt:'Ajude com o título'});await ai.run({prompt:'Algo sobre ideias'});assert.deepEqual(JSON.parse(calls[1].context).conversation,[{user:'Ajude com o título',assistant:'Qual título você prefere?'}]);ai.clearHistory();assert.deepEqual(ai.history,[]);
});
