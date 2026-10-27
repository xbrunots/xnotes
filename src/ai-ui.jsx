import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {DropdownIcon,PlusIcon} from './controls.jsx';
import './ai-ui.css';

export function SearchIcon({size=17}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>;}
export function AiIcon({size=18}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/><path d="M20 3v4M18 5h4"/></svg>;}
export function SettingsIcon({size=17}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.5 3-.6 2.2-2 .9-2-.6-2.4 4.1L4 11.2v1.7l-1.5 1.7L5 18.7l2-.6 2 .9.5 2.2h5l.6-2.2 2-.9 2 .6 2.4-4.1-1.5-1.7v-1.7l1.5-1.6L19 5.5l-2 .6-2-.9L14.5 3Z"/><circle cx="12" cy="12" r="3"/></svg>;}
function CloseIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>;}
function ArrowIcon(){return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>;}
function UndoIcon(){return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 5 3 10l5 5M3 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/></svg>;}
function RefreshIcon(){return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>;}
function CheckIcon(){return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>;}

const EMPTY_ROWS=[];
const EMPTY_AI={};
const EXAMPLES=[
  ['Criar uma estrutura','Crie um grupo Projetos com as sessões Ideias e Em andamento.'],
  ['Escrever uma nota','Crie uma nota com um roteiro para planejar minha semana.'],
  ['Organizar minhas notas','Organize minhas notas em grupos e sessões por assunto.']
];
const FOCUSABLE='button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),a[href]';
const errorText=error=>(error?.message || String(error || 'Não foi possível salvar. Tente novamente.')).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');

function RowIcon({row}){
  if(row.isCreation||/^criar |^nova? /i.test(row.label || ''))return <PlusIcon size={15}/>;
  if(row.isNote)return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 9h6M9 13h6"/></svg>;
  if(row.isSession)return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/></svg>;
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m13 3-8 11h6l-1 7 8-11h-6l1-7Z"/></svg>;
}

