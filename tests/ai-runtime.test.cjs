'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { AiRuntime, DEFAULT_SETTINGS } = require('../desktop/ai-runtime.cjs');

function fakeSpawner(handler) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const record = { command, args, options, child, input: '', messages: [], killed: false, ended: false };
    calls.push(record);
    child.pid = 100000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let buffer = '';
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        record.input += chunk.toString();
        if (record.onMessage) {
          buffer += chunk.toString();
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line) continue;
            const message = JSON.parse(line); record.messages.push(message);
            record.onMessage(message);
          }
        }
        done();
      },
      final(done) { record.onEnd?.(); done(); }
    });
    record.send = (value, fragment = 0) => {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (fragment) for (let offset = 0; offset < bytes.length; offset += fragment) child.stdout.write(bytes.subarray(offset, offset + fragment));
      else child.stdout.write(bytes);
    };
    record.close = (code = 0) => {
      if (record.ended) return;
      record.ended = true;
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, record.killed ? 'SIGTERM' : null));
    };
    child.kill = () => { record.killed = true; record.close(null); return true; };
    handler(record);
    return child;
  };
  return { spawnImpl, calls };
}

async function setup(t, handler = () => {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-ai-runtime-test-'));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  for (const name of ['codex.exe', 'claude.exe', 'agent.exe', 'node.exe']) await fs.writeFile(path.join(bin, name), 'test-only: never execute');
  const fake = fakeSpawner(handler), events = [];
  const runtime = new AiRuntime({ dataDir: directory, testing: true, platform: 'win32', env: { PATH: bin }, spawnImpl: fake.spawnImpl, emit: event => events.push(event), ...options });
  await runtime.init();
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^notes-ai-runtime-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, bin, fake, events, runtime };
}

const request = { prompt: 'Crie uma nota sintética', context: { groups: [], notes: [] }, schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } };
const output = { message: 'Ação sintética: sessão e coração 😀' };

function codexSuccess(record) {
  record.onEnd = () => {
    record.send({ type: 'thread.started', thread_id: 'fixture' });
    record.send({ type: 'item.completed', item: { id: 'fixture-item', type: 'agent_message', text: JSON.stringify(output) } }, 1);
    record.send({ type: 'turn.completed', usage: {} });
    record.close();
  };
}

test('AI init and status never start CLIs; device preferences are atomic and defensive', async t => {
  const f = await setup(t);
  assert.deepEqual(f.runtime.settings(), DEFAULT_SETTINGS);
  assert.equal(f.fake.calls.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'ai')), []);
  const next = { ...DEFAULT_SETTINGS, provider: 'claude', model: 'model-fixture', agent: 'revisor', effort: 'high' };
  const result = await f.runtime.configure(next);
  result.args.push('outside');
  assert.deepEqual(f.runtime.settings(), next);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'ai', 'settings.json'), 'utf8')), next);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'ai')), ['settings.json']);
  const restored = new AiRuntime({ dataDir: f.directory, testing: true });
  await restored.init();
  assert.deepEqual(restored.settings(), next);
  await restored.close();
});

test('corrupt preferences remain byte-for-byte preserved and block all writes', async t => {
  const f = await setup(t);
  const filename = path.join(f.directory, 'ai', 'settings.json');
  const corrupt = '{"provider":';
  await fs.writeFile(filename, corrupt);
  const runtime = new AiRuntime({ dataDir: f.directory, testing: true, spawnImpl: f.fake.spawnImpl });
  await runtime.init();
  assert.match(runtime.status().lastError, /preservadas/u);
  await assert.rejects(runtime.configure(DEFAULT_SETTINGS), /preservadas/u);
  await assert.rejects(runtime.run(request), /preservadas/u);
  assert.equal(await fs.readFile(filename, 'utf8'), corrupt);
  assert.equal(f.fake.calls.length, 0);
  await runtime.close();
});

