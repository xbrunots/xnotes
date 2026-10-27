import {normalizeCodeLanguage} from './code-languages';

export const CODE_HTML_MARKER='<pre data-notes-code="1">';
const encodeCode=text=>text.replace(/[&<>\u0000-\u0020\u007f]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[character] || '&#'+character.charCodeAt(0)+';'));

/** A single physical line avoids Markdown containers expanding tabs or
 * trimming whitespace-only code lines. All content stays inert text in pre. */
export function serializeNestedCode(text,language){
  return CODE_HTML_MARKER+'<code class="language-'+normalizeCodeLanguage(language)+'">'+encodeCode(text)+'</code></pre>';
}

/** Decode only our exact marker and escaping vocabulary, in one pass, without
 * a DOM, executing HTML, or evaluating recursively encoded entity strings. */
export function decodeNestedCode(source){
  if(typeof source!=='string')return null;
  const match=/^ {0,3}<pre data-notes-code="1"><code class="language-([a-z][a-z0-9-]*)">([^\r\n]*?)<\/code><\/pre>[ \t]*(?:\r?\n)?$/.exec(source);
  if(!match)return null;
  const encoded=match[2];
  if(/[<>]/.test(encoded)||/&(?!(?:amp|lt|gt|#(?:[0-9]|[12][0-9]|3[0-2]|127));)/.test(encoded))return null;
  const text=encoded.replace(/&(amp|lt|gt|#(?:[0-9]|[12][0-9]|3[0-2]|127));/g,(_entity,name)=>name[0]==='#'?String.fromCharCode(Number(name.slice(1))):({amp:'&',lt:'<',gt:'>'}[name]));
  return {text,language:normalizeCodeLanguage(match[1])};
}
