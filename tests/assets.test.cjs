const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {AssetStore}=require('../desktop/assets.cjs');

test('anexo importado mantém bytes e sincroniza entre dois computadores',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notes-assets-'));
  const source=path.join(root,'ação.txt');await fs.writeFile(source,'dados originais · ação\n');
  const a=new AssetStore({dataDir:path.join(root,'pc-a')}),b=new AssetStore({dataDir:path.join(root,'pc-b')});
  const descriptor=await a.addFile(source,{relativePath:'pasta/ação.txt'});
  assert.equal(descriptor.relativePath,'pasta/ação.txt');assert.equal(await fs.readFile(await a.file(descriptor.hash),'utf8'),'dados originais · ação\n');
  const drive=path.join(root,'drive');await fs.mkdir(drive);
  assert.deepEqual(await a.syncFolder(drive,[descriptor,descriptor]),{pending:0,uploaded:1,downloaded:0});
  assert.deepEqual(await b.syncFolder(drive,[descriptor]),{pending:0,uploaded:0,downloaded:1});
  assert.equal(await fs.readFile(await b.file(descriptor.hash),'utf8'),await fs.readFile(source,'utf8'));
  assert.deepEqual(await b.syncFolder(drive,[descriptor]),{pending:0,uploaded:0,downloaded:0});
});
test('metadados antes do arquivo ficam pendentes; corrupção é explícita e preservada',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'notes-assets-'));
  const store=new AssetStore({dataDir:path.join(root,'pc')}),drive=path.join(root,'drive');await fs.mkdir(drive);
  const descriptor={hash:'a'.repeat(64),name:'a.txt',relativePath:'a.txt',mime:'text/plain',size:4};
  assert.equal((await store.syncFolder(drive,[descriptor])).pending,1);
  await fs.writeFile(path.join(drive,'assets',descriptor.hash),'fake');
  await assert.rejects(store.syncFolder(drive,[descriptor]),/integridade/);
  assert.equal(await fs.readFile(path.join(drive,'assets',descriptor.hash),'utf8'),'fake');
  await assert.rejects(store.file('../workspace.json'),/inválido/);
});