test('preference validation rejects secrets, shells, native extra arguments and unsupported options', async t => {
  const f = await setup(t);
  for (const settings of [
    { apiKey: 'fixture-private' },
    { provider: 'unknown' },
    { command: 'codex.cmd' },
    { command: 'powershell.exe' },
    { args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { provider: 'acp', args: ['--api-key', 'fixture-private'] },
    { provider: 'acp', args: ['--token=fixture-private'] },
    { provider: 'acp', args: ['{"apiKey":"fixture-private"}'] },
    { provider: 'acp', args: ['bearer fixture-private'] },
    { provider: 'acp', args: ['a\nb'] },
    { provider: 'codex', agent: 'invented-agent' },
    { provider: 'claude', effort: 'ultra' },
    { model: '--dangerously-bypass-approvals-and-sandbox' },
    { model: 'bad\nmodel' }
  ]) await assert.rejects(f.runtime.configure(settings));
  assert.equal(f.fake.calls.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'ai')), []);
});

test('test mode refuses real subprocesses, even explicit discover or configured commands', async t => {
  const f = await setup(t, () => {}, { spawnImpl: undefined });
  await assert.rejects(f.runtime.discover(), { code: 'AI_TEST_ONLY' });
  await assert.rejects(f.runtime.run(request), { code: 'AI_TEST_ONLY' });
});

test('Codex uses isolated read-only ephemeral execution, stdin and fragmented UTF-8 JSONL', async t => {
  const f = await setup(t, codexSuccess);
  await f.runtime.configure({ provider: 'codex', effort: 'high', model: 'fixture-model' });
  const localEvents = [];
  const result = await f.runtime.run({ ...request, onEvent: event => localEvents.push(event) });
  assert.deepEqual(result, { text: JSON.stringify(output), provider: 'codex' });
  const call = f.fake.calls[0];
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.notEqual(call.options.cwd, f.directory); assert.match(path.basename(call.options.cwd), /^notes-ai-/u);
  assert.deepEqual(call.args.slice(0, 2), ['exec', '--json']);
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', '--output-schema']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  for (const feature of ['shell_tool', 'hooks', 'apps', 'multi_agent', 'code_mode']) assert.equal(call.args[call.args.indexOf(feature) - 1], '--disable');
  assert.ok(call.args.includes('web_search="disabled"'));
  assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'fixture-model');
  assert.equal(call.args.at(-1), '-');
  assert.equal(call.args.some(arg => arg.includes(request.prompt)), false);
  assert.match(call.input, /Crie uma nota sintética/u);
  assert.match(call.input, /CONTEXTO \(DADOS\)/u);
  await assert.rejects(fs.stat(call.options.cwd), { code: 'ENOENT' });
  assert.deepEqual(localEvents, f.events);
  assert.equal(localEvents.at(-1).type, 'done');
  assert.equal(localEvents.find(event => event.type === 'delta').text, JSON.stringify(output));
  assert.equal(f.runtime.status().running, false);
});

test('Claude forbids tools and MCP, accepts selected model/agent/effort and structured result', async t => {
  const f = await setup(t, record => { record.onEnd = () => {
    record.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Progresso sintético' } } });
    record.send({ type: 'result', subtype: 'success', is_error: false, structured_output: output, result: 'ignore plain text when structured output exists' });
    record.close();
  }; });
  await f.runtime.configure({ provider: 'claude', model: 'fixture-model', agent: 'reviewer', effort: 'high' });
  assert.deepEqual(await f.runtime.run(request), { text: JSON.stringify(output), provider: 'claude' });
  const { args } = f.fake.calls[0];
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--agent') + 1], 'reviewer');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), request.schema);
});

