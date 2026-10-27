// Loading a document (initial or received through Drive) is not a user edit.
// Keeping it out of history prevents Undo from resurrecting an older remote copy.
export function applyNoteContent(editor,content,options={}) {
  return editor.chain().setMeta('addToHistory',false).setContent(content,{...options,emitUpdate:false}).run();
}

// A focus/selection transaction can make TrailingNode append an empty paragraph.
// It changes the view, but must not turn a received document into a local edit.
export function shouldPersistEditorUpdate(transaction) {
  return transaction?.docChanged === true;
}
