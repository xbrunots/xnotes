import React,{useEffect,useRef,useState} from 'react';
import {EditorContent,useEditor,useEditorState} from '@tiptap/react';
import {BubbleMenu} from '@tiptap/react/menus';
import {editorExtensions} from './editor-extensions';
import {allowedLink,documentForNote,splitNoteSource} from './note-content';
import {applyNoteContent} from './editor-content';
import {PlusIcon,DropdownIcon} from './controls';
import {convertSelectionToCode,insertCodeBlock} from './code-commands';
import {pastedCodeLanguage} from './code-languages';

function Tool({label,children,active=false,disabled=false,onClick}){
  return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={onClick}>{children}</button>;
}

function FormattingTools({editor,onLink,compact=false}){
  useEditorState({editor,selector:({editor:e})=>({selection:e.state.selection.from+':'+e.state.selection.to,doc:e.state.doc,marks:e.state.storedMarks})});
  return <>
    {!compact&&<div className="format-group">
      <Tool label="Negrito (Ctrl+B)" active={editor.isActive('bold')} onClick={()=>editor.chain().focus().toggleBold().run()}><b>B</b></Tool>
      <Tool label="Itálico (Ctrl+I)" active={editor.isActive('italic')} onClick={()=>editor.chain().focus().toggleItalic().run()}><i>I</i></Tool>
      <Tool label="Sublinhado (Ctrl+U)" active={editor.isActive('underline')} onClick={()=>editor.chain().focus().toggleUnderline().run()}><u>U</u></Tool>
      <Tool label="Tachado" active={editor.isActive('strike')} onClick={()=>editor.chain().focus().toggleStrike().run()}><s>S</s></Tool>
      <Tool label="Destacar texto" active={editor.isActive('highlight')} onClick={()=>editor.chain().focus().toggleHighlight().run()}><span className="highlight-icon">A</span></Tool>
      <Tool label="Inserir ou editar link" active={editor.isActive('link')||editor.isActive('noteLink')} onClick={onLink}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m9 15 6-6m-6 1-2-2a4 4 0 0 1 6-6l2 2m0 10 2 2a4 4 0 0 1-6 6l-2-2"/></svg></Tool>
      <Tool label="Transformar em código (Monaco)" active={editor.isActive('codeBlock')} onClick={()=>convertSelectionToCode(editor)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/></svg></Tool>
      <Tool label="Remover formatação" onClick={()=>editor.chain().focus().unsetAllMarks().clearNodes().run()}>T<span className="tool-small">×</span></Tool>
    </div>}
    <div className="format-group">
      <Tool label="Texto normal" active={editor.isActive('paragraph')&&!editor.isActive('bulletList')&&!editor.isActive('orderedList')&&!editor.isActive('taskList')} onClick={()=>editor.chain().focus().clearNodes().setParagraph().run()}>T</Tool>
      {[1,2,3].slice(0,compact?2:3).map(level=><Tool key={level} label={'Título '+level} active={editor.isActive('heading',{level})} onClick={()=>editor.chain().focus().toggleHeading({level}).run()}>H<span className="tool-small">{level}</span></Tool>)}
      <Tool label="Lista com marcadores" active={editor.isActive('bulletList')} onClick={()=>editor.chain().focus().toggleBulletList().run()}>☷</Tool>
      {!compact&&<Tool label="Lista numerada" active={editor.isActive('orderedList')} onClick={()=>editor.chain().focus().toggleOrderedList().run()}>1.</Tool>}
      <Tool label="Lista de tarefas" active={editor.isActive('taskList')} onClick={()=>editor.chain().focus().toggleTaskList().run()}>☑</Tool>
      {!compact&&<><Tool label="Citação" active={editor.isActive('blockquote')} onClick={()=>editor.chain().focus().toggleBlockquote().run()}>❞</Tool>
        <Tool label="Alinhar à esquerda" active={editor.isActive({textAlign:'left'})} onClick={()=>editor.chain().focus().setTextAlign('left').run()}>≡</Tool>
        <Tool label="Centralizar" active={editor.isActive({textAlign:'center'})} onClick={()=>editor.chain().focus().setTextAlign('center').run()}>≣</Tool></>}
    </div>
  </>;
}

export function RichEditor({note,variables,onChange,onReady,onNote,onAsset,onExternal,onFocus}){
  const current=useRef({note,onChange,onReady,onNote,onAsset,onExternal,onFocus});
  current.current={note,onChange,onReady,onNote,onAsset,onExternal,onFocus};
  const source=useRef(splitNoteSource(note.body)),last=useRef({body:note.body,doc:JSON.stringify(documentForNote(note))});
  const [manual,setManual]=useState(false),[link,setLink]=useState(null),[linkValue,setLinkValue]=useState(''),[linkError,setLinkError]=useState('');
  const manualRef=useRef(null),linkRef=useRef(null),root=useRef(null),manualTrigger=useRef(null);
  const [position,setPosition]=useState({left:0,top:0});
  const editor=useEditor({
    extensions:editorExtensions(),content:source.current.content,contentType:'markdown',immediatelyRender:true,shouldRerenderOnTransaction:false,
    editorProps:{
      attributes:{class:'visual-document imported-markdown','data-editor':note.id,role:'textbox','aria-label':'Conteúdo da nota','aria-multiline':'true',spellcheck:'true'},
      handlePaste:(_view,event)=>{
        const clipboard=event.clipboardData,text=clipboard?.getData('text/plain');
        if(text){
          let hint;
          try{const metadata=clipboard?.getData('vscode-editor-data');if(metadata&&metadata.length<16384)hint=JSON.parse(metadata).mode;}catch{/* Plain code detection still works without editor metadata. */}
          const language=pastedCodeLanguage(text,hint);
          if(language){event.preventDefault();const instance=_view.dom.__notesEditor || editor;return instance?insertCodeBlock(instance,text,language):false;}
        }
        // Rich HTML is parsed through the editor schema. Plain Markdown is
        // converted on paste, before any source syntax enters the document.
        if(clipboard?.getData('text/html'))return false;
        if(!text)return false;
        // The view can receive input before the deferred onCreate callback
        // installs its DOM marker. The hook already owns the live editor.
        event.preventDefault();const instance=_view.dom.__notesEditor || editor;
        instance?.commands.insertContent(splitNoteSource(text).content,{contentType:'markdown'});return !!instance;
      },
      handleClick:(_view,_pos,event)=>{
        const a=event.target.closest('a');if(!a)return false;
        event.preventDefault();event.stopPropagation();
        if(a.dataset.note){current.current.onNote(a.dataset.note);return true;}
        const href=a.getAttribute('href') || '';
        if(/^notes-asset:[a-f0-9]{64}$/.test(href)){current.current.onAsset(href.slice(12));return true;}
        if(/^https?:\/\//i.test(href)){current.current.onExternal(href);return true;}
        return true;
      },
      handleKeyDown:(_view,event)=>{
        if(event.altKey&&event.key==='F10'){event.preventDefault();setManual(true);setTimeout(()=>manualRef.current?.querySelector('button')?.focus(),0);return true;}
        return false;
      },
    },
    onCreate:({editor:e})=>{
      const doc=documentForNote(current.current.note);
      if(doc){try{applyNoteContent(e,doc,{errorOnInvalidContent:true});}catch{/* The intact Markdown source is the fallback. */}}
      e.view.dom.__notesEditor=e;current.current.onReady?.(e);
    },
    onUpdate:({editor:e})=>{
      const body=(source.current.prefix?source.current.prefix+'\n':'')+e.getMarkdown(),doc=e.getJSON();
      last.current={body,doc:JSON.stringify(doc)};
      const richText={version:1,source:body,doc};
      current.current.onChange(body,richText);
    },
    onFocus:()=>current.current.onFocus?.(),
    onDestroy:()=>current.current.onReady?.(null),
  },[note.id]);

  useEffect(()=>{
    if(!editor||editor.isDestroyed)return;
    const doc=documentForNote(note),encoded=JSON.stringify(doc);
    if(last.current.body===note.body){
      if(!doc||last.current.doc===encoded)return;
      try{if(editor.state.doc.eq(editor.schema.nodeFromJSON(doc)))return;}catch{/* Fall back to the validated source below. */}
    }
    source.current=splitNoteSource(note.body);last.current={body:note.body,doc:encoded};
    const selection=editor.state.selection,wasFocused=editor.isFocused;
    try{applyNoteContent(editor,doc || source.current.content,{contentType:doc?'json':'markdown',errorOnInvalidContent:true});}
    catch{applyNoteContent(editor,source.current.content,{contentType:'markdown'});}
    if(wasFocused){const end=editor.state.doc.content.size;editor.commands.setTextSelection({from:Math.min(selection.from,end),to:Math.min(selection.to,end)});}
  },[note.body,note.richText,editor]);
  useEffect(()=>{
    if(!manual)return;
    const place=()=>{const rect=manualTrigger.current?.getBoundingClientRect();if(rect)setPosition({left:Math.max(10,Math.min(innerWidth-420,rect.left)),top:Math.max(50,Math.min(innerHeight-210,rect.bottom+8))});};
    place();const close=event=>{if(!manualRef.current?.contains(event.target)&&!manualTrigger.current?.contains(event.target))setManual(false);};
    document.addEventListener('pointerdown',close);window.addEventListener('resize',place);
    return()=>{document.removeEventListener('pointerdown',close);window.removeEventListener('resize',place);};
  },[manual]);
  useEffect(()=>{if(link)linkRef.current?.focus();},[link]);
  const editLink=()=>{
    const target=editor.getAttributes('noteLink').target;
    const existing=target?'nota:'+target:editor.getAttributes('link').href || '';
    setLink({from:editor.state.selection.from,to:editor.state.selection.to,existing:!!existing});setLinkValue(existing);setLinkError('');
  };
  const saveLink=event=>{
    event.preventDefault();const value=linkValue.trim();
    if(value&&!allowedLink(value)&&!value.startsWith('nota:')){setLinkError('Use https://, http:// ou nota:Nome da nota.');return;}
    const chain=editor.chain().focus().setTextSelection(link).extendMarkRange(editor.isActive('noteLink')?'noteLink':'link').unsetMark('noteLink').unsetLink();
    if(value.startsWith('nota:')){const target=value.slice(5).trim();if(!target){setLinkError('Informe o nome da nota.');return;}chain.setMark('noteLink',{target});}
    else if(value)chain.setLink({href:value});
    if(value&&link.from===link.to&&!link.existing)chain.insertContent({type:'text',text:value.startsWith('nota:')?value.slice(5).trim():value});
    chain.run();setLink(null);setManual(false);
  };
  if(!editor)return null;
  const toolbar=<><FormattingTools editor={editor} onLink={editLink}/><div className="format-extra">
    <Tool label="Inserir tabela" onClick={()=>editor.chain().focus().insertTable({rows:3,cols:2,withHeaderRow:true}).run()}><PlusIcon size={14}/></Tool>
    {editor.isActive('table')&&<><Tool label="Adicionar linha" onClick={()=>editor.chain().focus().addRowAfter().run()}><PlusIcon size={14}/></Tool><Tool label="Adicionar coluna" onClick={()=>editor.chain().focus().addColumnAfter().run()}><PlusIcon size={14}/></Tool><Tool label="Excluir tabela" onClick={()=>editor.chain().focus().deleteTable().run()}>Excluir tabela</Tool></>}
    <Tool label="Inserir separador" onClick={()=>editor.chain().focus().setHorizontalRule().run()}><PlusIcon size={14}/></Tool>
    <Tool label="Desfazer (Ctrl+Z)" disabled={!editor.can().undo()} onClick={()=>editor.chain().focus().undo().run()}>↶</Tool>
    <Tool label="Refazer (Ctrl+Y)" disabled={!editor.can().redo()} onClick={()=>editor.chain().focus().redo().run()}>↷</Tool>
  </div></>;
  return <div className="rich-editor" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&(manual||link)){event.stopPropagation();setLink(null);setManual(false);editor.commands.focus();}}}>
    <div className="editor-commandbar"><button ref={manualTrigger} className="format-trigger" title="Formatar nota (Alt+F10)" aria-label="Formatar nota" aria-expanded={manual} onMouseDown={event=>event.preventDefault()} onClick={()=>{setManual(!manual);setLink(null);}}>Aa <DropdownIcon className="format-dropdown-icon"/></button><FormattingTools editor={editor} compact onLink={editLink}/></div>
    <EditorContent editor={editor}/>
    <BubbleMenu editor={editor} pluginKey={'format-'+note.id} updateDelay={40} appendTo={()=>document.body} options={{placement:'top',offset:10,flip:true,shift:{padding:{top:50,bottom:12,left:12,right:12}}}} className="editor-popover" role="toolbar" aria-label="Formatar texto selecionado" style={variables} shouldShow={({editor:e,state})=>!manual&&!link&&!state.selection.empty&&e.isFocused}>
      {toolbar}
    </BubbleMenu>
    {manual&&<div ref={manualRef} className="editor-popover manual-format" role="toolbar" aria-label="Ferramentas da nota" style={{...variables,...position}}>{toolbar}</div>}
    {link&&<div className="editor-link-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget){setLink(null);editor.commands.focus();}}}><form className="editor-link-form" style={variables} onSubmit={saveLink} role="dialog" aria-modal="true" aria-label="Editar link" onKeyDown={event=>{if(event.key!=='Tab')return;const fields=[...event.currentTarget.querySelectorAll('button,input')],first=fields[0],last=fields.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}><label htmlFor={'link-'+note.id}>Link ou nota</label><input id={'link-'+note.id} className="text-input" ref={linkRef} value={linkValue} onChange={event=>setLinkValue(event.target.value)} placeholder="https:// ou nota:Nome da nota"/>{linkError&&<p role="alert">{linkError}</p>}<div><button type="button" onClick={()=>{setLink(null);editor.commands.focus();}}>Cancelar</button><button type="button" onClick={()=>{editor.chain().focus().setTextSelection(link).extendMarkRange(editor.isActive('noteLink')?'noteLink':'link').unsetLink().unsetMark('noteLink').run();setLink(null);}}>Remover link</button><button type="submit" className="primary">Aplicar</button></div></form></div>}
  </div>;
}
