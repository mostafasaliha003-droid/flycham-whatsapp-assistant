'use strict';
// Offline integration only. Real coordinator, dossier, dispatcher and worker;
// synthetic native adapter and in-memory bridge. Never a live response verifier.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path');
const {createRequire}=require('node:module'),vm=require('node:vm');
const OWNER='971507993145',SMS='966591182035',CODE='847392',START=Date.parse('2026-10-30T12:00:00Z');
const FIELDS=['challengeId','challengeRequestedAt','challengeExpiresAt','accountBinding'];
const tuple=value=>Object.fromEntries(FIELDS.map(key=>[key,value[key]]));
function rejectCodeLogging(t){for(const method of ['info','log','warn','error'])t.mock.method(console,method,(...args)=>assert.equal(args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' ').includes(CODE),false,'OTP must not be logged'));}
const pairPath=join(__dirname,'raad-paired-candidates-check.cjs');
const pair=readFileSync(pairPath,'utf8'),boundary=pair.indexOf("\ntest(");
assert.ok(boundary>0,'fixture must precede paired test declarations');
let prefix=pair.slice(0,boundary);
const marker='settle,now:()=>at};';
assert.equal(prefix.split(marker).length,2,'fixture accessor anchor changed');
prefix=prefix.replace(marker,'settle,now:()=>at,setNow:value=>{at=value;}};');

async function setup({captchaDelay=0}={}){
 const evidence={sms:0,entries:0,saves:0,requests:[],receipts:[],entryInputs:[],otpInputs:[],prompts:[],snapshots:[],nativeCalls:[]};
 let f,window;
 const wrapAdapter=original=>{
  const call=original.call;
  original.call=async(action,data,context)=>{
   evidence.nativeCalls.push(action);
   if(action==='request-application-sms'){
    evidence.sms++;
    window={challengeId:'synthetic_native_challenge',challengeRequestedAt:f.now(),challengeExpiresAt:f.now()+300000,accountBinding:'b'.repeat(64)};
    return {activationDispatched:true,...window,smsRequest:{requestObserved:true,destinationMatch:'matched',responseObserved:true,responseClass:'2xx',acceptance:'accepted'}};
   }
   if(action==='enter-application-sms'){
    assert.equal(data.code,CODE);assert.deepEqual(tuple(data),window);assert.ok(f.now()<window.challengeExpiresAt);
    evidence.entries++;evidence.entryInputs.push(data);return {codeEntered:true};
   }
   if(action==='refresh-form-captcha')return {refreshed:true};
   if(action==='solve-form-captcha'){f.setNow(f.now()+captchaDelay);return {solved:true};}
   if(action==='activate-control'&&data.mode==='submit'){
    evidence.saves++;assert.deepEqual(tuple(data),window);assert.ok(f.now()<window.challengeExpiresAt);
    throw Object.assign(Error('SYNTHETIC_SAVE_BOUNDARY'),{code:'SYNTHETIC_SAVE_BOUNDARY'});
   }
   const result=await call(action,data,context);
   if(action==='inspect-page')result.inspection.buttons=[{id:'syntheticSave',label:'Save',disabled:false}];
   return result;
  };
  return original;
 };
 const make=vm.runInThisContext('(function(require,wrapAdapter){'+prefix+
  '\nconst originalNativeAdapter=nativeAdapter;nativeAdapter=options=>wrapAdapter(originalNativeAdapter(options));return fixture;})',
  {filename:pairPath+'#synthetic-fixture'})(createRequire(pairPath),wrapAdapter);
 f=await make({now:START});
 const oldFetch=f.dispatcher.fetchImpl;
 f.dispatcher.fetchImpl=async(url,request)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/otp')){
   const body=JSON.parse(request.body);
   evidence.requests.push({path,method:request.method,...tuple(body)});evidence.otpInputs.push(body);
   const result=await f.worker.otp(f.job.id,body);evidence.receipts.push(result.otpReceipt);
   return {ok:true,status:202,json:async()=>structuredClone(result)};
  }
  return oldFetch(url,request);
 };
 f.fulfilment.resumeOtp=input=>f.dispatcher.resumeOtp(input);
 f.fulfilment.send=async(to,payload,guard)=>{
  await guard();evidence.prompts.push({to,text:payload.text});
  return {messageId:'synthetic-owner-prompt-'+evidence.prompts.length};
 };
 f.store.save=()=>{const serialized=JSON.stringify(f.store.data);assert.equal(serialized.includes(CODE),false,'OTP must never enter durable state');evidence.snapshots.push(serialized);};
 async function waitFor(stages){
  for(let i=0;i<300;i++){const state=f.worker.status(f.job.id);if(stages.includes(state.stage))return state;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail('synthetic worker did not reach '+stages.join('/'));
 }
 async function launch(){await f.dispatcher.launch(f.job);const state=await waitFor(['waiting_otp','blocked','lease_lost']);assert.equal(state.stage,'waiting_otp',state.blocker?.code);assert.deepEqual(tuple(state),window);return state;}
 async function poll(){return f.dispatcher.poll(f.job,f.store.data.visaPortalRuns[f.job.id]);}
 async function prompt(){
  await poll();const challenge=Object.values(f.fulfilment.data().challenges).find(c=>c.jobId===f.job.id);
  assert.ok(challenge);await f.fulfilment.dispatchMessage(challenge.outboxMessageId);assert.ok(challenge.messageId);return challenge;
 }
 const input=(challenge,id='synthetic-inbound-otp')=>({sender:OWNER,contextId:challenge.messageId,messageId:id,text:CODE});
 return {...f,evidence,launch,poll,prompt,input,waitFor,window:()=>window};
}

