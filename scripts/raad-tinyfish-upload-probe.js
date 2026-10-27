'use strict';

// Manual synthetic capability probe only. Setup/cancel contract checked against:
// https://docs.tinyfish.ai/api-reference/browser-context-profiles/create-a-profile-setup-session
// https://docs.tinyfish.ai/api-reference/browser-context-profiles/cancel-a-profile-setup-session
// Omitting url is documented to start about:blank. This never saves a profile.
const {isIP} = require('node:net');
const ORIGIN = 'https://agent.tinyfish.ai';
const MAX_JSON_BYTES = 200 * 1024;
const DEFAULT_LIMITS = Object.freeze({apiMs: 15000, workMs: 60000, cleanupMs: 15000, disconnectMs: 2000});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVv0AAAAASUVORK5CYII=', 'base64');
const FILE_NAME = 'synthetic-upload-probe.png';
const HTML = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'"><title>Synthetic upload probe</title></head><body><input id="synthetic-upload" type="file" accept="image/png"></body></html>';
const profileValid = value => typeof value === 'string' && value.match(/^prof_[A-Za-z0-9_-]{1,120}$/)?.[0] === value;
const sessionValid = value => typeof value === 'string' && value.match(/^[A-Za-z0-9_-]{1,200}$/)?.[0] === value;
const problem = code => Object.assign(Error(code), {code});
function result(reason, testedThisRun = false, uploadVerified = false, cleanupConfirmed = false) {
  return {testedThisRun, uploadVerified, cleanupConfirmed, executionConnected: false, reason};
}
function bounded(promise, signal) {
  if (signal.aborted) return Promise.reject(problem('PROBE_TIMEOUT'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(problem('PROBE_TIMEOUT')); };
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function validCdpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value), host = url.hostname;
    return url.protocol === 'wss:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && !isIP(host.replace(/^\[|\]$/g, '')) && /^[a-z0-9.-]+$/.test(host) && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && ['tinyfish.ai', 'tinyfish.io'].some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return false; }
}
async function readJson(response) {
  if (!response?.ok || !response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw problem('PROVIDER_API_FAILED');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw problem('PROVIDER_API_FAILED');
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) throw problem('PROVIDER_API_FAILED');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_JSON_BYTES) throw problem('PROVIDER_API_FAILED');
    chunks.push(bytes);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw problem('PROVIDER_API_FAILED'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('PROVIDER_API_FAILED');
  return value;
}
async function providerJson(request, url, apiKey, body, timeoutMs, parentSignal, onLatePayload) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  parentSignal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(abort, timeoutMs);
  let finished = false;
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw problem('PROBE_TIMEOUT');
    return request(url, {method: 'POST', headers: {'X-API-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(body), redirect: 'error', signal: controller.signal});
  }).then(readJson);
  // Standard fetch honors abort. An injected/late successful response still gets
  // a best-effort fixed-endpoint cancellation, never further browser actions.
  pending.then(payload => { if (finished && controller.signal.aborted) onLatePayload?.(payload); }, () => {});
  try { return await bounded(pending, controller.signal); }
  finally { finished = true; clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); controller.abort(); }
}
async function defaultConnect(url, options) {
  return require('playwright').chromium.connectOverCDP(url, options);
}

