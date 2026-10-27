'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createMofaLoginManager,createMofaLoginHandler}=require('../src/mofa-login-manager');
const ROOT='/internal/assistant/mofa-login-pilot';
const KEY='x'.repeat(40),TOKEN='SYNTHETIC_TOKEN',ID='a'.repeat(32),LINK='https://production-lon.browserless.io/e/abc/live/index.html?t=SECRET_LINK';
const tick=()=>new Promise(setImmediate);
function setup({enabled='true',key=KEY,token=TOKEN,runner,now=Date.now}={}){
 const env={RAAD_MOFA_LOGIN_PILOT_ENABLED:enabled,ASSISTANT_ADMIN_KEY:key,BROWSERLESS_API_TOKEN:token};
 const manager=createMofaLoginManager({env,run:runner,now,makeId:()=>ID});const handle=createMofaLoginHandler({manager,env});
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
 finish({tested:true,handoffCompleted:true,cleanupConfirmed:true,reason:'MANUAL_HANDOFF_COMPLETED_AUTH_UNVERIFIED'});await tick();
 const done=h.req('GET',ROOT+'/'+ID);assert.equal(done.body.result.authenticated,false);assert.doesNotMatch(JSON.stringify(done),/SECRET_LINK|SYNTHETIC_TOKEN/);h.manager.dispose();
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
test('MOFA pilot cannot start if the synthetic pilot is simultaneously enabled',()=>{
 let runs=0;const h=setup({runner:()=>{runs++;}});h.env.RAAD_SYNTHETIC_HYBRID_ENABLED='true';
 assert.equal(h.req('GET',ROOT).body.enabled,false);assert.equal(h.req('POST',ROOT).status,404);assert.equal(runs,0);h.manager.dispose();
});
test('continuity check requires auth, readiness and is single-use; login remains unverified',async()=>{
 let ready,finish;
 const h=setup({runner:o=>{ready=o.waitForContinuityCheck;return new Promise(resolve=>{finish=resolve;});}});
 assert.equal(h.req('POST',ROOT).status,202);await tick();
 assert.equal(h.req('POST',ROOT+'/'+ID+'/check').status,409);
 const pending=ready();
 assert.equal(h.req('GET',ROOT+'/'+ID).body.state,'awaiting_continuity_check');
 assert.equal(h.req('POST',ROOT+'/'+ID+'/check','Bearer wrong').status,401);
 assert.equal(h.req('POST',ROOT+'/'+ID+'/check').status,202);
 assert.equal(h.req('POST',ROOT+'/'+ID+'/check').status,409);await pending;
 finish({tested:true,handoffCompleted:true,continuityVerified:true,authenticated:true,cleanupConfirmed:true,reason:'CONTINUITY_VERIFIED_AUTH_UNVERIFIED'});await tick();
 const result=h.req('GET',ROOT+'/'+ID).body.result;assert.equal(result.continuityVerified,true);assert.equal(result.authenticated,false);h.manager.dispose();
});
test('expired or cancelled wait never accepts a check',async()=>{
 let stamp=1000,ready;
 const h=setup({now:()=>stamp,runner:o=>{ready=o.waitForContinuityCheck;return new Promise(()=>{});}});
 h.req('POST',ROOT);await tick();ready();stamp+=110001;assert.equal(h.req('POST',ROOT+'/'+ID+'/check').status,409);h.manager.dispose();
 let wait;const c=setup({runner:o=>{wait=o.waitForContinuityCheck;return new Promise(()=>{});}});
 c.req('POST',ROOT);await tick();wait();assert.equal(c.req('POST',ROOT+'/'+ID+'/cancel').status,202);assert.equal(c.req('POST',ROOT+'/'+ID+'/check').status,409);c.manager.dispose();
});
test('free session limits remain the default and paid limits require an explicit profile',async()=>{
 for(const [profile,expected] of [[undefined,{sessionMs:120000,workMs:110000,linkMs:90000}],['free',{sessionMs:120000,workMs:110000,linkMs:90000}],['prototyping_15m',{sessionMs:900000,workMs:880000,linkMs:840000}]]){
  let options;const h=setup({runner:o=>{options=o;return new Promise(()=>{});}});
  if(profile!==undefined)h.env.RAAD_MOFA_SESSION_PROFILE=profile;
  assert.equal(h.req('POST',ROOT).status,202);await tick();
  assert.deepEqual({sessionMs:options.sessionMs,workMs:options.workMs,linkMs:options.linkMs},expected);h.manager.dispose();
 }
});
test('unknown or malformed session profile fails closed without initiating a browser',()=>{
 for(const profile of ['','paid','prototyping_15m ','900000','PROTOTYPING_15M']){
  let runs=0;const h=setup({runner:()=>{runs++;}});h.env.RAAD_MOFA_SESSION_PROFILE=profile;
  assert.equal(h.req('GET',ROOT).body.configured,false);assert.equal(h.req('POST',ROOT).status,503);assert.equal(runs,0);h.manager.dispose();
 }
});
test('paid profile still expires, aborts and revokes the private link at its work deadline',async()=>{
 let stamp=1000,deliver,signal;const h=setup({now:()=>stamp,runner:o=>{deliver=o.deliverPrivateLink;signal=o.signal;return new Promise(()=>{});}});
 h.env.RAAD_MOFA_SESSION_PROFILE='prototyping_15m';h.req('POST',ROOT);await tick();await deliver(LINK);
 stamp+=880001;assert.equal(h.req('POST',ROOT+'/'+ID+'/link').status,409);assert.equal(signal.aborted,true);
 assert.equal(h.req('POST',ROOT).status,409);h.manager.dispose();
});