test('real chain: native deadline survives delayed polling, exact owner reply reaches one bound worker entry and Save boundary',async t=>{
 rejectCodeLogging(t);
 const f=await setup();t.after(()=>f.worker.shutdown());const native=await f.launch();
 f.setNow(f.now()+120000);const challenge=await f.prompt();
 assert.equal(challenge.owner,OWNER);assert.equal(challenge.expiresAt,native.challengeExpiresAt);
 assert.equal(challenge.challengeRequestedAt,native.challengeRequestedAt);
 assert.equal(challenge.accountBinding,native.accountBinding);
 assert.equal(f.evidence.prompts.length,1);assert.equal(f.evidence.prompts[0].to,OWNER);
 assert.ok(f.evidence.prompts[0].text.includes(new Date(native.challengeExpiresAt).toISOString()));
 const phone=f.adapter.calls.filter(x=>x.action==='fill-draft').flatMap(x=>x.data.fields).find(x=>x.id==='MobileInfo_Mobile');
 assert.equal(phone.value,SMS.slice(3),'worker must fill Saudi SMS destination, not UAE WhatsApp sender or applicant phone');
 const wrongSender={...f.input(challenge),sender:'971500000001'};
 const wrongContext={...f.input(challenge),contextId:'not-current-owner-prompt'};
 assert.equal((await f.fulfilment.consumeOtp(wrongSender)).ok,false);assert.equal(wrongSender.text,'');
 assert.equal((await f.fulfilment.consumeOtp(wrongContext)).ok,false);assert.equal(wrongContext.text,'');
 assert.equal(f.evidence.requests.length,0);
 const original=f.input(challenge),duplicate=f.input(challenge,'synthetic-duplicate-otp');
 const results=await Promise.all([f.fulfilment.consumeOtp(original),f.fulfilment.consumeOtp(duplicate)]);
 assert.equal(results.filter(x=>x.ok).length,1);assert.equal(original.text,'');assert.equal(duplicate.text,'');
 const terminal=await f.waitFor(['blocked','lease_lost']);
 assert.equal(f.evidence.requests.length,1);assert.equal(f.evidence.entries,1);assert.equal(f.evidence.saves,1);
 assert.equal(terminal.blocker.code,'SAVE_UNCERTAIN','synthetic boundary deliberately throws instead of saving');
 assert.deepEqual(tuple(f.evidence.requests[0]),tuple(native));assert.deepEqual(tuple(f.evidence.receipts[0]),tuple(native));
 assert.equal(f.evidence.receipts[0].jobId,f.job.id);assert.equal(f.evidence.receipts[0].caseSignature,f.job.caseSignature);assert.equal(f.evidence.receipts[0].applicantIndex,f.job.applicantIndex);
 assert.ok(f.evidence.entryInputs.every(x=>x.code===''));assert.ok(f.evidence.otpInputs.every(x=>x.code===''));
 const replay=f.input(challenge,'synthetic-replayed-otp');assert.equal((await f.fulfilment.consumeOtp(replay)).ok,false);assert.equal(replay.text,'');
 assert.equal(f.evidence.requests.length,1);assert.equal(JSON.stringify(f.store.data).includes(CODE),false);
});

test('polling at the original deadline cannot create or send a fresh five-minute owner prompt',async t=>{
 rejectCodeLogging(t);
 const f=await setup();t.after(()=>f.worker.shutdown());const native=await f.launch();
 f.setNow(native.challengeExpiresAt);await f.poll();
 assert.equal(Object.values(f.fulfilment.data().challenges).length,0);assert.equal(f.evidence.prompts.length,0);
 assert.equal(f.evidence.requests.length,0);assert.equal(f.evidence.entries,0);assert.equal(f.evidence.saves,0);
 assert.equal(f.job.blockedReason,'RAAD_OTP_CONTEXT_STALE');
});

test('CAPTCHA delay beyond the original native deadline blocks Save after a single accepted OTP entry',async t=>{
 rejectCodeLogging(t);
 const f=await setup({captchaDelay:300001});t.after(()=>f.worker.shutdown());await f.launch();const challenge=await f.prompt();
 const inbound=f.input(challenge);await f.fulfilment.consumeOtp(inbound);
 const terminal=await f.waitFor(['blocked','lease_lost']);
 assert.equal(inbound.text,'');assert.equal(f.evidence.requests.length,1);assert.equal(f.evidence.entries,1);assert.equal(f.evidence.saves,0);
 assert.equal(terminal.blocker.code,'APPLICATION_SMS_CHALLENGE_STALE');assert.equal(terminal.submissionUncertain,false);
 assert.ok(f.evidence.entryInputs.every(x=>x.code===''));assert.ok(f.evidence.otpInputs.every(x=>x.code===''));
 assert.equal(JSON.stringify(f.store.data).includes(CODE),false);
});

test('a queued owner prompt also expires at the native deadline without a late outbound send',async t=>{
 rejectCodeLogging(t);
 const f=await setup();t.after(()=>f.worker.shutdown());const native=await f.launch();await f.poll();
 const challenge=Object.values(f.fulfilment.data().challenges).find(c=>c.jobId===f.job.id);assert.ok(challenge);
 f.setNow(native.challengeExpiresAt);await f.fulfilment.dispatchMessage(challenge.outboxMessageId);
 assert.equal(f.evidence.prompts.length,0);assert.equal(f.evidence.requests.length,0);assert.equal(f.evidence.entries,0);assert.equal(f.evidence.saves,0);
 assert.notEqual(f.fulfilment.data().outbox[challenge.outboxMessageId].state,'accepted');
});