test('CLI nonzero, turn failures, incomplete and malformed output fail without echoing private stderr', async t => {
  const variants = [
    record => { record.child.stderr.write('fixture-private-token=secret'); record.close(2); },
    record => { record.send({ type: 'turn.failed', error: { message: 'fixture-private-content' } }); record.close(); },
    record => { record.send({ type: 'turn.completed' }); record.close(); },
    record => { record.child.stdout.write('plain non-json output\n'); },
    record => { record.child.stdout.write('[1,2,3]\n'); }
  ];
  for (const variant of variants) {
    const f = await setup(t, record => { record.onEnd = () => variant(record); });
    await assert.rejects(f.runtime.run(request), cause => { assert.doesNotMatch(cause.message, /fixture-private/u); return true; });
    assert.doesNotMatch(JSON.stringify(f.events), /fixture-private/u);
    assert.equal(f.runtime.status().running, false);
    await assert.rejects(fs.stat(f.fake.calls[0].options.cwd), { code: 'ENOENT' });
  }
});

test('concurrency, cancellation and timeout affect only the owned child and clean its cwd', async t => {
  const f = await setup(t);
  const running = f.runtime.run(request);
  const rejected = assert.rejects(running, { code: 'ABORT_ERR' });
  while (!f.fake.calls.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.status().running, true);
  await assert.rejects(f.runtime.run(request), { code: 'AI_BUSY' });
  await assert.rejects(f.runtime.configure(DEFAULT_SETTINGS), /Aguarde/u);
  assert.deepEqual(await f.runtime.cancel(), { cancelled: true });
  await rejected;
  assert.equal(f.fake.calls.length, 1); assert.equal(f.fake.calls[0].killed, true);
  await assert.rejects(fs.stat(f.fake.calls[0].options.cwd), { code: 'ENOENT' });
  const timed = await setup(t, () => {}, { timeoutMs: 25 });
  await assert.rejects(timed.runtime.run(request), { code: 'AI_TIMEOUT' });
  assert.equal(timed.fake.calls[0].killed, true);
});

