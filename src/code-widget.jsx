import CodeBlock from '@tiptap/extension-code-block';
import {Selection,TextSelection} from '@tiptap/pm/state';
import {CODE_LANGUAGES,detectCodeLanguage,normalizeCodeLanguage} from './code-languages';
import {CODE_HTML_MARKER,decodeNestedCode,serializeNestedCode} from './code-serialization';

// Loading is shared, local and lazy. Importing the document schema in Node does
// not load Monaco or require a DOM; only a mounted code NodeView requests it.
let monacoLoading,themeReady=false,nextWidget=0;
const loadMonaco=()=>monacoLoading || (monacoLoading=import('monaco-editor/editor/editor.main.js').catch(error=>{monacoLoading=null;throw error;}));
const THEME='notes-inherited-code';
const THEME_VARIABLES=['--note-bg','--win','--glass-strong','--field','--foot','--line','--line-strong','--ink','--ink-2','--ink-3','--accent','--acc-ink','--acc-soft','--acc-soft-2','--hover','--hover-2','--on-accent','--pane-shadow'];
const languageName=id=>CODE_LANGUAGES.find(item=>item.id===id)?.name || 'Texto simples';
const normalized=value=>value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');

function prepareTheme(monaco){
  if(themeReady)return;
  // Monaco themes are global. Stable token IDs are mapped to inherited CSS in
  // each widget instead of switching a global palette when a note changes.
  // ColorMap in Monaco assigns these custom colors IDs 1..8 in this order.
  const colors=['D0D1D2','707172','506070','605040','507050','5060A0','A0B0C0','B0C0D0'];
  monaco.editor.defineTheme(THEME,{
    base:'vs-dark',inherit:false,encodedTokensColors:colors,
    rules:[
      {token:'',foreground:colors[0],background:'000000'},
      {token:'comment',foreground:colors[1],fontStyle:'italic'},
      {token:'keyword',foreground:colors[2]},
      {token:'string',foreground:colors[3]},
      {token:'string.key',foreground:colors[5]},
      {token:'number',foreground:colors[4]},
      {token:'constant',foreground:colors[4]},
      {token:'type',foreground:colors[5]},
      {token:'type.identifier',foreground:colors[5]},
      {token:'tag',foreground:colors[2]},
      {token:'attribute.name',foreground:colors[5]},
      {token:'attribute.value',foreground:colors[3]},
      {token:'delimiter',foreground:colors[6]},
      {token:'operator',foreground:colors[6]},
      {token:'regexp',foreground:colors[7]},
      {token:'metatag',foreground:colors[7]},
      {token:'annotation',foreground:colors[7]},
    ],
    colors:{
      'editor.background':'#00000000','editor.foreground':'#'+colors[0],
      'editorLineNumber.foreground':'#'+colors[1],'editorLineNumber.activeForeground':'#'+colors[0],
      'editorCursor.foreground':'#'+colors[2],
      'editor.selectionBackground':'#50607055','editor.inactiveSelectionBackground':'#50607033',
      'editor.lineHighlightBackground':'#50607011','editor.lineHighlightBorder':'#00000000',
      'editorIndentGuide.background1':'#70717233','editorIndentGuide.activeBackground1':'#70717266',
    },
  });
  themeReady=true;
}

function button(label,className,action){
  const element=document.createElement('button');element.type='button';element.className=className;element.setAttribute('aria-label',label);element.title=label;
  element.addEventListener('mousedown',event=>event.preventDefault());
  element.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();action(event);});
  return element;
}

