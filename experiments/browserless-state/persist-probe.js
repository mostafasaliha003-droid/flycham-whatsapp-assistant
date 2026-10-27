'use strict';

// Standalone opt-in synthetic probe. This module has no MOFA code, no login,
// no screenshots, no customer documents, and no server routes. Do not expose
// provider URLs: connect and stop both contain bearer credentials.
const HOSTS = Object.freeze({lon:'production-lon.browserless.io',ams:'production-ams.browserless.io',sfo:'production-sfo.browserless.io'});
const ORIGIN = 'https://persistence-test.invalid';
const FIXTURE = 'synthetic-only';
const TTL_MS = 300000;
const TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 3000;

function bounded(value, ms=TIMEOUT_MS, onLate) {
  let expired=false, timer;
  const op=Promise.resolve(value);
  op.then(x=>{if(expired && onLate)Promise.resolve().then(()=>onLate(x)).catch(()=>{});},()=>{});
  return Promise.race([op,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('TIMEOUT'));},ms);})]).finally(()=>clearTimeout(timer));
}

function isProviderURL(value, scheme, host, token) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const u = new URL(value);
    return u.protocol === scheme && u.hostname === host && (!u.port || u.port === '443') &&
      !u.username && !u.password && !u.hash && u.searchParams.getAll('token').length === 1 &&
      u.searchParams.get('token') === token;
  } catch { return false; }
}
async function request(fetcher, url, options={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await bounded(fetcher(url, {...options, redirect:'manual', signal:controller.signal})); }
  finally { clearTimeout(timer); }
}
async function connectDefault(url) { return require('playwright').chromium.connectOverCDP(url, {timeout:TIMEOUT_MS}); }

async function runSyntheticPersistenceProbe({enabled=false,token,region='lon',fetcher=globalThis.fetch,connect=connectDefault,now=Date.now}={}) {
  const out={enabled:enabled===true,createAttempted:false,created:false,firstWrite:false,firstClosed:false,secondRead:false,secondClosed:false,deleted:false,reason:'DISABLED'};
  if (enabled !== true) return out;
  const host=HOSTS[region];
  if (!host || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token) || typeof fetcher !== 'function' || typeof connect !== 'function' || typeof now !== 'function') return {...out, reason:'INVALID_CONFIG'};
  let session, browser;
  try {
    const url=new URL(`https://${host}/session`); url.searchParams.set('token',token);
    out.createAttempted=true;
    const res=await request(fetcher,url.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ttl:TTL_MS,processKeepAlive:0,replay:false})});
    if (!res.ok) throw Error('CREATE_FAILED');
    out.created=true;
    const raw=await bounded(res.json());
    // A malformed response may make cleanup impossible; never use unchecked URLs.
    if (!raw || typeof raw.id!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) || !isProviderURL(raw.stop,'https:',host,token) || new URL(raw.stop).pathname!=='/session/'+raw.id) throw Error('STOP_URL_INVALID');
    session={stop:raw.stop};
    if (!isProviderURL(raw.connect,'wss:',host,token) || new URL(raw.connect).pathname!=='/session/connect/'+raw.id) throw Error('CONNECT_URL_INVALID');
    session.connect=raw.connect;
    async function open(){
      const b=await bounded(connect(session.connect),TIMEOUT_MS, late=>bounded(late.close(),CLOSE_TIMEOUT_MS));
      try {
        const contexts=b.contexts();
        if (!Array.isArray(contexts) || contexts.length!==1) throw Error('CONTEXT_INVALID');
        const ctx=contexts[0], page=await bounded(ctx.newPage());
        await bounded(page.route('**/*',route=>route.request().url()===ORIGIN+'/' ? route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>synthetic persistence</title>'}) : route.abort()));
        await bounded(page.goto(ORIGIN+'/',{waitUntil:'domcontentloaded',timeout:TIMEOUT_MS}));
        if(page.url()!==ORIGIN+'/')throw Error('PAGE_INVALID');
        return {browser:b,context:ctx,page};
      } catch(e) {try {await bounded(b.close(),CLOSE_TIMEOUT_MS);} catch {} throw e;}
    }
    const first=await open(); browser=first.browser;
    await bounded(first.context.addCookies([{name:'synthetic_cookie',value:FIXTURE,url:ORIGIN+'/',expires:Math.floor(now()/1000)+600}]));
    await bounded(first.page.evaluate(value=>localStorage.setItem('synthetic_state',value),FIXTURE));
    out.firstWrite=true;
    await bounded(browser.close(),CLOSE_TIMEOUT_MS); browser=null; out.firstClosed=true;
    const second=await open(); browser=second.browser;
    const stored=await bounded(second.page.evaluate(()=>localStorage.getItem('synthetic_state')));
    const cookies=await bounded(second.context.cookies(ORIGIN));
    out.secondRead=stored===FIXTURE && cookies.some(c=>c.name==='synthetic_cookie' && c.value===FIXTURE);
    await bounded(browser.close(),CLOSE_TIMEOUT_MS); browser=null; out.secondClosed=true;
    out.reason=out.secondRead?'SYNTHETIC_STATE_RESTORED':'STATE_NOT_RESTORED';
  } catch(e) {
    // Never surface provider exceptions: they may contain token-bearing URLs.
    const allowed=new Set(['CREATE_FAILED','STOP_URL_INVALID','CONNECT_URL_INVALID','CONTEXT_INVALID','PAGE_INVALID']);
    out.reason=allowed.has(e?.message)?e.message:'PROBE_FAILED';
  } finally {
    if(browser) try { await bounded(browser.close(),CLOSE_TIMEOUT_MS); } catch {}
    if(session?.stop) {
      try { const stop=new URL(session.stop);stop.searchParams.set('force','true'); const res=await request(fetcher,stop.href,{method:'DELETE'});out.deleted=res.ok===true; }
      catch {out.deleted=false;}
    }
  }
  // Valid provider success is required before cleanup can be claimed.
  if(out.createAttempted && !out.deleted)out.reason='CLEANUP_UNCONFIRMED';
  return out;
}
module.exports={runSyntheticPersistenceProbe,isProviderURL,bounded,ORIGIN,TTL_MS};
