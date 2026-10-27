export const PANEL_LIMITS = Object.freeze({
  sidebar:Object.freeze({min:180,max:420}),
  list:Object.freeze({min:220,max:520}),
  note:Object.freeze({min:260,max:1600}),
  section:Object.freeze({min:80,max:1600}),
});
export const EDITOR_MIN_WIDTH = 320;
export const PANEL_SIZE_ENTRY_LIMITS = Object.freeze({notes:512,sections:64});
const RESERVED=new Set(['__proto__','prototype','constructor']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.prototype.toString.call(value)==='[object Object]';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const keyValid=key=>typeof key==='string'&&/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,255}$/u.test(key)&&!RESERVED.has(key);

/** Shared clamp also handles a temporarily unavailable viewport measurement. */
export function clampPanelSize(value,min,max,fallback=min) {
  const lower=finite(min)?min:0,upper=finite(max)?Math.max(lower,max):lower;
  const candidate=finite(value)?value:finite(fallback)?fallback:lower;
  return Math.max(lower,Math.min(upper,Math.round(candidate)));
}

/** Canonical, bounded preference data; layout calculations never mutate it. */
export function normalizePanelSizes(value) {
  if(!object(value))return {};
  const result={};
  for(const name of ['sidebar','list'])if(finite(value[name]))result[name]=clampPanelSize(value[name],PANEL_LIMITS[name].min,PANEL_LIMITS[name].max);
  for(const [name,kind] of [['notes','note'],['sections','section']])if(object(value[name])) {
    const entries=Object.entries(value[name]).filter(([key,size])=>keyValid(key)&&finite(size)).slice(-PANEL_SIZE_ENTRY_LIMITS[name]);
    if(entries.length)result[name]=Object.fromEntries(entries.map(([key,size])=>[key,clampPanelSize(size,PANEL_LIMITS[kind].min,PANEL_LIMITS[kind].max)]));
  }
  return result;
}

/** Strict counterpart for storage validation: reject malformed/oversized input
 * instead of silently saving a sanitized version over unreadable preferences. */
export function isValidPanelSizes(value) {
  if(!object(value)||Object.keys(value).some(key=>!['sidebar','list','notes','sections'].includes(key)))return false;
  for(const name of ['sidebar','list'])if(Object.prototype.hasOwnProperty.call(value,name)) {
    const size=value[name],limits=PANEL_LIMITS[name];if(!finite(size)||size<limits.min||size>limits.max)return false;
  }
  for(const [name,kind] of [['notes','note'],['sections','section']])if(Object.prototype.hasOwnProperty.call(value,name)) {
    if(!object(value[name]))return false;
    const entries=Object.entries(value[name]),limits=PANEL_LIMITS[kind];
    if(entries.length>PANEL_SIZE_ENTRY_LIMITS[name]||entries.some(([key,size])=>!keyValid(key)||!finite(size)||size<limits.min||size>limits.max))return false;
  }
  return true;
}

/** Preferred widths survive a window resize. Only the returned effective sizes
 * shrink; both navigation panels share the reduction above their minimums. The
 * Windows minimum viewport (960px) always reserves at least 320px for editors. */
