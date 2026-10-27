import MarkdownIt from 'markdown-it';
import {decodeNestedCode} from './code-serialization';

// This parser only extracts text; no generated HTML is inserted into the DOM.
// Inline HTML is needed for source-compatible underline/alignment marks.
const markdown = new MarkdownIt({html:true,breaks:true});

// Keep imported properties in the saved source, outside the editable document.
export function splitNoteSource(source='') {
  const match=/^\uFEFF?---\r?\n([\s\S]*?\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  if(match && /^[\w-]+\s*:/m.test(match[1]))return {prefix:match[0],content:source.slice(match[0].length).replace(/^\r?\n/,'')};
  return {prefix:'',content:source};
}

export function plainText(source='',richText) {
  if(richText?.version===1&&richText.source===source&&richText.doc?.type==='doc'){
    const read=node=>node.type==='text'?node.text || '':node.type==='hardBreak'?'\n':(node.content || []).map(read).join('')+(['paragraph','heading','listItem','taskItem','tableRow','blockquote','codeBlock'].includes(node.type)?'\n':'');
    return read(richText.doc).replace(/\n{3,}/g,'\n\n').trim();
  }
  const text=splitNoteSource(source).content;
  const lines=[];
  const inline=tokens=>(tokens || []).map(token=>{
    if(token.type==='text')return token.content.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_all,target,label)=>label || target);
    if(token.type==='code_inline'||token.type==='image')return token.content;
    if(token.type==='softbreak'||token.type==='hardbreak')return '\n';
    return token.children?inline(token.children):'';
  }).join('');
  for(const token of markdown.parse(text,{})){
    if(token.type==='inline')lines.push(inline(token.children).replace(/^\[[ xX]\]\s*/,''));
    else if(token.type==='fence'||token.type==='code_block')lines.push(token.content.trimEnd());
    else if(token.type==='html_block')lines.push(decodeNestedCode(token.content)?.text.trimEnd() ?? token.content.replace(/<[^>]*>/g,'').trim());
  }
  return lines.join('\n').replace(/==([^=]+)==/g,'$1').trim();
}

export const allowedLink = value => typeof value==='string' && (/^https?:\/\//i.test(value)||/^notes-asset:[a-f0-9]{64}$/.test(value));

export function documentForNote(note) {
  // A source edited by another version/device always wins over a stale rich doc.
  const rich=note.richText;
  return rich?.version===1 && rich.source===note.body && rich.doc?.type==='doc' ? rich.doc : null;
}
