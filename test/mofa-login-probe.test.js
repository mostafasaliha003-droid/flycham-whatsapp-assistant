'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {runMofaLoginProbe,MOFA_LOGIN_URL}=require('../src/mofa-login-probe');
function fixture({destination=MOFA_LOGIN_URL,ending='userDone',closeFails=false,connected=true,closed=false,checkReject=false,checkHang=false}={}) {
 const events=[],cdp=new EventEmitter(); let current='about:blank';
 cdp.send=async(method,params)=>{events.push(['cdp',method,params]);if(method==='Page.getLayoutMetrics'){if(checkReject)throw Error('sensitive');if(checkHang)return new Promise(()=>{});return {sensitive:'NEVER_OUTPUT_LAYOUT'};}return {liveURL:'https://production-lon.browserless.io/e/abc/live/index.html?i=SECRET',liveURLId:'mofa1'};};
 const page={url:()=>current,isClosed:()=>closed,goto:async(url,opts)=>{events.push(['goto',url]);assert.equal(url,MOFA_LOGIN_URL);assert.equal(opts.waitUntil,'domcontentloaded');current=destination;}};
 const context={newPage:async()=>page,newCDPSession:async()=>cdp,pages:()=>[page]};
 const browser={contexts:()=>[context],isConnected:()=>connected,close:async()=>{events.push(['close']);if(closeFails)throw Error('sensitive browser exception');}};
 const connect=async(url)=>{const p=new URL(url);assert.equal(p.hostname,'production-lon.browserless.io');assert.equal(p.searchParams.get('record'),'false');assert.equal(p.searchParams.get('replay'),'false');events.push(['connect']);return browser;};
 const deliverPrivateLink=async()=>{events.push(['deliver']);queueMicrotask(()=>cdp.emit('Browserless.liveComplete',{liveURLId:'mofa1',reason:ending}));};
 return {events,browser,setCurrent:value=>{current=value;},options:{enabled:true,token:'SYNTHETIC_TOKEN',connect,deliverPrivateLink,waitForContinuityCheck:async()=>{events.push(['check']);},workMs:500,linkMs:400,cleanupMs:100}};
}
test('disabled mode makes no connection',async()=>{const f=fixture();assert.equal((await runMofaLoginProbe({...f.options,enabled:false})).reason,'DISABLED');assert.deepEqual(f.events,[]);});
test('handoff plus check verifies only continuity and closes browser without accessing forms',async()=>{const f=fixture();const r=await runMofaLoginProbe(f.options);assert.deepEqual(r,{tested:true,handoffCompleted:true,continuityVerified:true,authenticated:false,cleanupConfirmed:true,reason:'CONTINUITY_VERIFIED_AUTH_UNVERIFIED'});assert.deepEqual(f.events.map(x=>x[0]),['connect','goto','cdp','deliver','check','cdp','close']);assert.equal(f.events.filter(x=>x[0]==='cdp').at(-1)[1],'Page.getLayoutMetrics');assert.doesNotMatch(JSON.stringify(r),/SECRET|SYNTHETIC_TOKEN|browserless|mofa.gov|NEVER_OUTPUT_LAYOUT/);});
test('session remains open until admin check and closes if wait expires',async()=>{const f=fixture();let release,entered;const ready=new Promise(resolve=>entered=resolve);const pending=runMofaLoginProbe({...f.options,workMs:90,linkMs:80,waitForContinuityCheck:()=>new Promise(resolve=>{release=resolve;entered();})});await ready;assert.equal(f.events.some(x=>x[0]==='close'),false);release();const r=await pending;assert.equal(r.continuityVerified,true);assert.equal(r.authenticated,false);const timed=fixture();const out=await runMofaLoginProbe({...timed.options,workMs:50,linkMs:30,waitForContinuityCheck:()=>new Promise(()=>{})});assert.equal(out.reason,'TIMEOUT');assert.equal(out.cleanupConfirmed,true);assert.equal(out.authenticated,false);});
test('disconnected or closed browser does not verify continuity',async()=>{for(const config of [{connected:false},{closed:true}]){const f=fixture(config);const out=await runMofaLoginProbe(f.options);assert.equal(out.reason,'CONTINUITY_UNAVAILABLE');assert.equal(out.continuityVerified,false);assert.equal(out.authenticated,false);}});
test('remote check must complete, not merely report local connectivity',async()=>{for(const config of [{checkReject:true},{checkHang:true}]){const f=fixture(config);const out=await runMofaLoginProbe({...f.options,workMs:80,linkMs:60});assert.equal(out.continuityVerified,false);assert.equal(out.cleanupConfirmed,true);assert.equal(out.authenticated,false);assert.ok(['PROBE_FAILED','TIMEOUT'].includes(out.reason));}});
test('another destination after the handoff never verifies and is not exposed',async()=>{const f=fixture();const out=await runMofaLoginProbe({...f.options,waitForContinuityCheck:async()=>f.setCurrent('https://private.example/SECRET_PAGE')});assert.equal(out.continuityVerified,false);assert.equal(out.reason,'CONTINUITY_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(out),/private|SECRET_PAGE/);});
test('unexpected redirect prevents link handoff and closes browser',async()=>{const f=fixture({destination:'https://evil.example/login'});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'PAGE_INVALID');assert.equal(r.cleanupConfirmed,true);assert.equal(f.events.some(e=>e[0]==='deliver'),false);});
test('cancel or failure never reports completed login',async()=>{for(const ending of ['userFailed','timeout','closed','viewerDisconnected']){const f=fixture({ending});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'HANDOFF_NOT_COMPLETED');assert.equal(r.handoffCompleted,false);assert.equal(r.authenticated,false);}});
test('cleanup failure fails closed',async()=>{const f=fixture({closeFails:true});const r=await runMofaLoginProbe(f.options);assert.equal(r.reason,'CLEANUP_UNCONFIRMED');assert.equal(r.cleanupConfirmed,false);assert.equal(r.authenticated,false);});
test('paid mode passes only the explicit bounded session and link timeouts to the provider',async()=>{
 const f=fixture();let seen;const original=f.options.connect;
 const out=await runMofaLoginProbe({...f.options,sessionMs:900000,workMs:880000,linkMs:840000,connect:async(url,opts)=>{seen=new URL(url);return original(url,opts);}});
 assert.equal(out.continuityVerified,true);assert.equal(out.authenticated,false);assert.equal(out.cleanupConfirmed,true);
 assert.equal(seen.searchParams.get('timeout'),'900000');assert.equal(f.events.find(x=>x[0]==='cdp'&&x[1]==='Browserless.liveURL')[2].timeout,840000);
});
test('free limit cannot be exceeded and unknown paid session limits fail before connecting',async()=>{
 for(const overrides of [{workMs:880000,linkMs:840000},{sessionMs:900001,workMs:880000,linkMs:840000},{sessionMs:900000,workMs:900000,linkMs:840000},{sessionMs:900000,workMs:880000,linkMs:880000}]){
  const f=fixture();const out=await runMofaLoginProbe({...f.options,...overrides});assert.equal(out.reason,'CONFIG_INVALID');assert.deepEqual(f.events,[]);
 }
});
