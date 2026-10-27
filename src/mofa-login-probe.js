'use strict';

// Opt-in manual MOFA login probe: no applicant data or automatic form actions.
// The private link is a bearer secret, delivered only to an authenticated admin.
const HOSTS = Object.freeze({lon: 'production-lon.browserless.io', ams: 'production-ams.browserless.io', sfo: 'production-sfo.browserless.io'});
const MAX_SESSION_MS = 120000;
const DEFAULT_LINK_MS = 90000;
const CLEANUP_MS = 3000;
const MOFA_LOGIN_URL = 'https://visa.mofa.gov.sa/Account/Loginindividuals';
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
 * Manual-login pilot only. The injected `deliverPrivateLink` must perform secure,
 * authenticated one-time delivery; this module cannot implement or verify it.
 * Returns fixed status flags only. Never returns credentials, live URL, DOM,
 * customer records, a screenshot or provider errors.
 */
async function runMofaLoginProbe({enabled = false, token, region = 'lon', deliverPrivateLink, waitForContinuityCheck, connect = defaultConnect,
  signal, workMs = 110000, linkMs = DEFAULT_LINK_MS, cleanupMs = CLEANUP_MS} = {}) {
  const result = {tested:false, handoffCompleted:false, continuityVerified:false, authenticated:false, cleanupConfirmed:false, reason:'DISABLED'};
  if (enabled !== true) return result;
  const host = HOSTS[region];
  if (!host || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      typeof deliverPrivateLink !== 'function' || typeof waitForContinuityCheck !== 'function' || typeof connect !== 'function' ||
      !Number.isSafeInteger(workMs) || workMs < 1 || workMs > MAX_SESSION_MS ||
      !Number.isSafeInteger(linkMs) || linkMs < 1 || linkMs >= workMs ||
      !Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 5000 ||
      (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'))) return {...result, reason:'CONFIG_INVALID'};
  let browser, cdp, listener, complete, reason = 'PROBE_FAILED', handoffCompleted = false, continuityVerified = false;
  const scope = deadlineSignal(workMs, signal);
  try {
    if (scope.signal.aborted) throw invalid('TIMEOUT');
    const endpoint = new URL(`wss://${host}/`);
    endpoint.searchParams.set('token', token); endpoint.searchParams.set('timeout', String(MAX_SESSION_MS));
    endpoint.searchParams.set('record', 'false'); endpoint.searchParams.set('replay', 'false');
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
    // Open exactly the official login page. Do not read page content, solve a
    // CAPTCHA, type credentials or take any government action.
    await bounded(page.goto(MOFA_LOGIN_URL, {waitUntil:'domcontentloaded'}), scope.signal);
    const target = new URL(page.url());
    if (target.protocol !== 'https:' || target.hostname !== 'visa.mofa.gov.sa') throw invalid('PAGE_INVALID');
    cdp = await bounded(context.newCDPSession(page), scope.signal);
    const live = await bounded(cdp.send('Browserless.liveURL', {timeout:linkMs, instructions:'سجّل الدخول بنفسك وأدخل رمز التحقق الظاهر لك، ثم اضغط Done. لا تدخل مستندات أو تنشئ طلبًا.'}), scope.signal);
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
    // Hold this exact browser and page until an authenticated admin requests a
    // narrowly scoped continuity check. No DOM, network, CAPTCHA or login data.
    await bounded(Promise.resolve().then(() => waitForContinuityCheck()), scope.signal);
    const after = new URL(page.url());
    const pageAvailable = browser.isConnected() === true && page.isClosed() === false &&
      after.protocol === 'https:' && after.hostname === 'visa.mofa.gov.sa' &&
      context.pages().includes(page);
    if (pageAvailable) {
      // This harmless target-scoped CDP round trip verifies remote responsiveness;
      // do not inspect, persist, log or expose the returned layout measurements.
      await bounded(cdp.send('Page.getLayoutMetrics'), scope.signal);
      const finalTarget = new URL(page.url());
      continuityVerified = browser.isConnected() === true && page.isClosed() === false &&
        finalTarget.protocol === 'https:' && finalTarget.hostname === 'visa.mofa.gov.sa' &&
        context.pages().includes(page);
    }
    reason = continuityVerified ? 'CONTINUITY_VERIFIED_AUTH_UNVERIFIED' : 'CONTINUITY_UNAVAILABLE';
  } catch (e) {
    const codes = new Set(['TIMEOUT','CONTEXT_INVALID','PAGE_INVALID','LIVE_LINK_INVALID','HANDOFF_NOT_COMPLETED','UPLOAD_NOT_VERIFIED']);
    reason = codes.has(e?.code) ? e.code : 'PROBE_FAILED';
  } finally {
    scope.dispose();
    if (cdp && listener) try {cdp.off('Browserless.liveComplete', listener);} catch {}
  }
  const cleanupConfirmed = await closeBounded(browser, cleanupMs);
  return {tested:Boolean(browser), handoffCompleted, continuityVerified, authenticated:false, cleanupConfirmed,
    reason: browser && !cleanupConfirmed ? 'CLEANUP_UNCONFIRMED' : reason};
}
module.exports = {runMofaLoginProbe, MOFA_LOGIN_URL};
