const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const esbuild=require('esbuild');
const {validateSnapshot}=require('../desktop/storage.cjs');

const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/context-actions.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const moduleObject={exports:{}};
const exported=[];
vm.runInNewContext(built.outputFiles[0].text,{module:moduleObject,exports:moduleObject.exports,require,structuredClone,crypto:webcrypto,window:{notes:{exportNote:async id=>{exported.push(id);return 'nota.md';}}}},{timeout:10000});
const {applyContextAction,buildContextItems,invokeContextAction}=moduleObject.exports;
const fixture=()=>({
  groups:[{id:'g1',name:'Pessoal',color:'#FF9F0A',sessions:[{id:'s1',name:'Diário',custom:'sessão preservada'},{id:'s2',name:'Estudos'}]},{id:'g2',name:'Trabalho',color:'#7D7AFF',sessions:[{id:'s3',name:'Projeto'}]}],
  notes:[
    {id:'n1',s:'s1',title:'Zebra',body:'**Nota** com [link](https://example.com)',t:'Agora',tags:['pessoal'],attachments:[{hash:'a'.repeat(64),name:'imagem.png',relativePath:'imagem.png',size:20,mime:'image/png'}],imported:{source:'obsidian'},editorDoc:{type:'doc',content:[{type:'paragraph'}]}},
    {id:'n2',s:'s1',title:'Árvore',body:'Texto',t:'Ontem',pinned:true},
    {id:'n3',s:'s2',title:'Livro',body:'Notas',t:'Ontem'},
    {id:'n4',s:'s3',title:'Plano',body:'Projeto',t:'Ontem'},
    {id:'n5',s:'s1',title:'Antiga',body:'Lixeira',deletedAt:'2026-01-01T00:00:00.000Z'}
  ],
  session:'s1',openBy:{s1:['n1','n2'],s2:['n3'],s3:['n4','n1']},focusBy:{s1:'n1',s2:'n3',s3:'n1'},expanded:{g1:true,g2:false},view:'session',tag:null,editing:'n1',layout:'split',sidebar:true
});
function changed(initial,action,payload={}) {
  let count=0;const before=structuredClone(initial);
  const patch=structuredClone(applyContextAction(initial,action,payload,{makeId:prefix=>`${prefix}-new-${++count}`,now:()=> '2026-10-27T12:00:00.000Z'}));
  assert.deepEqual(initial,before,'a ação não pode alterar o estado recebido');
  const result={...initial,...patch};
  validateSnapshot(result);
  return result;
}
function noOrphans(state) {
  const sessionIds=new Set(state.groups.flatMap(group=>group.sessions.map(session=>session.id)));
  assert.ok(sessionIds.has(state.session));
  state.notes.forEach(note=>assert.ok(sessionIds.has(note.s),`sessão inexistente na nota ${note.id}`));
  Object.values(state.openBy).flat().forEach(id=>assert.ok(state.notes.some(note=>note.id===id&&!note.deletedAt)));
  for(const [session,id] of Object.entries(state.focusBy))if(id)assert.ok(state.openBy[session]?.includes(id));
}

