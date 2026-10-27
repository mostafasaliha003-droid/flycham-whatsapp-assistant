'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {runMofaLoginProbe,MOFA_LOGIN_URL}=require('../src/mofa-login-probe');
function fixture({destination=MOFA_LOGIN_URL,ending='userDone',closeFails=false}={}) {
 const events=[],cdp=new EventEmitter(); let current='about:blank';
 cdp.send=async(method,params)=>{events.push(['cdp',method,params]);return {liveURL:'https://production-lon.browserless.io/e/abc/live/index.html?i=SECRET',liveURLId:'mofa1'};};
 const page={url:()=>current,goto:async(url,opts)=>{events.push(['goto',url]);assert.equal(url,MOFA_LOGIN_URL);assert.equal(opts.waitUntil,'domcontentloaded');current=destination;}};
 const context={newPage:async()=>page,newCDPSession:async()=>cdp};
 const browser={contexts:()=>[context],close:async()=>{events.push(['close']);if(closeFails)throw Error('sensitive browser exception');}};
 const connect=async(url)=>{const p=new URL(url);assert.equal(p.hostname,'production-lon.browserless.io');assert.equal(p.searchParams.get('record'),'false');assert.equal(p.searchParams.get('replay'),'false');events.push(['connect']);return browser;};
 const deliverPrivateLink=async()=>{events.push(['deliver']);queueMicrotask(()=>cdp.emit('Browserless.liveComplete',{liveURLId:'mofa1',reason:ending}));};
 return {events,browser,options:{enabled:true,token:'SYNTHETIC_TOKEN',connect,deliverPrivateLink,workMs:500,linkMs:400,cleanupMs:100}};
}
test('disabled mode makes no connection',async()=>{const f=fixture();assert.equal((await runMofaLoginProbe({...f.options,enabled:false})).reason,'DISABLED');assert.deepEqual(f.events,[]);});
test('manual handoff never declares authenticated, closes browser, and does not access form or upload',async()=>{const f=fixture();const r=await runMofaLoginProbe(f.options);assert.deepEqual(r,{tested:true,handoffCompleted:true,authenticated:false,cleanupConfirmed:true,reason:'MANUAL_HANDOFF_COMPLETED_AUTH_UNVERIFIED'});assert.deepEqual(f.events.map(x=>x[0]),['connect','goto','cdp','deliver','close']);assert.doesNotMatch(JSON.stringify(r),/SECRET|SYNTHETIC_TOKEN|browserless|mofa.gov/);});
test('unexpected redirect prevents link handoff and closes browser',async()=>{const f=fixture({destination:'https://evil.example/login'});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'PAGE_INVALID');assert.equal(r.cleanupConfirmed,true);assert.equal(f.events.some(e=>e[0]==='deliver'),false);});
test('cancel or failure never reports completed login',async()=>{for(const ending of ['userFailed','timeout','closed','viewerDisconnected']){const f=fixture({ending});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'HANDOFF_NOT_COMPLETED');assert.equal(r.handoffCompleted,false);assert.equal(r.authenticated,false);}});
test('cleanup failure fails closed',async()=>{const f=fixture({closeFails:true});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'CLEANUP_UNCONFIRMED');assert.equal(r.cleanupConfirmed,false);assert.equal(r.authenticated,false);});