function codeNodeView({node:initialNode,editor,getPos}){
  let node=initialNode,disposed=false,model=null,code=null,monaco=null,synchronizing=false,lastText=node.textContent,language=normalizeCodeLanguage(node.attrs.language),menu=null,resizeFrame=0,loadingGeneration=0,editable=editor.isEditable;
  const disposables=[],widgetId='notes-code-'+(++nextWidget);
  const dom=document.createElement('div'),header=document.createElement('div'),badge=document.createElement('span'),languageButton=button('Linguagem do código','code-widget-language',()=>{
    const bounds=languageButton.getBoundingClientRect();openMenu(bounds.left,bounds.bottom+5);
  }),languageLabel=document.createElement('span'),chevron=document.createElementNS('http://www.w3.org/2000/svg','svg'),body=document.createElement('div'),fallback=document.createElement('pre'),status=document.createElement('div');
  dom.className='code-widget';dom.dataset.codeWidget='true';dom.contentEditable='false';dom.setAttribute('role','group');dom.setAttribute('aria-label','Bloco de código');dom.setAttribute('data-language',language);
  header.className='code-widget-header';badge.className='code-widget-badge';badge.textContent='</>';badge.setAttribute('aria-hidden','true');
  languageLabel.textContent=languageName(language);chevron.setAttribute('class','code-widget-chevron');chevron.setAttribute('viewBox','0 0 24 24');chevron.setAttribute('width','14');chevron.setAttribute('height','14');chevron.setAttribute('fill','currentColor');chevron.setAttribute('aria-hidden','true');chevron.setAttribute('focusable','false');
  const caret=document.createElementNS('http://www.w3.org/2000/svg','path');caret.setAttribute('d','M5 9h14l-7 7Z');chevron.append(caret);
  languageButton.setAttribute('aria-haspopup','dialog');languageButton.setAttribute('aria-expanded','false');languageButton.append(languageLabel,chevron);header.append(badge,languageButton);
  body.className='code-widget-editor';body.setAttribute('data-code-editor','true');body.style.height='110px';
  fallback.className='code-widget-fallback';fallback.textContent=node.textContent;body.append(fallback);
  status.className='code-widget-status';status.setAttribute('role','status');status.textContent='Carregando editor de código…';
  dom.append(header,body,status);

  const current=()=>{
    if(disposed||editor.isDestroyed)return null;
    let pos;try{pos=getPos();}catch{return null;}
    if(typeof pos!=='number')return null;
    const actual=editor.state.doc.nodeAt(pos);return actual?.type.name==='codeBlock'?{pos,node:actual}:null;
  };
  const syncLanguage=()=>{
    language=normalizeCodeLanguage(node.attrs.language);dom.dataset.language=language;languageLabel.textContent=languageName(language);
    languageButton.setAttribute('aria-label','Linguagem do código: '+languageName(language));languageButton.title='Linguagem do código: '+languageName(language);
    if(model&&model.getLanguageId()!==language){monaco.editor.setModelLanguage(model,language);code?.updateOptions({ariaLabel:'Código '+languageName(language)+'. Pressione Esc para voltar à nota.'});}
  };
  const layout=()=>{
    if(!code||disposed)return;
    const width=Math.max(1,Math.floor(body.clientWidth)),height=Math.min(440,Math.max(110,Math.ceil(code.getContentHeight())));
    if(body.style.height!==height+'px')body.style.height=height+'px';
    code.layout({width,height});
  };
  const scheduleLayout=()=>{if(!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;layout();});};
  const syncSelectionToDocument=()=>{
    if(!code||!model||synchronizing)return;
    const target=current(),selected=code.getSelection();if(!target||!selected)return;
    const anchor=target.pos+1+model.getOffsetAt(selected.getSelectionStart()),head=target.pos+1+model.getOffsetAt(selected.getPosition());
    const selection=editor.state.selection;if(selection.anchor===anchor&&selection.head===head)return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,anchor,head)).setMeta('addToHistory',false));
  };
  const syncSelectionFromDocument=()=>{
    const target=current();if(!target||!code||!model)return;
    const selection=editor.state.selection;
    if(selection.from<target.pos+1||selection.to>target.pos+target.node.nodeSize-1)return;
    const start=model.getPositionAt(selection.anchor-target.pos-1),end=model.getPositionAt(selection.head-target.pos-1);
    code.setSelection(new monaco.Selection(start.lineNumber,start.column,end.lineNumber,end.column));
  };
  const focusCode=()=>{if(code&&!disposed)code.focus();};
  const leaveCode=()=>{
    const target=current();if(!target)return;
    let tr=editor.state.tr,after=target.pos+target.node.nodeSize;
    if(!tr.doc.nodeAt(after))tr=tr.insert(after,editor.schema.nodes.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(tr.doc.content.size,after)),1));
    editor.view.dispatch(tr.scrollIntoView());editor.view.focus();
  };
  const setLanguage=id=>{
    const target=current();if(!target)return;
    const value=normalizeCodeLanguage(id);
    if(target.node.attrs.language!==value)editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos,undefined,{...target.node.attrs,language:value}));
    focusCode();
  };
  const convertToText=()=>{
    const target=current();if(!target)return;
    const tr=editor.state.tr.setNodeMarkup(target.pos,editor.schema.nodes.paragraph,{});
    tr.setSelection(TextSelection.create(tr.doc,Math.min(tr.doc.content.size,target.pos+1)));
    editor.view.dispatch(tr.scrollIntoView());editor.view.focus();
  };
  const removeCode=()=>{
    const target=current();if(!target)return;
    const tr=editor.state.tr.delete(target.pos,target.pos+target.node.nodeSize);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(target.pos,tr.doc.content.size))));
    editor.view.dispatch(tr.scrollIntoView());editor.view.focus();
  };

  function closeMenu(restore=true){
    if(!menu)return;
    const closed=menu;menu=null;closed.cleanup();closed.element.remove();languageButton.setAttribute('aria-expanded','false');
    if(restore)focusCode();
  }
  function openMenu(x,y){
    if(!current())return;
    closeMenu(false);
    const element=document.createElement('div'),heading=document.createElement('div'),input=document.createElement('input'),list=document.createElement('div'),actions=document.createElement('div'),feedback=document.createElement('div');
    element.className='code-widget-menu';element.setAttribute('role','dialog');element.setAttribute('aria-label','Opções do bloco de código');
    const computed=getComputedStyle(dom);for(const name of THEME_VARIABLES){const value=computed.getPropertyValue(name);if(value)element.style.setProperty(name,value);}
    heading.className='code-widget-menu-heading';heading.textContent='Linguagem do código';
    input.className='code-widget-search';input.type='text';input.placeholder='Buscar linguagem…';input.setAttribute('aria-label','Buscar linguagem de programação');input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls',widgetId+'-languages');input.spellcheck=false;
    list.className='code-widget-language-list';list.id=widgetId+'-languages';list.setAttribute('role','listbox');list.setAttribute('aria-label','Linguagem do código');
    actions.className='code-widget-menu-actions';feedback.className='code-widget-menu-feedback';feedback.setAttribute('role','status');
    let filtered=CODE_LANGUAGES,active=Math.max(0,CODE_LANGUAGES.findIndex(item=>item.id===language));
    const highlight=(index,scroll=true)=>{
      if(!filtered.length){input.removeAttribute('aria-activedescendant');return;}
      active=(index+filtered.length)%filtered.length;
      [...list.children].forEach((child,index)=>child.classList.toggle('active',index===active));
      const selected=list.children[active];if(selected){input.setAttribute('aria-activedescendant',selected.id);if(scroll)selected.scrollIntoView({block:'nearest'});}
    };
    const chooseLanguage=id=>{closeMenu(false);setLanguage(id);};
    const renderLanguages=()=>{
      const query=normalized(input.value.trim());filtered=CODE_LANGUAGES.filter(item=>normalized([item.name,item.id,...item.aliases].join(' ')).includes(query));
      list.replaceChildren();
      filtered.forEach((item,index)=>{
        const row=button(item.name,'code-widget-language-option',()=>chooseLanguage(item.id));row.id=widgetId+'-language-'+item.id;row.setAttribute('role','option');row.setAttribute('aria-selected',String(item.id===language));row.tabIndex=-1;
        const name=document.createElement('span'),check=document.createElement('span');name.textContent=item.name;check.textContent=item.id===language?'✓':'';check.setAttribute('aria-hidden','true');row.append(name,check);
        row.addEventListener('pointermove',()=>highlight(index,false));list.append(row);
      });
      active=Math.max(0,filtered.findIndex(item=>item.id===language));highlight(active,false);
      if(!filtered.length){const empty=document.createElement('div');empty.className='code-widget-empty';empty.textContent='Nenhuma linguagem encontrada.';empty.setAttribute('role','status');list.append(empty);}
    };
    const action=(label,run,danger=false)=>{const control=button(label,'code-widget-menu-action'+(danger?' danger':''),run);control.textContent=label;actions.append(control);return control;};
    action('Copiar código',async()=>{
      const target=current();if(!target)return;
      try{await window.notes.copyText(target.node.textContent);if(menu?.element===element)feedback.textContent='Código copiado.';}
      catch{if(menu?.element===element)feedback.textContent='Não foi possível copiar. Selecione o código e use Ctrl+C.';}
    });
    action('Selecionar todo o código',()=>{closeMenu(false);if(code&&model){focusCode();code.setSelection(model.getFullModelRange());syncSelectionToDocument();}});
    action('Transformar em texto',()=>{closeMenu(false);convertToText();});
    action('Excluir bloco de código',()=>{closeMenu(false);removeCode();},true);
    element.append(heading,input,list,actions,feedback);document.body.append(element);languageButton.setAttribute('aria-expanded','true');renderLanguages();
    const place=()=>{
      const bounds=element.getBoundingClientRect();element.style.left=Math.max(8,Math.min(x,innerWidth-bounds.width-8))+'px';element.style.top=Math.max(48,Math.min(y,innerHeight-bounds.height-8))+'px';
    };
    const outside=event=>{if(!element.contains(event.target))closeMenu(false);};
    const scroll=event=>{if(!element.contains(event.target))closeMenu(false);};
    const blur=()=>closeMenu(false);
    input.addEventListener('input',renderLanguages);
    element.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();});
    element.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'){event.preventDefault();closeMenu();return;}
      if(event.target===input&&['ArrowDown','ArrowUp','Home','End','Enter'].includes(event.key)){
        event.preventDefault();
        if(event.key==='Enter'){if(filtered[active])chooseLanguage(filtered[active].id);}
        else highlight(event.key==='Home'?0:event.key==='End'?filtered.length-1:active+(event.key==='ArrowDown'?1:-1));
      }
      if(event.key==='Tab'){
        const fields=[input,...actions.querySelectorAll('button')],first=fields[0],last=fields.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',scroll,true);window.addEventListener('resize',blur);window.addEventListener('blur',blur);
    menu={element,cleanup:()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',blur);window.removeEventListener('blur',blur);}};
    place();input.focus({preventScroll:true});highlight(active);
  }

  const context=event=>{event.preventDefault();event.stopPropagation();openMenu(event.clientX,event.clientY);};
  dom.addEventListener('contextmenu',context,true);
  dom.addEventListener('keydown',event=>{
    // The app owns saving/sync. Editing, Undo and other Monaco shortcuts stay
    // inside this widget and cannot toggle the application's sidebar or notes.
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s')return;
    if(event.key==='Escape'){event.preventDefault();leaveCode();}
    event.stopPropagation();
  });
  const resizeObserver=new ResizeObserver(scheduleLayout);resizeObserver.observe(body);
  const updateReadOnly=()=>{if(editable!==editor.isEditable){editable=editor.isEditable;code?.updateOptions({readOnly:!editable});}};
  editor.on('transaction',updateReadOnly);
  const canFocusCode=()=>{
    const target=current();if(!target||document.activeElement!==editor.view.dom)return false;
    const selection=editor.state.selection;
    return selection.from>=target.pos+1&&selection.to<=target.pos+target.node.nodeSize-1;
  };

  async function mount(){
    const generation=++loadingGeneration,requestedFocus=canFocusCode();
    try{
      const loaded=await loadMonaco();if(disposed||generation!==loadingGeneration||!current())return;
      monaco=loaded;prepareTheme(monaco);
      body.replaceChildren();lastText=node.textContent;
      model=monaco.editor.createModel(lastText,language,monaco.Uri.parse('inmemory://notes/'+widgetId));
      code=monaco.editor.create(body,{
        model,theme:THEME,autoDetectHighContrast:false,readOnly:!editor.isEditable,ariaLabel:'Código '+languageName(language)+'. Pressione Esc para voltar à nota.',
        fontFamily:'Cascadia Code, Consolas, Courier New, monospace',fontSize:13,lineHeight:21,
        fontLigatures:false,tabSize:2,insertSpaces:true,detectIndentation:true,
        padding:{top:11,bottom:11},lineNumbers:'on',lineNumbersMinChars:2,lineDecorationsWidth:8,
        minimap:{enabled:false},glyphMargin:false,folding:false,overviewRulerLanes:0,hideCursorInOverviewRuler:true,
        scrollBeyondLastLine:false,scrollBeyondLastColumn:4,scrollbar:{vertical:'auto',horizontal:'auto',alwaysConsumeMouseWheel:false,verticalScrollbarSize:7,horizontalScrollbarSize:7},
        automaticLayout:false,wordWrap:'off',contextmenu:false,renderLineHighlight:'none',renderWhitespace:'selection',
        guides:{indentation:false,bracketPairs:false},bracketPairColorization:{enabled:false},
        'semanticHighlighting.enabled':false,colorDecorators:false,colorDecoratorsActivatedOn:'click',
        quickSuggestions:false,suggestOnTriggerCharacters:false,wordBasedSuggestions:'off',acceptSuggestionOnEnter:'off',
        inlineSuggest:{enabled:false},parameterHints:{enabled:false},hover:{enabled:false},lightbulb:{enabled:'off'},
        codeLens:false,links:false,matchBrackets:'never',stickyScroll:{enabled:false},
        formatOnPaste:false,formatOnType:false,autoClosingBrackets:'never',autoClosingQuotes:'never',autoIndent:'keep',
        unicodeHighlight:{ambiguousCharacters:false,invisibleCharacters:false},accessibilitySupport:'on',
      });
      // Deliberately expose only the local editor instance on its own DOM node,
      // matching the surrounding visual editor's testing/integration convention.
      body.__notesCodeEditor=code;
      disposables.push(model.onDidChangeContent(()=>{
        if(synchronizing||disposed)return;
        const target=current();if(!target)return;
        const value=model.getValue();
        if(target.node.textContent!==lastText){
          synchronizing=true;model.setValue(target.node.textContent);lastText=target.node.textContent;synchronizing=false;scheduleLayout();return;
        }
        if(value===lastText)return;
        let from=0,to=lastText.length,end=value.length;
        while(from<to&&from<end&&lastText.charCodeAt(from)===value.charCodeAt(from))from++;
        while(to>from&&end>from&&lastText.charCodeAt(to-1)===value.charCodeAt(end-1)){to--;end--;}
        const before=lastText;lastText=value;
        try{editor.view.dispatch(editor.state.tr.insertText(value.slice(from,end),target.pos+1+from,target.pos+1+to).setMeta('notesCodeWidget',true));}
        catch(error){lastText=before;synchronizing=true;model.setValue(current()?.node.textContent || before);synchronizing=false;throw error;}
        scheduleLayout();
      }));
      disposables.push(code.onDidChangeCursorSelection(syncSelectionToDocument),code.onDidFocusEditorText(syncSelectionToDocument),code.onDidContentSizeChange(scheduleLayout));
      const undo=()=>{if(editor.commands.undo()){syncSelectionFromDocument();focusCode();}};
      const redo=()=>{if(editor.commands.redo()){syncSelectionFromDocument();focusCode();}};
      code.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyZ,undo);
      code.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyY,redo);
      code.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyMod.Shift|monaco.KeyCode.KeyZ,redo);
      code.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter,leaveCode);
      status.textContent='';status.hidden=true;dom.dataset.codeReady='true';syncLanguage();layout();scheduleLayout();
      if(requestedFocus&&!menu&&canFocusCode()){syncSelectionFromDocument();focusCode();}
    }catch(error){
      if(disposed||generation!==loadingGeneration)return;
      code?.dispose();model?.dispose();code=null;model=null;delete body.__notesCodeEditor;
      fallback.textContent=node.textContent;body.replaceChildren(fallback);status.hidden=false;status.textContent='Não foi possível carregar o editor. Seu código está preservado. ';
      const retry=button('Tentar carregar o editor novamente','code-widget-retry',()=>{status.textContent='Carregando editor de código…';mount();});retry.textContent='Tentar novamente';status.append(retry);
      console.error('Falha ao carregar o editor de código:',error);
    }
  }
  syncLanguage();mount();
  return {
    dom,
    update(nextNode){
      if(nextNode.type.name!=='codeBlock')return false;
      node=nextNode;syncLanguage();
      if(!model){fallback.textContent=node.textContent;return true;}
      if(model.getValue()!==node.textContent){
        const view=code.saveViewState();synchronizing=true;model.setValue(node.textContent);lastText=node.textContent;
        if(view)code.restoreViewState(view);synchronizing=false;scheduleLayout();
      }else lastText=node.textContent;
      return true;
    },
    selectNode(){dom.classList.add('ProseMirror-selectednode');},
    deselectNode(){dom.classList.remove('ProseMirror-selectednode');},
    stopEvent:event=>dom.contains(event.target),
    ignoreMutation:()=>true,
    destroy(){disposed=true;loadingGeneration++;closeMenu(false);if(resizeFrame)cancelAnimationFrame(resizeFrame);resizeObserver.disconnect();editor.off('transaction',updateReadOnly);for(const disposable of disposables)disposable.dispose();code?.dispose();model?.dispose();delete body.__notesCodeEditor;},
  };
}

