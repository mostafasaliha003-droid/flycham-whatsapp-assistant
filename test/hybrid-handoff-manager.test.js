'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHybridHandoffManager,createSyntheticHybridHandler}=require('../src/hybrid-handoff-manager');
const ROOT='/internal/assistant/synthetic-hybrid';
const KEY='x'.repeat(40),TOKEN='SYNTHETIC_TOKEN',ID='a'.repeat(32),LINK='https://production-lon.browserless.io/e/abc/live/index.html?t=SECRET_LINK';
const tick=()=>new Promise(setImmediate);
function setup({enabled='true',key=KEY,token=TOKEN,runner,now=Date.now}={}){
 const env={RAAD_SYNTHETIC_HYBRID_ENABLED:enabled,ASSISTANT_ADMIN_KEY:key,BROWSERLESS_API_TOKEN:token};
 const manager=createHybridHandoffManager({env,run:runner,now,makeId:()=>ID});const handle=createSyntheticHybridHandler({manager,env});
 function req(method,path,auth='Bearer '+KEY,headers={}){let status,body,outHeaders;const response={writeHead(s,h){status=s;outHeaders=h;return this;},end(b){body=b;return this;}};const matched=handle({method,headers:{authorization:auth,...headers}},response,new URL(path,'https://example.test'));return {matched,status,headers:outHeaders,body:JSON.parse(body)};}
 return {env,manager,req};
}
test('authentication and disabled gates reject requests without running probe or exposing data',()=>{
 let runs=0;const h=setup({enabled:'false',runner:()=>{runs++;}});
 assert.equal(h.req('POST',ROOT,'Bearer wrong').status,401);assert.equal(h.req('POST',ROOT).status,404);assert.equal(runs,0);
 assert.equal(JSON.stringify(h.req('GET',ROOT+'/'+ID)).includes(TOKEN),false);h.manager.dispose();
});
test('protected link is delivered once, only after readiness and never in status',async()=>{
 let deliver,finish;const runner=opts=>{deliver=opts.deliverPrivateLink;return new Promise(resolve=>{finish=resolve;});};const h=setup({runner});
 assert.deepEqual(h.req('POST',ROOT).body,{id:ID});await tick();assert.equal(h.req('POST',ROOT).status,409);
 await deliver(LINK);const status=h.req('GET',ROOT+'/'+ID);assert.equal(status.body.state,'ready');assert.doesNotMatch(JSON.stringify(status),/SECRET_LINK|SYNTHETIC_TOKEN/);
 assert.equal(h.req('POST',ROOT+'/'+ID+'/link','Bearer wrong').status,401);
 const claimed=h.req('POST',ROOT+'/'+ID+'/link');assert.equal(claimed.body.link,LINK);assert.equal(claimed.headers['Cache-Control'],'no-store, private');assert.equal(claimed.headers['Referrer-Policy'],'no-referrer');
 assert.equal(h.req('POST',ROOT+'/'+ID+'/link').status,409);assert.equal(h.req('GET',ROOT+'/'+ID).body.state,'opened');
 finish({tested:true,attached:true,handoffCompleted:true,cleanupConfirmed:true,reason:'SYNTHETIC_UPLOAD_VERIFIED'});await tick();
 const done=h.req('GET',ROOT+'/'+ID);assert.equal(done.body.result.attached,true);assert.doesNotMatch(JSON.stringify(done),/SECRET_LINK|SYNTHETIC_TOKEN/);h.manager.dispose();
});
test('untrusted destination, bodies and query strings cannot cause delivery',async()=>{
 let deliver;const h=setup({runner:o=>{deliver=o.deliverPrivateLink;return new Promise(()=>{});}});
 assert.equal(h.req('POST',ROOT+'?secret=bad').status,400);assert.equal(h.req('POST',ROOT,'Bearer '+KEY,{'content-length':'2'}).status,400);
 assert.equal(h.req('POST',ROOT,'Bearer '+KEY,{'transfer-encoding':'chunked'}).status,400);assert.equal(h.req('POST',ROOT).status,202);await tick();
 for(const link of ['http://production-lon.browserless.io/e/x/live/','https://evil.example/e/x/live/','https://production-lon.browserless.io.evil.example/e/x/live/','https://user:pass@production-lon.browserless.io/e/x/live/','https://production-lon.browserless.io/e/x/live/#x','https://production-lon.browserless.io/e/x/live/?token='+TOKEN])await assert.rejects(deliver(link));
 assert.equal(h.req('POST',ROOT+'/'+ID+'/link').status,409);h.manager.dispose();
});
test('expiry and cancellation revoke undelivered link and abort work',async()=>{
 let stamp=1000,deliver,signal;const h=setup({now:()=>stamp,runner:o=>{deliver=o.deliverPrivateLink;signal=o.signal;return new Promise(()=>{});}});
 h.req('POST',ROOT);await tick();await deliver(LINK);stamp+=110001;
 assert.equal(h.req('POST',ROOT+'/'+ID+'/link').status,409);assert.equal(signal.aborted,true);assert.equal(h.req('GET',ROOT+'/'+ID).body.state,'cancelling');assert.equal(h.req('POST',ROOT).status,409);h.manager.dispose();
});
test('cleanup must be confirmed before another probe can start, including after retention',async()=>{
 let stamp=1000;const h=setup({now:()=>stamp,runner:async()=>({tested:true,cleanupConfirmed:false,reason:'CLEANUP_UNCONFIRMED'})});
 h.req('POST',ROOT);await tick();assert.equal(h.req('GET',ROOT+'/'+ID).body.result.cleanupConfirmed,false);
 stamp+=60001;assert.equal(h.req('POST',ROOT).status,409);h.manager.dispose();
});
test('disposing while an asynchronous runner is still active is terminal',async()=>{
 let signal;const h=setup({runner:o=>{signal=o.signal;return new Promise(()=>{});}});h.req('POST',ROOT);await tick();h.manager.dispose();
 assert.equal(signal.aborted,true);assert.equal(h.req('POST',ROOT).status,404);assert.equal(h.req('GET',ROOT+'/'+ID).status,404);
});