test('AbortSignal and close cancel pending execution; aborted input never spawns', async t => {
  const f = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.run({ ...request, signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(f.fake.calls.length, 0);
  const running = f.runtime.run(request), rejected = assert.rejects(running, { code: 'ABORT_ERR' });
  while (!f.fake.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.close(); await rejected;
  assert.equal(f.runtime.status().running, false);
  await assert.rejects(f.runtime.run(request), /encerrada/u);
});

test('stdout/stderr bounds and oversized context reject without retaining request data', async t => {
  for (const target of ['stdout', 'stderr']) {
    const f = await setup(t, record => { record.onEnd = () => record.child[target].write('x'.repeat(300)); }, { maxOutputBytes: 100 });
    await assert.rejects(f.runtime.run(request), { code: 'AI_OUTPUT_LIMIT' });
    assert.equal(f.fake.calls[0].killed, true);
  }
  const f = await setup(t);
  await assert.rejects(f.runtime.run({ ...request, context: 'x'.repeat(4 * 1024 * 1024) }), /grande demais/u);
  assert.equal(f.fake.calls.length, 0);
});

test('ACP discovery inspects only the selected agent and preserves other provider descriptors', async t => {
  const f = await setup(t, record => {
    if (record.args[0] === '--version') setImmediate(() => { record.child.stdout.write('provider-cli 1.2.3\n'); record.close(); });
    else acpHandler()(record);
  });
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe') });
  const result = await f.runtime.discover();
  assert.equal(result.providers.length, 3);
  assert.ok(result.providers.every(provider => provider.available));
  assert.equal(f.fake.calls.length, 1);
  const acp = f.fake.calls[0];
  assert.deepEqual(acp.messages.map(item => item.method), ['initialize', 'session/new']);
  assert.equal(acp.killed, true);
  await assert.rejects(fs.stat(acp.options.cwd), { code: 'ENOENT' });
  assert.equal(result.providers.find(item => item.id === 'acp').version, '');
  assert.deepEqual(result.providers.find(item => item.id === 'acp').efforts, ['default', 'low', 'high']);
  assert.deepEqual(result.providers.find(item => item.id === 'acp').agents.map(item => item.value), ['', 'ask', 'writer']);
  assert.equal(result.providers.find(item => item.id === 'codex').version, '');
  result.providers[0].efforts.push('outside');
  assert.equal(f.runtime.status().providers[0].efforts.includes('outside'), false);
});

test('close cancels a version discovery and does not start further CLIs', async t => {
  const f = await setup(t);
  const discovery = f.runtime.discover(), rejected = assert.rejects(discovery, { code: 'ABORT_ERR' });
  while (!f.fake.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.close(); await rejected;
  assert.equal(f.fake.calls.length, 1);
  assert.equal(f.fake.calls[0].killed, true);
});

function metadataHandler(options = {}) {
  return record => {
    if (record.args[0] === '--version') {
      setImmediate(() => { record.child.stdout.write('provider-cli 1.2.3\n'); record.close(); });
      return;
    }
    if (record.args[0] === 'app-server') {
      record.onMessage = message => {
        if (!message.method) return;
        const respond = result => record.send({ id: message.id, result }, 1);
        if (message.method === 'initialize') {
          assert.equal(message.params.clientInfo.name, 'notes');
          assert.equal(message.params.capabilities.explicitGatewayOauth, true);
          respond({ userAgent: 'fixture', codexHome: 'fixture-private-path', platformFamily: 'windows', platformOs: 'windows' });
        } else if (message.method === 'model/list') {
          assert.equal(record.messages[1].method, 'initialized');
          assert.equal(message.params.includeHidden, false);
          if (options.onCodexList?.(record, message)) return;
          const page = options.pages?.find(item => (item.cursor || undefined) === message.params.cursor);
          respond(page?.result || { data: [{ id: 'row-fixture', model: 'fixture-model', displayName: 'Modelo sintético', description: 'Catálogo sintético', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null });
        } else assert.equal(message.method, 'initialized', 'model discovery must not open threads, turns or login');
      };
      return;
    }
    if (record.args.includes('--input-format')) {
      record.onMessage = message => {
        assert.equal(message.type, 'control_request');
        assert.equal(message.request.subtype, 'initialize');
        assert.deepEqual(message.request.hooks, {});
        assert.deepEqual(message.request.sdkMcpServers, []);
        if (options.onClaudeInitialize?.(record, message)) return;
        record.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
          account: { email: 'fixture-private-email', token: 'fixture-private-token' },
          models: [
            { value: 'default', displayName: 'Padrão sintético', description: 'Padrão do CLI', supportedEffortLevels: ['low', 'high'] },
            { value: 'fixture-claude[1m]', displayName: 'Claude sintético', description: 'Catálogo local sintético', supportsEffort: false }
          ]
        } } }, 2);
      };
      return;
    }
    acpHandler(options.acp)(record);
  };
}

test('Codex metadata discovery paginates live models and capabilities without opening a thread', async t => {
  const f = await setup(t, metadataHandler({ pages: [
    { result: { data: [
      { id: 'different-row-id', model: 'fixture-fast', displayName: 'Rápido 😀', description: 'Descrição sintética', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], isDefault: true },
      { model: 'fixture-hidden', hidden: true }
    ], nextCursor: 'page-two' } },
    { cursor: 'page-two', result: { data: [
      { model: 'fixture-deep', displayName: 'Profundo', defaultReasoningEffort: 'custom-effort', supportedReasoningEfforts: [{ reasoningEffort: 'custom-effort' }], isDefault: false },
      { model: 'fixture-fast', displayName: 'Duplicate ignored' }
    ], nextCursor: null } }
  ] }));
  const result = await f.runtime.discover();
  const provider = result.providers.find(item => item.id === 'codex');
  assert.equal(provider.modelsSource, 'codex-app-server');
  assert.deepEqual(provider.models, [
    { value: 'fixture-fast', label: 'Rápido 😀', supportedEfforts: ['low', 'high'], isDefault: true, description: 'Descrição sintética', defaultEffort: 'low' },
    { value: 'fixture-deep', label: 'Profundo', supportedEfforts: ['custom-effort'], isDefault: false, defaultEffort: 'custom-effort' }
  ]);
  assert.deepEqual(provider.efforts, ['default', 'low', 'high', 'custom-effort']);
  assert.equal(provider.modelWarning, undefined);
  assert.equal(f.fake.calls.length, 2);
  const server = f.fake.calls[1];
  assert.deepEqual(server.messages.map(item => item.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(server.messages.at(-1).params.cursor, 'page-two');
  for (const flag of ['model_provider="openai"', 'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"', 'mcp_servers={}']) assert.ok(server.args.includes(flag));
  for (const feature of ['hooks', 'apps', 'shell_tool', 'multi_agent', 'code_mode']) assert.equal(server.args[server.args.indexOf(feature) - 1], '--disable');
  assert.equal(server.options.shell, false); assert.equal(server.options.windowsHide, true);
  assert.equal(server.killed, true);
  await assert.rejects(fs.stat(server.options.cwd), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/u);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'ai')), []);
  await f.runtime.configure({ model: 'fixture-deep', effort: 'custom-effort' });
});

