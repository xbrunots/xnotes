const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const esbuild=require('esbuild');
const {Editor}=require('@tiptap/core');
const {history}=require('@tiptap/pm/history');

const root=path.join(__dirname,'..');
const built=esbuild.buildSync({
  stdin:{contents:"export {editorExtensions} from './src/editor-extensions'; export {applyNoteContent} from './src/editor-content';",resolveDir:root},
  bundle:true,write:false,platform:'node',format:'cjs',packages:'external',logLevel:'silent',
});
const compiled=new Module(path.join(__dirname,'editor-history-runtime.cjs'),module);
compiled.filename=path.join(__dirname,'editor-history-runtime.cjs');
compiled.paths=module.paths;
compiled._compile(built.outputFiles[0].text,compiled.filename);
const {editorExtensions,applyNoteContent}=compiled.exports;

function editorFor(t,content='Original'){
  const editor=new Editor({element:null,extensions:editorExtensions(),content,contentType:'markdown'});
  // Without a DOM mount TipTap does not install extension plugins. Install the
  // actual ProseMirror history used by StarterKit, rather than mocking undo.
  editor.registerPlugin(history({depth:150}));
  t.after(()=>editor.destroy());
  return editor;
}

test('undo nunca ressuscita o texto anterior a uma atualização remota Markdown',t=>{
  const editor=editorFor(t);
  editor.commands.insertContentAt(1,{type:'text',text:'Edição local. '});
  assert.equal(editor.can().undo(),true,'o histórico real precisa registrar edições locais');
  const updates=[];editor.on('update',()=>updates.push(editor.getMarkdown()));

  applyNoteContent(editor,'# Conteúdo recebido do outro PC',{contentType:'markdown',errorOnInvalidContent:true});
  const received=editor.getJSON();
  assert.deepEqual(updates,[],'receber sync não pode disparar um novo autosave');
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(),received,'Ctrl+Z não pode regravar a versão antiga sobre a remota');
  editor.commands.redo();
  assert.deepEqual(editor.getJSON(),received);
});

test('documento rico inicial ou remoto preserva formato, links e anexos fora do undo',t=>{
  const editor=editorFor(t,'Fonte Markdown anterior');
  const hash='a'.repeat(64);
  const doc={type:'doc',content:[
    {type:'paragraph',attrs:{textAlign:'center'},content:[
      {type:'text',text:'Texto rico',marks:[{type:'bold'},{type:'underline'}]},
      {type:'text',text:' Outra nota',marks:[{type:'noteLink',attrs:{target:'Destino'}}]},
    ]},
    {type:'paragraph',content:[{type:'image',attrs:{src:'notes-asset:'+hash,alt:'Imagem preservada'}}]},
  ]};
  let updates=0;editor.on('update',()=>updates++);
  applyNoteContent(editor,doc,{contentType:'json',errorOnInvalidContent:true,emitUpdate:true});
  const received=editor.getJSON();
  assert.equal(updates,0,'o helper deve silenciar update mesmo se um chamador pedir emitUpdate');
  assert.equal(editor.can().undo(),false);
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(),received);
  assert.equal(received.content[0].attrs.textAlign,'center');
  assert.ok(received.content[0].content[0].marks.some(mark=>mark.type==='underline'));
  assert.equal(received.content[0].content[1].marks[0].attrs.target,'Destino');
  assert.equal(received.content[1].content[0].attrs.src,'notes-asset:'+hash);
});

test('edição local após sync continua desfeita normalmente sem alterar o conteúdo remoto',t=>{
  const editor=editorFor(t);
  applyNoteContent(editor,'Texto remoto preservado',{contentType:'markdown'});
  const received=editor.getJSON();
  editor.commands.insertContentAt(1,{type:'text',text:'Novo texto local. '});
  assert.ok(editor.state.doc.textContent.startsWith('Novo texto local. '));
  assert.equal(editor.commands.undo(),true);
  assert.deepEqual(editor.getJSON(),received);
  assert.equal(editor.commands.redo(),true);
  assert.ok(editor.state.doc.textContent.startsWith('Novo texto local. '));
});

