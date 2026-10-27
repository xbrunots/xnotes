// Every editor and language worker is bundled with the portable. No CDN or
// remote language service is involved in displaying or editing a code block.
self.MonacoEnvironment={
  getWorker(_moduleId,label){
    const kind=label==='json'?'json':['css','scss','less'].includes(label)?'css':['html','handlebars','razor'].includes(label)?'html':['typescript','javascript'].includes(label)?'typescript':'editor';
    return new Worker(new URL('./workers/'+kind+'.worker.js',window.location.href),{name:'notes-code-'+kind});
  },
};
