const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('./build.cjs');

async function start() {
  await build();
  const executable = require('electron');
  const child = spawn(executable, [path.join(__dirname, '..')], {stdio:'inherit',windowsHide:true});
  let timer;
  const watch = fs.watch(path.join(__dirname,'../src'), {recursive:true}, ()=>{
    clearTimeout(timer);timer=setTimeout(()=>build().catch(console.error),180);
  });
  child.on('exit', code=>{watch.close();process.exitCode=code || 0;});
}
start().catch(error=>{console.error(error);process.exitCode=1;});
