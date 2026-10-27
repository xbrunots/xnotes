import React,{useId,useRef,useState} from 'react';
import {WORKSPACE_DRAG_MIME,readWorkspaceDrag,writeWorkspaceDrag} from './organize-workspace';

const Check=()=> <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>;
const Close=()=> <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>;
const Display=({split})=> <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/>{split&&<path d="M12 4v16"/>}</svg>;
const Grid=()=> <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="10" rx="1.5"/><rect x="14" y="3" width="7" height="6" rx="1.5"/><rect x="3" y="17" width="7" height="4" rx="1.5"/><rect x="14" y="13" width="7" height="8" rx="1.5"/></svg>;

export function WorkspaceDragHandle(){return <span className="workspace-drag-handle" aria-hidden="true"><svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="3" r=".8"/><circle cx="6" cy="3" r=".8"/><circle cx="2" cy="7" r=".8"/><circle cx="6" cy="7" r=".8"/><circle cx="2" cy="11" r=".8"/><circle cx="6" cy="11" r=".8"/></svg></span>;}

/** Appearance is persisted as standard/islands independently of editor display. */
export function LayoutPicker({value='standard',onChange}) {
  const id=useId(),buttons=useRef([]),selected=value==='islands'?'islands':'standard';
  const options=[{id:'standard',label:'Padrão',description:'Painéis contínuos.'},{id:'islands',label:'Ilha',description:'Painéis separados.'}];
  const key=(event,index)=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?1:1-index;
    onChange(options[next].id);buttons.current[next]?.focus();
  };
  return <section className="layout-picker" aria-labelledby={id+'-heading'}><div className="layout-picker-heading"><strong id={id+'-heading'}>Aparência</strong></div><div className="layout-picker-options" role="radiogroup" aria-label="Aparência da área de trabalho">{options.map((option,index)=><button key={option.id} ref={node=>{buttons.current[index]=node;}} type="button" role="radio" aria-label={option.label} aria-checked={selected===option.id} aria-describedby={id+'-'+option.id} tabIndex={selected===option.id?0:-1} className={'layout-option'+(selected===option.id?' selected':'')} data-layout-option={option.id} onClick={()=>onChange(option.id)} onKeyDown={event=>key(event,index)}><span className={'layout-preview '+option.id} aria-hidden="true"><span className="layout-preview-sidebar"><i/><i/><i/></span><span className="layout-preview-list"><i/><i/><i/></span><span className="layout-preview-editor"><b/><i/><i/><i/></span>{selected===option.id&&<span className="layout-preview-check"><Check/></span>}</span><span className="layout-option-copy"><strong>{option.label}</strong><small id={id+'-'+option.id}>{option.description}</small></span></button>)}</div></section>;
}

/** Tabs only navigate existing editors; they never render note content. display
 * uses single/split. Panel IDs are workspace-pane-ID; label IDs workspace-tab-ID. */
export function WorkspaceTabs({tabs=[],activeId,display='single',onFocus,onClose,onDisplay,onReorder}) {
  const buttons=useRef(new Map()),dragging=useRef(null),[drop,setDrop]=useState(null);
  const selected=tabs.some(tab=>tab.id===activeId)?activeId:tabs[0]?.id;
  if(!tabs.length)return null;
  const activate=id=>{onFocus(id);buttons.current.get(id)?.focus({preventScroll:true});};
  const key=(event,index)=>{
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;activate(tabs[next].id);
    } else if(event.key==='Delete'){event.preventDefault();event.stopPropagation();close(tabs[index].id);}
  };
  const close=id=>{
    const index=tabs.findIndex(tab=>tab.id===id),next=tabs[index+1] || tabs[index-1];onClose(id);
    if(next)requestAnimationFrame(()=>buttons.current.get(next.id)?.focus({preventScroll:true}));
  };
  const dragPosition=event=>event.clientX<event.currentTarget.getBoundingClientRect().left+event.currentTarget.getBoundingClientRect().width/2?'before':'after';
  const hasDrag=event=>dragging.current?.kind==='tab'||Array.from(event.dataTransfer?.types || []).includes(WORKSPACE_DRAG_MIME);
  return <div className="workspace-tabs"><div role="tablist" aria-label="Notas abertas" className="workspace-tablist">{tabs.map((tab,index)=><div key={tab.id} className={'workspace-tab'+(tab.id===selected?' active':'')} data-workspace-tab={tab.id} data-drop-target={drop?.id===tab.id?drop.position:undefined} onDragOver={event=>{if(!hasDrag(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';setDrop({id:tab.id,position:dragPosition(event)});}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setDrop(null);}} onDrop={event=>{if(!hasDrag(event))return;event.preventDefault();event.stopPropagation();const source=readWorkspaceDrag(event.dataTransfer) || dragging.current,position=dragPosition(event);setDrop(null);dragging.current=null;if(source?.kind==='tab')onReorder?.(source,{kind:'tab',id:tab.id},position);}}>
    <button ref={node=>{if(node)buttons.current.set(tab.id,node);else buttons.current.delete(tab.id);}} id={'workspace-tab-'+tab.id} type="button" role="tab" aria-selected={tab.id===selected} aria-controls={'workspace-pane-'+tab.id} tabIndex={tab.id===selected?0:-1} className="workspace-tab-button" onClick={()=>onFocus(tab.id)} onKeyDown={event=>key(event,index)} draggable={!!onReorder} onDragStart={event=>{const source={kind:'tab',id:tab.id};if(!writeWorkspaceDrag(event.dataTransfer,source)){event.preventDefault();return;}event.stopPropagation();dragging.current=source;event.currentTarget.closest('[data-workspace-tab]')?.setAttribute('data-dragging','true');}} onDragEnd={event=>{event.currentTarget.closest('[data-workspace-tab]')?.removeAttribute('data-dragging');dragging.current=null;setDrop(null);}}><WorkspaceDragHandle/><span>{tab.title || 'Sem título'}</span></button>
    <button type="button" className="workspace-tab-close" aria-label={'Fechar '+(tab.title || 'Sem título')} onClick={()=>close(tab.id)}><Close/></button>
  </div>)}</div><div className="workspace-display" role="group" aria-label="Exibição das notas"><button type="button" title="Uma nota" aria-label="Uma nota" aria-pressed={display==='single'} onClick={()=>onDisplay('single')}><Display split={false}/><span className="workspace-control-label">Uma nota</span></button><button type="button" title="Lado a lado" aria-label="Lado a lado" aria-pressed={display==='split'} onClick={()=>onDisplay('split')}><Display split/><span className="workspace-control-label">Lado a lado</span></button><button type="button" title="Grid em mosaico" aria-label="Grid" aria-pressed={display==='grid'} onClick={()=>onDisplay('grid')}><Grid/><span className="workspace-control-label">Grid</span></button></div></div>;
}
