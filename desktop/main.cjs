const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, shell, nativeTheme, clipboard, powerMonitor, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { WorkspaceStore } = require('./storage.cjs');
const { GitHubSync } = require('./github-sync.cjs');
const { GitHubTools } = require('./github-tools.cjs');
const { GitHubScheduler } = require('./github-scheduler.cjs');
const { AssetStore } = require('./assets.cjs');
const { importWorkspace } = require('./importers.cjs');
const { NotionClient } = require('./notion-client.cjs');
const { NotionMigration } = require('./notion-migration.cjs');
const { AiRuntime } = require('./ai-runtime.cjs');
const { AiWorkspace } = require('./ai-workspace.cjs');
const { writeBackup,readBackup,BACKUP_LIMITS } = require('./backups.cjs');
const seed = require('./seed.json');

app.setName('notes');
app.setAppUserModelId('app.notes.windows');
protocol.registerSchemesAsPrivileged([{ scheme: 'notes', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win, store, sync, tools, scheduler, runtimeRoot, assets, importing = false, config = {}, closing = false, readyToClose = false, dataDir;
const testing = process.env.NOTES_TEST === '1';
const syncOnly = process.argv.includes('--sync-only');
let openedDeviceCode, scheduledSync, scheduling = Promise.resolve();
let notionClient, notionMigration, notionOperation;
let aiRuntime, aiWorkspace;
const send = (channel, value) => { if (win && !win.isDestroyed()) win.webContents.send(channel, value); };
const action = (type, data = {}) => send('ui:action', { type, ...data });

async function configureData() {
  if(testing&&!process.env.NOTES_TEST_DATA_DIR)throw new Error('QA requer um perfil temporário explícito.');
  let candidate = testing && process.env.NOTES_TEST_DATA_DIR ? path.resolve(process.env.NOTES_TEST_DATA_DIR) : process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'notes-data') : path.join(app.getPath('appData'), 'notes');
  try {
    await fs.mkdir(candidate, {recursive:true});
    const probe = path.join(candidate, '.write-' + randomUUID());
    await fs.writeFile(probe, ''); await fs.unlink(probe);
  } catch (error) {
    if(testing)throw new Error('Não foi possível criar o perfil temporário de QA; nenhum perfil real foi aberto.');
    candidate = path.join(app.getPath('appData'), 'notes');
    await fs.mkdir(candidate, {recursive:true});
  }
  dataDir = candidate; app.setPath('userData', candidate);
  try { config = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') config = { configWarning: 'A configuração do dispositivo não pôde ser lida. Suas notas foram preservadas.' }; }
}
async function saveDeviceConfig(patch){
  config={...config,...patch};
  await require('./storage.cjs').atomicWrite(path.join(dataDir,'settings.json'),config);
}
const syncStatus=()=>({...sync.status,background:scheduler?.lastStatus || null});
function toolProgress(progress){
  if(testing)return;
  if(progress.verificationUri==='https://github.com/login/device'&&/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(progress.deviceCode || '')&&openedDeviceCode!==progress.deviceCode){
    openedDeviceCode=progress.deviceCode;void shell.openExternal(progress.verificationUri).catch(()=>{});
  }
}
function updateSyncStatus(status){
  send('github:status',{...status,background:scheduler?.lastStatus || null});
  if(status.connected&&status.lastSuccessfulSync&&status.lastSuccessfulSync!==scheduledSync&&scheduler&&!testing){
    scheduledSync=status.lastSuccessfulSync;
    scheduling=scheduling.then(()=>scheduler.ensure()).then(result=>{scheduler.lastStatus=result;send('github:status',syncStatus());}).catch(()=>{});
  }
}
async function ensureManualGitHubAccount(){
  const inspection=await tools.ensureInstalled();
  const account=inspection.account?.loggedIn?inspection.account:await tools.login();
  const owner=sync.status.account?.login;
  if(!account?.loggedIn || (owner&&account.login.toLowerCase()!==owner.toLowerCase()))throw new Error('Entre na mesma conta GitHub desta biblioteca para continuar.');
}
const safeFilename = name => (name || 'Sem título').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120).replace(/[. ]+$/, '') || 'Nota';

function runNotion(stage, task) {
  if (closing) throw new Error('A janela está concluindo o salvamento.');
  if (notionOperation || importing) throw new Error('Aguarde a importação atual terminar.');
  const controller = new AbortController();
  const operation = {controller,stage,promise:null};
  notionOperation = operation;
  const onProgress = value => send('notion:progress', {...value,stage:operation.stage});
  operation.promise = Promise.resolve().then(() => task({signal:controller.signal,onProgress,operation})).finally(() => {
    if (notionOperation === operation) notionOperation = null;
    send('notion:progress',null);
  });
  return operation.promise;
}
async function stopNotion() {
  const operation = notionOperation;
  // A journal commit is atomic and must finish even if the window closes.
  if (operation && operation.stage !== 'commit') operation.controller.abort();
  if (operation) await operation.promise.catch(() => {});
}
async function notionStatus() {
  const status = notionClient.status();
  try { return {...status,migration:await notionMigration.status()}; }
  catch { return {...status,migrationWarning:'O inventário anterior não pôde ser lido. Ele foi preservado; inicie uma nova verificação.'}; }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith('notes://app/')) throw new Error('Origem inválida.');
    return fn(...args);
  });
}
function registerIPC() {
  handle('workspace:bootstrap', async () => ({ snapshot:store.snapshot, sync:syncStatus(), ai:aiRuntime.status(), onboarding:(!testing||process.env.NOTES_TEST_SHOW_ONBOARDING==='1')&&!config.githubOnboardingSeen&&!sync.status.connected, recovery:store.recovery, warning:config.configWarning, dataDir, version:app.getVersion() }));
  handle('workspace:save', async (snapshot, base) => store.save(snapshot, {base}));
  handle('ai:status',()=>({...aiRuntime.status(),canUndo:!!aiWorkspace.undoRecord}));
  handle('ai:configure',settings=>{if(closing)throw new Error('A janela está fechando.');return aiRuntime.configure(settings);});
  handle('ai:discover',settings=>aiRuntime.discover(settings));
  handle('ai:run',payload=>{if(closing)throw new Error('A janela está fechando.');return aiWorkspace.run(payload);});
  handle('ai:apply',planId=>{if(closing||importing)throw new Error('Aguarde o salvamento ou importação terminar.');return aiWorkspace.apply(planId);});
  handle('ai:undo',()=>{if(closing||importing)throw new Error('Aguarde o salvamento ou importação terminar.');return aiWorkspace.undo();});
  handle('ai:cancel',()=>aiWorkspace.cancel());
  handle('ai:clear-history',()=>aiWorkspace.clearHistory());
  handle('clipboard:write', async text=>{if(typeof text!=='string'||text.length>16*1024*1024)throw new Error('Texto inválido.');await clipboard.writeText(text);});
  handle('clipboard:read', async ()=>(await clipboard.readText()).slice(0,16*1024*1024));
  handle('editor:native', command=>{if(!['undo','redo','cut','copy','paste','selectAll'].includes(command))throw new Error('Comando inválido.');win.webContents[command]();});
  handle('github:inspect', async () => ({inspection:await tools.inspect(),status:syncStatus()}));
  handle('github:connect', async () => {await saveDeviceConfig({githubOnboardingSeen:true});await sync.connect();return syncStatus();});
  handle('github:disconnect', async () => {await sync.disconnect();if(scheduler)scheduler.lastStatus=await scheduler.remove();return syncStatus();});
  handle('github:sync', async () => {await sync.connect();return syncStatus();});
  handle('github:conflicts', async () => sync.getConflicts());
  handle('github:resolve', async payload => {await ensureManualGitHubAccount();await sync.resolveConflicts(payload);return syncStatus();});
  handle('github:dismiss-onboarding', async () => saveDeviceConfig({githubOnboardingSeen:true}));
  handle('github:folder', async () => {const folder=path.join(runtimeRoot,'notes-repository');const result=await shell.openPath(folder);if(result)throw new Error('A pasta da biblioteca ainda não está disponível.');});
  handle('github:repository', async () => {const url=sync.status.repository?.url;if(typeof url!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(url))throw new Error('Conecte um repositório primeiro.');await shell.openExternal(url);});
  handle('notion:status', notionStatus);
  handle('notion:connect', () => runNotion('connect',async options => {
    await notionClient.connect(options);
    return notionStatus();
  }));
  handle('notion:disconnect', async () => {
    if (notionOperation || importing) throw new Error('Interrompa a importação antes de desconectar.');
    await notionClient.disconnect();
    return notionStatus();
  });
  handle('notion:scan', options => {
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'resume') || (options.resume !== undefined && typeof options.resume !== 'boolean'))) throw new Error('Opções de inventário inválidas.');
    return runNotion('scan',progress => notionMigration.scan({...progress,resume:options?.resume === true}));
  });
  handle('notion:import', planId => {
    if (typeof planId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(planId)) throw new Error('Inventário Notion inválido.');
    return runNotion('import',async ({signal,onProgress,operation}) => {
      importing = true;
      try {
        const base = store.snapshot;
        const result = await notionMigration.import({planId,snapshot:base,signal,onProgress});
        signal.throwIfAborted();
        operation.stage = 'commit'; onProgress({stage:'commit'});
        await store.save(result.snapshot,{base});
        // The durable workspace marker makes retries safe even if this final
        // bookkeeping write fails after the successful journal commit.
        await notionMigration.finish(planId).catch(() => {});
        return result.report;
      } finally { importing = false; }
    });
  });
  handle('notion:cancel', async () => {await stopNotion();return notionStatus();});
  handle('asset:save', async descriptor => {
    if(typeof descriptor?.hash!=='string')throw new Error('Anexo inválido.');
    const known=store.snapshot.notes.flatMap(note=>note.attachments || []).find(file=>file.hash===descriptor.hash);
    if(!known)throw new Error('O anexo não faz parte desta biblioteca.');
    const filename=await assets.file(known.hash);
    const result=await dialog.showSaveDialog(win,{title:'Salvar anexo',defaultPath:safeFilename(known.name)});
    if(result.canceled)return null;
    await fs.copyFile(filename,result.filePath);return result.filePath;
  });
  handle('link:open', async url=>{if(typeof url!=='string'||!/^https?:\/\//i.test(url))throw new Error('Endereço inválido.');await shell.openExternal(url);});
  handle('workspace:import-source', async (source,kind) => {
    if(!['notion','obsidian'].includes(source))throw new Error('Fonte de importação inválida.');
    if(importing || notionOperation)throw new Error('Aguarde a importação atual terminar.');
    const folder=kind==='folder';
    const selected=await dialog.showOpenDialog(win,{title:source==='notion'?'Selecionar exportação do Notion':'Selecionar cofre do Obsidian',properties:folder?['openDirectory']:['openFile'],...(folder?{}:{filters:[{name:'Arquivo ZIP',extensions:['zip']}]})});
    if(selected.canceled)return null;
    importing=true;
    try{
      const base=store.snapshot;
      const result=await importWorkspace({source,inputPath:selected.filePaths[0],snapshot:base,assets,onProgress:progress=>send('import:progress',progress)});
      await store.save(result.snapshot,{base});
      return result.report;
    }finally{importing=false;send('import:progress',null);}
  });
  handle('window:action', async type => {
    if (type === 'state') return {maximized:win.isMaximized(),minimized:win.isMinimized(),fullscreen:win.isFullScreen()};
    if (type === 'minimize') win.minimize();
    else if (type === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (type === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    else if (type === 'close') win.close();
  });
  handle('workspace:export', async () => {
    const result = await dialog.showSaveDialog(win, {title:'Exportar todas as notas e anexos',defaultPath:'notes-backup-' + new Date().toISOString().slice(0,10) + '.zip',filters:[{name:'Backup completo notes',extensions:['zip']}]});
    if (result.canceled) return null;
    await writeBackup(result.filePath,store.snapshot,assets);
    return result.filePath;
  });
  handle('workspace:import', async () => {
    const result = await dialog.showOpenDialog(win, {title:'Importar backup ou notas Markdown',properties:['openFile','multiSelections'],filters:[{name:'Notas e backups',extensions:['zip','json','md','txt']}]});
    if (result.canceled) return null;
    // Validate and collect everything before the first mutation.
    const collected = [], groups = [];
    for (const filename of result.filePaths) {
      const zipped=/\.zip$/i.test(filename);
      if (!zipped && (await fs.stat(filename)).size > 512 * 1024 * 1024) throw new Error('O arquivo excede o limite de importação.');
      const content = zipped?null:await fs.readFile(filename,'utf8');
      if (zipped || /\.json$/i.test(filename)) {
        const data = zipped?await readBackup(filename,assets):JSON.parse(content); const state = data.workspace || data;
        if (!Array.isArray(state.notes) || !Array.isArray(state.groups)) throw new Error('Este arquivo não é um backup válido do notes.');
        for (const note of state.notes) if (typeof note.title !== 'string' || typeof note.body !== 'string') throw new Error('O backup contém uma nota inválida.');
        for (const group of state.groups) if (typeof group.name !== 'string' || !Array.isArray(group.sessions) || group.sessions.some(s => typeof s.name !== 'string')) throw new Error('O backup contém uma sessão inválida.');
        groups.push(...state.groups); collected.push(...state.notes);
      } else collected.push({id:randomUUID(),title:path.basename(filename,path.extname(filename)),body:content,t:'Agora'});
    }
    const base = store.snapshot; const next = structuredClone(base); const ids = new Set(next.notes.map(n=>n.id));
    const groupIds = new Set(next.groups.map(g=>g.id)); const sessionIds = new Set(next.groups.flatMap(g=>g.sessions.map(s=>s.id)));
    // Existing groups/sessions are kept; imported entities get safe IDs when needed.
    const sessionMap = new Map();
    for (const group of groups) {
      const id = groupIds.has(group.id) ? 'g-' + randomUUID() : group.id; groupIds.add(id);
      const sessions = group.sessions.map(s=> { const sid = sessionIds.has(s.id) ? 's-' + randomUUID() : s.id; sessionIds.add(sid); sessionMap.set(s.id,sid); return {...s,id:sid}; });
      next.groups.push({...group,id,name:group.name,color:/^#[a-f0-9]{6}$/i.test(group.color) ? group.color : '#7D7AFF',sessions});
    }
    for (const note of collected) {
      const id = !note.id || ids.has(note.id) ? 'n-' + randomUUID() : note.id; ids.add(id);
      next.notes.unshift({...note,id,s:sessionMap.get(note.s) || base.session || next.groups[0].sessions[0].id,t:note.t || 'Agora'});
    }
    await store.save(next,{base}); return collected.length;
  });
  handle('note:export', async id => {
    const note = store.snapshot.notes.find(n=>n.id===id); if (!note) throw new Error('Nota não encontrada.');
    const result = await dialog.showSaveDialog(win,{title:'Exportar nota',defaultPath:safeFilename(note.title)+'.md',filters:[{name:'Markdown',extensions:['md']}]});
    if (result.canceled) return null;
    await fs.writeFile(result.filePath,'# '+(note.title || 'Sem título')+'\n\n'+note.body); return result.filePath;
  });
  handle('note:menu', async id => {
    if (!store.snapshot.notes.some(n=>n.id===id)) return;
    const moves = store.snapshot.groups.map(g=>({label:g.name,submenu:g.sessions.map(s=>({label:s.name,click:()=>action('move-note',{id,sessionId:s.id})}))}));
    Menu.buildFromTemplate([
      {label:'Editar nota',click:()=>action('edit-note',{id})},
      {label:'Duplicar',click:()=>action('duplicate-note',{id})},
      {label:'Mover para sessão',submenu:moves},
      {label:'Exportar Markdown…',click:()=>action('export-note',{id})},
      {type:'separator'},
      {label:'Mover para a lixeira',click:()=>action('trash-note',{id})},
    ]).popup({window:win});
  });
  handle('group:menu', async id => {
    if (!store.snapshot.groups.some(g=>g.id===id)) return;
    Menu.buildFromTemplate([{label:'Renomear grupo…',click:()=>action('rename-group',{id})},{label:'Nova sessão',click:()=>action('new-session',{id})},{label:'Novo grupo…',click:()=>action('new-group')}]).popup({window:win});
  });
  handle('app:menu', async (type,position) => {
    const menus={
      file:[
        {label:'Nova nota',accelerator:'Alt+N',click:()=>action('new-note')},
        {label:'Nota do dia',click:()=>action('daily-note')},
        {type:'separator'},
        {label:'Importar do Notion…',click:()=>action('open-dialog',{dialog:'import-notion'})},
        {label:'Importar do Obsidian…',click:()=>action('open-dialog',{dialog:'import-obsidian'})},
        {label:'Importar backup ou Markdown…',click:()=>action('import-backup')},
        {label:'Exportar backup…',click:()=>action('export-backup')},
        {type:'separator'},
        {label:'Configurações',accelerator:'CommandOrControl+,',click:()=>action('open-dialog',{dialog:'settings'})},
        {label:'Sair',accelerator:'Alt+F4',click:()=>win.close()},
      ],
      edit:[...['undo','redo','cut','copy','paste','selectAll'].map((command,index)=>({label:['Desfazer','Refazer','Recortar','Copiar','Colar','Selecionar tudo'][index],click:()=>action('editor-command',{command})})),{type:'separator'},{label:'Buscar notas',accelerator:'CommandOrControl+K',click:()=>action('search')}],
      view:[
        {label:'Navegar notas',click:()=>action('toggle-sidebar')},
        {label:'Layout padrão',click:()=>action('set-appearance',{appearance:'standard'})},
        {label:'Layout em ilha',click:()=>action('set-appearance',{appearance:'islands'})},
        {label:'Uma nota',click:()=>action('set-layout',{layout:'focus'})},
        {label:'Notas lado a lado',click:()=>action('set-layout',{layout:'split'})},
        {label:'Grid em mosaico',click:()=>action('set-layout',{layout:'grid'})},
        {type:'separator'},{role:'resetZoom',label:'Tamanho original'},{role:'zoomIn',label:'Ampliar'},{role:'zoomOut',label:'Reduzir'},
        {type:'separator'},{label:'Tela cheia',accelerator:'F11',click:()=>win.setFullScreen(!win.isFullScreen())},
        {label:'Atalhos de teclado',click:()=>action('open-dialog',{dialog:'shortcuts'})},
      ],
    };
    menus.all=[{label:'Arquivo',submenu:menus.file},{label:'Editar',submenu:menus.edit},{label:'Visualizar',submenu:menus.view}];
    if(!menus[type])return;
    const opts={window:win};
    if(Number.isFinite(position?.x)&&Number.isFinite(position?.y)){opts.x=Math.max(0,Math.round(position.x));opts.y=Math.max(0,Math.round(position.y));}
    Menu.buildFromTemplate(menus[type]).popup(opts);
  });
  ipcMain.on('window:close-ready', async event => {
    if (event.sender !== win?.webContents) return;
    readyToClose = true; await aiWorkspace.close(); await stopNotion(); await sync.close(); await tools.close(); await store.close(); await scheduling; win.close();
  });
}

async function start() {
  await configureData();
  if (!testing && !app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance',(_event,argv)=>{if(argv.includes('--sync-only')){void sync?.syncIfDue();return;}if(win){if(win.isMinimized())win.restore();win.focus();}});
  await app.whenReady();
  const uiRoot = path.join(__dirname, '..', 'app');
  protocol.handle('notes', async request => {
    const url = new URL(request.url);
    if(url.hostname==='asset'){
      const hash=url.pathname.slice(1);
      const descriptor=store?.snapshot.notes.flatMap(note=>note.attachments || []).find(file=>file.hash===hash);
      if(!descriptor)return new Response('Not found',{status:404});
      try{
        const filename=await assets.file(hash);const response=await net.fetch(pathToFileURL(filename).toString());
        const safeImage=/^image\/(png|jpeg|gif|webp|avif)$/.test(descriptor.mime);
        return new Response(response.body,{headers:{'Content-Type':safeImage?descriptor.mime:'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
      }catch{return new Response('Attachment not available',{status:404});}
    }
    if (url.hostname !== 'app') return new Response('Forbidden',{status:403});
    const target = path.resolve(uiRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(uiRoot + path.sep)) return new Response('Forbidden',{status:403});
    return net.fetch(pathToFileURL(target).toString());
  });
  store = new WorkspaceStore({dataDir,seed}); await store.init();
  assets = await new AssetStore({dataDir}).init();
  runtimeRoot=testing?dataDir:process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged?path.dirname(process.execPath):path.join(__dirname,'..'));
  const toolOptions={toolsDir:path.join(runtimeRoot,'notes-tools'),onProgress:toolProgress};
  tools=testing?require('./github-test.cjs').createTestTools(toolOptions).tools:new GitHubTools(toolOptions);
  if(!testing&&process.env.PORTABLE_EXECUTABLE_FILE){
    scheduler=new GitHubScheduler({executable:process.env.PORTABLE_EXECUTABLE_FILE,dataDir});
    scheduler.lastStatus=await scheduler.status();
  }
  sync = new GitHubSync({store,assets,tools,repoDir:path.join(runtimeRoot,'notes-repository'),onStatus:updateSyncStatus});
  await sync.init({syncIfDue:false});
  if(syncOnly){await sync.syncIfDue();await scheduling;await sync.close();await tools.close();await store.close();app.exit(0);return;}
  // Reading device settings never starts a CLI, a model, or a login flow.
  aiRuntime=new AiRuntime({dataDir,testing,emit:event=>send('ai:progress',event)});
  await aiRuntime.init();
  aiWorkspace=new AiWorkspace({store,runtime:aiRuntime,emit:event=>send('ai:progress',event)});
  // Opening the app only restores the encrypted local grant. All Notion
  // network activity and browser authorization require an explicit UI action.
  const notionOptions={dataDir,secureStorage:{isAvailable:()=>safeStorage.isEncryptionAvailable(),encrypt:text=>safeStorage.encryptString(text),decrypt:bytes=>safeStorage.decryptString(bytes)},openExternal:testing?async()=>{throw new Error('Login real desativado em QA.');}:url=>shell.openExternal(url)};
  if(testing)notionOptions.fetchImpl=async()=>{throw new Error('Acesso real ao Notion desativado em QA.');};
  notionClient=new NotionClient(notionOptions);
  await notionClient.restore().catch(()=>{});
  notionMigration=new NotionMigration({client:notionClient,dataDir,assets,...(testing?{fetchImpl:notionOptions.fetchImpl}:{})});
  powerMonitor.on('resume',()=>{void sync.syncIfDue();});
  nativeTheme.themeSource = store.snapshot.theme === 'light' ? 'light' : 'dark';
  store.on('change',snapshot=>{nativeTheme.themeSource = snapshot.theme === 'light' ? 'light' : 'dark';send('workspace:changed',snapshot);});
  registerIPC();
  win = new BrowserWindow({width:1440,height:900,useContentSize:true,minWidth:960,minHeight:640,frame:true,titleBarStyle:'hidden',titleBarOverlay:{height:42,color:'#00000000',symbolColor:store.snapshot.theme==='light'?'#1B1A21':'#F3F2F7'},show:false,title:'notes',backgroundColor:'#0B0A10',autoHideMenuBar:true,icon:path.join(__dirname,'../app/assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
  store.on('change',snapshot=>{if(!win.isDestroyed())win.setTitleBarOverlay({color:'#00000000',symbolColor:snapshot.theme==='light'?'#1B1A21':'#F3F2F7',height:42});});
  Menu.setApplicationMenu(null);
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{ if (!url.startsWith('notes://app/')) event.preventDefault(); });
  win.once('ready-to-show',()=>win.show());
  win.on('close',event=>{
    if (readyToClose || win.webContents.isCrashed()) return;
    event.preventDefault(); if (closing) return; closing = true;
    send('window:closing');
    // A renderer that is hung must not force data loss by a timed auto-close.
    setTimeout(async()=>{if(readyToClose || !win || win.isDestroyed())return;const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Continuar aguardando','Fechar com os dados já salvos'],defaultId:0,cancelId:0,message:'O editor está demorando para concluir o salvamento.'});if(result.response===1){readyToClose=true;await aiWorkspace.close();await stopNotion();await sync.close();win.close();}else closing=false;},12000).unref();
  });
  await win.loadURL('notes://app/index.html');
  void sync.syncIfDue();
  if (testing) global.__notesTest = {store,get sync(){return sync;},assets,dataDir,importWorkspace,
    createAiRuntime(){return new AiRuntime({dataDir,testing:true,emit:event=>send('ai:progress',event)});},
    async setAiRuntime(runtime){
      if(aiWorkspace.operation)throw new Error('QA: aguarde a operação de IA.');
      if(!['run','status','settings','configure','discover','cancel','close'].every(key=>typeof runtime?.[key]==='function'))throw new Error('QA: runtime sintético inválido.');
      await aiWorkspace.close();aiRuntime=runtime;aiWorkspace=new AiWorkspace({store,runtime,emit:event=>send('ai:progress',event)});
    },
    async setNotionClient(client){
      if(notionOperation)throw new Error('QA: aguarde a operação Notion.');
      if(typeof client?.callTool!=='function'||typeof client?.listTools!=='function'||typeof client?.status!=='function')throw new Error('QA: cliente sintético inválido.');
      notionClient=client;notionMigration=new NotionMigration({client,dataDir,assets,fetchImpl:notionOptions.fetchImpl});
    },
    async useGitHubRemote(testRemote,{loggedIn=false}={}){
      const target=path.resolve(testRemote),base=path.resolve(dataDir);
      if(!target.startsWith(base+path.sep))throw new Error('QA remote must be inside the temporary profile.');
      await sync.close();await tools.close();
      const fixture=require('./github-test.cjs').createTestTools({...toolOptions,loggedIn});tools=fixture.tools;
      sync=new GitHubSync({store,assets,tools,repoDir:path.join(runtimeRoot,'notes-repository'),testRemote:target,onStatus:updateSyncStatus});
      await sync.init({syncIfDue:false});
      return sync.status;
    },
    get tools(){return tools;}
  };
}
app.on('window-all-closed',()=>app.quit());
start().catch(async error=>{console.error('[notes]',error.message);await dialog.showMessageBox({type:'error',title:'notes',message:'Não foi possível abrir suas notas.',detail:error.message+'\nOs arquivos existentes foram preservados.'});app.exit(1);});
