'use strict';

// Exercise input during the real window between mounting the editor view and
// the deferred onCreate marker. Do not delay the paste until the race vanishes.
async function pasteBeforeCreate(page, editor) {
  await editor.evaluate(element => {
    let value=element.__notesEditor;
    Object.defineProperty(element,'__notesEditor',{configurable:true,get:()=>undefined,set:next=>{value=next;}});
    element.__restorePasteMarker=()=>{
      Object.defineProperty(element,'__notesEditor',{configurable:true,writable:true,enumerable:true,value});
      delete element.__restorePasteMarker;
    };
  });
  try {
    await editor.focus(); await page.keyboard.press('Control+v');
    await page.waitForFunction(element=>!!element.textContent.trim()||!!element.querySelector('[data-code-widget]'),await editor.elementHandle());
  } finally { await editor.evaluate(element=>element.__restorePasteMarker?.()); }
}
module.exports={pasteBeforeCreate};
