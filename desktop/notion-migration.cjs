'use strict';

// Read-only MCP inventory -> durable private plan -> existing transactional
// importer. No WorkspaceStore write and no Notion mutation occurs in this file.
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { importWorkspace, IMPORT_LIMITS } = require('./importers.cjs');
const { validateSnapshot } = require('./storage.cjs');
const { notionIdentity, unpackResult, listItems, field, contentOf, notionMarkdown, propertiesMarkdown, valueText, stableHash, referencesIn, fileReferencesIn, mapOutsideCode } = require('./notion-content.cjs');

const PLAN_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const SCOPE = 'accessible-private-shared';
const normalizeTool = value => String(value || '').replace(/^notion[-_]/i, '').replace(/-/g, '_');
const now = () => new Date().toISOString();
const abortError = () => Object.assign(new Error('A importação foi interrompida. O inventário foi preservado para retomar.'), { name: 'AbortError', code: 'ABORT_ERR' });
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const isAbort = error => error?.name === 'AbortError' || ['ABORT_ERR', 'NOTION_CANCELLED'].includes(error?.code);
const failure = (code, message) => Object.assign(new Error(message), { code });
const LIMIT_MESSAGES = Object.freeze({ unavailable: 'A conexão não disponibiliza uma ferramenta necessária. Use também uma exportação ZIP completa do workspace.', permission: 'O Notion não permitiu ler este conteúdo. Confira as permissões da conexão ou complemente com o ZIP completo.', quota: 'O Notion limitou esta leitura por cota ou plano. O conteúdo já encontrado foi preservado; complemente com o ZIP completo.', fetch: 'Não foi possível ler um item do Notion. Retome o inventário ou complemente com uma exportação ZIP completa.' });
function classifyError(error) {
  const text = (String(error?.providerCode || error?.code || '') + ' ' + String(error?.message || error || '')).toLowerCase();
  if (/quota|upgrade|plan_required|full_version|rate.limit|429|usage.limit|billing/.test(text)) return 'quota';
  if (/permission|forbidden|object_not_found|not.found|unauthorized|403|401|access.denied/.test(text)) return 'permission';
  return 'fetch';
}
async function directory(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('NOTES_NOTION_UNSAFE_PLAN', 'O inventário precisa de uma pasta privada regular, sem links ou junctions.');
}
async function atomicJSON(filename, value) {
  const temporary = filename + '.' + crypto.randomUUID() + '.partial';
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function verifiedCopy(source, destination, expected, expectedBytes) {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) throw failure('NOTES_NOTION_FILE_INTEGRITY', 'Um arquivo do inventário mudou. Nenhuma nota foi salva.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of nativeFs.createReadStream(source)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw failure('NOTES_NOTION_FILE_INTEGRITY', 'A integridade de um arquivo do inventário não pôde ser confirmada. Nenhuma nota foi salva.');
  await fs.copyFile(source, destination);
}
function effectiveSchema(tool) {
  const schema = tool?.inputSchema || tool?.input_schema || {};
  const wrapped = schema.properties?.data && (schema.required?.includes('data') || Object.keys(schema.properties).length === 1);
  return { schema: wrapped ? schema.properties.data : schema, wrapped };
}
function schemaProperties(schema, mode) {
  let result = { ...(schema.properties || {}) };
  const alternatives = schema.anyOf || schema.oneOf || [];
  const matching = alternatives.filter(item => {
    const selector = item.properties?.mode;
    return !mode || !selector || (selector.const === undefined || selector.const === mode) && (!selector.enum || selector.enum.includes(mode));
  });
  for (const item of [...(schema.allOf || []), ...matching]) result = { ...result, ...schemaProperties(item, mode) };
  return result;
}
function toolProperties(tool, mode) {
  const { schema } = effectiveSchema(tool);
  return schemaProperties(schema, mode);
}
function argsFor(tool, values) {
  const properties = toolProperties(tool, values.mode), result = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined && Object.hasOwn(properties, key)) result[key] = value;
  return effectiveSchema(tool).wrapped ? { data: result } : result;
}
function firstProperty(tool, names, fallback) { const properties = toolProperties(tool); return names.find(name => Object.hasOwn(properties, name)) || fallback; }
function continuation(payload) {
  const cursor = field(payload, 'nextCursor', 'next_cursor', 'next_page_cursor', 'nextPageCursor');
  return cursor == null || cursor === '' ? null : String(cursor);
}
function rowIdentity(row) {
  return notionIdentity(row?.page_url || row?.pageUrl || row?.url || row?.page_id || row?.pageId || row?.id || row?.properties?.url, 'page');
}
function rowTitle(row) {
  const properties = row?.properties || row;
  for (const key of ['title', 'Name', 'name', 'Nome', 'Título', 'Titulo', 'Documento']) if (properties?.[key] != null) return valueText(properties[key]).replace(/<[^>]+>/g, '').slice(0, 200);
  for (const value of Object.values(properties || {})) if (value?.type === 'title') return valueText(value.title).slice(0, 200);
  return 'Registro do banco';
}
function fileName(value, fallback = 'arquivo') {
  return String(value || fallback).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || fallback;
}
function officialDownload(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  const allowed = /^(?:file|files)\.notion\.so$/.test(host) || /^(?:[a-z\d-]+\.)*notionusercontent\.com$/.test(host) || /^(?:[a-z\d-]+\.)*notion-static\.com$/.test(host) || /^prod-files-secure\.s3\.[a-z\d-]+\.amazonaws\.com$/.test(host) || (/^s3(?:[.-][a-z\d-]+)?\.amazonaws\.com$/.test(host) && url.pathname.startsWith('/secure.notion-static.com/'));
  return allowed ? url : null;
}
function archiveSafe(value, depth = 0) {
  if (depth > 40) throw failure('NOTES_NOTION_ARCHIVE_DEPTH', 'A resposta do Notion excede a profundidade permitida para o arquivo técnico.');
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) { try { return JSON.stringify(archiveSafe(JSON.parse(value), depth + 1)); } catch {} }
    return value.replace(/https:\/\/[^\s<>"'\])}]+/gi, target => { const url = officialDownload(target.replace(/\\\//g, '/')); if (!url) return target; url.search = ''; url.hash = ''; return url.href; });
  }
  if (Array.isArray(value)) return value.map(item => archiveSafe(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:authorization|access_token|refresh_token|client_secret|id_token|cookie|set-cookie)$/i.test(key) ? '[redigido]' : archiveSafe(item, depth + 1)]));
  return value;
}
function inlineFiles(value, output = [], depth = 0) {
  if (!value || depth > 16) return output;
  if (Array.isArray(value)) { value.forEach(item => inlineFiles(item, output, depth + 1)); return output; }
  if (typeof value !== 'object') return output;
  if (value.type === 'file' && typeof value.file?.url === 'string') output.push({ reference: value.file.url, url: value.file.url, name: value.name, expiry: value.file.expiry_time, inline: true });
  else if (typeof value.url === 'string' && (value.type === 'file' || value.type === 'external' || value.name && /\.[a-z\d]{1,10}$/i.test(value.name))) output.push({ reference: value.url, url: value.url, name: value.name, inline: true });
  for (const [key, item] of Object.entries(value)) if (key !== 'file') inlineFiles(item, output, depth + 1);
  return output;
}
function adaptOutsideCode(text, transform) {
  return mapOutsideCode(text, part => {
    let output = '', offset = 0;
    for (const match of part.matchAll(/(`+)[^\n]*?\1/g)) { output += transform(part.slice(offset, match.index)) + match[0]; offset = match.index + match[0].length; }
    return output + transform(part.slice(offset));
  });
}

class NotionMigration {
  constructor({ client, dataDir, assets, fetchImpl = globalThis.fetch } = {}) {
    if (!client || typeof client.listTools !== 'function' || typeof client.callTool !== 'function') throw new TypeError('Cliente Notion MCP inválido.');
    if (!path.isAbsolute(dataDir || '')) throw new TypeError('O perfil privado precisa de um caminho absoluto.');
    this.client = client; this.assets = assets; this.fetch = fetchImpl; this.folder = path.join(dataDir, 'notion-import'); this.busy = false;
  }
  _planFolder(id) { if (!PLAN_ID.test(id || '')) throw failure('NOTES_NOTION_PLAN_ID', 'Inventário Notion inválido.'); return path.join(this.folder, id); }
  async _load(id) {
    const plan = JSON.parse(await fs.readFile(path.join(this._planFolder(id), 'plan.json'), 'utf8'));
    if (plan.version !== 1 || plan.id !== id || !plan.entities || !Array.isArray(plan.tasks)) throw failure('NOTES_NOTION_PLAN_INVALID', 'O inventário está ilegível. Ele foi preservado; inicie um novo inventário.');
    return plan;
  }
  async _save(plan) {
    plan.updatedAt = now(); await atomicJSON(path.join(this._planFolder(plan.id), 'plan.json'), plan);
    await atomicJSON(path.join(this.folder, 'latest.json'), { id: plan.id });
  }
  _issue(plan, code, message, entityId = '', extra = {}) {
    const key = code + ':' + entityId;
    const previous = plan.issues.find(issue => issue.key === key);
    if (previous) Object.assign(previous, { message, resolved: false, ...extra });
    else plan.issues.push({ key, code, message, entityId, recoverable: false, resolved: false, ...extra });
  }
  _resolve(plan, code, entityId) { for (const issue of plan.issues) if (issue.code === code && issue.entityId === entityId) issue.resolved = true; }
  _task(plan, task) {
    if (plan.tasks.some(item => item.key === task.key)) return;
    if (plan.tasks.length >= IMPORT_LIMITS.entries) { this._issue(plan, 'INVENTORY_LIMIT', 'O inventário atingiu o limite de segurança de entradas. Nenhum conteúdo existente foi substituído.'); return; }
    plan.tasks.push({ ...task, state: 'pending' });
  }
  _enqueue(plan, item, parentKey = null) {
    const identity = item.key ? item : notionIdentity(item.url || item.id, item.type || item.kind || 'page');
    if (!identity) { this._issue(plan, 'UNRECOGNIZED_REFERENCE', 'Uma referência retornada pelo Notion não contém um ID estável legível. Sua resposta original será arquivada.', stableHash(JSON.stringify(item)).slice(0, 16)); return null; }
    if (!plan.entities[identity.key]) {
      const entity = { ...identity, title: item.title || item.name || '', parentKey, state: 'pending', properties: item.properties || null, ...(item.properties ? { rowProperties: item.properties } : {}) };
      plan.entities[identity.key] = entity;
      this._task(plan, { key: 'fetch:' + identity.key, type: 'fetch', entityKey: identity.key });
    } else if (item.properties) plan.entities[identity.key].rowProperties = item.properties;
    return plan.entities[identity.key];
  }
  _public(plan) {
    const entities = Object.values(plan.entities), issues = plan.issues.filter(issue => !issue.resolved).map(({ code, message, entityId, recoverable }) => ({ code, message, entityId, recoverable }));
    const unfinished = plan.tasks.some(task => task.state === 'pending' || task.state === 'running');
    const interrupted = !this.busy && ['scanning', 'importing'].includes(plan.state);
    const state = interrupted ? 'interrupted' : plan.state;
    const pages = entities.filter(item => !['database', 'data_source', 'view', 'subtree'].includes(item.kind) && item.state === 'done').length;
    const databases = entities.filter(item => item.kind === 'database' && item.state === 'done').length;
    return { id: plan.id, state, pages, databases, files: Object.values(plan.files).filter(item => item.state === 'done').length, failedFiles: Object.values(plan.files).filter(item => item.state === 'error').length, discovered: entities.length, processed: entities.filter(item => item.state === 'done').length, pending: plan.tasks.filter(task => task.state !== 'done').length, issues, complete: !unfinished && !['cancelled', 'interrupted'].includes(state) && !issues.length, workspaceComplete: false, scope: SCOPE, coverageMessage: 'Conteúdo acessível nas seções Particular e Compartilhado da conexão. Páginas sem permissão, teamspaces e recursos indisponíveis exigem conferência ou exportação completa.', canImport: pages + databases > 0 && !['scanning', 'importing', 'interrupted'].includes(state), canResume: interrupted || !['scanning', 'importing'].includes(state) && (unfinished || ['cancelled', 'error'].includes(state) || issues.some(item => item.recoverable)), createdAt: plan.createdAt, updatedAt: plan.updatedAt, ...(plan.report ? { report: plan.report } : {}) };
  }
  async status() {
    try { const pointer = JSON.parse(await fs.readFile(path.join(this.folder, 'latest.json'), 'utf8')); const plan = await this._load(pointer.id); await this._assertAccount(plan, null, null, false); return this._public(plan); }
    catch (error) {
      if (['ENOENT', 'NOTES_NOTION_ACCOUNT_UNVERIFIED', 'NOTES_NOTION_ACCOUNT_REQUIRED'].includes(error.code)) return { state: error.code === 'ENOENT' ? 'idle' : 'identity-unverified', pages: 0, databases: 0, files: 0, issues: error.code === 'ENOENT' ? [] : [{ code: 'ACCOUNT_IDENTITY_UNVERIFIED', message: 'Conecte e confira a conta Notion para visualizar ou retomar seu inventário privado.', recoverable: true }], complete: false, canImport: false, canResume: false, workspaceComplete: false, scope: SCOPE };
      throw error;
    }
  }
  async _account(tools, signal, allowNetwork = true) {
    checkAbort(signal);
    const status = typeof this.client.status === 'function' ? await this.client.status() : null;
    if (status?.connected === false || status?.state === 'disconnected') throw failure('NOTES_NOTION_ACCOUNT_REQUIRED', 'Conecte a conta Notion que criou este inventário para continuar.');
    let account = status?.account || this.client.account;
    if ((!account?.workspaceId || !account?.userId) && !allowNetwork) throw failure('NOTES_NOTION_ACCOUNT_UNVERIFIED', 'A identidade da conexão precisa ser conferida antes de acessar o inventário.');
    if ((!account?.workspaceId || !account?.userId) && !tools) {
      const discovered = await this.client.listTools({ signal });
      tools = new Map((Array.isArray(discovered) ? discovered : discovered?.tools || []).map(tool => [normalizeTool(tool.name), tool]));
    }
    if ((!account?.workspaceId || !account?.userId) && tools?.has('get_self')) {
      const result = await this.client.callTool(tools.get('get_self').name, argsFor(tools.get('get_self'), {}), { signal });
      const payload = unpackResult(result), workspace = field(payload, 'workspace'), user = field(payload, 'user');
      if (!result.isError) account = { workspaceId: workspace?.id, userId: user?.id };
    }
    if (!account?.workspaceId || !account?.userId) throw failure('NOTES_NOTION_ACCOUNT_REQUIRED', 'A conexão não informou os IDs da conta e do workspace. Reconecte o Notion para iniciar um inventário vinculado à sua conta.');
    return stableHash(String(account.workspaceId).replace(/-/g, '').toLowerCase() + ':' + String(account.userId).replace(/-/g, '').toLowerCase());
  }
  async _assertAccount(plan, tools, signal, allowNetwork = true) {
    const fingerprint = await this._account(tools, signal, allowNetwork);
    if (!plan.accountFingerprint || fingerprint !== plan.accountFingerprint) throw failure('NOTES_NOTION_ACCOUNT_MISMATCH', 'Este inventário pertence a outra conta ou workspace do Notion. Conecte a conta original ou inicie um novo inventário. O plano anterior foi preservado.');
    return fingerprint;
  }
  _emit(plan, onProgress) { if (typeof onProgress === 'function') onProgress(this._public(plan)); }
  async _raw(plan, tool, args, result) {
    const name = String(++plan.sequence).padStart(6, '0') + '-' + normalizeTool(tool.name) + '.json';
    const bytes = Buffer.from(JSON.stringify(archiveSafe({ tool: tool.name, arguments: args, fetchedAt: now(), result }), null, 2));
    if (bytes.length > IMPORT_LIMITS.fileBytes || plan.sourceBytes + bytes.length > IMPORT_LIMITS.totalBytes) throw failure('NOTES_NOTION_LIMIT', 'O inventário excede o limite de segurança de bytes.');
    await fs.writeFile(path.join(this._planFolder(plan.id), 'sources', name), bytes, { flag: 'wx', mode: 0o600 });
    plan.sourceBytes += bytes.length; plan.rawFiles.push({ name, bytes: bytes.length, hash: stableHash(bytes) });
    return name;
  }
  async _call(plan, tool, args, signal) {
    checkAbort(signal);
    const result = await this.client.callTool(tool.name, args, { signal });
    checkAbort(signal);
    const raw = await this._raw(plan, tool, args, result);
    if (result?.isError) {
      const payload = unpackResult(result);
      const detail = field(payload, 'error');
      const providerCode = detail && typeof detail === 'object' ? detail.code : field(payload, 'code', 'error_code');
      throw Object.assign(new Error(providerCode || payload.text || JSON.stringify(payload.data)), { raw, providerCode });
    }
    const payload = unpackResult(result);
    const code = field(payload, 'error_code', 'tool_error_code');
    const status = field(payload, 'status', 'type', 'code');
    if (code || field(payload, 'error') || ['error', 'permission_error', 'validation_error', 'rate_limited', 'quota_exceeded', 'upgrade_required', 'full_version_required', 'not_enabled', 'object_not_found', 'unauthorized', 'plan_required'].includes(status)) throw new Error(String(code || status || field(payload, 'message') || JSON.stringify(payload.data)));
    return { result, payload, raw };
  }
  async scan({ signal, onProgress, resume = false } = {}) {
    if (this.busy) throw failure('NOTES_NOTION_BUSY', 'Uma importação Notion já está em andamento.');
    this.busy = true; let plan;
    try {
      await directory(this.folder);
      checkAbort(signal);
      const discoveredTools = await this.client.listTools({ signal });
      const availableTools = Array.isArray(discoveredTools) ? discoveredTools : discoveredTools?.tools || [];
      const tools = new Map(availableTools.map(tool => [normalizeTool(tool.name), tool]));
      const accountFingerprint = await this._account(tools, signal);
      if (resume) {
        const pointer = JSON.parse(await fs.readFile(path.join(this.folder, 'latest.json'), 'utf8')); const candidate = await this._load(pointer.id);
        await this._assertAccount(candidate, tools, signal); plan = candidate;
        if (plan.state === 'applied' && !this._public(plan).canResume) return this._public(plan);
        for (const task of plan.tasks) if (['running', 'error'].includes(task.state)) task.state = 'pending';
        for (const file of Object.values(plan.files)) if (file.state === 'error') file.state = 'pending';
      } else {
        const id = crypto.randomUUID(); await directory(this._planFolder(id));
        await directory(path.join(this._planFolder(id), 'sources')); await directory(path.join(this._planFolder(id), 'downloads'));
        plan = { version: 1, id, accountFingerprint, state: 'scanning', createdAt: now(), updatedAt: now(), tasks: [], entities: {}, files: {}, issues: [], tools: [], rawFiles: [], sequence: 0, sourceBytes: 0 };
      }
      // A resumed round can discover importable items before cancellation.
      // Advance its durable revision before work, rather than only on success.
      plan.revision = (plan.revision || 0) + 1;
      plan.state = 'scanning'; await this._save(plan); this._emit(plan, onProgress);
      checkAbort(signal);
      plan.tools = availableTools;
      await atomicJSON(path.join(this._planFolder(plan.id), 'sources', 'tools-list.json'), { discoveredAt: now(), tools: plan.tools });
      if (!tools.has('fetch')) throw failure('NOTES_NOTION_TOOL_UNAVAILABLE', LIMIT_MESSAGES.unavailable);
      if (tools.has('get_tool_access') && !plan.accessChecked) {
        try { const accessTool = tools.get('get_tool_access'); const access = await this._call(plan, accessTool, argsFor(accessTool, { tool_names: ['fetch', 'query_data_sources', 'get_comments', 'list_private_pages', 'list_shared_pages', 'get_file_download_urls'] }), signal); plan.access = access.payload.data; plan.accessChecked = true; this._resolve(plan, 'ACCESS_CHECK_FAILED', ''); }
        catch (error) { if (isAbort(error)) throw error; this._issue(plan, 'ACCESS_CHECK_FAILED', 'A conexão não informou todos os limites de ferramentas. As leituras serão conferidas individualmente.', '', { recoverable: true }); }
      }
      for (const kind of ['private', 'shared']) {
        const name = 'list_' + kind + '_pages';
        if (tools.has(name)) this._task(plan, { key: 'roots:' + kind, type: 'roots', toolName: name, cursor: null, cursors: [] });
        else this._issue(plan, 'ROOT_LIST_UNAVAILABLE', 'A conexão não permite enumerar a seção ' + (kind === 'private' ? 'Particular' : 'Compartilhado') + '. A busca não comprova um workspace completo; complemente com o ZIP completo.', kind);
      }
      for (const task of plan.tasks) {
        if (task.state === 'done') continue;
        checkAbort(signal); task.state = 'running'; await this._save(plan); this._emit(plan, onProgress);
        try {
          if (task.type === 'roots') await this._roots(plan, task, tools, signal, onProgress);
          else if (task.type === 'fetch') await this._entity(plan, task, tools, signal);
          else if (task.type === 'query') await this._query(plan, task, tools, signal, onProgress);
          else if (task.type === 'comments') await this._comments(plan, task, tools, signal);
          task.state = 'done'; this._resolve(plan, 'READ_FAILED', task.key);
        } catch (error) {
          if (isAbort(error)) { task.state = 'pending'; throw error; }
          task.state = 'error'; const reason = classifyError(error);
          this._issue(plan, 'READ_FAILED', LIMIT_MESSAGES[reason], task.key, { recoverable: true });
          if (task.entityKey) plan.entities[task.entityKey].readFailure = reason;
        }
        await this._save(plan); this._emit(plan, onProgress);
      }
      await this._files(plan, tools, signal, onProgress);
      checkAbort(signal);
      this._coverage(plan);
      this._resolve(plan, 'SCAN_FAILED', '');
      plan.state = 'ready'; await this._save(plan); this._emit(plan, onProgress);
      return this._public(plan);
    } catch (error) {
      if (!plan) throw error;
      plan.state = isAbort(error) ? 'cancelled' : 'error';
      if (!isAbort(error)) this._issue(plan, error.code === 'NOTES_NOTION_LIMIT' ? 'INVENTORY_LIMIT' : 'SCAN_FAILED', error.code === 'NOTES_NOTION_TOOL_UNAVAILABLE' ? LIMIT_MESSAGES.unavailable : 'O inventário foi interrompido. Seus dados foram preservados e ele pode ser retomado.', '', { recoverable: true });
      await this._save(plan); this._emit(plan, onProgress); return this._public(plan);
    } finally { this.busy = false; }
  }
  async _roots(plan, task, tools, signal, onProgress) {
    const tool = tools.get(task.toolName);
    if (!tool) throw failure('NOTES_NOTION_TOOL_UNAVAILABLE', LIMIT_MESSAGES.unavailable);
    do {
      const args = argsFor(tool, { limit: 200, cursor: task.cursor || undefined, page_size: 200, start_cursor: task.cursor || undefined });
      const { payload } = await this._call(plan, tool, args, signal);
      const items = listItems(payload, ['pages', 'results', 'items', 'private_pages', 'shared_pages']);
      for (const item of items) this._enqueue(plan, item);
      for (const ref of referencesIn(payload.text)) this._enqueue(plan, ref);
      const next = continuation(payload);
      if (!next && field(payload, 'has_more', 'hasMore') === true) this._issue(plan, 'ROOT_PAGINATION_GAP', 'O Notion informou mais raízes sem fornecer cursor. Complemente esta seção com uma exportação ZIP completa.', task.key);
      if (next && (next === task.cursor || task.cursors.includes(next))) { this._issue(plan, 'REPEATED_CURSOR', 'O Notion repetiu um cursor de paginação. A enumeração foi interrompida para preservar os dados e evitar um ciclo.', task.key); break; }
      if (next && !['cursor', 'start_cursor'].some(name => Object.hasOwn(toolProperties(tool), name))) { this._issue(plan, 'ROOT_PAGINATION_GAP', 'O Notion retornou um cursor que esta ferramenta não aceita. A seção pode estar incompleta.', task.key); break; }
      if (task.cursor) task.cursors.push(task.cursor); task.cursor = next;
      await this._save(plan); this._emit(plan, onProgress);
    } while (task.cursor);
  }
  _file(plan, reference, entity, extras = {}) {
    if (!reference || plan.files[reference]) return;
    if (Object.keys(plan.files).length + plan.tasks.length >= IMPORT_LIMITS.entries) { this._issue(plan, 'INVENTORY_LIMIT', 'A migração atingiu o limite de segurança de entradas.'); return; }
    plan.files[reference] = { reference, entityKey: entity.key, state: 'pending', ...extras };
  }
  async _entity(plan, task, tools, signal) {
    const entity = plan.entities[task.entityKey], tool = tools.get('fetch');
    const idKey = firstProperty(tool, ['id', 'url', 'page_id'], 'id');
    const args = argsFor(tool, { include_file_urls: false, [idKey]: entity.kind === 'subtree' ? entity.id : entity.url });
    const { result, payload, raw } = await this._call(plan, tool, args, signal);
    const content = contentOf(result, entity);
    entity.title = content.title || entity.title || (entity.kind === 'database' ? 'Banco de dados' : entity.kind === 'data_source' ? 'Fonte de dados' : 'Página sem título');
    entity.body = content.body; entity.text = content.text; entity.raw = raw; entity.state = 'done'; entity.readFailure = null; entity.sourcePath = content.sourcePath;
    entity.properties = content.properties || entity.rowProperties || entity.properties;
    entity.unknownBlockIds = content.unknownBlockIds; entity.unknownBlockCount = content.unknownBlockCount; entity.truncated = content.truncated;
    entity.modifiedAt = field(payload, 'page_last_edited_at', 'last_edited_time');
    if (entity.kind === 'view') {
      entity.dataSourceKeys = content.discovered.filter(item => item.kind === 'data_source').map(item => item.key);
      let configuration = field(payload, 'configuration', 'config');
      if (!configuration) { const match = /<configuration\b[^>]*>([\s\S]*?)<\/configuration>/i.exec(content.text); if (match) { try { configuration = JSON.parse(match[1]); } catch {} } }
      const filter = field(payload, 'filter', 'filters') ?? (configuration && Object.hasOwn(configuration, 'filter') ? configuration.filter : configuration?.filters);
      const explicitlyNull = payload.records.some(record => Object.hasOwn(record, 'filter') && record.filter === null || Object.hasOwn(record, 'filters') && record.filters === null) || configuration && (Object.hasOwn(configuration, 'filter') && configuration.filter === null || Object.hasOwn(configuration, 'filters') && configuration.filters === null);
      entity.unfilteredView = !!explicitlyNull || filter !== undefined && (Array.isArray(filter) ? !filter.length : filter && typeof filter === 'object' && !Object.keys(filter).length);
    }
    if (/<database\b/i.test(content.text.slice(0, 500)) && entity.kind === 'page') entity.kind = 'database';
    for (const ref of content.discovered) if (ref.key !== entity.key) this._enqueue(plan, ref, ref.child ? entity.key : entity.parentKey);
    for (const blockId of content.unknownBlockIds) this._enqueue(plan, { ...notionIdentity(blockId, 'subtree'), title: 'Conteúdo recuperado', kind: 'subtree' }, entity.key);
    if (content.unknownTags.length) this._issue(plan, 'UNSUPPORTED_BLOCK', 'O Notion devolveu blocos sem representação completa. O texto e a resposta original foram preservados.', entity.key);
    for (const reference of fileReferencesIn(content.text)) this._file(plan, reference, entity);
    for (const record of payload.records) for (const file of inlineFiles({ properties: record.properties, cover: record.cover, icon: record.icon })) this._file(plan, file.reference, entity, file);
    if (entity.kind === 'data_source') {
      if (tools.has('query_data_sources')) this._task(plan, { key: 'query:' + entity.key, type: 'query', entityKey: entity.key, cursor: null, cursors: [] });
      else this._issue(plan, 'DATABASE_QUERY_UNAVAILABLE', 'A conexão não expõe leitura dos registros deste banco. O esquema e o conteúdo encontrados serão preservados; complemente com o ZIP completo.', entity.key);
    }
    if (!['data_source', 'view', 'subtree'].includes(entity.kind)) {
      if (tools.has('get_comments')) this._task(plan, { key: 'comments:' + entity.key, type: 'comments', entityKey: entity.key });
      else this._issue(plan, 'COMMENTS_UNAVAILABLE', 'A conexão não disponibiliza os comentários. Páginas e propriedades podem ser importadas; comentários exigem conferência na origem.', 'workspace');
    }
    this._resolve(plan, 'READ_FAILED', task.key);
  }
  async _query(plan, task, tools, signal, onProgress) {
    const entity = plan.entities[task.entityKey], tool = tools.get('query_data_sources'), properties = toolProperties(tool);
    if (!tool || entity.state !== 'done') throw failure('NOTES_NOTION_QUERY', 'O esquema do banco precisa ser lido antes dos registros.');
    // A saved view can filter rows. It is used only when the actual session
    // exposes cursor pagination; rows mode is still read as an independent set.
    const siblingSources = Object.values(plan.entities).filter(item => item.kind === 'data_source' && item.parentKey === entity.parentKey).length;
    const view = Object.values(plan.entities).find(item => item.kind === 'view' && item.state === 'done' && (item.parentKey === entity.key || item.dataSourceKeys?.includes(entity.key) || (!item.dataSourceKeys?.length && siblingSources <= 1 && item.parentKey === entity.parentKey)));
    const cursorName = firstProperty(tool, ['cursor', 'start_cursor', 'next_cursor'], null);
    const viewName = firstProperty(tool, ['view_url', 'view_id', 'view'], null);
    const viewCapable = view && cursorName && viewName && (!properties.mode?.enum || properties.mode.enum.includes('view'));
    let mode = task.mode || (viewCapable ? 'view' : 'rows'); task.mode = mode;
    const rows = entity.rows || []; const seen = new Set(rows.map(row => stableHash(JSON.stringify(row))));
    do {
      const args = argsFor(tool, { mode, data_source_url: entity.url, data_source_id: entity.id, limit: 100, page_size: 100, ...(mode === 'view' ? { [viewName]: view.url } : {}), ...(task.cursor ? { [cursorName]: task.cursor } : {}) });
      const { payload, raw } = await this._call(plan, tool, args, signal);
      const items = listItems(payload, ['results', 'rows', 'items']);
      (entity.querySources ||= []).push(raw);
      for (const row of items) {
        const hash = stableHash(JSON.stringify(row)); if (!seen.has(hash)) { rows.push(row); seen.add(hash); }
        const identity = rowIdentity(row);
        if (identity) this._enqueue(plan, { ...identity, title: rowTitle(row), properties: row.properties || row }, entity.key);
        else {
          const key = 'row:' + stableHash(entity.key + ':' + hash);
          if (!plan.entities[key]) plan.entities[key] = { key, id: stableHash(key).slice(0, 32), kind: 'row', title: rowTitle(row), parentKey: entity.key, state: 'done', body: '', properties: row.properties || row };
          this._issue(plan, 'ROW_WITHOUT_PAGE_ID', 'Um registro não expõe o ID de sua página. Suas propriedades foram preservadas, mas o corpo não pôde ser conferido.', key);
        }
        for (const file of inlineFiles(row)) this._file(plan, file.reference, entity, file);
      }
      entity.rows = rows;
      const next = continuation(payload), more = field(payload, 'has_more', 'hasMore') === true;
      if (next && mode === 'view' && cursorName) {
        if (next === task.cursor || task.cursors.includes(next)) { this._issue(plan, 'REPEATED_CURSOR', 'O Notion repetiu um cursor dos registros. O banco pode estar incompleto.', task.key); break; }
        if (task.cursor) task.cursors.push(task.cursor); task.cursor = next;
      } else {
        if (more || next || items.length >= 100 && (mode === 'rows' || field(payload, 'has_more', 'hasMore') !== false) || field(payload, 'truncated') === true) this._issue(plan, 'DATABASE_ROW_LIMIT', 'Este banco atingiu o limite de leitura do Notion ou informou mais registros sem paginação. Os registros encontrados serão preservados; complemente com a exportação ZIP completa.', entity.key);
        task.cursor = null;
      }
      await this._save(plan); this._emit(plan, onProgress);
    } while (task.cursor);
    if (mode === 'view') {
      if (view?.unfilteredView && !plan.issues.some(issue => !issue.resolved && issue.entityId === task.key)) return;
      this._issue(plan, 'FILTERED_VIEW_SCOPE', 'Os registros foram lidos de uma visualização salva, que pode aplicar filtros. O esquema e a visualização original foram preservados; complemente com o ZIP completo para conferir todos os registros.', entity.key);
      // The same query task has a separate rows pass, never SQL. A full view
      // is not evidence that filtered-out records do not exist.
      task.mode = 'rows'; task.cursor = null; return this._query(plan, task, tools, signal, onProgress);
    }
    if (mode === 'rows' && !plan.issues.some(issue => !issue.resolved && issue.code === 'DATABASE_ROW_LIMIT' && issue.entityId === entity.key)) this._resolve(plan, 'FILTERED_VIEW_SCOPE', entity.key);
    this._resolve(plan, 'READ_FAILED', task.key);
  }
  async _comments(plan, task, tools, signal) {
    const tool = tools.get('get_comments'), entity = plan.entities[task.entityKey];
    if (!tool) throw failure('NOTES_NOTION_COMMENTS', 'Comentários indisponíveis.');
    const idKey = firstProperty(tool, ['page_id', 'id', 'page_url', 'url'], 'page_id');
    const args = argsFor(tool, { include_resolved: true, include_all_blocks: true, include_content: true, [idKey]: entity.id });
    const { payload, raw } = await this._call(plan, tool, args, signal);
    entity.commentsRaw = raw; entity.comments = payload.text || (listItems(payload, ['comments', 'discussions', 'results']).length ? JSON.stringify(payload.data, null, 2) : '');
    if (field(payload, 'has_more', 'hasMore') === true || continuation(payload)) this._issue(plan, 'COMMENTS_PAGINATION_GAP', 'O Notion indicou comentários adicionais. A resposta original e os comentários lidos foram preservados; confira o restante na origem.', entity.key);
    if (field(payload, 'truncated') === true) this._issue(plan, 'COMMENTS_TRUNCATED', 'O Notion truncou a resposta de comentários. O conteúdo recebido foi preservado.', entity.key);
  }
  async _download(plan, file, signal) {
    let current = officialDownload(file.url);
    if (!current) throw failure('NOTES_NOTION_EXTERNAL_FILE', 'O anexo não está em um endereço HTTPS oficial de arquivos do Notion.');
    if (file.expiry && new Date(file.expiry).getTime() <= Date.now()) throw failure('NOTES_NOTION_EXPIRED_FILE', 'O endereço temporário do anexo expirou.');
    const downloadSignal = typeof AbortSignal.any === 'function' ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]) : signal;
    let response;
    for (let redirects = 0; redirects < 5; redirects++) {
      checkAbort(signal);
      response = await this.fetch(current.href, { signal: downloadSignal, redirect: 'manual', credentials: 'omit', headers: { Accept: '*/*' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel?.().catch(() => {});
      current = officialDownload(new URL(response.headers.get('location') || '', current).href);
      if (!current) throw failure('NOTES_NOTION_UNSAFE_REDIRECT', 'O endereço do anexo redirecionou para um host não permitido.');
      if (redirects === 4) throw failure('NOTES_NOTION_REDIRECT_LIMIT', 'O anexo excede o limite de redirecionamentos.');
    }
    if (!response?.ok || !response.body) throw failure('NOTES_NOTION_FILE_HTTP', 'O Notion não disponibilizou os bytes do anexo.');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > IMPORT_LIMITS.fileBytes) { await response.body.cancel?.(); throw failure('NOTES_NOTION_FILE_LIMIT', 'O anexo excede 256 MiB.'); }
    const hash = crypto.createHash('sha256'); let bytes = 0;
    const name = stableHash(file.reference) + '-' + fileName(file.name || decodeURIComponent(current.pathname.split('/').at(-1) || 'arquivo'));
    const destination = path.join(this._planFolder(plan.id), 'downloads', name), temporary = destination + '.' + crypto.randomUUID() + '.partial';
    const guard = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > IMPORT_LIMITS.fileBytes || plan.sourceBytes + bytes > IMPORT_LIMITS.totalBytes) { callback(failure('NOTES_NOTION_FILE_LIMIT', 'O anexo ou o inventário excede o limite de bytes.')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      const stream = typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      await pipeline(stream, guard, nativeFs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), ...(downloadSignal ? [{ signal: downloadSignal }] : []));
      if (response.headers.has('content-length') && Number.isFinite(declared) && declared !== bytes) throw failure('NOTES_NOTION_FILE_CHANGED', 'O tamanho recebido não corresponde ao anexo anunciado.');
      checkAbort(signal); await fs.rename(temporary, destination);
      file.local = name; file.hash = hash.digest('hex'); file.bytes = bytes; file.state = 'done'; file.name = fileName(file.name || name.slice(65)); plan.sourceBytes += bytes;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async _files(plan, tools, signal, onProgress) {
    const files = Object.values(plan.files).filter(file => file.state !== 'done'), resolver = tools.get('get_file_download_urls');
    const references = files.filter(file => file.reference.startsWith('notion-file-block://'));
    for (let start = 0; start < references.length; start += 25) {
      checkAbort(signal); const batch = references.slice(start, start + 25);
      if (!resolver) { for (const file of batch) { file.state = 'error'; this._issue(plan, 'FILE_RESOLVER_UNAVAILABLE', 'A conexão não disponibiliza os endereços dos anexos. As referências originais serão preservadas; complemente com o ZIP completo.', stableHash(file.reference).slice(0, 16), { recoverable: true }); } continue; }
      try {
        const { payload } = await this._call(plan, resolver, argsFor(resolver, { references: batch.map(file => file.reference) }), signal);
        for (const resolved of listItems(payload, ['files', 'results'])) {
          const file = plan.files[resolved.reference]; if (file) { file.url = resolved.url; file.expiry = resolved.expiry_time; }
        }
      } catch (error) { if (isAbort(error)) throw error; for (const file of batch) file.state = 'error'; }
      for (const file of batch) if (!file.url) { file.state = 'error'; this._issue(plan, 'FILE_UNRESOLVED', 'O Notion não resolveu um anexo (permissão, arquivo ausente ou endereço expirado). Sua referência foi preservada.', stableHash(file.reference).slice(0, 16), { recoverable: true }); }
      await this._save(plan); this._emit(plan, onProgress);
    }
    for (const file of files) {
      checkAbort(signal); if (!file.url) continue;
      const id = stableHash(file.reference).slice(0, 16);
      try { await this._download(plan, file, signal); this._resolve(plan, 'FILE_DOWNLOAD_FAILED', id); this._resolve(plan, 'FILE_UNRESOLVED', id); this._resolve(plan, 'FILE_RESOLVER_UNAVAILABLE', id); }
      catch (error) { if (signal?.aborted) throw abortError(); file.state = 'error'; this._issue(plan, 'FILE_DOWNLOAD_FAILED', error.code === 'NOTES_NOTION_EXTERNAL_FILE' ? 'Um anexo externo foi preservado como link; seus bytes não foram baixados. Apenas hosts oficiais do Notion são baixados automaticamente.' : file.inline ? 'Não foi possível preservar localmente um arquivo de propriedade ou capa. Inicie uma nova verificação para renovar o endereço deste arquivo ou complemente com o ZIP completo. Sua referência original foi mantida.' : 'Não foi possível preservar localmente um anexo (falha, tamanho, endereço expirado ou integridade). Sua referência original foi mantida; retome ou complemente com o ZIP completo.', id, { recoverable: true }); }
      await this._save(plan); this._emit(plan, onProgress);
    }
  }
  _coverage(plan) {
    for (const entity of Object.values(plan.entities)) {
      if (!entity.truncated && !entity.unknownBlockCount) continue;
      const missing = entity.unknownBlockIds.filter(id => { const key = notionIdentity(id, 'subtree')?.key; return !key || plan.entities[key]?.state !== 'done'; });
      if (!entity.unknownBlockIds.length || missing.length || entity.unknownBlockCount > entity.unknownBlockIds.length) this._issue(plan, 'TRUNCATED_CONTENT', 'O Notion omitiu blocos desta página e nem todos puderam ser recuperados. O conteúdo lido e as respostas originais foram preservados; complemente com o ZIP completo.', entity.key, { recoverable: missing.length > 0 });
      else this._resolve(plan, 'TRUNCATED_CONTENT', entity.key);
    }
    if (!Object.values(plan.entities).some(entity => entity.state === 'done')) this._issue(plan, 'EMPTY_INVENTORY', 'A conexão não retornou páginas legíveis. Confira o workspace e as permissões ou importe uma exportação ZIP completa.');
  }
  _entityPath(entity, plan) {
    const parents = []; const seen = new Set([entity.key]); let parent = plan.entities[entity.parentKey];
    while (parent && !seen.has(parent.key)) { seen.add(parent.key); parents.unshift(fileName(parent.title, 'Página').slice(0, 35)); parent = plan.entities[parent.parentKey]; }
    // All hierarchy remains in metadata/breadcrumbs. Bounded physical paths keep
    // deep workspaces importable on Windows without inventing a path limit.
    const sourceNames = Array.isArray(entity.sourcePath) ? entity.sourcePath.map(item => typeof item === 'string' ? item : item?.title || item?.name || '').filter(Boolean) : [];
    const folder = sourceNames.length ? sourceNames.join(' / ') : typeof entity.sourcePath === 'string' ? entity.sourcePath : parents.join(' / '), slug = fileName(entity.title, 'Página').slice(0, 70), id = entity.id.replace(/-/g, '');
    return { relative: 'Páginas/' + (parents.length ? fileName(parents[0]).slice(0, 35) + '/' : '') + slug + ' ' + id + '.md', breadcrumbs: folder };
  }
  _sourceHash(entity, plan) {
    return stableHash(JSON.stringify(archiveSafe({ body: entity.body, properties: entity.rowProperties || entity.properties, comments: entity.comments, rows: entity.rows, recovered: Object.values(plan.entities).filter(item => item.parentKey === entity.key && item.kind === 'subtree' && item.state === 'done').map(item => ({ id: item.id, body: item.body })) })));
  }
  async import({ planId, snapshot, signal, onProgress } = {}) {
    if (this.busy) throw failure('NOTES_NOTION_BUSY', 'Uma importação Notion já está em andamento.');
    this.busy = true; let plan;
    try {
      const candidate = await this._load(planId); await this._assertAccount(candidate, null, signal); plan = candidate; const original = validateSnapshot(snapshot);
      const previous = original.groups.find(group => group.imported?.notionMigrationId === planId);
      if (previous && Number(previous.imported.notionMigrationRevision || 0) === Number(plan.revision || 0)) return { snapshot: original, report: { ...(plan.report || {}), source: 'notion', groupId: previous.id, alreadyImported: true, notionMigrationId: planId } };
      if (!this._public(plan).canImport) throw failure('NOTES_NOTION_NOT_READY', 'Conclua ou interrompa o inventário antes de importar o conteúdo encontrado.');
      checkAbort(signal); plan.state = 'importing'; await this._save(plan); this._emit(plan, onProgress);
      const staging = await fs.mkdtemp(path.join(this._planFolder(plan.id), 'workspace-')); await directory(path.join(staging, 'Fontes MCP')); await directory(path.join(staging, 'Anexos'));
      const oldNotes = original.notes.filter(note => note.imported?.notionMigrationId === planId && note.imported?.notionId), oldIds = new Set(oldNotes.map(note => note.imported.notionId.replace(/-/g, '')));
      const oldHashes = new Set(original.notes.filter(note => note.imported?.archive).flatMap(note => note.attachments || []).map(item => item.hash));
      for (const entity of Object.values(plan.entities)) if (entity.state === 'done' && oldIds.has(entity.id.replace(/-/g, ''))) {
        const prior = oldNotes.find(note => note.imported.notionId.replace(/-/g, '') === entity.id.replace(/-/g, ''));
        if (prior.imported.notionSourceHash && prior.imported.notionSourceHash !== this._sourceHash(entity, plan)) this._issue(plan, 'SOURCE_ALREADY_IMPORTED_CHANGED', 'A origem de um item já importado mudou. Sua nota local foi preservada integralmente; as novas respostas estão no arquivo técnico para conferência.', entity.key);
      }
      const entityPaths = new Map(), content = Object.values(plan.entities).filter(entity => entity.state === 'done' && entity.kind !== 'view' && !oldIds.has(entity.id.replace(/-/g, '')) && (entity.kind !== 'subtree' || oldIds.has(plan.entities[entity.parentKey]?.id?.replace(/-/g, ''))));
      for (const entity of content) entityPaths.set(entity.key, this._entityPath(entity, plan));
      for (const raw of plan.rawFiles) { checkAbort(signal); if (!oldHashes.has(raw.hash)) await verifiedCopy(path.join(this._planFolder(plan.id), 'sources', raw.name), path.join(staging, 'Fontes MCP', raw.name), raw.hash, raw.bytes); }
      await fs.copyFile(path.join(this._planFolder(plan.id), 'sources', 'tools-list.json'), path.join(staging, 'Fontes MCP', 'tools-list.json'));
      for (const file of Object.values(plan.files)) if (file.state === 'done' && !oldHashes.has(file.hash)) {
        checkAbort(signal); const source = path.join(this._planFolder(plan.id), 'downloads', file.local);
        await verifiedCopy(source, path.join(staging, 'Anexos', file.local), file.hash, file.bytes);
      }
      for (const entity of content) {
        checkAbort(signal); const info = entityPaths.get(entity.key); let body = entity.body || '';
        const properties = propertiesMarkdown(entity.rowProperties || entity.properties);
        const recovered = Object.values(plan.entities).filter(item => item.parentKey === entity.key && item.kind === 'subtree' && item.state === 'done');
        if (recovered.length) body += '\n\n## Conteúdo recuperado\n\n' + recovered.map(item => item.body || item.text || '').join('\n\n');
        if (entity.comments) body += '\n\n## Comentários da origem\n\n' + notionMarkdown(entity.comments);
        if (entity.rows?.length) {
          const keys = [...new Set(entity.rows.flatMap(row => Object.keys(row.properties || row)))];
          const quote = value => '"' + valueText(value).replace(/"/g, '""') + '"';
          const csv = [keys.map(quote).join(','), ...entity.rows.map(row => keys.map(key => quote((row.properties || row)[key])).join(','))].join('\r\n');
          const csvName = fileName(entity.title, 'Banco') + ' ' + entity.id.replace(/-/g, '') + '.csv';
          await directory(path.join(staging, 'Bancos')); await fs.writeFile(path.join(staging, 'Bancos', csvName), archiveSafe(csv), { mode: 0o600 });
          body += '\n\n## Registros encontrados\n\n' + entity.rows.map(row => { const ref = rowIdentity(row); return ref ? '- [' + rowTitle(row).replace(/[\[\]]/g, '') + '](' + ref.url + ')' : '- ' + rowTitle(row); }).join('\n');
        }
        let document = '# ' + entity.title.replace(/\r?\n/g, ' ') + '\n\n' + (info.breadcrumbs ? '**Caminho na origem:** ' + info.breadcrumbs + '\n\n' : '') + (entity.url ? '[Abrir no Notion](' + entity.url + ')\n\n' : '') + (properties ? properties + '\n' : '') + body;
        document = adaptOutsideCode(document, part => {
          for (const file of Object.values(plan.files)) if (file.state === 'done') part = part.split(file.reference).join(oldHashes.has(file.hash) ? 'notes-asset:' + file.hash : path.posix.relative(path.posix.dirname(info.relative), 'Anexos/' + file.local));
          return part.replace(/\[([^\]\n]*)\]\((collection:\/\/[^)\s]+)\)/g, (originalLink, label, target) => {
            const key = notionIdentity(target)?.key, local = key && entityPaths.get(key);
            if (local) return '[' + label + '](' + path.posix.relative(path.posix.dirname(info.relative), local.relative) + ')';
            // Existing-note links are associated after importWorkspace, whose
            // staging index intentionally contains only newly added documents.
            return originalLink;
          });
        });
        document = archiveSafe(document);
        if (Buffer.byteLength(document, 'utf8') > IMPORT_LIMITS.textBytes) throw failure('NOTES_NOTION_TEXT_LIMIT', 'Uma página excede o limite de texto local. Seus originais foram preservados; nenhuma nota foi salva.');
        const filename = path.join(staging, ...info.relative.split('/')); await directory(path.dirname(filename)); await fs.writeFile(filename, document, { mode: 0o600 });
      }
      const summary = this._public(plan);
      await atomicJSON(path.join(staging, 'Fontes MCP', 'manifest.json'), archiveSafe({ version: 1, notionMigrationId: plan.id, createdAt: plan.createdAt, scope: SCOPE, workspaceComplete: false, complete: summary.complete, issues: summary.issues, entities: Object.values(plan.entities).map(({ key, id, kind, title, parentKey, raw, commentsRaw, querySources }) => ({ key, id, kind, title, parentKey, raw, commentsRaw, querySources })), files: Object.values(plan.files).map(({ reference, hash, bytes, local, state }) => ({ reference, hash, bytes, local, state })) }));
      const originalGroups = new Set(original.groups.map(group => group.id));
      const originalNoteIds = new Set(original.notes.map(note => note.id));
      const result = await importWorkspace({ source: 'notion', inputPath: staging, snapshot: original, assets: { addFile: async (...args) => { checkAbort(signal); const descriptor = await this.assets.addFile(...args); checkAbort(signal); return descriptor; } }, onProgress: () => this._emit(plan, onProgress) });
      checkAbort(signal);
      const generatedGroup = result.snapshot.groups.find(item => !originalGroups.has(item.id));
      let group = generatedGroup;
      if (previous) {
        group = result.snapshot.groups.find(item => item.id === previous.id);
        const remap = new Map();
        for (const session of generatedGroup.sessions) {
          const match = group.sessions.find(item => !!item.imported?.archive === !!session.imported?.archive && item.imported?.path === session.imported?.path);
          if (match) remap.set(session.id, match.id); else group.sessions.push(session);
        }
        const oldNoteIds = new Set(original.notes.map(note => note.id));
        for (const note of result.snapshot.notes) if (!oldNoteIds.has(note.id) && remap.has(note.s)) note.s = remap.get(note.s);
        if (remap.has(result.snapshot.session)) result.snapshot.session = remap.get(result.snapshot.session);
        for (const fieldName of ['openBy', 'focusBy']) for (const [from, to] of remap) if (Object.hasOwn(result.snapshot[fieldName] || {}, from)) {
          const incoming = result.snapshot[fieldName][from];
          result.snapshot[fieldName][to] = fieldName === 'openBy' ? [...new Set([...(result.snapshot[fieldName][to] || []), ...incoming])] : original.focusBy?.[to] || incoming;
          delete result.snapshot[fieldName][from];
        }
        result.snapshot.groups = result.snapshot.groups.filter(item => item.id !== generatedGroup.id);
        if (result.snapshot.expanded) delete result.snapshot.expanded[generatedGroup.id];
      } else group.name = 'Notion · ' + plan.createdAt.slice(0, 10);
      group.imported.notionMigrationId = plan.id; group.imported.notionMigrationRevision = plan.revision || 0;
      const byPath = new Map(content.map(entity => [entityPaths.get(entity.key).relative, entity]));
      const oldAssets = new Map(original.notes.flatMap(note => note.attachments || []).map(item => [item.hash, item]));
      for (const note of result.snapshot.notes) if (!originalNoteIds.has(note.id) && note.imported?.path && byPath.has(note.imported.path)) {
        const entity = byPath.get(note.imported.path); Object.assign(note.imported, { notionId: entity.id, notionUrl: entity.url || '', notionParentId: plan.entities[entity.parentKey]?.id || '', notionMigrationId: plan.id, notionKind: entity.kind, notionBreadcrumbs: entityPaths.get(entity.key).breadcrumbs, notionSourceHash: this._sourceHash(entity, plan) });
        for (const [hash, descriptor] of oldAssets) if (note.body.includes('notes-asset:' + hash) && !(note.attachments || []).some(item => item.hash === hash)) (note.attachments ||= []).push(structuredClone(descriptor));
      }
      const previousByNotionId = new Map(oldNotes.map(note => [note.imported.notionId.replace(/-/g, ''), note]));
      for (const note of result.snapshot.notes) if (!originalNoteIds.has(note.id)) note.body = adaptOutsideCode(note.body, part => part.replace(/\[([^\]\n]*)\]\(((?:https:\/\/(?:[\w-]+\.)?notion\.(?:so|site|com)\/|collection:\/\/)[^)\s]+)\)/gi, (originalLink, label, target) => {
        const previousNote = previousByNotionId.get(notionIdentity(target)?.id?.replace(/-/g, ''));
        if (!previousNote) return originalLink;
        const links = note.imported.links ||= [];
        if (!links.some(link => link.noteId === previousNote.id && link.target === target)) links.push({ target, label, fragment: '', noteId: previousNote.id, embed: false });
        return '[[' + previousNote.title + ']]';
      }));
      result.report = { ...result.report, groupId: group.id, notionMigrationId: plan.id, pages: summary.pages, databases: summary.databases, downloadedFiles: summary.files, complete: summary.complete, workspaceComplete: false, scope: SCOPE, issues: summary.issues, warnings: [...result.report.warnings, ...summary.issues.map(issue => issue.message)] };
      plan.state = 'prepared'; plan.report = structuredClone(result.report); await this._save(plan); this._emit(plan, onProgress);
      return { snapshot: validateSnapshot(result.snapshot), report: result.report };
    } catch (error) {
      if (plan && plan.state === 'importing') { plan.state = isAbort(error) ? 'cancelled' : 'ready'; await this._save(plan); this._emit(plan, onProgress); }
      throw error;
    } finally { this.busy = false; }
  }
  async finish(planId) {
    const plan = await this._load(planId); plan.state = 'applied'; await this._save(plan); return this._public(plan);
  }
}
module.exports = { NotionMigration, normalizeTool, officialDownload };
