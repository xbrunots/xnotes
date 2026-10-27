import React,{useMemo,useState} from 'react';
import {plainText} from './note-content';

export function GitHubIcon({size=18}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.9c.1-1.1-.4-1.8-1-2.2 3.2-.4 6.5-1.6 6.5-7A5.5 5.5 0 0 0 19 5.1c.2-1.2.1-2.4-.4-3.5 0 0-1.2-.4-4.1 1.5a14 14 0 0 0-7 0C4.6 1.2 3.4 1.6 3.4 1.6c-.5 1.1-.6 2.3-.4 3.5A5.5 5.5 0 0 0 1.5 9c0 5.3 3.3 6.6 6.5 7-.5.4-.9 1.1-1 2.1V22" transform="translate(1 0) scale(.92)"/></svg>;}
export const githubWorking=state=>['checking','installing','authenticating','creating-repo','syncing'].includes(state);

export function GitHubPanel({status,inspection,busy,onConnect,onSync,onCancel,onInspect,onFolder,onRepository,onConflicts,onCopy}){
  const connected=!!status.connected,working=githubWorking(status.state),onboarding=status.onboarding || {},repository=status.repository;
  const steps=[
    {label:'Preparar o computador',detail:'Git e GitHub CLI serão instalados se necessário.',done:inspection?.git?.installed&&inspection?.gh?.installed,active:['checking','installing'].includes(status.state)},
    {label:'Entrar no GitHub',detail:status.account?.login?'Conectado como '+status.account.login:'Você autoriza a conexão no navegador.',done:!!status.account?.login||inspection?.account?.loggedIn,active:status.state==='authenticating'||status.state==='auth-required'},
    {label:'Criar seu repositório privado',detail:repository?.nameWithOwner || 'Suas notas e seu histórico ficam na sua conta.',done:connected,active:status.state==='creating-repo'},
  ];
  return <>
    <div className="dialog-intro"><span className="dialog-icon"><GitHubIcon size={25}/></span><div><h2>{connected?'Sua biblioteca no GitHub.':'Conecte uma vez. Continue escrevendo.'}</h2><p>{connected?'Cópia local completa, histórico de versões e sincronização diária.':'O notes prepara as ferramentas, abre o login e cria um repositório privado para você.'}</p></div></div>
    {!connected&&<ol className="github-onboarding" aria-label="Etapas de conexão ao GitHub">{steps.map((step,index)=><li key={step.label} data-state={step.done?'done':step.active?'active':'pending'}><span className="github-step-number" aria-hidden="true">{step.done?'✓':index+1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div></li>)}</ol>}
    <div className="connection-card" aria-live="polite"><div className="connection-heading"><span className={'status-dot status-'+status.state}/><strong>{onboarding.message || ({ready:'Sincronizado com o GitHub',offline:'Offline · suas notas estão salvas localmente',conflict:'Há versões para comparar',disconnected:'Pronto para conectar',error:'Não foi possível concluir a sincronização','auth-required':'Entre na sua conta GitHub',checking:'Verificando o computador…',installing:'Preparando as ferramentas…',authenticating:'Conclua o login no navegador', 'creating-repo':'Preparando seu repositório privado…',syncing:'Sincronizando…'}[status.state] || 'Conecte sua conta GitHub')}</strong></div>
      {repository?.nameWithOwner&&<strong className="github-repository-name">{repository.nameWithOwner}</strong>}
      {status.lastSuccessfulSync&&<small>Última sincronização: {new Date(status.lastSuccessfulSync).toLocaleString('pt-BR')}</small>}
      {status.nextSync&&connected&&<small>Próxima sincronização: {new Date(status.nextSync).toLocaleString('pt-BR')}</small>}
      {connected&&status.background?.installed&&<small>Rotina diária ativa também com o notes fechado, enquanto sua sessão do Windows estiver aberta.</small>}
      {connected&&status.background?.error&&<p className="error-text">O Windows não permitiu ativar a rotina em segundo plano. A sincronização diária continua com o notes aberto. {status.background.error}</p>}
      {!!status.pending&&connected&&<small>{status.pending} alterações aguardando envio.</small>}
      {status.error&&<p className="error-text" role="alert">{status.error}</p>}
    </div>
    {onboarding.deviceCode&&<div className="github-device-code"><span>Confirme este código no navegador</span><button type="button" onClick={()=>onCopy(onboarding.deviceCode)} aria-label="Copiar código de autorização">{onboarding.deviceCode}</button><small>Seu código é temporário. A senha fica no GitHub.</small></div>}
    <div className="dialog-actions">{status.state==='conflict'?<button className="primary" onClick={onConflicts}>Comparar versões ({status.conflictCount || 0})</button>:connected?<button className="primary" disabled={busy||working} onClick={onSync}>Sincronizar agora</button>:<button className="primary" disabled={busy||working} onClick={onConnect}>{status.state==='error'?'Tentar novamente':'Conectar GitHub'}</button>}{working&&<button onClick={onCancel}>Cancelar</button>}{!connected&&!working&&<button className="quiet" onClick={onInspect}>Verificar novamente</button>}</div>
    {repository?.localPath&&<div className="github-local-folder"><span>Pasta da biblioteca</span><p>{repository.localPath}</p><div><button onClick={onFolder}>Abrir pasta</button>{repository.url&&<button onClick={onRepository}>Abrir no GitHub</button>}</div></div>}
    <div className="sync-explanation"><p><strong>Uma vez por dia ou pelo botão.</strong> A sincronização recebe as alterações, mescla o que for compatível, cria um commit e envia para o GitHub. Ctrl+Shift+S também sincroniza; Ctrl+S salva neste computador.</p><p>Se duas versões forem incompatíveis, você compara Local e GitHub e escolhe o que manter. Até decidir, as versões continuam preservadas.</p></div>
  </>;
}

function textOf(version,kind){
  if(!version||version.deleted)return '';
  const note=version.note || version;
  if(kind==='note')return [note.title,plainText(note.body || '',note.richText)].filter(Boolean).join('\n\n');
  if(version.binary)return '';
  const source=version.text ?? version.content ?? '';
  return typeof source==='string'?source:'';
}

// Aligned line comparison, bounded to keep large imported notes responsive.
function comparison(left,right){
  const a=left.split('\n'),b=right.split('\n');
  if(a.length*b.length>250000)return [...a.map(text=>({local:text,remote:null,type:'removed'})),...b.map(text=>({local:null,remote:text,type:'added'}))];
  const rows=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
  const result=[];let i=0,j=0;
  while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){result.push({local:a[i++],remote:b[j++],type:'same'});}else if(i<a.length&&(j===b.length||rows[i+1][j]>=rows[i][j+1]))result.push({local:a[i++],remote:null,type:'removed'});else result.push({local:null,remote:b[j++],type:'added'});}
  return result;
}

