'use strict';
// Offline integration: real signed webhook function, coordinator, dispatcher,
// worker HTTP handler and lease callback. Government/browser/WhatsApp endpoints
// are synthetic. The native adapter throws before any application save.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {createRequire}=require('node:module');
const {createHmac}=require('node:crypto');
const vm=require('node:vm');
const {ConversationJournal}=require('../src/conversation-journal');
const {extractIncomingMessages,verifySignature}=require('../src/whatsapp');
const {SUPERVISOR_WHATSAPP_NUMBER:OWNER,SUPERVISOR_SMS_NUMBER:SMS}=require('../src/visa-supervisor-route');
const CODE='847392',SECRET='synthetic_loopback_webhook_secret_no_live_value';
const START=Date.parse('2026-10-31T08:00:00Z');
const FIELDS=['challengeId','challengeRequestedAt','challengeExpiresAt','accountBinding'];
const tuple=value=>Object.fromEntries(FIELDS.map(key=>[key,value[key]]));
async function readRaw(req,max=4500000){const parts=[];let size=0;for await(const p of req){size+=p.length;if(size>max)throw Error('TEST_BODY_TOO_LARGE');parts.push(p);}return Buffer.concat(parts);}
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;}
async function until(predicate,label){for(let i=0;i<500;i++){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('loopback did not settle: '+label);}

async function fixture(t,{nonSubmitting=false}={}){
 const evidence={nativeEntries:0,saveBoundaries:0,otpPosts:0,leaseGets:0,feedback:[],outbound:[],errors:[],consumes:[]};
 for(const method of ['info','log','warn','error'])t.mock.method(console,method,(...args)=>assert.equal(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ').includes(CODE),false,'OTP cannot be logged'));
 let f,mainBase,workerBase,nativeWindow;
 const pairPath=join(__dirname,'../scripts/raad-paired-candidates-check.cjs');
 const source=readFileSync(pairPath,'utf8');
 let prefix=source.slice(0,source.indexOf('\ntest('));
 if(nonSubmitting){const workerEnv="env:{RAAD_JOB_BRIDGE_KEY:KEY}";assert.equal(prefix.split(workerEnv).length,2);prefix=prefix.replace(workerEnv,"env:{RAAD_JOB_BRIDGE_KEY:KEY,RAAD_EXECUTION_MODE:'non_submitting_test',RAAD_TEST_MAIN_URL:'http://127.0.0.1:19091/',RAAD_TEST_JOB_BRIDGE_KEY:'synthetic_test_bridge_key_'.repeat(3)}");}
 assert.ok(prefix.includes('function fixture(options={})'));
 const leaseStart=prefix.indexOf('leaseFetch:async(url,request)=>{');
 const leaseEnd=prefix.indexOf('\n }});',leaseStart);
 assert.ok(leaseStart>0&&leaseEnd>leaseStart,'paired fixture lease adapter anchor');
 prefix=prefix.slice(0,leaseStart)+'leaseFetch:loopbackLeaseFetch'+prefix.slice(leaseEnd+3);
 const accessor='settle,now:()=>at};';
 assert.equal(prefix.split(accessor).length,2,'paired fixture clock anchor');
 prefix=prefix.replace(accessor,'settle,now:()=>at,setNow:value=>{at=value;}};');
 const wrapAdapter=adapter=>{
  const original=adapter.call;
  adapter.call=async(action,data,context)=>{
   if(action==='request-application-sms'){
    nativeWindow={challengeId:'loopback_native_challenge',challengeRequestedAt:f.now(),challengeExpiresAt:f.now()+300000,accountBinding:'b'.repeat(64)};
    return {activationDispatched:true,...nativeWindow,smsRequest:{requestObserved:true,destinationMatch:'matched',responseObserved:true,responseClass:'2xx',acceptance:'accepted'}};
   }
   if(action==='enter-application-sms'){assert.equal(data.code,CODE);assert.deepEqual(tuple(data),nativeWindow);evidence.nativeEntries++;return {codeEntered:true};}
   if(action==='refresh-form-captcha')return {refreshed:true};
   if(action==='solve-form-captcha')return {solved:true};
   if(action==='activate-control'&&data.mode==='submit'){evidence.saveBoundaries++;throw Object.assign(Error('SYNTHETIC_STOP_BEFORE_SAVE'),{code:'SYNTHETIC_STOP_BEFORE_SAVE'});}
   const result=await original(action,data,context);
   if(action==='inspect-page')result.inspection.buttons=[{id:'testSaveBoundary',label:'Save',disabled:false}];
   return result;
  };return adapter;
 };
 const leaseFetch=async(url,request)=>{assert.equal(new URL(url).origin,nonSubmitting?'http://127.0.0.1:19091':'https://flycham-whatsapp-assistant.onrender.com');return fetch(mainBase+new URL(url).pathname,request);};
 const make=vm.runInThisContext('(function(require,wrapAdapter,loopbackLeaseFetch){'+prefix+'\nconst originalNativeAdapter=nativeAdapter;nativeAdapter=options=>wrapAdapter(originalNativeAdapter(options));return fixture;})',{filename:pairPath+'#loopback-fixture'})(createRequire(pairPath),wrapAdapter,leaseFetch);
 f=await make({now:START});
 if(nonSubmitting)f.dispatcher.env.RAAD_JOB_BRIDGE_KEY='synthetic_test_bridge_key_'.repeat(3);
 const originalConsume=f.fulfilment.consumeOtp.bind(f.fulfilment);
 f.fulfilment.consumeOtp=async input=>{const result=await originalConsume(input);evidence.consumes.push(result);return result;};
 f.fulfilment.resumeOtp=input=>f.dispatcher.resumeOtp(input);
 f.fulfilment.send=async(to,payload,guard)=>{await guard();evidence.outbound.push({to,payload});return {messageId:'synthetic_loopback_prompt_'+evidence.outbound.length};};
 f.store.save=()=>assert.equal(JSON.stringify(f.store.data).includes(CODE),false,'OTP never enters durable state');
 const journal=new ConversationJournal({store:f.store,now:f.now});
 const serverSource=readFileSync(require.resolve('../src/server'),'utf8');
 const handlerSource=serverSource.slice(serverSource.indexOf('async function handleWebhookPost('),serverSource.indexOf('\nfunction customerSearchActive'));
 const accepted=new Set();
 const context=vm.createContext({
  process:{env:{NODE_ENV:'production',WHATSAPP_APP_SECRET:SECRET}},Buffer,readBody:readRaw,verifySignature,extractIncomingMessages,
  recordDeliveryStatuses(){},assistant:{store:f.store},journal,complaints:{handleReceipt(){}},visaFulfilment:f.fulfilment,
  quoteJobs:{acceptMessage(id){if(accepted.has(id))return false;accepted.add(id);return true;},save(){}},noteIncoming(){},wakeVisa(){},
  rawSendTextMessage:async(to,text)=>{evidence.feedback.push({to,text});}
 });
 vm.runInContext(handlerSource+'\nthis.webhook=handleWebhookPost;',context);
 const main=http.createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='POST'&&path==='/webhook'){await context.webhook(req,res);return;}
  if(req.method==='GET'&&path==='/internal/assistant/visa-portal/jobs/'+f.job.id+'/lease'){
   evidence.leaseGets++;let current=false;
   if(req.headers.authorization==='Bearer '+f.dispatcher.env.RAAD_JOB_BRIDGE_KEY)try{f.fulfilment.guardLease(f.job.id,req.headers['x-raad-lease-token']);current=true;}catch{}
   res.writeHead(current?200:403,{'Content-Type':'application/json'}).end(JSON.stringify({current}));return;
  }
  res.writeHead(404).end();
 }catch(error){evidence.errors.push(error.code||error.name);if(!res.headersSent)res.writeHead(500);res.end();}});
 const worker=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ready:true,production:f.worker.health()}));return;}
  if(url.pathname.endsWith('/otp')&&req.method==='POST')evidence.otpPosts++;
  if(!await f.worker.handler(req,res,url,{readBody:async(request,max)=>JSON.parse((await readRaw(request,max)).toString('utf8'))}))res.writeHead(404).end();
 }catch(error){evidence.errors.push(error.code||error.name);if(!res.headersSent)res.writeHead(500);res.end();}});
 t.after(async()=>{await f.worker.shutdown();main.closeAllConnections();worker.closeAllConnections();await Promise.all([new Promise(resolve=>main.close(resolve)),new Promise(resolve=>worker.close(resolve))]);});
 mainBase=await listen(main);workerBase=await listen(worker);
 f.dispatcher.fetchImpl=async(url,request)=>{assert.equal(new URL(url).origin,'https://synthetic-worker.example.test');return fetch(workerBase+new URL(url).pathname,request);};
 const inbound=async({sender=OWNER,contextId,id='synthetic_loopback_inbound',signature=true,text=CODE}={})=>{
  const body=Buffer.from(JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[{from:sender,id,type:'text',text:{body:text},context:{id:contextId}}]}}]}]}));
  const signed='sha256='+createHmac('sha256',SECRET).update(body).digest('hex');
  const response=await fetch(mainBase+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':signature?signed:'sha256='+'0'.repeat(64)},body});
  body.fill(0);await response.arrayBuffer();return response.status;
 };
 const launch=async()=>{
  await f.dispatcher.launch(f.job);
  await until(()=>f.worker.status(f.job.id).stage==='waiting_otp','native wait');
  await f.dispatcher.poll(f.job,f.store.data.visaPortalRuns[f.job.id]);
  const challenge=Object.values(f.fulfilment.data().challenges).find(c=>c.jobId===f.job.id);assert.ok(challenge);
  await f.fulfilment.dispatchMessage(challenge.outboxMessageId);return challenge;
 };
 const workerOtp=body=>fetch(workerBase+'/internal/raad/jobs/'+f.job.id+'/otp',{method:'POST',headers:{Authorization:'Bearer '+f.dispatcher.env.RAAD_JOB_BRIDGE_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {...f,evidence,journal,inbound,launch,workerOtp,window:()=>nativeWindow};
}

test('signed WhatsApp-shaped reply crosses two loopback services once with exact native/job/sender bindings and no real save',async t=>{
 const f=await fixture(t),challenge=await f.launch();
 assert.equal(challenge.owner,OWNER);assert.deepEqual(tuple({...challenge,challengeId:challenge.portalChallengeId}),f.window());
 const filled=f.adapter.calls.filter(c=>c.action==='fill-draft').flatMap(c=>c.data.fields);
 assert.equal(filled.find(c=>c.id==='MobileInfo_Mobile').value,SMS.slice(3));
 assert.equal(filled.find(c=>c.id==='EmbassyCode').value,'214','synthetic Abu Dhabi option selected');
 assert.equal(await f.inbound({contextId:challenge.messageId}),200);
 await until(()=>f.evidence.consumes.length===1,'OTP consume');
 assert.equal(f.evidence.consumes[0].ok,true);
 await until(()=>f.worker.status(f.job.id).stage==='blocked','synthetic save boundary');
 assert.equal(f.evidence.nativeEntries,1);assert.equal(f.evidence.otpPosts,1);assert.equal(f.evidence.saveBoundaries,1);
 assert.ok(f.evidence.leaseGets>1);assert.equal(f.worker.status(f.job.id).saved,false);assert.equal(f.c.submissionStatus,'not_submitted');
 assert.equal(JSON.stringify(f.store.data).includes(CODE),false);assert.equal(JSON.stringify(f.journal.data).includes(CODE),false);
 assert.equal(await f.inbound({contextId:challenge.messageId,id:'synthetic_replay'}),200);
 await until(()=>f.evidence.consumes.length===2,'replay consume');assert.equal(f.evidence.consumes[1].ok,false);
 assert.equal(f.evidence.nativeEntries,1);assert.equal(f.evidence.otpPosts,1);assert.deepEqual(f.evidence.errors,[]);
});

test('HTTP signature, sender and reply-context failures cannot reach the worker OTP endpoint',async t=>{
 const f=await fixture(t),challenge=await f.launch();
 assert.equal(await f.inbound({signature:false,contextId:challenge.messageId,id:'bad_signature'}),401);
 assert.equal(f.evidence.consumes.length,0);
 assert.equal(await f.inbound({sender:'15550009991',contextId:challenge.messageId,id:'wrong_sender'}),200);
 assert.equal(await f.inbound({contextId:'unrelated_prompt',id:'wrong_context'}),200);
 await until(()=>f.evidence.consumes.length===2,'invalid consumes');
 assert.deepEqual(f.evidence.consumes.map(x=>x.reason),['OTP_SENDER_INVALID','OTP_NOT_PENDING']);
 assert.equal(f.evidence.otpPosts,0);assert.equal(f.evidence.nativeEntries,0);assert.equal(JSON.stringify(f.store.data).includes(CODE),false);
 assert.deepEqual(f.evidence.errors,[]);
});

test('worker HTTP rejects altered account/deadline/request tuple before accepting one exact handoff, then rejects replay',async t=>{
 const f=await fixture(t);await f.launch();
 for(const patch of [{challengeId:'wrong_native_request'},{challengeRequestedAt:f.window().challengeRequestedAt-1},{challengeExpiresAt:f.window().challengeExpiresAt+1},{accountBinding:'c'.repeat(64)}]){
  const response=await f.workerOtp({...f.window(),code:CODE,...patch});assert.equal(response.status,409);await response.arrayBuffer();
 }
 assert.equal(f.evidence.nativeEntries,0);
 const response=await f.workerOtp({...f.window(),code:CODE});assert.equal(response.status,202);
 const accepted=await response.json();assert.equal(accepted.accepted,true);assert.equal(accepted.otpReceipt.jobId,f.job.id);assert.deepEqual(tuple(accepted.otpReceipt),f.window());
 await until(()=>f.worker.status(f.job.id).stage==='blocked','native boundary');
 const replay=await f.workerOtp({...f.window(),code:CODE});assert.equal(replay.status,409);await replay.arrayBuffer();
 assert.equal(f.evidence.nativeEntries,1);assert.equal(f.evidence.saveBoundaries,1);assert.deepEqual(f.evidence.errors,[]);
});

test('signed inbound exactly at original native expiry stays redacted and never posts an OTP to worker',async t=>{
 const f=await fixture(t),challenge=await f.launch();f.setNow(f.window().challengeExpiresAt);
 assert.equal(await f.inbound({contextId:challenge.messageId}),200);
 await until(()=>f.evidence.consumes.length===1,'expired consume');assert.equal(f.evidence.consumes[0].ok,false);
 assert.equal(f.evidence.otpPosts,0);assert.equal(f.evidence.nativeEntries,0);assert.equal(f.evidence.saveBoundaries,0);
 assert.equal(JSON.stringify(f.store.data).includes(CODE),false);assert.deepEqual(f.evidence.errors,[]);
});

test('non-submitting worker mode accepts the bound loopback OTP, then stops before any save call and cannot report completion',async t=>{
 const f=await fixture(t,{nonSubmitting:true}),challenge=await f.launch();
 assert.equal(f.worker.health().executionMode,'non_submitting_test');assert.equal(f.worker.health().submissionEnabled,false);
 assert.equal(await f.inbound({contextId:challenge.messageId}),200);
 await until(()=>f.evidence.consumes.length===1,'test OTP consume');assert.equal(f.evidence.consumes[0].ok,true);
 const state=await until(()=>{const s=f.worker.status(f.job.id);return s.stage==='blocked'?s:null;},'test stop');
 assert.equal(state.blocker.code,'RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(state.phase,'test_boundary');assert.equal(state.testStopped,true);
 assert.equal(state.saved,false);assert.equal(state.applicationSubmitted,false);assert.equal(state.reference,null);assert.equal(state.submissionUncertain,false);assert.equal(state.artifactReady,false);assert.equal(state.ownedBrowserClosed,true);
 assert.equal(f.evidence.nativeEntries,1);assert.equal(f.evidence.otpPosts,1);assert.equal(f.evidence.saveBoundaries,0);
 assert.equal(f.adapter.calls.some(c=>c.action==='confirm-application'),false);assert.equal(f.c.submissionStatus,'not_submitted');
 assert.equal(JSON.stringify(f.store.data).includes(CODE),false);assert.deepEqual(f.evidence.errors,[]);
});
