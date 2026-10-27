const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const vm=require('node:vm');
const esbuild=require('esbuild');
const built=esbuild.buildSync({stdin:{contents:"export * from './src/code-languages';export * from './src/code-serialization';",resolveDir:path.join(__dirname,'..')},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const mod={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module:mod,exports:mod.exports},{timeout:1000});
const {CODE_LANGUAGES,normalizeCodeLanguage,detectCodeLanguage,pastedCodeLanguage,serializeNestedCode,decodeNestedCode}=mod.exports;

test('catálogo de código oferece IDs únicos e aliases de mais de oitenta linguagens locais',()=>{
  assert(CODE_LANGUAGES.length>=80);assert.equal(new Set(CODE_LANGUAGES.map(item=>item.id)).size,CODE_LANGUAGES.length);
  for(const item of CODE_LANGUAGES){assert(/^[a-z][a-z0-9-]*$/.test(item.id));assert(item.name);assert.equal(normalizeCodeLanguage(item.id),item.id);for(const alias of item.aliases)assert.equal(normalizeCodeLanguage(alias),item.id);}
  for(const input of [undefined,null,'#fff','unknown','<script>','javascript;alert(1)'])assert.equal(normalizeCodeLanguage(input),'plaintext');
  assert.equal(normalizeCodeLanguage('language-js'),'javascript');assert.equal(normalizeCodeLanguage('TSX'),'typescript');
});
test('reconhecimento automático identifica código sem alterar caracteres ou indentação',()=>{
  const cases=[
    ['javascript','const saudação = "Olá 👋";\n\tconsole.log(saudação);'],
    ['javascript','const message = `\n```example\nconteúdo\n```\n`;'],
    ['typescript','interface Note {\n  title: string;\n}'],
    ['python','def hello(name):\n    return f"Olá {name}"'],
    ['json','{\n  "name": "notes",\n  "count": 2\n}'],
    ['html','<div class="hello">\n  <strong>Olá</strong>\n</div>'],
    ['css','.note {\n  display: grid;\n  color: red;\n}'],
    ['sql','SELECT id, title\nFROM notes\nWHERE archived = false;'],
    ['go','package main\n\nfunc main() {\n  println("notes")\n}'],
    ['rust','pub fn main() {\n    println!("notes");\n}'],
    ['csharp','using System;\nConsole.WriteLine("notes");'],
    ['shell','#!/usr/bin/env bash\nprintf "notes\\n"'],
  ];
  for(const [language,text] of cases){const before=String(text);assert.equal(detectCodeLanguage(text),language,text);assert.equal(text,before);}
});
test('prosa, Markdown e dados ambíguos permanecem no editor visual',()=>{
  for(const text of ['Vamos rever o projeto amanhã.','Minha função é organizar notas.','- [x] Comprar leite\n- [ ] Ler um livro','# Reunião\n\nO objetivo é manter notas.','Roteiro {Lisboa}: visitar Belém.','https://example.com/?q=hello','importante: preparar reunião','```js\nconst x = 1;\n```','# Notas\n\n```js\nconst x=1;\n```','Exemplo para amanhã:\nconsole.log(42);','',null])assert.equal(detectCodeLanguage(text),null,String(text));
});
test('cada opção corresponde a uma linguagem realmente distribuída no Monaco offline',()=>{
  const root=path.join(__dirname,'../node_modules/monaco-editor/esm/vs/languages/definitions'),ids=new Set(['plaintext','json']);
  for(const folder of fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory())){
    const file=path.join(root,folder.name,'register.js');if(!fs.existsSync(file))continue;
    for(const match of fs.readFileSync(file,'utf8').matchAll(/id:\s*"([^"]+)"/g))ids.add(match[1]);
  }
  for(const item of CODE_LANGUAGES)assert(ids.has(item.id),'Linguagem não distribuída: '+item.id);
});
test('metadados do clipboard são opcionais, limitados e não autorizam linguagem arbitrária',()=>{
  assert.equal(pastedCodeLanguage('qualquer código',{mode:'python'}),'python');
  assert.equal(pastedCodeLanguage('let x = 1;','{"mode":"typescript"}'),'typescript');
  assert.equal(pastedCodeLanguage('texto','{"mode":"<script>"}'),null);
  assert.equal(pastedCodeLanguage('const x = 1;','{broken'),'javascript');
  assert.equal(pastedCodeLanguage('texto',{language:'sh'}),'shell');
});
test('código aninhado preserva whitespace e entidades literais com decode único e sem HTML ativo',()=>{
  const text='\nif True:\n\tprint("Olá 👋 & &#9; &lt;")\n        print("b")\n  \n\t\n\n</code></pre><script>alert(1)</script>\r\n';
  const encoded=serializeNestedCode(text,'py');assert(!/[\r\n\t]/.test(encoded));assert(!encoded.includes('<script>'));
  const decoded=decodeNestedCode(encoded);assert.equal(decoded.text,text);assert.equal(decoded.language,'python');
  assert.equal(decodeNestedCode(serializeNestedCode('&#9; &amp;#10;','txt')).text,'&#9; &amp;#10;');
  for(const malformed of ['<pre><code>code</code></pre>','<pre data-notes-code="1"><code class="language-js"><script>alert(1)</script></code></pre>','<pre data-notes-code="1"><code class="language-js">&#9999999;</code></pre>','<pre data-notes-code="1"><code class="language-js">&unknown;</code></pre>'])assert.equal(decodeNestedCode(malformed),null);
});
