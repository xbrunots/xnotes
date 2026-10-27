'use strict';

/* Application-owned Google Desktop OAuth identity, never user credentials.
 * Priority: dev env ID/secret -> explicit absolute file -> local build identity
 * -> packaged app/google-client.json. Absent sources return undefined; an
 * existing/provided invalid source throws a sanitized error without its data.
 * The JSON produced by this loader contains only client_id/client_secret.
 * Runtime OAuth endpoints and user refresh tokens remain in drive-oauth.cjs.
 */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { configuration } = require('./drive-oauth.cjs');

const MAX_CLIENT_BYTES = 64 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const IDENTITY_FIELDS = new Set(['client_id', 'client_secret', 'clientId', 'clientSecret']);
const GOOGLE_EXPORT_FIELDS = new Set([...IDENTITY_FIELDS, 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'redirect_uris']);
const AUTH_URIS = new Set(['https://accounts.google.com/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/v2/auth']);

function invalid(source, reason = 'Use somente a identidade OAuth Desktop registrada do aplicativo.') {
  return Object.assign(new Error('Identidade Google do aplicativo inválida (' + source + '). ' + reason), { code: 'AUTH_CLIENT_CONFIGURATION', source });
}

function sanitize(input, source) {
  if (!plain(input) || own(input, 'web')) throw invalid(source);
  const installed = own(input, 'installed');
  if (installed && (Object.keys(input).length !== 1 || !plain(input.installed))) throw invalid(source);
  const candidate = installed ? input.installed : input;
  const allowed = installed ? GOOGLE_EXPORT_FIELDS : IDENTITY_FIELDS;
  // Explicitly reject credential exports (tokens, service accounts, email,
  // account selectors, etc.) instead of silently accepting and stripping them.
  if (Object.keys(candidate).some(key => !allowed.has(key))) throw invalid(source);
  if (own(candidate, 'auth_uri') && !AUTH_URIS.has(candidate.auth_uri)) throw invalid(source, 'O endpoint de autorização deve ser o oficial do Google.');
  if (own(candidate, 'token_uri') && candidate.token_uri !== 'https://oauth2.googleapis.com/token') throw invalid(source, 'O endpoint de token deve ser o oficial do Google.');
  if (own(candidate, 'auth_provider_x509_cert_url') && candidate.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs') throw invalid(source);
  if (own(candidate, 'project_id') && typeof candidate.project_id !== 'string') throw invalid(source);
  if (own(candidate, 'redirect_uris')) {
    if (!Array.isArray(candidate.redirect_uris) || candidate.redirect_uris.some(value => {
      try {
        const url = new URL(value);
        return url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !!url.username || !!url.password || !!url.search || !!url.hash;
      } catch { return true; }
    })) throw invalid(source, 'O cliente Desktop deve permitir retorno local de autenticação.');
  }
  // Ambiguous aliases must not select a different identity by truthiness.
  if ((own(candidate, 'client_id') && own(candidate, 'clientId') && candidate.client_id !== candidate.clientId)
    || (own(candidate, 'client_secret') && own(candidate, 'clientSecret') && candidate.client_secret !== candidate.clientSecret)) throw invalid(source);
  try { return configuration(input); }
  catch { throw invalid(source); }
}

async function noSymlinks(filename, source) {
  // Includes parent junctions on Windows. Never follow a build identity through
  // a link to an unrelated credential file. Electron's patched fs also handles
  // regular paths inside app.asar; no directory-only check is made here.
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw invalid(source, 'Links simbólicos ou junções não são aceitos como fonte da identidade.');
  }
}

async function fromFile(filename, source, required) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw invalid(source, 'O arquivo configurado deve usar um caminho absoluto.');
  let bytes, handle;
  try {
    await noSymlinks(filename, source);
    const stat = await fs.lstat(filename);
    if (!stat.isFile()) throw invalid(source, 'A fonte deve ser um arquivo regular.');
    if (stat.size > MAX_CLIENT_BYTES) throw invalid(source, 'O arquivo de identidade excede 64 KiB.');
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw invalid(source, 'A fonte deve ser um arquivo regular.');
    if (opened.size > MAX_CLIENT_BYTES) throw invalid(source, 'O arquivo de identidade excede 64 KiB.');
    // Bound the read itself as well as stat: a source that grows or is replaced
    // during the read must not allocate an unbounded credential file in memory.
    const buffer = Buffer.alloc(MAX_CLIENT_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_CLIENT_BYTES) throw invalid(source, 'O arquivo de identidade excede 64 KiB.');
    bytes = buffer.subarray(0, count);
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return undefined;
    if (error.code === 'AUTH_CLIENT_CONFIGURATION') throw error;
    throw invalid(source, 'Não foi possível ler o arquivo de identidade fornecido.');
  } finally { if (handle) await handle.close(); }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(source, 'O arquivo de identidade deve conter JSON UTF-8 válido.'); }
  return sanitize(input, source);
}

async function loadDesktopClient({ appRoot = path.resolve(__dirname, '..'), env = process.env } = {}) {
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) throw new TypeError('appRoot deve ser absoluto.');
  if (!env || typeof env !== 'object') throw new TypeError('env deve ser um objeto de configuração.');
  const idProvided = env.NOTES_GOOGLE_CLIENT_ID !== undefined, secretProvided = env.NOTES_GOOGLE_CLIENT_SECRET !== undefined;
  if (idProvided || secretProvided) {
    if (!idProvided || typeof env.NOTES_GOOGLE_CLIENT_ID !== 'string' || (secretProvided && typeof env.NOTES_GOOGLE_CLIENT_SECRET !== 'string')) throw invalid('environment');
    return sanitize({ client_id: env.NOTES_GOOGLE_CLIENT_ID, ...(secretProvided ? { client_secret: env.NOTES_GOOGLE_CLIENT_SECRET } : {}) }, 'environment');
  }
  if (env.NOTES_GOOGLE_CLIENT_FILE !== undefined) return fromFile(env.NOTES_GOOGLE_CLIENT_FILE, 'explicit-file', true);
  const local = await fromFile(path.join(appRoot, 'build', 'google-oauth.local.json'), 'local-build', false);
  if (local) return local;
  return fromFile(path.join(appRoot, 'app', 'google-client.json'), 'packaged', false);
}

module.exports = { loadDesktopClient };
