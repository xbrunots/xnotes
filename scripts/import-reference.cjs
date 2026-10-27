// Imports the supplied design without reinterpreting its markup, values or assets.
// The original Notas.html is read-only. The app does not run its bundler/runtime.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { parse } = require('parse5');

const root = path.join(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'Notas.html'), 'utf8');
const island = kind => JSON.parse(original.match(new RegExp('<script type="__bundler/' + kind + '">([\\s\\S]*?)<\\/script>'))[1]);
const manifest = island('manifest');
const template = island('template').replaceAll('⌘K','Ctrl+K').replaceAll('⌘J','Ctrl+J').replaceAll('⌥N','Alt+N');
fs.mkdirSync(path.join(root, 'src/assets'), { recursive: true });
let css = template.match(/<helmet>\s*<style>([\s\S]*?)<\/style>/)[1];
for (const [id, entry] of Object.entries(manifest)) {
  if (!entry.mime.startsWith('font/')) continue;
  const filename = id + '.woff2';
  fs.writeFileSync(path.join(root, 'src/assets', filename), entry.compressed ? zlib.gunzipSync(Buffer.from(entry.data, 'base64')) : Buffer.from(entry.data, 'base64'));
  css = css.replaceAll(id, './' + filename);
}

const tree = parse(template);
function find(node, name) { if (node.tagName === name) return node; for (const child of node.childNodes || []) { const found = find(child, name); if (found) return found; } }
const design = find(tree, 'x-dc');
const vars = new Set();
const hoverStyles = [];
const camel = text => text.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function value(text, aliases) {
  const parts = []; let end = 0;
  for (const m of text.matchAll(/{{\s*([\s\S]*?)\s*}}/g)) {
    if (m.index > end) parts.push(JSON.stringify(text.slice(end, m.index)));
    const expression = m[1].trim();
    const name = expression.split('.')[0];
    if (!aliases.has(name)) vars.add(name);
    parts.push('(' + expression + ')'); end = m.index + m[0].length;
  }
  if (end < text.length) parts.push(JSON.stringify(text.slice(end)));
  return parts.length ? parts.join(' + ') : '""';
}
function style(text, aliases) {
  if (/^{{/.test(text.trim())) return value(text.trim(), aliases);
  return '{' + text.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':'); const key = s.slice(0, i).trim();
    return JSON.stringify(key.startsWith('--') ? key : camel(key)) + ':' + value(s.slice(i + 1).trim(), aliases);
  }).join(',') + '}';
}
function children(node, aliases) { return (node.childNodes || []).map(n => compile(n, aliases)).filter(Boolean); }
let loop = 0;
function compile(node, aliases = new Set()) {
  if (node.nodeName === '#text') return node.value.trim() ? value(node.value, aliases) : null;
  if (!node.tagName || node.tagName === 'helmet') return null;
  const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
  if(node.tagName==='div'&&node.childNodes?.some(child=>child.tagName==='button'&&child.attrs?.some(attr=>attr.name==='sc-camel-on-click'&&attr.value.includes('setLight'))))return null;
  if(node.tagName==='button'&&attrs['sc-camel-on-click']?.includes('newNote')){
    attrs.title='Nova nota (Alt+N)';
    attrs.style=[...(attrs.style || '').split(';').filter(rule=>!['padding','width','display','place-items'].includes(rule.split(':')[0].trim())),'padding:0','width:32px','display:grid','place-items:center'].join(';');
  }
  if(node.tagName==='path'&&attrs.d==='m13 3-8 11h6l-1 7 8-11h-6Z'&&node.parentNode?.parentNode?.attrs?.some(attr=>attr.value.includes('r.isAction')))attrs.d='{{ r.isCreation ? "M12 5v14M5 12h14" : "m13 3-8 11h6l-1 7 8-11h-6Z" }}';
  if(attrs['sc-camel-on-click']?.includes('toggleSidebar'))return null;
  if(attrs.style?.includes('height:24px; padding:0 6px')&&node.childNodes?.some(child=>child.attrs?.some(attr=>attr.name==='sc-camel-on-click'&&attr.value.includes('toggleSidebar'))))return null;
  // Keep groups, sessions and the note list. Only the note card is simplified.
  if(node.parentNode?.tagName==='main'&&attrs.style?.startsWith('flex:none; height:54px'))return null;
  if(node.parentNode?.tagName==='article'&&node.tagName==='div'&&!attrs.style?.includes('overflow-y:auto'))return null;
  if(attrs.style?.includes('overflow-y:auto')&&node.childNodes?.some(child=>child.tagName==='sc-if'&&child.attrs.some(attr=>attr.value.includes('p.editing'))))return 'h("div",{className:"note-editor-scroll"},this.renderNoteEditor(p))';
  if (node.tagName==='span'&&node.childNodes?.some(child=>child.nodeName==='#text'&&child.value.includes('{{ g.name }}'))) { attrs.style='flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis'; attrs.title='{{ g.name }}'; }
  if (node.tagName === 'sc-if') return '(' + value(attrs.value, aliases) + ' ? h(React.Fragment,null,' + children(node, aliases).join(',') + ') : null)';
  if (node.tagName === 'sc-for') {
    const alias = attrs.as; const local = new Set([...aliases, alias]); const idx = '__i' + loop++;
    return '(' + value(attrs.list, aliases) + ' || []).map((' + alias + ',' + idx + ') => h(React.Fragment,{key:' + alias + '.id ?? ' + idx + '},' + children(node, local).join(',') + '))';
  }
  const props = [];
  for (const [name, val] of Object.entries(attrs)) {
    if (name.startsWith('hint-') || name === 'style-hover' || name === 'style-active') continue;
    const key = name.startsWith('sc-camel-') ? camel(name.slice(9)) : ({ class: 'className', tabindex: 'tabIndex', 'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', 'viewbox': 'viewBox' }[name] || name);
    props.push(JSON.stringify(key) + ':' + (key === 'style' ? style(val, aliases) : value(val, aliases)));
  }
  const overrideStyle=extra=>{const next='"style":{...('+style(attrs.style || '',aliases)+'),'+extra+'}',index=props.findIndex(prop=>prop.startsWith('"style":'));if(index<0)props.push(next);else props[index]=next;};
  if (attrs['style-hover'] || attrs['style-active']) {
    const cls = 'ref-interaction-' + hoverStyles.length;
    const important = text => text.split(';').filter(x => x.trim()).map(x => x.trim() + ' !important').join(';');
    hoverStyles.push((attrs['style-hover'] ? '.' + cls + ':hover{' + important(attrs['style-hover']) + '}' : '') + (attrs['style-active'] ? '.' + cls + ':active{' + important(attrs['style-active']) + '}' : ''));
    props.push('className:' + JSON.stringify(cls));
  }
  if (node.tagName === 'input' && attrs.value) {
    const label = attrs.value.includes('p.title') ? 'Título da nota' : attrs.value.includes('listTitle') ? 'Nome da sessão' : 'Buscar notas, sessões ou comandos';
    props.push('"aria-label":' + JSON.stringify(label));
  }
  if (node.tagName === 'textarea') props.push('"aria-label":"Conteúdo da nota"');
  if (attrs.ref?.includes('winRef')) props.push('"data-app-shell":"true","data-appearance":this.state.appearance==="islands"?"islands":"standard","data-display":["split","grid"].includes(this.state.noteDisplay)?this.state.noteDisplay:"single","data-sidebar-open":this.state.sidebar!==false?"true":"false"');
  if (attrs.ref?.includes('paneWrap')) props.push('"data-editor-workspace":"true"');
  if(attrs.style?.includes('grid-template-columns:{{ cols }}'))props.push('"data-workspace-grid":"true"');
  if(node.tagName==='aside')props.push('"data-side-panel":"true",id:"notes-navigation-panel"');
  if(node.tagName==='main')props.push('"data-note-main":"true"');
  if(node.tagName==='section'&&attrs.style?.includes('background:var(--list)'))props.push('"data-note-list":"true",id:"notes-list-panel",onDragOver:event=>this.state.view==="session"&&this.dragOver(event,{kind:"session",id:this.state.session}),onDrop:event=>this.state.view==="session"&&this.dropWorkspace(event,{kind:"session",id:this.state.session}),onDragLeave:event=>this.dragLeave(event)');
  const groupSection=node.tagName==='div'&&node.childNodes?.some(child=>child.tagName==='sc-for'&&child.attrs?.some(attr=>attr.name==='list'&&attr.value.includes('groups')));
  if(groupSection){props.push('"data-sidebar-groups":"true"');overrideStyle('height:this.sidebarGroupHeight()');}
  if(attrs.style?.includes('margin:0 -4px; padding:0 4px'))props.push('"data-sidebar-sections":"true"');
  if(node.tagName==='div'&&node.parentNode?.tagName==='sc-if'&&node.parentNode.attrs?.some(attr=>attr.value.includes('p.hasBacklinks')))props.push('"data-note-backlinks":"true"');
  if (attrs.style?.startsWith('position:fixed; inset:0; overflow:hidden; background:var(--wall)')) props.push('"data-app-root":"true"');
  if (attrs.style?.includes('height:24px; padding:0 6px')) props.push('"data-window-drag":"true"');
  if (attrs.style?.startsWith('flex:none; height:54px')) props.push('"data-window-drag":"true"');
  if (attrs['sc-camel-on-click']?.includes('g.onToggle')) props.push('"data-group-id":g.id,onContextMenu:event=>this.openContextMenu(event,"group",g.id)');
  if (attrs['sc-camel-on-click']?.includes('g.onAdd')) props.push('"data-create":"session","aria-label":"Nova sessão em "+g.name');
  if (attrs['sc-camel-on-click']?.includes('s.onSelect')) props.push('"data-session-id":s.id,onContextMenu:event=>this.openContextMenu(event,"session",s.id)');
  if (attrs['sc-camel-on-click']?.includes('n.onOpen')) props.push('"data-note-row":"true","data-note-id":n.id,onContextMenu:event=>this.openContextMenu(event,"note",n.id)');
  if (attrs['data-pane']) props.push('id:"workspace-pane-"+p.id,role:"tabpanel","aria-labelledby":"workspace-tab-"+p.id,onContextMenu:event=>this.openContextMenu(event,"note",p.id)');
  const dragEntity=attrs['sc-camel-on-click']?.includes('g.onToggle')?['group','g.id']:attrs['sc-camel-on-click']?.includes('s.onSelect')?['session','s.id']:attrs['sc-camel-on-click']?.includes('n.onOpen')?['note','n.id']:null;
  if(dragEntity){const descriptor='{kind:'+JSON.stringify(dragEntity[0])+',id:'+dragEntity[1]+'}';props.push('draggable:true,onDragStart:event=>this.startWorkspaceDrag(event,'+descriptor+'),onDragEnd:()=>this.endWorkspaceDrag(),onDragOver:event=>this.dragOver(event,'+descriptor+'),onDragLeave:event=>this.dragLeave(event),onDrop:event=>this.dropWorkspace(event,'+descriptor+')');}
  if (attrs['sc-camel-on-click'] && !['button','input','textarea'].includes(node.tagName)) {
    props.push('role:"button",tabIndex:0,"data-interactive":"true"');
    if(!dragEntity)props.push('onKeyDown:event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){event.preventDefault();event.stopPropagation();(' + value(attrs['sc-camel-on-click'], aliases) + ')(event)}}');
    props.push('onKeyUp:event=>{if(event.target===event.currentTarget&&(event.key==="ContextMenu"||(event.shiftKey&&event.key==="F10"))){const r=event.currentTarget.getBoundingClientRect();event.currentTarget.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:r.left+16,clientY:r.bottom-4}))}}');
    if(dragEntity)props.push('onKeyDown:event=>{if(event.target!==event.currentTarget)return;if(event.altKey&&(event.key==="ArrowUp"||event.key==="ArrowDown")){event.preventDefault();event.stopPropagation();this.moveWorkspaceByKeyboard({kind:'+JSON.stringify(dragEntity[0])+',id:'+dragEntity[1]+'},event.key==="ArrowUp"?-1:1)}else if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();('+value(attrs['sc-camel-on-click'],aliases)+')(event)}}');
  }
  const content = children(node, aliases);
  if(groupSection){content.splice(0,content.length,'h("div",{className:"sidebar-section-body"},'+content.join(',')+')');content.push('this.renderSectionResize()');}
  if(node.tagName==='aside')content.push('this.renderPanelResize("sidebar")');
  if(node.tagName==='section'&&attrs.style?.includes('background:var(--list)'))content.push('this.renderPanelResize("list")');
  if(node.tagName==='button'&&attrs['sc-camel-on-click']?.includes('newNote')){
    props.push('"aria-label":"Nova nota","data-create":"note"');
    content.splice(0,content.length,'h("svg",{width:16,height:16,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round","aria-hidden":"true"},h("path",{d:"M12 5v14M5 12h14"}))');
  }
  if(node.tagName==='main')content.unshift('this.renderWorkspaceTabs()');
  if (node.tagName==='article') {props.push('"data-note-theme":this.noteThemeId(p.note)');content.unshift('this.renderNoteThemeControl(p)');content.push('this.renderAttachments?.(p)','this.renderNoteResize(p)');overrideStyle('...this.notePaneStyle(p)');}
  if(attrs.ref?.includes('paneWrap'))return 'this.renderEditorWorkspace(['+content.join(',')+'])';
  const dotAction = attrs.style?.includes('background:#FF5F57') ? ['close','Fechar notes'] : attrs.style?.includes('background:#FEBC2E') ? ['minimize','Minimizar'] : attrs.style?.includes('background:#28C840') ? ['maximize','Maximizar ou restaurar'] : null;
  if (dotAction) props.push('onClick:()=>window.notes?.window(' + JSON.stringify(dotAction[0]) + '),title:' + JSON.stringify(dotAction[1]) + ',"aria-label":' + JSON.stringify(dotAction[1]) + ',className:"window-dot"');
  let code = 'h(' + JSON.stringify(dotAction ? 'button' : node.tagName) + ',{' + props.join(',') + '}' + (content.length ? ',' + content.join(',') : '') + ')';
  return code;
}
const view = children(design, new Set()).join(',');
fs.writeFileSync(path.join(root, 'src/reference-view.jsx'), '// Generated from Notas.html by scripts/import-reference.cjs.\nimport React from "react";\nconst h=React.createElement;\nexport function renderReference() {\nconst {' + [...vars].join(',') + '} = this.renderVals();\nreturn h(React.Fragment,null,' + view + ');\n}\n');
fs.writeFileSync(path.join(root, 'src/assets/reference.css'), css + '\n' + hoverStyles.join('\n'));
const logic = template.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
let appLogic = logic.replace('class Component extends DCLogic {', 'export class ReferenceNotes extends React.Component {\n  render() { return renderReference.call(this); }\n  activeNotes() { return this.state.notes.filter(n => !n.deletedAt); }\n');
appLogic = appLogic.replaceAll('this.state.notes.find', 'this.activeNotes().find');
appLogic = appLogic.replace('const st = this.state, dark =', 'const st = { ...this.state, layout:["split","grid"].includes(this.state.noteDisplay)?"split":"focus", notes: this.activeNotes() }, dark =');
appLogic = appLogic.replace('if (list.length > 4) list.shift();','');
appLogic = appLogic.replace(/      else if \(mod && k === 'j'\)[^\n]+\n/,'');
appLogic = appLogic.replace(/     \{ label: dark \? 'Mudar para tema claro'[^\n]+\n/,'');
appLogic = appLogic.replace("return { title: byId[id].title || 'Sem título', bg:", "return { id, title: byId[id].title || 'Sem título', bg:");
appLogic = appLogic.replace('name: g.name, color: g.color, open:', 'id: g.id, name: g.name, color: g.color, open:');
appLogic = appLogic.replace('return { name: s.name, count:', 'return { id:s.id, name: s.name, count:');
appLogic = appLogic.replace(/const snippetOf = b => [^\n]+;/, "const snippetOf = b => plainText(b).replace(/\\n+/g,'  ').slice(0,140);");
appLogic = appLogic.replace(/if \(s.editing && ps.editing !== s.editing\) setTimeout\([^\n]+;/, 'if(s.editing && ps.editing!==s.editing) this.focusEditor?.(s.editing);');
appLogic = appLogic.replace("return { title: n.title || 'Sem título', snippet:", "return { id:n.id, title: n.title || 'Sem título', snippet:");
appLogic = appLogic.replace('ACCENTS[this.props.accent]', 'ACCENTS[this.state.accent || this.props.accent]');
appLogic = appLogic.replace('(this.props.blur ?? 22)', '(this.state.blur ?? this.props.blur ?? 28)');
appLogic = appLogic.replace('id, title: n.title, gName:', 'id, note:n, imported:!!n.imported, attachments:n.attachments || [], title: n.title, gName:');
appLogic = appLogic.replace("{ label: 'Abrir nota do dia', run: () => this.daily() }]", "{ label: 'Abrir nota do dia', run: () => this.daily() }, ...(this.extraCommands?.() || [])]");
appLogic = appLogic.replace(/    if \(q && !exists\(st\.pq\.trim\(\)\)\) acts\.push\((\{[^\n]+\})\);/, '    const createAction = q && !exists(st.pq.trim()) ? $1 : null;');
appLogic = appLogic.replace(".forEach(x => acts.push({ ...x, isAction: true, iconColor: 'var(--acc-ink)' }));", ".forEach(x => acts.push({ ...x, isAction: true, iconColor: 'var(--acc-ink)' }));\n    if(createAction) acts.push(createAction);");
appLogic = appLogic.replace('const tagsOf = b => { const o = [];', 'const tagsOf = (b, importedTags=[]) => { const o = [...new Set(importedTags.filter(t=>typeof t===\'string\'))];');
appLogic = appLogic.replaceAll('tagsOf(n.body)', 'tagsOf(n.body,n.tags)');
appLogic = appLogic.replace(/     \{ label: st.layout === 'split'[^\n]+\n/, '');
// The Windows shortcuts retain the original actions and show native key names.
appLogic = appLogic.replaceAll("'⌥N'", "'Alt+N'").replaceAll("'⌘J'", "'Ctrl+J'");
fs.writeFileSync(path.join(root, 'src/reference-logic.jsx'), '// Imported from the supplied Notas.html; behavior extensions live in notes.jsx.\nimport React from "react";\nimport {renderReference} from "./reference-view";\nimport {plainText} from "./note-content";\n' + appLogic);
const seedConstants = logic.slice(logic.indexOf('const GROUPS0'), logic.indexOf('class Component'));
const seedState = logic.match(/  state = ({[\s\S]*?\n  });/)[1];
const seed = JSON.parse(vm.runInNewContext(seedConstants + '\nJSON.stringify(' + seedState + ')', {window:{innerWidth:1440}}, {timeout:1000}));
for (const field of ['palette','pq','psel','editing','w']) delete seed[field];
seed.accent = 'Azul'; seed.motion = true; seed.blur = 28;
fs.mkdirSync(path.join(root, 'desktop'), {recursive:true});
fs.writeFileSync(path.join(root, 'desktop/seed.json'), JSON.stringify(seed,null,2)+'\n');
console.log('Referência importada: fontes, estilos, markup e comportamento originais.');