/** A single, keyboard-operated entry point for local search and workspace requests. */
export function WorkspaceSearch({open,query='',onQuery,rows=EMPTY_ROWS,selected=0,onSelect,onClose,onSettings,mode='search',onMode,ai=EMPTY_AI,onSubmit,onCancel,onUndo,onClear,inputRef}){
  const dialogRef=useRef(null),localInput=useRef(null),searchTab=useRef(null),aiTab=useRef(null);
  const uid=useId().replace(/:/g,''),listId='workspace-results-'+uid,titleId='workspace-title-'+uid,panelId='workspace-panel-'+uid;
  const items=useMemo(()=>rows.filter(row=>!row.isHeader),[rows]);
  const active=Math.max(0,Math.min(Number.isFinite(selected)?selected:0,items.length-1));
  const isAi=mode==='ai',hasAnswer=!!(ai.response || ai.error || ai.changes?.length);

  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement;
    const timer=setTimeout(()=>localInput.current?.focus(),0);
    return()=>{
      clearTimeout(timer);
      const focused=document.activeElement;
      if((!focused||focused===document.body||dialogRef.current?.contains(focused))&&previous?.isConnected)previous.focus({preventScroll:true});
    };
  },[open]);
  useEffect(()=>{
    if(open&&!isAi)document.getElementById(listId+'-'+active)?.scrollIntoView({block:'nearest'});
  },[active,listId,open,isAi]);

  function attachInput(node){
    localInput.current=node;
    if(typeof inputRef==='function')inputRef(node);
    else if(inputRef)inputRef.current=node;
  }
  function changeMode(next,focusTab=false){
    onMode?.(next);
    if(focusTab)(next==='ai'?aiTab:searchTab).current?.focus();
    else localInput.current?.focus();
  }
  function trapFocus(event){
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();onClose?.();return;
    }
    if(event.key!=='Tab')return;
    const nodes=[...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])].filter(node=>node.getClientRects().length);
    const first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&(document.activeElement===first||!dialogRef.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!dialogRef.current?.contains(document.activeElement))){event.preventDefault();first?.focus();}
  }
  function inputKey(event){
    if(event.nativeEvent.isComposing)return;
    if(!isAi&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&!event.ctrlKey&&!event.metaKey){
      if(!items.length)return;
      if((event.key==='Home'||event.key==='End')&&!event.altKey)return;
      event.preventDefault();event.stopPropagation();
      onSelect?.(event.key==='Home'?0:event.key==='End'?items.length-1:(active+(event.key==='ArrowDown'?1:-1)+items.length)%items.length);
    }else if(event.key==='Enter'){
      event.preventDefault();event.stopPropagation();
      if(isAi){if(query.trim()&&!ai.busy)onSubmit?.(query.trim());}
      else items[active]?.onClick?.();
    }
  }
  function tabKey(event){
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    changeMode(event.key==='Home'?'search':event.key==='End'?'ai':isAi?'search':'ai',true);
  }
  if(!open)return null;
  let itemIndex=-1;
  return <div className="workspace-search-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose?.();}}>
    <section className="workspace-search" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapFocus}>
      <h2 className="ai-visually-hidden" id={titleId}>Buscar ou pedir à IA</h2>
      <div className="workspace-search-toolbar">
        <div className="workspace-search-modes" role="tablist" aria-label="Modo da busca" onKeyDown={tabKey}>
          <button ref={searchTab} type="button" id={'search-tab-'+uid} role="tab" aria-selected={!isAi} aria-controls={panelId} tabIndex={isAi?-1:0} onClick={()=>changeMode('search')}><SearchIcon size={14}/><span>Buscar</span></button>
          <button ref={aiTab} type="button" id={'ai-tab-'+uid} role="tab" aria-selected={isAi} aria-controls={panelId} tabIndex={isAi?0:-1} onClick={()=>changeMode('ai')}><AiIcon size={15}/><span>Pedir à IA</span></button>
        </div>
        <div className="workspace-search-tools">
          <button type="button" className="workspace-icon-button" onClick={onSettings} aria-label="Configurar IA" title="Provedor, agente e esforço"><SettingsIcon/></button>
          <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Fechar busca" title="Fechar (Esc)"><CloseIcon/></button>
        </div>
      </div>
      <div className="workspace-search-input-row">
        <span className="workspace-input-icon">{isAi?<AiIcon size={21}/>:<SearchIcon size={21}/>}</span>
        <input ref={attachInput} value={query} onChange={event=>onQuery?.(event.target.value)} onKeyDown={inputKey} type="text" role={isAi?undefined:'combobox'} aria-label={isAi?'Pedido para a IA':'Buscar notas, grupos, sessões ou comandos'} aria-expanded={isAi?undefined:true} aria-autocomplete={isAi?undefined:'list'} aria-controls={isAi?undefined:listId} aria-activedescendant={!isAi&&items.length?listId+'-'+active:undefined} autoComplete="off" spellCheck={isAi} placeholder={isAi?'O que você quer fazer nas suas notas?':'Buscar notas, grupos, sessões ou comandos…'}/>
        {isAi?<button type="button" className="workspace-send-button" disabled={ai.busy||!query.trim()} onClick={()=>onSubmit?.(query.trim())} aria-label="Enviar pedido à IA" title="Enviar pedido (Enter)"><ArrowIcon/></button>:<kbd className="workspace-escape">esc</kbd>}
      </div>
      <div className="workspace-search-content" id={panelId} role="tabpanel" aria-labelledby={(isAi?'ai-tab-':'search-tab-')+uid}>
        {isAi?<div className="workspace-ai-content">
          {!hasAnswer&&!ai.busy?<div className="workspace-ai-welcome">
            <span className="workspace-ai-mark"><AiIcon size={26}/></span>
            <h3>Suas ideias, organizadas.</h3>
            <p>Peça para escrever ou editar notas, criar grupos e sessões ou organizar sua biblioteca.</p>
            <div className="workspace-ai-examples" aria-label="Exemplos de pedidos para a IA">{EXAMPLES.map(([label,prompt])=><button key={label} type="button" onClick={()=>{onQuery?.(prompt);localInput.current?.focus();}}><PlusIcon size={14}/><span>{label}</span><span className="workspace-example-arrow" aria-hidden="true">↗</span></button>)}</div>
          </div>:null}
          {ai.busy?<div className="workspace-ai-progress" role="status" aria-live="polite"><span className="workspace-ai-spinner" aria-hidden="true"/><div><strong>A IA está trabalhando</strong><p>{ai.progress || 'Preparando seu pedido…'}</p></div>{ai.canCancel!==false?<button type="button" onClick={onCancel}>Cancelar</button>:null}</div>:null}
          {ai.error?<div className="workspace-ai-error" role="alert"><strong>Não foi possível concluir o pedido</strong><p>{errorText(ai.error)}</p><button type="button" onClick={onSettings}><SettingsIcon size={14}/>Conferir configurações</button></div>:null}
          {ai.response?<div className="workspace-ai-response" role="region" aria-label="Resposta da IA"><div className="workspace-ai-response-label"><AiIcon size={14}/><strong>{ai.providerLabel || 'IA'}</strong></div><div className="workspace-ai-answer">{ai.response}</div></div>:null}
          {ai.changes?.length?<div className="workspace-ai-changes"><strong>Alterações na biblioteca</strong><ul>{ai.changes.map((change,index)=><li key={index}><CheckIcon/><span>{typeof change==='string'?change:change.label || change.message || 'Alteração aplicada'}</span></li>)}</ul></div>:null}
          {hasAnswer||ai.canUndo?<div className="workspace-ai-result-actions">{ai.canUndo?<button type="button" disabled={ai.busy} onClick={onUndo}><UndoIcon/>Desfazer alterações</button>:null}{hasAnswer?<button type="button" className="workspace-clear-response" disabled={ai.busy} onClick={onClear}>Limpar resposta</button>:null}</div>:null}
        </div>:<div className="workspace-search-results" id={listId} role="listbox" aria-label="Resultados da busca">
          {rows.map((row,index)=>{
            if(row.isHeader)return <div className="workspace-search-result-heading" key={'heading-'+index} role="presentation">{row.label}</div>;
            const rowIndex=++itemIndex;
            return <div className="workspace-search-result" id={listId+'-'+rowIndex} key={row.id || 'row-'+index} role="option" aria-selected={rowIndex===active} onMouseEnter={()=>{if(row.onHover)row.onHover();else onSelect?.(rowIndex);}} onClick={row.onClick}>
              <span className="workspace-result-icon" style={{color:row.iconColor}}><RowIcon row={row}/></span><span className="workspace-result-copy"><strong>{row.label}</strong>{row.sub?<small>{row.sub}</small>:null}</span>{row.kbd?<kbd>{row.kbd}</kbd>:null}
            </div>;
          })}
          {!items.length?<div className="workspace-search-empty"><SearchIcon size={24}/><strong>Nada encontrado</strong><p>Tente outro termo ou peça à IA para criar e organizar.</p><button type="button" onClick={()=>changeMode('ai')}><AiIcon size={14}/>Pedir à IA</button></div>:null}
        </div>}
      </div>
      <div className="workspace-search-footer"><span>{isAi?<><AiIcon size={12}/>{ai.providerLabel || 'CLI / ACP nesta máquina'}</>:<>{items.length} {items.length===1?'resultado':'resultados'}</>}</span><span>{isAi?<><kbd>Enter</kbd> enviar pedido</>:<><kbd>↑ ↓</kbd> navegar <kbd>Enter</kbd> abrir</>}</span></div>
    </section>
  </div>;
}

