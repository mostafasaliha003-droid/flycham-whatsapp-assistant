'use strict';
// Synthetic main + browser candidates. Every transport is injected in memory.
// This file never starts an HTTP server, invokes fetch, or opens a browser.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {VisaFulfilment}=require('../src/visa-fulfilment');
const {VisaPortalDispatcher}=require('../src/visa-portal-dispatcher');
const {RaadVisaWorkflow}=require('../src/raad-visa-workflow');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {createProductionWorker,validateManifest}=require('../src/raad-login-pilot/production-worker');
const {estimate,dubaiDate}=require('../src/raad-login-pilot/estimated-entry-date');
const CUSTOMER='971500000001',OWNER='971500000009',KEY='synthetic_bridge_key_'.repeat(3);
const IDS={receipt:'10000000-0000-4000-8000-000000000001',passport:'10000000-0000-4000-8000-000000000002',residence:'10000000-0000-4000-8000-000000000003',photo:'10000000-0000-4000-8000-000000000004'};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const field=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
function facts({entryDate,address='Synthetic confirmed address',transport='land',port='Synthetic confirmed land port'}={}){
 return {nationalityCode:'SYR',passportNumber:'TEST0001',passportType:'ordinary',issuingCountryCode:'SYR',issueDate:'2025-01-01',expiryDate:'2030-01-01',birthDate:'1990-04-03',birthPlace:'Synthetic City',sex:'M',latinFirstName:'Synthetic',latinFatherName:'Synthetic',latinFamilyName:'Applicant',arabicFirstName:'تجريبي',arabicFatherName:'تجريبي',arabicFamilyName:'تجريبي',emiratesId:'784199000000001',residenceExpiry:'2028-01-01',maritalStatus:'single',previousNationality:false,travelledLastFiveYears:false,performUmrah:false,gccResident:true,priorGccDeportation:false,priorGccRuleViolation:false,saudiAddress:address,transport,arrivalPort:port,health:{hospitalizedOrEmergency:false,accidentDisability:false,congenitalCondition:false},...(entryDate?{entryDate}:{})};
}
function nativeAdapter({port,transport,label='Expected entry date',duplicate=false}={}){
 let path='/SmartForm',closed=0,smsDispatches=0;const calls=[];
 const select=(id,value,caption=value)=>({id,type:'select',disabled:false,options:[{value,label:caption}]});
 const controls=[
 select('VisaKind','10'),select('NATIONALITY','SYR'),select('ddlResidenceCountry','270'),
 select('SOCIAL_STATUS','1','أعزب'),select('Sex','1','ذكر'),select('PASSPORType','1','عادي'),
 select('PASSPORT_ISSUE_PLACE','SYR'),select('EmbassyCode','214','أبو ظبي'),
 select('COMING_THROUGH','77',{air:'جوا',land:'برا',sea:'بحرا'}[transport]),
 select('ENTRY_POINT','synthetic_port',port),select('TourismEVisaIssuingCountryCode','ARE'),
 select('MobileInfo_MobilePrefix','971','United Arab Emirates (00971)'),
 ...['IsVisaEndDateOptional','Endorsement','IsPrivacyPolicyAgreed','terms_and_conditions'].map(id=>({id,type:'checkbox',disabled:false})),
 ...['PassportImageFile','IqamaOrVisaImageFile','PersonalImage'].map(id=>({id,type:'file',disabled:false})),
 {id:'ExpectedEntryDate',type:'text',label,disabled:false}
 ];
 const inspection=()=>({path,controls,buttons:[],links:path==='/SmartForm'?[{path:'/SmartForm/Agreement',label:'إضافة طلب جديد'}]:[]});
 return {calls,get closed(){return closed;},get smsDispatches(){return smsDispatches;},
 reserve:async()=> 'synthetic-reservation',close:async()=>{closed++;return true;},release:async()=>{},locate:async()=>({path}),
 call:async(action,data)=>{
  calls.push({action,data:structuredClone(data)});
  if(action==='start')return {sessionId:'synthetic-session',automaticCaptcha:true,stage:'awaiting_input'};
  if(action==='auto-login')return {submitted:true,stage:'submitted_unverified'};
  if(action==='current')return {stage:'authenticated',accountSignals:{accountUiVerified:true}};
  if(action==='inspect-page')return {inspection:inspection()};
  if(action==='lookup-applications')return {lookupSupported:true,matchCount:duplicate?2:0,matches:duplicate?[{applicationReference:'E111111'},{applicationReference:'E222222'}]:[]};
  if(action==='open-page'){if(data.path==='/SmartForm/Agreement')path='/SmartForm/TraditionalApp';return {opened:true};}
  if(action==='fill-draft')return {filledCount:1};
  if(action==='set-dates')return {filledCount:1};
  if(action==='upload-documents')return {uploadedCount:1};
  if(action==='inspect-application-sms')return {verification:{buttons:[{id:'btnSendOtp',label:'Send SMS',disabled:false}]}};
  if(action==='request-application-sms'){
   // Emulates the production verifier's pre-dispatch refusal. No request is sent.
   throw Object.assign(Error('APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED'),{code:'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED'});
  }
  throw Error('Unexpected native action '+action);
 }};
}
async function fixture(options={}){
 let at=options.now||Date.parse('2026-10-30T19:59:00Z'),claimed=true,sends=0;
 const value=facts(options),c={id:'synthetic-paired-case',policyVersion:'synthetic-policy',revision:1,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],quote:{total:700},paymentStatus:'unverified',submissionStatus:'not_submitted',documents:[],stage:'quoted'};
 const bytes=Buffer.from('89504e470d0a1a0a0000000d494844520000012c0000012c0802000000','hex');
 const records=Object.fromEntries(Object.values(IDS).map(id=>[id,{id,customer:CUSTOMER,mimeType:'image/png',size:bytes.length,checksum:hash(bytes),status:'pending_review',receivedAt:at-1000,expiresAt:at+86400000}]));
 const store={data:{visaCases:{[CUSTOMER]:c},visaMedia:records,complaints:[],conversationJournal:{customers:{[CUSTOMER]:{}}}},save(){}};
 const mediaStore={get(id,{customer}){const m=records[id];if(!m||m.customer!==customer)throw Error('MEDIA_NOT_FOUND');return structuredClone(m);},read(id,{customer}){return {metadata:this.get(id,{customer}),bytes:Buffer.from(bytes)};}};
 const inbox={isOperatorOwned:()=>claimed,isBlocked:()=>false,updateVisa(customer,input){assert.equal(customer,CUSTOMER);c.staffVerification||={};c.staffVerification.payment={amount:input.amount,reference:input.reference,actor:'synthetic-staff',verifiedAt:at,caseSignature:visaCaseSignature(c)};c.paymentStatus='verified';c.revision++;}};
 const env={RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_VISA_AUTOMATION_ENABLED:'true',RAAD_BROWSER_WORKER_URL:'https://synthetic-worker.example.test/',RAAD_JOB_BRIDGE_KEY:KEY,
 RAAD_APPLICATION_PHONE:'+971500000010',RAAD_CONTACT_EMAIL:'application@example.test',RAAD_INSURANCE_PHONE:'+971500000011',RAAD_POSTAL_CODE:'00000',RAAD_CITY:'Synthetic City',RAAD_POST_OFFICE_BOX:'000'};
 const raad=new RaadVisaWorkflow({store,mediaStore,env,now:()=>at,canAutomate:()=>!claimed});
 const fulfilment=new VisaFulfilment({store,inbox,mediaStore,raad,env,now:()=>at,send:async(to,payload,guard)=>{guard();sends++;return {messageId:'synthetic-outbound-'+sends};}});
 fulfilment.receiveReceipt(CUSTOMER,{receiptId:IDS.receipt});
 const result=fulfilment.confirmPayment(CUSTOMER,{receiptId:IDS.receipt,amount:700,reference:'synthetic-payment',actor:{id:'synthetic-accountant',role:'accountant'},actualReceived:true,confirm:true,expectedCaseSignature:visaCaseSignature(c),idempotencyKey:'synthetic-payment-attempt'});
 c.staffVerification.documentsReviewed=true;c.staffVerification.documentsSignature=visaCaseSignature(c);
 const prepared=raad.prepare(CUSTOMER,{expectedRevision:0,fields:value,documents:{passport:IDS.passport,residence:IDS.residence,photo:IDS.photo},confirm:true});
 if(options.applicationNow)at=options.applicationNow;
 const current=raad.get(CUSTOMER);
 raad.review(CUSTOMER,{expectedRevision:prepared.revision,confirmedFields:current.reviewRequiredFields,confirm:true});
 claimed=false;
 const job=fulfilment.job(result.jobs[0].id);await fulfilment.dispatchMessage(job.paymentNoticeId);
 let fields;
 for(let round=0;round<4;round++){
  const asked=fulfilment.askQuestions(job.id,fields?{fields}:{});fields=null;
  for(const question of asked.questions){
   let answer=field(value,question.field);
   if(question.field==='arrivalPort')answer='other';
   if(question.field==='arrivalPortDetails')answer=value.arrivalPort;
   const input={sender:CUSTOMER,token:question.token};
   if(question.type==='choice'){const choice=question.options.find(o=>o.value===answer);assert.ok(choice,question.field);input.option=choice.id;}else input.value=answer;
   const outcome=fulfilment.answerQuestion(input);if(outcome.followupFields)fields=outcome.followupFields;
  }
  if(!fields)break;
 }
 assert.ok(job.summary,'synthetic applicant summary prepared');
 fulfilment.confirmAnswers({sender:CUSTOMER,token:job.summary.token,confirm:true,messageId:'synthetic-inbound-consent'});
 if(options.entryDate){
  const asked=fulfilment.askQuestions(job.id,{fields:['entryDate']});fulfilment.answerQuestion({sender:CUSTOMER,token:asked.questions[0].token,value:options.entryDate});
  fulfilment.confirmAnswers({sender:CUSTOMER,token:job.summary.token,confirm:true,messageId:'synthetic-explicit-date-consent'});
 }
 const adapter=nativeAdapter({port:value.arrivalPort,transport:value.transport,label:options.label,duplicate:options.duplicate});
 const worker=createProductionWorker({env:{RAAD_JOB_BRIDGE_KEY:KEY},adapter,now:()=>at,wait:async()=>{},leaseFetch:async(url,request)=>{
  let current=false;try{fulfilment.guardLease(job.id,request.headers['X-Raad-Lease-Token']);current=true;}catch{}
  return {ok:current,json:async()=>({current})};
 }});
 const bridge=[],json=value=>({ok:true,status:200,json:async()=>structuredClone(value)});
 const dispatcher=new VisaPortalDispatcher({fulfilment,raad,mediaStore,store,env,now:()=>at,startupGraceMs:0,fetchImpl:async(url,request)=>{
  const path=new URL(url).pathname,body=request.body&&JSON.parse(request.body);bridge.push({path,body});
  if(path==='/health')return json({ready:true,production:worker.health()});
  if(path==='/internal/raad/jobs')return json(await worker.start(body));
  if(path.endsWith('/cancel'))return json(await worker.cancel(job.id));
  if(path==='/internal/raad/jobs/'+job.id)return json(worker.status(job.id));
  throw Error('Unexpected bridge path '+path);
 }});
 async function settle(){for(let i=0;i<200;i++){const state=worker.status(job.id);if(['blocked','completed','lease_lost'].includes(state.stage))return state;await new Promise(resolve=>setImmediate(resolve));}assert.fail('synthetic worker did not settle');}
 return {value,store,c,job,raad,fulfilment,dispatcher,adapter,worker,bridge,settle,now:()=>at};
}

