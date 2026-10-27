const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const esbuild=require('esbuild');

const built=esbuild.buildSync({entryPoints:[path.join(__dirname,'../src/themes.js')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const moduleContext={exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module:moduleContext,exports:moduleContext.exports},{timeout:1000});
const {THEMES,DEFAULT_THEME_ID,resolveTheme,themeVariables}=moduleContext.exports;

const color=value=>{
  if(value.startsWith('#'))return value.slice(1).match(/../g).map(part=>parseInt(part,16)).concat(1);
  const values=value.match(/[\d.]+/g).map(Number);return [...values.slice(0,3),values[3]??1];
};
const blend=(over,under)=>over.slice(0,3).map((channel,index)=>channel*over[3]+under[index]*(1-over[3])).concat(1);
const luminance=rgb=>rgb.slice(0,3).map(channel=>channel/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4).reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0);
const contrast=(first,second)=>(Math.max(luminance(first),luminance(second))+.05)/(Math.min(luminance(first),luminance(second))+.05);

test('dez temas têm cinco modos escuros e cinco claros, todos com os mesmos materiais',()=>{
  assert.equal(THEMES.length,10);
  assert.equal(THEMES.filter(theme=>theme.mode==='dark').length,5);
  assert.equal(THEMES.filter(theme=>theme.mode==='light').length,5);
  assert.equal(new Set(THEMES.map(theme=>theme.id)).size,10);
  const keys=Object.keys(THEMES[0].variables).sort();
  for(const theme of THEMES){
    assert.deepEqual(Object.keys(theme.variables).sort(),keys);
    assert.ok(theme.name&&theme.description);
    assert.equal(theme.variables['--accent'],undefined);
    assert.equal(theme.variables['--blur'],undefined);
  }
});

test('Obsidiana é o padrão quase preto e Carbono mantém luminância muito baixa',()=>{
  assert.equal(DEFAULT_THEME_ID,'obsidian');
  assert.equal(resolveTheme().id,'obsidian');
  assert.equal(resolveTheme('desconhecido','light').id,'snow');
  assert.equal(resolveTheme('midnight','light').id,'midnight');
  for(const id of ['obsidian','carbon']){
    const variables=themeVariables(id);
    for(const token of ['--wall','--b1','--b2','--b3','--b4'])assert.ok(luminance(color(variables[token]))<.007,`${id} ${token} é escuro`);
  }
});

test('texto principal, secundário e auxiliar preservam contraste nas superfícies dos dez temas',()=>{
  for(const theme of THEMES){
    const tokens=theme.variables;
    for(const background of ['--wall','--b1','--b2','--b3','--b4']){
      const base=color(tokens[background]);
      const window=blend(color(tokens['--win']),base);
      const surfaces=[window,...['--side','--list','--glass-strong','--field'].map(name=>blend(color(tokens[name]),window))];
      for(const ink of ['--ink','--ink-2','--ink-3']){
        for(const surface of surfaces)assert.ok(contrast(color(tokens[ink]),surface)>=4.5,`${theme.id}: ${ink} sobre ${background} (${contrast(color(tokens[ink]),surface).toFixed(2)}:1)`);
      }
    }
  }
});

test('os tokens de um tema podem ser combinados sem alterar o catálogo',()=>{
  const first=themeVariables('obsidian');
  first['--wall']='#FFFFFF';first['--accent']='#123456';
  assert.equal(resolveTheme('obsidian').variables['--wall'],'#020203');
  assert.equal(themeVariables('obsidian')['--accent'],undefined);
});
