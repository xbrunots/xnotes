import React,{useEffect,useRef,useState} from 'react';
import {clampPanelSize} from './panel-sizing';

/** A fully styled, controlled separator. onChange previews at most once per
 * frame; onCommit persists only after pointer/key release or double-click reset.
 * Escape/cancel restores the initial value and optionally invokes onCancel. */
export function ResizeHandle({value,getValue,min,max,defaultValue,onChange,onCommit,onCancel,axis='x',invert=false,label,className='',style,id,controls}) {
  const lower=Number.isFinite(min)?min:0,upper=Number.isFinite(max)?Math.max(lower,max):lower;
  const current=clampPanelSize(value,lower,upper,defaultValue);
  const [visual,setVisual]=useState(current),[dragging,setDragging]=useState(false);
  const element=useRef(null),session=useRef(null),latest=useRef(null),mounted=useRef(false);
  latest.current={value:current,getValue,min:lower,max:upper,defaultValue,onChange,onCommit,onCancel,axis,invert};
  const bounded=next=>clampPanelSize(next,latest.current.min,latest.current.max,latest.current.value);
  const readValue=()=>{try{return bounded(latest.current.getValue?.() ?? latest.current.value);}catch{return latest.current.value;}};
  const publish=(active,next)=>{
    const size=bounded(next);active.currentValue=size;
    if(mounted.current)setVisual(size);
    if(active.lastPublished!==size){active.lastPublished=size;latest.current.onChange?.(size);}
  };
  const queue=(active,next)=>{
    active.currentValue=bounded(next);
    if(active.frame!==null)return;
    active.frame=requestAnimationFrame(()=>{active.frame=null;if(session.current===active)publish(active,active.currentValue);});
  };
  const restoreDocument=active=>{
    if(active.cleanup)active.cleanup();
    if(active.frame!==null){cancelAnimationFrame(active.frame);active.frame=null;}
    if(active.documentStyle){
      const {body,root,bodyCursor,rootCursor,userSelect,marker}=active.documentStyle;
      body.style.cursor=bodyCursor;root.style.cursor=rootCursor;body.style.userSelect=userSelect;
      if(marker===null)root.removeAttribute('data-panel-resizing');else root.setAttribute('data-panel-resizing',marker);
    }
    try{if(active.handle?.hasPointerCapture?.(active.pointerId))active.handle.releasePointerCapture(active.pointerId);}catch{}
  };
  const finish=(commit,notify=true,reason='pointer')=>{
    const active=session.current;if(!active)return;
    session.current=null;restoreDocument(active);
    const next=bounded(commit?active.currentValue:active.startValue);
    if(mounted.current){setDragging(false);setVisual(next);}
    if(!notify)return;
    if(commit){
      if(active.lastPublished!==next)latest.current.onChange?.(next);
      if(next!==active.startValue)latest.current.onCommit?.(next,{reason});
    } else {
      latest.current.onChange?.(next);
      latest.current.onCancel?.();
    }
  };
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;finish(false);};
  },[]);
  useEffect(()=>{if(!session.current)setVisual(current);},[current]);

  const pointerDown=event=>{
    event.preventDefault();event.stopPropagation();
    if(event.button!==0||event.isPrimary===false||lower===upper)return;
    if(session.current)finish(false);
    const handle=event.currentTarget;handle.focus({preventScroll:true});
    const coordinate=axis==='y'?event.clientY:event.clientX;
    const initial=readValue(),active={kind:'pointer',pointerId:event.pointerId,handle,startCoordinate:coordinate,startValue:initial,currentValue:initial,lastPublished:initial,frame:null};
    session.current=active;setVisual(initial);setDragging(true);
    const body=document.body,root=document.documentElement;
    active.documentStyle={body,root,bodyCursor:body.style.cursor,rootCursor:root.style.cursor,userSelect:body.style.userSelect,marker:root.getAttribute('data-panel-resizing')};
    const cursor=axis==='y'?'row-resize':'col-resize';body.style.cursor=cursor;root.style.cursor=cursor;body.style.userSelect='none';root.setAttribute('data-panel-resizing',axis);
    const move=pointer=>{
      if(pointer.pointerId!==active.pointerId||session.current!==active)return;
      pointer.preventDefault();pointer.stopPropagation();
      const coordinate=latest.current.axis==='y'?pointer.clientY:pointer.clientX;
      queue(active,active.startValue+(coordinate-active.startCoordinate)*(latest.current.invert?-1:1));
    };
    const up=pointer=>{if(pointer.pointerId!==active.pointerId)return;pointer.preventDefault();pointer.stopPropagation();move(pointer);finish(true);};
    const cancel=pointer=>{if(pointer.pointerId!==active.pointerId)return;pointer.preventDefault();pointer.stopPropagation();finish(false);};
    const escape=key=>{if(key.key==='Escape'){key.preventDefault();key.stopPropagation();finish(false);}};
    const blur=()=>finish(false);
    document.addEventListener('pointermove',move,{capture:true,passive:false});document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancel,true);document.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);
    active.cleanup=()=>{document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);};
    try{handle.setPointerCapture(event.pointerId);}catch{}
  };
  const keyDown=event=>{
    if(event.key==='Escape'&&session.current){event.preventDefault();event.stopPropagation();finish(false);return;}
    const negative=axis==='y'?'ArrowUp':'ArrowLeft',positive=axis==='y'?'ArrowDown':'ArrowRight';
    if(![negative,positive,'Home','End'].includes(event.key)||event.ctrlKey||event.metaKey||event.altKey)return;
    event.preventDefault();event.stopPropagation();if(lower===upper)return;
    if(session.current?.kind==='pointer')return;
    if(!session.current){const initial=readValue();session.current={kind:'keyboard',startValue:initial,currentValue:initial,lastPublished:initial,frame:null};}
    const active=session.current,delta=(event.key===negative?-1:1)*(event.shiftKey?10:1)*(invert?-1:1);
    publish(active,event.key==='Home'?lower:event.key==='End'?upper:active.currentValue+delta);
  };
  const keyUp=event=>{
    if(session.current?.kind==='keyboard'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();finish(true,true,'keyboard');}
  };
  const reset=event=>{
    event.preventDefault();event.stopPropagation();if(session.current)finish(false);
    const next=bounded(defaultValue);
    if(next!==readValue()){setVisual(next);onChange?.(next);onCommit?.(next,{reason:'reset'});}
  };
  const stop=event=>{event.preventDefault();event.stopPropagation();};
  return <div ref={element} id={id} className={'panel-resize-handle panel-resize-'+axis+(dragging?' is-resizing':'')+(className?' '+className:'')} style={style} role="separator" tabIndex={lower===upper?-1:0} aria-orientation={axis==='y'?'horizontal':'vertical'} aria-label={label || (axis==='y'?'Redimensionar altura do painel':'Redimensionar largura do painel')} aria-valuemin={lower} aria-valuemax={upper} aria-valuenow={bounded(visual)} aria-valuetext={bounded(visual)+' pixels'} aria-controls={controls} aria-disabled={lower===upper || undefined} data-resize-axis={axis} draggable={false} onPointerDown={pointerDown} onLostPointerCapture={()=>{if(session.current?.kind==='pointer')finish(false);}} onKeyDown={keyDown} onKeyUp={keyUp} onBlur={()=>{if(session.current?.kind==='keyboard')finish(true,true,'keyboard');}} onDoubleClick={reset} onClick={stop} onMouseDown={stop} onDragStart={stop} onContextMenu={stop}><span aria-hidden="true"/></div>;
}