test('paired candidates accept a real main manifest, resolve a custom port, verify +15 days, and stop before SMS dispatch',async()=>{
 const f=await fixture();await f.dispatcher.launch(f.job);
 const sent=f.bridge.find(x=>x.path==='/internal/raad/jobs')?.body;assert.ok(sent);
 const checked=validateManifest(sent,f.now());assert.equal(checked.facts.arrivalPort,f.value.arrivalPort);
 assert.deepEqual(checked.entryDateProvenance,{source:'office_estimate',referenceDate:'2026-10-30',offsetDays:15});
 assert.equal(checked.facts.entryDate,'2026-11-14');
 const state=await f.settle();assert.equal(state.blocker.code,'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED');
 assert.equal(state.requiresOtp,false);assert.equal(state.saved,false);assert.equal(f.adapter.smsDispatches,0);assert.equal(f.adapter.closed,1);
 const selected=f.adapter.calls.filter(x=>x.action==='fill-draft').flatMap(x=>x.data.fields).find(x=>x.id==='COMING_THROUGH');
 assert.equal(selected.value,'77');assert.ok(f.adapter.calls.some(x=>x.action==='set-dates'&&x.data.dates[0].id==='ExpectedEntryDate'&&x.data.dates[0].isoDate==='2026-11-14'));
 await f.dispatcher.poll(f.job,f.store.data.visaPortalRuns[f.job.id]);
 assert.equal(f.job.state,'portal_review_required');assert.equal(f.job.blockedReason,'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED');
 assert.equal(f.bridge.filter(x=>x.path==='/internal/raad/jobs').length,1);assert.equal(f.c.submissionStatus,'not_submitted');
});
test('actual Dubai application day replaces conversation day at midnight without asking a routine entry date',async()=>{
 const f=await fixture({now:Date.parse('2026-10-30T19:59:00Z'),applicationNow:Date.parse('2026-10-30T20:01:00Z')});
 const proof=f.fulfilment.getConfirmedFields(f.job.id);assert.equal(proof.fields.entryDate,undefined);
 await f.dispatcher.launch(f.job);const body=f.bridge.find(x=>x.path==='/internal/raad/jobs')?.body;assert.ok(body);
 assert.equal(body.entryDateProvenance.referenceDate,'2026-10-31');assert.equal(body.fields.entryDate,'2026-11-15');
 assert.equal((await f.settle()).blocker.code,'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED');
});
test('explicit applicant date wins over office estimate and keeps its provenance',async()=>{
 const f=await fixture({entryDate:'2026-12-20'});await f.dispatcher.launch(f.job);
 const body=f.bridge.find(x=>x.path==='/internal/raad/jobs')?.body;assert.ok(body);
 assert.equal(body.fields.entryDate,'2026-12-20');assert.deepEqual(body.entryDateProvenance,{source:'applicant_confirmed'});
 assert.equal(validateManifest(body,f.now()).facts.entryDate,'2026-12-20');
 assert.equal((await f.settle()).blocker.code,'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED');
});
test('an unspecified stay is preserved as unknown and blocks before a browser job exists',async()=>{
 const f=await fixture({address:'not_specified'});await f.dispatcher.launch(f.job);
 assert.equal(f.job.confirmedFields.saudiAddress,'not_specified');assert.equal(f.job.blockedReason,'SAUDI_ADDRESS_UNSPECIFIED_REQUIRES_PORTAL_REVIEW');
 assert.equal(f.bridge.some(x=>x.path==='/internal/raad/jobs'),false);assert.equal(f.adapter.calls.length,0);
});
test('an unconfirmed official date label stops before setting dates or inspecting SMS',async()=>{
 const f=await fixture({label:'Confirmed booking date'});await f.dispatcher.launch(f.job);const state=await f.settle();
 assert.equal(state.blocker.code,'ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');assert.equal(f.adapter.calls.some(x=>x.action==='set-dates'||x.action==='inspect-application-sms'),false);
 assert.equal(state.saved,false);assert.equal(f.adapter.smsDispatches,0);
});
test('ambiguous saved-application lookup stops before filling or SMS and never retries',async()=>{
 const f=await fixture({duplicate:true});await f.dispatcher.launch(f.job);const state=await f.settle();
 assert.equal(state.blocker.code,'CASE_LOOKUP_UNCONFIRMED');assert.equal(f.adapter.calls.some(x=>x.action==='fill-draft'||x.action==='inspect-application-sms'),false);
 assert.equal(f.bridge.filter(x=>x.path==='/internal/raad/jobs').length,1);assert.equal(f.adapter.smsDispatches,0);
});
test('calendar estimate handles leap years, month/year boundaries and the Dubai timezone explicitly',()=>{
 for(const [reference,expected]of [['2026-12-25','2027-01-09'],['2028-02-20','2028-03-06'],['2026-01-25','2026-02-09']])assert.equal(estimate(reference),expected);
 assert.equal(dubaiDate(Date.parse('2026-12-31T20:00:00Z')),'2027-01-01');
});
