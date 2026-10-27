import {Mark,mergeAttributes} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import Link from '@tiptap/extension-link';
import {TaskItem,TaskList} from '@tiptap/extension-list';
import {Table,TableRow,TableCell,TableHeader} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import {Markdown} from '@tiptap/markdown';
import {allowedLink} from './note-content';
import {NoteCodeBlock} from './code-widget';

const NoteLink=Mark.create({
  name:'noteLink', inclusive:false, excludes:'link',
  addAttributes(){return {target:{default:'',parseHTML:el=>el.getAttribute('data-note'),renderHTML:attrs=>({'data-note':attrs.target})}};},
  parseHTML(){return [{tag:'a[data-note]'}];},
  renderHTML({HTMLAttributes}){return ['a',mergeAttributes(HTMLAttributes,{href:'#',class:'note-link',title:'Abrir nota'}),0];},
  markdownTokenizer:{name:'noteLink',level:'inline',start:src=>src.indexOf('[['),tokenize(src,_tokens,helpers){const match=/^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src);if(match)return {type:'noteLink',raw:match[0],target:match[1],tokens:helpers.inlineTokens(match[2] || match[1])};}},
  parseMarkdown:(token,h)=>h.applyMark('noteLink',h.parseInline(token.tokens || []),{target:token.target}),
  renderMarkdown:(node,h)=>{const text=h.renderChildren(node),target=node.attrs.target;return '[['+target+(text===target?'':'|'+text)+']]';},
});

const CustomTaskItem=TaskItem.extend({
  // The standard extension creates a browser checkbox. Both clipboard HTML and
  // the live node view use our own button instead.
  renderHTML({node,HTMLAttributes}){return ['li',mergeAttributes(HTMLAttributes,{'data-type':'taskItem','data-checked':String(!!node.attrs.checked)}),['span',{'data-task-control':'true',contenteditable:'false'},node.attrs.checked?'✓':'○'],['div',0]];},
  addNodeView(){return ({node,getPos,editor})=>{
    const dom=document.createElement('li'),button=document.createElement('button'),contentDOM=document.createElement('div');
    dom.dataset.type='taskItem';button.type='button';button.className='visual-task';button.contentEditable='false';button.setAttribute('role','checkbox');
    const update=current=>{const checked=String(!!current.attrs.checked),label='Concluir tarefa: '+(current.textContent || 'Nova tarefa'),text=current.attrs.checked?'✓':'';if(dom.dataset.checked!==checked)dom.dataset.checked=checked;if(button.getAttribute('aria-checked')!==checked)button.setAttribute('aria-checked',checked);if(button.getAttribute('aria-label')!==label)button.setAttribute('aria-label',label);if(button.textContent!==text)button.textContent=text;};
    update(node);button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const pos=getPos();if(typeof pos!=='number')return;const current=editor.state.doc.nodeAt(pos);if(current)editor.view.dispatch(editor.state.tr.setNodeMarkup(pos,undefined,{...current.attrs,checked:!current.attrs.checked}));});
    dom.append(button,contentDOM);
    return {dom,contentDOM,update:current=>{if(current.type.name!=='taskItem')return false;update(current);return true;},stopEvent:event=>button.contains(event.target),ignoreMutation:mutation=>button.contains(mutation.target)||(mutation.type==='attributes'&&mutation.target===dom)};
  };},
}).configure({nested:true});

const SafeImage=Image.extend({
  renderHTML({HTMLAttributes}){
    const src=HTMLAttributes.src || '',hash=/^(?:notes-asset:|notes:\/\/asset\/)([a-f0-9]{64})$/.exec(src)?.[1];
    if(hash)return ['img',{src:'notes://asset/'+hash,alt:HTMLAttributes.alt || '',title:HTMLAttributes.title || '',loading:'lazy','data-source':'notes-asset:'+hash}];
    return ['span',{class:'external-media',contenteditable:'false'},(HTMLAttributes.alt || 'Imagem externa')+' · carregar pelo arquivo de origem'];
  },
  addAttributes(){return {...this.parent?.(),src:{default:null,parseHTML:el=>el.getAttribute('data-source') || el.getAttribute('src')}};},
});

const VisualParagraph=Paragraph.extend({
  parseMarkdown:(token,h)=>{
    const tokens=token.tokens || [];
    const empty=tokens.length===1&&tokens[0].type==='text'&&['&nbsp;','\u00a0'].includes(tokens[0].raw || tokens[0].text);
    // Images are inline schema nodes, including a paragraph containing just an
    // image. The stock block-image shortcut would create an invalid document.
    return h.createNode('paragraph',undefined,empty?[]:h.parseInline(tokens));
  },
});

export function editorExtensions(){return [
  StarterKit.configure({link:false,paragraph:false,codeBlock:false,heading:{levels:[1,2,3]},undoRedo:{depth:150}}),VisualParagraph,NoteCodeBlock,
  Link.configure({openOnClick:false,autolink:true,markdownLinks:true,protocols:['notes-asset'],isAllowedUri:allowedLink}),
  NoteLink,TaskList,CustomTaskItem,
  Table.configure({resizable:false}),TableRow,TableHeader,TableCell,SafeImage.configure({inline:true}),
  Highlight,TextAlign.configure({types:['heading','paragraph']}),
  Placeholder.configure({placeholder:'Comece a escrever. Selecione o texto para formatar.'}),
  Markdown.configure({markedOptions:{gfm:true,breaks:true}}),
];}
