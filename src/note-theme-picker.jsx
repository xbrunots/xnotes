import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {autoUpdate,computePosition,flip,offset,shift} from '@floating-ui/dom';
import {NOTE_THEMES,noteThemeVariables,resolveNoteTheme} from './note-themes';

export function NoteThemePicker({value,onChange}){
  const buttons=useRef([]);
  const move=(event,index)=>{
    let target;
    if(event.key==='ArrowRight')target=(index+1)%20;
    else if(event.key==='ArrowLeft')target=(index+19)%20;
    else if(event.key==='ArrowDown')target=(index+5)%20;
    else if(event.key==='ArrowUp')target=(index+15)%20;
    else if(event.key==='Home')target=0;
    else if(event.key==='End')target=19;
    if(target===undefined)return;event.preventDefault();event.stopPropagation();buttons.current[target]?.focus();onChange(NOTE_THEMES[target].id);
  };
  return <div className="note-theme-grid" role="radiogroup" aria-label="20 temas da nota">{NOTE_THEMES.map((theme,index)=><button key={theme.id} ref={element=>{buttons.current[index]=element;}} type="button" role="radio" aria-checked={value===theme.id} aria-label={theme.name} title={theme.name} tabIndex={value===theme.id||(!value&&index===0)?0:-1} style={noteThemeVariables(theme.id)} className="note-theme-swatch" onKeyDown={event=>move(event,index)} onClick={()=>onChange(theme.id)}><span className="note-theme-sample" aria-hidden="true">Aa<span/><span/></span><span className="note-theme-name">{theme.name}</span>{value===theme.id&&<svg className="note-theme-check" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>}</button>)}</div>;
}

function NoteThemePopover({id,trigger,value,onChange,onClose,variables}){
  const panel=useRef(null),current=useRef({onClose});
  const [position,setPosition]=useState(null);
  current.current={onClose};
  useLayoutEffect(()=>{
    const anchor=trigger.current,element=panel.current;if(!anchor||!element)return;
    let disposed=false;
    const update=()=>computePosition(anchor,element,{strategy:'fixed',placement:'bottom-end',middleware:[offset(8),flip({padding:10}),shift({padding:10,crossAxis:true})]}).then(({x,y})=>{if(!disposed)setPosition(previous=>previous?.left===x&&previous?.top===y?previous:{left:x,top:y});});
    const stop=autoUpdate(anchor,element,update,{animationFrame:true});
    return()=>{disposed=true;stop();if(element.contains(document.activeElement)&&anchor.isConnected)anchor.focus({preventScroll:true});};
  },[trigger]);
  const positioned=!!position;
  useEffect(()=>{if(positioned)panel.current?.querySelector('[aria-checked="true"],[role="radio"][tabindex="0"]')?.focus({preventScroll:true});},[positioned]);
  useEffect(()=>{
    const outside=event=>{if(!panel.current?.contains(event.target)&&!trigger.current?.contains(event.target))current.current.onClose();};
    const key=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();trigger.current?.focus({preventScroll:true});current.current.onClose();}
      else if((event.ctrlKey||event.metaKey)&&['k',','].includes(event.key.toLowerCase()))current.current.onClose();
    };
    const scroll=event=>{if(!panel.current?.contains(event.target))current.current.onClose();};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('focusin',outside);document.addEventListener('keydown',key,true);document.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',key,true);document.removeEventListener('scroll',scroll,true);};
  },[trigger]);
  return createPortal(<section id={id} ref={panel} className="note-theme-popover" role="dialog" aria-label="Cor e tema da nota" style={{...variables,...position,visibility:position?'visible':'hidden'}} onMouseDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onContextMenu={event=>{event.preventDefault();event.stopPropagation();}}>
    <header><span><strong>Cor da nota</strong><small>20 estilos</small></span><button type="button" className="note-theme-close" aria-label="Fechar paleta" onClick={onClose}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
    <NoteThemePicker value={value} onChange={onChange}/>
    <footer><button type="button" disabled={!value} onClick={()=>onChange(null)}>Usar tema do aplicativo</button></footer>
  </section>,document.body);
}

export function NoteThemeControl({value,open,onToggle,onClose,onChange,variables}){
  const trigger=useRef(null),popoverId=useId(),theme=resolveNoteTheme(value);
  return <><button type="button" ref={trigger} className="note-theme-trigger" aria-label="Cor e tema da nota" title={'Cor da nota: '+(theme?.name || 'tema do aplicativo')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?popoverId:undefined} style={{'--note-chip-color':theme?.background || 'var(--glass-strong)'}} onMouseDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onToggle();}}><span aria-hidden="true"/></button>{open&&<NoteThemePopover id={popoverId} trigger={trigger} value={value} onChange={onChange} onClose={onClose} variables={variables}/>}</>;
}
