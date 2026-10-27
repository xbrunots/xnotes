const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const esbuild=require('esbuild');

const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/panel-sizing.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const moduleObject={exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module:moduleObject,exports:moduleObject.exports},{timeout:1000});
const {PANEL_LIMITS,PANEL_SIZE_ENTRY_LIMITS,EDITOR_MIN_WIDTH,clampPanelSize,normalizePanelSizes,isValidPanelSizes,calculatePanelLayout,calculateNoteWidths}=moduleObject.exports;
const plain=value=>structuredClone(value);
const frozen=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(frozen);}return value;};

test('preferências de largura aceitam somente dimensões finitas, mapas limitados e chaves seguras',()=>{
  const valid={sidebar:240,list:300,notes:{'n-123':450},sections:{groups:280,tags:160,'group:g1':90}};
  assert.equal(isValidPanelSizes(valid),true);assert.deepEqual(plain(normalizePanelSizes(valid)),valid);
  for(const invalid of [null,[],42,{sidebar:NaN},{sidebar:Infinity},{sidebar:'240'},{sidebar:179},{list:521},{notes:[]},{notes:{n1:259}},{notes:{n1:1601}},{sections:{tags:79}},{sections:{tags:1601}},{notes:{'../arquivo':400}},{notes:JSON.parse('{"__proto__":400}')},{sections:{constructor:120}},{sidebar:240,unexpected:true}])assert.equal(isValidPanelSizes(invalid),false);
});

test('normalização conserva apenas tamanhos úteis e limita os dois mapas sem mutar a entrada',()=>{
  const initial={sidebar:900,list:-1,notes:{n1:1700,n2:NaN,'bad/path':400},sections:{groups:0,tags:Infinity}};
  const before=plain(initial),normalized=plain(normalizePanelSizes(frozen(initial)));
  assert.deepEqual(initial,before);assert.deepEqual(normalized,{sidebar:420,list:220,notes:{n1:1600},sections:{groups:80}});
  const many={notes:Object.fromEntries(Array.from({length:520},(_,index)=>['n'+index,300])),sections:Object.fromEntries(Array.from({length:70},(_,index)=>['s'+index,200]))};
  assert.equal(isValidPanelSizes(many),false);
  const bounded=normalizePanelSizes(many);
  assert.equal(Object.keys(bounded.notes).length,PANEL_SIZE_ENTRY_LIMITS.notes);assert.equal(Object.keys(bounded.sections).length,PANEL_SIZE_ENTRY_LIMITS.sections);
  assert.equal(bounded.notes.n519,300,'as entradas mais recentes devem sobreviver ao limite');assert.equal(bounded.notes.n0,undefined);
  assert.equal(isValidPanelSizes(bounded),true);
});

test('padrões preservam a geometria contínua e reservam corretamente os gaps da aparência Ilha',()=>{
  const standard=calculatePanelLayout({width:1440}),islands=calculatePanelLayout({width:1440,appearance:'islands'}),compact=calculatePanelLayout({width:1024,appearance:'islands'});
  assert.equal(standard.sidebarWidth,244);assert.equal(standard.listWidth,300);assert.equal(standard.editorWidth,896);assert.equal(standard.gap,0);assert.equal(standard.padding,0);
  assert.equal(islands.sidebarWidth,244);assert.equal(islands.listWidth,300);assert.equal(islands.editorWidth,848);assert.equal(islands.gap,12);assert.equal(islands.padding,12);
  assert.equal(compact.sidebarWidth,220);assert.equal(compact.listWidth,264);assert.equal(compact.editorWidth,504);assert.equal(compact.gap,9);assert.equal(compact.padding,9);
});

test('a janela mínima distribui redução entre os painéis e preserva 320px para o editor',()=>{
  const preferred=frozen({sidebar:420,list:520}),before=plain(preferred),result=calculatePanelLayout({width:960,appearance:'islands',panelSizes:preferred});
  assert.equal(result.editorWidth,EDITOR_MIN_WIDTH);
  assert.ok(result.sidebarWidth>=PANEL_LIMITS.sidebar.min&&result.sidebarWidth<420);
  assert.ok(result.listWidth>=PANEL_LIMITS.list.min&&result.listWidth<520);
  assert.equal(result.sidebarWidth+result.listWidth+result.editorWidth+result.overhead,960);
  assert.equal(result.minimumsSatisfied,true);assert.deepEqual(preferred,before);
  const restored=calculatePanelLayout({width:1440,appearance:'islands',panelSizes:preferred});
  assert.equal(restored.sidebarWidth,420);assert.equal(restored.listWidth,520,'a janela maior recupera a escolha original');
});

