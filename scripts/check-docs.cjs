// Offline documentation check: relative Markdown/HTML links, images and anchors.
const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const { parse } = require('parse5');

const root = path.resolve(__dirname, '..');
const markdown = new MarkdownIt({ html: true });
const ignored = new Set(['node_modules', '.git', 'app', 'portable', 'reference']);

function documents(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || ignored.has(entry.name)) return [];
    const filename = path.join(folder, entry.name);
    return entry.isDirectory() ? documents(filename) : entry.name.endsWith('.md') ? [filename] : [];
  });
}

function slug(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
}

const parsed = new Map();
function inspect(filename) {
  if (parsed.has(filename)) return parsed.get(filename);
  const source = fs.readFileSync(filename, 'utf8');
  if (source.includes('\uFFFD')) throw new Error('Caractere de substituição UTF-8: ' + path.relative(root, filename));
  const tokens = markdown.parse(source, {}), links = [], anchors = new Set(), counts = new Map();
  const headingText = token => (token.children || []).map(child => child.type === 'image' ? child.content : child.content || '').join('');
  const visitHTML = html => {
    const visit = node => {
      for (const attribute of node.attrs || []) {
        if (attribute.name === 'href' || attribute.name === 'src') links.push(attribute.value);
        if (attribute.name === 'id' || attribute.name === 'name') anchors.add(attribute.value);
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(parse(html));
  };
  const visit = items => {
    for (const token of items) {
      if (token.type === 'link_open') links.push(token.attrGet('href'));
      if (token.type === 'image') links.push(token.attrGet('src'));
      if (token.type === 'html_inline' || token.type === 'html_block') visitHTML(token.content);
      if (token.children) visit(token.children);
    }
  };
  visit(tokens);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const base = slug(headingText(tokens[i + 1]));
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count ? base + '-' + count : base);
  }
  const value = { links, anchors };
  parsed.set(filename, value);
  return value;
}

function main() {
  const files = documents(root), errors = [];
  let checked = 0;
  for (const filename of files) {
    const current = inspect(filename);
    for (const value of current.links) {
      if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
      checked++;
      try {
        const hashIndex = value.indexOf('#');
        const linkPath = (hashIndex < 0 ? value : value.slice(0, hashIndex)).split('?')[0];
        const fragment = hashIndex < 0 ? '' : decodeURIComponent(value.slice(hashIndex + 1));
        const target = linkPath ? path.resolve(path.dirname(filename), decodeURIComponent(linkPath)) : filename;
        const relative = path.relative(root, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('caminho fora do repositório');
        if (!fs.existsSync(target)) throw new Error('destino ausente');
        if (fragment && target.endsWith('.md') && !inspect(target).anchors.has(fragment)) throw new Error('âncora ausente');
      } catch (error) {
        errors.push(path.relative(root, filename) + ': ' + value + ' (' + error.message + ')');
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Documentação válida: ' + files.length + ' arquivos Markdown e ' + checked + ' links/recursos locais.');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
