import React,{useLayoutEffect,useMemo,useRef} from 'react';
import MarkdownIt from 'markdown-it';

const md=new MarkdownIt({html:false,breaks:true,linkify:false});
const defaultLink=md.validateLink.bind(md);
md.validateLink=url=>/^notes-asset:[a-f0-9]{64}$/.test(url)||defaultLink(url);
md.inline.ruler.before('link','notes_wiki',(state,silent)=>{
  if(state.src.slice(state.pos,state.pos+2)!=='[[')return false;
  const end=state.src.indexOf(']]',state.pos+2);if(end<0)return false;
  const value=state.src.slice(state.pos+2,end),[target,alias]=value.split('|');
  if(!target)return false;
  if(!silent){const token=state.push('html_inline','',0);token.content='<a href="#" data-note="'+md.utils.escapeHtml(target)+'">'+md.utils.escapeHtml(alias || target)+'</a>';}
  state.pos=end+2;return true;
});
md.renderer.rules.image=(tokens,idx)=>{
  const token=tokens[idx],src=token.attrGet('src'),alt=md.utils.escapeHtml(token.content);
  if(/^notes-asset:[a-f0-9]{64}$/.test(src))return '<img loading="lazy" src="notes://asset/'+src.slice('notes-asset:'.length)+'" alt="'+alt+'">';
  return '<span class="external-media">'+alt+' · imagem externa: '+md.utils.escapeHtml(src)+'</span>';
};
const linkOpen=md.renderer.rules.link_open || ((tokens,idx,options,_env,self)=>self.renderToken(tokens,idx,options));
md.renderer.rules.link_open=(tokens,idx,options,env,self)=>{
  const token=tokens[idx],href=token.attrGet('href') || '';
  if(/^notes-asset:[a-f0-9]{64}$/.test(href)){token.attrSet('data-asset',href.slice('notes-asset:'.length));token.attrSet('href','#');}
  else if(/^https?:\/\//i.test(href)){token.attrSet('data-external',href);token.attrSet('href','#');}
  return linkOpen(tokens,idx,options,env,self);
};
md.core.ruler.after('inline','notes_tasks',state=>{
  for(const token of state.tokens){
    if(token.type!=='inline'||!token.children?.length||!/^\[( |x|X)\]\s/.test(token.content))continue;
    const prefix=token.children[0];if(prefix.type!=='text')continue;
    const done=token.content[1].toLowerCase()==='x';prefix.content=prefix.content.replace(/^\[( |x|X)\]\s/,'');
    const control=new state.Token('html_inline','',0);control.content='<button type="button" class="markdown-task" role="checkbox" data-task-line="'+(token.map?.[0] ?? -1)+'" aria-checked="'+done+'" aria-label="Concluir tarefa">'+(done?'<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5 9.5-9.5"></path></svg>':'')+'</button>';
    token.children.unshift(control);
  }
});

export function MarkdownBody({note,onNote,onAsset,onExternal,onToggle,onEdit}){
  const html=useMemo(()=>md.render(note.body),[note.body]);
  const root=useRef(null),restoreTask=useRef(null);
  useLayoutEffect(()=>{if(restoreTask.current!==null){root.current?.querySelector('[data-task-line="'+restoreTask.current+'"]')?.focus({preventScroll:true});restoreTask.current=null;}},[html]);
  const click=event=>{
    const link=event.target.closest('a');
    if(link){event.preventDefault();event.stopPropagation();if(link.dataset.note)onNote(link.dataset.note);else if(link.dataset.asset)onAsset(link.dataset.asset);else if(link.dataset.external)onExternal(link.dataset.external);return;}
    const task=event.target.closest('button[data-task-line]');
    if(task){event.stopPropagation();if(document.activeElement===task)restoreTask.current=Number(task.dataset.taskLine);onToggle(Number(task.dataset.taskLine));return;}
  };
  return <div ref={root} className="imported-markdown" onClick={click} onDoubleClick={onEdit} dangerouslySetInnerHTML={{__html:html}}/>;
}