test('Claude metadata uses the SDK initialize response and never sends a user message', async t => {
  const f = await setup(t, metadataHandler());
  const draft = { provider: 'claude', command: path.join(f.bin, 'claude.exe'), model: 'fixture-claude[1m]' };
  const result = await f.runtime.discover(draft);
  const provider = result.providers.find(item => item.id === 'claude');
  assert.equal(provider.modelsSource, 'claude-cli');
  assert.deepEqual(provider.models, [
    { value: 'default', label: 'Padrão sintético', isDefault: true, description: 'Padrão do CLI', supportedEfforts: ['low', 'high'] },
    { value: 'fixture-claude[1m]', label: 'Claude sintético', isDefault: false, description: 'Catálogo local sintético', supportedEfforts: [] }
  ]);
  const process = f.fake.calls[1];
  assert.equal(process.messages.length, 1);
  assert.equal(process.messages[0].type, 'control_request');
  assert.equal(process.args[process.args.indexOf('--tools') + 1], '');
  assert.equal(process.args[process.args.indexOf('--setting-sources') + 1], '');
  assert.equal(process.args[process.args.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.equal(process.args[process.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(process.killed, true);
  assert.deepEqual(f.runtime.settings(), DEFAULT_SETTINGS);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'ai')), []);
  assert.doesNotMatch(JSON.stringify(f.runtime.status()), /fixture-private/u);
  await f.runtime.configure(draft);
  assert.deepEqual(f.runtime.status().providers.find(item => item.id === 'claude').models, provider.models, 'saving a discovered draft must preserve its catalogue');
});

test('metadata failure preserves prior provider catalogues and exposes explicit Claude aliases fallback', async t => {
  let fail = false;
  const f = await setup(t, metadataHandler({ onCodexList(record, message) {
    if (!fail) return false;
    record.send({ id: message.id, error: { code: -32000, message: 'fixture-private-error' } });
    return true;
  }, onClaudeInitialize(record, message) {
    record.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'fixture-private-error' } });
    return true;
  } }));
  const initial = await f.runtime.discover();
  fail = true;
  const failed = await f.runtime.discover();
  const prior = initial.providers.find(item => item.id === 'codex'), preserved = failed.providers.find(item => item.id === 'codex');
  assert.deepEqual(preserved.models, prior.models);
  assert.equal(preserved.modelsSource, 'codex-app-server');
  assert.match(preserved.modelWarning, /anterior foi preservado/u);
  const claude = (await f.runtime.discover({ provider: 'claude' })).providers.find(item => item.id === 'claude');
  assert.equal(claude.modelsSource, 'provider-aliases');
  assert.deepEqual(claude.models.map(item => item.value), ['', 'sonnet', 'opus', 'haiku']);
  assert.match(claude.modelWarning, /aliases oficiais/u);
  assert.deepEqual(f.runtime.status().providers.find(item => item.id === 'codex').models, prior.models);
  assert.doesNotMatch(JSON.stringify(f.runtime.status()), /fixture-private/u);
});

