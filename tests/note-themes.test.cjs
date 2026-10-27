const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const esbuild=require('esbuild');
const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/note-themes.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const mod={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module:mod,exports:mod.exports},{timeout:1000});
const {NOTE_THEMES,resolveNoteTheme,noteThemeVariables}=mod.exports;
const luminance=hex=>hex.slice(1).match(/../g).map(part=>parseInt(part,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
const contrast=(a,b)=>{const first=luminance(a),second=luminance(b);return (Math.max(first,second)+.05)/(Math.min(first,second)+.05);};
test('a paleta de notas tem exatamente vinte cores exclusivas e nenhum valor arbitrário',()=>{
  assert.equal(NOTE_THEMES.length,20);assert.equal(new Set(NOTE_THEMES.map(theme=>theme.id)).size,20);assert.equal(new Set(NOTE_THEMES.map(theme=>theme.background)).size,20);
  for(const value of [undefined,null,'#ff0000','var(--injected)','unknown']){assert.equal(resolveNoteTheme(value),null);assert.equal(Object.keys(noteThemeVariables(value)).length,0);}
});
test('texto e destaque das vinte notas mantêm contraste de leitura',()=>{
  for(const theme of NOTE_THEMES)for(const ink of [theme.ink,theme.secondary,theme.muted,theme.accent])assert(contrast(theme.background,ink)>=4.5,theme.name+' '+ink);
});
test('cada preset altera o material inteiro sem modificar o catálogo ou o tema global',()=>{
  for(const theme of NOTE_THEMES){const vars=noteThemeVariables(theme.id);assert.equal(vars['--note-bg'],theme.background);assert.equal(vars['--ink'],theme.ink);assert(vars['--line']&&vars['--foot']&&vars['--accent']);assert.equal(vars['--wall'],undefined);vars['--ink']='#000000';assert.equal(noteThemeVariables(theme.id)['--ink'],theme.ink);}
});
