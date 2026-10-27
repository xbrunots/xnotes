const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=(value,fallback)=>finite(value)&&value>0?value:fallback;

export function masonryColumns({width=0,minColumnWidth=280,gap=12}={}) {
  const available=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,finite(width)?width:0));
  const spacing=Math.max(0,Math.min(1000000,finite(gap)?gap:12));
  const minimum=positive(minColumnWidth,280);
  const columnCount=available>0?Math.min(64,Math.max(1,Math.floor((available+spacing)/(minimum+spacing)))):0;
  const columnWidth=columnCount?(available-spacing*(columnCount-1))/columnCount:0;
  return {width:available,gap:spacing,columnCount,columnWidth};
}

/** A preference snaps to the nearest complete number of contiguous columns. */
export function masonrySpan(preferredWidth,columnWidth,columnCount,gap=12) {
  if(!columnCount||columnWidth<=0)return 0;
  if(!finite(preferredWidth)||preferredWidth<=0)return 1;
  return Math.max(1,Math.min(columnCount,Math.round((preferredWidth+gap)/(columnWidth+gap))));
}

/** Pack actual card heights into the lowest available contiguous columns. The
 * returned order matches the input order; only visual coordinates change. */
export function packMasonry({width=0,items=[],minColumnWidth=280,gap=12}={}) {
  const geometry=masonryColumns({width,minColumnWidth,gap});
  if(!geometry.columnCount)return {...geometry,placements:[],height:0};
  const input=Array.isArray(items)?items:[],seen=new Set(),levels=Array(geometry.columnCount).fill(0),placements=[];
  const maximumHeight=Number.MAX_SAFE_INTEGER/Math.max(1,input.length+1);
  for(const item of input) {
    if(!item||!['string','number'].includes(typeof item.id)||(typeof item.id==='number'&&!Number.isSafeInteger(item.id))||item.id===''||seen.has(item.id))continue;
    seen.add(item.id);
    const span=masonrySpan(item.preferredWidth,geometry.columnWidth,geometry.columnCount,geometry.gap);
    let column=0,y=Infinity;
    for(let candidate=0;candidate<=geometry.columnCount-span;candidate++) {
      let top=0;for(let index=candidate;index<candidate+span;index++)top=Math.max(top,levels[index]);
      if(top<y){y=top;column=candidate;}
    }
    const height=Math.min(maximumHeight,Math.max(0,finite(item.height)?item.height:0));
    const placement={id:item.id,column,span,x:column*(geometry.columnWidth+geometry.gap),y,width:span*geometry.columnWidth+(span-1)*geometry.gap,height};
    placements.push(placement);
    const bottom=y+height+geometry.gap;
    for(let index=column;index<column+span;index++)levels[index]=bottom;
  }
  return {...geometry,placements,height:placements.length?Math.max(...levels)-geometry.gap:0};
}
