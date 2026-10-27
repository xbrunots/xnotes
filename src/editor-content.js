// Loading a document (initial or received through Drive) is not a user edit.
// Keeping it out of history prevents Undo from resurrecting an older remote copy.
export function applyNoteContent(editor,content,options={}) {
  return editor.chain().setMeta('addToHistory',false).setContent(content,{...options,emitUpdate:false}).run();
}
