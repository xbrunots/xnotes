import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {invokeContextAction} from './context-actions';
import {PlusIcon} from './controls';

const enabled=items=>items.map((item,index)=>!item.separator&&!item.disabled?index:-1).filter(index=>index>=0);
const normalized=value=>value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const Check=()=> <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m3.5 9 3.5 3.5 7.5-8"/></svg>;
const Chevron=()=> <svg width="12" height="12" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6.5 4 5 5-5 5"/></svg>;

/** Fully custom, portalled menu. Nested menus fit the current viewport and never
 * depend on browser menus or native form widgets. */
export function ContextMenu({items,x,y,onClose,style,label='Opções'}) {
  const container=useRef(null),panels=useRef([]),rows=useRef([]),previousFocus=useRef(document.activeElement),typed=useRef({text:'',at:0});
  const [path,setPath]=useState([]),[active,setActive]=useState([enabled(items)[0] ?? -1]),[depth,setDepth]=useState(0),[positions,setPositions]=useState([]);
  const levels=[{items,label}];
  for(let index=0;index<path.length;index++) {
    const parent=levels[index]?.items[path[index]];
    if(!parent?.children?.length||parent.disabled)break;
    levels.push({items:parent.children,label:parent.label});
  }
  useEffect(()=>{
    const dismiss=event=>{if(!container.current?.contains(event.target))onClose();};
    const scroll=event=>{if(!container.current?.contains(event.target))onClose();};
    document.addEventListener('pointerdown',dismiss,true);
    document.addEventListener('scroll',scroll,true);
    window.addEventListener('resize',onClose);window.addEventListener('blur',onClose);
    return ()=>{
      const returnFocus=container.current?.contains(document.activeElement)||document.activeElement===document.body;
      document.removeEventListener('pointerdown',dismiss,true);document.removeEventListener('scroll',scroll,true);
      window.removeEventListener('resize',onClose);window.removeEventListener('blur',onClose);
      if(returnFocus&&previousFocus.current?.isConnected)previousFocus.current.focus({preventScroll:true});
    };
  },[]);
  useLayoutEffect(()=>{
    const result=[],margin=8,width=window.innerWidth,height=window.innerHeight;
    levels.forEach((_level,index)=>{
      const panel=panels.current[index];if(!panel)return;
      const bounds=panel.getBoundingClientRect();let left=x,top=y;
      if(index) {
        const parent=rows.current[index-1]?.[path[index-1]]?.getBoundingClientRect();
        const parentPanel=panels.current[index-1]?.getBoundingClientRect();
        if(parent&&parentPanel){left=parentPanel.right+3;if(left+bounds.width>width-margin)left=parentPanel.left-bounds.width-3;top=parent.top-6;}
      }
      left=Math.max(margin,Math.min(left,width-bounds.width-margin));top=Math.max(margin,Math.min(top,height-bounds.height-margin));
      result.push({left,top});
      // Later submenus must measure their parent's final, clamped position.
      panel.style.left=`${left}px`;panel.style.top=`${top}px`;
    });
    setPositions(previous=>JSON.stringify(previous)===JSON.stringify(result)?previous:result);
  },[path,x,y,items]);
  useLayoutEffect(()=>{const row=rows.current[depth]?.[active[depth]];row?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest',inline:'nearest'});},[depth,active,positions]);

  const highlight=(level,index,open=false)=>{
    const entry=levels[level].items[index];if(entry.disabled)return;
    const hasChild=open&&entry.children?.length;
    if(depth===level&&active[level]===index&&path.length===(hasChild?level+1:level)&&(!hasChild||path[level]===index))return;
    setActive(previous=>{const next=previous.slice(0,level+1);next[level]=index;return next;});setDepth(level);
    if(open&&entry.children?.length)setPath(previous=>[...previous.slice(0,level),index]);
    else setPath(previous=>previous.slice(0,level));
  };
  const openChild=(level,index,focus=true)=>{
    const entry=levels[level].items[index];if(entry.disabled||!entry.children?.length)return;
    setPath(previous=>[...previous.slice(0,level),index]);
    if(focus){setActive(previous=>{const next=previous.slice(0,level+1);next[level]=index;next[level+1]=enabled(entry.children)[0] ?? -1;return next;});setDepth(level+1);}
  };
  const choose=(level,index)=>{
    const entry=levels[level].items[index];if(!entry||entry.disabled||entry.separator)return;
    if(entry.children?.length){openChild(level,index);return;}
    onClose();entry.action?.();
  };
  const onKey=(event,level)=>{
    event.stopPropagation();
    const choices=enabled(levels[level].items),position=choices.indexOf(active[level]);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();const index=event.key==='Home'?choices[0]:event.key==='End'?choices.at(-1):choices[(position+(event.key==='ArrowUp'?-1:1)+choices.length)%choices.length];
      if(index!==undefined)highlight(level,index);
    } else if(event.key==='ArrowRight'){event.preventDefault();openChild(level,active[level]);}
    else if(event.key==='ArrowLeft'||event.key==='Escape') {
      event.preventDefault();if(level){setPath(previous=>previous.slice(0,level-1));setDepth(level-1);setActive(previous=>previous.slice(0,level));}else if(event.key==='Escape')onClose();
    } else if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(level,active[level]);}
    else if(event.key==='Tab'){event.preventDefault();onClose();}
    else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey) {
      const now=Date.now(),character=normalized(event.key),prior=now-typed.current.at<650?typed.current.text:'';
      const query=prior===character?character:prior+character;typed.current={text:query,at:now};
      const ordered=[...choices.filter(index=>index>active[level]),...choices.filter(index=>index<=active[level])];
      const found=ordered.find(index=>normalized(levels[level].items[index].label).startsWith(query));
      if(found!==undefined){event.preventDefault();highlight(level,found);}
    }
  };
  return createPortal(<div className="notes-context-layer" ref={container} style={style} onContextMenu={event=>event.preventDefault()}>
    {levels.map((level,index)=><div key={index} ref={node=>{panels.current[index]=node;}} className="notes-context-menu" role="menu" aria-label={level.label} onKeyDown={event=>onKey(event,index)} style={{left:positions[index]?.left ?? x,top:positions[index]?.top ?? y,visibility:index&&!positions[index]?'hidden':undefined}}>
      {!index&&<div className="notes-context-heading" aria-hidden="true">{label}</div>}
      {level.items.map((entry,itemIndex)=>entry.separator?<div role="separator" className="notes-context-separator" key={`separator-${itemIndex}`}/>:<button key={`${entry.id}-${itemIndex}`} ref={node=>{if(!rows.current[index])rows.current[index]=[];rows.current[index][itemIndex]=node;}}
        type="button" role={'checked' in entry?'menuitemcheckbox':'menuitem'} aria-checked={'checked' in entry?entry.checked:undefined} aria-haspopup={entry.children?.length?'menu':undefined} aria-expanded={entry.children?.length?path[index]===itemIndex:undefined}
        disabled={entry.disabled} tabIndex={depth===index&&active[index]===itemIndex?0:-1} className={'notes-context-item'+(entry.danger?' danger':'')+(active[index]===itemIndex?' active':'')}
        onPointerMove={()=>highlight(index,itemIndex,!!entry.children?.length)} onClick={()=>choose(index,itemIndex)}>
        <span className="notes-context-symbol">{entry.color?<i style={{background:entry.color}}/>:entry.checked?<Check/>:/^(session-create|session-new-note|group-create|group-new)$/.test(entry.id)?<PlusIcon size={14}/>:null}</span><span className="notes-context-label">{entry.label}</span>
        {entry.color&&entry.checked&&<Check/>}{entry.children?.length?<Chevron/>:null}
      </button>)}
    </div>)}
  </div>,document.body);
}

