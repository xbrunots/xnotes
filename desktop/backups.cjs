const fs=require('node:fs/promises');
const nativeFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const yazl=require('yazl');
const yauzl=require('yauzl');
const BACKUP_LIMITS={entries:200001,totalBytes:32*1024*1024*1024,workspaceBytes:512*1024*1024,fileBytes:256*1024*1024};

async function writeBackup(filename,snapshot,assets,overrides={}){
  const limits={...BACKUP_LIMITS,...overrides};
  const metadata=Buffer.from(JSON.stringify({format:'notes-backup',version:1,exportedAt:new Date().toISOString(),checksum:crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),workspace:snapshot}));
  const descriptors=new Map(snapshot.notes.flatMap(note=>note.attachments || []).map(file=>[file.hash,file]));
  if(descriptors.size+1>limits.entries||metadata.length>limits.workspaceBytes)throw new Error('A biblioteca excede os limites de restauração do backup. Nenhum backup incompleto foi criado.');
  let total=metadata.length;
  const verified=[];for(const [hash] of descriptors){const file=await assets.file(hash);const stat=await fs.stat(file);total+=stat.size;if(stat.size>limits.fileBytes||total>limits.totalBytes)throw new Error('A biblioteca excede os limites de restauração do backup. Nenhum backup incompleto foi criado.');verified.push({hash,filename:file});}
  const temporary=filename+'.'+crypto.randomUUID()+'.partial';
  const zip=new yazl.ZipFile();
  zip.on('error',error=>zip.outputStream.destroy(error));
  try{
    const done=pipeline(zip.outputStream,nativeFs.createWriteStream(temporary,{flags:'wx'}));
    zip.addBuffer(metadata, 'workspace.json');
    for(const file of verified)zip.addFile(file.filename,'assets/'+file.hash,{compress:false});
    zip.end();await done;await fs.rename(temporary,filename);
  }catch(error){zip.outputStream.destroy();await fs.unlink(temporary).catch(()=>{});throw error;}
}

async function readBackup(filename,assets,overrides={}){
  const limits={...BACKUP_LIMITS,...overrides};
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'notes-backup-'));
  let zip;
  let workspace=null,total=0,count=0;const received=new Set();
  try{
    zip=await new Promise((resolve,reject)=>yauzl.open(filename,{lazyEntries:true,validateEntrySizes:true},(error,value)=>error?reject(error):resolve(value)));
    await new Promise((resolve,reject)=>{
      const fail=error=>{zip.close();reject(error);};
      zip.on('error',fail);zip.on('end',resolve);
      zip.on('entry',entry=>{(async()=>{
        if(++count>limits.entries||entry.uncompressedSize>(entry.fileName==='workspace.json'?limits.workspaceBytes:limits.fileBytes)||(total+=entry.uncompressedSize)>limits.totalBytes)throw new Error('O backup excede os limites de restauração.');
        const match=/^assets\/([a-f0-9]{64})$/.exec(entry.fileName);
        if(entry.fileName!=='workspace.json'&&!match)throw new Error('O ZIP não é um backup válido do notes.');
        if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000)throw new Error('O backup contém um link simbólico.');
        const stream=await new Promise((resolveStream,rejectStream)=>zip.openReadStream(entry,(error,value)=>error?rejectStream(error):resolveStream(value)));
        const target=path.join(staging,String(count));let bytes=0;
        await pipeline(stream,new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>entry.uncompressedSize){callback(new Error('Tamanho inválido no backup.'));return;}callback(null,chunk);}}),nativeFs.createWriteStream(target,{flags:'wx'}));
        if(entry.fileName==='workspace.json'){
          if(workspace)throw new Error('O backup contém metadados duplicados.');
          const data=JSON.parse(await fs.readFile(target,'utf8'));
          if(data.format!=='notes-backup'||data.version!==1||!Array.isArray(data.workspace?.notes)||!Array.isArray(data.workspace?.groups))throw new Error('Formato de backup inválido.');
          if(data.checksum!==crypto.createHash('sha256').update(JSON.stringify(data.workspace)).digest('hex'))throw new Error('Os metadados do backup estão corrompidos.');
          workspace=data.workspace;
        }else{
          const descriptor=await assets.addFile(target,{name:match[1]});
          if(descriptor.hash!==match[1])throw new Error('Um anexo do backup falhou na verificação de integridade.');
          received.add(match[1]);
        }
        zip.readEntry();
      })().catch(fail);});
      zip.readEntry();
    });
    if(!workspace)throw new Error('O backup não contém notas.');
    for(const descriptor of workspace.notes.flatMap(note=>note.attachments || []))if(!received.has(descriptor.hash))throw new Error('O backup está incompleto: um anexo está ausente.');
    return workspace;
  }finally{
    zip?.close();
    const resolved=path.resolve(staging),parent=path.resolve(os.tmpdir())+path.sep;
    if(resolved.startsWith(parent)&&path.basename(resolved).startsWith('notes-backup-'))await fs.rm(resolved,{recursive:true,force:true});
  }
}
module.exports={writeBackup,readBackup,BACKUP_LIMITS};
