'use strict';
// New local lab scenario, using the frozen fixture setup with synthetic, pre-reviewed
// state. This does not test intake, Meta delivery, a browser, SMS, or Render.
// The production-flow DI stops at the real non-submission policy boundary.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const FREEZE=process.env.INTEGRATION_LAB_FREEZE;
const {verifyApprovedSource}=require('./lab-boundary.cjs');
const APP=verifyApprovedSource({source:process.env.INTEGRATION_LAB_SOURCE,freeze:FREEZE}).source;
if(typeof APP!=='string'||!path.isAbsolute(APP))throw Error('LAB_EXPLICIT_SOURCE_REQUIRED');
const requireApp=require('node:module').createRequire(path.join(APP,'package.json'));
const {createSessionGate,createLoopbackTransport,REAL_META_ENABLED}=require('./lab-boundary.cjs');
const CUSTOMER='15550004801';
const {SUPERVISOR_WHATSAPP_NUMBER:OWNER}=requireApp('./src/visa-supervisor-route');
const CODE='482719';
const SECRET='synthetic-full-router-webhook-secret';
const STATE_KEY='synthetic-full-router-encrypted-state-key';
const BRIDGE='synthetic-full-router-test-bridge-key-xxxxxxxxxxxxxxxx';
const WORKER_ORIGIN='https://synthetic-worker.example.test';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const atField=(object,field)=>field.split('.').reduce((value,key)=>value?.[key],object);
const tuple=value=>Object.fromEntries(['challengeId','challengeRequestedAt','challengeExpiresAt','accountBinding'].map(key=>[key,value[key]]));

async function listen(server){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+server.address().port;
}
async function until(predicate,label){
  for(let i=0;i<1600;i++){
    const value=await predicate();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('bounded full-router fixture did not settle: '+label);
}
function request(base,route,{method='GET',body,headers={}}={}){
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const url=new URL(route,base);
    assert.equal(url.hostname,'127.0.0.1');
    const req=http.request(url,{method,headers:{...(bytes?{'Content-Type':'application/json'}:{}),...headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        const text=Buffer.concat(chunks).toString();let json;
        try{json=JSON.parse(text);}catch{}
        resolve({status:res.statusCode,json});
      });
    });
    req.on('error',reject);req.end(bytes);
  });
}

