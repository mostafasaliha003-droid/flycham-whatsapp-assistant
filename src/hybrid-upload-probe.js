'use strict';

// Standalone, opt-in synthetic probe; not connected to the application, MOFA,
// or any applicant data. The live URL is a bearer secret and must only be
// delivered to an authenticated recipient over a private transport.
const HOSTS = Object.freeze({lon: 'production-lon.browserless.io', ams: 'production-ams.browserless.io', sfo: 'production-sfo.browserless.io'});
const MAX_SESSION_MS = 120000;
const DEFAULT_LINK_MS = 90000;
const CLEANUP_MS = 3000;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; form-action 'none'; base-uri 'none'"><title>Private synthetic upload test</title></head><body><p>اختبار اتصال فقط. اختر تم للمتابعة.</p><input id="synthetic-upload" type="file" accept="image/png"></body></html>`;
const ENDINGS = new Set(['userDone', 'userFailed', 'timeout', 'closed', 'viewerDisconnected']);

function invalid(code) { return Object.assign(new Error(code), {code}); }
function allowedLiveURL(value, host) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === host && (!u.port || u.port === '443') &&
      !u.username && !u.password && !u.hash && /^\/e\/[A-Za-z0-9_-]+\/live\//.test(u.pathname);
  } catch { return false; }
}
function deadlineSignal(ms, parent) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort(); else parent?.addEventListener('abort', onAbort, {once:true});
  const timer = setTimeout(onAbort, ms);
  return {signal: controller.signal, dispose() {clearTimeout(timer); parent?.removeEventListener('abort', onAbort);}};
}
function bounded(value, signal) {
  if (signal.aborted) return Promise.reject(invalid('TIMEOUT'));
  return new Promise((resolve, reject) => {
    const abort = () => {signal.removeEventListener('abort', abort); reject(invalid('TIMEOUT'));};
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(value).then(v => {signal.removeEventListener('abort', abort); resolve(v);},
      e => {signal.removeEventListener('abort', abort); reject(e);});
  });
}
async function closeBounded(browser, ms = CLEANUP_MS) {
  if (!browser || typeof browser.close !== 'function') return false;
  const scope = deadlineSignal(ms);
  try { await bounded(Promise.resolve().then(() => browser.close()), scope.signal); return true; }
  catch { return false; } finally {scope.dispose();}
}
async function defaultConnect(url, options) {return require('playwright').chromium.connectOverCDP(url, options);}

/**
 * Synthetic only. The injected `deliverPrivateLink` must perform secure,
 * authenticated one-time delivery; this module cannot implement or verify it.
 * Returns fixed status flags only. Never returns credentials, live URL, DOM,
 * customer records, a screenshot or provider errors.
 */
