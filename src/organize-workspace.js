/** Only workspace entity IDs travel through drag and drop. Note contents, file
 * paths and attachment bytes never enter DataTransfer. */
export const WORKSPACE_DRAG_MIME = 'application/x-notes-workspace';
const VERSION = 1;
const MAX_DRAG_LENGTH = 2048;
const KINDS = new Set(['note','group','session','tab']);
const POSITIONS = new Set(['before','after','inside']);
const RESERVED = new Set(['__proto__','prototype','constructor']);
const safeId = value => Number.isSafeInteger(value) || (typeof value==='string' && /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,255}$/u.test(value) && !RESERVED.has(value));
const validDescriptor = value => value && typeof value==='object' && !Array.isArray(value)
  && KINDS.has(value.kind) && safeId(value.id)
  && (value.sessionId===undefined || safeId(value.sessionId))
  && Object.keys(value).every(key=>['kind','id','sessionId'].includes(key));
const descriptor = value => ({kind:value.kind,id:value.id,...(value.sessionId===undefined?{}:{sessionId:value.sessionId})});

export function serializeWorkspaceDrag(source) {
  if(!validDescriptor(source))return null;
  return JSON.stringify({version:VERSION,...descriptor(source)});
}

export function parseWorkspaceDrag(text) {
  if(typeof text!=='string'||!text.length||text.length>MAX_DRAG_LENGTH)return null;
  try {
    const data=JSON.parse(text);
    if(!data||data.version!==VERSION||Object.keys(data).some(key=>!['version','kind','id','sessionId'].includes(key)))return null;
    const {version:_version,...source}=data;
    return validDescriptor(source)?descriptor(source):null;
  } catch { return null; }
}

export function writeWorkspaceDrag(dataTransfer,source) {
  const serialized=serializeWorkspaceDrag(source);
  if(!dataTransfer||!serialized)return false;
  try { dataTransfer.setData(WORKSPACE_DRAG_MIME,serialized);dataTransfer.effectAllowed='move';return true; }
  catch { return false; }
}

export function readWorkspaceDrag(dataTransfer) {
  if(!dataTransfer)return null;
  try {
    const types=Array.from(dataTransfer.types || []);
    if(dataTransfer.files?.length||types.includes('Files')||!types.includes(WORKSPACE_DRAG_MIME))return null;
    return parseWorkspaceDrag(dataTransfer.getData(WORKSPACE_DRAG_MIME));
  } catch { return null; }
}

const sameOrder = (first,second) => first.length===second.length&&first.every((item,index)=>item===second[index]);
const moveRelative = (items,sourceId,targetId,position) => {
  const source=items.find(item=>item.id===sourceId);
  if(!source||sourceId===targetId)return items;
  const result=items.filter(item=>item.id!==sourceId),target=result.findIndex(item=>item.id===targetId);
  if(target<0)return items;
  result.splice(target+(position==='before'?0:1),0,source);
  return sameOrder(items,result)?items:result;
};
const sessionsOf = state => (state.groups || []).flatMap(group=>(group.sessions || []).map(session=>({session,group})));

/** A moved note leaves stale tabs in previous workspaces. Its destination keeps
 * the tab only when the note was already open. Current-session focus falls back
 * to a remaining tab; all note documents and arbitrary metadata stay intact. */
function movedNotePanes(state,noteId,destination) {
  const openBy={...state.openBy},focusBy={...state.focusBy};let wasOpen=false,changed=false;
  for(const [sessionId,ids] of Object.entries(state.openBy || {})) {
    if(!Array.isArray(ids)||!ids.includes(noteId))continue;
    wasOpen=true;
    if(String(destination)===sessionId)continue;
    const remaining=ids.filter(id=>id!==noteId);openBy[sessionId]=remaining;changed=true;
    if(focusBy[sessionId]===noteId)focusBy[sessionId]=remaining.at(-1) || null;
  }
  if(wasOpen) {
    const destinationTabs=[...new Set([...(openBy[destination] || []),noteId])];
    if(!sameOrder(openBy[destination] || [],destinationTabs)){openBy[destination]=destinationTabs;changed=true;}
    if(!focusBy[destination]){focusBy[destination]=noteId;changed=true;}
  }
  const editing=state.editing===noteId&&state.session!==destination?null:state.editing;
  return {...(changed?{openBy,focusBy}:{}),...(editing!==state.editing?{editing}:{})};
}

