const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const esbuild=require('esbuild');
const {validateSnapshot}=require('../desktop/storage.cjs');

const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/organize-workspace.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const moduleObject={exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module:moduleObject,exports:moduleObject.exports},{timeout:1000});
const {WORKSPACE_DRAG_MIME,serializeWorkspaceDrag,parseWorkspaceDrag,writeWorkspaceDrag,readWorkspaceDrag,applyWorkspaceDrop,canWorkspaceDrop}=moduleObject.exports;

const fixture=()=>({
  groups:[
    {id:'g1',name:'Pessoal',color:'#FF9F0A',customGroup:{kept:true},sessions:[{id:'s1',name:'Diário',customSession:{kept:true}},{id:'s2',name:'Estudos'}]},
    {id:'g2',name:'Trabalho',color:'#7D7AFF',sessions:[{id:'s3',name:'Projeto'},{id:'s4',name:'Arquivo'}]},
    {id:'g3',name:'Vazio',color:'#30D158',sessions:[]},
  ],
  notes:[
    {id:'n1',s:'s1',title:'Primeira',body:'**Texto**',t:'Ontem',attachments:[{hash:'a'.repeat(64),name:'imagem.png',relativePath:'imagem.png',size:20,mime:'image/png'}],tags:['pessoal'],richText:{version:1,source:'**Texto**',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Texto',marks:[{type:'bold'}]}]}]}},future:{kept:true}},
    {id:'n2',s:'s1',title:'Segunda',body:'Texto 2',pinned:true},
    {id:'n3',s:'s2',title:'Terceira',body:'Texto 3'},
    {id:'n4',s:'s3',title:'Quarta',body:'Texto 4'},
    {id:'n5',s:'s1',title:'Antiga',body:'Preservada',deletedAt:'2026-10-27T00:00:00Z'},
    {id:'n6',s:'s1',title:'Sexta',body:'Texto 6'},
  ],
  session:'s1',view:'session',tag:null,editing:'n1',layout:'split',sidebar:true,
  openBy:{s1:['n1','n2','n6'],s2:['n3'],s3:['n4','n1'],s4:[]},focusBy:{s1:'n1',s2:'n3',s3:'n1',s4:null},expanded:{g1:true,g2:false,g3:false},
});
const source=(kind,id,extra={})=>({kind,id,...extra});
function frozen(value) {if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(frozen);}return value;}
function apply(initial,from,to,position) {
  const before=structuredClone(initial),patch=structuredClone(applyWorkspaceDrop(frozen(initial),from,to,position)),result={...initial,...patch};
  assert.deepEqual(initial,before,'o drop não pode alterar o estado de entrada');validateSnapshot(result);
  assert.equal(result.notes.length,before.notes.length,'nenhuma nota deve desaparecer');
  assert.equal(new Set(result.notes.map(note=>note.id)).size,result.notes.length,'nenhuma nota deve ser duplicada');
  const sessionIds=new Set(result.groups.flatMap(group=>group.sessions.map(session=>session.id)));
  result.notes.forEach(note=>assert.ok(sessionIds.has(note.s),'a sessão de cada nota deve existir'));
  for(const [session,id] of Object.entries(result.focusBy))if(id)assert.ok(result.openBy[session]?.includes(id),'o foco precisa ser uma aba aberta');
  return {result,patch};
}

test('grupos são reordenados antes/depois preservando sessões e metadados',()=>{
  const initial=fixture(),{result}=apply(initial,source('group','g1'),source('group','g2'),'after');
  assert.deepEqual(result.groups.map(group=>group.id),['g2','g1','g3']);
  assert.deepEqual(result.groups[1],initial.groups[0]);assert.deepEqual(result.notes,initial.notes);
  const first=apply(fixture(),source('group','g3'),source('group','g1'),'before').result;
  assert.deepEqual(first.groups.map(group=>group.id),['g3','g1','g2']);
});

test('sessões mudam de grupo em um único patch sem duplicar IDs ou tocar as notas',()=>{
  const initial=fixture(),{result}=apply(initial,source('session','s1'),source('group','g3'),'inside');
  assert.deepEqual(result.groups[0].sessions.map(session=>session.id),['s2']);
  assert.deepEqual(result.groups[2].sessions,[initial.groups[0].sessions[0]]);
  assert.equal(result.expanded.g3,true);assert.equal(result.session,'s1');
  assert.deepEqual(result.notes,initial.notes);assert.deepEqual(result.openBy,initial.openBy);
});

test('sessões reordenam no mesmo grupo e em relação a sessões de outro grupo',()=>{
  const same=apply(fixture(),source('session','s2'),source('session','s1'),'before').result;
  assert.deepEqual(same.groups[0].sessions.map(session=>session.id),['s2','s1']);
  const moved=apply(fixture(),source('session','s1'),source('session','s4'),'before').result;
  assert.deepEqual(moved.groups[1].sessions.map(session=>session.id),['s3','s1','s4']);
  assert.equal(moved.groups[0].sessions.length,1);assert.equal(moved.expanded.g2,true);
});

test('reordenar notas preserva documentos, anexos, propriedades e todas as notas da lixeira',()=>{
  const initial=fixture(),{result,patch}=apply(initial,source('note','n6'),source('note','n1'),'before');
  assert.deepEqual(result.notes.filter(note=>note.s==='s1'&&!note.deletedAt).map(note=>note.id),['n6','n1','n2']);
  assert.deepEqual(result.notes.find(note=>note.id==='n1'),initial.notes[0]);
  assert.deepEqual(result.notes.find(note=>note.id==='n5'),initial.notes.find(note=>note.id==='n5'));
  assert.deepEqual(Object.keys(patch),['notes']);
});

test('mover nota aberta transfere a aba, limpa foco antigo e mantém todos os dados visuais',()=>{
  const initial=fixture(),{result}=apply(initial,source('note','n1'),source('session','s2'),'inside');
  const moved=result.notes.find(note=>note.id==='n1');
  assert.deepEqual(moved,{...initial.notes[0],s:'s2'});
  assert.deepEqual(result.openBy.s1,['n2','n6']);assert.equal(result.focusBy.s1,'n6');
  assert.deepEqual(result.openBy.s3,['n4']);assert.equal(result.focusBy.s3,'n4');
  assert.deepEqual(result.openBy.s2,['n3','n1']);assert.equal(result.focusBy.s2,'n3');
  assert.equal(result.editing,null);assert.equal(result.session,'s1');
});

test('mover nota fechada não cria abas e permite destino sem nenhuma nota',()=>{
  const initial=fixture();initial.openBy.s1=['n1','n2'];
  const {result}=apply(initial,source('note','n6'),source('session','s4'),'inside');
  assert.equal(result.notes.find(note=>note.id==='n6').s,'s4');
  assert.deepEqual(result.openBy,initial.openBy);assert.deepEqual(result.focusBy,initial.focusBy);
});

test('nota arrastada entre notas de outra sessão muda de destino e ordem conjuntamente',()=>{
  const initial=fixture(),{result}=apply(initial,source('note','n1'),source('note','n4'),'before');
  assert.deepEqual(result.notes.filter(note=>note.s==='s3').map(note=>note.id),['n1','n4']);
  assert.deepEqual(result.notes.find(note=>note.id==='n1'),{...initial.notes[0],s:'s3'});
  assert.ok(result.openBy.s3.includes('n1'));assert.ok(!result.openBy.s1.includes('n1'));
});

test('abas reordenam independentemente das notas e conservam o foco do editor',()=>{
  const initial=fixture(),{result,patch}=apply(initial,source('tab','n6'),source('tab','n1'),'before');
  assert.deepEqual(result.openBy.s1,['n6','n1','n2']);assert.equal(result.focusBy.s1,'n1');
  assert.deepEqual(result.notes,initial.notes);assert.deepEqual(result.groups,initial.groups);
  assert.deepEqual(Object.keys(patch),['openBy']);
});

test('drops impossíveis, autorreferentes e de entidades excluídas não alteram o workspace',()=>{
  const initial=fixture();
  for(const [from,to,position] of [
    [source('note','n5'),source('session','s2'),'inside'],
    [source('note','n1'),source('note','n1'),'before'],
    [source('group','g1'),source('group','g1'),'after'],
    [source('session','s1'),source('session','s1'),'before'],
    [source('session','s1'),source('group','missing'),'inside'],
    [source('note','n1'),source('session','missing'),'inside'],
    [source('note','n1'),source('group','g2'),'inside'],
    [source('tab','n1'),source('tab','n3',{sessionId:'s2'}),'before'],
    [source('tab','n3'),source('tab','n1'),'before'],
    [source('note','n1'),source('session','s2'),'before'],
    [source('session','s1'),source('group','g2'),'after'],
    [source('note','n1'),source('note','n2'),'invalid'],
  ]){
    const {patch}=apply(initial,from,to,position);assert.equal(Object.keys(patch).length,0);
    assert.equal(canWorkspaceDrop(initial,from,to,position),false);
  }
});

test('o MIME próprio contém apenas tipo, ID e versão e ignora caminhos e dados estranhos',()=>{
  const data=serializeWorkspaceDrag(source('tab','n-123',{sessionId:'s1'}));
  assert.deepEqual(JSON.parse(data),{version:1,kind:'tab',id:'n-123',sessionId:'s1'});
  assert.deepEqual(structuredClone(parseWorkspaceDrag(data)),source('tab','n-123',{sessionId:'s1'}));
  for(const text of ['',null,'{bad}',JSON.stringify({version:2,kind:'note',id:'n1'}),JSON.stringify({version:1,kind:'note',id:'../documento'}),JSON.stringify({version:1,kind:'note',id:'C:\\Users\\documento.md'}),JSON.stringify({version:1,kind:'note',id:'n1',path:'secret.md'}),JSON.stringify({version:1,kind:'file',id:'n1'}),'x'.repeat(2049)])assert.equal(parseWorkspaceDrag(text),null);
  assert.equal(serializeWorkspaceDrag(source('note','n1',{body:'texto privado'})),null);
});

test('DataTransfer somente aceita o MIME próprio sem arquivos ou URI externos',()=>{
  const entries=new Map(),transfer={types:[],files:[],setData(type,text){entries.set(type,text);this.types=[...entries.keys()];},getData:type=>entries.get(type)};
  assert.equal(writeWorkspaceDrag(transfer,source('note','n1')),true);
  assert.equal(transfer.effectAllowed,'move');assert.deepEqual(transfer.types,[WORKSPACE_DRAG_MIME]);
  assert.deepEqual(structuredClone(readWorkspaceDrag(transfer)),source('note','n1'));
  assert.equal(readWorkspaceDrag({...transfer,files:[{name:'arquivo.md'}]}),null);
  assert.equal(readWorkspaceDrag({...transfer,types:[WORKSPACE_DRAG_MIME,'Files']}),null);
  assert.equal(readWorkspaceDrag({types:['text/uri-list'],getData:()=> 'file:///C:/segredo'}),null);
  assert.equal(readWorkspaceDrag({types:['text/plain'],getData:()=>entries.get(WORKSPACE_DRAG_MIME)}),null);
  assert.equal(writeWorkspaceDrag({setData(){throw Error('indisponível');}},source('note','n1')),false);
});