async function runSyntheticHybridProbe({enabled = false, token, region = 'lon', deliverPrivateLink, connect = defaultConnect,
  signal, workMs = 110000, linkMs = DEFAULT_LINK_MS, cleanupMs = CLEANUP_MS} = {}) {
  const result = {tested:false, attached:false, handoffCompleted:false, cleanupConfirmed:false, reason:'DISABLED'};
  if (enabled !== true) return result;
  const host = HOSTS[region];
  if (!host || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      typeof deliverPrivateLink !== 'function' || typeof connect !== 'function' ||
      !Number.isSafeInteger(workMs) || workMs < 1 || workMs > MAX_SESSION_MS ||
      !Number.isSafeInteger(linkMs) || linkMs < 1 || linkMs >= workMs ||
      !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5000 ||
      (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'))) return {...result, reason:'CONFIG_INVALID'};
  let browser, cdp, listener, complete, reason = 'PROBE_FAILED', attached = false, handoffCompleted = false;
  const scope = deadlineSignal(workMs, signal);
  try {
    if (scope.signal.aborted) throw invalid('TIMEOUT');
    const endpoint = new URL(`wss://${host}/`);
    endpoint.searchParams.set('token', token); endpoint.searchParams.set('timeout', String(MAX_SESSION_MS));
    // A connection resolving after a timeout still owns a remote browser; close
    // it as soon as it appears instead of leaving the session orphaned.
    const pending = Promise.resolve().then(() => {
      if (scope.signal.aborted) throw invalid('TIMEOUT');
      return connect(endpoint.href, {timeout: Math.min(15000, workMs)});
    });
    pending.then(value => {if(scope.signal.aborted) void closeBounded(value, cleanupMs);}, () => {});
    browser = await bounded(pending, scope.signal);
    const contexts = browser.contexts();
    if (!Array.isArray(contexts) || contexts.length !== 1) throw invalid('CONTEXT_INVALID');
    const context = contexts[0], page = await bounded(context.newPage(), scope.signal);
    if (page.url() !== 'about:blank') throw invalid('PAGE_INVALID');
    await bounded(page.route('**/*', route => route.abort()), scope.signal);
    await bounded(page.setContent(HTML, {waitUntil:'domcontentloaded'}), scope.signal);
    if (page.url() !== 'about:blank' || await bounded(page.locator('#synthetic-upload').count(), scope.signal) !== 1) throw invalid('PAGE_INVALID');
    cdp = await bounded(context.newCDPSession(page), scope.signal);
    const live = await bounded(cdp.send('Browserless.liveURL', {timeout:linkMs, instructions:'هذا اختبار اتصال فقط. اضغط Done للمتابعة.'}), scope.signal);
    if (!live || live.error || typeof live.liveURLId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(live.liveURLId) || !allowedLiveURL(live.liveURL, host)) throw invalid('LIVE_LINK_INVALID');
    complete = new Promise(resolve => {listener = event => {
      if (event && event.liveURLId === live.liveURLId && ENDINGS.has(event.reason)) resolve(event.reason);
    }; cdp.on('Browserless.liveComplete', listener);});
    // The callback is responsible for private single-recipient delivery.
    // Start the listener before delivering so a fast response cannot be lost.
    await bounded(Promise.resolve().then(() => deliverPrivateLink(live.liveURL)), scope.signal);
    const ending = await bounded(complete, scope.signal);
    if (ending !== 'userDone') throw invalid('HANDOFF_NOT_COMPLETED');
    handoffCompleted = true;
    if (page.url() !== 'about:blank') throw invalid('PAGE_INVALID');
    const input = page.locator('#synthetic-upload');
    await bounded(input.setInputFiles({name:'synthetic-test.png', mimeType:'image/png', buffer:PNG}), scope.signal);
    const metadata = await bounded(input.evaluate(el => Array.from(el.files || []).map(f => ({name:f.name, type:f.type, size:f.size}))), scope.signal);
    if (!Array.isArray(metadata) || metadata.length !== 1 || metadata[0].name !== 'synthetic-test.png' ||
        metadata[0].type !== 'image/png' || metadata[0].size !== PNG.length) throw invalid('UPLOAD_NOT_VERIFIED');
    attached = true; reason = 'SYNTHETIC_UPLOAD_VERIFIED';
  } catch (e) {
    const codes = new Set(['TIMEOUT','CONTEXT_INVALID','PAGE_INVALID','LIVE_LINK_INVALID','HANDOFF_NOT_COMPLETED','UPLOAD_NOT_VERIFIED']);
    reason = codes.has(e?.code) ? e.code : 'PROBE_FAILED';
  } finally {
    scope.dispose();
    if (cdp && listener) try {cdp.off('Browserless.liveComplete', listener);} catch {}
  }
  const cleanupConfirmed = await closeBounded(browser, cleanupMs);
  return {tested:Boolean(browser), attached, handoffCompleted, cleanupConfirmed,
    reason: browser && !cleanupConfirmed ? 'CLEANUP_UNCONFIRMED' : reason};
}
module.exports = {runSyntheticHybridProbe};