async function seedReadyCase(file,env){
  const {AssistantState}=requireApp('./src/assistant-state');
  const {VisaMediaStore}=requireApp('./src/visa-media');
  const {ConversationJournal}=requireApp('./src/conversation-journal');
  const {RaadVisaWorkflow}=requireApp('./src/raad-visa-workflow');
  const {VisaFulfilment}=requireApp('./src/visa-fulfilment');
  const {visaCaseSignature}=requireApp('./src/visa-case-signature');
  const policy=requireApp('./src/saudi-visa-policy');
  const now=Date.now();
  const entryDate=new Date(now+30*86400000).toISOString().slice(0,10);
  const facts={nationalityCode:'SYR',passportNumber:'TEST4801',passportType:'ordinary',issuingCountryCode:'SYR',issueDate:'2025-01-01',expiryDate:'2035-01-01',birthDate:'1990-04-03',birthPlace:'Synthetic City',sex:'M',latinFirstName:'Synthetic',latinFatherName:'Synthetic',latinFamilyName:'Applicant',arabicFirstName:'تجريبي',arabicFatherName:'تجريبي',arabicFamilyName:'تجريبي',emiratesId:'784199000000001',residenceExpiry:'2030-01-01',maritalStatus:'single',previousNationality:false,travelledLastFiveYears:false,performUmrah:false,gccResident:true,priorGccDeportation:false,priorGccRuleViolation:false,saudiAddress:'Synthetic confirmed address',transport:'land',arrivalPort:'Synthetic confirmed port',entryDate,health:{hospitalizedOrEmergency:false,accidentDisability:false,congenitalCondition:false}};
  const store=new AssistantState({file,key:STATE_KEY});
  const visaCase={id:crypto.randomUUID(),service:'saudi_visa',policyVersion:policy.POLICY_VERSION,revision:1,createdAt:now,updatedAt:now,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'unverified',submissionStatus:'not_submitted',documents:[],stage:'quoted'};
  visaCase.quote=policy.calculateQuote(visaCase);
  store.data.visaCases={[CUSTOMER]:visaCase};
  store.data.serviceSessions={[CUSTOMER]:{service:'saudi_visa',revision:0,at:now}};
  store.set(CUSTOMER,{history:[],status:'idle',offers:[]});
  const media=new VisaMediaStore({store,env});
  const image=await requireApp('sharp')({create:{width:600,height:400,channels:3,background:'#e4e8f0'}}).png().toBuffer();
  const sessionId=crypto.randomUUID(),documents={};let receipt;
  for(const role of ['passport','residence','photo','receipt']){
    const item=await media.storeUpload(CUSTOMER,{bytes:image,mimeType:'image/png',role:role==='receipt'?'passport':role,sessionId,caseId:visaCase.id});
    media.activateUploads(CUSTOMER,{sessionId,mediaIds:[item.id]});
    if(role==='receipt')receipt=item.id;else documents[role]=item.id;
  }
  let claimed=true;
  // Seed-only accountant and sender adapters. The servers below use their
  // original InboxService and VisaWhatsApp adapter; these are not substituted.
  const inbox={isOperatorOwned:()=>claimed,isBlocked:()=>false,updateVisa(customer,input){
    assert.equal(customer,CUSTOMER);
    visaCase.staffVerification||={};
    visaCase.staffVerification.payment={amount:input.amount,reference:input.reference,actor:'synthetic-accountant',verifiedAt:Date.now(),caseSignature:visaCaseSignature(visaCase)};
    visaCase.paymentStatus='verified';visaCase.revision++;
  }};
  const raad=new RaadVisaWorkflow({store,mediaStore:media,env,canAutomate:()=>!claimed});
  const fulfilment=new VisaFulfilment({store,inbox,mediaStore:media,raad,env,send:async(_to,_payload,guard)=>{guard();return {messageId:'synthetic-seed-payment-notice'};}});
  fulfilment.receiveReceipt(CUSTOMER,{receiptId:receipt});
  const approved=fulfilment.confirmPayment(CUSTOMER,{receiptId:receipt,amount:visaCase.quote.total,reference:'synthetic-payment-only',actor:{id:'synthetic-accountant',role:'accountant'},actualReceived:true,confirm:true,expectedCaseSignature:visaCaseSignature(visaCase),idempotencyKey:'synthetic-full-router-payment'});
  visaCase.staffVerification.documentsReviewed=true;
  visaCase.staffVerification.documentsSignature=visaCaseSignature(visaCase);
  const prepared=raad.prepare(CUSTOMER,{expectedRevision:0,fields:facts,documents,confirm:true});
  raad.review(CUSTOMER,{expectedRevision:prepared.revision,confirmedFields:raad.get(CUSTOMER).reviewRequiredFields,confirm:true});
  claimed=false;
  const job=fulfilment.job(approved.jobs[0].id);
  await fulfilment.dispatchMessage(job.paymentNoticeId);
  let fields;
  for(let round=0;round<4;round++){
    const asked=fulfilment.askQuestions(job.id,fields?{fields}:{});fields=null;
    for(const question of asked.questions){
      let answer=atField(facts,question.field);
      if(question.field==='arrivalPort')answer='other';
      if(question.field==='arrivalPortDetails')answer=facts.arrivalPort;
      const input={sender:CUSTOMER,token:question.token};
      if(question.type==='choice'){
        const choice=question.options.find(option=>option.value===answer);assert.ok(choice,question.field);input.option=choice.id;
      }else input.value=answer;
      const result=fulfilment.answerQuestion(input);if(result.followupFields)fields=result.followupFields;
    }
    if(!fields)break;
  }
  assert.ok(job.summary);
  fulfilment.confirmAnswers({sender:CUSTOMER,token:job.summary.token,confirm:true,messageId:'synthetic-full-router-client-consent'});
  const proof=fulfilment.getConfirmedFields(job.id),dossier=raad.portalDossier(CUSTOMER,{clientProof:proof});
  assert.equal(dossier.ready,true,JSON.stringify(dossier.issues));
  // A real journal instance initializes the same snapshot format used at boot.
  new ConversationJournal({store});store.save();
  assert.equal(job.state,'ready');assert.equal(fulfilment.data().lease,null);
  assert.equal(Object.keys(fulfilment.data().challenges).length,0);
  return {jobId:job.id,caseSignature:job.caseSignature,applicantIndex:job.applicantIndex};
}

