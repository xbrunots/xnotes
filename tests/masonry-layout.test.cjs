const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const esbuild=require('esbuild');

const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/masonry-layout.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const moduleObject={exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module:moduleObject,exports:moduleObject.exports},{timeout:1000});
const {masonryColumns,masonrySpan,packMasonry}=moduleObject.exports;
const plain=value=>structuredClone(value);
const intersects=(first,second)=>first.x<second.x+second.width-.001&&first.x+first.width>second.x+.001&&first.y<second.y+second.height-.001&&first.y+first.height>second.y+.001;
function noOverlap(packed,width){
  const {placements}=packed;
  for(let first=0;first<placements.length;first++){
    const placement=placements[first];assert.ok(placement.x>=0&&placement.y>=0);assert.ok(placement.x+placement.width<=width+.001,'cada cartão precisa caber na largura disponível');
    assert.ok(placement.y+placement.height<=packed.height+.001,'o espaçador precisa incluir o cartão inteiro');
    for(let second=first+1;second<placements.length;second++)assert.equal(intersects(placement,placements[second]),false,`cartões ${placement.id}/${placements[second].id} não podem se sobrepor`);
  }
}

test('masonry responsivo usa colunas de pelo menos280 sem overflow horizontal',()=>{
  for(const width of [120,280,571,572,900,1024,1440,3840]){
    const columns=masonryColumns({width,gap:12});
    assert.ok(columns.columnCount>=1);assert.ok(columns.columnWidth>0);
    assert.ok(columns.columnCount===1||columns.columnWidth>=280);
    assert.ok(Math.abs(columns.columnWidth*columns.columnCount+columns.gap*(columns.columnCount-1)-width)<.001);
  }
  assert.equal(masonryColumns({width:571}).columnCount,1);assert.equal(masonryColumns({width:572}).columnCount,2);
});

test('cada nota vai para a próxima coluna mais baixa preservando a ordem dos filhos',()=>{
  const packed=packMasonry({width:900,items:[{id:'a',height:400},{id:'b',height:100},{id:'c',height:200},{id:'d',height:90}]});
  assert.deepEqual(plain(packed.placements.map(item=>item.id)),['a','b','c','d']);
  assert.deepEqual(plain(packed.placements.map(item=>item.column)),[0,1,2,1]);
  assert.equal(packed.placements[3].y,112);assert.equal(packed.height,400);noOverlap(packed,900);
});

test('uma preferência larga ocupa colunas contíguas com a menor altura conjunta',()=>{
  const packed=packMasonry({width:900,items:[{id:'tall',height:500},{id:'short',height:100},{id:'wide',height:160,preferredWidth:600}]});
  const wide=packed.placements[2];assert.equal(wide.span,2);assert.equal(wide.column,1);assert.equal(wide.y,112);assert.equal(wide.width,596);
  assert.equal(masonrySpan(600,292,3,12),2);assert.equal(masonrySpan(9999,292,3,12),3);assert.equal(masonrySpan(0,292,3,12),1);
  noOverlap(packed,900);
});

test('notas que abrangem todas as colunas não atravessam outros cartões',()=>{
  const packed=packMasonry({width:900,items:[{id:'left',height:80},{id:'middle',height:200},{id:'right',height:140},{id:'all',height:110,preferredWidth:1600},{id:'next',height:60}]});
  assert.equal(packed.placements[3].span,3);assert.equal(packed.placements[3].y,212);assert.equal(packed.placements[3].width,900);
  assert.equal(packed.placements[4].y,334);noOverlap(packed,900);
});

test('notas muito longas conservam altura natural e as demais preenchem colunas livres',()=>{
  const packed=packMasonry({width:900,items:[{id:'long',height:25000},...Array.from({length:30},(_,index)=>({id:'n'+index,height:80+(index%3)*15}))]});
  assert.equal(packed.placements[0].height,25000);assert.equal(packed.height,25000);
  assert.ok(packed.placements.slice(1).every(placement=>placement.column!==0));noOverlap(packed,900);
});

test('redimensionar e mudar a preferência recalcula geometria sem mudar IDs, alturas ou dados de entrada',()=>{
  const items=[{id:'a',height:100,preferredWidth:600},{id:'b',height:230},{id:'c',height:160}];
  items.forEach(Object.freeze);Object.freeze(items);
  const before=plain(items),narrow=packMasonry({width:400,items}),wide=packMasonry({width:1200,items});
  assert.deepEqual(items,before);assert.deepEqual(plain(narrow.placements.map(item=>item.id)),plain(wide.placements.map(item=>item.id)));
  assert.deepEqual(plain(narrow.placements.map(item=>item.height)),[100,230,160]);
  assert.equal(narrow.columnCount,1);assert.ok(wide.columnCount>1);assert.ok(wide.placements[0].span>1);
  noOverlap(narrow,400);noOverlap(wide,1200);
});

test('janela sem largura ou dados parciais produzem geometria segura e sem IDs duplicados',()=>{
  for(const width of [0,-10,NaN,Infinity]){
    const empty=packMasonry({width,items:[{id:'a',height:100}]});assert.equal(empty.height,0);assert.equal(empty.columnCount,0);assert.equal(empty.placements.length,0);
  }
  const partial=packMasonry({width:900,items:[null,{id:'a',height:NaN},{id:'a',height:20},{id:'b',height:-5},{id:'c',height:Infinity},{id:'',height:100}]});
  assert.deepEqual(plain(partial.placements.map(item=>item.id)),['a','b','c']);
  assert.ok(partial.placements.every(item=>Number.isFinite(item.height)&&item.height===0));
  assert.ok(Number.isFinite(partial.height));assert.equal(packMasonry({width:900,items:[]}).height,0);
});

test('diversas alturas e spans preservam separação e cabem no total vertical calculado',()=>{
  let seed=947;
  const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
  for(const width of [280,580,900,1440,2100]){
    const items=Array.from({length:70},(_,index)=>({id:'n'+index,height:40+Math.floor(random()*1200),preferredWidth:index%4===0?280+Math.floor(random()*1300):undefined}));
    const packed=packMasonry({width,items,gap:9});assert.equal(packed.placements.length,70);noOverlap(packed,width);
  }
});
