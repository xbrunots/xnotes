import React,{forwardRef,useCallback,useLayoutEffect,useRef} from 'react';
import {masonryColumns,masonrySpan,packMasonry} from './masonry-layout';

const px=value=>`${Math.round(value*1000)/1000}px`;
const number=value=>{const parsed=parseFloat(value);return Number.isFinite(parsed)?parsed:0;};
const cardsOf=node=>[...node.children].filter(child=>child.matches('article[data-pane]'));
const clearCard=card=>{
  for(const name of ['--masonry-x','--masonry-y','--masonry-width'])card.style.removeProperty(name);
  card.removeAttribute('data-masonry-placed');
};

/** Keeps the same container and child instances in all display modes. In grid
 * mode the existing articles are measured/repositioned; editors are never cloned
 * or rendered a second time. Forwarded ref is the real scrollable DOM element. */
export const EditorWorkspace=forwardRef(function EditorWorkspace({display='single',panelSizes={},children,className='',style,...props},forwardedRef) {
  const root=useRef(null),spacer=useRef(null),schedule=useRef(null),sizes=useRef(panelSizes);
  sizes.current=panelSizes;
  const mode=display==='grid'?'grid':display==='split'?'split':'single';
  const assignRef=useCallback(node=>{root.current=node;if(typeof forwardedRef==='function')forwardedRef(node);else if(forwardedRef)forwardedRef.current=node;},[forwardedRef]);

  useLayoutEffect(()=>{
    const container=root.current;if(!container)return;
    if(mode!=='grid'){
      cardsOf(container).forEach(clearCard);if(spacer.current)spacer.current.style.height='0px';return;
    }
    let stopped=false,frame=null,observed=new Set();
    const setProperty=(node,name,value)=>{if(node.style.getPropertyValue(name)!==value)node.style.setProperty(name,value);};
    const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>request()):null;
    const request=()=>{if(stopped||frame!==null)return;frame=requestAnimationFrame(layout);};
    const synchronize=()=>{
      const cards=cardsOf(container),current=new Set(cards);
      for(const card of observed)if(!current.has(card)){resizeObserver?.unobserve(card);clearCard(card);}
      for(const card of cards)if(!observed.has(card))resizeObserver?.observe(card);
      observed=current;return cards;
    };
    function layout(){
      frame=null;if(stopped)return;
      const cards=synchronize(),computed=getComputedStyle(container);
      const left=number(computed.paddingLeft),top=number(computed.paddingTop),right=number(computed.paddingRight);
      const width=Math.max(0,container.clientWidth-left-right),gap=number(computed.getPropertyValue('--masonry-gap')) || 12;
      const geometry=masonryColumns({width,minColumnWidth:280,gap});
      if(!geometry.columnCount){if(spacer.current)spacer.current.style.height='0px';return;}
      // Widths are written together, then heights are read in the next frame.
      // This prevents stale wrapped-text heights and ResizeObserver feedback.
      let widthChanged=false;
      for(const card of cards){
        const preferred=sizes.current?.notes?.[card.dataset.pane];
        const span=masonrySpan(preferred,geometry.columnWidth,geometry.columnCount,gap);
        const width=px(span*geometry.columnWidth+(span-1)*gap);
        if(card.style.getPropertyValue('--masonry-width')!==width){setProperty(card,'--masonry-width',width);widthChanged=true;}
      }
      if(widthChanged){request();return;}
      // offsetHeight is the untransformed border box. The app's introductory
      // scale changes client rects without triggering a ResizeObserver update.
      const packed=packMasonry({width,gap,minColumnWidth:280,items:cards.map(card=>({id:card.dataset.pane,height:card.offsetHeight,preferredWidth:sizes.current?.notes?.[card.dataset.pane]}))});
      const byId=new Map(cards.map(card=>[card.dataset.pane,card]));
      for(const placement of packed.placements){
        const card=byId.get(placement.id);setProperty(card,'--masonry-x',px(placement.x+left));setProperty(card,'--masonry-y',px(placement.y+top));
        if(!card.hasAttribute('data-masonry-placed'))card.setAttribute('data-masonry-placed','true');
      }
      if(spacer.current&&spacer.current.style.height!==px(packed.height))spacer.current.style.height=px(packed.height);
    }
    schedule.current=request;
    resizeObserver?.observe(container);synchronize();
    const mutations=new MutationObserver(request);mutations.observe(container,{childList:true,subtree:true,characterData:true});
    container.addEventListener('load',request,true);container.addEventListener('error',request,true);window.addEventListener('resize',request);
    document.fonts?.addEventListener?.('loadingdone',request);document.fonts?.ready?.then(()=>{if(!stopped)request();});
    request();
    return()=>{
      stopped=true;schedule.current=null;if(frame!==null)cancelAnimationFrame(frame);
      resizeObserver?.disconnect();mutations.disconnect();container.removeEventListener('load',request,true);container.removeEventListener('error',request,true);window.removeEventListener('resize',request);document.fonts?.removeEventListener?.('loadingdone',request);
      new Set([...observed,...cardsOf(container)]).forEach(clearCard);if(spacer.current)spacer.current.style.height='0px';
    };
  },[mode]);
  useLayoutEffect(()=>{schedule.current?.();},[panelSizes,children]);

  return <div {...props} ref={assignRef} className={'editor-workspace'+(className?' '+className:'')} style={style} data-editor-workspace="true" data-note-display={mode}>{children}<div ref={spacer} className="masonry-workspace-spacer" aria-hidden="true"/></div>;
});
