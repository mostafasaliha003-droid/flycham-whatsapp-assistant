'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {createPilot}=require('./server');
const {createProductionWorker}=require('./production-worker');
const MODE='non_submitting_test',PILOT='p'.repeat(43),BRIDGE='b'.repeat(43),TEST_BRIDGE='t'.repeat(43),TEST_MAIN='http://127.0.0.1:19091/';
const isolatedEnv=()=>({RAAD_JOB_BRIDGE_KEY:BRIDGE,RAAD_EXECUTION_MODE:MODE,RAAD_TEST_JOB_BRIDGE_KEY:TEST_BRIDGE,RAAD_TEST_MAIN_URL:TEST_MAIN});
function manifest(){const bytes=Buffer.from('synthetic_document_bytes_only');return {jobId:'non_submit_test_job',caseId:'synthetic_case',leaseToken:'synthetic_lease_token_123456',caseSignature:'a'.repeat(64),applicantIndex:0,clientConsent:{granted:true,scope:'saudi_visa_application',caseSignature:'a'.repeat(64),messageId:'synthetic_consent',grantedAt:Date.now()},fields:{passportNumber:'TEST001'},documents:['passport','residence','portrait'].map(role=>({role,mimeType:'image/png',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}))};}
async function until(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setImmediate(r));}assert.fail('test worker did not settle');}
async function pilot(t,{mode=MODE,websocketFence=true,moveDuringFill=false,isolatedWorker=false}={}){
 const evidence={launches:0,closes:0,contextOptions:null,route:null,websocket:null,nativeTouches:0};let path='/Account/Loginindividuals';
 const page={url:()=> 'https://visa.mofa.gov.sa'+path,isClosed:()=>false,goto:async()=>{},locator:selector=>({count:async()=>1,isVisible:async()=>true,fill:async()=>{if(moveDuringFill&&selector==='#myform #Captcha')path='/SmartForm/TraditionalApp';},click:async()=>{evidence.nativeTouches++;}})};
 const context={route:async(_pattern,fn)=>{evidence.route=fn;},newPage:async()=>page,...(websocketFence?{routeWebSocket:async(_pattern,fn)=>{evidence.websocket=fn;}}:{})};
 const env={RAAD_PILOT_KEY:PILOT,RAAD_PILOT_ORIGIN:'https://pilot.example',RAAD_DIRECT_LOGIN_ENABLED:'true',RAAD_JOB_BRIDGE_KEY:BRIDGE,...(isolatedWorker?isolatedEnv():{}),...(mode===undefined?{}:{RAAD_EXECUTION_MODE:mode})};
 const app=createPilot({env,productionLeaseFetch:async()=>({ok:true,json:async()=>({current:true})}),launch:async()=>{evidence.launches++;return {newContext:async options=>{evidence.contextOptions=options;return context;},isConnected:()=>true,close:async()=>{evidence.closes++;}};}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await app.shutdown();app.server.closeAllConnections();});
 const call=async(action,data={},key=PILOT)=>{const response=await fetch(base+action,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:'https://pilot.example','Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,body:await response.json()};};
 return {app,env,evidence,call,setPath:value=>{path=value;},health:async()=>(await fetch(base+'/health')).json()};
}

test('invalid service/worker execution configuration fails before any browser or adapter admission',()=>{
 let launches=0,reserves=0;
 assert.throws(()=>createPilot({env:{RAAD_PILOT_KEY:PILOT,RAAD_PILOT_ORIGIN:'https://pilot.example',RAAD_EXECUTION_MODE:'non-submitting-test'},launch:()=>{launches++;}}),e=>e.code==='RAAD_EXECUTION_MODE_INVALID');
 assert.throws(()=>createProductionWorker({env:{RAAD_EXECUTION_MODE:''},adapter:{reserve(){reserves++;},call(){}}}),e=>e.code==='RAAD_EXECUTION_MODE_INVALID');assert.equal(launches,0);assert.equal(reserves,0);
});

test('direct authenticated HTTP cannot submit/confirm/navigate payment or downgrade test mode without a session',async t=>{
 const f=await pilot(t,{isolatedWorker:true});
 for(const [action,data]of [['/api/activate-control',{mode:'submit',label:'Save'}],['/api/activate-control',{mode:'next',label:'Continue'}],['/api/confirm-application',{label:'استمرار'}],['/api/open-page',{path:'/SmartForm/PayFee/123',label:'بيانات الدفع',viewPaymentDetails:true}],['/api/open-page',{path:'/Payment/Summary',label:'متابعة'}],['/api/start',{executionMode:'production'}],['/api/start',{fields:{allowSubmit:true}}]]){
  const r=await f.call(action,{sessionId:'not_a_session',...data});assert.equal(r.status,409);assert.match(r.body.error,/^RAAD_TEST_/);assert.equal(r.body.testStopped,true);assert.equal(r.body.submitted,false);assert.equal(r.body.submissionEnabled,false);
 }
 assert.equal(f.evidence.launches,0);assert.equal((await f.call('/api/save',{allowSubmit:true})).status,404);assert.equal((await f.call('/internal/raad/jobs/synthetic/save',{},TEST_BRIDGE)).status,404);assert.equal(f.evidence.launches,0);
});

test('health/session metadata stay in test mode after env mutation, and login actions cannot target an application form',async t=>{
 const f=await pilot(t);f.env.RAAD_EXECUTION_MODE='production';const h=await f.health();assert.equal(h.executionMode,MODE);assert.equal(h.production.executionMode,MODE);assert.equal(h.production.submissionEnabled,false);
 const start=await f.call('/api/start');assert.equal(start.status,200);assert.equal(start.body.executionMode,MODE);assert.equal(f.evidence.launches,1);
 f.setPath('/SmartForm/TraditionalApp');
 for(const action of ['/api/submit','/api/auto-login','/api/verify','/api/auto-verify']){const r=await f.call(action,{sessionId:start.body.sessionId,username:'synthetic',password:'synthetic',code:'123456'});assert.equal(r.status,409);assert.equal(r.body.error,'RAAD_TEST_SUBMISSION_BLOCKED');}
 const close=await f.call('/api/close',{sessionId:start.body.sessionId});assert.equal(close.status,200);assert.equal(close.body.closed,true);
});

test('test browser context blocks service workers, closes WebSockets, and aborts same-origin autosave/unknown requests',async t=>{
 const f=await pilot(t);const start=await f.call('/api/start');assert.equal(start.status,200);assert.deepEqual(f.evidence.contextOptions,{serviceWorkers:'block'});assert.equal(typeof f.evidence.websocket,'function');
 let continued=0,aborted=0,sockets=0;
 const req=(path,method,type='xhr')=>({url:()=> 'https://visa.mofa.gov.sa'+path,method:()=>method,resourceType:()=>type,redirectedFrom:()=>null,isNavigationRequest:()=>type==='document'});
 for(const request of [req('/SmartForm/TraditionalApp','POST'),req('/SmartForm/Save','POST'),req('/SmartForm?save=true','GET','document'),req('/Payment/Summary','GET','document'),req('/SmartForm/Unexpected','GET')])await f.evidence.route({request:()=>request,continue:()=>{continued++;},abort:()=>{aborted++;}});
 assert.equal(continued,0);assert.equal(aborted,5);
 await f.evidence.websocket({close:options=>{assert.equal(options.code,1008);sockets++;}});assert.equal(sockets,1);
 const current=await f.call('/api/current');assert.equal(current.status,409,'a blocked network request stops further native session work');assert.equal(current.body.error,'RAAD_TEST_NETWORK_BLOCKED');assert.equal(current.body.executionMode,MODE);
});

test('test mode refuses browser startup when the WebSocket fence capability is missing',async t=>{
 const f=await pilot(t,{websocketFence:false});const start=await f.call('/api/start');assert.equal(start.status,503);assert.equal(f.evidence.closes,1);assert.equal(f.app.productionWorker.health().activeJob,false);
});

test('an application-page change during awaited login fill cannot reuse the login submit route',async t=>{
 const f=await pilot(t,{moveDuringFill:true}),start=await f.call('/api/start');assert.equal(start.status,200);
 const r=await f.call('/api/submit',{sessionId:start.body.sessionId,username:'synthetic@example.test',password:'synthetic-not-a-secret',captcha:'AB12'});
 assert.equal(r.status,409);assert.equal(r.body.error,'RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(r.body.testStopped,true);assert.equal(f.evidence.nativeTouches,0);assert.equal(f.evidence.closes,1);
});

test('internal authenticated job HTTP rejects mode overrides and saved-application continuations before browser admission',async t=>{
 const f=await pilot(t,{isolatedWorker:true});
 for(const input of [{...manifest(),executionMode:'production'},{...manifest(),RAAD_TEST_MAIN_URL:'https://flycham-whatsapp-assistant.onrender.com/'},{...manifest(),RAAD_TEST_JOB_BRIDGE_KEY:BRIDGE},{...manifest(),existingApplicationReference:'E12345678'},{...manifest(),submissionUncertain:true}]){const r=await f.call('/internal/raad/jobs',input,TEST_BRIDGE);assert.equal(r.status,409);assert.match(r.body.error,/^RAAD_TEST_/);assert.equal(r.body.executionMode,MODE);}
 assert.equal(f.evidence.launches,0);
});

test('the shipped pilot UI start handler supplies an explicit JSON object accepted by test mode',async t=>{
 const f=await pilot(t),source=readFileSync(require.resolve('./app.js'),'utf8'),line=source.split('\n').find(value=>value.startsWith("$('start').onclick="));assert.ok(line);const start={};let body;
 vm.runInNewContext(line,{$:()=>start,run:async fn=>fn(1),clearImage(){},clearVerification(){},hideApplicationSms(){},message(){},guard(){},showState(){},showImage:async()=>{},automaticLogin:async()=>{},request:async(action,data)=>{assert.equal(action,'start');body=data;const response=await f.call('/api/start',data);assert.equal(response.status,200);return {json:async()=>response.body};}});
 await start.onclick();assert.equal(JSON.stringify(body),'{}');assert.equal(f.evidence.launches,1);
});

test('worker policy independently blocks submit/confirmation/payment/raw-page/unknown actions before adapter dispatch',async()=>{
 const attempts=[ctx=>ctx.api('activate-control',{mode:'submit',label:'Save'}),ctx=>ctx.api('activate-control',{mode:'next',label:'Continue'}),ctx=>ctx.api('confirm-application',{label:'استمرار'}),ctx=>ctx.api('open-page',{path:'/SmartForm/PayFee/123',viewPaymentDetails:true}),ctx=>ctx.api('unknown-save-action',{}),ctx=>ctx.withPage(()=>assert.fail('raw page unavailable')),ctx=>ctx.capturePdf({})];
 for(const attempt of attempts){let calls=0,closed=0;const worker=createProductionWorker({env:isolatedEnv(),leaseFetch:async()=>({ok:true,json:async()=>({current:true})}),adapter:{reserve:async()=> 'synthetic_reservation',call:async()=>{calls++;assert.fail('forbidden adapter call');},close:async()=>{closed++;return true;},release:async()=>{}},runFlow:attempt});await worker.start(manifest());const s=await until(()=>{const x=worker.status('non_submit_test_job');return x.stage==='blocked'?x:null;});assert.equal(s.testStopped,true);assert.equal(s.phase,'test_boundary');assert.equal(s.saved,false);assert.equal(s.applicationSubmitted,false);assert.equal(s.submissionUncertain,false);assert.equal(s.artifactReady,false);assert.equal(s.ownedBrowserClosed,true);assert.equal(calls,0);assert.equal(closed,1);await worker.shutdown();}
});

test('even a trusted injected flow claiming completion cannot issue a completed/saved artifact in test mode',async()=>{
 const worker=createProductionWorker({env:isolatedEnv(),leaseFetch:async()=>({ok:true,json:async()=>({current:true})}),adapter:{reserve:async()=> 'synthetic_reservation',call:async()=>{},close:async()=>true,release:async()=>{}},runFlow:async ctx=>{ctx.record.saved=true;ctx.record.reference='E123456';ctx.record.returnedFromPayment=true;ctx.record.artifact={buffer:Buffer.from('%PDF-synthetic'),sha256:'a'.repeat(64)};}});await worker.start(manifest());const s=await until(()=>{const x=worker.status('non_submit_test_job');return x.stage==='blocked'?x:null;});assert.equal(s.testStopped,true);assert.equal(s.saved,false);assert.equal(s.reference,null);assert.equal(s.artifactReady,false);assert.equal(s.applicationSubmitted,false);assert.throws(()=>worker.artifact('non_submit_test_job'),e=>e.code==='ARTIFACT_NOT_READY');await worker.shutdown();
});

test('a manual test pilot keeps its worker disabled without isolated callback/key and rejects the production bridge key',async t=>{
 const f=await pilot(t),h=await f.health();assert.equal(h.production.enabled,false);assert.equal(h.production.configurationBlocker,'RAAD_TEST_ISOLATED_MAIN_REQUIRED');
 assert.equal((await f.call('/internal/raad/jobs',manifest(),BRIDGE)).status,401);assert.equal(f.evidence.launches,0);
 assert.equal((await f.call('/api/start')).status,200,'manual fenced pilot is independently available');
});

test('configured test worker HTTP accepts only the separate test bridge credential',async t=>{
 const f=await pilot(t,{isolatedWorker:true});assert.equal((await f.health()).production.enabled,true);
 assert.equal((await f.call('/internal/raad/jobs',manifest(),BRIDGE)).status,401);
 const accepted=await f.call('/internal/raad/jobs',manifest(),TEST_BRIDGE);assert.equal(accepted.status,202);assert.equal(accepted.body.executionMode,MODE);assert.equal(accepted.body.applicationSubmitted,false);assert.equal(f.evidence.launches,0,'synthetic missing-field dossier stops before browser');
});

test('test worker refuses implicit/production main callback before reservation and snapshots all isolated transport settings',async()=>{
 let reserves=0;
 const adapter={reserve:async()=>{reserves++;return 'synthetic_reservation';},call:async()=>{},close:async()=>true,release:async()=>{}};
 for(const env of [{RAAD_EXECUTION_MODE:MODE,RAAD_JOB_BRIDGE_KEY:BRIDGE},{...isolatedEnv(),RAAD_MAIN_URL:'https://flycham-whatsapp-assistant.onrender.com/'},{...isolatedEnv(),RAAD_TEST_MAIN_URL:'https://flycham-whatsapp-assistant.onrender.com/',RAAD_TEST_APPROVED_MAIN_ORIGIN:'https://flycham-whatsapp-assistant.onrender.com'},{...isolatedEnv(),RAAD_TEST_JOB_BRIDGE_KEY:BRIDGE}]){
  const worker=createProductionWorker({env,adapter});assert.equal(worker.health().enabled,false);await assert.rejects(()=>worker.start(manifest()),e=>e.code==='RAAD_TEST_ISOLATED_MAIN_REQUIRED');await worker.shutdown();
 }
 assert.equal(reserves,0);
 const env={...isolatedEnv(),RAAD_TEST_MAIN_URL:'https://stage.example.test/',RAAD_TEST_APPROVED_MAIN_ORIGIN:'https://stage.example.test'},callbacks=[];
 const worker=createProductionWorker({env,adapter,leaseFetch:async(url,options)=>{callbacks.push({origin:new URL(url).origin,key:options.headers.Authorization});return {ok:true,json:async()=>({current:true})};},runFlow:async()=>{}});
 env.RAAD_EXECUTION_MODE='production';env.RAAD_TEST_MAIN_URL='https://flycham-whatsapp-assistant.onrender.com/';env.RAAD_TEST_APPROVED_MAIN_ORIGIN='https://flycham-whatsapp-assistant.onrender.com';env.RAAD_TEST_JOB_BRIDGE_KEY=BRIDGE;
 assert.equal(worker.health().enabled,true);assert.equal(worker.health().executionMode,MODE);await worker.start(manifest());await until(()=>worker.status('non_submit_test_job').stage==='blocked');
 assert.equal(callbacks.length,1);assert.equal(callbacks[0].origin,'https://stage.example.test');assert.equal(callbacks[0].key,'Bearer '+TEST_BRIDGE);await worker.shutdown();
});