test('recolher sidebar remove coluna e gap extras e devolve a largura ao editor',()=>{
  for(const appearance of ['standard','islands']){
    const open=calculatePanelLayout({width:960,appearance,panelSizes:{sidebar:420,list:520}}),closed=calculatePanelLayout({width:960,appearance,sidebar:false,panelSizes:{sidebar:420,list:520}});
    assert.equal(closed.sidebarWidth,0);assert.equal(closed.listWidth,520);assert.ok(closed.editorWidth>open.editorWidth);
    assert.equal(closed.columns,'520px minmax(0,1fr)');assert.ok(!closed.columns.startsWith('0px '));
    assert.equal(closed.overhead,appearance==='islands'?27:0);
    assert.equal(closed.listWidth+closed.editorWidth+closed.overhead,960);
  }
});

test('qualquer combinação suportada de janela, aparência e larguras cabe sem scroll global',()=>{
  for(const width of [960,1024,1099,1100,1440,1920,3840])for(const appearance of ['standard','islands'])for(const sidebar of [true,false])for(const panelSizes of [{},{sidebar:180,list:220},{sidebar:420,list:520},{sidebar:360,list:220},{sidebar:180,list:500}]){
    const result=calculatePanelLayout({width,appearance,sidebar,panelSizes});
    assert.ok(result.editorWidth>=320,JSON.stringify({width,appearance,sidebar,panelSizes,result}));
    assert.equal(result.sidebarWidth+result.listWidth+result.editorWidth+result.overhead,width);
    assert.ok(result.listWidth>=220&&result.listWidth<=520);
    assert.ok(!sidebar||(result.sidebarWidth>=180&&result.sidebarWidth<=420));
    assert.ok(result.listWidth>=result.listLimits.min&&result.listWidth<=result.listLimits.max);
    assert.ok(!sidebar||(result.sidebarWidth>=result.sidebarLimits.min&&result.sidebarWidth<=result.sidebarLimits.max));
    assert.ok(result.listLimits.max+result.sidebarWidth+320+result.overhead<=width);
    if(sidebar)assert.ok(result.sidebarLimits.max+result.listWidth+320+result.overhead<=width);
  }
});

test('medidas ausentes ou abaixo do mínimo não produzem NaN, números negativos ou overflow externo',()=>{
  assert.equal(calculatePanelLayout({width:NaN}).viewportWidth,1440);
  for(const width of [0,240,500,640,800]){
    const result=calculatePanelLayout({width,appearance:'islands',panelSizes:{sidebar:420,list:520}});
    for(const name of ['sidebarWidth','listWidth','editorWidth','availableWidth'])assert.ok(Number.isFinite(result[name])&&result[name]>=0);
    assert.ok(result.sidebarWidth+result.listWidth+result.editorWidth<=width);
  }
  assert.equal(clampPanelSize(Infinity,180,420,244),244);assert.equal(clampPanelSize(800,180,420),420);
  assert.equal(clampPanelSize(80,80.4,80.6),80.4,'limites fracionários continuam válidos');
});

test('notas sem tamanho salvo dividem a área disponível e IDs repetidos não criam painéis duplicados',()=>{
  const sizing=calculateNoteWidths({ids:['n1','n2','n3','n1'],availableWidth:1000,gap:12});
  assert.equal(Object.keys(sizing.widths).length,3);assert.equal(sizing.totalWidth,1000);assert.equal(sizing.overflow,false);
  for(const size of Object.values(sizing.widths))assert.ok(size>=325&&size<=326);
  const empty=calculateNoteWidths({ids:[],availableWidth:900});assert.equal(empty.totalWidth,0);assert.equal(empty.overflow,false);
});

test('largura explícita de uma nota redistribui apenas o espaço das notas sem preferência',()=>{
  const preferred=frozen({notes:{n1:500}}),sizing=calculateNoteWidths({ids:['n1','n2'],availableWidth:900,panelSizes:preferred,gap:12});
  assert.equal(sizing.widths.n1,500);assert.equal(sizing.widths.n2,388);assert.equal(sizing.totalWidth,900);assert.equal(sizing.overflow,false);
  assert.deepEqual(plain(preferred),{notes:{n1:500}});
});

test('notas largas ou várias notas mantêm mínimo de260 com overflow restrito à área de editores',()=>{
  const wide=calculateNoteWidths({ids:['n1','n2'],availableWidth:800,panelSizes:{notes:{n1:1600}},gap:12});
  assert.equal(wide.widths.n1,1600);assert.equal(wide.widths.n2,260);assert.equal(wide.totalWidth,1872);assert.equal(wide.availableWidth,800);assert.equal(wide.overflow,true);
  const narrow=calculateNoteWidths({ids:['n1','n2','n3'],availableWidth:320,gap:9});
  assert.equal(narrow.totalWidth,798);assert.equal(narrow.overflow,true);
  const outer=calculatePanelLayout({width:960,appearance:'islands'});assert.ok(outer.editorWidth>=320,'overflow local das notas não muda as colunas externas');
});
