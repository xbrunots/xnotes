'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {DriveApi}=require('../desktop/drive-api.cjs');
const {GoogleDriveOAuth,SCOPE}=require('../desktop/drive-oauth.cjs');
const {fakeAuth,fakeDrive,hash,json}=require('./helpers/fake-drive.cjs');

test('resumable consulta o offset confirmado após conexão interrompida com chunk parcialmente recebido',async()=>{
  const bytes=Buffer.alloc(9*1024*1024,77),name='notes-v1-asset-'+hash(bytes);
  let metadata,received=Buffer.alloc(0),interrupted=false,probes=0;
  const fetch=async(value,options={})=>{
    const url=new URL(value);assert.equal(url.origin,'https://www.googleapis.com');
    const final=()=>({...metadata,size:String(received.length),version:'1',sha256Checksum:hash(received)});
    if(url.pathname.endsWith('/generateIds'))return json({ids:['review-file']});
    if(options.method==='POST'){
      metadata=JSON.parse(options.body);
      return new Response(null,{status:200,headers:{Location:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=review'}});
    }
    if(options.method==='PUT'){
      const range=options.headers['Content-Range'];
      if(range==='bytes */'+bytes.length){
        probes++;
        return received.length===bytes.length?json(final()):new Response(null,{status:308,headers:received.length?{Range:'bytes=0-'+(received.length-1)}:{}});
      }
      const parts=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '');
      assert.ok(parts);assert.equal(Number(parts[3]),bytes.length);
      if(Number(parts[1])!==received.length)return json({error:{errors:[{reason:'invalidRange'}]}},400);
      if(!interrupted){
        interrupted=true;received=Buffer.from(options.body.subarray(0,4*1024*1024));
        throw new TypeError('simulated interruption after partial commit');
      }
      received=Buffer.concat([received,Buffer.from(options.body)]);
      return received.length===bytes.length?json(final()):new Response(null,{status:308,headers:{Range:'bytes=0-'+(received.length-1)}});
    }
    return received.length===bytes.length?json(final()):json({error:{}},404);
  };
  const api=new DriveApi({auth:fakeAuth(),fetch,maxAttempts:3,retryBaseMs:0,maxRetryMs:0});
  const uploaded=await api.uploadImmutable({name,buffer:bytes,sha256:hash(bytes),kind:'asset'});
  assert.ok(probes>0,'o cliente deve consultar a sessão antes de reenviar bytes de posição incerta');
  assert.equal(uploaded.id,'review-file');assert.equal(uploaded.sha256Checksum,hash(bytes));
  assert.deepEqual(received,bytes);
});

test('sessão de upload externa ou rebaixada para HTTP nunca recebe token nem conteúdo',async()=>{
  const bytes=Buffer.from('review-only fixture');
  for(const location of [
    'https://attacker.invalid/upload/drive/v3/files?uploadType=resumable',
    'https://www.googleapis.com.attacker.invalid/upload/drive/v3/files?uploadType=resumable',
    'https://www.googleapis.com@attacker.invalid/upload/drive/v3/files?uploadType=resumable',
    'http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
  ]){
    const requests=[];
    const api=new DriveApi({auth:fakeAuth(),fetch:async(value,options={})=>{
      const url=new URL(value);requests.push({url,method:options.method});
      assert.equal(url.origin,'https://www.googleapis.com');
      return url.pathname.endsWith('/generateIds')?json({ids:['review-file']}):new Response(null,{status:200,headers:{Location:location}});
    },retryBaseMs:0,maxRetryMs:0});
    await assert.rejects(api.uploadImmutable({name:'notes-v1-asset-'+hash(bytes),buffer:bytes,kind:'asset'}),{code:'DRIVE_PROTOCOL'});
    assert.equal(requests.length,2);assert.ok(!requests.some(request=>request.method==='PUT'));
  }
});

test('anexo de zero bytes mantém hash e ID imutáveis no upload e download',async()=>{
  const drive=fakeDrive(),api=new DriveApi({auth:fakeAuth(),fetch:drive.fetch,retryBaseMs:0,maxRetryMs:0});
  const bytes=Buffer.alloc(0),sha256=hash(bytes),name='notes-v1-asset-'+sha256;
  const uploaded=await api.uploadImmutable({name,buffer:bytes,sha256,kind:'asset'});
  assert.equal(uploaded.size,'0');assert.equal(uploaded.sha256Checksum,sha256);
  assert.equal((await api.downloadBuffer(uploaded.id)).length,0);
  assert.equal((await api.verifyFile(uploaded.id,{sha256,size:0})).size,0);
  assert.equal((await api.uploadImmutable({name,buffer:bytes,sha256,kind:'asset'})).id,uploaded.id);
  assert.equal(drive.files.size,1);
  assert.ok(drive.requests.some(request=>request.method==='PUT'&&request.options.headers['Content-Range']==='bytes */0'));
});

function encryptedStorage(){
  const key=crypto.randomBytes(32);
  return {
    isAsyncEncryptionAvailable:async()=>true,
    encryptStringAsync:async text=>{
      const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
      const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
    },
    decryptStringAsync:async bytes=>{
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      return {result:Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'),shouldReEncrypt:false};
    },
  };
}

test('nova autorização sem refresh token não reutiliza a autorização offline da conta anterior',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'notes-cloud-review-'));
  let authorizations=0;
  const auth=new GoogleDriveOAuth({dataDir:directory,safeStorage:encryptedStorage(),authTimeoutMs:3000,
    openExternal:async value=>{
      const url=new URL(value),callback=new URL(url.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname,'127.0.0.1');
      callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','review-code');
      const response=await fetch(callback);assert.equal(response.status,200);await response.text();
    },
    fetch:async()=>json({access_token:'review-account-'+(++authorizations),expires_in:3600,token_type:'Bearer',scope:SCOPE,...(authorizations===1?{refresh_token:'review-account-one-refresh'}:{})}),
  });
  t.after(async()=>{await auth.close();await fs.rm(directory,{recursive:true,force:true});});
  await auth.configure({installed:{client_id:'review-desktop.apps.googleusercontent.com'}});
  await auth.connect();
  await assert.rejects(auth.connect(),{code:'AUTH_REQUIRED'});
});
