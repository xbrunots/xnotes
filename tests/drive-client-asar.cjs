'use strict';

// Isolated packaging probe. Synthetic identities exist only in temporary ASAR
// files and are never copied to app/, release/, or the delivered portable.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createPackage } = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const FIXTURE_ID = 'asar-probe-fixture.apps.googleusercontent.com';
const FIXTURE_SECRET = 'asar-probe-desktop-identity-only';
const FIXTURE_TOKEN = 'ASAR_PROBE_PRIVATE_TOKEN_MUST_NOT_LEAK';

const probeSource = `
'use strict';
const {app} = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const {loadDesktopClient} = require('./desktop/drive-client.cjs');
app.disableHardwareAcceleration();
app.setName('notes-drive-client-probe');
app.setPath('userData', process.env.NOTES_PROBE_USER_DATA);
const mode = process.env.NOTES_PROBE_MODE;
const finish = (value, code) => process.stdout.write(JSON.stringify(value)+'\\n', () => app.exit(code));
app.whenReady().then(async () => {
  // Matches main's path.join(__dirname, '..') from its desktop/ directory.
  const appRoot = path.join(__dirname, 'desktop', '..');
  assert(appRoot.endsWith('.asar'));
  assert.equal(app.getAppPath(), appRoot);
  if (mode === 'available') {
    const config = await loadDesktopClient({appRoot, env:{}});
    assert.deepEqual(config, {client_id:${JSON.stringify(FIXTURE_ID)},client_secret:${JSON.stringify(FIXTURE_SECRET)}});
    finish({mode,ok:true,asar:true,fields:Object.keys(config).sort()}, 0);
  } else if (mode === 'absent') {
    assert.equal(await loadDesktopClient({appRoot,env:{}}), undefined);
    finish({mode,ok:true,asar:true,configured:false}, 0);
  } else {
    let rejected = false;
    try { await loadDesktopClient({appRoot,env:{}}); }
    catch(error) {
      rejected = error.code === 'AUTH_CLIENT_CONFIGURATION';
      assert(!String(error.message).includes(${JSON.stringify(FIXTURE_TOKEN)}));
      assert(!String(error.message).includes(${JSON.stringify(FIXTURE_ID)}));
      assert(!String(error.message).includes(${JSON.stringify(FIXTURE_SECRET)}));
    }
    assert(rejected);
    finish({mode,ok:true,asar:true,credentialsRejected:true}, 0);
  }
}).catch(error => finish({mode,ok:false,code:typeof error.code==='string'?error.code:'PROBE_FAILURE'}, 1));
`;

async function launch(archive, mode, directory) {
  const env = { ...process.env, NOTES_TEST: '1', NOTES_PROBE_MODE: mode, NOTES_PROBE_USER_DATA: path.join(directory, 'user-data-' + mode) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NOTES_GOOGLE_CLIENT_ID;
  delete env.NOTES_GOOGLE_CLIENT_SECRET;
  delete env.NOTES_GOOGLE_CLIENT_FILE;
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [archive, '--disable-gpu'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('O probe Electron excedeu o tempo permitido.')); }, 30000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Não foi possível iniciar o Electron de teste.')); });
    child.on('exit', code => {
      clearTimeout(timer);
      const combined = stdout + stderr;
      assert(![FIXTURE_ID, FIXTURE_SECRET, FIXTURE_TOKEN].some(value => combined.includes(value)), 'O processo não pode imprimir identidade ou credenciais.');
      // Report only the sanitized probe result, never Electron stderr or the
      // fixture configuration if a lower layer fails.
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('{'));
      let result;
      try { result = JSON.parse(line); } catch { reject(new Error('O probe Electron não retornou resultado estruturado.')); return; }
      if (code !== 0 || !result.ok) { reject(new Error('O probe Electron falhou: ' + (result.code || 'PROBE_FAILURE'))); return; }
      resolve(result);
    });
  });
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-asar-probe-'));
  try {
    const results = [];
    for (const mode of ['available', 'absent', 'token-rejected']) {
      const source = path.join(directory, 'source-' + mode);
      await fs.mkdir(path.join(source, 'desktop'), { recursive: true });
      for (const name of ['drive-client.cjs', 'drive-oauth.cjs', 'drive-api.cjs']) await fs.copyFile(path.join(root, 'desktop', name), path.join(source, 'desktop', name));
      await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'notes-drive-client-probe', version: '0.0.0', main: 'probe.cjs' }));
      await fs.writeFile(path.join(source, 'probe.cjs'), probeSource);
      if (mode !== 'absent') {
        await fs.mkdir(path.join(source, 'app'));
        await fs.writeFile(path.join(source, 'app', 'google-client.json'), JSON.stringify({ client_id: FIXTURE_ID, client_secret: FIXTURE_SECRET,
          ...(mode === 'token-rejected' ? { refresh_token: FIXTURE_TOKEN } : {}) }));
      }
      const archive = path.join(directory, mode + '.asar');
      await createPackage(source, archive);
      results.push(await launch(archive, mode, directory));
    }
    console.log(JSON.stringify({ ok: true, electronAsar: true, cases: results }));
    return results;
  } finally {
    // Verify the explicit temporary target before Windows recursive cleanup.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('notes-asar-probe-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