test('imagens em parágrafos, títulos, listas, tabelas e isoladas continuam válidas e editáveis',t=>{
  const target='notes-asset:'+'b'.repeat(64);
  const image='![Imagem preservada]('+target+')';
  const sources=[
    'Antes '+image+' depois',
    '# Título '+image+' depois',
    '- Item '+image+' depois',
    '| Nome | Recurso |\n| --- | --- |\n| Antes | '+image+' depois |',
    image,
  ];
  for(const source of sources){
    const editor=editorFor(t,source);
    assert.doesNotThrow(()=>editor.state.doc.check(),'a fonte deve produzir um documento válido: '+source);
    let position;
    editor.state.doc.descendants((node,pos)=>{if(node.isText&&position===undefined)position=pos;});
    assert.equal(editor.commands.insertContentAt(position ?? 1,{type:'text',text:'Novo '}),true);
    assert.doesNotThrow(()=>editor.state.doc.check(),'editar ao lado do anexo deve continuar válido');
    const rendered=editor.getMarkdown();
    assert.ok(rendered.includes(target),'o anexo não pode desaparecer ao editar');
    if(source.includes('depois'))assert.ok(editor.state.doc.textContent.includes('depois'),'o texto após a imagem deve sobreviver');
    const reopened=editorFor(t,rendered);
    assert.doesNotThrow(()=>reopened.state.doc.check(),'a fonte salva deve continuar editável ao reabrir');
    const images=[];reopened.state.doc.descendants(node=>{if(node.type.name==='image')images.push(node);});
    assert.equal(images.length,1);
    assert.equal(images[0].attrs.src,target);
  }
});

test('blocos de código preservam linguagem, indentação, crases e linhas vazias no Markdown e no documento rico',t=>{
  const texts=['\n\tconst message = `\n```exemplo\n~~~\n`;\n\n','<script>alert("inert")</script>\n','  antes\n\n\n  depois\n'];
  for(const text of texts){
    const editor=editorFor(t);
    applyNoteContent(editor,{type:'doc',content:[{type:'codeBlock',attrs:{language:'javascript'},content:[{type:'text',text}]}]},{contentType:'json',errorOnInvalidContent:true});
    const source=editor.getMarkdown(),reopened=editorFor(t,source),block=reopened.getJSON().content.find(node=>node.type==='codeBlock');
    assert.equal(block.attrs.language,'javascript');assert.equal(block.content.map(node=>node.text || '').join(''),text);
    assert.equal(reopened.state.doc.textContent,text);assert.equal(reopened.can().undo(),false);
  }
});

test('código em listas e citações preserva TABs e espaços em linhas vazias ao exportar e reimportar',t=>{
  const text='\nif True:\n\tprint("a")\n        print("b")\n  \n\t\n\n';
  const block={type:'codeBlock',attrs:{language:'python'},content:[{type:'text',text}]};
  const paragraph={type:'paragraph',content:[{type:'text',text:'Item'}]};
  const containers=[
    {type:'bulletList',content:[{type:'listItem',content:[paragraph,block]}]},
    {type:'orderedList',attrs:{start:1},content:[{type:'listItem',content:[paragraph,block]}]},
    {type:'taskList',content:[{type:'taskItem',attrs:{checked:false},content:[paragraph,block]}]},
    {type:'blockquote',content:[block]},
  ];
  for(const container of containers){
    const editor=editorFor(t);applyNoteContent(editor,{type:'doc',content:[container]},{contentType:'json',errorOnInvalidContent:true});
    const source=editor.getMarkdown(),reopened=editorFor(t,source),blocks=[];
    reopened.state.doc.descendants(node=>{if(node.type.name==='codeBlock')blocks.push(node);});
    assert.equal(blocks.length,1,container.type+' preserva o widget');assert.equal(blocks[0].textContent,text,container.type+' preserva cada caractere do código');assert.equal(blocks[0].attrs.language,'python');
  }
});
