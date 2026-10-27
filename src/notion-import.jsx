import React,{useEffect,useRef,useState} from 'react';
import './notion-import.css';

const EXPORT_GUIDE='https://www.notion.com/help/export-your-content#export-your-entire-workspace';
const PHASES={connect:'Autorize o notes no navegador',scan:'Localizando páginas e bancos',import:'Trazendo sua biblioteca',archive:'Importando a exportação',download:'Preservando arquivos',commit:'Salvando no computador'};
const count=value=>Number.isFinite(value)?value.toLocaleString('pt-BR'):'0';
const issueText=issue=>typeof issue==='string'?issue:issue?.message || issue?.code || 'Conteúdo que precisa de conferência.';
const errorText=error=>(error?.message || 'Não foi possível concluir. Tente novamente.').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');

function NotionMark(){return <span className="source-monogram" aria-hidden="true">N</span>;}

export function NotionImport({onBeforeImport,onImported,onArchive,onClose,archiveProgress}){
  const [status,setStatus]=useState({connected:false,state:'loading'});
  const [summary,setSummary]=useState(null);
  const [progress,setProgress]=useState(null);
  const [phase,setPhase]=useState(null);
  const [error,setError]=useState(null);
  const [cancelled,setCancelled]=useState(false);
  const [showGuide,setShowGuide]=useState(false);
  const mounted=useRef(false),active=useRef(false),cancelRequested=useRef(false);

  useEffect(()=>{
    mounted.current=true;
    const off=window.notes.onNotionProgress(value=>{if(mounted.current)setProgress(value);});
    window.notes.notionStatus().then(value=>{if(mounted.current){setStatus(value);if(value.migration?.id&&(value.migration.state!=='applied'||value.migration.canResume))setSummary(value.migration);if(value.migrationWarning)setError(value.migrationWarning);}}).catch(()=>{if(mounted.current)setStatus({connected:false,state:'disconnected'});});
    return()=>{mounted.current=false;off();if(active.current)window.notes.cancelNotion().catch(()=>{});};
  },[]);

  async function perform(nextPhase,task){
    if(active.current)return;
    active.current=true;cancelRequested.current=false;
    setPhase(nextPhase);setError(null);setCancelled(false);setProgress(null);
    try{await task();}
    catch(failure){if(mounted.current&&!cancelRequested.current)setError(errorText(failure));}
    finally{active.current=false;if(mounted.current)setPhase(null);}
  }

  function discover(resume=false){return perform('connect',async()=>{
    const connected=await window.notes.connectNotion();
    if(!mounted.current||cancelRequested.current)return;
    setStatus(connected);setPhase('scan');
    const result=await window.notes.scanNotion({resume});
    const latest=await window.notes.notionStatus();
    if(mounted.current){setSummary(result);setStatus(latest);}
  });}

  function importLibrary(){return perform('import',async()=>{
    await onBeforeImport();
    const report=await window.notes.importNotion(summary.id);
    if(mounted.current)onImported(report);
  });}

  async function cancel(){
    cancelRequested.current=true;setCancelled(true);
    try{await window.notes.cancelNotion();}catch{}
  }

  const busy=!!phase,issues=Array.isArray(summary?.issues)?summary.issues:[];
  const hasContent=!!summary?.canImport;
  const step=phase==='import'?2:summary||phase==='scan'?1:0;
  const workspace=status.account?.workspaceName;
  const currentProgress=phase==='archive'?archiveProgress:progress;
  const stage=currentProgress?.stage || currentProgress?.phase;
  const progressTitle=PHASES[stage] || PHASES[phase] || 'Preparando a migração';

  return <div className="notion-migration">
    <ol className="migration-steps" aria-label="Etapas da importação">
      {['Conectar','Conferir','Importar'].map((label,index)=><li key={label} aria-current={step===index?'step':undefined} data-done={step>index}><span aria-hidden="true">{step>index?'✓':index+1}</span>{label}</li>)}
    </ol>
    <div className="import-source-heading"><NotionMark/><div><h2>Seu Notion, aqui.</h2><p>Páginas, bancos e arquivos no seu computador, com o contexto preservado.</p></div></div>

    {!summary&&!busy?<div className="migration-start">
      <p>Conecte sua conta para localizar o conteúdo disponível. Você confere o inventário antes de importar.</p>
      <div className="migration-promises"><span>Origem preservada</span><span>Login no navegador</span><span>Sem token manual</span></div>
    </div>:null}

    {status.connected?<div className="migration-account"><span className="status-dot status-ready" aria-hidden="true"/><span>{workspace || 'Conta Notion conectada'}</span><button className="quiet" disabled={busy} onClick={()=>perform('connect',async()=>{const value=await window.notes.disconnectNotion();if(mounted.current){setStatus(value);setSummary(null);}})}>Desconectar</button></div>:null}

    {busy?<div className="migration-progress" role="status" aria-live="polite">
      <span className="status-dot status-syncing" aria-hidden="true"/>
      <div><strong>{progressTitle}</strong><p>{phase==='connect'?'Conclua a autorização na página oficial do Notion.':phase==='archive'?(currentProgress?.message || `${count(currentProgress?.files)} arquivos lidos. Aguarde a preservação dos originais.`):`${count(currentProgress?.pages ?? currentProgress?.processed ?? currentProgress?.files)} itens conferidos. Você pode interromper e retomar.`}</p></div>
    </div>:null}

    {summary?<section className="migration-inventory" aria-label="Conteúdo encontrado no Notion">
      <div className="import-stats"><div><strong>{count(summary.pages)}</strong><span>páginas</span></div><div><strong>{count(summary.databases)}</strong><span>bancos</span></div><div><strong>{count(summary.files)}</strong><span>arquivos</span></div></div>
      <div className={'migration-coverage '+(summary.complete?'is-complete':'has-gaps')} role={summary.complete?'status':'alert'}>
        <strong>{summary.complete?'Conteúdo acessível conferido':'Há pendências para uma migração completa'}</strong>
        <p>{summary.complete?'O inventário percorreu o conteúdo que esta conexão permite acessar.':'Algumas páginas, linhas ou arquivos não puderam ser conferidos. Use a exportação completa para complementar a biblioteca.'}</p>
      </div>
      <p className="muted migration-scope">{summary.coverageMessage || 'O acesso depende da conta e das permissões do Notion. Confira teamspaces e páginas que não aparecem nesta conexão com uma exportação completa.'}</p>
      {issues.length?<div className="migration-issues"><h3>{issues.length} {issues.length===1?'pendência':'pendências'}</h3><ul>{issues.slice(0,12).map((issue,index)=><li key={index}>{issueText(issue)}</li>)}</ul>{issues.length>12?<p className="muted">O relatório completo acompanha a importação.</p>:null}</div>:null}
    </section>:null}

    {error?<div className="migration-error" role="alert"><strong>A migração não foi concluída.</strong><p>{error}</p><p>Você pode tentar novamente ou usar uma exportação completa.</p></div>:null}
    {cancelled&&!busy?<p className="migration-cancelled" role="status">Operação interrompida. As notas já existentes foram preservadas; retome quando quiser.</p>:null}

    <div className="migration-primary-actions">
      {busy?(phase==='archive'?null:<button onClick={cancel} disabled={stage==='commit'}>Interromper</button>):<>
        {hasContent?<button className="primary" onClick={importLibrary}>{summary.complete?'Importar biblioteca':'Importar conteúdo encontrado'}</button>:null}
        <button className={hasContent?'':'primary'} disabled={status.state==='loading'} onClick={()=>discover(summary?.canResume===true)}>{status.connected?(summary?.canResume?'Retomar verificação':summary?'Conferir novamente':'Localizar biblioteca'):'Conectar ao Notion'}</button>
        {summary?.canResume?<button className="quiet" onClick={()=>discover(false)}>Iniciar nova verificação</button>:null}
      </>}
    </div>

    <section className="migration-archive" aria-label="Importar exportação completa">
      <div><h3>Também funciona com uma exportação completa</h3><p>Traga o ZIP de todo o workspace, incluindo subpáginas e arquivos.</p></div>
      <div className="migration-archive-actions"><button disabled={busy} onClick={()=>perform('archive',()=>onArchive('zip'))}>Selecionar ZIP…</button><button disabled={busy} onClick={()=>perform('archive',()=>onArchive('folder'))}>Pasta extraída…</button></div>
      <button className="quiet migration-guide-toggle" aria-expanded={showGuide} onClick={()=>setShowGuide(value=>!value)}>Como exportar tudo<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{transform:showGuide?'rotate(180deg)':undefined}}><path d="M3 5h8L7 9Z" fill="currentColor"/></svg></button>
      {showGuide?<div className="migration-guide"><ol><li>No Notion, abra <strong>Configurações → Workspace → Geral</strong>.</li><li>Escolha <strong>Exportar todo o conteúdo do workspace</strong>, em HTML ou Markdown e CSV, com subpáginas e arquivos.</li><li>Quando o Notion disponibilizar o arquivo, selecione o ZIP completo aqui. Exportar uma página isolada traz apenas aquela parte da biblioteca.</li></ol><button className="quiet" onClick={()=>window.notes.openExternal(EXPORT_GUIDE).catch(()=>setError('Não foi possível abrir a ajuda do Notion.'))}>Abrir instruções oficiais ↗</button></div>:null}
    </section>
    <footer><span className="version">As notas atuais continuam na biblioteca.</span><button disabled={busy} onClick={onClose}>Cancelar</button></footer>
  </div>;
}