test('new local lab gate and strict transport wire one approved synthetic OTP through actual current routers',{timeout:25000},async t=>{
  // Advance only Date after boot to pass the ordinary 30-second startup grace.
  // Network, Promise, interval and expiry timers retain their real scheduling.
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'visa-full-router-'));
  const file=path.join(directory,'state.enc');
  // This test runs in its own node:test process. Drop application configuration
  // by name without reading values; no host credentials/state are inherited.
  const preserved=new Set(['PATH','NODE_PATH','NODE_OPTIONS','NODE_TEST_CONTEXT','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','OFFLINE_GUARD_LOG']);
  for(const name of Object.keys(process.env))if(!preserved.has(name))delete process.env[name];
  Object.assign(process.env,{NODE_ENV:'test',ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:STATE_KEY,WHATSAPP_APP_SECRET:SECRET,WHATSAPP_VERIFY_TOKEN:'synthetic-full-router-verify-token',ASSISTANT_ADMIN_KEY:'synthetic-full-router-admin-key-xxxxxxxxxxxxxxxx',WHATSAPP_ACCESS_TOKEN:'synthetic-full-router-graph-token',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_GRAPH_API_VERSION:'v23.0',DRY_RUN:'false',SAUDI_VISA_ENABLED:'true',RAAD_DOCUMENT_OCR_ENABLED:'false',ASSISTANT_AI_PROVIDER:'disabled',CONSULTANT_ORCHESTRATOR_ENABLED:'false',FARE_CATALOG_ENABLED:'false',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FLYCHAM_PORTAL_ENABLED:'false',RAAD_VISA_AUTOMATION_ENABLED:'true',RAAD_BROWSER_WORKER_URL:WORKER_ORIGIN+'/',RAAD_JOB_BRIDGE_KEY:BRIDGE,RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_CONTACT_EMAIL:'application@example.test',RAAD_INSURANCE_PHONE:'+971500000011',RAAD_POSTAL_CODE:'00000',RAAD_CITY:'Synthetic City',RAAD_POST_OFFICE_BOX:'000',SAUDI_VISA_PRIVATE_PATH:path.join(directory,'absent-private-config.enc')});
  const guardedFetch=globalThis.fetch;
  const evidence={meta:[],bridgeStarts:0,bridgeOtpPosts:0,leaseGets:0,syntheticResumes:0,browserLaunches:0,saveCalls:0,externalCalls:0,logs:[],logViolations:0,graphViolations:[]};
  let main,mainBase,pilot,workerBase,seeded,nativeWindow,challengeId,labTransport=null;
  for(const method of ['log','info','warn','error'])t.mock.method(console,method,(...args)=>{
    const line=args.map(value=>typeof value==='string'?value:JSON.stringify(value)).join(' ');
    // Application catch handlers must not hide an assertion from this adapter.
    if(line.includes(CODE))evidence.logViolations++;
    assert.equal(line.includes(CODE),false,'synthetic OTP must not enter application logs');evidence.logs.push(line);
  });
  globalThis.fetch=async(raw,options={})=>{
    const url=new URL(raw);
    const jobPath=seeded&&'/internal/raad/jobs/'+seeded.jobId;
    const method=options.method||'GET';
    const workerRoute=url.pathname==='/health'&&method==='GET'||url.pathname==='/internal/raad/jobs'&&method==='POST'||jobPath&&url.pathname===jobPath&&method==='GET'||jobPath&&[jobPath+'/otp',jobPath+'/cancel'].includes(url.pathname)&&method==='POST';
    if(url.origin===WORKER_ORIGIN&&workerRoute&&!url.search&&!url.hash){
      assert.ok(workerBase);
      if(url.pathname==='/internal/raad/jobs'){
        const manifest=JSON.parse(options.body);assert.equal(manifest.jobId,seeded.jobId);assert.equal(manifest.caseSignature,seeded.caseSignature);assert.equal(manifest.applicantIndex,seeded.applicantIndex);evidence.bridgeStarts++;
      }
      if(url.pathname===jobPath+'/otp')evidence.bridgeOtpPosts++;
      const target=new URL(url.pathname,workerBase).href;
      const response=labTransport?await labTransport.request(target,options):await guardedFetch(target,options);
      if(url.pathname===jobPath+'/otp'){const accepted=await response.clone().json();evidence.workerOtpReceipt=accepted.otpReceipt;}
      if(url.pathname===jobPath){
        const state=await response.clone().json();
        if(state.blocker?.code==='RAAD_TEST_SUBMISSION_BLOCKED')evidence.workerBoundary=state;
      }
      return response;
    }
    if(mainBase&&url.origin===mainBase&&/^\/internal\/assistant\/visa-portal\/jobs\/[a-f0-9-]{36}\/lease$/.test(url.pathname)&&!url.search&&!url.hash){
      assert.equal(options.method,'GET');evidence.leaseGets++;
      return labTransport?labTransport.request(url.href,options):guardedFetch(url,options);
    }
    if(url.href==='https://graph.facebook.com/v23.0/123456789/messages'&&options.method==='POST'){
      let body;
      try{body=JSON.parse(options.body);}catch(error){evidence.graphViolations.push('MALFORMED_CAPTURE');throw error;}
      if(body.to!==OWNER)evidence.graphViolations.push('WRONG_RECIPIENT');
      if(body.type!=='text')evidence.graphViolations.push('UNEXPECTED_MESSAGE_TYPE');
      if(JSON.stringify(body).includes(CODE))evidence.graphViolations.push('OTP_IN_OUTBOUND_TEXT');
      assert.equal(body.to,OWNER);assert.equal(body.type,'text');assert.equal(JSON.stringify(body).includes(CODE),false);
      const messageId='wamid.synthetic.full-router.'+(evidence.meta.length+1);
      evidence.meta.push({body,messageId});
      return new Response(JSON.stringify({messages:[{id:messageId}]}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    evidence.externalCalls++;
    // Preserve the runner's network fence, including its blocked-call count.
    return guardedFetch(raw,options);
  };
  const {AssistantState}=requireApp('./src/assistant-state');
  const readState=()=>new AssistantState({file,key:STATE_KEY}).data;
  const auth={Authorization:'Bearer '+BRIDGE};
  try{
    seeded=await seedReadyCase(file,process.env);
    const {createServer}=requireApp('./src/server');
    main=createServer();mainBase=await listen(main);
    const {createPilot}=requireApp('./src/raad-login-pilot/server');
    pilot=createPilot({env:{RAAD_PILOT_KEY:'synthetic-full-router-pilot-key-'.repeat(3),RAAD_PILOT_ORIGIN:'https://synthetic-pilot.example.test',RAAD_JOB_BRIDGE_KEY:'synthetic-unused-production-key-'.repeat(2),RAAD_EXECUTION_MODE:'non_submitting_test',RAAD_TEST_MAIN_URL:mainBase+'/',RAAD_TEST_JOB_BRIDGE_KEY:BRIDGE,RAAD_DIRECT_LOGIN_ENABLED:'false'},supervisorSmsContract:null,productionLeaseFetch:(...args)=>globalThis.fetch(...args),launch:async()=>{evidence.browserLaunches++;throw Error('SYNTHETIC_BROWSER_MUST_NOT_LAUNCH');},productionFlow:async(ctx,{resume})=>{
      if(!resume){
        const challengeRequestedAt=ctx.now();
        nativeWindow={challengeId:'synthetic-full-router-native-challenge',challengeRequestedAt,challengeExpiresAt:challengeRequestedAt+300000,accountBinding:'b'.repeat(64)};
        Object.assign(ctx.record,nativeWindow,{stage:'waiting_otp',phase:'application_sms'});return;
      }
      assert.equal(ctx.record.pendingCode,CODE);assert.deepEqual(tuple(ctx.record.smsWindow),nativeWindow);
      ctx.record.pendingCode='';evidence.syntheticResumes++;
      await ctx.checkLease();ctx.assertSubmissionAllowed();
      evidence.saveCalls++;assert.fail('non-submission policy must stop before save');
    }});
    workerBase=await listen(pilot.server);
    let inboundSequence=0;
    const inbound=({sender=OWNER,contextId='synthetic-unrelated-context',validSignature=true,id}={})=>{
      const body={entry:[{changes:[{field:'messages',value:{messages:[{from:sender,id:id||'synthetic-full-router-inbound-'+(++inboundSequence),type:'text',context:{id:contextId},text:{body:CODE},timestamp:String(Math.floor(Date.now()/1000))}]}}]}]};
      const signature='sha256='+crypto.createHmac('sha256',SECRET).update(JSON.stringify(body)).digest('hex');
      return request(mainBase,'/webhooks/whatsapp',{method:'POST',body,headers:{'x-hub-signature-256':validSignature?signature:'sha256='+'0'.repeat(64)}});
    };
    const workerStatus=()=>request(workerBase,'/internal/raad/jobs/'+seeded.jobId,{headers:auth});


    // Bootstrap only this fixture's one pre-reviewed synthetic job. All Graph
    // operations remain captured; productionFlow is injected and cannot launch.
    assert.equal(REAL_META_ENABLED,false);t.mock.timers.tick(31000);
    assert.equal((await inbound()).status,200);
    await until(async()=>{const state=await workerStatus();return state.json?.stage==='waiting_otp';},'synthetic worker challenge');
    assert.equal((await inbound({contextId:'synthetic-poll-only'})).status,200);
    const challenge=await until(()=>Object.values(readState().visaFulfilment.challenges).find(value=>value.jobId===seeded.jobId&&value.messageId),'bound synthetic owner prompt');
    challengeId=challenge.id;
    const gate=createSessionGate({source:APP,freeze:FREEZE,config:{enabled:true,mode:'local_synthetic',owner:OWNER,dedicatedMetaTestSender:true,phoneNumberId:'123456789',wabaId:'111222333',syntheticSigningSecret:SECRET},now:()=>Date.now()});
    const binding=gate.openSession({sessionId:'synthetic_gated_router_session',jobId:seeded.jobId,caseSignature:seeded.caseSignature,applicantIndex:0,promptMessageId:challenge.messageId,code:CODE,...nativeWindow});
    labTransport=createLoopbackTransport({source:APP,freeze:FREEZE,enabled:true,mainOrigin:mainBase+'/',workerOrigin:workerBase+'/',binding,now:()=>Date.now(),fetchImpl:guardedFetch});
    let forwarded=0;
    const envelope=(sender=OWNER)=>{const payload={object:'whatsapp_business_account',entry:[{id:'111222333',changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:'123456789'},messages:[{from:sender,id:'wamid.synthetic.gated.owner',type:'text',timestamp:String(Math.floor(Date.now()/1000)),context:{id:challenge.messageId},text:{body:CODE}}]}}]}]};const rawBody=Buffer.from(JSON.stringify(payload));return{rawBody,signature:'sha256='+crypto.createHmac('sha256',SECRET).update(rawBody).digest('hex')};};
    const relay=async input=>{forwarded++;const response=await labTransport.request(mainBase+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':input.signature},body:input.rawBody.toString()});assert.equal(response.status,200);await response.arrayBuffer();await until(()=>readState().visaFulfilment.challenges[challengeId].state==='consumed','actual main consumed exact worker receipt');assert.ok(evidence.workerOtpReceipt);return{accepted:true,...evidence.workerOtpReceipt};};
    await assert.rejects(gate.acceptWebhook({...envelope('15550004999'),context:binding},relay),e=>e.code==='LAB_SENDER_INVALID');
    await assert.rejects(gate.acceptWebhook({...envelope(),context:{...binding,jobId:'other_job'}},relay),e=>e.code==='LAB_SESSION_JOB_OR_CHALLENGE_MISMATCH');
    await assert.rejects(labTransport.request(workerBase+'/internal/raad/jobs/other_job/otp',{method:'POST',headers:auth,body:JSON.stringify({...nativeWindow,code:CODE})}),e=>e.code==='LAB_TRANSPORT_FORBIDDEN');
    assert.equal(forwarded,0);assert.equal(evidence.bridgeOtpPosts,0);assert.equal(evidence.syntheticResumes,0);
    const valid=envelope();try{const accepted=await gate.acceptWebhook({...valid,context:binding},relay);assert.equal(accepted.accepted,true);}finally{valid.rawBody.fill(0);}
    await assert.rejects(gate.acceptWebhook({...envelope(),context:binding},relay),e=>e.code==='LAB_SINGLE_USE_OR_REPLAY');
    const stopped=await until(()=>evidence.workerBoundary,'actual immutable non-submission fence');
    assert.equal(stopped.blocker.code,'RAAD_TEST_SUBMISSION_BLOCKED');assert.equal(stopped.testStopped,true);assert.equal(stopped.saved,false);assert.equal(stopped.applicationSubmitted,false);assert.equal(stopped.artifactReady,false);assert.equal(stopped.reference,null);
    assert.equal(forwarded,1);assert.equal(evidence.bridgeStarts,1);assert.equal(evidence.bridgeOtpPosts,1);assert.equal(evidence.syntheticResumes,1);assert.ok(evidence.leaseGets>=3);
    assert.equal(evidence.browserLaunches,0);assert.equal(evidence.saveCalls,0);assert.equal(evidence.externalCalls,0);assert.equal(evidence.logViolations,0);assert.deepEqual(evidence.graphViolations,[]);assert.equal(JSON.stringify(readState()).includes(CODE),false);assert.equal(JSON.stringify(evidence.meta).includes(CODE),false);assert.equal(gate.snapshot().realMetaWired,false);
  }finally{
    process.env.RAAD_VISA_AUTOMATION_ENABLED='false';
    process.env.SAUDI_VISA_ENABLED='false';
    if(pilot)await pilot.shutdown();
    if(main){main.closeAllConnections();await new Promise(resolve=>main.close(resolve));}
    globalThis.fetch=guardedFetch;
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
