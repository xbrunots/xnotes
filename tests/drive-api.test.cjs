'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriveApi } = require('../desktop/drive-api.cjs');
const { fakeDrive, fakeAuth, hash, json } = require('./helpers/fake-drive.cjs');

const apiFor = drive => new DriveApi({ auth: fakeAuth(), fetch: drive.fetch, retryBaseMs: 0, maxRetryMs: 0 });

test('Drive API completes pagination including empty pages and rejects incomplete/cyclic results', async () => {
  const drive = fakeDrive({ pageSize: 2 });
  for (let i = 0; i < 5; i++) drive.seed('fixture-' + i, 'bytes');
  const api = apiFor(drive);
  assert.equal((await api.listFiles()).length, 5);
  assert.equal(drive.requests.filter(request => request.url.pathname === '/drive/v3/files').length, 3);
  drive.hook = request => request.url.pathname === '/drive/v3/files' ? json({ files: [], nextPageToken: 'same' }) : null;
  await assert.rejects(api.listFiles(), { code: 'DRIVE_PROTOCOL' });
  drive.hook = () => json({ files: [], incompleteSearch: true });
  await assert.rejects(api.listFiles(), { code: 'DRIVE_PROTOCOL' });
});

test('Drive API retries 429/5xx within bounds and refreshes an expired access token once', async () => {
  const drive = fakeDrive(), auth = fakeAuth();
  let calls = 0;
  drive.hook = () => { calls++; return calls === 1 ? json({}, 401) : calls === 2 ? json({}, 429) : calls === 3 ? json({}, 503) : null; };
  const api = new DriveApi({ auth, fetch: drive.fetch, maxAttempts: 4, retryBaseMs: 0, maxRetryMs: 0 });
  assert.deepEqual(await api.listFiles(), []);
  assert.equal(auth.invalidations, 1);
  assert.equal(calls, 4);
  calls = 0; drive.hook = () => { calls++; return json({}, 503); };
  await assert.rejects(api.listFiles(), { code: 'DRIVE_TEMPORARY' });
  assert.equal(calls, 4);
});

test('resumable upload verifies bytes and pre-generated IDs prevent duplicates after a lost completion response', async () => {
  const drive = fakeDrive(), api = apiFor(drive), bytes = Buffer.from('Conteúdo imutável\n😀');
  drive.failAfterCompleteOnce = true;
  const uploaded = await api.uploadImmutable({ name: 'notes-v1-asset-' + hash(bytes), buffer: bytes, sha256: hash(bytes), kind: 'asset' });
  assert.equal(drive.files.size, 1);
  assert.equal(uploaded.sha256Checksum, hash(bytes));
  const again = await api.uploadImmutable({ name: uploaded.name, buffer: bytes, sha256: hash(bytes), kind: 'asset' });
  assert.equal(again.id, uploaded.id);
  assert.equal(drive.files.size, 1);
  assert.ok(drive.requests.some(request => request.url.pathname.endsWith('/files/generateIds') && request.url.searchParams.get('space') === 'appDataFolder'));
});

test('streamed downloads enforce hash/size and preserve existing files on corruption', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-drive-api-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const drive = fakeDrive(), api = apiFor(drive), bytes = Buffer.from('Anexo com bytes originais');
  const file = drive.seed('fixture', bytes), destination = path.join(directory, hash(bytes));
  await api.downloadTo(file.id, destination, { sha256: hash(bytes), size: bytes.length });
  assert.deepEqual(await fs.readFile(destination), bytes);
  drive.change(file.id, Buffer.from('corrompido'));
  await assert.rejects(api.downloadTo(file.id, destination, { sha256: hash(bytes), size: bytes.length }), { code: 'DRIVE_INTEGRITY' });
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.deepEqual(await fs.readdir(directory), [hash(bytes)]);
  await assert.rejects(api.downloadBuffer(file.id, { maxBytes: 2 }), { code: 'DRIVE_SIZE_LIMIT' });
});

test('cancellation aborts active HTTP and production refuses arbitrary or injected endpoints', async () => {
  const auth = fakeAuth();
  const api = new DriveApi({ auth, fetch: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const running = api.listFiles();
  await new Promise(resolve => setImmediate(resolve)); api.cancel();
  await assert.rejects(running);
  await assert.rejects(api.downloadBuffer('../escape'), { code: 'DRIVE_PROTOCOL' });
  assert.throws(() => new DriveApi({ auth, testBaseURL: 'http://example.com' }), TypeError);
});

test('HTTP timeouts are bounded and cannot leave a transfer hanging indefinitely', async () => {
  let calls = 0;
  const api = new DriveApi({ auth: fakeAuth(), timeoutMs: 20, maxAttempts: 2, retryBaseMs: 0,
    fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      calls++;
      const timer = setTimeout(() => resolve(json({ files: [] })), 200);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(api.listFiles(), { code: 'DRIVE_OFFLINE' });
  assert.equal(calls, 2);
});

test('untrusted upload session URLs never receive an authorization token', async () => {
  const drive = fakeDrive();
  drive.hook = request => request.method === 'POST' ? new Response(null, { headers: { Location: 'https://attacker.invalid/upload' } }) : null;
  const api = apiFor(drive), bytes = Buffer.from('guard');
  await assert.rejects(api.uploadImmutable({ name: 'notes-v1-asset-' + hash(bytes), buffer: bytes, kind: 'asset' }), { code: 'DRIVE_PROTOCOL' });
  assert.ok(drive.requests.every(request => request.url.hostname === 'www.googleapis.com'));
});

test('empty immutable files are uploaded with the Google zero-byte content range', async () => {
  const drive = fakeDrive(), api = apiFor(drive), bytes = Buffer.alloc(0);
  const file = await api.uploadImmutable({ name: 'notes-v1-asset-' + hash(bytes), buffer: bytes, sha256: hash(bytes), kind: 'asset' });
  assert.equal(Number(file.size), 0); assert.equal(file.sha256Checksum, hash(bytes));
  assert.ok(drive.requests.some(request => request.method === 'PUT' && request.options.headers['Content-Range'] === 'bytes */0'));
});
