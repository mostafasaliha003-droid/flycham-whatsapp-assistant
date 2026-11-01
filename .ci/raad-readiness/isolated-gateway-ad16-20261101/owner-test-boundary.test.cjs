'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHmac}=require('node:crypto'),{EventEmitter}=require('node:events');
const {createOwnerTestBoundary,OWNER,SOURCE_TREE,OPEN_TEXT,TEXT}=require('./owner-test-boundary.cjs');
const {createPinnedMetaTransport}=require('./pinned-meta-transport.cjs');
const baseTime=1793512800000;
const binding={sessionId:'test_session_a',jobId:'test_job_a',applicantId:'test_applicant_a',challengeId:'test_challenge_a'};
function setup(options={}){
 let at=baseTime,calls=[],dispatches=[];
 const config={mode:'offline_injected',sourceTree:SOURCE_TREE,owner:OWNER,wabaId:'111222333',phoneNumberId:'123456789',appSecret:'synthetic-boundary-signing-secret-only',dedicatedTestIdentityVerified:true,zeroCostEligibilityVerified:true,...options.config};
 const transport={kind:'offline_injected',sendOwnerText:async input=>{calls.push(input);if(options.send)return options.send(input,calls.length,()=>{at+=300000;});return{recipient:OWNER,messageId:'wamid.synthetic.test.'+calls.length};}};
 const dispatch={kind:'synthetic_boundary_only',execute:async input=>{dispatches.push(input);return options.dispatch?options.dispatch(input):{...binding,code:'RAAD_TEST_SUBMISSION_BLOCKED'};}};
 const b=createOwnerTestBoundary({enabled:true,config,transport,dispatch,now:options.now||(()=>at)});
 function envelope({id='wamid.synthetic.inbound.'+Math.random(),text=OPEN_TEXT,owner=OWNER,waba=config.wabaId,phone=config.phoneNumberId,context,timestamp=at}={}){
  const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phone},messages:[{from:owner,id,type:'text',timestamp:String(Math.floor(timestamp/1000)),...(context?{context:{id:context}}:{}),text:{body:text}}]}}]}]}));
  return[raw,'sha256='+createHmac('sha256',config.appSecret).update(raw).digest('hex')];
 }
 const open=async()=>{b.start(binding);return b.ingest(...envelope());};
 const reply=()=>envelope({text:b.privateTestCode(b.operatorCapability),context:'wamid.synthetic.test.1'});
 return{b,calls,dispatches,config,envelope,open,reply,setTime:value=>{at=value;}};
}
test('default disabled and real adapter cannot be enabled by an environment-like flag',()=>{
 assert.throws(()=>createOwnerTestBoundary().start(binding),{code:'ISOLATED_TEST_DISABLED'});
 const s=setup({config:{mode:'real_meta'}});assert.throws(()=>s.b.start(binding),{code:'ISOLATED_TEST_DISABLED'});
});
test('missing identity or zero-cost confirmation fails closed',()=>{
 for(const key of ['dedicatedTestIdentityVerified','zeroCostEligibilityVerified']){const s=setup({config:{[key]:false}});assert.throws(()=>s.b.start(binding),{code:'ISOLATED_TEST_DISABLED'});}
});
test('one signed owner exchange reaches only synthetic stop, two outbound attempts, no exposed code',async()=>{
 const s=setup();await s.open();const r=await s.b.ingest(...s.reply());
 assert.equal(r.code,'RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(s.dispatches.length,1);assert.equal(s.calls.length,2);
 assert.deepEqual(s.dispatches[0].capabilities,{government:false,payment:false,models:false,browser:false});
 assert.equal(s.b.snapshot().stage,'completed');assert.equal(s.b.snapshot().actualMainEntrypointIntegrated,false);
 assert.throws(()=>s.b.privateTestCode(s.b.operatorCapability),{code:'PRIVATE_OPERATOR_REQUIRED'});
 assert.ok(!Object.keys(s.b.snapshot()).some(k=>/code|secret|token/i.test(k)));
});
test('invalid signature leaves authenticated inbound and outbound budgets untouched',async()=>{
 const s=setup();s.b.start(binding);const [raw]=s.envelope();
 await assert.rejects(s.b.ingest(raw,'sha256='+'0'.repeat(64)),{code:'WEBHOOK_SIGNATURE_INVALID'});
 assert.equal(s.b.snapshot().ingressAttempts,0);assert.equal(s.calls.length,0);
});
test('signed foreign owner, WABA and phone fail before outbound or dispatch',async()=>{
 for(const override of [{owner:'15550000099'},{waba:'999999999'},{phone:'999999999'}]){
  const s=setup();s.b.start(binding);await assert.rejects(s.b.ingest(...s.envelope(override)));assert.equal(s.calls.length,0);assert.equal(s.dispatches.length,0);
 }
});
test('config is copied and cannot silently switch sender identity after construction',async()=>{
 const s=setup();s.config.wabaId='999999999';s.b.start(binding);
 await assert.rejects(s.b.ingest(...s.envelope()),{code:'WEBHOOK_SCOPE_INVALID'});assert.equal(s.calls.length,0);
});
test('wrong context does not consume correct challenge or dispatch',async()=>{
 const s=setup();await s.open();await assert.rejects(s.b.ingest(...s.envelope({text:'not a code',context:'wamid.synthetic.foreign'})),{code:'TEST_REPLY_CONTEXT_MISMATCH'});
 assert.equal(s.b.snapshot().consumed,false);assert.equal(s.dispatches.length,0);await s.b.ingest(...s.reply());assert.equal(s.dispatches.length,1);
});
test('replayed owner opening does not create a second prompt',async()=>{
 const s=setup();s.b.start(binding);const e=s.envelope();await s.b.ingest(...e);
 await assert.rejects(s.b.ingest(...e),{code:'TEST_REPLAY_REJECTED'});assert.equal(s.calls.length,1);
});
test('two simultaneous valid replies consume and dispatch once',async()=>{
 const s=setup();await s.open();const a=s.reply(),b=s.reply();const rs=await Promise.allSettled([s.b.ingest(...a),s.b.ingest(...b)]);
 assert.equal(rs.filter(v=>v.status==='fulfilled').length,1);assert.equal(s.dispatches.length,1);assert.equal(s.calls.length,2);
});
test('invalid correlated code is terminal, not a brute-force retry',async()=>{
 const s=setup();await s.open();await assert.rejects(s.b.ingest(...s.envelope({text:'bad code',context:'wamid.synthetic.test.1'})),{code:'TEST_CODE_REJECTED'});
 assert.equal(s.b.snapshot().consumed,true);assert.equal(s.dispatches.length,0);assert.equal(s.calls.length,1);
 await assert.rejects(s.b.ingest(...s.envelope({text:'another',context:'wamid.synthetic.test.1'})),{code:'TEST_CHALLENGE_NOT_ACTIVE'});
});
test('original five-minute deadline and clock rollback invalidate the code',async()=>{
 for(const value of [baseTime+300000,baseTime-1]){const s=setup();await s.open();const r=s.reply();s.setTime(value);await assert.rejects(s.b.ingest(...r),{code:'TEST_SESSION_EXPIRED'});assert.equal(s.dispatches.length,0);}
});
test('slow prompt cannot extend expiry or silently retry an unknown send',async()=>{
 const s=setup({send:async(_x,_n,advance)=>{advance();return{recipient:OWNER,messageId:'wamid.synthetic.slow'};}});
 await assert.rejects(s.open(),{code:'TEST_PROMPT_UNCONFIRMED'});assert.equal(s.calls.length,1);assert.equal(s.b.snapshot().stage,'expired');
});
test('unknown prompt outcome is charged once and halts',async()=>{
 const s=setup({send:async()=>{throw Error('synthetic timeout');}});await assert.rejects(s.open(),{code:'TEST_PROMPT_UNCONFIRMED'});
 assert.equal(s.b.snapshot().outboundAttempts,1);assert.equal(s.b.snapshot().stage,'halted');assert.equal(s.dispatches.length,0);
});
test('mismatched dispatch receipt cannot claim completion or send success acknowledgement',async()=>{
 const s=setup({dispatch:async()=>({...binding,jobId:'test_other',code:'RAAD_TEST_SUBMISSION_BLOCKED'})});await s.open();
 await assert.rejects(s.b.ingest(...s.reply()),{code:'TEST_HANDOFF_UNCONFIRMED'});assert.equal(s.calls.length,1);assert.equal(s.b.snapshot().stage,'halted');
});
test('operator cancellation and single-session admission do not restore state',async()=>{
 const s=setup();await s.open();assert.throws(()=>s.b.cancel({}),{code:'PRIVATE_OPERATOR_REQUIRED'});s.b.cancel(s.b.operatorCapability);
 assert.throws(()=>s.b.privateTestCode(s.b.operatorCapability),{code:'TEST_SESSION_CANCELLED'});assert.throws(()=>s.b.start(binding),{code:'TEST_SESSION_ALREADY_EXISTS'});
});
test('new instance has no restart restoration or previous challenge',async()=>{
 const a=setup();await a.open();const b=setup();await assert.rejects(b.b.ingest(...a.reply()),{code:'TEST_SESSION_MISSING'});
});
function transportConfig(){return{graphVersion:'v23.0',phoneNumberId:'123456789',accessToken:'synthetic-test-token-not-a-credential',attestation:{kind:'operator_verified_dedicated_test_identity',owner:OWNER,phoneNumberId:'123456789',zeroCostEligible:true,verifiedAt:baseTime,expiresAt:baseTime+300000}};}
function responseRequest(status,body,capture){return(options,callback)=>{
 const req=new EventEmitter();req.destroy=()=>{};req.end=bytes=>{capture.push({options,body:JSON.parse(bytes)});queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.resume=()=>{};res.destroy=()=>{};callback(res);if(status===200){res.emit('data',Buffer.from(JSON.stringify(body)));res.emit('end');}});};return req;
};}
test('native transport is default disabled and does not disclose its credential in status',async()=>{
 const t=createPinnedMetaTransport({config:transportConfig(),now:()=>baseTime});await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_TRANSPORT_DISABLED'});
 assert.equal(JSON.stringify(t.status()).includes('synthetic-test-token'),false);
});
test('injected transport pins host, TLS, owner and allowed text; never follows redirect or auto-retries',async()=>{
 const capture=[],t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,requestImpl:responseRequest(200,{messaging_product:'whatsapp',contacts:[{wa_id:OWNER}],messages:[{id:'wamid.synthetic.accepted'}]},capture)});
 await t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt});const x=capture[0];assert.equal(x.options.hostname,'graph.facebook.com');assert.equal(x.options.rejectUnauthorized,true);assert.equal(x.options.minVersion,'TLSv1.2');assert.equal(x.body.to,OWNER);
 await assert.rejects(t.sendOwnerText({owner:'15550000099',purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_MESSAGE_SCOPE_INVALID'});
 const redirects=[],r=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,requestImpl:responseRequest(302,{},redirects)});
 await assert.rejects(r.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_RESPONSE_UNCONFIRMED'});assert.equal(redirects.length,1);assert.equal(r.status().attempts,1);
});
test('transport reserves attempts and enforces hard maximum two',async()=>{
 const calls=[],t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,requestImpl:responseRequest(500,{},calls)});
 for(let i=0;i<2;i++)await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}));
 await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_MESSAGE_LIMIT'});assert.equal(calls.length,2);
});
test('transport rejects foreign provider acceptance and expired attestation',async()=>{
 const calls=[],t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,requestImpl:responseRequest(200,{messaging_product:'whatsapp',contacts:[{wa_id:'15550000099'}],messages:[{id:'wamid.synthetic.accepted'}]},calls)});
 await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_RESPONSE_UNCONFIRMED'});
 const e=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime+300000,requestImpl:()=>assert.fail('must not invoke')});
 await assert.rejects(e.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_ATTESTATION_EXPIRED'});
});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
test('cancellation during pending prompt cannot revive challenge',async()=>{
 const entered=deferred(),release=deferred(),s=setup({send:async()=>{entered.resolve();await release.promise;return{recipient:OWNER,messageId:'wamid.synthetic.pending'};}});
 const p=s.open();await entered.promise;s.b.cancel(s.b.operatorCapability);release.resolve();
 await assert.rejects(p,{code:'TEST_PROMPT_UNCONFIRMED'});assert.equal(s.b.snapshot().stage,'cancelled');assert.equal(s.calls.length,1);assert.equal(s.dispatches.length,0);
});
test('cancellation during dispatch cannot send acknowledgement or claim completion',async()=>{
 const entered=deferred(),release=deferred(),s=setup({dispatch:async()=>{entered.resolve();await release.promise;return{...binding,code:'RAAD_TEST_SUBMISSION_BLOCKED'};}});
 await s.open();const p=s.b.ingest(...s.reply());await entered.promise;s.b.cancel(s.b.operatorCapability);release.resolve();
 await assert.rejects(p,{code:'TEST_HANDOFF_UNCONFIRMED'});assert.equal(s.b.snapshot().stage,'cancelled');assert.equal(s.calls.length,1);assert.equal(s.dispatches.length,1);
});
test('oversize input and pending queue are bounded before copying/processing',async()=>{
 const entered=deferred(),release=deferred(),s=setup({send:async()=>{entered.resolve();await release.promise;return{recipient:OWNER,messageId:'wamid.synthetic.pending'};}});
 await assert.rejects(s.b.ingest(Buffer.alloc(16385),'ignored'),{code:'WEBHOOK_BODY_INVALID'});
 const p=s.open();await entered.promise;const pending=[];
 for(let i=0;i<32;i++)pending.push(s.b.ingest(...s.envelope()).catch(e=>e.code));
 assert.equal(await pending.at(-1),'TEST_QUEUE_LIMIT');s.b.cancel(s.b.operatorCapability);release.resolve();await assert.rejects(p);await Promise.all(pending);assert.equal(s.calls.length,1);
});
test('invalid subsequent clock and array-lookalike envelope fail closed',async()=>{
 const s=setup();await s.open();const r=s.reply();s.setTime(NaN);await assert.rejects(s.b.ingest(...r),{code:'TEST_SESSION_EXPIRED'});
 const a=setup();a.b.start(binding);const [raw]=a.envelope(),v=JSON.parse(raw);v.entry={0:v.entry[0],length:1};const bytes=Buffer.from(JSON.stringify(v));
 await assert.rejects(a.b.ingest(bytes,'sha256='+createHmac('sha256',a.config.appSecret).update(bytes).digest('hex')),{code:'WEBHOOK_SCOPE_INVALID'});assert.equal(a.calls.length,0);
});
test('a clock invalidated or expired between session admission and message validation cannot reach dispatch',async()=>{
 for(const bad of [NaN,baseTime+300000]){
  let invalid=false,samples=0;const s=setup({now:()=>invalid?(++samples===1?baseTime:bad):baseTime});
  await s.open();const e=s.reply();invalid=true;
  await assert.rejects(s.b.ingest(...e),{code:'TEST_SESSION_EXPIRED'});assert.equal(s.dispatches.length,0);assert.equal(s.calls.length,1);assert.equal(s.b.snapshot().stage,'expired');
 }
});
test('transport absolute deadline rejects an incomplete/trickling response without retry',async()=>{
 let destroyed=0;const t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,timeoutMs:5,requestImpl:(_opts,callback)=>{const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};callback(res);res.emit('data',Buffer.from('{'));};return req;}});
 await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_REQUEST_UNCERTAIN'});assert.equal(t.status().attempts,1);assert.equal(destroyed,1);
});
test('aborted and prematurely closed provider responses cannot hang',async()=>{
 for(const event of ['aborted','close']){const t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>baseTime,requestImpl:(_o,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};cb(res);queueMicrotask(()=>res.emit(event));};return req;}});await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_RESPONSE_UNCONFIRMED'});}
});
test('expired or invalid clock at response cannot confirm provider acceptance',async()=>{
 for(const expired of [baseTime+300000,NaN]){let at=baseTime;const t=createPinnedMetaTransport({enabled:true,config:transportConfig(),now:()=>at,requestImpl:(_o,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};cb(res);at=expired;res.emit('data',Buffer.from(JSON.stringify({messaging_product:'whatsapp',contacts:[{wa_id:OWNER}],messages:[{id:'wamid.synthetic.accepted'}]})));res.emit('end');};return req;}});await assert.rejects(t.sendOwnerText({owner:OWNER,purpose:'prompt',text:TEXT.prompt}),{code:'META_TEST_ATTESTATION_EXPIRED'});}
});
test('instrumented native network calls remain zero',()=>{assert.equal(globalThis[Symbol.for('remal.gateway.test.network')](),0);});
