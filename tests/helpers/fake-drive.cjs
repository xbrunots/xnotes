'use strict';
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fakeDrive({ pageSize = 2 } = {}) {
  const files = new Map(), sessions = new Map(), requests = [];
  let nextId = 0, nextSession = 0;
  const drive = { files, requests, hook: null, failAfterCompleteOnce: false };
  const metadata = file => Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'bytes'));
  drive.seed = (name, content, extra = {}) => {
    const bytes = Buffer.from(content), id = 'file-' + ++nextId;
    const file = { id, name, size: String(bytes.length), version: '1', sha256Checksum: hash(bytes), bytes, ...extra };
    files.set(id, file); return metadata(file);
  };
  drive.change = (id, content) => {
    const file = files.get(id), bytes = Buffer.from(content);
    Object.assign(file, { bytes, size: String(bytes.length), sha256Checksum: hash(bytes), version: String(Number(file.version) + 1) });
  };
  drive.fetch = async (value, options = {}) => {
    options.signal?.throwIfAborted();
    const url = new URL(value), request = { url, method: options.method || 'GET', options };
    requests.push(request);
    const injected = await drive.hook?.(request);
    if (injected) return injected;
    if (request.method === 'GET' && url.pathname.endsWith('/files/generateIds')) return json({ ids: ['file-' + ++nextId] });
    if (request.method === 'GET' && url.pathname === '/drive/v3/files') {
      if (url.searchParams.get('spaces') !== 'appDataFolder') return json({ error: {} }, 400);
      const offset = Number(url.searchParams.get('pageToken') || 0), all = [...files.values()];
      return json({ files: all.slice(offset, offset + pageSize).map(metadata), ...(offset + pageSize < all.length ? { nextPageToken: String(offset + pageSize) } : {}) });
    }
    const match = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const file = files.get(match[1]);
      if (!file) return json({ error: {} }, 404);
      return url.searchParams.get('alt') === 'media' ? new Response(file.bytes, { headers: { 'Content-Length': String(file.bytes.length) } }) : json(metadata(file));
    }
    if (request.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const meta = JSON.parse(options.body);
      if (files.has(meta.id)) return json({ error: {} }, 409);
      const id = 'upload-' + ++nextSession;
      sessions.set(id, { meta, bytes: Buffer.alloc(0), expectedSize: Number(options.headers['X-Upload-Content-Length']) });
      return new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + id } });
    }
    if (request.method === 'PUT' && url.pathname === '/upload/drive/v3/files') {
      const session = sessions.get(url.searchParams.get('upload_id'));
      if (!session) return json({ error: {} }, 404);
      const range = options.headers['Content-Range'], bytes = Buffer.from(options.body);
      if (/^bytes \*\//.test(range) && bytes.length === 0 && session.expectedSize !== 0) return new Response(null, { status: 308, headers: session.bytes.length ? { Range: 'bytes=0-' + (session.bytes.length - 1) } : {} });
      const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      const total = parts ? Number(parts[3]) : 0, start = parts ? Number(parts[1]) : 0;
      if (start !== session.bytes.length) return new Response(null, { status: 308, headers: { Range: 'bytes=0-' + (session.bytes.length - 1) } });
      session.bytes = Buffer.concat([session.bytes, bytes]);
      if (session.bytes.length < total) return new Response(null, { status: 308, headers: { Range: 'bytes=0-' + (session.bytes.length - 1) } });
      const file = { ...session.meta, size: String(session.bytes.length), version: '1', sha256Checksum: hash(session.bytes), bytes: session.bytes };
      files.set(file.id, file); sessions.delete(url.searchParams.get('upload_id'));
      if (drive.failAfterCompleteOnce) { drive.failAfterCompleteOnce = false; throw new TypeError('simulated connection loss'); }
      return json(metadata(file));
    }
    return json({ error: {} }, 404);
  };
  return drive;
}

function fakeAuth({ connected = true, connectionId = 'test-grant' } = {}) {
  return {
    status: { configured: true, connected, connectionId, error: null }, calls: 0, invalidations: 0, clientId: 'test-client',
    async init() { return this.status; },
    async getAccessToken() { this.calls++; if (!this.status.connected) throw Object.assign(new Error('Conecte novamente.'), { code: 'AUTH_REQUIRED' }); return 'test-access-only'; },
    invalidateAccessToken() { this.invalidations++; },
    async connect() { this.status.connected = true; this.status.connectionId ||= 'test-new-grant'; return this.status; },
    async configure(input) {
      const id = input.installed?.client_id || input.client_id;
      if (id !== this.clientId) { this.clientId = id; this.status.connected = false; this.status.connectionId = null; }
      return this.status;
    },
    async disconnect() { this.status.connected = false; return this.status; }, async close() {}
  };
}
module.exports = { fakeDrive, fakeAuth, hash, json };