/** The schema and Markdown serializer stay the standard codeBlock. Only the
 * editable in-app rendering becomes a Monaco widget. */
export const NoteCodeBlock=CodeBlock.extend({
  addAttributes(){
    return {...this.parent?.(),language:{default:null,rendered:false,parseHTML:element=>{
      const label=element.firstElementChild?.getAttribute('class')?.split(/\s+/).find(value=>value.startsWith('language-'))?.slice(9);
      return label?normalizeCodeLanguage(label):null;
    }}};
  },
  parseMarkdown:(token,helpers)=>{
    const text=token.text || '',label=token.lang?.trim().split(/\s+/)[0];
    return helpers.createNode('codeBlock',{language:label?normalizeCodeLanguage(label):detectCodeLanguage(text)||'plaintext'},text?[helpers.createTextNode(text)]:[]);
  },
  markdownTokenizer:{
    name:'code',level:'block',start:source=>source.indexOf(CODE_HTML_MARKER),
    tokenize:source=>{
      const match=/^ {0,3}<pre data-notes-code="1"><code class="language-([a-z][a-z0-9-]*)">([^\r\n]*?)<\/code><\/pre>(?:[ \t]*(?:\r?\n|$))/.exec(source);
      if(!match)return;
      const decoded=decodeNestedCode(match[0]);if(!decoded)return;
      return {type:'code',raw:match[0],lang:decoded.language,text:decoded.text};
    },
  },
  renderMarkdown:(node,_helpers,context)=>{
    // Source compatibility must not truncate a program containing Markdown
    // fences, backticks or trailing blank lines. Code text is never escaped.
    const text=(node.content || []).map(child=>child.text || '').join('');
    const language=node.attrs?.language?normalizeCodeLanguage(node.attrs.language):'';
    // Markdown container indentation expands tabs and trims blank code lines.
    // Keep nested code on one physical line using inert, escaped HTML instead.
    // The custom tokenizer above restores it identically even without a DOM;
    // ordinary Markdown readers also display this as a normal pre/code block.
    if(context?.parentType&&context.parentType!=='doc')return (context.parentType==='listItem'?'\n':'')+serializeNestedCode(text,language);
    const longest=(text.match(/`+/g)||[]).reduce((size,run)=>Math.max(size,run.length),0);
    const fence='`'.repeat(Math.max(3,longest+1));
    return fence+language+'\n'+text+'\n'+fence;
  },
  // RichEditor owns paste detection and validates optional VS Code metadata.
  // The stock plugin parses that metadata without a guard and rewrites CRLF.
  addProseMirrorPlugins(){return [];},
  addNodeView(){return codeNodeView;},
});
