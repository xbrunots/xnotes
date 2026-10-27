// The saved value is a Monaco language ID. This closed catalog also prevents
// imported language labels from becoming class names or executable settings.
const language=(id,name,...aliases)=>Object.freeze({id,name,aliases:Object.freeze(aliases)});
export const CODE_LANGUAGES=Object.freeze([
  language('plaintext','Texto simples','text','txt','plain','none'),
  language('abap','ABAP'),language('apex','Apex'),language('azcli','Azure CLI','azurecli'),
  language('bat','Batch','batch','cmd'),language('bicep','Bicep'),language('c','C'),
  language('cpp','C++','c++','cplusplus','cc','h','hpp'),language('cameligo','CameLIGO'),
  language('clojure','Clojure','clj'),language('coffeescript','CoffeeScript','coffee'),
  language('csharp','C#','c#','cs'),language('csp','CSP'),language('css','CSS'),
  language('cypher','Cypher'),language('dart','Dart'),language('dockerfile','Dockerfile','docker'),
  language('ecl','ECL'),language('elixir','Elixir','ex','exs'),language('flow9','Flow9'),
  language('fsharp','F#','f#','fs','fsx'),language('freemarker2','FreeMarker','ftl'),
  language('go','Go','golang'),language('graphql','GraphQL','gql'),
  language('handlebars','Handlebars','hbs'),language('hcl','HCL / Terraform','terraform','tf'),
  language('html','HTML','htm'),language('ini','INI / Properties','properties','conf'),
  language('java','Java'),language('javascript','JavaScript','js','jsx','mjs','cjs'),
  language('json','JSON','jsonc'),language('julia','Julia','jl'),language('kotlin','Kotlin','kt','kts'),
  language('less','Less'),language('lexon','Lexon'),language('liquid','Liquid'),language('lua','Lua'),
  language('m3','Modula-3'),language('markdown','Markdown','md'),language('mdx','MDX'),
  language('mips','MIPS','asm'),language('msdax','DAX','dax'),language('mysql','MySQL'),
  language('objective-c','Objective-C','objc','objectivec'),language('pascal','Pascal','pas'),
  language('pascaligo','PascaLIGO'),language('perl','Perl','pl'),language('pgsql','PostgreSQL','postgres','postgresql'),
  language('php','PHP'),language('pla','PLA'),language('postiats','ATS / Postiats','ats'),
  language('powerquery','Power Query','pq'),language('powershell','PowerShell','ps1','pwsh'),
  language('proto','Protocol Buffers','protobuf'),language('pug','Pug','jade'),
  language('python','Python','py','python3','py3'),language('qsharp','Q#','q#','qs'),
  language('r','R'),language('razor','Razor','cshtml'),language('redis','Redis'),
  language('redshift','Redshift'),language('restructuredtext','reStructuredText','rst'),
  language('ruby','Ruby','rb'),language('rust','Rust','rs'),language('sb','Small Basic','smallbasic'),
  language('scala','Scala'),language('scheme','Scheme','scm'),language('scss','SCSS','sass'),
  language('shell','Shell / Bash','bash','sh','zsh','shellscript'),language('sol','Solidity','solidity'),
  language('aes','Sophia','sophia'),language('sparql','SPARQL'),language('sql','SQL'),
  language('st','Structured Text'),language('swift','Swift'),language('systemverilog','SystemVerilog','verilog','sv'),
  language('tcl','Tcl'),language('twig','Twig'),language('typescript','TypeScript','ts','tsx'),
  language('typespec','TypeSpec','tsp'),language('vb','Visual Basic','vbnet','visualbasic'),
  language('wgsl','WGSL'),language('xml','XML','xsl','xsd','svg'),language('yaml','YAML','yml'),
]);

const known=new Map();
for(const item of CODE_LANGUAGES)for(const value of [item.id,item.name,...item.aliases])known.set(value.toLowerCase(),item.id);
const lookup=value=>typeof value==='string'?known.get(value.trim().replace(/^language-/i,'').toLowerCase()):undefined;
export const normalizeCodeLanguage=value=>lookup(value) || 'plaintext';

/** Conservative recognition: ordinary prose, checklists and Markdown stay in
 * the visual editor. Recognition never changes the original code string. */
