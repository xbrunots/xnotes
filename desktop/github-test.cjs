'use strict';
// Available only to isolated NOTES_TEST launches. No GitHub command can escape
// this fixture runner; Git itself still operates on temporary bare repositories.
const path=require('node:path');
const fs=require('node:fs');
const {GitHubTools}=require('./github-tools.cjs');
function createTestTools({toolsDir,onProgress,loggedIn=false}={}){
  if(process.env.NOTES_TEST!=='1'||!process.env.NOTES_TEST_DATA_DIR)throw new Error('O adaptador de QA exige um perfil temporário.');
  const fixturePath=path.join(toolsDir,'gh','bin',process.platform==='win32'?'gh.exe':'gh');
  fs.mkdirSync(path.dirname(fixturePath),{recursive:true});
  if(!fs.existsSync(fixturePath))fs.writeFileSync(fixturePath,'notes QA fixture; never executed',{flag:'wx'});
  const state={loggedIn,commands:[],gitCommands:[]};let tools;
  tools=new GitHubTools({toolsDir,onProgress,trustedFileProtocol:true,runner:async(executable,args,options)=>{
    const name=path.basename(executable).toLowerCase();
    if(name==='git.exe'||name==='git'){state.gitCommands.push([...args]);return tools.spawn(executable,args,options);}
    if(name!=='gh.exe'&&name!=='gh')throw new Error('Processo não autorizado no QA.');
    state.commands.push([...args]);
    if(args[0]==='--version')return {stdout:'gh version 2.103.3\n',stderr:'',code:0};
    if(args[0]==='auth'&&args[1]==='status')return state.loggedIn?{stdout:JSON.stringify({state:'success',tokenSource:'keyring'}),stderr:'',code:0}:{stdout:'',stderr:'',code:1};
    if(args[0]==='auth'&&args[1]==='login'){
      options.onStderr?.('! First copy your one-time code: ABCD-EFGH\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
      await new Promise(resolve=>setTimeout(resolve,1200));state.loggedIn=true;
      return {stdout:'',stderr:'',code:0};
    }
    if(args[0]==='api'&&args.includes('user'))return {stdout:JSON.stringify({login:'notes-test-user',id:12345}),stderr:'',code:0};
    throw new Error('O QA bloqueou uma operação real no GitHub.');
  }});
  tools.fixtureState=state;
  tools.paths.gh=fixturePath;
  return {tools,state};
}
module.exports={createTestTools};
