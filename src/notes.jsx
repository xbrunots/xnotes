import React from 'react';
import {ReferenceNotes} from './reference-logic';
import {RichEditor} from './rich-editor';
import {ColorPicker,Toggle,Slider,PlusIcon} from './controls';
import {ThemePicker} from './theme-picker';
import {resolveTheme,themeVariables} from './themes';
import {plainText} from './note-content';
import {ContextMenu,ContextActionDialog} from './context-menu';
import {buildContextItems,contextMenuTitle,invokeContextAction} from './context-actions';
import {LayoutPicker,WorkspaceTabs} from './workspace-layout';
import {applyWorkspaceDrop,canWorkspaceDrop,readWorkspaceDrag,writeWorkspaceDrag} from './organize-workspace';
import {ResizeHandle} from './resizable-panels';
import {PANEL_LIMITS,calculatePanelLayout,calculateNoteWidths,normalizePanelSizes} from './panel-sizing';
import {EditorWorkspace} from './masonry-workspace';
import {resolveNoteTheme,noteThemeVariables} from './note-themes';
import {NoteThemeControl} from './note-theme-picker';
import {GitHubIcon,GitHubPanel,GitHubConflictPanel,githubWorking} from './github-ui';
import {convertSelectionToCode,insertCodeBlock} from './code-commands';
import {pastedCodeLanguage} from './code-languages';
import {NotionImport} from './notion-import';

const PERSISTED = ['panelSizes','appearance','noteDisplay','theme','themePreset','themeChoices','accent','motion','blur','groups','notes','openBy','focusBy','session','view','tag','expanded','layout','sidebar'];
const serial = state => Object.fromEntries(PERSISTED.filter(key=>key in state).map(key=>[key,state[key]]));
const extras = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([key])=>!PERSISTED.includes(key)));
const equal = (a,b) => {
  if(Object.is(a,b))return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
};
const clone = value => structuredClone(value);
const id = prefix => prefix + '-' + crypto.randomUUID();

// Rebase keystrokes entered while an asynchronous disk save was in flight.
// Only locally changed fields are overlaid; incoming entities remain intact.
function rebaseObject(remote, before, after) {
  const result = {...remote};
  for (const key of new Set([...Object.keys(before || {}),...Object.keys(after || {})])) {
    if (equal(before?.[key],after?.[key])) continue;
    if (['notes','groups','sessions'].includes(key) && Array.isArray(after?.[key])) result[key] = rebaseEntities(remote?.[key] || [],before?.[key] || [],after[key]);
    else if (!(key in (after || {}))) delete result[key];
    else result[key] = after[key];
  }
  return result;
}
function rebaseEntities(remote,before,after) {
  const old = new Map(before.map(x=>[x.id,x])); const current = new Map(after.map(x=>[x.id,x]));
  const result = new Map(remote.map(x=>[x.id,x]));
  for (const item of after) if (!equal(old.get(item.id),item)) result.set(item.id,rebaseObject(result.get(item.id),old.get(item.id),item));
  for (const item of before) if (!current.has(item.id)) result.delete(item.id);
  const order = [...after.map(x=>x.id),...remote.map(x=>x.id).filter(key=>!current.has(key))];
  return [...new Set(order)].filter(key=>result.has(key)).map(key=>result.get(key));
}

function CloseIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>; }

