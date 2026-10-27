'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {WorkspaceStore}=require('../desktop/storage.cjs');
const seed={groups:[{id:'g',name:'Pessoal',sessions:[{id:'s',name:'Notas'}]}],notes:[{id:'n',s:'s',title:'Nota',body:'Conteúdo preservado.'}],session:'s',openBy:{s:['n']},focusBy:{s:'n'}};

test('tamanhos e grid persistem e sincronizam sem alterar o conteúdo das notas',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notes-panel-pref-'));
  const a=new WorkspaceStore({dataDir:path.join(directory,'a'),deviceId:'panel-a',seed});
  const b=new WorkspaceStore({dataDir:path.join(directory,'b'),deviceId:'panel-b',seed});
  t.after(async()=>{await a.close();await b.close();});await a.init();await b.init();
  const state=a.snapshot;state.noteDisplay='grid';state.panelSizes={sidebar:280,list:360,notes:{n:620},sections:{groups:220}};
  await a.save(state);await b.mergeRevisions(a.exportRevisions());
  assert.deepEqual(b.snapshot.panelSizes,state.panelSizes);assert.equal(b.snapshot.noteDisplay,'grid');assert.deepEqual(b.snapshot.notes,state.notes);
  const reopened=new WorkspaceStore({dataDir:path.join(directory,'a'),seed});await reopened.init();
  assert.deepEqual(reopened.snapshot.panelSizes,state.panelSizes);assert.equal(reopened.snapshot.noteDisplay,'grid');await reopened.close();
});

test('preferências de tamanho inválidas são rejeitadas antes de alterar a biblioteca',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'notes-panel-invalid-'));
  const store=new WorkspaceStore({dataDir,seed});await store.init();t.after(()=>store.close());
  const before=store.snapshot;
  for(const panelSizes of [{sidebar:0},{list:10000},{notes:{n:-1}},{sections:{groups:1700}},{unexpected:300},{notes:Array(2).fill(300)},{notes:Object.fromEntries(Array.from({length:513},(_,i)=>['n'+i,300]))},JSON.parse('{"notes":{"__proto__":300}}')]){
    await assert.rejects(store.save({...before,panelSizes}));assert.deepEqual(store.snapshot,before);
  }
});