test('duplicar nota preserva anexos, tags e documento visual com IDs independentes',()=>{
  const initial=fixture(),result=changed(initial,'note-duplicate',{id:'n1'}),duplicate=result.notes[0];
  assert.equal(duplicate.id,'n-new-1');assert.equal(duplicate.title,'Zebra (cópia)');assert.equal(result.session,'s1');assert.equal(result.editing,duplicate.id);
  assert.deepEqual(duplicate.attachments,initial.notes[0].attachments);assert.notEqual(duplicate.attachments,initial.notes[0].attachments);
  assert.deepEqual(duplicate.tags,initial.notes[0].tags);assert.deepEqual(duplicate.imported,initial.notes[0].imported);assert.deepEqual(duplicate.editorDoc,initial.notes[0].editorDoc);
  assert.ok(result.openBy.s1.includes(duplicate.id));noOrphans(result);
});
test('copiar nota para sessão mantém original, título e metadados; mover conserva o ID',()=>{
  const initial=fixture(),copied=changed(initial,'note-copy-to',{id:'n1',sessionId:'s3'});
  assert.equal(copied.notes[0].s,'s3');assert.equal(copied.notes[0].title,'Zebra');assert.equal(copied.notes.find(note=>note.id==='n1').s,'s1');assert.equal(copied.session,'s1');
  const moved=changed(initial,'note-move',{id:'n1',sessionId:'s3'});
  assert.equal(moved.notes.length,initial.notes.length);assert.equal(moved.notes.find(note=>note.id==='n1').s,'s3');
  assert.equal(Object.keys(applyContextAction(initial,'note-copy-to',{id:'n1',sessionId:'inexistente'})).length,0);
});
test('duplicar grupo gera IDs de grupo, sessões e notas e preserva todas as referências de anexos',()=>{
  const initial=fixture(),result=changed(initial,'group-duplicate',{id:'g1'}),duplicate=result.groups[1];
  assert.equal(duplicate.name,'Pessoal (cópia)');assert.notEqual(duplicate.id,'g1');assert.equal(duplicate.sessions.length,2);
  assert.equal(duplicate.sessions[0].custom,'sessão preservada');
  const ids=new Set(duplicate.sessions.map(session=>session.id)),notes=result.notes.filter(note=>ids.has(note.s));
  assert.equal(notes.length,3);assert.ok(notes.every(note=>!initial.notes.some(original=>original.id===note.id)));
  assert.deepEqual(notes.find(note=>note.title==='Zebra').attachments,initial.notes[0].attachments);
  assert.equal(result.notes.filter(note=>note.deletedAt).length,1);noOrphans(result);
});
test('duplicar sessão preserva metadados e notas e mover sessão conserva os IDs',()=>{
  const initial=fixture(),result=changed(initial,'session-duplicate',{id:'s1'}),duplicate=result.groups[0].sessions[1];
  assert.equal(duplicate.name,'Diário (cópia)');assert.equal(duplicate.custom,'sessão preservada');assert.equal(result.notes.filter(note=>note.s===duplicate.id).length,2);
  assert.deepEqual(result.openBy[duplicate.id],[]);assert.equal(result.session,duplicate.id);noOrphans(result);
  const moved=changed(initial,'session-move',{id:'s1',groupId:'g2'});
  assert.deepEqual(moved.groups[1].sessions[1],initial.groups[0].sessions[0]);assert.ok(!moved.groups[0].sessions.some(session=>session.id==='s1'));assert.equal(moved.notes.length,initial.notes.length);noOrphans(moved);
});
test('excluir grupo envia notas à lixeira, mantém anexos e limpa painéis e sessões removidas',()=>{
  const initial=fixture(),result=changed(initial,'group-delete',{id:'g1'});
  assert.deepEqual(result.groups.map(group=>group.id),['g2']);assert.equal(result.session,'s3');assert.equal(result.notes.length,5);
  for(const id of ['n1','n2','n3','n5']){const note=result.notes.find(note=>note.id===id);assert.equal(note.s,'s3');assert.ok(note.deletedAt);}
  assert.equal(result.notes.find(note=>note.id==='n5').deletedAt,'2026-01-01T00:00:00.000Z');
  assert.deepEqual(result.notes.find(note=>note.id==='n1').attachments,initial.notes[0].attachments);
  assert.equal(result.openBy.s1,undefined);assert.equal(result.focusBy.s2,undefined);assert.deepEqual(result.openBy.s3,['n4']);assert.equal(result.focusBy.s3,'n4');noOrphans(result);
});
test('excluir último grupo cria destino válido e preserva todas as notas na lixeira',()=>{
  const initial=fixture();initial.groups=[initial.groups[0]];initial.notes=initial.notes.filter(note=>note.s!=='s3');delete initial.openBy.s3;delete initial.focusBy.s3;
  const result=changed(initial,'group-delete',{id:'g1'});
  assert.equal(result.groups.length,1);assert.equal(result.groups[0].name,'Pessoal');assert.equal(result.groups[0].sessions[0].name,'Geral');
  assert.ok(result.notes.every(note=>note.deletedAt));assert.equal(result.notes.length,initial.notes.length);noOrphans(result);
});
test('excluir última sessão cria Geral e todas as notas permanecem restauráveis',()=>{
  const initial=fixture();initial.groups=[{...initial.groups[0],sessions:[initial.groups[0].sessions[0]]}];initial.notes=initial.notes.filter(note=>note.s==='s1');initial.openBy={s1:['n1','n2']};initial.focusBy={s1:'n1'};
  const removed=changed(initial,'session-delete',{id:'s1'});assert.equal(removed.groups[0].sessions[0].name,'Geral');noOrphans(removed);
  const restored=changed(removed,'note-restore',{id:'n1'});assert.equal(restored.notes.find(note=>note.id==='n1').deletedAt,undefined);assert.deepEqual(restored.notes.find(note=>note.id==='n1').editorDoc,initial.notes[0].editorDoc);noOrphans(restored);
});
test('enviar notas à lixeira mantém o grupo/sessão, preserva lixeira anterior e fecha painéis',()=>{
  const initial=fixture(),result=changed(initial,'session-trash-notes',{id:'s1'});
  assert.equal(result.groups,initial.groups);assert.deepEqual(result.openBy.s1,[]);assert.equal(result.focusBy.s1,null);assert.equal(result.editing,null);
  assert.equal(result.notes.find(note=>note.id==='n5').deletedAt,'2026-01-01T00:00:00.000Z');assert.ok(!result.notes.find(note=>note.id==='n3').deletedAt);noOrphans(result);
});
test('renomear, fixar, cores e reordenar afetam apenas o destino escolhido',()=>{
  let result=changed(fixture(),'note-rename',{id:'n1',name:'  Título novo  '});assert.equal(result.notes[0].title,'Título novo');
  result=changed(result,'note-pin',{id:'n1'});assert.equal(result.notes[0].pinned,true);
  result=changed(result,'group-rename',{id:'g1',name:'Minha vida'});assert.equal(result.groups[0].name,'Minha vida');
  result=changed(result,'group-color',{id:'g1',color:'#FF6494'});assert.equal(result.groups[0].color,'#FF6494');
  result=changed(result,'group-reorder',{id:'g1',direction:'last'});assert.equal(result.groups[1].id,'g1');
  result=changed(result,'session-rename',{id:'s1',name:'Rotina'});assert.equal(result.groups[1].sessions[0].name,'Rotina');
  result=changed(result,'session-reorder',{id:'s1',direction:'down'});assert.deepEqual(result.groups[1].sessions.map(session=>session.id),['s2','s1']);
  result=changed(result,'group-expanded',{id:'g2',expanded:true});assert.equal(result.expanded.g2,true);
  result=changed(result,'groups-expanded',{expanded:false});assert.ok(Object.values(result.expanded).every(value=>!value));noOrphans(result);
});
test('criar sessão e nova nota utiliza destino clicado mesmo quando outra sessão está ativa',()=>{
  let result=changed(fixture(),'session-create',{id:'g2',name:'Nova sessão'});
  const created=result.groups[1].sessions[1];assert.equal(created.name,'Nova sessão');assert.equal(result.session,created.id);noOrphans(result);
  result=changed(result,'session-new-note',{id:'s2'});assert.equal(result.notes[0].s,'s2');assert.equal(result.session,'s2');assert.equal(result.editing,result.notes[0].id);noOrphans(result);
});
test('abas preservam foco e fechamento; ordenação não move notas de outras sessões',()=>{
  const initial=fixture();let result=changed(initial,'note-focus',{id:'n3'});assert.equal(result.layout,'focus');assert.equal(result.session,'s2');assert.ok(result.openBy.s2.includes('n3'));
  result=changed(result,'note-close-others',{id:'n3'});assert.deepEqual(result.openBy.s2,['n3']);assert.equal(result.focusBy.s2,'n3');
  result=changed(result,'note-close',{id:'n3'});assert.deepEqual(result.openBy.s2,[]);assert.equal(result.focusBy.s2,null);
  result=changed(initial,'session-open-notes',{id:'s1'});assert.deepEqual(result.openBy.s1,['n2','n1']);assert.equal(result.layout,'split');
  const grid={...initial,noteDisplay:'grid',notes:[...initial.notes,...Array.from({length:6},(_,i)=>({id:'extra-'+i,s:'s1',title:'Extra '+i,body:'Preservado.'}))]};
  const opened=changed(grid,'session-open-notes',{id:'s1'});assert.equal(opened.openBy.s1.length,8);assert.equal(opened.noteDisplay,'grid');
  assert(opened.openBy.s1.includes('extra-5'));assert.equal(opened.notes,grid.notes);
  result=changed(initial,'session-sort-notes',{id:'s1',order:'title-asc'});assert.deepEqual(result.notes.filter(note=>note.s==='s1').map(note=>note.title),['Antiga','Árvore','Zebra']);assert.equal(result.notes[2].id,'n3');assert.equal(result.notes[3].id,'n4');
  result=changed(initial,'session-move-notes',{id:'s1',sessionId:'s3'});assert.equal(result.notes.find(note=>note.id==='n5').s,'s1');assert.ok(result.notes.filter(note=>['n1','n2'].includes(note.id)).every(note=>note.s==='s3'));noOrphans(result);
});
test('todos os menus possuem ações reais ou submenus, e nomes/exclusões abrem diálogos próprios',()=>{
  const host={state:fixture(),setState(patch){this.state={...this.state,...(typeof patch==='function'?patch(this.state):patch)};}};
  const visit=items=>items.forEach(item=>{if(item.separator)return;if(item.children){assert.ok(item.children.length);visit(item.children);}else assert.equal(typeof item.action,'function',item.label);});
  for(const kind of ['note','group','session'])visit(buildContextItems(host,kind,kind==='note'?'n1':kind==='group'?'g1':'s1'));
  buildContextItems(host,'note','n1').find(item=>item.id==='note-rename').action();assert.equal(host.state.contextDialog.mode,'name');assert.equal(host.state.contextDialog.value,'Zebra');
  buildContextItems(host,'group','g1').find(item=>item.id==='group-delete').action();assert.equal(host.state.contextDialog.mode,'confirm');assert.equal(host.state.contextDialog.danger,true);
  const reorder=buildContextItems(host,'group','g1').find(item=>item.id==='group-order');assert.equal(reorder.children[0].disabled,true);assert.equal(reorder.children[1].disabled,false);
});
test('copiar usa texto visual, exportar aguarda flush, e anexos abrem o gerenciador real',async()=>{
  const copied=[],events=[],host={state:fixture(),setState(patch){this.state={...this.state,...(typeof patch==='function'?patch(this.state):patch)};},copyText:async text=>copied.push(text),plainText:()=> 'Nota com link',run:task=>task(),showToast:text=>events.push(text),flushAll:async()=>events.push('flush')};
  await invokeContextAction(host,'note-copy-text',{id:'n1'});assert.deepEqual(copied,['Nota com link']);
  await invokeContextAction(host,'note-export',{id:'n1'});assert.deepEqual(exported,['n1']);assert.ok(events.includes('flush'));
  invokeContextAction(host,'note-attachments',{id:'n1'});assert.equal(host.state.dialog,'attachments');assert.equal(host.state.attachmentNoteId,'n1');
});
