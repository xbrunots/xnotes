'use strict';

// Pure conversion of Notion's documented enhanced Markdown. The exact MCP
// response is archived by the migration engine; this is its readable local copy.
const crypto = require('node:crypto');
const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32}/ig;
const decode = value => String(value ?? '').replace(/&(?:amp|lt|gt|quot|apos|#39|#x[\da-f]+|#\d+);/gi, entity => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
  if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()];
  const number = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
  return Number.isInteger(number) && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
});
function attributes(text) {
  const result = {};
  for (const match of String(text).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = decode(match[2] ?? match[3]);
  return result;
}
function notionIdentity(value, hint = 'page') {
  value = String(value || '').trim().replace(/^\{\{|\}\}$/g, '');
  const scheme = /^(collection|view):\/\//i.exec(value)?.[1]?.toLowerCase();
  let identityPart = value;
  if (/^https:/i.test(value)) { try { identityPart = new URL(value).pathname; } catch {} }
  const matches = [...identityPart.matchAll(UUID)], uuid = matches.at(-1)?.[0]?.replace(/-/g, '').toLowerCase();
  // Never follow arbitrary web links as pages or turn their URL into an ID.
  if (!uuid || (/^[a-z]+:/i.test(value) && !scheme && !/^https:\/\/(?:[\w-]+\.)?notion\.(?:so|site|com)\//i.test(value))) return null;
  const id = uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const kind = scheme === 'collection' ? 'data_source' : scheme === 'view' ? 'view' : hint;
  return { key: (kind === 'data_source' ? 'collection:' : kind === 'view' ? 'view:' : kind === 'subtree' ? 'block:' : 'notion:') + uuid, id, kind, url: scheme ? scheme + '://' + id : /^https:/i.test(value) ? value : 'https://www.notion.so/' + uuid };
}
function mapOutsideCode(text, transform) {
  const lines = String(text).split(/(?<=\n)/), output = [];
  let fence = null, pending = '';
  const flush = () => { if (pending) { output.push(transform(pending)); pending = ''; } };
  for (const line of lines) {
    const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      output.push(line);
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^[ \t]*(?:`+|~+)[ \t]*\r?\n?$/.test(line)) fence = null;
    } else if (match) { flush(); fence = match[1]; output.push(line); }
    else pending += line;
  }
  flush();
  return output.join('');
}
function unpackResult(result) {
  const parsed = [], text = [];
  if (result?.structuredContent !== undefined) parsed.push(result.structuredContent);
  const blocks = result?.content || [];
  for (const block of blocks) if (block.type === 'text' && typeof block.text === 'string') {
    try { parsed.push(JSON.parse(block.text)); } catch { text.push(block.text); }
  }
  if (!blocks.length && result && typeof result === 'object' && !result.structuredContent) parsed.push(result);
  const records = [];
  const walk = (value, depth = 0) => {
    if (!value || depth > 12) return;
    if (typeof value === 'string') {
      if (/^\s*[{[]/.test(value)) { try { walk(JSON.parse(value), depth + 1); return; } catch {} }
      if (/<(?:page|database|content|data-source|folder)\b|\n/.test(value)) text.push(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    records.push(value);
    for (const [key, item] of Object.entries(value)) if (['result', 'data', 'response', 'text', 'markdown', 'content'].includes(key)) walk(item, depth + 1);
  };
  parsed.forEach(value => walk(value));
  return { data: parsed[0] || {}, records, text: [...new Set(text)].join('\n\n') };
}
function listItems(payload, preferred = ['results', 'pages', 'items']) {
  if (Array.isArray(payload.data)) return payload.data;
  for (const record of payload.records) for (const key of preferred) if (Array.isArray(record[key])) return record[key];
  return [];
}
const field = (payload, ...names) => { for (const record of payload.records) for (const name of names) if (record[name] !== undefined) return record[name]; };
function referencesIn(text) {
  const found = new Map();
  const add = (value, hint, title, child = false) => {
    const item = notionIdentity(value, hint); if (!item) return;
    const previous = found.get(item.key);
    found.set(item.key, { ...previous, ...item, title: title || previous?.title || '', child: child || previous?.child || false });
  };
  mapOutsideCode(text, part => {
    for (const match of part.matchAll(/<(page|database|folder|data-source|view|mention-page|mention-database|mention-data-source|synced_block_reference|link-to-page)\b([^>]*?)>([^<\n]*)/gi)) {
      const attrs = attributes(match[2]), tag = match[1].toLowerCase();
      add(attrs.url || attrs.href || attrs.id, /data-source/.test(tag) ? 'data_source' : /database/.test(tag) ? 'database' : tag === 'folder' ? 'folder' : tag === 'view' ? 'view' : 'page', decode((match[3] || '').replace(/<[^>]*>/g, '').trim()), !tag.startsWith('mention-') && tag !== 'synced_block_reference');
    }
    for (const match of part.matchAll(/\[([^\]\n]*)\]\((https:\/\/(?:[\w-]+\.)?notion\.(?:so|site|com)\/[^\s)]+)\)/gi)) add(match[2], 'page', match[1]);
    for (const match of part.matchAll(/(?:collection|view):\/\/[a-f\d-]{32,36}/gi)) add(match[0], 'page', '');
    return part;
  });
  return [...found.values()];
}
function objectReferences(value, output = new Map(), depth = 0) {
  if (!value || depth > 20) return [...output.values()];
  if (typeof value === 'string') { for (const item of referencesIn(value)) output.set(item.key, item); return [...output.values()]; }
  if (Array.isArray(value)) { for (const item of value) objectReferences(item, output, depth + 1); return [...output.values()]; }
  if (typeof value !== 'object') return [...output.values()];
  const type = value.type || value.object || '';
  const identity = notionIdentity(value.url || (['page', 'database', 'data_source', 'view', 'folder'].includes(type) ? value.id : ''), type === 'data_source' ? 'data_source' : type === 'database' ? 'database' : 'page');
  if (identity) output.set(identity.key, { ...identity, title: typeof value.title === 'string' ? value.title : typeof value.name === 'string' ? value.name : '', child: false });
  for (const item of Object.values(value)) objectReferences(item, output, depth + 1);
  return [...output.values()];
}
function fileReferencesIn(text) {
  const found = new Set();
  mapOutsideCode(text, part => { part = part.replace(/(`+)[^\n]*?\1/g, ''); for (const match of part.matchAll(/notion-file-block:\/\/[^\s<>"'\])}]+/g)) found.add(match[0]); return part; });
  return [...found];
}
const mdLabel = value => decode(value).replace(/<[^>]*>/g, '').replace(/[\[\]\\]/g, '\\$&').trim();
function convertInline(value) {
  const tokens = [];
  value = value.replace(/(`+)[^\n]*?\1/g, code => '\u0000CODE' + (tokens.push(code) - 1) + '\u0000');
  value = value.replace(/<(?:mention-(?:page|database|data-source|user|agent)|page|database|data-source|view|folder|link-to-page)\b([^>]*)>([\s\S]*?)<\/(?:mention-(?:page|database|data-source|user|agent)|page|database|data-source|view|folder|link-to-page)>/gi, (_all, attrs, label) => {
    const a = attributes(attrs), text = mdLabel(label) || a.url || 'Referência';
    return a.url ? '[' + text + '](' + a.url.replace(/\s/g, '%20') + ')' : text;
  });
  value = value.replace(/<mention-date\b([^>]*?)\/?>/gi, (_all, attrs) => { const a = attributes(attrs); return [a.start, a.startTime, a.end && '→ ' + a.end, a.timeZone].filter(Boolean).join(' '); });
  value = value.replace(/<(audio|video|file|pdf|image|bookmark|embed)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/\1>)/gi, (_all, type, attrs, label) => {
    const a = attributes(attrs), url = a.src || a.url;
    return url ? (type.toLowerCase() === 'image' ? '!' : '') + '[' + (mdLabel(label) || type) + '](' + url.replace(/\s/g, '%20') + ')' : mdLabel(label);
  });
  value = value.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, '$1').replace(/\s*\{(?:color|toggle)="[^"\n]*"(?:\s+(?:color|toggle)="[^"\n]*")*\}/g, '');
  return value.replace(/\u0000CODE(\d+)\u0000/g, (_all, index) => tokens[Number(index)]);
}
function notionMarkdown(text) {
  return mapOutsideCode(String(text || '').replace(/\r\n/g, '\n'), part => {
    part = part.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_all, table) => {
      const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => convertInline(cell[1]).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim()));
      if (!rows.length) return table.replace(/<[^>]*>/g, '');
      const columns = Math.max(...rows.map(row => row.length)), line = row => '| ' + Array.from({ length: columns }, (_, index) => row[index] || '').join(' | ') + ' |';
      return '\n' + line(rows[0]) + '\n' + line(Array(columns).fill('---')) + '\n' + rows.slice(1).map(line).join('\n') + '\n';
    });
    const wrappers = [], output = [];
    for (let line of part.split('\n')) {
      const close = /^\s*<\/(details|callout|columns|column|synced_block|synced_block_reference)>\s*$/.exec(line);
      if (close) { if (wrappers.at(-1) === close[1]) wrappers.pop(); continue; }
      const open = /^\s*<(details|callout|columns|column|synced_block|synced_block_reference)\b([^>]*)>\s*$/.exec(line);
      if (open) { wrappers.push(open[1]); const icon = attributes(open[2]).icon; if (icon) output.push(icon); continue; }
      // Remove only indentation introduced by structural XML, never code tabs.
      for (let count = 0; count < wrappers.length && line.startsWith('\t'); count++) line = line.slice(1);
      line = line.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '**$1**').replace(/<empty-block\s*\/>/gi, '').replace(/<table_of_contents\b[^>]*\/?>/gi, '_Sumário da página original_');
      output.push(convertInline(line));
    }
    return output.join('\n');
  });
}
function contentOf(result, fallback = {}) {
  const payload = unpackResult(result), text = payload.text || String(field(payload, 'markdown', 'text') || '');
  let properties = field(payload, 'properties');
  if (!properties) { const match = /<properties\b[^>]*>([\s\S]*?)<\/properties>/i.exec(text); if (match) { try { properties = JSON.parse(match[1]); } catch { properties = { 'Propriedades na origem': match[1].trim() }; } } }
  const bodyMatch = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(text);
  let body = bodyMatch ? bodyMatch[1].replace(/^\n|\n$/g, '') : text;
  if (!bodyMatch) body = body.replace(/<ancestor-path\b[^>]*>[\s\S]*?<\/ancestor-path>/gi, '').replace(/<properties\b[^>]*>[\s\S]*?<\/properties>/gi, '');
  const title = field(payload, 'title', 'name') || properties?.title || properties?.Name || fallback.title || '';
  const unknownBlockIds = field(payload, 'unknown_block_ids', 'unknownBlockIds') || [];
  const unknownBlockCount = Number(field(payload, 'unknown_block_count', 'unknownBlockCount') || unknownBlockIds.length || 0);
  const discovered = new Map(objectReferences(payload.data).map(item => [item.key, item]));
  for (const item of referencesIn(text + '\n' + JSON.stringify(properties || {}))) discovered.set(item.key, item);
  const unknownTags = new Set(); mapOutsideCode(body, value => { for (const match of value.matchAll(/<(unknown|unsupported|custom-block)\b/gi)) unknownTags.add(match[1]); return value; });
  return { payload, text, body: notionMarkdown(body), title: typeof title === 'string' ? title : fallback.title || '', properties: properties || null, discovered: [...discovered.values()], sourcePath: field(payload, 'path') || null, truncated: field(payload, 'truncated') === true, unknownBlockIds: Array.isArray(unknownBlockIds) ? unknownBlockIds : [], unknownBlockCount, unknownTags: [...unknownTags] };
}
function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return notionMarkdown(value);
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (typeof value === 'object') {
    if (value.plain_text !== undefined) return String(value.plain_text);
    if (value.text?.content !== undefined) return String(value.text.content);
    if (value.name !== undefined && typeof value.name === 'string') return value.name;
    if (value.url) return '[' + mdLabel(value.name || 'Arquivo') + '](' + value.url + ')';
    return JSON.stringify(value);
  }
  return String(value);
}
function propertiesMarkdown(properties) {
  if (!properties || !Object.keys(properties).length) return '';
  return '## Propriedades\n\n| Propriedade | Valor |\n| --- | --- |\n' + Object.entries(properties).map(([key, value]) => '| ' + key.replace(/\|/g, '\\|') + ' | ' + valueText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') + ' |').join('\n') + '\n';
}
const stableHash = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
module.exports = { attributes, notionIdentity, unpackResult, listItems, field, contentOf, notionMarkdown, referencesIn, fileReferencesIn, propertiesMarkdown, valueText, stableHash, mapOutsideCode };