export function detectCodeLanguage(source){
  if(typeof source!=='string'||!source.trim())return null;
  // Recognition only needs a bounded sample; the caller retains all content.
  const text=source.slice(0,32000).trim();
  if(/^(?:```|~~~)/.test(text))return null;
  if(/^(?:\{|\[)[\s\S]*(?:\}|\])$/.test(text)){
    try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object')return 'json';}catch{/* Other languages also use braces. */}
  }
  if(/^#!.*\b(?:python[\d.]*)\b/.test(text))return 'python';
  if(/^#!.*\b(?:node|deno|bun)\b/.test(text))return 'javascript';
  if(/^#!.*\b(?:bash|sh|zsh)\b/.test(text))return 'shell';
  if(/^<\?xml\b/.test(text))return 'xml';
  if(/^<!doctype\s+html\b/i.test(text)||/^<(?:html|head|body|div|section|main|article|form|button|script|style)\b[^>]*>[\s\S]*<\//i.test(text))return 'html';
  if(/^(?:FROM\s+\S+[^\n]*\n)(?:[\s\S]*\n)?(?:RUN|COPY|WORKDIR|CMD|ENTRYPOINT|ENV|EXPOSE)\b/.test(text))return 'dockerfile';
  if(/^\s*(?:syntax\s*=\s*["']proto[23]["']\s*;|message\s+\w+\s*\{)/.test(text))return 'proto';
  if(/^\s*(?:query|mutation|subscription)\b[^\n]*\{/.test(text))return 'graphql';
  if(/^\s*(?:SELECT\s+[\s\S]+?\s+FROM\s+\w|CREATE\s+TABLE\s+\w|INSERT\s+INTO\s+\w|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s+\w)/i.test(text))return 'sql';
  if(/^\s*(?:package\s+\w+\s*\n[\s\S]*\bfunc\s+|func\s+(?:\([^)]*\)\s*)?\w+\([^)]*\)[^{]*\{)/.test(text))return 'go';
  if(/^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+\s*\(|use\s+[\w:]+(?:::\{[^}]+\})?\s*;|let\s+mut\s+\w+\s*[:=])/.test(text))return 'rust';
  if(/^\s*(?:using\s+System(?:\.\w+)*\s*;|namespace\s+[\w.]+\s*[{;]|(?:public\s+)?(?:static\s+)?class\s+\w+[^\n]*\{[\s\S]*\b(?:Console|Task|string)\b)/.test(text))return 'csharp';
  if(/^\s*(?:package\s+[\w.]+\s*;|import\s+java\.[\w.*]+\s*;|public\s+(?:final\s+)?class\s+\w+)/.test(text))return 'java';
  if(/^\s*#\s*include\s*[<"][^>"\n]+[>"]/.test(text))return /\b(?:std::|cout|cin|class\s+\w+)/.test(text)?'cpp':'c';
  if(/^\s*(?:async\s+)?def\s+\w+\s*\([^\n]*\)\s*(?:->[^\n]+)?\s*:|^\s*(?:from\s+[\w.]+\s+import\s+\w|import\s+\w+(?:\s+as\s+\w+)?\s*$)|^\s*class\s+\w+(?:\([^\n]*\))?\s*:/.test(text))return 'python';
  if(/^\s*print\s*\([^\n]+\)\s*$/.test(text)&&!/[{};]/.test(text))return 'python';
  if(/^\s*<\?php\b|^\s*\$\w+\s*=.*;\s*$/.test(text))return 'php';
  if(/^\s*(?:param\s*\(|\$(?:env:)?\w+\s*=\s*(?:Get-|Set-|New-|@\{|@\(|\[)|(?:Get|Set|New|Write|Invoke|Test|Remove|Start)-[A-Z][\w-]*(?:\s+-\w+|\s*["']))/.test(text))return 'powershell';
  if(/^\s*(?:(?:export\s+)?(?:interface|type|enum)\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\s*(?:[<{=:])|(?:const|let|var)\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\s*:\s*\w+[^\n]*=|(?:export\s+)?(?:async\s+)?function\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\([^)]*\)\s*:\s*\w+)/u.test(text))return 'typescript';
  if(/^\s*(?:(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*[\p{ID_Continue}$]*\s*\(|(?:export\s+)?(?:const|let|var)\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\s*=|import\s+.+\s+from\s+["']|(?:console\.(?:log|error|warn)|document\.querySelector)\s*\()/u.test(text))return 'javascript';
  if(/^(?:[.#][\w-]+|[a-z][\w-]*(?:\s+[.#]?[\w-]+)*)\s*\{[^}]*[\w-]+\s*:\s*[^;{}]+;[^}]*\}/i.test(text))return 'css';
  if(/^\s*(?:echo\s+["'][^\n]+|(?:npm|pnpm|yarn|git|pip3?|cargo|docker)\s+(?:install|add|run|build|clone|status|commit|push|pull|test)\b[^\n]*)\s*$/.test(text)&&!/^\s*[-*#]/m.test(text))return 'shell';
  return null;
}

/** Clipboard integrations may provide VS Code's mode or a MIME language hint.
 * Unrecognized or malformed metadata falls back to conservative recognition. */
export function pastedCodeLanguage(source,hint){
  let metadata=hint;
  if(typeof hint==='string'){
    const direct=lookup(hint);if(direct)return direct;
    if(hint.length<16000){try{metadata=JSON.parse(hint);}catch{metadata=null;}}
  }
  if(metadata&&typeof metadata==='object'){
    const detected=lookup(metadata.mode)||lookup(metadata.language)||lookup(metadata.languageId);
    if(detected)return detected;
  }
  return detectCodeLanguage(source);
}