test('discovery accepts an unsaved ACP draft without changing persisted preferences', async t => {
  const f = await setup(t, metadataHandler({ acp: { customEffort: 'thinking(32k)' } }));
  await f.runtime.configure(DEFAULT_SETTINGS);
  const bytes = await fs.readFile(path.join(f.directory, 'ai', 'settings.json'));
  const draft = { provider: 'acp', command: path.join(f.bin, 'agent.exe'), args: ['--stdio-fixture'], model: 'fixture-model', effort: 'obsolete-value' };
  const result = await f.runtime.discover(draft);
  const provider = result.providers.find(item => item.id === 'acp');
  assert.equal(provider.modelsSource, 'acp');
  assert.deepEqual(provider.models, [{ value: 'fixture-model', label: 'Fixture', supportedEfforts: ['low', 'thinking(32k)'], defaultEffort: 'low' }]);
  assert.deepEqual(f.fake.calls[0].args, ['--stdio-fixture']);
  assert.deepEqual(f.fake.calls[0].messages.map(item => item.method), ['initialize', 'session/new', 'session/set_config_option']);
  assert.equal(f.fake.calls[0].messages.at(-1).params.configId, 'model');
  assert.deepEqual(f.runtime.settings(), DEFAULT_SETTINGS);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'ai', 'settings.json')), bytes);
  const calls = f.fake.calls.length;
  await assert.rejects(f.runtime.discover({ provider: 'acp', args: ['--api-key', 'fixture'] }));
  assert.equal(f.fake.calls.length, calls);
});

test('same discovery drafts share a request; different drafts are serialized and return their own catalogue', async t => {
  let held;
  const f = await setup(t, metadataHandler({ onCodexList(record, message) { held = { record, message }; return true; } }));
  const codexDraft = { provider: 'codex', model: 'fixture-model' };
  const first = f.runtime.discover(codexDraft);
  while (!held) await new Promise(resolve => setImmediate(resolve));
  const same = f.runtime.discover({ ...codexDraft });
  const next = f.runtime.discover({ provider: 'acp', command: path.join(f.bin, 'agent.exe'), model: 'fixture-model' });
  assert.equal(f.fake.calls.length, 2);
  held.record.send({ id: held.message.id, result: { data: [{ model: 'fixture-queued-model', displayName: 'Primeiro', supportedReasoningEfforts: [] }], nextCursor: null } });
  const [a, b, c] = await Promise.all([first, same, next]);
  assert.deepEqual(a, b);
  assert.equal(a.providers.find(item => item.id === 'codex').models[0].value, 'fixture-queued-model');
  assert.equal(c.providers.find(item => item.id === 'acp').models[0].value, 'fixture-model');
  assert.equal(c.providers.find(item => item.id === 'codex').models[0].value, 'fixture-queued-model');
  assert.equal(f.fake.calls.length, 3);
  assert.deepEqual(f.runtime.settings(), DEFAULT_SETTINGS);
});

test('Codex repeated pagination cursors fail closed without publishing a partial catalogue', async t => {
  const f = await setup(t, metadataHandler({ onCodexList(record, message) {
    record.send({ id: message.id, result: { data: [{ model: 'fixture-partial', displayName: 'Incomplete' }], nextCursor: 'repeat' } });
    return true;
  } }));
  const provider = (await f.runtime.discover()).providers.find(item => item.id === 'codex');
  assert.deepEqual(provider.models, []);
  assert.match(provider.modelWarning, /Não foi possível consultar/u);
  assert.equal(f.fake.calls[1].messages.filter(item => item.method === 'model/list').length, 2);
  assert.equal(f.fake.calls[1].killed, true);
});

