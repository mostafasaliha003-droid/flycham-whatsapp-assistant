'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {runSyntheticHybridProbe} = require('../src/hybrid-upload-probe');

function fixture({liveURL = 'https://production-lon.browserless.io/e/abcd/live/index.html?i=SECRET', ending = 'userDone',
  invalidFile = false, failClose = false} = {}) {
 const events = [], cdp = new EventEmitter();
 let attached;
 cdp.send = async (method, params) => {events.push(['cdp',method,params]);return {liveURL,liveURLId:'synthetic-live-id'};};
 const input = {count:async()=>1,setInputFiles:async file=>{events.push(['attach']);attached=file;},
  evaluate:async fn=>invalidFile ? [] : fn({files:[{name:attached.name,type:attached.mimeType,size:attached.buffer.length}]})};
 const page = {url:()=> 'about:blank',route:async (glob, fn)=>{events.push(['route',glob]);let aborted=false;await fn({abort:async()=>{aborted=true;}});assert.equal(aborted,true);},
  setContent:async html=>{events.push(['html']);assert.match(html,/form-action 'none'/);assert.doesNotMatch(html,/<form|<script|https?:\/\//);},
  locator:selector=>{assert.equal(selector,'#synthetic-upload');return input;}};
 const ctx = {newPage:async()=>page,newCDPSession:async()=>cdp};
 const browser = {contexts:()=>[ctx],close:async()=>{events.push(['close']);if(failClose)throw Error('SECRET provider error');}};
 const connect = async (url,opts)=>{const parsed=new URL(url);assert.equal(parsed.hostname,'production-lon.browserless.io');assert.equal(parsed.searchParams.get('token'),'TOKEN_SECRET');assert.ok(opts.timeout<=15000);events.push(['connect']);return browser;};
 const deliverPrivateLink = async url=>{events.push(['deliver']);assert.equal(url,liveURL);queueMicrotask(()=>cdp.emit('Browserless.liveComplete',{liveURLId:'synthetic-live-id',reason:ending,feedback:{message:'SECRET_FEEDBACK'}}));};
 return {events,cdp,browser,connect,deliverPrivateLink,options:{enabled:true,token:'TOKEN_SECRET',connect,deliverPrivateLink,workMs:500,linkMs:400,cleanupMs:100}};
}
function noSecrets(result) {assert.doesNotMatch(JSON.stringify(result),/TOKEN_SECRET|SECRET_FEEDBACK|\?i=SECRET|browserless\.io|wss:|https:/);}

test('disabled or invalid config never connects or delivers', async()=>{
 const f=fixture();assert.equal((await runSyntheticHybridProbe(f.options={...f.options,enabled:false})).reason,'DISABLED');assert.deepEqual(f.events,[]);
 for(const value of [{region:'attacker.example'},{token:'bad\nkey'},{workMs:3,linkMs:3},{token:''},{deliverPrivateLink:undefined}]) {
  const t=fixture();const result=await runSyntheticHybridProbe({...t.options,...value});assert.equal(result.reason,'CONFIG_INVALID');assert.deepEqual(t.events,[]);noSecrets(result);
 }
});
test('private handoff followed by synthetic upload closes session and exposes no secrets',async()=>{
 const f=fixture();const result=await runSyntheticHybridProbe(f.options);assert.deepEqual(result,{tested:true,attached:true,handoffCompleted:true,cleanupConfirmed:true,reason:'SYNTHETIC_UPLOAD_VERIFIED'});
 assert.deepEqual(f.events.map(e=>e[0]),['connect','route','html','cdp','deliver','attach','close']);
 assert.equal(f.cdp.listenerCount('Browserless.liveComplete'),0);noSecrets(result);
});
test('rejects foreign, insecure or malicious live URLs before delivery',async()=>{
 for(const link of ['http://production-lon.browserless.io/e/abcd/live/a','https://production-lon.browserless.io.evil.example/e/abcd/live/a',
 'https://user:pass@production-lon.browserless.io/e/abcd/live/a','https://production-lon.browserless.io:8443/e/abcd/live/a',
 'https://production-lon.browserless.io/not-live','https://production-lon.browserless.io/e/abcd/live/a#secret']){
  const f=fixture({liveURL:link});const result=await runSyntheticHybridProbe(f.options);assert.equal(result.reason,'LIVE_LINK_INVALID');
  assert.equal(result.cleanupConfirmed,true);assert.equal(f.events.some(e=>e[0]==='deliver'),false);noSecrets(result);
 }
});
test('non-success handoff never attaches an upload',async()=>{
 for(const ending of ['userFailed','timeout','closed','viewerDisconnected']){const f=fixture({ending});const result=await runSyntheticHybridProbe(f.options);
  assert.equal(result.reason,'HANDOFF_NOT_COMPLETED');assert.equal(result.attached,false);assert.equal(result.cleanupConfirmed,true);noSecrets(result);}
});
test('wrong event ID is ignored and work terminates at deadline',async()=>{
 const f=fixture();f.options={...f.options,workMs:20,linkMs:10,deliverPrivateLink:async()=>f.cdp.emit('Browserless.liveComplete',{liveURLId:'other',reason:'userDone'})};
 const result=await runSyntheticHybridProbe(f.options);assert.equal(result.reason,'TIMEOUT');assert.equal(result.attached,false);assert.equal(result.cleanupConfirmed,true);noSecrets(result);
});
test('metadata mismatch fails closed and cleanup failure is not success',async()=>{
 let f=fixture({invalidFile:true});let result=await runSyntheticHybridProbe(f.options);assert.equal(result.reason,'UPLOAD_NOT_VERIFIED');assert.equal(result.attached,false);assert.equal(result.cleanupConfirmed,true);
 f=fixture({failClose:true});result=await runSyntheticHybridProbe(f.options);assert.equal(result.reason,'CLEANUP_UNCONFIRMED');assert.equal(result.cleanupConfirmed,false);noSecrets(result);
});
test('late browser connection is closed after timeout',async()=>{
 let finish;const f=fixture();f.options={...f.options,workMs:10,linkMs:5,connect:()=>new Promise(resolve=>{finish=resolve;})};
 const result=await runSyntheticHybridProbe(f.options);assert.equal(result.reason,'TIMEOUT');assert.equal(result.tested,false);assert.equal(result.cleanupConfirmed,false);
 finish(f.browser);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.events.at(-1)[0],'close');noSecrets(result);
});
test('abort before work never connects',async()=>{const f=fixture(),controller=new AbortController();controller.abort();const result=await runSyntheticHybridProbe({...f.options,signal:controller.signal});
 assert.equal(result.reason,'TIMEOUT');assert.deepEqual(f.events,[]);noSecrets(result);});
test('provider and link-delivery failures do not leak secrets or leave an opened session',async()=>{
 let f=fixture();let result=await runSyntheticHybridProbe({...f.options,connect:async()=>{throw Error('TOKEN_SECRET provider URL');}});
 assert.equal(result.reason,'PROBE_FAILED');assert.equal(result.tested,false);noSecrets(result);
 f=fixture();result=await runSyntheticHybridProbe({...f.options,deliverPrivateLink:async()=>{throw Error('TOKEN_SECRET https://example.invalid');}});
 assert.equal(result.reason,'PROBE_FAILED');assert.equal(result.cleanupConfirmed,true);assert.equal(f.events.at(-1)[0],'close');noSecrets(result);
});