class Modal extends React.Component {
  ref=React.createRef();
  componentDidMount() { this.previous=document.activeElement; this.ref.current?.querySelector('input,button,[tabindex="0"]')?.focus(); }
  componentWillUnmount() { if(this.previous?.isConnected)this.previous.focus(); }
  onKey=event=>{
    if(event.key==='Escape'){event.stopPropagation();this.props.onClose();}
    if(event.key==='Tab'){
      const elements=[...this.ref.current.querySelectorAll('button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),[tabindex="0"],a[href]')];
      const first=elements[0],last=elements[elements.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  };
  render(){return <div className="dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)this.props.onClose();}} onKeyDown={this.onKey}><section ref={this.ref} className={'dialog '+(this.props.wide?'dialog-wide':'')} role="dialog" aria-modal="true" aria-label={this.props.title}><header><h1>{this.props.title}</h1><button className="icon-button" aria-label="Fechar janela" onClick={this.props.onClose}><CloseIcon/></button></header>{this.props.children}</section></div>;}
}

export class Notes extends ReferenceNotes {
  constructor(props){
    super(props);
    this.state={...this.state,...serial(props.snapshot),githubStatus:props.sync,dialog:props.onboarding?'github':null,dialogName:'',toast:null,saveError:null,busy:false};
    this.persistentExtras=clone(extras(props.snapshot));
    this.confirmed=clone(props.snapshot); this.savePromise=null; this.pendingRemote=null; this.mounted=false;
  }
  motion(){return this.state.motion!==false&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;}
  theme(){return resolveTheme(this.state.themePreset,this.state.theme || super.theme()).mode;}
  chooseTheme=presetId=>{const preset=resolveTheme(presetId);this.setState(st=>({theme:preset.mode,themePreset:preset.id,themeChoices:{...st.themeChoices,[preset.mode]:preset.id}}));};
  setTheme(mode){if(mode===this.theme())return;const choice=resolveTheme(this.state.themeChoices?.[mode],mode);this.chooseTheme(choice.id);}
  editors=new Map();
  plainText=plainText;
  copyText=text=>window.notes.copyText(text);
  focusEditor=noteId=>{const editor=this.editors.get(noteId);if(!editor){this.pendingEditorFocus=noteId;return;}this.pendingEditorFocus=null;editor.commands.focus('end',{scrollIntoView:false});};
  openSessionNote=sessionId=>{
    this.setState(st=>{const notes=st.notes.filter(note=>note.s===sessionId&&!note.deletedAt),last=st.focusBy[sessionId],selected=notes.find(note=>note.id===last) || notes[0];return {session:sessionId,view:'session',tag:null,editing:null,openBy:{...st.openBy,[sessionId]:selected?[selected.id]:[]},focusBy:{...st.focusBy,[sessionId]:selected?.id || null}};});
  };
  openContextMenu=(event,kind,entityId)=>{
    event.preventDefault();event.stopPropagation();this.setState({themeNoteId:null,contextMenu:{kind,id:entityId,x:event.clientX,y:event.clientY}});
  };
  setNoteDisplay=noteDisplay=>{if(['single','split','grid'].includes(noteDisplay))this.setState({noteDisplay,layout:noteDisplay==='single'?'focus':'split'});};
  panelSizesForRender=()=>this.state.panelSizePreview || normalizePanelSizes(this.state.panelSizes);
  clearPanelPreview=()=>{if(this.mounted)this.setState({panelSizePreview:null});};
  changePanelSize=(kind,key,value,commit=false)=>this.setState(state=>{
    const sizes=normalizePanelSizes(commit?state.panelSizes:state.panelSizePreview || state.panelSizes);
    const next=normalizePanelSizes(key?{...sizes,[kind]:{...sizes[kind],[key]:value}}:{...sizes,[kind]:value});
    return commit?{panelSizes:next,panelSizePreview:null}:{panelSizePreview:next};
  });
  renderPanelResize(kind){
    const layout=this.panelLayout || calculatePanelLayout({width:this.state.w}),limits=layout[kind+'Limits'];
    return <ResizeHandle value={kind==='sidebar'?layout.sidebarWidth:layout.listWidth} {...limits} defaultValue={kind==='sidebar'?(this.state.w<1100?220:244):(this.state.w<1100?264:300)} label={kind==='sidebar'?'Redimensionar barra lateral':'Redimensionar lista de notas'} controls={kind==='sidebar'?'notes-navigation-panel':'notes-list-panel'} style={{right:0}} onChange={value=>this.changePanelSize(kind,null,value)} onCommit={value=>this.changePanelSize(kind,null,value,true)} onCancel={this.clearPanelPreview}/>;
  }
  sidebarSectionMax=()=>Math.max(100,Math.min(1600,(this.state.sidebarSectionsHeight || document.querySelector('[data-sidebar-sections]')?.clientHeight || window.innerHeight-200)-94));
  sidebarGroupHeight=()=>{const value=this.panelSizesForRender().sections?.groups;return value?Math.min(value,this.sidebarSectionMax()):undefined;};
  renderSectionResize(){
    const actual=this.state.sidebarGroupMeasuredHeight || document.querySelector('[data-sidebar-groups]')?.getBoundingClientRect().height || 300,max=this.sidebarSectionMax();
    return <ResizeHandle axis="y" value={this.sidebarGroupHeight() || Math.min(actual,max)} getValue={()=>document.querySelector('[data-sidebar-groups]')?.getBoundingClientRect().height || actual} min={80} max={max} defaultValue={300} label="Redimensionar grupos e tags" style={{bottom:0}} onChange={value=>this.changePanelSize('sections','groups',value)} onCommit={value=>this.changePanelSize('sections','groups',value,true)} onCancel={this.clearPanelPreview}/>;
  }
  noteThemeId=note=>resolveNoteTheme(note?.noteTheme)?.id;
  openNoteThemes=noteId=>{this.openNote(noteId);this.setState({themeNoteId:noteId,dialog:null,contextMenu:null});};
  renderNoteThemeControl(p){return <NoteThemeControl value={this.noteThemeId(p.note)} open={this.state.themeNoteId===p.id&&!this.state.dialog&&!this.state.palette} onToggle={()=>this.setState(state=>({themeNoteId:state.themeNoteId===p.id?null:p.id}))} onClose={()=>this.setState(state=>state.themeNoteId===p.id?{themeNoteId:null}:null)} onChange={noteTheme=>this.updateNote(p.id,{noteTheme:noteTheme || null})} variables={this.materialVars}/>;}
  notePaneStyle(p){return {...noteThemeVariables(p.note?.noteTheme),...(this.state.noteDisplay==='split'?{'--pane-width':(this.noteWidths?.[p.id] || 300)+'px'}:{})};}
  renderNoteResize(p){
    if(!['split','grid'].includes(this.state.noteDisplay))return null;
    const grid=this.state.noteDisplay==='grid',element=document.querySelector('[data-pane="'+CSS.escape(String(p.id))+'"]');
    const value=grid?(element?.getBoundingClientRect().width || 300):(this.noteWidths?.[p.id] || 300);
    const max=grid?Math.min(PANEL_LIMITS.note.max,Math.max(260,(this.panelLayout?.editorWidth || 600)-28)):PANEL_LIMITS.note.max;
    return <ResizeHandle value={value} getValue={()=>document.querySelector('[data-pane="'+CSS.escape(String(p.id))+'"]')?.getBoundingClientRect().width || value} min={260} max={max} defaultValue={300} label={'Redimensionar nota '+(p.title || 'Sem título')} style={{right:0}} onChange={width=>this.changePanelSize('notes',p.id,width)} onCommit={width=>this.changePanelSize('notes',p.id,width,true)} onCancel={this.clearPanelPreview}/>;
  }
  renderEditorWorkspace(children){return <EditorWorkspace ref={this.paneWrap} display={this.state.noteDisplay || 'single'} panelSizes={this.panelSizesForRender()}>{React.Children.toArray(children)}</EditorWorkspace>;}
  startWorkspaceDrag=(event,source)=>{
    if(!writeWorkspaceDrag(event.dataTransfer,source)){event.preventDefault();return;}
    event.stopPropagation();this.dragSource=source;event.currentTarget.dataset.dragging='true';
  };
  endWorkspaceDrag=()=>{this.dragSource=null;document.querySelectorAll('[data-drop-target],[data-dragging]').forEach(el=>{el.removeAttribute('data-drop-target');el.removeAttribute('data-dragging');});};
  dropPosition=(event,source,target)=>source?.kind==='note'&&target.kind==='session'||source?.kind==='session'&&target.kind==='group'?'inside':event.clientY<event.currentTarget.getBoundingClientRect().top+event.currentTarget.getBoundingClientRect().height/2?'before':'after';
  dragOver=(event,target)=>{
    const source=this.dragSource || readWorkspaceDrag(event.dataTransfer),position=this.dropPosition(event,source,target);
    if(!canWorkspaceDrop(this.state,source,target,position))return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';event.currentTarget.dataset.dropTarget=position;
  };
  dragLeave=event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.removeAttribute('data-drop-target');};
  dropWorkspace=(event,target)=>{
    const source=readWorkspaceDrag(event.dataTransfer) || this.dragSource,position=this.dropPosition(event,source,target);
    if(!canWorkspaceDrop(this.state,source,target,position))return;
    event.preventDefault();event.stopPropagation();this.setState(state=>applyWorkspaceDrop(state,source,target,position));this.endWorkspaceDrag();
  };
  moveWorkspaceByKeyboard=(source,direction)=>{
    const ordered=source.kind==='group'?this.state.groups:source.kind==='session'?this.state.groups.find(g=>g.sessions.some(s=>s.id===source.id))?.sessions:this.state.notes.filter(n=>n.s===this.state.session&&!n.deletedAt);
    const index=ordered?.findIndex(item=>item.id===source.id),target=ordered?.[index+direction];
    if(target)this.setState(state=>applyWorkspaceDrop(state,source,{kind:source.kind,id:target.id},direction<0?'before':'after'));
  };
  renderWorkspaceTabs(){
    const existing=new Map(this.activeNotes().map(note=>[note.id,note])),ids=[...new Set(this.state.openBy[this.state.session] || [])].filter(id=>existing.has(id));
    return <WorkspaceTabs tabs={ids.map(id=>({id,title:existing.get(id).title}))} activeId={this.state.focusBy[this.state.session]} display={this.state.noteDisplay || 'single'} onFocus={id=>this.setFocus(id)} onClose={id=>this.closeNote(id)} onDisplay={this.setNoteDisplay} onReorder={(source,target,position)=>this.setState(state=>applyWorkspaceDrop(state,source,target,position))}/>;
  }
  editorCommand=command=>this.run(async()=>{
    const editor=this.editors.get(this.activeEditorId);
    if(!editor||editor.isDestroyed){this.lastTextControl?.focus();return window.notes.nativeEdit(command);}
    if(command==='undo'||command==='redo'||command==='selectAll')return editor.chain().focus()[command]().run();
    if(command==='copy'||command==='cut'){const {from,to}=editor.state.selection;if(from!==to){await this.copyText(editor.state.doc.textBetween(from,to,'\n'));if(command==='cut')editor.chain().focus().deleteSelection().run();}return;}
    if(command==='paste'){const text=await window.notes.readClipboard();if(text){const language=pastedCodeLanguage(text);if(language)insertCodeBlock(editor,text,language);else editor.chain().focus().insertContent(text,{contentType:'markdown'}).run();}}
  });
  contextItems(menu){
    const items=buildContextItems(this,menu.kind,menu.id),editor=this.editors.get(menu.id);
    if(menu.kind!=='note'||!editor||editor.isDestroyed)return items;
    const selected=!editor.state.selection.empty;
    const copy=async cut=>{const {from,to}=editor.state.selection;await this.copyText(editor.state.doc.textBetween(from,to,'\n'));if(cut)editor.chain().focus().deleteSelection().run();};
    return [
      {id:'editor-undo',label:'Desfazer',disabled:!editor.can().undo(),action:()=>editor.chain().focus().undo().run()},
      {id:'editor-redo',label:'Refazer',disabled:!editor.can().redo(),action:()=>editor.chain().focus().redo().run()},
      {separator:true},
      {id:'editor-cut',label:'Recortar seleção',disabled:!selected,action:()=>this.run(()=>copy(true))},
      {id:'editor-copy',label:'Copiar seleção',disabled:!selected,action:()=>this.run(()=>copy(false))},
      {id:'editor-paste',label:'Colar',action:()=>this.run(async()=>{const text=await window.notes.readClipboard();if(text){const language=pastedCodeLanguage(text);if(language)insertCodeBlock(editor,text,language);else editor.chain().focus().insertContent(text,{contentType:'markdown'}).run();}})},
      {id:'editor-all',label:'Selecionar todo o texto',action:()=>editor.chain().focus().selectAll().run()},
      {id:'editor-code',label:'Transformar seleção em código (Monaco)',disabled:!selected,action:()=>convertSelectionToCode(editor)},
      {separator:true},...items,
    ];
  }
  componentDidMount(){
    this.mounted=true; super.componentDidMount();
    this.off=[window.notes.onWorkspace(this.receive),window.notes.onSync(this.receiveGitHubStatus),window.notes.onAction(this.onAction),window.notes.onBeforeClose(this.beforeClose),window.notes.onImportProgress(progress=>this.setState({importProgress:progress}))];
    if(this.props.onboarding){this.inspectGitHub();window.notes.dismissOnboarding().catch(()=>{});}
    if(this.state.githubStatus.state==='conflict')this.loadGitHubConflicts();
    if(this.props.recovery || this.props.warning)this.showToast(this.props.warning || 'Uma cópia de segurança foi recuperada. Os arquivos originais foram preservados.',7000);
    this.extraKey=event=>{
      if(event.key==='F11'){event.preventDefault();window.notes.window('fullscreen').catch(error=>this.showToast(error.message));}
      else if((event.ctrlKey||event.metaKey)&&event.key===','){event.preventDefault();this.openDialog('settings');}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='b'&&!event.target.isContentEditable&&!event.defaultPrevented){event.preventDefault();this.setState(st=>({sidebar:!st.sidebar}));}
      else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(event.shiftKey)this.syncGitHub();else this.run(async()=>{await this.flushAll();this.showToast('Notas salvas neste dispositivo.');});}
      else if((event.ctrlKey||event.metaKey)&&event.key==='Delete'&&!event.target.isContentEditable&&!['INPUT','TEXTAREA'].includes(event.target.tagName)){
        const focused=this.state.focusBy[this.state.session];if(focused)this.trashNote(focused);
      }
    };
    window.addEventListener('keydown',this.extraKey);
    this.trackTextFocus=event=>{const dom=event.target.closest?.('[data-editor]');if(dom){this.activeEditorId=dom.dataset.editor;this.lastTextControl=null;}else if(['INPUT','TEXTAREA'].includes(event.target.tagName)){this.activeEditorId=null;this.lastTextControl=event.target;}};
    document.addEventListener('focusin',this.trackTextFocus);
    this.sectionObserver=new ResizeObserver(()=>{
      if(!this.mounted)return;
      const sidebarSectionsHeight=Math.round(document.querySelector('[data-sidebar-sections]')?.clientHeight || 0),sidebarGroupMeasuredHeight=Math.round(document.querySelector('[data-sidebar-groups]')?.getBoundingClientRect().height || 0);
      if(sidebarSectionsHeight!==this.state.sidebarSectionsHeight || sidebarGroupMeasuredHeight!==this.state.sidebarGroupMeasuredHeight)this.setState({sidebarSectionsHeight,sidebarGroupMeasuredHeight});
    });
    for(const selector of ['[data-sidebar-sections]','[data-sidebar-groups]']){const node=document.querySelector(selector);if(node)this.sectionObserver.observe(node);}
  }
  componentWillUnmount(){
    this.mounted=false;super.componentWillUnmount();this.off?.forEach(fn=>fn());clearTimeout(this.saveTimer);clearTimeout(this.toastTimer);
    window.removeEventListener('keydown',this.extraKey);
    document.removeEventListener('focusin',this.trackTextFocus);
    this.sectionObserver?.disconnect();
  }
  componentDidUpdate(previousProps,previousState){
    super.componentDidUpdate(previousProps,previousState);
    if(PERSISTED.some(key=>previousState[key]!==this.state[key])&&!equal(this.snapshotForSave(),this.confirmed))this.scheduleSave();
  }
  snapshotForSave=()=>({...this.persistentExtras,...serial(this.state)});
  scheduleSave(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.flush().catch(()=>{}),140);}
  receive=snapshot=>{
    if(this.savePromise||!equal(this.snapshotForSave(),this.confirmed)){this.pendingRemote=snapshot;return;}
    this.confirmed=clone(snapshot);this.persistentExtras=clone(extras(snapshot));this.setState(serial(snapshot));
  };
  drainPending=async()=>{
    while(this.pendingRemote&&equal(this.snapshotForSave(),this.confirmed)){
      const snapshot=this.pendingRemote;this.pendingRemote=null;this.confirmed=clone(snapshot);
      this.persistentExtras=clone(extras(snapshot));
      await new Promise(resolve=>this.setState(serial(snapshot),resolve));
    }
  };
  flush=()=>{
    clearTimeout(this.saveTimer);
    if(this.savePromise)return this.savePromise;
    const sent=clone(this.snapshotForSave());
    if(equal(sent,this.confirmed))return this.drainPending();
    this.savePromise=window.notes.save(sent,this.confirmed).then(result=>new Promise(resolve=>{
      const canonical=this.pendingRemote || result;this.pendingRemote=null;
      const rebased=rebaseObject(canonical,sent,this.snapshotForSave());
      this.confirmed=clone(canonical);
      this.persistentExtras=clone(extras(rebased));
      this.setState({...serial(rebased),saveError:null},resolve);
    })).catch(error=>{this.setState({saveError:error.message});throw error;}).finally(async()=>{this.savePromise=null;await this.drainPending();});
    return this.savePromise;
  };
  flushAll=async()=>{do{await this.flush();}while(!equal(this.snapshotForSave(),this.confirmed));};
  beforeClose=async()=>{try{await this.flushAll();window.notes.finishClose();}catch(error){this.showToast('Não foi possível salvar: '+error.message,8000);}};
  run=async task=>{this.setState({busy:true});try{return await task();}catch(error){this.showToast(error.message,6500);}finally{this.setState({busy:false});}};
  showToast=(text,duration=3400)=>{clearTimeout(this.toastTimer);this.setState({toast:text});this.toastTimer=setTimeout(()=>{if(this.mounted)this.setState({toast:null});},duration);};
  openDialog=type=>{this.setState({dialog:type,themeNoteId:null,palette:false,dialogName:'',navigationOpen:false});if(type==='github')this.inspectGitHub();};
  closeDialog=()=>this.setState({dialog:null});
  newNote(title,body){
    const noteId=id('n');
    this.setState(st=>{const s=st.session;const list=[...(st.openBy[s] || []),noteId];return{notes:[{id:noteId,s,t:'Agora',title:title || '',body:body || ''},...st.notes],openBy:{...st.openBy,[s]:list},focusBy:{...st.focusBy,[s]:noteId},editing:noteId,view:'session',tag:null};});
  }
  addSession(gid){
    const sessionId=id('s');
    this.setState(st=>({groups:st.groups.map(g=>g.id===gid?{...g,sessions:[...g.sessions,{id:sessionId,name:'Nova sessão'}]}:g),expanded:{...st.expanded,[gid]:true},openBy:{...st.openBy,[sessionId]:[]},session:sessionId,view:'session',tag:null}));
  }
  toggleTodo(noteId,line){
    this.setState(st=>({notes:st.notes.map(note=>{
      if(note.id!==noteId)return note;
      const lines=note.body.split('\n');
      if(!/^\s*[-*+]\s+\[[ xX]\]/.test(lines[line] || ''))return note;
      lines[line]=lines[line].replace(/^(\s*[-*+]\s+\[)([ xX])\]/,(_match,prefix,done)=>prefix+(done===' '?'x':' ')+']');
      return {...note,body:lines.join('\n'),t:'Agora'};
    })}));
  }
  daily(){
    const now=new Date(),key=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
    const existing=this.activeNotes().find(n=>n.dailyKey===key);
    if(existing){this.selectSession(existing.s);this.openNote(existing.id);return;}
    const session=this.state.groups.find(g=>g.id==='g1')?.sessions[0]?.id || this.state.groups[0]?.sessions[0]?.id;
    if(!session)return;
    const noteId=id('n');const title=now.toLocaleDateString('pt-BR',{day:'numeric',month:'long'});
    this.setState(st=>({notes:[{id:noteId,s:session,title,body:'## Intenção do dia\n- [ ] \n\n## Notas\n',t:'Agora',dailyKey:key},...st.notes],session,view:'session',tag:null,openBy:{...st.openBy,[session]:[...(st.openBy[session] || []),noteId]},focusBy:{...st.focusBy,[session]:noteId},editing:noteId}));
  }
  trashNote=noteId=>{
    const note=this.state.notes.find(n=>n.id===noteId);if(!note)return;
    this.setState(st=>({notes:st.notes.map(n=>n.id===noteId?{...n,deletedAt:new Date().toISOString()}:n),openBy:Object.fromEntries(Object.entries(st.openBy).map(([s,ids])=>[s,ids.filter(x=>x!==noteId)])),editing:st.editing===noteId?null:st.editing}));
    this.showToast('Nota movida para a lixeira. Você pode restaurá-la nas configurações.');
  };
  restoreNote=noteId=>this.setState(st=>({notes:st.notes.map(n=>{if(n.id!==noteId)return n;const copy={...n};delete copy.deletedAt;return copy;})}));
  onAction=action=>{
    const note=this.state.notes.find(n=>n.id===action.id);
    if(action.type==='new-note')this.newNote();
    else if(action.type==='editor-command')this.editorCommand(action.command);
    else if(action.type==='daily-note')this.daily();
    else if(action.type==='open-dialog')this.openDialog(action.dialog);
    else if(action.type==='search')this.setState({palette:true,pq:'',psel:0});
    else if(action.type==='toggle-sidebar')this.setState(st=>({sidebar:!st.sidebar}));
    else if(action.type==='set-layout')this.setNoteDisplay(action.layout==='grid'?'grid':action.layout==='split'?'split':'single');
    else if(action.type==='set-appearance'&&['standard','islands'].includes(action.appearance))this.setState({appearance:action.appearance});
    else if(action.type==='import-backup')this.run(async()=>{await this.flushAll();const count=await window.notes.importBackup();if(count!==null)this.showToast(count+' notas importadas.');});
    else if(action.type==='export-backup')this.run(async()=>{await this.flushAll();if(await window.notes.exportBackup())this.showToast('Backup exportado.');});
    else if(action.type==='trash-note')this.trashNote(action.id);
    else if(action.type==='edit-note'){this.openNote(action.id);this.setState({editing:action.id});}
    else if(action.type==='duplicate-note'&&note)invokeContextAction(this,'note-duplicate',{id:note.id});
    else if(action.type==='move-note')this.setState(st=>({notes:st.notes.map(n=>n.id===action.id?{...n,s:action.sessionId,t:'Agora'}:n)}));
    else if(action.type==='export-note')this.run(async()=>{await this.flushAll();const file=await window.notes.exportNote(action.id);if(file)this.showToast('Nota exportada.');});
    else if(action.type==='new-session')this.addSession(action.id);
    else if(action.type==='new-group')this.openDialog('new-group');
    else if(action.type==='rename-group'){const group=this.state.groups.find(g=>g.id===action.id);this.setState({dialog:'rename-group',dialogName:group?.name || '',editingGroup:action.id});}
  };
  submitName=event=>{
    event.preventDefault();const name=this.state.dialogName.trim();if(!name)return;
    if(this.state.dialog==='rename-group')this.setState(st=>({groups:st.groups.map(g=>g.id===st.editingGroup?{...g,name}:g),dialog:null}));
    else{const groupId=id('g'),sessionId=id('s');this.setState(st=>({groups:[...st.groups,{id:groupId,name,color:'#7D7AFF',sessions:[{id:sessionId,name:'Nova sessão'}]}],expanded:{...st.expanded,[groupId]:true},openBy:{...st.openBy,[sessionId]:[]},session:sessionId,view:'session',tag:null,dialog:null}));}
  };
  extraCommands(){
    return [
      ['GitHub','Repositório privado, histórico e sincronização diária',()=>this.openDialog('github')],
      ['Configurações','Aparência, backups e lixeira',()=>this.openDialog('settings')],
      ['Novo grupo','Organizar suas sessões',()=>this.openDialog('new-group')],
      ['Importar do Notion','Páginas, bancos de dados e anexos',()=>this.openDialog('import-notion')],
      ['Importar do Obsidian','Cofre, notas, links e anexos',()=>this.openDialog('import-obsidian')],
      ['Nova sessão','No grupo atual',()=>{const group=this.state.groups.find(g=>g.sessions.some(s=>s.id===this.state.session));if(group)this.addSession(group.id);}],
    ].map(([label,sub,run])=>({label,sub,run}));
  }
  renderVals(){
    const values=super.renderVals();
    values.isDesktop=false;
    values.pRows=values.pRows.map(row=>({...row,isCreation:row.isAction&&/^(Nova |Novo |Criar |Adicionar |Abrir nota do dia)/.test(row.label)}));
    values.vars={...values.vars,...themeVariables(resolveTheme(this.state.themePreset,this.theme()))};
    const pins=new Set(this.state.notes.filter(n=>n.pinned).map(n=>n.id));
    values.list.sort((a,b)=>Number(pins.has(b.id))-Number(pins.has(a.id)));
    values.panes=[...new Map(values.panes.map(p=>[p.id,p])).values()];
    values.noPanes=values.panes.length===0;
    this.panelLayout=calculatePanelLayout({width:this.state.w,appearance:this.state.appearance,sidebar:this.state.sidebar!==false,panelSizes:this.panelSizesForRender()});
    values.cols=this.panelLayout.columns;
    this.noteWidths=calculateNoteWidths({ids:values.panes.map(p=>p.id),availableWidth:this.panelLayout.editorWidth-(this.state.appearance==='islands'?2:28),panelSizes:this.panelSizesForRender(),gap:0}).widths;
    this.materialVars=values.vars;
    return values;
  }
  receiveGitHubStatus=status=>{if(!this.mounted)return;const previous=this.state.githubStatus.state;this.setState({githubStatus:status,...(['installing','authenticating'].includes(status.state)?{dialog:'github'}:{})});if(status.state==='conflict'&&previous!=='conflict')this.loadGitHubConflicts();};
  inspectGitHub=async()=>{try{const result=await window.notes.inspectGitHub();if(this.mounted)this.setState({githubInspection:result.inspection || result,...(result.status?{githubStatus:result.status}:{})});}catch(error){this.showToast(error.message);}};
  loadGitHubConflicts=async()=>{try{const conflictSession=await window.notes.getGitHubConflicts();if(this.mounted&&(conflictSession?.items?.length||conflictSession?.conflicts?.length))this.setState({conflictSession,dialog:'github-conflicts'});}catch(error){this.showToast(error.message);}};
  resolveGitHubConflicts=payload=>this.run(async()=>{await this.flushAll();const status=await window.notes.resolveGitHubConflicts(payload);this.setState({githubStatus:status});if(status.state==='conflict')await this.loadGitHubConflicts();else this.setState({dialog:'github',conflictSession:null});});
  syncGitHub=()=>this.run(async()=>{await this.flushAll();const status=await window.notes.syncNow();if(status)this.receiveGitHubStatus(status);if(['auth-required','disconnected'].includes(status?.state))this.openDialog('github');});
  connectGitHub=()=>this.run(async()=>{
    await this.flushAll();this.setState({dialog:'github',connecting:true});
    try{const status=await window.notes.connectGitHub();if(status)this.receiveGitHubStatus(status);}
    finally{this.setState({connecting:false});}
  });
  disconnectGitHub=async()=>{try{const status=await window.notes.disconnectGitHub();if(this.mounted)this.setState({githubStatus:status,connecting:false});}catch(error){this.showToast(error.message);}};
  renderGitHubControl(){
    const status=this.state.githubStatus,connected=!!status.connected;
    const label=status.state==='conflict'?'Comparar versões':status.state==='syncing'?'Sincronizando…':status.state==='offline'?'Offline · salvo localmente':status.state==='error'?'Requer atenção':status.pending&&connected?'Alterações aguardando envio':connected?'Sincronização diária':'Conectar conta';
    return <button className="github-control" disabled={githubWorking(status.state)||this.state.busy} onClick={()=>status.state==='conflict'?this.loadGitHubConflicts():connected?this.syncGitHub():this.connectGitHub()} onContextMenu={event=>{event.preventDefault();this.openDialog('github');}} title={status.state==='conflict'?'Comparar versões Local e GitHub':connected?'Sincronizar agora (Ctrl+Shift+S) · botão direito para opções':'Conectar ao GitHub'} aria-label={status.state==='conflict'?'Comparar conflitos do GitHub':connected?'Sincronizar GitHub agora':'GitHub e sincronização'}><GitHubIcon/><span><strong>GitHub</strong><small>{label}</small></span><span className={'status-dot status-'+status.state}/></button>;
  }
  showAppMenu=(event,type)=>{const rect=event.currentTarget.getBoundingClientRect();window.notes.appMenu(type,{x:rect.left,y:rect.bottom}).catch(error=>this.showToast(error.message));};
  renderTitlebar(){
    return <header className="app-titlebar" data-appearance={this.state.appearance || 'standard'} aria-label="Barra de ferramentas do notes">
      <button className="titlebar-settings" aria-pressed={this.state.sidebar!==false} aria-label="Alternar barra lateral" title="Barra lateral (Ctrl+B)" onClick={()=>this.setState(st=>({sidebar:!st.sidebar}))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg></button>
      <div className="app-brand"><img src="./assets/icon.png" alt=""/><span>notes</span></div>
      <div className="titlebar-drag-space"/>
      <button className="titlebar-settings" title="Nova nota (Alt+N)" aria-label="Nova nota" data-create="note" onClick={()=>this.newNote()}><PlusIcon/></button>
      <button className="titlebar-settings" title="Buscar ou executar (Ctrl+K)" aria-label="Buscar notas" onClick={()=>this.setState({palette:true,pq:'',psel:0,navigationOpen:false})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg></button>
      {this.renderGitHubControl()}
      <button className="titlebar-settings" title="Configurações (Ctrl+,)" aria-label="Abrir configurações" onClick={()=>this.openDialog('settings')}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m9.5 3-.6 2.2-2 .9-2-.6-2.4 4.1L4 11.2v1.7l-1.5 1.7L5 18.7l2-.6 2 .9.5 2.2h5l.6-2.2 2-.9 2 .6 2.4-4.1-1.5-1.7v-1.7l1.5-1.6L19 5.5l-2 .6-2-.9L14.5 3Z"/><circle cx="12" cy="12" r="3"/></svg></button>
      <button className="titlebar-settings" title="Menu do aplicativo" aria-label="Menu do aplicativo" onClick={event=>this.showAppMenu(event,'all')}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button>
    </header>;
  }
  renderNoteEditor(p){
    return <RichEditor key={p.id} note={p.note} variables={{...this.materialVars,...noteThemeVariables(p.note?.noteTheme)}} onReady={editor=>{if(editor){this.editors.set(p.id,editor);if(this.pendingEditorFocus===p.id)this.focusEditor(p.id);}else this.editors.delete(p.id);}} onChange={(body,richText)=>this.updateNote(p.id,{body,richText})} onNote={title=>this.openByTitle(title)} onAsset={hash=>this.downloadAttachment(p.attachments.find(file=>file.hash===hash))} onExternal={url=>this.run(()=>window.notes.openExternal(url))} onFocus={()=>this.setState(st=>({focusBy:{...st.focusBy,[st.session]:p.id}}))}/>;
  }
  downloadAttachment=descriptor=>{if(descriptor)this.run(async()=>{if(await window.notes.saveAttachment(descriptor))this.showToast('Anexo salvo.');});};
  renderAttachments(p){
    if(!p.attachments?.length)return null;
    return <div className="note-attachments"><button onClick={()=>this.setState({dialog:'attachments',attachmentNoteId:p.id,attachmentQuery:'',attachmentLimit:100})}>{p.attachments.length} {p.attachments.length===1?'arquivo':'arquivos'}</button>{p.attachments.slice(0,2).map(file=><button key={file.hash+file.name} title={file.relativePath} onClick={()=>this.downloadAttachment(file)}>{file.name}</button>)}</div>;
  }
  importSource=(source,kind)=>this.run(async()=>{
    await this.flushAll();this.setState({importProgress:{phase:'Selecionando arquivos…'}});
    try{const report=await window.notes.importSource(source,kind);if(report)this.setState({dialog:'import-report',importReport:report,importReportLimit:30});}
    finally{this.setState({importProgress:null});}
  });
  renderImport(source){
    const notion=source==='notion';
    if(notion)return <Modal title="Importar do Notion" onClose={()=>{if(!this.state.busy)this.closeDialog();}}><NotionImport onBeforeImport={this.flushAll} onImported={report=>this.setState({dialog:'import-report',importReport:report,importReportLimit:30})} onArchive={kind=>this.importSource('notion',kind)} archiveProgress={this.state.importProgress} onClose={this.closeDialog}/></Modal>;
    const progress=this.state.importProgress;
    return <Modal title={notion?'Importar do Notion':'Importar do Obsidian'} onClose={()=>{if(!this.state.busy)this.closeDialog();}}>
      <div className="import-source-heading"><span className="source-monogram">{notion?'N':'O'}</span><div><h2>{notion?'Traga seu workspace.':'Traga seu cofre.'}</h2><p>O conteúdo original é preservado. Suas notas atuais continuam na biblioteca.</p></div></div>
      {notion?<ol className="import-instructions"><li>No Notion, abra <strong>Configurações → Geral → Exportar todo o conteúdo do workspace</strong>.</li><li>Selecione <strong>HTML</strong> (inclua comentários, quando disponível) ou <strong>Markdown e CSV</strong>, com subpáginas e arquivos.</li><li>Selecione aqui o ZIP baixado ou a pasta já extraída.</li></ol>:<ol className="import-instructions"><li>Localize a pasta do seu cofre no Obsidian.</li><li>Selecione a pasta inteira, incluindo suas subpastas e anexos, ou um ZIP desse cofre.</li><li>O notes organiza os caminhos em sessões e preserva notas, propriedades, tags, links e arquivos originais.</li></ol>}
      <div className="import-includes"><strong>{notion?'Páginas · subpáginas · HTML · Markdown · bancos CSV · anexos':'Markdown · pastas · frontmatter · tags · wikilinks · imagens · anexos'}</strong><p>{notion?'A importação usa os dados presentes na exportação. Histórico, permissões, visualizações e recursos que o Notion não exporta não podem ser reconstruídos.':'Canvas, bases, configurações e outros arquivos são preservados como anexos. Extensões e plugins do Obsidian não são executados no notes.'}</p></div>
      {progress&&<div className="import-progress" role="status"><span className="status-dot status-syncing"/>{typeof progress==='string'?progress:progress.message || progress.phase || ({scan:'Lendo arquivos',convert:'Convertendo notas',assets:'Preservando anexos',complete:'Concluído'}[progress.stage] || 'Importando arquivos')+(progress.files?' · '+progress.files:'')+'…'}</div>}
      <footer><button disabled={this.state.busy} onClick={this.closeDialog}>Cancelar</button><button disabled={this.state.busy} onClick={()=>this.importSource(source,notion?'folder':'zip')}>{notion?'Pasta extraída…':'Arquivo ZIP…'}</button><button className="primary" disabled={this.state.busy} onClick={()=>this.importSource(source,notion?'zip':'folder')}>{notion?'Selecionar ZIP…':'Selecionar cofre…'}</button></footer>
    </Modal>;
  }
  renderImportReport(){
    const report=this.state.importReport;
    const warnings=[...(report.warnings || []),...(report.excluded || []).map(item=>typeof item==='string'?item:JSON.stringify(item))];
    const sessions=new Map(this.state.groups.find(group=>group.id===report.groupId)?.sessions.map(session=>[session.id,session.name]) || []);
    const imported=this.state.notes.filter(note=>sessions.has(note.s)&&note.imported&&!note.imported.archive&&!note.deletedAt);
    const show=note=>this.setState(state=>({dialog:null,session:note.s,view:'session',tag:null,openBy:{...state.openBy,[note.s]:[...new Set([...(state.openBy[note.s] || []),note.id])]},focusBy:{...state.focusBy,[note.s]:note.id}}));
    return <Modal title="Importação concluída" onClose={this.closeDialog}><h2>{report.notes?'Seu conteúdo já está na biblioteca.':'Os arquivos foram preservados.'}</h2><p>{report.notes?'Os arquivos de origem foram preservados.':'Não encontramos páginas compatíveis neste arquivo. Consulte os originais e o relatório antes de considerar a migração concluída.'}</p><div className="import-stats"><div><strong>{report.notes || 0}</strong><span>notas</span></div><div><strong>{report.sessions || 0}</strong><span>sessões</span></div><div><strong>{report.files || 0}</strong><span>arquivos preservados</span></div></div>{report.source==='notion'?<p className="muted">{report.notionMigrationId?'O relatório reúne o conteúdo acessível desta conexão. Confira as observações antes de considerar a migração concluída.':'O relatório mostra o conteúdo recebido. Um ZIP de uma página isolada não inclui todo o workspace.'}</p>:null}<div className="migration-report-notes" aria-label="Notas importadas">{imported.slice(0,this.state.importReportLimit || 30).map(note=><button key={note.id} aria-label={(note.imported.format==='csv'?'Abrir tabela ':'Abrir nota ')+note.title} onClick={()=>show(note)}><span><strong>{note.title}</strong><small>{note.imported.format==='csv'?'Tabela':'Página'} · {sessions.get(note.s)}</small></span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>)}</div>{imported.length>(this.state.importReportLimit || 30)?<button onClick={()=>this.setState(state=>({importReportLimit:(state.importReportLimit || 30)+30}))}>Mostrar mais notas</button>:null}<p className="muted">Os anexos participam da sincronização diária ou manual com o GitHub. Os originais estão na nota de arquivos da importação.</p>{warnings.length>0&&<div className="import-warning"><strong>{warnings.length} {warnings.length===1?'observação':'observações'}</strong><ul>{warnings.slice(0,20).map((warning,i)=><li key={i}>{typeof warning==='string'?warning:JSON.stringify(warning)}</li>)}</ul>{warnings.length>20&&<p>Veja o relatório completo na nota de arquivos da importação.</p>}</div>}<footer><button className="primary" onClick={this.closeDialog}>Abrir biblioteca</button></footer></Modal>;
  }
  renderAttachmentDialog(){
    const note=this.state.notes.find(item=>item.id===this.state.attachmentNoteId);
    const files=(note?.attachments || []).filter(file=>(file.relativePath+' '+file.name).toLocaleLowerCase('pt-BR').includes((this.state.attachmentQuery || '').toLocaleLowerCase('pt-BR')));
    return <Modal title="Arquivos da nota" onClose={this.closeDialog}><input className="text-input" aria-label="Buscar arquivos" placeholder="Buscar pelo nome ou caminho…" value={this.state.attachmentQuery || ''} onChange={event=>this.setState({attachmentQuery:event.target.value,attachmentLimit:100})}/><div className="attachment-list">{files.slice(0,this.state.attachmentLimit || 100).map((file,i)=><button key={file.hash+i} onClick={()=>this.downloadAttachment(file)}><span>{file.relativePath || file.name}</span><small>{Math.ceil(file.size/1024)} KB · Salvar</small></button>)}</div>{files.length>(this.state.attachmentLimit || 100)&&<button onClick={()=>this.setState(st=>({attachmentLimit:(st.attachmentLimit || 100)+100}))}>Mostrar mais arquivos</button>}<footer><span className="version">{files.length} arquivos</span><button onClick={this.closeDialog}>Concluir</button></footer></Modal>;
  }
  renderGitHub(){
    const status=this.state.githubStatus;
    return <Modal title="GitHub" onClose={this.closeDialog}><GitHubPanel status={status} inspection={this.state.githubInspection} busy={this.state.busy} onConnect={this.connectGitHub} onSync={this.syncGitHub} onCancel={this.disconnectGitHub} onInspect={this.inspectGitHub} onFolder={()=>this.run(()=>window.notes.openGitHubFolder())} onRepository={()=>this.run(()=>window.notes.openGitHubRepository())} onConflicts={this.loadGitHubConflicts} onCopy={text=>this.run(async()=>{await this.copyText(text);})}/><footer>{status.connected&&<button className="quiet danger" onClick={this.disconnectGitHub}>Desconectar</button>}<button className="quiet" onClick={this.closeDialog}>Concluir</button></footer></Modal>;
  }
  renderSettings(){
    const trash=this.state.notes.filter(n=>n.deletedAt);
    return <Modal title="Configurações" onClose={this.closeDialog}>
      <LayoutPicker value={this.state.appearance || 'standard'} onChange={appearance=>this.setState({appearance})}/>
      <ThemePicker value={resolveTheme(this.state.themePreset,this.theme()).id} onChange={this.chooseTheme}/>
      <div className="settings-row"><span><strong>Cor de destaque</strong><small>O mesmo vidro, com a sua cor.</small></span><ColorPicker value={this.state.accent || 'Azul'} onChange={accent=>this.setState({accent})}/></div>
      <div className="settings-row"><span><strong>Movimento</strong><small>Animações e luzes de fundo.</small></span><Toggle label="Movimento" checked={this.state.motion!==false} onChange={motion=>this.setState({motion})}/></div>
      <div className="settings-row"><span><strong>Desfoque do vidro</strong><small>{this.state.blur ?? 28} px</small></span><Slider label="Desfoque do vidro" value={this.state.blur ?? 28} onChange={blur=>this.setState({blur})}/></div>
      <button className="settings-link" onClick={()=>this.openDialog('github')}><GitHubIcon/>GitHub e sincronização<span>{['disconnected','auth-required'].includes(this.state.githubStatus.state)?'Conectar':'Gerenciar'}</span></button>
      <div className="settings-section"><h2>Seus dados</h2><p className="muted">O backup inclui todas as notas, inclusive a lixeira. Importar adiciona os dados à biblioteca atual.</p><div className="dialog-actions"><button disabled={this.state.busy} onClick={()=>this.run(async()=>{await this.flushAll();if(await window.notes.exportBackup())this.showToast('Backup exportado.');})}>Exportar backup…</button><button disabled={this.state.busy} onClick={()=>this.run(async()=>{await this.flushAll();const count=await window.notes.importBackup();if(count!==null)this.showToast(count+' notas importadas.');})}>Importar backup…</button><button onClick={()=>this.openDialog('import-notion')}>Do Notion…</button><button onClick={()=>this.openDialog('import-obsidian')}>Do Obsidian…</button></div></div>
      <div className="settings-section"><h2>Lixeira <span className="muted">· {trash.length}</span></h2>{trash.length?<div className="trash-list">{trash.map(note=><div key={note.id}><span>{note.title || 'Sem título'}</span><button onClick={()=>this.restoreNote(note.id)}>Restaurar</button></div>)}</div>:<p className="muted">As notas excluídas aparecem aqui para restauração.</p>}</div>
      <footer><span className="version">notes {this.props.version} · Windows</span><button onClick={()=>this.openDialog('shortcuts')}>Atalhos</button><button className="primary" onClick={this.closeDialog}>Concluir</button></footer>
    </Modal>;
  }
  render(){
    const reference=super.render();
    return <>{reference}<div className="notes-overlays" style={this.materialVars}>
      {this.renderTitlebar()}
      {this.state.dialog==='github'&&this.renderGitHub()}
      {this.state.dialog==='github-conflicts'&&<Modal title="Comparar versões" onClose={this.closeDialog}><GitHubConflictPanel key={this.state.conflictSession?.sessionId} session={this.state.conflictSession} busy={this.state.busy} onResolve={this.resolveGitHubConflicts}/></Modal>}
      {this.state.dialog==='settings'&&this.renderSettings()}
      {this.state.dialog==='import-notion'&&this.renderImport('notion')}
      {this.state.dialog==='import-obsidian'&&this.renderImport('obsidian')}
      {this.state.dialog==='import-report'&&this.renderImportReport()}
      {this.state.dialog==='attachments'&&this.renderAttachmentDialog()}
      {this.state.contextMenu&&<ContextMenu key={[this.state.contextMenu.kind,this.state.contextMenu.id,this.state.contextMenu.x,this.state.contextMenu.y].join(':')} items={this.contextItems(this.state.contextMenu)} x={this.state.contextMenu.x} y={this.state.contextMenu.y} style={this.materialVars} label={contextMenuTitle(this.state,this.state.contextMenu.kind,this.state.contextMenu.id)} onClose={()=>this.setState({contextMenu:null})}/>}
      <ContextActionDialog host={this} Modal={Modal}/>
      {['new-group','rename-group'].includes(this.state.dialog)&&<Modal title={this.state.dialog==='new-group'?'Novo grupo':'Renomear grupo'} onClose={this.closeDialog}><form onSubmit={this.submitName}><label className="form-label" htmlFor="group-name">Nome do grupo</label><input id="group-name" className="text-input" value={this.state.dialogName} maxLength={100} onChange={e=>this.setState({dialogName:e.target.value})} placeholder="Ex.: Projetos pessoais"/><footer><button type="button" onClick={this.closeDialog}>Cancelar</button><button className="primary" type="submit" disabled={!this.state.dialogName.trim()} aria-label={this.state.dialog==='new-group'?'Criar grupo':undefined} title={this.state.dialog==='new-group'?'Criar grupo':undefined}>{this.state.dialog==='new-group'?<PlusIcon/>:'Salvar'}</button></footer></form></Modal>}
      {this.state.dialog==='shortcuts'&&<Modal title="Atalhos de teclado" onClose={this.closeDialog}><dl className="shortcuts">{[['Buscar ou executar','Ctrl + K'],['Nova nota','Alt + N'],['Salvar localmente','Ctrl + S'],['Sincronizar GitHub','Ctrl + Shift + S'],['Configurações','Ctrl + ,'],['Reordenar grupo, sessão ou nota','Alt + ↑ / ↓'],['Mover nota para a lixeira','Ctrl + Delete'],['Sair da edição / fechar busca','Esc']].map(([label,key])=><div key={key}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl><p className="muted">Clique com o botão direito em uma nota, grupo ou sessão para mais ações.</p><footer><button className="primary" onClick={this.closeDialog}>Concluir</button></footer></Modal>}
      {this.state.toast&&<div className="toast" role="status">{this.state.toast}<button aria-label="Dispensar aviso" onClick={()=>this.setState({toast:null})}><CloseIcon/></button></div>}
      {this.state.saveError&&<div className="save-error" role="alert"><span>Não foi possível salvar no disco: {this.state.saveError}</span><button onClick={()=>this.run(()=>this.flushAll())}>Tentar novamente</button></div>}
    </div></>;
  }
}
