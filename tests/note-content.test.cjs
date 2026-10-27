const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const esbuild=require('esbuild');
const moduleContext={exports:{}};
const vm=require('node:vm');
const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/note-content.js')],bundle:true,write:false,platform:'node',format:'cjs'});
vm.runInNewContext(built.outputFiles[0].text,{module:moduleContext,exports:moduleContext.exports,require});
const {splitNoteSource,plainText,documentForNote,allowedLink}=moduleContext.exports;

test('propriedades importadas ficam fora do texto visual e são preservadas literalmente',()=>{
  const prefix='---\r\ntags: [ação, privado]\r\naliases: [Casa]\r\n---\r\n';
  const result=splitNoteSource(prefix+'\r\n# Casa\n**Texto**');
  assert.equal(result.prefix,prefix);assert.equal(result.content,'# Casa\n**Texto**');
  assert.equal(plainText(prefix+'\n# Casa\n**Texto**'),'Casa\nTexto');
  assert.equal(splitNoteSource('---\nUma divisão\n---\nTexto').prefix,'');
});
test('resumos e cópia mostram conteúdo legível de títulos, listas, links, tarefas e tabelas',()=>{
  const text=plainText('# Título\n\n**Negrito** e _itálico_\n\n- [x] Tarefa\n\n[[Original|Apelido]] [Site](https://example.com)\n\n|Nome|Valor|\n|---|---|\n|Olá|1|');
  assert.ok(text.includes('Título'));assert.ok(text.includes('Negrito e itálico'));assert.ok(text.includes('Tarefa'));assert.ok(text.includes('Apelido Site'));
  assert.ok(!text.includes('**'));assert.ok(!text.includes('https://'));assert.ok(!text.includes('[x]'));assert.ok(!text.includes('[['));
  assert.equal(plainText('# <u>**Texto sublinhado**</u>'),'Texto sublinhado');
});
test('um documento rico antigo nunca esconde uma edição Markdown recebida de outro computador',()=>{
  const doc={type:'doc',content:[]};const note={body:'nova versão',richText:{version:1,source:'antiga',doc}};
  assert.equal(documentForNote(note),null);note.richText.source=note.body;assert.equal(documentForNote(note),doc);
});
test('links rejeitam protocolos executáveis e só aceitam anexos com hash válido',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,oi','file:///C:/segredo','httpsx://site','notes-asset:../segredo'])assert.equal(allowedLink(value),false);
  for(const value of ['https://example.com','http://localhost','notes-asset:'+'a'.repeat(64)])assert.equal(allowedLink(value),true);
});

test('cópia e comparação decodificam blocos de código aninhados sem expor HTML ou entidades',()=>{
  const source='> <pre data-notes-code="1"><code class="language-python">if&#32;True:&#10;&#9;print(&lt;valor&gt;)&#10;&#32;&#32;&#10;&amp;#9;</code></pre>';
  assert.equal(plainText(source),'if True:\n\tprint(<valor>)\n  \n&#9;');
});

test('cópia e comparação não interpretam links de notas dentro de código',()=>{
  const text='const value = "[[Destino|literal]]";';
  assert.equal(plainText('```javascript\n'+text+'\n```'),text);
  assert.equal(plainText('`[[Destino|literal]]`'),'[[Destino|literal]]');
  assert.equal(plainText('[[Destino|Apelido]]'),'Apelido');
  assert.equal(plainText('<pre data-notes-code="1"><code class="language-javascript">const&#32;value&#32;=&#32;"[[Destino|literal]]";</code></pre>'),text);
});
