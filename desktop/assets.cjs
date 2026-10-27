'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const HASH=/^[a-f0-9]{64}$/;
const MAX_BYTES=256*1024*1024;
const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.pdf':'application/pdf','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm','.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.html':'text/html','.htm':'text/html'};

class AssetStore {
  constructor({dataDir}){this.folder=path.join(dataDir,'assets');this.checked=new Map();this.queue=Promise.resolve();}
  async init(){await fs.mkdir(this.folder,{recursive:true});return this;}
  async _verified(filename,expected){
    let stat;try{stat=await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return false;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('O anexo deve ser um arquivo regular.');
    const stamp=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;
    if(this.checked.get(filename)===stamp)return true;
    const hash=crypto.createHash('sha256');
    for await(const chunk of nativeFs.createReadStream(filename))hash.update(chunk);
    if(hash.digest('hex')!==expected)throw new Error('A integridade de um anexo não pôde ser confirmada. O arquivo foi preservado.');
    this.checked.set(filename,stamp);return true;
  }
  async _copy(source,destination,expected){
    const temporary=destination+'.'+crypto.randomUUID()+'.partial';
    const hash=crypto.createHash('sha256');let bytes=0;
    try{
      const guard=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>MAX_BYTES){callback(new Error('O anexo excede 256 MB.'));return;}hash.update(chunk);callback(null,chunk);}});
      await pipeline(nativeFs.createReadStream(source),guard,nativeFs.createWriteStream(temporary,{flags:'wx'}));
      const result=hash.digest('hex');
      if(expected&&result!==expected)throw new Error('Checksum inválido no anexo. Nenhum arquivo existente foi substituído.');
      const final=expected?destination:path.join(this.folder,result);
      if(await this._verified(final,result))await fs.unlink(temporary);
      else await fs.rename(temporary,final);
      return {hash:result,size:bytes};
    }catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
  }
  async addFile(filename,{name,relativePath,mime}={}){
    await this.init();const stat=await fs.lstat(filename);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Links simbólicos não são importados como anexos.');
    if(stat.size>MAX_BYTES)throw new Error('O arquivo '+path.basename(filename)+' excede 256 MB.');
    const result=await this._copy(filename,path.join(this.folder,'import-'+crypto.randomUUID()),null);
    const filenameOnly=path.basename(name || filename);
    return {...result,name:filenameOnly,relativePath:relativePath || filenameOnly,mime:mime || MIME[path.extname(filenameOnly).toLowerCase()] || 'application/octet-stream'};
  }
  async file(hash){if(!HASH.test(hash))throw new Error('Identificador de anexo inválido.');const filename=path.join(this.folder,hash);if(!await this._verified(filename,hash))throw new Error('O anexo ainda não está disponível neste computador.');return filename;}
  syncFolder(folder,descriptors){
    const run=()=>this._syncFolder(folder,descriptors);
    const result=this.queue.then(run);this.queue=result.catch(()=>{});return result;
  }
  async _syncFolder(folder,descriptors){
    await this.init();const target=path.join(folder,'assets');
    await fs.mkdir(target).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const dir=await fs.lstat(target);if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error('A pasta de anexos precisa ser uma pasta regular.');
    let pending=0,uploaded=0,downloaded=0;
    const unique=new Map(descriptors.filter(d=>HASH.test(d.hash)).map(d=>[d.hash,d]));
    for(const [hash,descriptor] of unique){
      const local=path.join(this.folder,hash),remote=path.join(target,hash);
      const hasLocal=await this._verified(local,hash),hasRemote=await this._verified(remote,hash);
      if(hasLocal&&!hasRemote){const copied=await this._copy(local,remote,hash);if(copied.size!==descriptor.size)throw new Error('O tamanho do anexo não corresponde aos metadados.');uploaded++;}
      else if(!hasLocal&&hasRemote){const copied=await this._copy(remote,local,hash);if(copied.size!==descriptor.size)throw new Error('O tamanho do anexo não corresponde aos metadados.');downloaded++;}
      else if(!hasLocal&&!hasRemote)pending++;
    }
    return {pending,uploaded,downloaded};
  }
}
module.exports={AssetStore,HASH};
