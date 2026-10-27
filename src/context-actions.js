const copy = value => structuredClone(value);
const freshId = prefix => `${prefix}-${crypto.randomUUID()}`;
const sessionsOf = state => state.groups.flatMap(group => group.sessions.map(session => ({...session,group})));
const noteTitle = note => note.title || 'Sem título';
const active = note => !note.deletedAt;
const named = value => String(value ?? '').trim();

function openNotePatch(state,noteId,sessionId=state.session) {
  const list=[...(state.openBy[sessionId] || []).filter(id=>id!==noteId),noteId];
  return {session:sessionId,view:'session',tag:null,openBy:{...state.openBy,[sessionId]:list},focusBy:{...state.focusBy,[sessionId]:noteId}};
}

function cleanPanes(state,removedNotes=[],removedSessions=[]) {
  const notes=new Set(removedNotes),sessions=new Set(removedSessions);
  const openBy=Object.fromEntries(Object.entries(state.openBy).filter(([id])=>!sessions.has(id)).map(([id,list])=>[id,list.filter(noteId=>!notes.has(noteId))]));
  const focusBy=Object.fromEntries(Object.entries(state.focusBy).filter(([id])=>!sessions.has(id)).map(([id,focused])=>[id,notes.has(focused)?openBy[id]?.at(-1) || null:focused]));
  return {openBy,focusBy,editing:notes.has(state.editing)?null:state.editing};
}

function reordered(items,index,direction) {
  const target=direction==='first'?0:direction==='last'?items.length-1:Math.max(0,Math.min(items.length-1,index+(direction==='up'?-1:1)));
  const result=[...items];result.splice(target,0,result.splice(index,1)[0]);return result;
}

function fallbackGroups(groups,makeId) {
  const result=copy(groups);
  if(!result.length)result.push({id:makeId('g'),name:'Pessoal',color:'#7D7AFF',sessions:[]});
  let session=result.flatMap(group=>group.sessions)[0];
  if(!session){session={id:makeId('s'),name:'Geral'};result[0].sessions.push(session);}
  return {groups:result,sessionId:session.id};
}

/** Return a React state patch. All workspace changes are immutable and use the
 * existing autosave transaction; attachment descriptors and unknown metadata
 * travel with their note. The environment argument makes clocks/IDs testable. */
