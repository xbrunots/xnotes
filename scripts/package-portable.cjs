'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadDesktopClient } = require('../desktop/drive-client.cjs');

async function stageDesktopClient({ appRoot = path.resolve(__dirname, '..'), env = process.env } = {}) {
  // npm run dist builds the UI first. Stamp only this generated identity file
  // afterwards; renderer output and portable user data are never removed.
  const client = await loadDesktopClient({ appRoot, env });
  if (!client) return false;
  const directory = path.join(appRoot, 'app');
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A pasta gerada do aplicativo deve ser regular.');
  const target = path.join(directory, 'google-client.json');
  try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('O destino da identidade não pode ser um link.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o644);
    await handle.writeFile(JSON.stringify(client, null, 2) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, target);
  } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  return true;
}

async function run({ appRoot = path.resolve(__dirname, '..'), env = process.env } = {}) {
  console.log('Sincronização GitHub integrada; somente portable Windows x64.');
  const pkg = require('electron-builder/package.json');
  const builder = path.join(path.dirname(require.resolve('electron-builder/package.json')), pkg.bin['electron-builder']);
  // Only the portable target is allowed. Level 2 keeps local rebuilds practical;
  // the archive is still embedded in one self-contained Windows executable.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builder, '--win', 'portable', '--x64'], { cwd: appRoot, stdio: 'inherit', windowsHide: true,
      env: { ...env, ELECTRON_BUILDER_COMPRESSION_LEVEL: '2', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    child.on('error', () => reject(new Error('Não foi possível iniciar o empacotador portable.')));
    child.on('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('O empacotador portable não concluiu a compilação.')));
  });
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { stageDesktopClient, run };