test('Windows Explorer launch finds the conventional user-local Codex binary outside PATH', async t => {
  const f = await setup(t, codexSuccess);
  const local = path.join(f.directory, 'user', 'AppData', 'Local');
  const command = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  await fs.mkdir(path.dirname(command), { recursive: true }); await fs.writeFile(command, 'test-only');
  f.runtime.env = { USERPROFILE: path.join(f.directory, 'user'), LOCALAPPDATA: local };
  await f.runtime.run(request);
  assert.equal(f.fake.calls[0].command, command);
});

function acpHandler(options = {}) {
  return record => {
    let configOptions = [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'writer', name: 'Writer' }] },
      { id: 'model', category: 'model', type: 'select', currentValue: 'fixture-default', options: [{ group: 'group', name: 'Models', options: [{ value: 'fixture-model', name: 'Fixture' }] }] },
      { id: 'reasoning', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: options.customEffort || 'high', name: 'High' }] }
    ];
    record.onMessage = message => {
      if (!message.method) return;
      const respond = result => record.send({ jsonrpc: '2.0', id: message.id, result }, 3);
      if (message.method === 'initialize') {
        assert.deepEqual(message.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
        respond({ protocolVersion: options.version ?? 1, agentCapabilities: {} });
      } else if (message.method === 'session/new') {
        assert.deepEqual(message.params.mcpServers, []);
        assert.equal(message.params.cwd, record.options.cwd);
        respond({ sessionId: 'session-test', ...(options.legacy ? { modes: { currentModeId: 'ask', availableModes: [{ id: 'writer', name: 'Writer' }] } } : { configOptions: options.noOptions ? [] : configOptions }) });
      } else if (message.method === 'session/set_config_option') {
        const { configId, value } = message.params;
        configOptions = configOptions.map(item => item.id === configId ? { ...item, currentValue: options.ignoreConfig ? item.currentValue : value } : item);
        if(configId==='model'&&options.modelChangesEffort)configOptions=configOptions.map(item=>item.id==='reasoning'?{...item,currentValue:'balanced',options:[{value:'balanced',name:'Balanced'},{value:'deep',name:'Deep'}]}:item);
        respond({ configOptions });
      } else if (message.method === 'session/set_mode') respond({});
      else if (message.method === 'session/prompt') {
        options.onPrompt?.(record, message);
        if (options.wait) return;
        record.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'unrelated', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ignore unrelated session' } } } });
        record.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-test', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(output) } } } }, 1);
        respond({ stopReason: options.stopReason ?? 'end_turn' });
      }
    };
  };
}

test('ACP v1 negotiates announced grouped model, agent and effort options then streams JSON', async t => {
  const f = await setup(t, acpHandler());
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe'), args: ['--stdio'], model: 'fixture-model', agent: 'writer', effort: 'high' });
  assert.deepEqual(await f.runtime.run(request), { text: JSON.stringify(output), provider: 'acp' });
  const call = f.fake.calls[0];
  assert.deepEqual(call.args, ['--stdio']);
  assert.deepEqual(call.messages.filter(item => item.method === 'session/set_config_option').map(item => item.params), [
    { sessionId: 'session-test', configId: 'mode', value: 'writer' },
    { sessionId: 'session-test', configId: 'model', value: 'fixture-model' },
    { sessionId: 'session-test', configId: 'reasoning', value: 'high' }
  ]);
  assert.equal(call.messages.at(-1).method, 'session/prompt');
  assert.deepEqual(f.runtime.status().providers.find(item => item.id === 'acp').efforts, ['default', 'low', 'high']);
  assert.ok(call.killed, 'persistent ACP child is closed after the turn');
  await assert.rejects(fs.stat(call.options.cwd), { code: 'ENOENT' });
});
test('ACP discovery shows effort choices of the selected model without applying stale effort or prompting',async t=>{
  const f=await setup(t,record=>{
    if(record.args[0]==='--version')setImmediate(()=>{record.child.stdout.write('fixture 1.2.3\n');record.close();});
    else acpHandler({modelChangesEffort:true})(record);
  });
  await f.runtime.configure({provider:'acp',command:path.join(f.bin,'agent.exe'),model:'fixture-model',agent:'writer',effort:'high'});
  const result=await f.runtime.discover();assert.deepEqual(result.providers.find(p=>p.id==='acp').efforts,['default','balanced','deep']);
  const calls=f.fake.calls.at(-1).messages;assert.deepEqual(calls.filter(m=>m.method==='session/set_config_option').map(m=>m.params.configId),['mode','model']);assert.equal(calls.some(m=>m.method==='session/prompt'),false);
});

