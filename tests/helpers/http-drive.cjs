'use strict';
// Local HTTP transport around the Drive v3 protocol fixture. Electron's main
// process uses its real fetch client; no renderer or cloud account is mocked in.
const http=require('node:http');
const {fakeDrive}=require('./fake-drive.cjs');
async function serveFakeDrive(){
  const drive=fakeDrive({pageSize:7});
  const server=http.createServer(async(request,response)=>{
    try{
      if(!['Bearer test-only-token','Bearer test-access-only'].includes(request.headers.authorization)){response.writeHead(401);response.end();return;}
      const chunks=[];let length=0;
      for await(const chunk of request){length+=chunk.length;if(length>64*1024*1024)throw new Error('Fixture body exceeds limit');chunks.push(chunk);}
      const body=Buffer.concat(chunks),headers={...request.headers,'Content-Range':request.headers['content-range']};
      const result=await drive.fetch('https://www.googleapis.com'+request.url,{method:request.method,headers,...(body.length?{body}:request.method==='PUT'?{body:Buffer.alloc(0)}:{})});
      response.writeHead(result.status,Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    }catch{response.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {drive,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
module.exports={serveFakeDrive};
