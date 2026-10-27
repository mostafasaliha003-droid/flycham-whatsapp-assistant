'use strict';

// Synthetic prototype only. This module is not connected to server.js or the
// staff UI. Before wiring it, retain the same server-side Authorization gate;
// all existing admins share one key, so this does not identify one employee.
// Never put a Browserless token or live URL in logs, persistent storage or URLs.
const {randomBytes} = require('node:crypto');
const {validQueueKey} = require('./quote-jobs');
const {runSyntheticHybridProbe} = require('./hybrid-upload-probe');

const ROOT = '/internal/assistant/synthetic-hybrid';
const TTL_MS = 110000;
const RESULT_RETENTION_MS = 60000;
const ID = /^[a-f0-9]{32}$/;
const REASONS = new Set(['DISABLED','CONFIG_INVALID','PROBE_FAILED','TIMEOUT','CONTEXT_INVALID','PAGE_INVALID','LIVE_LINK_INVALID','HANDOFF_NOT_COMPLETED','UPLOAD_NOT_VERIFIED','SYNTHETIC_UPLOAD_VERIFIED','CLEANUP_UNCONFIRMED']);
function safeLink(link, token) {
  if (typeof link !== 'string' || link.length > 8192) return false;
  try { const u = new URL(link), decoded=decodeURIComponent(link); return typeof token==='string' && token.length>0 && !link.includes(token) && !decoded.includes(token) && u.protocol==='https:' && ['production-lon.browserless.io','production-ams.browserless.io','production-sfo.browserless.io'].includes(u.hostname) && (!u.port || u.port==='443') && !u.username && !u.password && !u.hash && /^\/e\/[A-Za-z0-9_-]+\/live\//.test(u.pathname); } catch { return false; }
}

function createHybridHandoffManager({env = process.env, run = runSyntheticHybridProbe, now = Date.now, makeId = () => randomBytes(16).toString('hex')} = {}) {
  let job = null, disposed = false;
  const clear = () => { if (job) { clearTimeout(job.timer); job.controller.abort(); job.link = null; job = null; } };
  function prune() {
    if (!job) return;
    if (job.expiresAt <= now() && !job.done) { job.link = null; job.controller.abort(); }
    if (job.done && job.result?.cleanupConfirmed === true && job.finishedAt + RESULT_RETENTION_MS <= now()) clear();
  }
  const enabled = () => !disposed && env.RAAD_SYNTHETIC_HYBRID_ENABLED === 'true' && env.RAAD_MOFA_LOGIN_PILOT_ENABLED !== 'true';
  const configuration = () => ({enabled:enabled(),configured:typeof env.BROWSERLESS_API_TOKEN==='string' && /^[\x21-\x7e]{1,4096}$/.test(env.BROWSERLESS_API_TOKEN)});
  function status(id) {
    prune();
    if (!job || job.id !== id) return null;
    if (job.done) return {id, state:'finished', result:job.result};
    return {id, state:job.expiresAt <= now() ? 'cancelling' : job.link ? 'ready' : job.claimed ? 'opened' : 'starting'};
  }
  function start() {
    prune();
    if (!enabled()) return {error:'DISABLED', status:404};
    const token = env.BROWSERLESS_API_TOKEN;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) return {error:'NOT_CONFIGURED', status:503};
    if (job && (!job.done || !job.result?.cleanupConfirmed)) return {error:'BUSY', status:409};
    if (job) clear();
    const id = makeId();
    if (!ID.test(id)) return {error:'UNAVAILABLE', status:503};
    const current = {id, controller:new AbortController(), link:null, claimed:false, done:false, result:null, expiresAt:now()+TTL_MS};
    job = current;
    current.timer = setTimeout(() => { if (job===current && !current.done) { current.link=null; current.controller.abort(); } }, TTL_MS); current.timer.unref?.();
    // The link is held only inside this process and only the authenticated
    // endpoint can consume it. This does not make the provider link itself
    // one-use; anyone holding that link can use it until its own expiry.
    const deliverPrivateLink = async link => {
      if (job !== current || current.done || current.controller.signal.aborted || current.expiresAt <= now() || !safeLink(link, token)) throw Error('STALE');
      current.link = link;
    };
    Promise.resolve().then(() => run({enabled:true, token, deliverPrivateLink, signal:current.controller.signal})).then(value => {
      if (job !== current) return;
      const reason = REASONS.has(value?.reason) ? value.reason : 'PROBE_FAILED';
      clearTimeout(current.timer); current.link = null; current.done = true; current.finishedAt = now();
      current.result = {tested:value?.tested===true, attached:value?.attached===true, handoffCompleted:value?.handoffCompleted===true, cleanupConfirmed:value?.cleanupConfirmed===true, reason};
    }, () => {
      if (job !== current) return;
      clearTimeout(current.timer); current.link = null; current.done = true; current.finishedAt = now();
      current.result = {tested:false, attached:false, handoffCompleted:false, cleanupConfirmed:false, reason:'PROBE_FAILED'};
    });
    return {id};
  }
  function take(id) {
    prune();
    if (!job || job.id !== id || job.done || !job.link || job.claimed || job.controller.signal.aborted || job.expiresAt <= now()) return null;
    const link = job.link; job.link = null; job.claimed = true;
    return link;
  }
  function cancel(id) {
    prune(); if (!job || job.id !== id || job.done) return false;
    job.link = null; job.controller.abort(); return true;
  }
  // Disposal is terminal: an outstanding asynchronous runner may still own a
  // remote browser even after abort. Never restart through this same manager.
  function dispose() { disposed = true; clear(); }
  return {configuration,start,status,take,cancel,dispose};
}

// Standalone Node HTTP adapter, not currently registered in the app.
// The admin key is in the Authorization header, never in the URL or body.
function createSyntheticHybridHandler({manager, env = process.env} = {}) {
  if (!manager) throw Error('MANAGER_REQUIRED');
  const reply = (res, status, obj) => res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, private', 'Pragma':'no-cache', 'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff'}).end(JSON.stringify(obj));
  return function handle(req, res, url) {
    if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT+'/')) return false;
    if (!validQueueKey(req.headers.authorization, env.ASSISTANT_ADMIN_KEY)) { reply(res,401,{error:'UNAUTHORIZED'}); return true; }
    if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') { reply(res,400,{error:'BODY_NOT_ALLOWED'}); return true; }
    if (url.search || url.hash) { reply(res,400,{error:'QUERY_NOT_ALLOWED'}); return true; }
    const rest = url.pathname.slice(ROOT.length), match = /^\/([a-f0-9]{32})(?:\/(link|cancel))?$/.exec(rest);
    if (!rest && req.method === 'GET') { reply(res,200,manager.configuration()); return true; }
    if (!rest && req.method === 'POST') { const out=manager.start(); reply(res,out.status||202,out.error?{error:out.error}:out); return true; }
    if (!match) { reply(res,404,{error:'NOT_FOUND'}); return true; }
    const [, id, action] = match;
    if (!action && req.method === 'GET') { const out=manager.status(id); reply(res,out?200:404,out||{error:'NOT_FOUND'}); return true; }
    if (action === 'link' && req.method === 'POST') { const link=manager.take(id); reply(res,link?200:409,link?{link}:{error:'NOT_AVAILABLE'}); return true; }
    if (action === 'cancel' && req.method === 'POST') { const ok=manager.cancel(id); reply(res,ok?202:409,ok?{cancelling:true}:{error:'NOT_AVAILABLE'}); return true; }
    reply(res,405,{error:'METHOD_NOT_ALLOWED'}); return true;
  };
}
module.exports = {createHybridHandoffManager, createSyntheticHybridHandler};