const PROVIDERS=[{id:'codex',label:'Codex CLI'},{id:'claude',label:'Claude Code'},{id:'acp',label:'Agente ACP'}];
const EFFORT_LABELS={default:'Padrão do provedor',minimal:'Mínimo',low:'Baixo',medium:'Médio',high:'Alto',xhigh:'Extra alto',max:'Máximo',ultra:'Extremo'};
const optionValue=option=>typeof option==='string'?option:String(option?.id ?? option?.value ?? option?.name ?? '');
function optionsFrom(values=[],labels={},allowEmpty=false){
  const seen=new Set();
  return values.map(item=>({id:optionValue(item),label:typeof item==='string'?(labels[item] || item):item.label || item.name || labels[optionValue(item)] || optionValue(item),description:typeof item==='object'?item.description:undefined})).filter(item=>{if((!item.id&&!allowEmpty)||seen.has(item.id))return false;seen.add(item.id);return true;});
}

/** Custom, keyboard-accessible combobox; editable variant accepts provider agent IDs. */
function AiCombobox({id,label,value,options,onChange,editable=false,searchable=false,placeholder,disabled=false}){
  const [open,setOpen]=useState(false),[active,setActive]=useState(0),[filter,setFilter]=useState('');
  const [menuLayout,setMenuLayout]=useState({side:'below',height:260});
  const root=useRef(null),control=useRef(null),search=useRef(null),listId=id+'-options';
  const query=(searchable?filter:editable?value:'').toLocaleLowerCase('pt-BR');
  const available=query?options.filter(option=>(option.label+' '+option.id).toLocaleLowerCase('pt-BR').includes(query)):options;
  const activeIndex=Math.min(active,Math.max(0,available.length-1));
  const selected=options.find(option=>option.id===value);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{if(open&&searchable){setFilter('');search.current?.focus();}},[open,searchable]);
  useEffect(()=>{
    if(!open||!searchable)return;
    const place=()=>{
      const trigger=root.current?.getBoundingClientRect(),clip=root.current?.closest('.dialog')?.getBoundingClientRect();if(!trigger)return;
      const top=Math.max(12,clip?.top||0),bottom=Math.min(innerHeight-12,clip?.bottom||innerHeight);
      const below=bottom-trigger.bottom-12,above=trigger.top-top-12,side=below<200&&above>below?'above':'below',height=Math.max(90,Math.min(260,side==='above'?above:below));
      setMenuLayout(previous=>previous.side===side&&previous.height===height?previous:{side,height});
    };
    place();window.addEventListener('resize',place);document.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);};
  },[open,searchable]);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!root.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{
    if(open)document.getElementById(listId+'-'+activeIndex)?.scrollIntoView({block:'nearest'});
  },[activeIndex,listId,open]);
  function choose(option){onChange(option.id);setOpen(false);control.current?.focus();}
  function key(event){
    if(disabled)return;
    if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);if(searchable)control.current?.focus();return;}
    if(event.key==='Tab'){setOpen(false);if(open&&searchable)control.current?.focus();return;}
    if(searchable&&event.target===search.current&&['Home','End'].includes(event.key))return;
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&(!editable||event.key==='ArrowDown'||event.key==='ArrowUp')){
      event.preventDefault();event.stopPropagation();
      if(!open){setOpen(true);setActive(Math.max(0,available.findIndex(option=>option.id===value)));}
      else setActive(index=>event.key==='Home'?0:event.key==='End'?available.length-1:Math.max(0,Math.min(available.length-1,index+(event.key==='ArrowDown'?1:-1))));
    }else if((event.key==='Enter'||(!editable&&event.target===control.current&&event.key===' '))&&open){event.preventDefault();event.stopPropagation();if(available[activeIndex])choose(available[activeIndex]);else setOpen(false);}
    else if(!editable&&event.target===control.current&&(event.key==='Enter'||event.key===' ')){event.preventDefault();event.stopPropagation();setActive(Math.max(0,available.findIndex(option=>option.id===value)));setOpen(true);}
  }
  const accessibility={id,role:'combobox','aria-label':label,'aria-expanded':open,'aria-controls':listId,'aria-haspopup':'listbox','aria-activedescendant':open&&available.length?listId+'-'+activeIndex:undefined,disabled};
  return <div className={'ai-combobox'+(open?' is-open':'')} ref={root} onKeyDown={key}>
    {editable?<div className="ai-combobox-editable"><input {...accessibility} ref={control} value={value} autoComplete="off" spellCheck={false} placeholder={placeholder} aria-autocomplete="list" onChange={event=>{onChange(event.target.value);setActive(0);setOpen(true);}}/><button type="button" tabIndex={-1} disabled={disabled} aria-label={'Mostrar opções de '+label.toLocaleLowerCase('pt-BR')} onClick={()=>{setOpen(current=>!current);control.current?.focus();}}><DropdownIcon className={open?'ai-dropdown-icon is-open':'ai-dropdown-icon'}/></button></div>:<button {...accessibility} ref={control} type="button" className="ai-combobox-trigger" onClick={()=>{setActive(Math.max(0,options.findIndex(option=>option.id===value)));setOpen(current=>!current);}}><span>{selected?.label || value || placeholder}</span><DropdownIcon className={open?'ai-dropdown-icon is-open':'ai-dropdown-icon'}/></button>}
    {open?<div className={'ai-combobox-popup'+(searchable?' is-searchable':'')} data-side={searchable?menuLayout.side:undefined}>
      {searchable?<input ref={search} className="ai-combobox-search" aria-label="Buscar modelos de IA" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={available.length?listId+'-'+activeIndex:undefined} autoComplete="off" spellCheck={false} value={filter} onChange={event=>{setFilter(event.target.value);setActive(0);}} placeholder="Buscar modelo pelo nome ou identificador…"/>:null}
      <ul className="ai-combobox-options" style={searchable?{maxHeight:Math.max(40,menuLayout.height-58)}:undefined} id={listId} role="listbox" aria-label={label}>{available.length?available.map((option,index)=><li id={listId+'-'+index} key={option.id} role="option" aria-selected={option.id===value} className={index===activeIndex?'is-active':''} onMouseEnter={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(option)}><span><strong>{option.label}</strong>{option.description?<small>{option.description}</small>:null}</span>{option.id===value?<CheckIcon/>:null}</li>):<li className="ai-combobox-no-options" role="presentation">{searchable?'Nenhum modelo corresponde à busca.':editable?'Use o identificador do seu agente.':'Nenhuma opção disponível.'}</li>}</ul>
    </div>:null}
  </div>;
}