/** Immutable React state patch. Unknown fields, note bodies, rich documents,
 * attachment descriptors, IDs and trash entries are preserved verbatim. */
export function applyWorkspaceDrop(state,source,target,position='inside') {
  if(!validDescriptor(source)||!validDescriptor(target)||!POSITIONS.has(position)||!state||!Array.isArray(state.groups)||!Array.isArray(state.notes))return {};
  const sessions=sessionsOf(state);
  if(source.kind==='group'&&target.kind==='group') {
    if(!state.groups.some(group=>group.id===source.id)||!state.groups.some(group=>group.id===target.id))return {};
    const groups=moveRelative(state.groups,source.id,target.id,position);
    return groups===state.groups?{}:{groups};
  }
  if(source.kind==='session'&&(target.kind==='group'||target.kind==='session')) {
    const origin=sessions.find(({session})=>session.id===source.id);
    const sibling=target.kind==='session'?sessions.find(({session})=>session.id===target.id):null;
    const destination=target.kind==='group'?state.groups.find(group=>group.id===target.id):sibling?.group;
    if(!origin||!destination||(target.kind==='session'&&source.id===target.id))return {};
    if(target.kind==='group'&&position!=='inside')return {};
    const children=(destination.sessions || []).filter(session=>session.id!==source.id);
    const index=target.kind==='session'?children.findIndex(session=>session.id===target.id)+(position==='before'?0:1):children.length;
    children.splice(index,0,origin.session);
    if(origin.group.id===destination.id&&sameOrder(destination.sessions,children))return {};
    const groups=state.groups.map(group=>group.id===destination.id?{...group,sessions:children}:group.id===origin.group.id?{...group,sessions:group.sessions.filter(session=>session.id!==source.id)}:group);
    return {groups,...(!state.expanded?.[destination.id]?{expanded:{...state.expanded,[destination.id]:true}}:{})};
  }
  if(source.kind==='note'&&(target.kind==='note'||target.kind==='session')) {
    const note=state.notes.find(item=>item.id===source.id&&!item.deletedAt);
    const sibling=target.kind==='note'?state.notes.find(item=>item.id===target.id&&!item.deletedAt):null;
    const destination=target.kind==='session'?target.id:sibling?.s;
    if(!note||!sessions.some(({session})=>session.id===destination)||(target.kind==='note'&&(!sibling||note.id===sibling.id)))return {};
    if(target.kind==='session'&&position!=='inside')return {};
    const changed=note.s===destination?note:{...note,s:destination};
    const notes=state.notes.filter(item=>item.id!==note.id);
    let index;
    if(sibling)index=notes.findIndex(item=>item.id===sibling.id)+(position==='before'?0:1);
    else {index=notes.length;for(let cursor=notes.length-1;cursor>=0;cursor--)if(notes[cursor].s===destination){index=cursor+1;break;}}
    notes.splice(index,0,changed);
    if(note===changed&&sameOrder(state.notes,notes))return {};
    return {notes,...(note.s!==destination?movedNotePanes(state,note.id,destination):{})};
  }
  if(source.kind==='tab'&&target.kind==='tab') {
    const workspace=source.sessionId ?? state.session,destination=target.sessionId ?? state.session;
    if(workspace!==destination||!sessions.some(({session})=>session.id===workspace))return {};
    const ids=state.openBy?.[workspace] || [];
    if(source.id===target.id||!ids.includes(source.id)||!ids.includes(target.id))return {};
    const available=new Set(state.notes.filter(note=>!note.deletedAt).map(note=>note.id));
    if(!available.has(source.id)||!available.has(target.id))return {};
    const unique=[...new Set(ids)],remaining=unique.filter(id=>id!==source.id),index=remaining.indexOf(target.id)+(position==='before'?0:1);
    remaining.splice(index,0,source.id);
    return sameOrder(ids,remaining)?{}:{openBy:{...state.openBy,[workspace]:remaining}};
  }
  return {};
}

export function canWorkspaceDrop(state,source,target,position='inside') {
  return Object.keys(applyWorkspaceDrop(state,source,target,position)).length>0;
}