export function applyContextAction(state,action,payload={},environment={}) {
  const makeId=environment.makeId || freshId;
  const now=environment.now || (()=>new Date().toISOString());
  const note=state.notes.find(item=>item.id===payload.id);
  const group=state.groups.find(item=>item.id===payload.id);
  const session=sessionsOf(state).find(item=>item.id===payload.id);
  const sessionExists=id=>sessionsOf(state).some(item=>item.id===id);
  const openingSession=note&&(state.openBy[state.session] || []).includes(note.id)?state.session:note?.s;
  if(action==='note-open'&&note&&active(note))return openNotePatch(state,note.id,openingSession);
  if(action==='note-focus'&&note&&active(note))return {...openNotePatch(state,note.id,openingSession),layout:'focus',noteDisplay:'single'};
  if(action==='note-rename'&&note&&named(payload.name))return {notes:state.notes.map(item=>item.id===note.id?{...item,title:named(payload.name),t:'Agora'}:item)};
  if(action==='note-pin'&&note)return {notes:state.notes.map(item=>item.id===note.id?{...item,pinned:!item.pinned}:item)};
  if((action==='note-duplicate'||action==='note-copy-to')&&note) {
    const destination=action==='note-copy-to'?payload.sessionId:note.s;
    if(!sessionExists(destination))return {};
    const duplicate={...copy(note),id:makeId('n'),s:destination,title:action==='note-duplicate'?`${noteTitle(note)} (cópia)`:note.title,t:'Agora'};
    delete duplicate.deletedAt;
    return {notes:[duplicate,...state.notes],...(action==='note-duplicate'?{...openNotePatch(state,duplicate.id,destination),editing:duplicate.id}: {})};
  }
  if(action==='note-move'&&note&&sessionExists(payload.sessionId)&&payload.sessionId!==note.s)return {notes:state.notes.map(item=>item.id===note.id?{...item,s:payload.sessionId,t:'Agora'}:item)};
  if(action==='note-trash'&&note)return {notes:state.notes.map(item=>item.id===note.id?{...item,deletedAt:now()}:item),...cleanPanes(state,[note.id])};
  if(action==='note-restore'&&note)return {notes:state.notes.map(item=>{if(item.id!==note.id)return item;const restored={...item};delete restored.deletedAt;return restored;})};
  if(action==='note-close'&&note) {
    const list=(state.openBy[state.session] || []).filter(id=>id!==note.id);
    return {openBy:{...state.openBy,[state.session]:list},focusBy:{...state.focusBy,[state.session]:state.focusBy[state.session]===note.id?list.at(-1) || null:state.focusBy[state.session]},editing:state.editing===note.id?null:state.editing};
  }
  if(action==='note-close-others'&&note)return {openBy:{...state.openBy,[state.session]:[note.id]},focusBy:{...state.focusBy,[state.session]:note.id},editing:state.editing===note.id?note.id:null};
  if(action==='group-rename'&&group&&named(payload.name))return {groups:state.groups.map(item=>item.id===group.id?{...item,name:named(payload.name)}:item)};
  if(action==='group-color'&&group&&/^#[0-9a-f]{6}$/i.test(payload.color || ''))return {groups:state.groups.map(item=>item.id===group.id?{...item,color:payload.color}:item)};
  if(action==='group-expanded'&&group)return {expanded:{...state.expanded,[group.id]:payload.expanded}};
  if(action==='groups-expanded')return {expanded:{...state.expanded,...Object.fromEntries(state.groups.map(item=>[item.id,payload.expanded]))}};
  if(action==='group-reorder'&&group)return {groups:reordered(state.groups,state.groups.indexOf(group),payload.direction)};
  if(action==='group-sort-sessions'&&group)return {groups:state.groups.map(item=>item.id===group.id?{...item,sessions:[...item.sessions].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')*(payload.descending?-1:1))}:item)};
  if(action==='session-create'&&group&&named(payload.name)) {
    const created={id:makeId('s'),name:named(payload.name)};
    return {groups:state.groups.map(item=>item.id===group.id?{...item,sessions:[...item.sessions,created]}:item),expanded:{...state.expanded,[group.id]:true},session:created.id,view:'session',tag:null,openBy:{...state.openBy,[created.id]:[]},focusBy:{...state.focusBy,[created.id]:null}};
  }
  if(action==='session-open'&&session)return {session:session.id,view:'session',tag:null,editing:null,expanded:{...state.expanded,[session.group.id]:true}};
  if(action==='session-rename'&&session&&named(payload.name))return {groups:state.groups.map(item=>({...item,sessions:item.sessions.map(child=>child.id===session.id?{...child,name:named(payload.name)}:child)}))};
  if(action==='session-new-note'&&session) {
    const created={id:makeId('n'),s:session.id,title:'',body:'',t:'Agora'};
    return {notes:[created,...state.notes],...openNotePatch(state,created.id,session.id),editing:created.id};
  }
  if(action==='session-reorder'&&session)return {groups:state.groups.map(item=>item.id===session.group.id?{...item,sessions:reordered(item.sessions,item.sessions.findIndex(child=>child.id===session.id),payload.direction)}:item)};
  if(action==='session-move'&&session&&payload.groupId!==session.group.id&&state.groups.some(item=>item.id===payload.groupId)) {
    const {group:_group,...data}=session;
    return {groups:state.groups.map(item=>item.id===session.group.id?{...item,sessions:item.sessions.filter(child=>child.id!==session.id)}:item.id===payload.groupId?{...item,sessions:[...item.sessions,data]}:item),expanded:{...state.expanded,[payload.groupId]:true}};
  }
  if(action==='session-open-notes'&&session) {
    const ids=state.notes.filter(item=>item.s===session.id&&active(item)).sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)).map(item=>item.id);
    return {session:session.id,view:'session',tag:null,layout:'split',noteDisplay:state.noteDisplay==='grid'?'grid':'split',openBy:{...state.openBy,[session.id]:ids},focusBy:{...state.focusBy,[session.id]:ids[0] || null},editing:null};
  }
  if(action==='session-close-notes'&&session)return {openBy:{...state.openBy,[session.id]:[]},focusBy:{...state.focusBy,[session.id]:null},...(state.session===session.id?{editing:null}:{})};
  if(action==='session-sort-notes'&&session) {
    const sorted=state.notes.filter(item=>item.s===session.id);
    if(payload.order==='reverse')sorted.reverse();else sorted.sort((a,b)=>noteTitle(a).localeCompare(noteTitle(b),'pt-BR')*(payload.order==='title-desc'?-1:1));
    let index=0;return {notes:state.notes.map(item=>item.s===session.id?sorted[index++]:item)};
  }
  if(action==='session-move-notes'&&session&&sessionExists(payload.sessionId)&&payload.sessionId!==session.id)return {notes:state.notes.map(item=>item.s===session.id&&active(item)?{...item,s:payload.sessionId,t:'Agora'}:item)};
  if(action==='group-duplicate'&&group) {
    const sessionIds=new Map(group.sessions.map(child=>[child.id,makeId('s')]));
    const duplicate={...copy(group),id:makeId('g'),name:`${group.name} (cópia)`,sessions:group.sessions.map(child=>({...copy(child),id:sessionIds.get(child.id)}))};
    const copiedNotes=state.notes.filter(item=>sessionIds.has(item.s)&&active(item)).map(item=>({...copy(item),id:makeId('n'),s:sessionIds.get(item.s),t:'Agora'}));
    const index=state.groups.indexOf(group),groups=[...state.groups];groups.splice(index+1,0,duplicate);
    return {groups,notes:[...copiedNotes,...state.notes],expanded:{...state.expanded,[duplicate.id]:true},...(duplicate.sessions[0]?{session:duplicate.sessions[0].id,view:'session',tag:null,editing:null}: {})};
  }
  if(action==='session-duplicate'&&session) {
    const {group:_group,...data}=session;
    const duplicate={...copy(data),id:makeId('s'),name:`${session.name} (cópia)`};
    const copiedNotes=state.notes.filter(item=>item.s===session.id&&active(item)).map(item=>({...copy(item),id:makeId('n'),s:duplicate.id,t:'Agora'}));
    return {groups:state.groups.map(item=>{if(item.id!==session.group.id)return item;const children=[...item.sessions];children.splice(children.findIndex(child=>child.id===session.id)+1,0,duplicate);return {...item,sessions:children};}),notes:[...copiedNotes,...state.notes],expanded:{...state.expanded,[session.group.id]:true},session:duplicate.id,view:'session',tag:null,editing:null,openBy:{...state.openBy,[duplicate.id]:[]},focusBy:{...state.focusBy,[duplicate.id]:null}};
  }
  if((action==='group-trash-notes'&&group)||(action==='session-trash-notes'&&session)) {
    const ids=new Set(action==='group-trash-notes'?group.sessions.map(child=>child.id):[session.id]);
    const trashed=state.notes.filter(item=>ids.has(item.s)&&active(item)).map(item=>item.id);
    return {notes:state.notes.map(item=>ids.has(item.s)&&active(item)?{...item,deletedAt:now()}:item),...cleanPanes(state,trashed)};
  }
  if((action==='group-delete'&&group)||(action==='session-delete'&&session)) {
    const removedSessions=action==='group-delete'?group.sessions.map(child=>child.id):[session.id];
    const ids=new Set(removedSessions);
    const remaining=action==='group-delete'?state.groups.filter(item=>item.id!==group.id):state.groups.map(item=>({...item,sessions:item.sessions.filter(child=>child.id!==session.id)}));
    const fallback=fallbackGroups(remaining,makeId);
    const removedNotes=state.notes.filter(item=>ids.has(item.s)).map(item=>item.id);
    const expanded={...state.expanded};if(action==='group-delete')delete expanded[group.id];
    return {groups:fallback.groups,notes:state.notes.map(item=>ids.has(item.s)?{...item,s:fallback.sessionId,deletedAt:item.deletedAt || now()}:item),...cleanPanes(state,removedNotes,removedSessions),expanded,session:ids.has(state.session)?fallback.sessionId:state.session,...(ids.has(state.session)?{view:'session',tag:null}: {})};
  }
  return {};
}

const SUCCESS={
  'note-duplicate':'Nota duplicada.','note-copy-to':'Nota copiada para a sessão.','note-move':'Nota movida.','note-trash':'Nota enviada à lixeira.','note-restore':'Nota restaurada.',
  'group-duplicate':'Grupo e notas duplicados.','group-delete':'Grupo excluído. As notas estão na lixeira.','session-duplicate':'Sessão e notas duplicadas.','session-delete':'Sessão excluída. As notas estão na lixeira.',
  'session-move':'Sessão movida.','session-move-notes':'Notas movidas.','session-trash-notes':'Notas enviadas à lixeira.','group-trash-notes':'Notas enviadas à lixeira.'
};

export function invokeContextAction(host,action,payload={}) {
  if(action==='note-copy-text'||action==='note-copy-title') {
    const note=host.state.notes.find(item=>item.id===payload.id);if(!note)return;
    return host.run(async()=>{await host.copyText(action==='note-copy-title'?note.title:host.plainText(note.body,note.richText));host.showToast(action==='note-copy-title'?'Título copiado.':'Texto copiado.');});
  }
  if(action==='note-export')return host.run(async()=>{await host.flushAll();if(await window.notes.exportNote(payload.id))host.showToast('Nota exportada.');});
  if(action==='note-attachments')return host.setState({dialog:'attachments',attachmentNoteId:payload.id,attachmentQuery:'',attachmentLimit:100});
  if(action==='note-theme')return host.openNoteThemes(payload.id);
  host.setState(state=>applyContextAction(state,action,payload));
  if(SUCCESS[action])host.showToast(SUCCESS[action]);
}

function prompt(host,action,payload,title,label,value='',description='') {
  host.setState({contextDialog:{mode:'name',action,payload,title,label,value,description}});
}
function confirm(host,action,payload,title,description,confirmLabel) {
  host.setState({contextDialog:{mode:'confirm',action,payload,title,description,confirmLabel,danger:true}});
}

export function contextMenuTitle(state,kind,id) {
  if(kind==='note')return noteTitle(state.notes.find(item=>item.id===id) || {});
  if(kind==='group')return state.groups.find(item=>item.id===id)?.name || 'Grupo';
  return sessionsOf(state).find(item=>item.id===id)?.name || 'Sessão';
}

/** Build declarative items. Every leaf invokes a real action; impossible actions
 * remain visible and disabled so their availability is understandable. */
export function buildContextItems(host,kind,id) {
  const state=host.state;
  const execute=(action,payload={})=>()=>invokeContextAction(host,action,{id,...payload});
  const item=(action,label,options={})=>({id:action,label,action:execute(action,options.payload),...options});
  const separator={separator:true};
  const destinations=(action,excluded)=>state.groups.map(group=>({id:group.id,label:group.name,color:group.color,disabled:!group.sessions.length,children:group.sessions.map(session=>({id:session.id,label:session.name,disabled:session.id===excluded,action:execute(action,{sessionId:session.id})}))}));
  const reorder=(prefix,index,length)=>({id:`${prefix}-order`,label:'Reordenar',children:[['up','Mover para cima'],['down','Mover para baixo'],['first','Mover para o início'],['last','Mover para o fim']].map(([direction,label])=>item(`${prefix}-reorder`,label,{id:`${prefix}-${direction}`,payload:{direction},disabled:direction==='up'||direction==='first'?index===0:index===length-1}))});
  if(kind==='note') {
    const note=state.notes.find(candidate=>candidate.id===id);if(!note)return [];
    const opened=state.openBy[state.session] || [];
    return [
      item('note-open','Abrir nota',{disabled:!!note.deletedAt}),item('note-focus','Abrir em foco',{disabled:!!note.deletedAt}),
      {id:'note-rename',label:'Renomear…',action:()=>prompt(host,'note-rename',{id},'Renomear nota','Título da nota',note.title)},
      item('note-duplicate','Duplicar nota'),item('note-pin',note.pinned?'Desafixar nota':'Fixar no topo',{checked:!!note.pinned}),item('note-theme','Cor e tema da nota…'),separator,
      {id:'note-move-to',label:'Mover para',children:destinations('note-move',note.s),disabled:!!note.deletedAt},
      {id:'note-copy-to',label:'Copiar para',children:destinations('note-copy-to',null)},separator,
      item('note-copy-text','Copiar texto',{disabled:!note.body}),item('note-copy-title','Copiar título',{disabled:!note.title}),item('note-export','Exportar nota…'),
      ...(note.attachments?.length?[item('note-attachments',`Anexos (${note.attachments.length})…`)]:[]),separator,
      item('note-close','Fechar aba',{disabled:!opened.includes(id)}),item('note-close-others','Fechar outras abas',{disabled:!opened.includes(id)||opened.length<2}),separator,
      note.deletedAt?item('note-restore','Restaurar nota'):item('note-trash','Enviar à lixeira',{danger:true})
    ];
  }
  if(kind==='group') {
    const group=state.groups.find(candidate=>candidate.id===id);if(!group)return [];
    const ids=new Set(group.sessions.map(child=>child.id)),count=state.notes.filter(note=>ids.has(note.s)&&active(note)).length;
    return [
      {id:'session-create',label:'Nova sessão…',action:()=>prompt(host,'session-create',{id},'Nova sessão','Nome da sessão','')},
      {id:'group-create',label:'Novo grupo…',action:()=>host.openDialog('new-group')},
      {id:'group-rename',label:'Renomear grupo…',action:()=>prompt(host,'group-rename',{id},'Renomear grupo','Nome do grupo',group.name)},item('group-duplicate','Duplicar grupo e notas'),separator,
      {id:'group-color',label:'Cor do grupo',children:[['Âmbar','#FF9F0A'],['Violeta','#7D7AFF'],['Verde','#30D158'],['Azul','#409CFF'],['Rosa','#FF6494'],['Grafite','#8E8E93']].map(([label,color])=>item('group-color',label,{id:color,color,checked:(group.color || '').toLowerCase()===color.toLowerCase(),payload:{color}}))},
      reorder('group',state.groups.indexOf(group),state.groups.length),
      {id:'group-sort',label:'Ordenar sessões',disabled:group.sessions.length<2,children:[item('group-sort-sessions','Nome de A a Z',{id:'group-sort-asc',payload:{descending:false}}),item('group-sort-sessions','Nome de Z a A',{id:'group-sort-desc',payload:{descending:true}})]},separator,
      item('group-expanded',state.expanded[group.id]?'Recolher grupo':'Expandir grupo',{payload:{expanded:!state.expanded[group.id]}}),
      item('groups-expanded','Expandir todos os grupos',{id:'groups-expand',payload:{expanded:true},disabled:state.groups.every(candidate=>state.expanded[candidate.id])}),
      item('groups-expanded','Recolher todos os grupos',{id:'groups-collapse',payload:{expanded:false},disabled:state.groups.every(candidate=>!state.expanded[candidate.id])}),separator,
      {id:'group-trash-notes',label:'Enviar notas à lixeira…',danger:true,disabled:!count,action:()=>confirm(host,'group-trash-notes',{id},'Enviar notas à lixeira?',`As ${count} notas de “${group.name}” poderão ser restauradas nas configurações. O grupo e suas sessões serão mantidos.`,'Enviar à lixeira')},
      {id:'group-delete',label:'Excluir grupo…',danger:true,action:()=>confirm(host,'group-delete',{id},'Excluir grupo?',`“${group.name}” e suas ${group.sessions.length} sessões serão excluídos. ${count} notas serão enviadas à lixeira e poderão ser restauradas.`,'Excluir grupo')}
    ];
  }
  if(kind==='session') {
    const session=sessionsOf(state).find(candidate=>candidate.id===id);if(!session)return [];
    const notes=state.notes.filter(note=>note.s===id&&active(note));
    return [
      item('session-open','Abrir sessão'),item('session-new-note','Nova nota nesta sessão'),
      {id:'session-create',label:'Nova sessão neste grupo…',action:()=>prompt(host,'session-create',{id:session.group.id},'Nova sessão','Nome da sessão','')},
      {id:'session-rename',label:'Renomear sessão…',action:()=>prompt(host,'session-rename',{id},'Renomear sessão','Nome da sessão',session.name)},item('session-duplicate','Duplicar sessão e notas'),separator,
      {id:'session-move',label:'Mover para grupo',disabled:state.groups.length<2,children:state.groups.map(group=>item('session-move',group.name,{id:group.id,color:group.color,disabled:group.id===session.group.id,payload:{groupId:group.id}}))},
      reorder('session',session.group.sessions.findIndex(candidate=>candidate.id===id),session.group.sessions.length),
      {id:'session-sort',label:'Ordenar notas',disabled:notes.length<2,children:[item('session-sort-notes','Título de A a Z',{id:'session-sort-asc',payload:{order:'title-asc'}}),item('session-sort-notes','Título de Z a A',{id:'session-sort-desc',payload:{order:'title-desc'}}),item('session-sort-notes','Inverter ordem atual',{id:'session-sort-reverse',payload:{order:'reverse'}})]},separator,
      item('session-open-notes','Abrir todas as notas',{disabled:!notes.length}),item('session-close-notes','Fechar todos os painéis',{disabled:!state.openBy[id]?.length}),
      {id:'session-move-notes',label:'Mover notas para',disabled:!notes.length,children:destinations('session-move-notes',id)},separator,
      {id:'session-trash-notes',label:'Enviar notas à lixeira…',danger:true,disabled:!notes.length,action:()=>confirm(host,'session-trash-notes',{id},'Enviar notas à lixeira?',`As ${notes.length} notas de “${session.name}” poderão ser restauradas nas configurações. A sessão será mantida.`,'Enviar à lixeira')},
      {id:'session-delete',label:'Excluir sessão…',danger:true,action:()=>confirm(host,'session-delete',{id},'Excluir sessão?',`“${session.name}” será excluída. ${notes.length} notas serão enviadas à lixeira e poderão ser restauradas.`,'Excluir sessão')}
    ];
  }
  return [];
}