async function runUploadProbe({env = {}, privateConfig = {}, request = global.fetch, connect = defaultConnect, limits = {}} = {}) {
  const apiKey = env.RAAD_TINYFISH_API_KEY;
  const profileId = env.RAAD_TINYFISH_PROFILE_ID || privateConfig.raad?.tinyfishProfileId;
  if (!apiKey || !profileId) return result('CONFIG_MISSING');
  if (!profileValid(profileId)) return result('PROFILE_ID_INVALID');
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey) || typeof request !== 'function' || typeof connect !== 'function') return result('CONFIG_INVALID');
  const time = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, maximum]) => [name, Number.isSafeInteger(limits[name]) && limits[name] > 0 ? Math.min(limits[name], maximum) : maximum]));
  const setupUrl = ORIGIN + '/v1/profiles/' + profileId + '/setup-session';
  const cancelUrl = setupUrl + '/cancel';
  const cancellations = new Map();
  function cancel(sessionId) {
    if (!sessionValid(sessionId)) return Promise.resolve(false);
    if (!cancellations.has(sessionId)) cancellations.set(sessionId, providerJson(request, cancelUrl, apiKey, {session_id: sessionId}, time.cleanupMs).then(payload => payload.cancelled === true && payload.cleanup_failed !== true, () => false));
    return cancellations.get(sessionId);
  }
  let sessionId = null, browser = null, uploadVerified = false, cleanupConfirmed = false, reason = 'SETUP_API_FAILED';
  const work = new AbortController(), timer = setTimeout(() => work.abort(), time.workMs);
  let finishCancellation;
  const cancellationFinished = new Promise(resolve => { finishCancellation = resolve; });
  async function disconnect(value) {
    if (!value || typeof value.close !== 'function') return;
    const controller = new AbortController(), closeTimer = setTimeout(() => controller.abort(), time.disconnectMs);
    try { await bounded(Promise.resolve().then(() => value.close()), controller.signal); } catch {} finally { clearTimeout(closeTimer); }
  }
  try {
    const payload = await providerJson(request, setupUrl, apiKey, {timeout_seconds: 120}, time.apiMs, work.signal, late => { if (sessionValid(late.session_id)) void cancel(late.session_id); });
    if (sessionValid(payload.session_id)) sessionId = payload.session_id;
    if (!sessionId || typeof payload.cdp_url !== 'string') throw problem('SETUP_RESPONSE_INVALID');
    if (!validCdpUrl(payload.cdp_url)) throw problem('CDP_URL_REJECTED');
    reason = 'BROWSER_CONNECT_FAILED';
    const connection = Promise.resolve().then(() => connect(payload.cdp_url, {timeout: Math.min(time.apiMs, time.workMs)}));
    connection.then(value => { if (work.signal.aborted) void cancellationFinished.then(() => disconnect(value)); }, () => {});
    browser = await bounded(connection, work.signal);
    const context = browser?.contexts?.()[0];
    if (!context || typeof context.newPage !== 'function') throw problem('BROWSER_CONTEXT_UNAVAILABLE');
    reason = 'UPLOAD_FAILED';
    const page = await bounded(Promise.resolve().then(() => context.newPage()), work.signal);
    if (page.url() !== 'about:blank') throw problem('PROBE_PAGE_NOT_BLANK');
    await bounded(Promise.resolve().then(() => page.route('**/*', route => route.abort())), work.signal);
    await bounded(Promise.resolve().then(() => page.setContent(HTML, {timeout: time.workMs, waitUntil: 'domcontentloaded'})), work.signal);
    if (page.url() !== 'about:blank') throw problem('PROBE_PAGE_NOT_BLANK');
    const input = page.locator('#synthetic-upload');
    await bounded(Promise.resolve().then(() => input.setInputFiles({name: FILE_NAME, mimeType: 'image/png', buffer: Buffer.from(PNG)}, {timeout: time.workMs})), work.signal);
    const metadata = await bounded(Promise.resolve().then(() => input.evaluate(element => Array.from(element.files || []).map(file => ({name: file.name, type: file.type, size: file.size})))), work.signal);
    uploadVerified = Array.isArray(metadata) && metadata.length === 1 && metadata[0]?.name === FILE_NAME && metadata[0]?.type === 'image/png' && metadata[0]?.size === PNG.length && PNG.length <= 1024;
    reason = uploadVerified ? 'UPLOAD_VERIFIED' : 'UPLOAD_MISMATCH';
  } catch (error) {
    const safe = ['PROBE_TIMEOUT', 'SETUP_RESPONSE_INVALID', 'CDP_URL_REJECTED', 'BROWSER_CONTEXT_UNAVAILABLE', 'PROBE_PAGE_NOT_BLANK'];
    if (safe.includes(error?.code)) reason = error.code;
  } finally {
    clearTimeout(timer);
    work.abort();
    if (sessionId) cleanupConfirmed = await cancel(sessionId);
    finishCancellation();
    await disconnect(browser);
  }
  if (uploadVerified && !cleanupConfirmed) reason = 'CLEANUP_UNCONFIRMED';
  return result(reason, true, uploadVerified, cleanupConfirmed);
}

if (require.main === module) {
  const main = async () => {
    if (process.argv.length !== 2) return result('ARGUMENTS_NOT_ALLOWED');
    const {loadVisaPrivateConfig} = require('../src/saudi-visa-private');
    return runUploadProbe({env: process.env, privateConfig: loadVisaPrivateConfig({env: process.env})});
  };
  main().catch(() => result('PROBE_FAILED')).then(value => {
    process.stdout.write(JSON.stringify(value) + '\n', () => process.exit(value.uploadVerified && value.cleanupConfirmed ? 0 : 1));
  });
}

module.exports = {runUploadProbe};
