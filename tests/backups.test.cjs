const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {AssetStore}=require('../desktop/assets.cjs');
const {writeBackup,readBackup}=require('../desktop/backups.cjs');

test('backup portátil restaura notas e bytes de anexos em outro computador',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notes-backup-test-'));
  const source=path.join(root,'documento.md');await fs.writeFile(source,'# Ação\nDados íntegros.');
  const a=new AssetStore({dataDir:path.join(root,'a')}),b=new AssetStore({dataDir:path.join(root,'b')});
  const file=await a.addFile(source,{relativePath:'Notas/documento.md'});
  const snapshot={groups:[{id:'g',name:'Importação',color:'#abc123',sessions:[{id:'s',name:'Notas'}]}],notes:[{id:'n',s:'s',title:'Ação',body:'Dados',attachments:[file],imported:{source:'obsidian',path:'Notas/documento.md'}}]};
  const zip=path.join(root,'backup.zip');await writeBackup(zip,snapshot,a);
  assert.deepEqual(await readBackup(zip,b),snapshot);
  assert.equal(await fs.readFile(await b.file(file.hash),'utf8'),'# Ação\nDados íntegros.');
});
test('exportação recusa antes de escrever um backup que excederia seu leitor',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notes-backup-limit-'));
  const source=path.join(root,'data.txt');await fs.writeFile(source,'conteúdo preservado');
  const assets=new AssetStore({dataDir:path.join(root,'local')});const attachment=await assets.addFile(source);
  const snapshot={groups:[],notes:[{id:'n',s:'s',title:'Limite',body:'Dados',attachments:[attachment]}]};
  const output=path.join(root,'backup.zip');
  await assert.rejects(writeBackup(output,snapshot,assets,{entries:1}),/limites de restauração/);
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
  await assert.rejects(writeBackup(output,snapshot,assets,{totalBytes:20}),/limites de restauração/);
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
});
