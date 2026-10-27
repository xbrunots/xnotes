const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const esbuild=require('esbuild');
const seed=require('../desktop/seed.json');

function harness(save,snapshot=seed){
  const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/notes.jsx')],bundle:true,write:false,platform:'node',format:'cjs',external:['react','react-dom','@tiptap/*'],loader:{'.css':'empty'},logLevel:'silent'});
  const module={exports:{}};
  const window={innerWidth:1440,notes:{save},matchMedia:()=>({matches:false})};
  vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require,window,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,console},{timeout:10000});
  const notes=new module.exports.Notes({snapshot:structuredClone(snapshot),sync:{state:'disconnected'},drives:[]});
  notes.setState=(patch,callback)=>{notes.state={...notes.state,...(typeof patch==='function'?patch(notes.state):patch)};callback?.();};
  notes.scheduleSave=()=>{};
  return notes;
}
test('save async preserva teclas digitadas enquanto o disco trabalha',async()=>{
  let resolveFirst;const calls=[];
  const editor=harness((snapshot,base)=>{calls.push({snapshot,base});return calls.length===1?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve(snapshot);});
  editor.state.notes=editor.state.notes.map((n,i)=>i? n:{...n,body:'primeira versão'});
  const first=editor.flush();
  editor.state.notes=editor.state.notes.map((n,i)=>i? n:{...n,body:'versão digitada durante o save'});
  resolveFirst(calls[0].snapshot);await first;
  assert.equal(editor.state.notes[0].body,'versão digitada durante o save');
  await editor.flushAll();
  assert.equal(calls[1].snapshot.notes[0].body,'versão digitada durante o save');
  clearTimeout(editor.saveTimer);
});
test('autosave preserva metadados de versões futuras sem confundi-los com estado da UI',async()=>{
  const initial={...structuredClone(seed),futureMetadata:{version:2,preserved:'dados adicionais'}};
  let saved;
  const editor=harness(snapshot=>{saved=snapshot;return Promise.resolve(snapshot);},initial);
  editor.state.notes=editor.state.notes.map((note,i)=>i?note:{...note,body:'Editado no notes'});
  await editor.flushAll();
  assert.deepEqual(saved.futureMetadata,initial.futureMetadata);
  const incoming={...saved,futureMetadata:{version:3,preserved:'novos dados'}};
  editor.receive(incoming);
  assert.deepEqual(editor.snapshotForSave().futureMetadata,incoming.futureMetadata);
  assert.equal(editor.state.futureMetadata,undefined);
});
test('atualização remota no callback React é drenada mesmo sem nova edição',async()=>{
  let resolveSave;const editor=harness(()=>new Promise(resolve=>{resolveSave=resolve;}));
  const callbacks=[];let hold=true;
  editor.setState=(patch,callback)=>{editor.state={...editor.state,...patch};if(hold)callbacks.push(callback);else callback?.();};
  editor.state.notes=editor.state.notes.map((n,i)=>i? n:{...n,body:'local'});
  const saving=editor.flush();const local=structuredClone(editor.state);for(const key of ['driveStatus','drives','dialog','dialogName','toast','saveError','busy','w','palette','pq','psel','editing'])delete local[key];
  resolveSave(local);await new Promise(resolve=>setImmediate(resolve));
  const remote=structuredClone(local);remote.notes[0].body='remoto chegou após o save';
  editor.receive(remote);hold=false;callbacks.shift()();await saving;
  assert.equal(editor.state.notes[0].body,'remoto chegou após o save');assert.equal(editor.pendingRemote,null);
  clearTimeout(editor.saveTimer);
});