/** The caller supplies its existing Modal, preserving the application's focus
 * trap and visual language without introducing another dialog framework. */
export function ContextActionDialog({host,Modal}) {
  const dialog=host.state.contextDialog,input=useRef(null);
  useEffect(()=>{if(dialog?.mode==='name'){input.current?.focus();input.current?.select();}},[dialog?.action,dialog?.payload?.id]);
  if(!dialog)return null;
  const close=()=>host.setState({contextDialog:null});
  const submit=event=>{
    event.preventDefault();if(dialog.mode==='name'&&!dialog.value.trim())return;
    close();invokeContextAction(host,dialog.action,{...dialog.payload,...(dialog.mode==='name'?{name:dialog.value}: {})});
  };
  return <Modal title={dialog.title} onClose={close}><form className="context-action-form" onSubmit={submit}>
    {dialog.description&&<p>{dialog.description}</p>}
    {dialog.mode==='name'&&<><label className="form-label" htmlFor="context-action-name">{dialog.label}</label><input ref={input} id="context-action-name" className="text-input" autoComplete="off" maxLength={500} value={dialog.value} onChange={event=>host.setState({contextDialog:{...dialog,value:event.target.value}})}/></>}
    <footer><button type="button" onClick={close}>Cancelar</button><button type="submit" aria-label={dialog.action==='session-create'?'Criar sessão':undefined} title={dialog.action==='session-create'?'Criar sessão':undefined} className={dialog.danger?'context-confirm-danger':'primary'} disabled={dialog.mode==='name'&&!dialog.value.trim()}>{dialog.action==='session-create'?<PlusIcon/>:dialog.confirmLabel || 'Salvar'}</button></footer>
  </form></Modal>;
}
