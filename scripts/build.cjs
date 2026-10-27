const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');

async function build() {
  const root = path.join(__dirname, '..');
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  await fs.cp(path.join(root, 'src/assets'), path.join(root, 'app/assets'), { recursive: true });
  await fs.copyFile(path.join(root, 'src/index.html'), path.join(root, 'app/index.html'));
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main.jsx')],
    bundle: true,
    outfile: path.join(root, 'app/renderer.js'),
    minify: true,
    sourcemap: false,
    target: 'chrome140',
    loader: { '.woff2': 'file', '.ttf':'file' },
    assetNames: 'assets/[name]',
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof',
    plugins:[{
      name:'notes-inherited-code-colors',
      setup(builder){
        // The app owns the palette. Monaco's command palette must not expose
        // a separate global theme toggle that invalidates per-note token colors.
        builder.onResolve({filter:/\/toggleHighContrast\.js$/},()=>({path:'fixed-note-theme',namespace:'notes-code-theme'}));
        builder.onLoad({filter:/.*/,namespace:'notes-code-theme'},()=>({contents:'export {};',loader:'js'}));
      },
    }],
  });
  await Promise.all(['editor','json','css','html','typescript'].map(kind=>esbuild.build({
    entryPoints:[path.join(root,'node_modules/monaco-editor/esm/vs',kind==='editor'?'editor/editor.worker.js':'language/'+kind+'/'+(kind==='typescript'?'ts':kind)+'.worker.js')],
    bundle:true,outfile:path.join(root,'app/workers',kind+'.worker.js'),format:'iife',platform:'browser',target:'chrome140',minify:true,sourcemap:false,legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'},
  })));
  console.log('Interface notes compilada com as fontes locais.');
}

if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build };