export function calculatePanelLayout({width=1440,appearance='standard',sidebar=true,panelSizes={}}={}) {
  const viewportWidth=Math.max(0,Math.floor(finite(width)?width:1440));
  const sizes=normalizePanelSizes(panelSizes),islands=appearance==='islands',compact=viewportWidth<1100;
  const gap=islands?(compact?9:12):0,padding=gap;
  const overhead=padding*2+gap*(sidebar?2:1);
  const availableWidth=Math.max(0,viewportWidth-overhead),editorMinimum=Math.min(EDITOR_MIN_WIDTH,availableWidth);
  const navigationBudget=Math.max(0,availableWidth-editorMinimum);
  let sidebarWidth=sidebar?clampPanelSize(sizes.sidebar,PANEL_LIMITS.sidebar.min,PANEL_LIMITS.sidebar.max,compact?220:244):0;
  let listWidth=clampPanelSize(sizes.list,PANEL_LIMITS.list.min,PANEL_LIMITS.list.max,compact?264:300);
  if(sidebarWidth+listWidth>navigationBudget) {
    const sidebarMinimum=sidebar?PANEL_LIMITS.sidebar.min:0,listMinimum=PANEL_LIMITS.list.min;
    const minimum=sidebarMinimum+listMinimum;
    if(navigationBudget>=minimum) {
      const sidebarExtra=sidebarWidth-sidebarMinimum,listExtra=listWidth-listMinimum,totalExtra=sidebarExtra+listExtra;
      const room=navigationBudget-minimum;
      sidebarWidth=sidebarMinimum+(totalExtra?Math.floor(room*sidebarExtra/totalExtra):0);
      listWidth=listMinimum+room-(sidebarWidth-sidebarMinimum);
    } else {
      // Defensive handling below the supported Windows minimum: avoid global
      // overflow even when minimum navigation widths cannot all be satisfied.
      sidebarWidth=sidebar?Math.min(sidebarMinimum,Math.max(0,navigationBudget-listMinimum)):0;
      listWidth=Math.max(0,navigationBudget-sidebarWidth);
    }
  }
  const editorWidth=Math.max(0,availableWidth-sidebarWidth-listWidth);
  const sidebarMax=Math.max(PANEL_LIMITS.sidebar.min,Math.min(PANEL_LIMITS.sidebar.max,availableWidth-listWidth-EDITOR_MIN_WIDTH));
  const listMax=Math.max(PANEL_LIMITS.list.min,Math.min(PANEL_LIMITS.list.max,availableWidth-sidebarWidth-EDITOR_MIN_WIDTH));
  return {
    viewportWidth,availableWidth,sidebarWidth,listWidth,editorWidth,gap,padding,overhead,
    columns:sidebar?`${sidebarWidth}px ${listWidth}px minmax(0,1fr)`:`${listWidth}px minmax(0,1fr)`,
    sidebarLimits:{min:PANEL_LIMITS.sidebar.min,max:sidebarMax},
    listLimits:{min:PANEL_LIMITS.list.min,max:listMax},
    minimumsSatisfied:editorWidth>=EDITOR_MIN_WIDTH&&listWidth>=PANEL_LIMITS.list.min&&(!sidebar||sidebarWidth>=PANEL_LIMITS.sidebar.min),
  };
}

/** Unspecified split notes share the remaining editor width. Explicit choices
 * remain intact; narrow windows scroll within the editor workspace, never by
 * increasing the outer grid. IDs are de-duplicated before assigning widths. */
export function calculateNoteWidths({ids=[],availableWidth=0,panelSizes={},gap=12}={}) {
  const unique=[...new Set(ids.filter(id=>(typeof id==='string'&&keyValid(id))||Number.isSafeInteger(id)))];
  const available=Math.max(0,Math.floor(finite(availableWidth)?availableWidth:0)),spacing=Math.max(0,Math.floor(finite(gap)?gap:12));
  const preferred=normalizePanelSizes(panelSizes).notes || {},widths={};
  const floating=unique.filter(id=>!Object.prototype.hasOwnProperty.call(preferred,id));
  const fixed=unique.filter(id=>Object.prototype.hasOwnProperty.call(preferred,id));
  let fixedTotal=0;for(const id of fixed){widths[id]=preferred[id];fixedTotal+=widths[id];}
  const gapTotal=Math.max(0,unique.length-1)*spacing;
  const room=Math.max(0,available-gapTotal-fixedTotal),base=floating.length?clampPanelSize(Math.floor(room/floating.length),PANEL_LIMITS.note.min,PANEL_LIMITS.note.max):0;
  let remainder=Math.max(0,room-base*floating.length);
  for(const id of floating){widths[id]=base+(remainder>0&&base<PANEL_LIMITS.note.max?1:0);if(widths[id]>base)remainder--;}
  const totalWidth=Object.values(widths).reduce((sum,size)=>sum+size,0)+gapTotal;
  return {widths,totalWidth,overflow:totalWidth>available,availableWidth:available,gap:spacing};
}