function draftFrom(value){
  return {provider:PROVIDERS.some(provider=>provider.id===value?.provider)?value.provider:'codex',command:value?.command || '',argsText:Array.isArray(value?.args)?value.args.join('\n'):'',model:value?.model || '',agent:value?.agent || '',effort:value?.effort || 'default'};
}

const settingsFromDraft=draft=>({provider:draft.provider,command:draft.command.trim(),args:draft.argsText.split(/\r?\n/).filter(line=>line.trim().length),model:draft.model.trim(),agent:draft.agent.trim(),effort:draft.effort});
const discoveryIdentity=draft=>JSON.stringify([draft.provider,draft.command.trim(),draft.argsText.split(/\r?\n/).filter(line=>line.trim().length),draft.provider==='acp'?draft.agent.trim():'',draft.provider==='acp'?draft.model.trim():'']);

/** Device-local provider configuration. Discovery only requests model metadata. */
export function AiSettings({value,status,discovery,busy=false,onSave,onDiscover}){
  const settingsKey=JSON.stringify(value || {});
  const [draft,setDraft]=useState(()=>draftFrom(value)),[saving,setSaving]=useState(false),[advanced,setAdvanced]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  const [catalog,setCatalog]=useState(null),[discovering,setDiscovering]=useState(false),[catalogError,setCatalogError]=useState('');
  const requestId=useRef(0);
  const currentDraft=useRef(draft);currentDraft.current=draft;
  const uid=useId().replace(/:/g,''),headingId='ai-settings-title-'+uid;
  useEffect(()=>{requestId.current++;setDiscovering(false);const incoming=draftFrom(value);if(discoveryIdentity(incoming)!==discoveryIdentity(currentDraft.current))setCatalog({providers:[]});setDraft(incoming);setError('');},[settingsKey]);
  const providers=catalog?.providers || (Array.isArray(discovery?.providers)&&discovery.providers.length?discovery.providers:Array.isArray(status?.providers)?status.providers:[]);
  const current=providers.find(provider=>provider.id===draft.provider);
  const announcedModels=current?.models || [];
  const models=optionsFrom([{value:'',label:'Padrão do provedor',description:'Usar o modelo padrão do CLI.'},...announcedModels],{},true);
  if(draft.model&&!models.some(option=>option.id===draft.model))models.push({id:draft.model,label:draft.model,description:'Identificador personalizado'});
  const selectedModel=announcedModels.find(model=>optionValue(model)===draft.model)||(!draft.model?announcedModels.find(model=>model.isDefault):null);
  const providerOptions=PROVIDERS.map(provider=>({...provider,label:providers.find(item=>item.id===provider.id)?.label || provider.label,description:providers.find(item=>item.id===provider.id)?.available?'CLI encontrado':provider.id==='acp'?'Conecte um agente compatível com ACP':undefined}));
  const availableEfforts=selectedModel?.supportedEfforts || current?.efforts || [];
  const efforts=optionsFrom(['default',...availableEfforts,...(draft.effort!=='default'&&!availableEfforts.length?[draft.effort]:[])],EFFORT_LABELS);
  const agents=optionsFrom(current?.agents || [],{'':'Padrão do provedor'},true);
  const locked=busy||saving;
  const discoveredError=discovery?.error || status?.lastError || status?.error;
  useEffect(()=>{
    refresh(draft);
    return()=>{requestId.current++;};
  },[draft.provider]);
  async function refresh(candidate=draft){
    const request=++requestId.current;
    if(typeof onDiscover!=='function'||(candidate.provider==='acp'&&!candidate.command.trim())){setDiscovering(false);return;}
    setDiscovering(true);setCatalogError('');
    try{
      const result=await onDiscover(settingsFromDraft(candidate));
      if(requestId.current===request&&discoveryIdentity(candidate)===discoveryIdentity(currentDraft.current)){
        setCatalog(result);
        const provider=result?.providers?.find(item=>item.id===candidate.provider),model=provider?.models?.find(item=>optionValue(item)===candidate.model),supported=model?.supportedEfforts||provider?.efforts||[];
        if(candidate.effort!=='default'&&supported.length&&!supported.map(optionValue).includes(candidate.effort))setDraft(previous=>({...previous,effort:'default'}));
      }
    }
    catch(failure){if(requestId.current===request)setCatalogError(errorText(failure));}
    finally{if(requestId.current===request)setDiscovering(false);}
  }
  function update(field,next){
    if(['command','argsText'].includes(field)||(draft.provider==='acp'&&['agent','model'].includes(field))){requestId.current++;setDiscovering(false);setCatalog({providers:[]});setCatalogError('');}
    setDraft(previous=>({...previous,[field]:next}));setSaved(false);setError('');
  }
  function chooseModel(model){
    const nextModel=announcedModels.find(item=>optionValue(item)===model)||(!model?announcedModels.find(item=>item.isDefault):null);
    const supported=nextModel?.supportedEfforts || current?.efforts || [];
    const next={...draft,model,effort:supported.map(optionValue).includes(draft.effort)?draft.effort:'default'};
    setDraft(next);setSaved(false);setError('');
    if(next.provider==='acp')refresh(next);
  }
  function chooseProvider(next){
    requestId.current++;setDiscovering(false);setCatalogError('');
    setDraft(previous=>({...previous,provider:next,command:'',argsText:'',agent:'',model:'',effort:'default'}));setSaved(false);setError('');
  }
  async function save(event){
    event.preventDefault();
    if(locked)return;
    if(draft.provider==='acp'&&!draft.command.trim()&&!current?.command){setError('Informe o executável do agente ACP ou detecte um agente disponível.');setAdvanced(true);return;}
    if(!efforts.some(option=>option.id===draft.effort)){setError('Escolha um esforço disponível para este provedor.');return;}
    const next=settingsFromDraft(draft);
    setSaving(true);setError('');setSaved(false);
    try{await onSave?.(next);setSaved(true);}
    catch(failure){setError(errorText(failure));}
    finally{setSaving(false);}
  }
  return <section className="ai-settings" id="settings-ai" tabIndex={-1} aria-labelledby={headingId}>
    <div className="ai-settings-heading"><span className="ai-settings-mark"><AiIcon size={21}/></span><div><h2 id={headingId}>Inteligência artificial</h2><p>Seu agente, dentro do notes.</p></div></div>
    <p className="ai-settings-intro">Use um CLI já configurado para criar, editar e organizar sua biblioteca pela busca central.</p>
    <form onSubmit={save}>
      <div className="ai-settings-grid">
        <div className="ai-settings-field"><label htmlFor={'ai-provider-'+uid}>Provedor</label><AiCombobox id={'ai-provider-'+uid} label="Provedor de IA" value={draft.provider} options={providerOptions} onChange={chooseProvider} disabled={locked}/></div>
        <div className="ai-settings-field"><label htmlFor={'ai-agent-'+uid}>{draft.provider==='acp'?'Agente / modo':'Agente'}</label><AiCombobox id={'ai-agent-'+uid} label="Agente de IA" value={draft.agent} options={agents} onChange={next=>update('agent',next)} editable placeholder="Padrão do provedor" disabled={locked||draft.provider==='codex'}/><small>{draft.provider==='codex'?'Codex usa seu agente padrão. Escolha o modelo abaixo.':agents.some(agent=>agent.id)?'Escolha um agente anunciado pelo provedor ou informe seu identificador.':'Deixe vazio para usar o agente padrão.'}</small></div>
        <div className="ai-settings-field ai-model-field"><div className="ai-model-label"><label htmlFor={'ai-model-'+uid}>Modelo</label><button type="button" onClick={()=>refresh()} disabled={locked||discovering} title="Atualizar a lista de modelos do provedor"><RefreshIcon/>{discovering?'Carregando…':'Atualizar modelos'}</button></div><AiCombobox id={'ai-model-'+uid} label="Modelo de IA" value={draft.model} options={models} onChange={chooseModel} searchable disabled={locked} placeholder="Padrão do provedor"/><small role="status">{discovering?'Consultando o catálogo do provedor, sem gerar conteúdo…':catalogError || current?.modelWarning || (announcedModels.length?announcedModels.length+' modelos · '+(current?.modelsSource==='provider-aliases'?'aliases oficiais do provedor':'catálogo do CLI'):'Nenhum catálogo carregado. Atualize os modelos ou informe o executável em Avançado.')}</small></div>
        <div className="ai-settings-field"><label htmlFor={'ai-effort-'+uid}>Esforço</label><AiCombobox id={'ai-effort-'+uid} label="Esforço da IA" value={draft.effort} options={efforts} onChange={next=>update('effort',next)} disabled={locked}/><small>{efforts.length>1?'Quanto o agente deve raciocinar sobre o pedido.':'As opções disponíveis dependem do provedor e do modelo.'}</small></div>
        <div className="ai-settings-detection"><span className={'ai-cli-indicator'+(current?.available?' is-available':'')} aria-hidden="true"/><div><strong>{current?.available?'CLI encontrado':current?.available===false?'CLI não encontrado':'Detectar provedores locais'}</strong><small>{current?.version || (current?.available===false?'Informe um executável ou revise a instalação existente.':'A lista é carregada sem iniciar uma conversa.')}</small></div></div>
      </div>
      <button type="button" className="ai-settings-advanced-trigger" aria-expanded={advanced} aria-controls={'ai-advanced-'+uid} onClick={()=>setAdvanced(current=>!current)}>Configuração avançada<DropdownIcon className={advanced?'ai-dropdown-icon is-open':'ai-dropdown-icon'}/></button>
      {advanced?<div className="ai-settings-advanced" id={'ai-advanced-'+uid}>
        <div className="ai-settings-field"><label htmlFor={'ai-command-'+uid}>Executável {draft.provider==='acp'?'do agente ACP':'do CLI'}</label><input id={'ai-command-'+uid} type="text" value={draft.command} onChange={event=>update('command',event.target.value)} disabled={locked} autoComplete="off" spellCheck={false} placeholder={current?.command || (draft.provider==='acp'?'C:\\caminho\\agente.exe':'Padrão detectado no sistema')}/><small>Um executável ou caminho, sem comandos de shell.</small></div>
        {draft.provider==='acp'?<div className="ai-settings-field"><label htmlFor={'ai-args-'+uid}>Argumentos do agente ACP</label><textarea id={'ai-args-'+uid} value={draft.argsText} onChange={event=>update('argsText',event.target.value)} disabled={locked} rows={3} autoComplete="off" spellCheck={false} placeholder="Um argumento por linha"/><small>Cada linha é um argumento separado. Use os argumentos ACP documentados pelo seu agente.</small></div>:null}
        <div className="ai-settings-field"><label htmlFor={'ai-custom-model-'+uid}>Identificador de modelo personalizado</label><input id={'ai-custom-model-'+uid} type="text" value={draft.model} onChange={event=>update('model',event.target.value)} disabled={locked} autoComplete="off" spellCheck={false} placeholder="Opcional: modelo que não aparece no catálogo"/><small>Use um identificador aceito pelo CLI. Para modelos do catálogo, use a lista acima.</small></div>
      </div>:null}
      <div className="ai-settings-privacy"><SettingsIcon size={14}/><p>O CLI roda na sua máquina. O modelo pode usar a nuvem do provedor. Estas configurações ficam neste computador e não vão para o Git.</p></div>
      {(error||discoveredError)?<p className="ai-settings-error" role="alert">{error || errorText(discoveredError)}</p>:null}
      {saved?<p className="ai-settings-saved" role="status"><CheckIcon/>Configurações de IA salvas nesta máquina.</p>:null}
      <div className="ai-settings-actions"><span>{saving?'Salvando…':'Usa a autenticação do seu CLI.'}</span><button className="primary" type="submit" disabled={locked}>{saving?'Salvando…':'Salvar IA'}</button></div>
    </form>
  </section>;
}