test('ACP denies permissions, filesystem and terminal requests instead of exposing host access', async t => {
  const f = await setup(t, acpHandler({ onPrompt(record) {
    for (const [id, method] of [[100, 'session/request_permission'], [101, 'fs/read_text_file'], [102, 'fs/write_text_file'], [103, 'terminal/create'], [104, 'untrusted/operation']]) record.send({ jsonrpc: '2.0', id, method, params: { path: 'never-read-this' } });
  } }));
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe') });
  await f.runtime.run(request);
  const responses = f.fake.calls[0].messages.filter(item => item.id >= 100);
  assert.equal(responses.length, 5);
  assert.deepEqual(responses[0].result, { outcome: { outcome: 'cancelled' } });
  for (const response of responses.slice(1)) assert.equal(response.error.code, -32601);
});

test('ACP rejects incompatible versions, unannounced or unconfirmed configuration and incomplete turns', async t => {
  const cases = [
    [{ version: 2 }, {}, 'AI_PROTOCOL_VERSION'],
    [{ noOptions: true }, { effort: 'high' }, 'AI_ACP_CONFIG'],
    [{}, { model: 'not-advertised' }, 'AI_ACP_CONFIG'],
    [{ ignoreConfig: true }, { agent: 'writer' }, 'AI_ACP_CONFIG'],
    [{ stopReason: 'max_tokens' }, {}, 'AI_EMPTY']
  ];
  for (const [behavior, settings, code] of cases) {
    const f = await setup(t, acpHandler(behavior));
    await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe'), ...settings });
    await assert.rejects(f.runtime.run(request), { code });
    assert.equal(f.fake.calls[0].killed, true);
  }
});

test('ACP legacy modes work only when no config options were advertised', async t => {
  const f = await setup(t, acpHandler({ legacy: true }));
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe'), agent: 'writer' });
  await f.runtime.run(request);
  assert.ok(f.fake.calls[0].messages.some(item => item.method === 'session/set_mode' && item.params.modeId === 'writer'));
});

test('ACP accepts opaque effort identifiers only when the actual agent announces them', async t => {
  const effort = 'thinking(32k):custom';
  const f = await setup(t, acpHandler({ customEffort: effort }));
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe'), effort });
  await f.runtime.run(request);
  assert.ok(f.fake.calls[0].messages.some(item => item.method === 'session/set_config_option' && item.params.configId === 'reasoning' && item.params.value === effort));
  assert.deepEqual(f.runtime.status().providers.find(item => item.id === 'acp').efforts, ['default', 'low', effort]);
});

test('ACP cancellation rejects pending RPC, terminates owned agent and removes isolated cwd', async t => {
  const f = await setup(t, acpHandler({ wait: true }));
  await f.runtime.configure({ provider: 'acp', command: path.join(f.bin, 'agent.exe') });
  const running = f.runtime.run(request), rejected = assert.rejects(running, { code: 'ABORT_ERR' });
  while (!f.fake.calls[0]?.messages.some(item => item.method === 'session/prompt')) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.cancel(); await rejected;
  assert.equal(f.fake.calls[0].killed, true);
  assert.ok(f.fake.calls[0].messages.some(item => item.method === 'session/cancel'));
  await assert.rejects(fs.stat(f.fake.calls[0].options.cwd), { code: 'ENOENT' });
});