export function GitHubConflictPanel({session,busy,onResolve}){
  const items=session?.items || session?.conflicts || [],[selected,setSelected]=useState(0),[choices,setChoices]=useState({});
  const item=items[Math.min(selected,items.length-1)],kind=item?.kind || 'file';
  const rows=useMemo(()=>item?comparison(textOf(item.local,kind),textOf(item.remote,kind)):[],[item,kind]);
  if(!item)return <p>Não há conflitos pendentes.</p>;
  const complete=items.every(entry=>choices[entry.id]);
  return <div className="github-conflict-content"><p className="muted">Compare as versões e escolha o que manter. Alterações compatíveis já foram mescladas.</p><div className="github-conflict-tabs" role="tablist" aria-label="Conflitos para revisar">{items.map((entry,index)=><button key={entry.id} role="tab" aria-selected={selected===index} onClick={()=>setSelected(index)}>{choices[entry.id]&&<span aria-hidden="true">✓ </span>}{entry.title || entry.path || 'Nota'}</button>)}</div><div className="github-conflict-versions">{['local','remote'].map(side=><section key={side} aria-label={side==='local'?'Versão local':'Versão do GitHub'}><h2>{side==='local'?'Local':'GitHub'}</h2>{item[side]?.deleted?<p className="github-version-empty">Excluído nesta versão.</p>:item[side]?.binary?<p className="github-version-empty">Arquivo binário · {item[side]?.size??0} bytes<br/>{item[side]?.hash || ''}</p>:<div className="github-conflict-lines">{rows.map((row,index)=><div key={index} className={'github-conflict-line '+(row[side]===null?'empty':row.type)}>{row[side]??'\u00a0'}</div>)}</div>}</section>)}</div><div className="github-conflict-choices" role="group" aria-label="Escolher versão">{[['local','Manter local'],['remote','Manter GitHub'],['both','Manter ambas']].filter(([choice])=>choice!=='both'||item.canKeepBoth!==false).map(([choice,label])=><button key={choice} aria-pressed={choices[item.id]===choice} onClick={()=>setChoices(value=>({...value,[item.id]:choice}))}>{label}</button>)}</div><div className="github-conflict-apply"><span>{Object.keys(choices).length} de {items.length} decisões</span><button className="primary" disabled={!complete||busy} onClick={()=>onResolve({sessionId:session.sessionId,remoteCommit:session.remoteCommit,expectedHeadIds:session.expectedHeadIds,choices:items.map(entry=>({id:entry.id,choice:choices[entry.id]}))})}>{busy?'Aplicando…':'Aplicar e sincronizar'}</button></div></div>;
}
