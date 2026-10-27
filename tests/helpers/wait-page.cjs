// Poll IPC-backed conditions in Node. An async predicate passed to the browser's
// requestAnimationFrame poller is a truthy Promise before its result is known.
async function waitPage(page, predicate, arg, {timeout=30000, interval=25, message='A condição do aplicativo não foi atendida no prazo.'}={}){
  const deadline=Date.now()+timeout;
  while(true){
    const result=await page.evaluate(predicate,arg);
    if(result)return result;
    if(Date.now()>=deadline)throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,interval));
  }
}

module.exports={waitPage};
