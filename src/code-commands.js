import {pastedCodeLanguage} from './code-languages';
import {closeHistory} from '@tiptap/pm/history';

export function insertCodeBlock(editor,text,language=pastedCodeLanguage(text) || 'plaintext',range){
  const block={type:'codeBlock',attrs:{language},content:text?[{type:'text',text}]:[]};
  const chain=editor.chain().focus();
  const inserted=(range?chain.insertContentAt(range,block):chain.insertContent(block)).run();
  // Pasting/converting a widget and subsequently typing in it are separate
  // user actions, even if Monaco becomes ready within the history delay.
  if(inserted&&!editor.isDestroyed)editor.view.dispatch(closeHistory(editor.state.tr));
  return inserted;
}

export function convertSelectionToCode(editor){
  if(!editor||editor.isDestroyed)return false;
  const {from,to,empty}=editor.state.selection;
  if(empty)return editor.chain().focus().setCodeBlock({language:'plaintext'}).run();
  return insertCodeBlock(editor,editor.state.doc.textBetween(from,to,'\n','\n'),undefined,{from,to});
}
