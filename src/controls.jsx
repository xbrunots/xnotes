import React,{useEffect,useRef,useState} from 'react';

export function PlusIcon({size=16}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>;}
export function DropdownIcon({className}){return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M5 9h14l-7 7Z"/></svg>;}

export function ColorPicker({value,onChange}){
  const colors=[['Azul','#3B82F6'],['Grafite','#8E8E98'],['Violeta','#8B6CFF'],['Menta','#22B89A'],['Coral','#FF6B57'],['Âmbar','#F2B225']];
  const [open,setOpen]=useState(false),[active,setActive]=useState(Math.max(0,colors.findIndex(([name])=>name===value)));
  const root=useRef(null),trigger=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!root.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  const choose=index=>{onChange(colors[index][0]);setOpen(false);trigger.current?.focus();};
  const key=event=>{
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();event.stopPropagation();
      if(!open){setOpen(true);setActive(Math.max(0,colors.findIndex(([name])=>name===value)));return;}
      setActive(current=>event.key==='Home'?0:event.key==='End'?colors.length-1:Math.max(0,Math.min(colors.length-1,current+(event.key==='ArrowDown'?1:-1))));
    }else if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(open)choose(active);else{setActive(Math.max(0,colors.findIndex(([name])=>name===value)));setOpen(true);}}
    else if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);}
    else if(event.key==='Tab')setOpen(false);
  };
  return <div className="color-picker" ref={root} onKeyDown={key}>
    <button className="color-picker-trigger" ref={trigger} role="combobox" aria-label="Cor de destaque" aria-expanded={open} aria-controls="accent-options" aria-haspopup="listbox" aria-activedescendant={open?'accent-option-'+active:undefined} onClick={()=>{setActive(Math.max(0,colors.findIndex(([name])=>name===value)));setOpen(current=>!current);}}>
      <span className="color-swatch" style={{background:colors.find(([name])=>name===value)?.[1] || colors[0][1]}}/><span>{value}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={open?'picker-chevron open':'picker-chevron'}><path d="m6 9 6 6 6-6"/></svg>
    </button>
    {open&&<ul className="color-picker-options" id="accent-options" role="listbox" aria-label="Cores de destaque">{colors.map(([name,color],index)=><li id={'accent-option-'+index} key={name} role="option" aria-selected={name===value} className={index===active?'active':''} onMouseEnter={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span className="color-swatch" style={{background:color}}/><span>{name}</span>{name===value&&<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10"/></svg>}</li>)}</ul>}
  </div>;
}

export function Toggle({checked,onChange,label}){
  return <button type="button" className="custom-toggle" role="switch" aria-label={label} aria-checked={checked} onClick={()=>onChange(!checked)}><span/></button>;
}

export function Slider({value,min=0,max=60,step=2,onChange,label}){
  const ref=useRef(null),drag=useRef(null);const [dragging,setDragging]=useState(false);
  const clamp=next=>Math.max(min,Math.min(max,Math.round((next-min)/step)*step+min));
  const move=event=>{const rect=ref.current.getBoundingClientRect();onChange(clamp(min+(event.clientX-rect.left)/rect.width*(max-min)));};
  const key=event=>{
    const delta={ArrowLeft:-step,ArrowDown:-step,ArrowRight:step,ArrowUp:step,PageDown:-step*5,PageUp:step*5}[event.key];
    if(delta!==undefined||event.key==='Home'||event.key==='End'){event.preventDefault();event.stopPropagation();onChange(clamp(event.key==='Home'?min:event.key==='End'?max:value+delta));}
  };
  return <div ref={ref} className={'custom-slider'+(dragging?' dragging':'')} tabIndex={0} role="slider" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={value+' pixels'} onKeyDown={key} onPointerDown={event=>{event.preventDefault();ref.current.focus();drag.current=event.pointerId;ref.current.setPointerCapture(event.pointerId);setDragging(true);move(event);}} onPointerMove={event=>{if(drag.current===event.pointerId)move(event);}} onPointerUp={event=>{if(drag.current===event.pointerId){drag.current=null;setDragging(false);ref.current.releasePointerCapture(event.pointerId);}}} onPointerCancel={()=>{drag.current=null;setDragging(false);}}>
    <span className="slider-rail"><span className="slider-fill" style={{width:(value-min)/(max-min)*100+'%'}}/></span><span className="slider-thumb" style={{left:(value-min)/(max-min)*100+'%'}}/>
  </div>;
}
