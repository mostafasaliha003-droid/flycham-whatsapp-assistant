'use strict';
const crypto=require('node:crypto');
const {abuDhabiMission,abuDhabiOption,tourismOption,waitForPhoneSection}=require('./visa-route-readiness');
const {cleanEntryDateProvenance,assertEstimatedEntryDateCurrent,verifyExpectedEntryDate,verifyExpectedEntryDateField,verifiedSubmittedEntryDate,insuranceEntryDate}=require('./estimated-entry-date');
const {cleanSmsRequestEvidence,confirmSmsRequest}=require('./sms-request-proof');
const {FIELD_ALLOWLIST}=require('../raad-visa-workflow');
const {captureApplicationPdf}=require('./portal-print');
const {supervisorSmsRoute}=require('../visa-supervisor-route');
const {assertSmsWindow,sameSmsWindow}=require('./sms-challenge-window');
const {createExecutionPolicy,createTestBridgeConfig}=require('./execution-policy');
const JOB=/^[A-Za-z0-9_-]{1,100}$/,REF=/^[A-Z]{0,3}[0-9]{3,20}$/;
const ORIGIN='https://visa.mofa.gov.sa',MAIN_ORIGIN='https://flycham-whatsapp-assistant.onrender.com';
const FIELD_SET=new Set([...FIELD_ALLOWLIST,'religion','occupation','occupationClass','proposedEntryDate','noEmployment']);
const BOOL=new Set(['previousNationality','travelledLastFiveYears','performUmrah','gccResident','priorGccDeportation','priorGccRuleViolation','noEmployment']);
const HEALTH=['hospitalizedOrEmergency','accidentDisability','congenitalCondition'];
const TERMINAL=new Set(['blocked','completed','failed','cancelled','lease_lost']);
function finite(code,field){const error=new Error(/^[A-Z][A-Z0-9_]{1,99}$/.test(code)?code:'PRODUCTION_UNCONFIRMED');error.code=error.message;if(field&&/^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$/.test(field))error.field=field;return error;}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const clone=value=>JSON.parse(JSON.stringify(value));
const norm=value=>String(value||'').normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/\s+/g,' ').trim().toLowerCase();
function cleanFacts(input){
 if(!plain(input)||Object.keys(input).length>90)throw finite('MANIFEST_FIELDS_INVALID');const result={};
 for(const [raw,value]of Object.entries(input)){
  const parts=raw.split('.'),key=parts[0];if(!FIELD_SET.has(key))throw finite('MANIFEST_FIELD_NOT_ALLOWED');
  if(parts.length>1){if(key!=='health'||parts.length!==2||!HEALTH.includes(parts[1])||typeof value!=='boolean')throw finite('MANIFEST_FIELDS_INVALID');result.health={...result.health,[parts[1]]:value};continue;}
  if(value===undefined||value===null||value==='')continue;
  if(key==='health'){if(!plain(value)||Object.keys(value).some(name=>!HEALTH.includes(name)||typeof value[name]!=='boolean'))throw finite('MANIFEST_FIELDS_INVALID');result.health={...result.health,...value};}
  else if(key==='guardian'){if(!plain(value)||Object.keys(value).some(name=>!['relationship','visaReference','status'].includes(name)||typeof value[name]!=='string'||value[name].length>200))throw finite('MANIFEST_FIELDS_INVALID');result.guardian=clone(value);}
  else if(BOOL.has(key)){if(typeof value!=='boolean')throw finite('MANIFEST_FIELDS_INVALID');result[key]=value;}
  else if(key==='visaValidityDays'){if(!Number.isSafeInteger(value)||value<1||value>3650)throw finite('MANIFEST_FIELDS_INVALID');result[key]=value;}
  else{if(typeof value!=='string'||value.length>1500||/[\u0000-\u001f\u007f]/.test(value))throw finite('MANIFEST_FIELDS_INVALID');result[key]=value;}
 }
 return result;
}
function validateManifest(input,now=Date.now()){
 if(!plain(input)||!JOB.test(input.jobId||'')||!JOB.test(input.caseId||'')||typeof input.leaseToken!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(input.leaseToken)||!Number.isInteger(input.applicantIndex)||input.applicantIndex<0||input.applicantIndex>30||! /^[a-f0-9]{64}$/i.test(input.caseSignature||''))throw finite('MANIFEST_INVALID');
 const consent=input.clientConsent;if(!plain(consent)||consent.granted!==true||consent.scope!=='saudi_visa_application'||consent.caseSignature!==input.caseSignature||typeof consent.messageId!=='string'||!consent.messageId||consent.messageId.length>256||!Number.isFinite(consent.grantedAt)||consent.grantedAt<=0||consent.grantedAt>now+300000)throw finite('CLIENT_CONSENT_REQUIRED');
 if(input.review&&input.review.complete!==true||input.draftReviewComplete===false)throw finite('DRAFT_REVIEW_REQUIRED');
 const fields=cleanFacts(input.fieldsFlat||input.fields||{}),defaults=cleanFacts(input.defaultsFlat||input.defaults||{}),answers=cleanFacts(input.answers||{});
 for(const [key,value]of Object.entries(answers)){if(key==='health'){fields.health={...fields.health,...value};}else{if(Object.hasOwn(fields,key)&&JSON.stringify(fields[key])!==JSON.stringify(value))throw finite('MANIFEST_FACT_CONFLICT',key);fields[key]=value;}}
 const facts={...defaults,...fields,health:{...defaults.health,...fields.health}};if(!facts.entryDate&&facts.proposedEntryDate)facts.entryDate=facts.proposedEntryDate;
 if(typeof facts.passportNumber!=='string'||!/^[A-Z0-9]{5,12}$/.test(facts.passportNumber))throw finite('MANIFEST_PASSPORT_REQUIRED','passportNumber');
 const existing=input.existingApplicationReference;if(existing!==undefined&&existing!==null&&!REF.test(existing))throw finite('MANIFEST_REFERENCE_INVALID');
 if(!Array.isArray(input.documents)||input.documents.length>3||!existing&&input.documents.length!==3)throw finite('MANIFEST_DOCUMENTS_INVALID');
 const roles=new Set();const documents=input.documents.map(doc=>{
  if(!plain(doc)||!['passport','residence','portrait'].includes(doc.role)||roles.has(doc.role)||!['image/jpeg','image/png'].includes(doc.mimeType)||typeof doc.data!=='string'||doc.data.length>1333336||! /^[A-Za-z0-9+/]*={0,2}$/.test(doc.data)||! /^[a-f0-9]{64}$/i.test(doc.sha256||''))throw finite('MANIFEST_DOCUMENTS_INVALID');
  const bytes=Buffer.from(doc.data,'base64');try{if(!bytes.length||bytes.length>1000000||bytes.toString('base64')!==doc.data||crypto.createHash('sha256').update(bytes).digest('hex')!==doc.sha256.toLowerCase())throw finite('MANIFEST_DOCUMENT_DIGEST_INVALID');}finally{bytes.fill(0);}roles.add(doc.role);return {role:doc.role,mimeType:doc.mimeType,data:doc.data,sha256:doc.sha256.toLowerCase()};
 });
 return {jobId:input.jobId,leaseToken:input.leaseToken,caseId:input.caseId,applicantIndex:input.applicantIndex,caseSignature:input.caseSignature,clientConsent:{...consent},facts,documents,entryDateProvenance:cleanEntryDateProvenance(input.entryDateProvenance),existingApplicationReference:existing||null,submissionUncertain:input.submissionUncertain===true};
}
function uaePhone(value){if(typeof value!=='string'||!/^\+?[0-9 ()-]{7,25}$/.test(value))throw finite('MISSING_FIELD','applicationPhone');let digits=value.replace(/[^0-9]/g,'');if(digits.startsWith('00971'))digits=digits.slice(5);else if(digits.startsWith('971')&&digits.length===12)digits=digits.slice(3);if(digits.startsWith('0')&&digits.length===10)digits=digits.slice(1);if(!/^5[0-9]{8}$/.test(digits))throw finite('PHONE_FORMAT_UNCONFIRMED','applicationPhone');return digits;}
function createProductionWorker({env=process.env,adapter,leaseFetch=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),runFlow=runGovernmentJob,supervisorSmsContract=null}={}){
 const executionPolicy=createExecutionPolicy(env);
 const testBridge=executionPolicy.isTest?createTestBridgeConfig(env):null;
 const bridgeKey=()=>executionPolicy.isTest?testBridge?.bridgeKey:env.RAAD_JOB_BRIDGE_KEY;
 const mainUrl=()=>executionPolicy.isTest?testBridge?.mainUrl:env.RAAD_MAIN_URL||MAIN_ORIGIN;
 if(!adapter||typeof adapter.reserve!=='function'||typeof adapter.call!=='function')throw finite('WORKER_ADAPTER_REQUIRED');
 let active=null,admitting=false;const records=new Map();
 const configured=()=>{if(executionPolicy.isTest)return testBridge!==null;try{const u=new URL(env.RAAD_MAIN_URL||MAIN_ORIGIN);return typeof env.RAAD_JOB_BRIDGE_KEY==='string'&&env.RAAD_JOB_BRIDGE_KEY.length>=32&&u.origin===MAIN_ORIGIN&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password;}catch{return false;}};
 const status=record=>({...executionPolicy.health(),...(executionPolicy.isTest?{testStopped:record.testStopped===true,applicationSubmitted:false}:{}),jobId:record.id,stage:record.stage,phase:record.phase,reference:executionPolicy.isTest?null:record.reference||null,saved:!executionPolicy.isTest&&record.saved===true,submissionUncertain:!executionPolicy.isTest&&record.submissionUncertain===true,smsRequest:cleanSmsRequestEvidence(record.smsRequest),...(record.smsDispatchState?{smsDispatchState:record.smsDispatchState}:{}),requiresOtp:record.stage==='waiting_otp',challengeId:record.stage==='waiting_otp'?record.challengeId:null,challengeExpiresAt:record.stage==='waiting_otp'?record.challengeExpiresAt:null,challengeRequestedAt:record.stage==='waiting_otp'?record.challengeRequestedAt:null,accountBinding:record.stage==='waiting_otp'?record.accountBinding:null,artifactReady:!executionPolicy.isTest&&record.stage==='completed'&&Boolean(record.artifact)&&record.saved&&record.returnedFromPayment,blocker:record.blocker||null,paymentAttempted:false,returnedFromPayment:record.returnedFromPayment===true,ownedBrowserClosed:record.ownedBrowserClosed===true,caseSignature:record.caseSignature,applicantIndex:record.applicantIndex,artifactSha256:record.artifact?.sha256||null});
 const scrub=record=>{record.pendingCode='';record.smsWindow=null;record.challengeId=null;record.challengeExpiresAt=null;record.challengeRequestedAt=null;record.accountBinding=null;if(record.manifest){for(const doc of record.manifest.documents||[])doc.data='';record.manifest.facts={};record.manifest.documents=[];record.manifest.clientConsent=null;record.manifest.leaseToken='';record.manifest=null;}};
 async function checkLease(record){
  if(record.cancelled||record.controller.signal.aborted)throw finite('JOB_CANCELLED');
  let current=false;try{const response=await leaseFetch(new URL('/internal/assistant/visa-portal/jobs/'+encodeURIComponent(record.id)+'/lease',mainUrl()),{method:'GET',headers:{Authorization:'Bearer '+bridgeKey(),'X-Raad-Lease-Token':record.leaseToken},redirect:'error',signal:AbortSignal.any([record.controller.signal,AbortSignal.timeout(5000)])});current=response.ok&&(await response.json()).current===true;}catch{}
  if(record.cancelled||record.controller.signal.aborted)throw finite('JOB_CANCELLED');if(!current)throw finite('LEASE_REVOKED');
 }
 async function closeOwned(record){
  if(record.ownedBrowserClosed)return true;let closed=false;try{closed=await adapter.close(record.reservation,record.sessionId)===true;}catch{}
  if(closed){record.ownedBrowserClosed=true;try{await adapter.release?.(record.reservation);}catch{}if(active===record)active=null;}return closed;
 }
 const apiFor=record=>async(action,data={},mutation=true)=>{let payload;try{executionPolicy.assertAction(action,data);if(mutation){if(record.smsWindow)assertSmsWindow(record.smsWindow,now());await checkLease(record);if(record.smsWindow)assertSmsWindow(record.smsWindow,now());}if(record.cancelled)throw finite('JOB_CANCELLED');executionPolicy.assertAction(action,data);payload={...data,...(record.sessionId?{sessionId:record.sessionId}:{})};return await adapter.call(action,payload,{reservation:record.reservation,signal:record.controller.signal,guard:async()=>{executionPolicy.assertAction(action,payload);await checkLease(record);executionPolicy.assertAction(action,payload);}});}finally{if(action==='enter-application-sms'){data.code='';if(payload)payload.code='';}}};
 async function execute(record,resume=false){
  if(record.running)return;record.running=true;record.stage='running';record.blocker=null;
  try{
   await checkLease(record);
   const context={record,manifest:record.manifest,supervisorSmsContract,api:apiFor(record),checkLease:()=>checkLease(record),wait,now,assertSubmissionAllowed:()=>executionPolicy.assertSubmissionAllowed(),withPage:fn=>{executionPolicy.assertRawPageAllowed();return adapter.withPage(record.reservation,record.sessionId,fn,()=>checkLease(record));},locate:()=>adapter.locate?.(record.reservation,record.sessionId),capturePdf:(...args)=>{executionPolicy.assertRawPageAllowed();return captureApplicationPdf(...args);}};
   await runFlow(context,{resume});
   if(record.cancelled)throw finite('JOB_CANCELLED');
   if(record.stage==='waiting_otp'){record.smsWindow=Object.freeze(assertSmsWindow(record,now()));const challenge=record.challengeId;clearTimeout(record.otpTimer);record.otpTimer=setTimeout(()=>{void expireOtp(record,challenge);},Math.max(1,record.challengeExpiresAt-now()));record.otpTimer.unref?.();return;}
   executionPolicy.assertSubmissionAllowed();
   if(!record.artifact||!record.saved||!record.returnedFromPayment)throw finite('COMPLETION_PROOF_REQUIRED');
   if(!await closeOwned(record))throw finite('OWNED_BROWSER_CLEANUP_UNCONFIRMED');record.stage='completed';record.phase='done';scrub(record);
  }catch(error){
   if(record.cancelled)return;
   if(error?.smsRequest)record.smsRequest=cleanSmsRequestEvidence(error.smsRequest);if(['not_dispatched','dispatched','uncertain'].includes(error?.smsDispatchState))record.smsDispatchState=error.smsDispatchState;
   const code=/^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code||'')?error.code:'PRODUCTION_UNCONFIRMED';
   record.stage=code==='LEASE_REVOKED'?'lease_lost':'blocked';record.blocker={code,...(error?.field?{field:error.field}:{})};
   if(executionPolicy.isTest&&code.startsWith('RAAD_TEST_')){record.testStopped=true;record.phase='test_boundary';record.saved=false;record.reference=null;record.returnedFromPayment=false;record.submissionUncertain=false;record.saveDispatched=false;if(record.artifact?.buffer)record.artifact.buffer.fill(0);record.artifact=null;}
   if(record.saveDispatched&&!record.saved){record.submissionUncertain=true;if(code!=='LEASE_REVOKED')record.blocker={code:'SAVE_UNCERTAIN'};}
   record.pendingCode='';record.controller.abort();await closeOwned(record);scrub(record);
  }finally{if(record.cancelled&&record.artifact?.buffer){record.artifact.buffer.fill(0);record.artifact=null;}record.running=false;}
 }
 async function expireOtp(record,challenge){if(record.stage!=='waiting_otp'||record.challengeId!==challenge||record.cancelled)return;record.stage='blocked';record.blocker={code:'OTP_CHALLENGE_EXPIRED'};record.challengeId=null;record.challengeExpiresAt=null;record.pendingCode='';record.controller.abort();await closeOwned(record);scrub(record);}
 async function start(input){
  executionPolicy.assertManifest(input);if(executionPolicy.isTest&&!testBridge)throw finite('RAAD_TEST_ISOLATED_MAIN_REQUIRED');if(!configured())throw finite('BRIDGE_DISABLED');if(admitting)throw finite('WORKER_BUSY');admitting=true;
  let manifest;try{
   manifest=validateManifest(input,now());const old=records.get(manifest.jobId),fingerprint=crypto.createHash('sha256').update(JSON.stringify({...manifest,documents:manifest.documents.map(({data,...doc})=>doc)})).digest('hex');
   if(old&&old.leaseToken===manifest.leaseToken){if(old.fingerprint!==fingerprint)throw finite('JOB_MANIFEST_CONFLICT');return status(old);}
   if(active||old&&!TERMINAL.has(old.stage))throw finite('WORKER_BUSY');
   const reservation=await adapter.reserve(manifest.jobId);if(!reservation)throw finite('WORKER_BUSY');
   if(old?.artifact?.buffer)old.artifact.buffer.fill(0);
   const record={id:manifest.jobId,caseId:manifest.caseId,caseSignature:manifest.caseSignature,applicantIndex:manifest.applicantIndex,leaseToken:manifest.leaseToken,fingerprint,manifest,reservation,sessionId:null,stage:'running',phase:'preflight',saved:false,reference:manifest.existingApplicationReference,returnedFromPayment:false,ownedBrowserClosed:false,controller:new AbortController(),running:false,createdAt:now(),blocker:null};active=record;records.set(record.id,record);
   for(const [id,item]of records)if(records.size>8&&item!==active){item.artifact?.buffer?.fill(0);records.delete(id);}
   void execute(record);return status(record);
  }finally{admitting=false;}
 }
 async function otp(id,input){
  try{executionPolicy.assertInput(input);const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');
   const current=()=>{if(record.stage!=='waiting_otp'||record.running||record.challengeId!==input?.challengeId)throw finite('OTP_CHALLENGE_STALE');try{sameSmsWindow(input,record.smsWindow,now());}catch{throw finite('OTP_CHALLENGE_STALE');}};
   current();if(typeof input.code!=='string'||! /^[0-9]{4,8}$/.test(input.code))throw finite('OTP_INPUT_INVALID');await checkLease(record);current();
   const otpReceipt=Object.freeze({jobId:record.id,caseSignature:record.caseSignature,applicantIndex:record.applicantIndex,...assertSmsWindow(record.smsWindow,now())});clearTimeout(record.otpTimer);record.pendingCode=input.code;record.challengeId=null;void execute(record,true);return {accepted:true,otpReceipt,...status(record)};
  }finally{if(input&&typeof input==='object')input.code='';}
 }

 async function cancel(id){if(typeof id!=='string'||!JOB.test(id))throw finite('JOB_ID_INVALID');const record=records.get(id)||(active?.id===id?active:null);if(!record)return {jobId:id,stage:'cancelled',ownedBrowserClosed:true,absent:true};record.cancelled=true;clearTimeout(record.otpTimer);record.controller.abort();if(record.pendingCode)record.pendingCode='';if(!await closeOwned(record)){record.stage='blocked';record.blocker={code:'OWNED_BROWSER_CLEANUP_UNCONFIRMED'};throw finite('OWNED_BROWSER_CLEANUP_UNCONFIRMED');}record.stage='cancelled';record.phase='done';record.blocker=null;record.challengeId=null;record.challengeExpiresAt=null;if(record.artifact?.buffer)record.artifact.buffer.fill(0);record.artifact=null;scrub(record);return status(record);}
 function get(id){const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');return status(record);}
 function artifact(id){const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');if(record.stage!=='completed'||!record.saved||!record.returnedFromPayment||!record.artifact?.buffer)throw finite('ARTIFACT_NOT_READY');return record.artifact;}
 const authorized=value=>{if(!configured())return false;const wanted=Buffer.from('Bearer '+bridgeKey()),actual=Buffer.from(typeof value==='string'?value:'');return wanted.length===actual.length&&crypto.timingSafeEqual(wanted,actual);};
 async function handler(req,res,url,{readBody}={}){
  if(!url.pathname.startsWith('/internal/raad/'))return false;
  const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(executionPolicy.isTest?{...obj,...executionPolicy.health()}:obj));};
  if(!authorized(req.headers.authorization)){send(401,{error:'UNAUTHORIZED'});return true;}
  const route=url.pathname.match(/^\/internal\/raad\/jobs(?:\/([A-Za-z0-9_-]{1,100})(?:\/(otp|artifact|cancel))?)?$/);if(!route||url.search||url.hash){send(404,{error:'NOT_FOUND'});return true;}
  let input;try{
   const [,id,action]=route;
   if(req.method==='GET'&&id&&action==='artifact'){const item=artifact(id),bytes=Buffer.from(item.buffer);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="application.pdf"','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Artifact-Sha256':item.sha256});res.end(bytes,()=>bytes.fill(0));}
   else if(req.method==='GET'&&id&&!action)send(200,get(id));
   else if(req.method==='POST'&&(!id||action==='otp'||action==='cancel')){input=await readBody(req,!id?4200000:2048);if(!id)send(202,await start(input));else if(action==='otp')send(202,await otp(id,input));else send(200,await cancel(id));}
   else send(405,{error:'METHOD_NOT_ALLOWED'});
  }catch(error){const code=/^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code||'')?error.code:'PRODUCTION_UNCONFIRMED';send(code==='JOB_NOT_FOUND'?404:code==='BRIDGE_DISABLED'?503:409,{error:code});}
  finally{if(input?.code)input.code='';if(Array.isArray(input?.documents))for(const doc of input.documents)doc.data='';}
  return true;
 }
 return {start,status:get,otp,cancel,artifact,handler,health:()=>({...executionPolicy.health(),...(executionPolicy.isTest&&!testBridge?{configurationBlocker:'RAAD_TEST_ISOLATED_MAIN_REQUIRED'}:{}),enabled:configured(),activeJob:active!==null,estimatedEntryDateVerification:true}),async shutdown(){if(active)try{await cancel(active.id);}catch{}}};
}

const TEXT_FIELDS={latinFirstName:'EFIRSTNAME',latinFatherName:'EFATHER',latinGrandfatherName:'EGRAND',latinFamilyName:'EFAMILY',arabicFirstName:'AFIRSTNAME',arabicFatherName:'AFATHER',arabicGrandfatherName:'AGRAND',arabicFamilyName:'AFAMILY',passportNumber:'PASSPORTnumber',birthPlace:'BIRTH_PLACE',saudiAddress:'ADDRESS_HOME',emiratesId:'TourismEVisaIqamaOrVisaNo'};
const DATE_FIELDS={issueDate:'PASSPORT_ISSUE_DATE',expiryDate:'PASSPORT_EXPIRY_DATe',birthDate:'BIRTH_DATE',entryDate:'ExpectedEntryDate',residenceExpiry:'TourismEVisaIqamaOrVisaExpiryDate'};
const KNOWN_PLEDGE='345d81b52b2519097ac1f02e4c8b884d9c96030440ac04a730df6f908184054e';
function required(facts,key){const value=facts[key];if(value===undefined||value===null||value==='')throw finite('MISSING_FIELD',key);return value;}
function transportValues(value){const labels={air:['air','جوا'],land:['land','برا'],sea:['sea','بحرا']};if(!Object.hasOwn(labels,value))throw finite('PORTAL_TRANSPORT_UNCONFIRMED','transport');return labels[value];}
function countryLabels(code){if(typeof code!=='string'||! /^[A-Z]{3}$/.test(code))return [code];const iso2={ARE:'AE',SYR:'SY',EGY:'EG',SAU:'SA',JOR:'JO',LBN:'LB',IRQ:'IQ',PSE:'PS',SDN:'SD',YEM:'YE',IND:'IN',PAK:'PK',BGD:'BD',PHL:'PH',GBR:'GB',USA:'US',CAN:'CA',TUR:'TR',DEU:'DE',FRA:'FR',KWT:'KW',QAT:'QA',BHR:'BH',OMN:'OM'}[code];return [code,...(iso2?['ar','en'].map(locale=>new Intl.DisplayNames([locale],{type:'region'}).of(iso2)):[])];}
function optionFor(control,values,field){const targets=values.filter(v=>v!==undefined&&v!==null).map(norm),matches=(control?.options||[]).filter(option=>option.value!==undefined&&!option.disabled&&!option.hidden&&option.value!==''&&(targets.includes(norm(option.value))||targets.includes(norm(option.label))));if(matches.length!==1)throw finite('PORTAL_OPTION_UNCONFIRMED',field);return matches[0];}
function readbackForField(field){if(field.kind==='select-label')return null;const expected={...field,expectedValue:field.value};delete expected.value;if(field.kind==='radio'&&!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(expected.id||''))delete expected.id;return expected;}
function chooseCheapest(inspection){
 const quotes=inspection?.insuranceQuotes;if(!quotes?.available||!Array.isArray(quotes.offers)||!quotes.offers.length)throw finite('INSURANCE_QUOTES_UNAVAILABLE');
 const offers=quotes.offers.map(offer=>{const amounts=[];for(const cell of offer.cells||[]){for(const match of String(cell).matchAll(/(?:\$|USD|US\s*dollars?|دولار(?:\s*امريكي)?)\s*([0-9]{1,5}(?:\.[0-9]{1,2})?)|([0-9]{1,5}(?:\.[0-9]{1,2})?)\s*(?:\$|USD|US\s*dollars?|دولار(?:\s*امريكي)?)/gi))amounts.push(Number(match[1]||match[2]));}const unique=[...new Set(amounts)];if(unique.length!==1||!Number.isFinite(unique[0])||unique[0]<=0||! /^[0-9]{3}$/.test(offer.publicChoice||''))throw finite('INSURANCE_PRICE_UNCONFIRMED');return {choice:offer.publicChoice,amount:unique[0],company:norm(offer.companyLabel)};});
 offers.sort((a,b)=>a.amount-b.amount||a.choice.localeCompare(b.choice));return {choice:offers[0].choice,fingerprint:crypto.createHash('sha256').update(JSON.stringify(offers)).digest('hex')};
}
function loginDiagnosticEvidence(state={}){
 const signals={};for(const key of ['officialHost','mainDocument','loginRoute','logoutPresent','myApplicationsPresent','logoutVisible','applicationsVisible','applicationsRoute','protectedApplicationsVisible','loginControlsVisible','otpPresent','accountUiVerified'])if(typeof state.accountSignals?.[key]==='boolean')signals[key]=state.accountSignals[key];
 const menuReasons=new Set(['ALREADY_INSPECTED','UNAVAILABLE','UNTRUSTED_PAGE','ALREADY_ATTEMPTED','TOGGLE_UNAVAILABLE','ALREADY_EXPANDED','FOCUS_UNCONFIRMED','EXPANDED','ACTIVATION_DISPATCHED','INTERACTION_UNCONFIRMED']);
 const network={};for(const key of ['relevantResponses','relevantFailures','crossOriginNonGetAttempted','crossOriginNonGetFailed','crossOriginNonGetRouteAborted','crossOriginNavigationRouteAborted','crossOriginRouteAbortedTotal','crossOriginRouteAbortedOther']){const value=state.networkDiagnostics?.counts?.[key];if(Number.isSafeInteger(value)&&value>=0&&value<=1000000)network[key]=value;}
 const census={};for(const key of ['observed','ambiguous','rejectionCensusObserved'])if(typeof state.menuInspection?.census?.[key]==='boolean')census[key]=state.menuInspection.census[key];for(const key of ['logoutControls','observedToggles','associatedVisibleSafeToggles','legacyAssociations','bs5Associations','ariaAssociations','associatedTogglesBeforeSafety','associatedVisibleToggles','visibleMarkedToggles','enabledMarkedToggles','rejectedInlineAction','rejectedFormAncestor','rejectedFormOwner','rejectedTagOrType','rejectedHref','rejectedLogout','visibleDropdownToggles','visibleHeaderLoginToggles','visibleDesktopHeaderToggles','visibleMobileHeaderToggles','logoutAnchors','logoutButtons','logoutInputs','logoutDirectTargets','logoutInheritedTargets']){const value=state.menuInspection?.census?.[key];if(Number.isSafeInteger(value)&&value>=0&&value<=32)census[key]=value;}
 return {signals,...(Object.keys(census).length?{menuCensus:census}:{}),...(typeof state.menuInspection?.opened==='boolean'?{menuOpened:state.menuInspection.opened}:{}),...(menuReasons.has(state.menuInspection?.reason)?{menuReason:state.menuInspection.reason}:{}),...(Object.keys(network).length?{network}:{}),...(typeof state.canVerify==='boolean'?{canVerify:state.canVerify}:{})};
}
function loginPageEvidence(inspection){
 if(!inspection||typeof inspection.path!=='string')return {observed:false};
 const path=inspection.path,pageKind=/^\/SmartForm\/?$/.test(path)?'applications':path==='/'||/^\/Home(?:\/Index)?\/?$/i.test(path)?'home':/^\/Account\/Login(?:individuals)?\/?$/i.test(path)?'login':/^\/Account\//i.test(path)?'account_other':'other';
 const links=Array.isArray(inspection.links)?inspection.links:[];
 return {observed:true,pageKind,visibleControls:Math.min(Array.isArray(inspection.controls)?inspection.controls.length:0,100),visibleButtons:Math.min(Array.isArray(inspection.buttons)?inspection.buttons.length:0,100),applicationsLink:links.some(link=>/^\/SmartForm\/?$/.test(link?.path||'')),newApplicationLink:links.some(link=>link?.path==='/SmartForm/TraditionalApp'),loginLink:links.some(link=>/^\/Account\/Login(?:individuals)?\/?$/i.test(link?.path||''))};
}
async function loginGovernmentAccount(ctx){
 const {record:r,api:rawApi,wait}=ctx;r.phase='login';let otpSubmitted=false,lastStage='unconfirmed',lastEvidence={},lastMenuInspection=null;
 const api=async(action,...args)=>{try{return await rawApi(action,...args);}catch(error){const operations=new Set(['start','auto-login','current','auto-verify','inspect-account-menu']);console.info('[RAAD_LOGIN_FINAL] '+JSON.stringify({otpSubmitted,...lastEvidence,failedOperation:operations.has(action)?action:'unconfirmed'}));throw error;}};
 const stages=new Set(['awaiting_input','submitted_unverified','verification_required','verification_submitted','verification_unconfirmed','authenticated','result_unverified','login_not_completed','no_session']);
 const report=(operation,state)=>{const stage=stages.has(state?.stage)?state.stage:'unconfirmed';if(r.loginDiagnostic?.operation===operation&&r.loginDiagnostic?.stage===stage)return;r.loginDiagnostic={operation,stage};console.info('[RAAD_LOGIN_DIAGNOSTIC] '+JSON.stringify(r.loginDiagnostic));};
 const started=await api('start');r.sessionId=started.sessionId;report('start',started);if(!r.sessionId||started.automaticCaptcha!==true)throw finite('AUTOMATIC_LOGIN_UNAVAILABLE');
 const submitted=await api('auto-login');report('submit',submitted);if(submitted.submitted!==true){const reasons=new Set(['DISABLED','READ_ALREADY_ATTEMPTED','IMAGE_CHANGED','CANCELLED','UNREADABLE','BRIDGE_UNAVAILABLE','PROVIDER_UNAVAILABLE','TIMEOUT','INVALID_PROVIDER_REPLY','RATE_LIMITED','BUSY','IMAGE_LIMIT']);throw finite('LOGIN_CAPTCHA_'+(reasons.has(submitted.captcha?.reason)?submitted.captcha.reason:'UNCONFIRMED'));}
 for(let poll=0;poll<30;poll++){
  await wait(1500);const state=await api('current',{},false);report('observe',state);lastStage=state.stage;lastEvidence=loginDiagnosticEvidence({...state,menuInspection:lastMenuInspection});
  if(state.stage==='authenticated'||state.accountSignals?.accountUiVerified===true)return;
  if(state.stage==='verification_required'){
   if(otpSubmitted)throw finite('LOGIN_EMAIL_OTP_REJECTED');
   if(state.automaticOtp!==true)throw finite('LOGIN_EMAIL_OTP_UNAVAILABLE');
   const verified=await api('auto-verify');report('email_otp',verified);if(verified.submitted!==true)throw finite('LOGIN_EMAIL_OTP_UNCONFIRMED');otpSubmitted=true;continue;
  }
  if(state.stage==='result_unverified'&&otpSubmitted){
   const menu=await api('inspect-account-menu');lastMenuInspection=menu.menuInspection||null;const checked=await api('current',{},false);report('account_check',checked);lastEvidence=loginDiagnosticEvidence({...checked,menuInspection:lastMenuInspection});if(checked.stage==='authenticated'||checked.accountSignals?.accountUiVerified===true)return;
  }
  if(state.stage==='login_not_completed')throw finite('LOGIN_REJECTED');
  if(state.stage==='verification_unconfirmed')throw finite('LOGIN_EMAIL_OTP_UNCONFIRMED');
  if(state.stage==='no_session')throw finite('LOGIN_SESSION_LOST');
 }
 let pageEvidence={observed:false};try{const inspected=await rawApi('inspect-page',{},false);pageEvidence=loginPageEvidence(inspected?.inspection);}catch{}
 console.info('[RAAD_LOGIN_FINAL] '+JSON.stringify({otpSubmitted,...lastEvidence,pageEvidence}));
 throw finite(otpSubmitted?'LOGIN_EMAIL_OTP_UNCONFIRMED':lastStage==='result_unverified'?'LOGIN_ACCOUNT_UI_UNCONFIRMED':'LOGIN_UNCONFIRMED');
}

async function runGovernmentJob(ctx,{resume=false}={}){
 const {record:r,manifest:m,api,wait}=ctx,f=m.facts;
 const checkEstimatedDate=()=>{if(m.entryDateProvenance?.source==='office_estimate')assertEstimatedEntryDateCurrent({provenance:m.entryDateProvenance,date:f.entryDate,now:ctx.now(),existingApplicationReference:m.existingApplicationReference});};
 checkEstimatedDate();
 const inspect=async()=>{const result=await api('inspect-page',{},false);if(!result.inspection)throw finite('PORTAL_INSPECTION_UNAVAILABLE');return result.inspection;};
 const locate=async()=>{const state=await ctx.locate();if(!state||typeof state.path!=='string')throw finite('PORTAL_LOCATION_UNAVAILABLE');return state;};
 const settle=async()=>{await wait(1200);return inspect();};
 const fill=async(field)=>{const result=await api('fill-draft',{fields:[field]});if(result.filledCount!==1)throw finite('FIELD_FILL_UNCONFIRMED');if((await locate()).path==='/SmartForm/TraditionalApp'&&field.kind!=='select-label'){r.expectedDraft??=[];const expected=readbackForField(field);const index=r.expectedDraft.findIndex(item=>field.kind==='radio'?item.kind==='radio'&&item.name===field.name:item.id===field.id);if(index>=0)r.expectedDraft[index]=expected;else r.expectedDraft.push(expected);}};
 const setDate=async(id,isoDate)=>{const result=await api('set-dates',{dates:[{id,isoDate}]});if(result.filledCount!==1)throw finite('DATE_FILL_UNCONFIRMED');};
 const originalButton=async(inspection,mode,expectedFields=[])=>{const pattern=mode==='submit'?/^(?:حفظ|حفظ الطلب|Save)$/i:mode==='agreement'?/^(?:موافق|أوافق|اوافق|Agree|I Agree)$/i:/^(?:التالي|متابعة|Next|Continue)$/i;const matches=(inspection.buttons||[]).filter(button=>!button.disabled&&pattern.test(button.label));if(matches.length!==1)throw finite('PORTAL_BUTTON_AMBIGUOUS');if(mode==='submit')ctx.assertSubmissionAllowed?.();r.saveDispatched=mode==='submit'&&(await locate()).path==='/SmartForm/TraditionalApp'||r.saveDispatched;return api('activate-control',{label:matches[0].label,mode,expectedFields,...(mode==='submit'&&r.smsWindow?assertSmsWindow(r.smsWindow,ctx.now()):{})});};
 const open=async(link,extra={})=>{if(!link)throw finite('PORTAL_LINK_UNAVAILABLE');return api('open-page',{path:link.path,label:link.label,...extra});};
 const lookup=async()=>{if((await locate()).path!=='/SmartForm')throw finite('CASE_LOOKUP_PAGE_REQUIRED');const result=await api('lookup-applications',{passportNumber:f.passportNumber},false);if(!result.lookupSupported||result.matchCount>1||result.matches?.length>1)throw finite('CASE_LOOKUP_UNCONFIRMED');return result;};
 const returnToList=async()=>{let metadata=await inspect();const links=(metadata.links||[]).filter(link=>link.path==='/SmartForm'&&/^(?:عودة|العودة|رجوع|Back|Return)$/i.test(link.label));if(links.length!==1)throw finite('OBSERVED_RETURN_UNAVAILABLE');await open(links[0]);if((await locate()).path!=='/SmartForm')throw finite('RETURN_UNCONFIRMED');return lookup();};
 const finish=async()=>{r.phase='return';const matches=await returnToList();if(matches.matchCount!==1)throw finite('SAVED_CASE_UNCONFIRMED');const match=matches.matches[0];if(r.reference&&r.reference!==match.applicationReference)throw finite('SAVED_REFERENCE_MISMATCH');r.reference=match.applicationReference;r.saved=true;r.returnedFromPayment=true;r.phase='print';await ctx.checkLease();const artifact=await ctx.withPage(page=>ctx.capturePdf(page,{applicationReference:r.reference,passportNumber:f.passportNumber,guard:ctx.checkLease,signal:r.controller.signal}));if(!artifact||!Buffer.isBuffer(artifact.buffer)||artifact.applicationReference!==r.reference||artifact.buffer.length>10000000||artifact.buffer.subarray(0,5).toString()!=='%PDF-'||crypto.createHash('sha256').update(artifact.buffer).digest('hex')!==artifact.sha256)throw finite('ARTIFACT_PROOF_INVALID');r.artifact=artifact;};
 if(!resume){
  if(typeof f.saudiAddress==='string'&&/^(?:none|not[_ ]specified|غير محدد|لم تحدد بعد)$/iu.test(f.saudiAddress.trim()))throw finite('SAUDI_ADDRESS_UNSPECIFIED_REQUIRES_PORTAL_REVIEW','saudiAddress');
  // Validate human facts before opening a government session. Missing grandparent
  // names deliberately remain blank; no health/marital answer is inferred.
  for(const key of ['nationalityCode','passportNumber','passportType','issuingCountryCode','issueDate','expiryDate','birthDate','birthPlace','sex','latinFirstName','latinFatherName','latinFamilyName','arabicFirstName','arabicFatherName','arabicFamilyName','maritalStatus','previousNationality','travelledLastFiveYears','performUmrah','saudiAddress','transport','arrivalPort','gccResident','priorGccDeportation','priorGccRuleViolation','contactEmail','insurancePhone','postalCode','city','postOfficeBox'])required(f,key);
  abuDhabiMission(f.mission);required(f,'entryDate');if(f.visitPurpose!=='tourism'||f.residenceCountryCode!=='ARE')throw finite('SUPPORTED_WORKFLOW_REQUIRED',f.visitPurpose!=='tourism'?'visitPurpose':'residenceCountryCode');const born=new Date(f.birthDate+'T00:00:00Z'),entry=new Date(f.entryDate+'T00:00:00Z');let age=entry.getUTCFullYear()-born.getUTCFullYear();if(entry.getUTCMonth()<born.getUTCMonth()||entry.getUTCMonth()===born.getUTCMonth()&&entry.getUTCDate()<born.getUTCDate())age--;if(!Number.isFinite(age)||age<18||Object.values(f.guardian||{}).some(Boolean))throw finite('MANUAL_REVIEW_REQUIRED','guardian');if(f.gccResident!==true)throw finite('GCC_RESIDENCY_REQUIRED','gccResident');for(const key of ['previousNationality','travelledLastFiveYears'])if(f[key]===true)throw finite('MANUAL_REVIEW_REQUIRED',key);if(f.priorGccDeportation||f.priorGccRuleViolation)throw finite('ELIGIBLE_ROUTE_REVIEW_REQUIRED',f.priorGccDeportation?'priorGccDeportation':'priorGccRuleViolation');for(const key of HEALTH)if(typeof f.health?.[key]!=='boolean')throw finite('MISSING_FIELD','health.'+key);required(f,'emiratesId');required(f,'residenceExpiry');supervisorSmsRoute(ctx.supervisorSmsContract,ctx.now());
  await loginGovernmentAccount(ctx);r.phase='lookup';
  let metadata=await inspect();for(let nav=0;(await locate()).path!=='/SmartForm'&&nav<3;nav++){const links=(metadata.links||[]).filter(link=>link.path==='/SmartForm'&&/طلب|تأشير|تاشير|application|visa/i.test(link.label));if(links.length!==1)throw finite('CASE_LIST_LINK_UNAVAILABLE');await open(links[0]);metadata=await settle();}
  const existing=await lookup();if(existing.matchCount){const match=existing.matches[0];if(!m.existingApplicationReference||match.applicationReference!==m.existingApplicationReference)throw finite('EXISTING_APPLICATION_REVIEW_REQUIRED');r.reference=match.applicationReference;r.saved=true;const continuations=match.continuations||[],link=continuations.find(item=>/^\/SmartForm\/HealthInsuranceInfo\/[0-9]+$/.test(item.path))||continuations.find(item=>/^\/SmartForm\/PayFee\/[0-9]+$/.test(item.path));if(!link)throw finite('SAVED_CONTINUATION_UNAVAILABLE');await open(link,{viewPaymentDetails:/\/PayFee\//.test(link.path)});}
  else{if(m.existingApplicationReference||m.submissionUncertain)throw finite('SAVED_CASE_UNCONFIRMED');r.phase='agreements';metadata=await inspect();let link=(metadata.links||[]).filter(item=>item.path==='/SmartForm/Agreement'&&/إضافة طلب جديد|اضافة طلب جديد/i.test(item.label));if(link.length!==1)throw finite('NEW_APPLICATION_LINK_UNAVAILABLE');await open(link[0]);for(let step=0;step<3&&(await locate()).path!=='/SmartForm/TraditionalApp';step++){metadata=await inspect();const path=(await locate()).path;if(!['/SmartForm/Agreement','/SmartForm/ElectronicAgreement'].includes(path))throw finite('AGREEMENT_FLOW_UNCONFIRMED');const links=(metadata.links||[]).filter(item=>/^\/SmartForm\/(?:ElectronicAgreement|TraditionalApp)$/.test(item.path)&&/^(?:موافق|أوافق|اوافق|Agree|I Agree)$/i.test(item.label));if(links.length===1)await open(links[0],{acceptAgreement:true});else if(path==='/SmartForm/Agreement')await originalButton(metadata,'agreement');else throw finite('AGREEMENT_CONTROL_UNAVAILABLE');await wait(700);}
   if((await locate()).path!=='/SmartForm/TraditionalApp')throw finite('DRAFT_FORM_UNAVAILABLE');r.phase='draft';
   const control=async id=>{const data=await inspect(),all=(data.controls||[]).filter(c=>c.id===id&&!c.disabled);if(all.length!==1)throw finite('PORTAL_FIELD_UNAVAILABLE',id);return all[0];};
   const select=async(id,values,key)=>{const c=await control(id),option=optionFor(c,values,key);await fill({id,kind:'select',value:option.value});};
   await fill({id:'VisaKind',kind:'select',value:tourismOption(await control('VisaKind')).value});await select('NATIONALITY',[f.nationalityCode,...countryLabels(f.nationalityCode)],'nationalityCode');await select('ddlResidenceCountry',['270',...countryLabels(f.residenceCountryCode||'ARE')],'residenceCountryCode');
   await fill({id:'3',name:'TourismEVisaRequestTypeId',optionValue:'3',kind:'radio',value:true});
   await fill({id:'EmbassyCode',kind:'select',value:abuDhabiOption(await control('EmbassyCode')).value});
   let data=await inspect();const noJob=(data.controls||[]).filter(c=>c.id==='Has_Job'&&!c.disabled&&c.required);if(noJob.length){if(f.noEmployment!==true)throw finite('MISSING_FIELD','noEmployment');await fill({id:'Has_Job',kind:'check',value:true});}
   for(const [id,key] of [['RELIGION','religion'],['JOB_OR_RELATION_Id','occupation']]){const visible=(await inspect()).controls.find(c=>c.id===id&&!c.disabled);if(visible&&(visible.required||f[key])){const values=key==='religion'&&/^(?:islam|muslim|اسلام|الاسلام|مسلم)$/i.test(norm(required(f,key)))?[f[key],'اسلام','الإسلام','مسلم','islam','muslim']:[required(f,key)];await select(id,values,key);}}
   for(const [key,id]of Object.entries(TEXT_FIELDS)){const value=f[key];if(key.includes('Grandfather')&&!value){if((await inspect()).controls.some(c=>c.id===id&&!c.disabled))await fill({id,kind:'text',value:''});continue;}if(value!==undefined&&value!=='')await fill({id,kind:'text',value});}
   await select('SOCIAL_STATUS',norm(f.maritalStatus)==='single'?['1','اعزب','single']:[f.maritalStatus,...({married:['متزوج'],divorced:['مطلق'],widowed:['ارمل','أرمل'],separated:['منفصل']}[f.maritalStatus]||[])],'maritalStatus');await select('Sex',/^(?:male|ذكر|m)$/i.test(f.sex)?['1','ذكر','male']:/^(?:female|انثى|أنثى|f)$/i.test(f.sex)?[f.sex,'انثى','أنثى','female']:[f.sex,'غير محدد'],'sex');await select('PASSPORType',/^(?:ordinary|normal|عادي)$/i.test(f.passportType)?['1','عادي','ordinary']:[f.passportType,...({diplomatic:['دبلوماسي'],service:['خدمة'],special:['خاص']}[f.passportType]||[])],'passportType');await select('PASSPORT_ISSUE_PLACE',countryLabels(f.issuingCountryCode),'issuingCountryCode');await select('COMING_THROUGH',transportValues(f.transport),'transport');await select('ENTRY_POINT',/الملك خالد|king khalid/i.test(f.arrivalPort)?['1',f.arrivalPort]:[f.arrivalPort],'arrivalPort');await select('TourismEVisaIssuingCountryCode',countryLabels(f.residenceCountryCode||'ARE'),'residenceCountryCode');
   for(const [key,id,name]of [['previousNationality','No','Has_NATIONALITY_FIRST'],['travelledLastFiveYears','HaveTraveledToOtherCountriesNo','HaveTraveledToOtherCountries'],['performUmrah',f.performUmrah?'PerformUmrahYes':'PerformUmrahNo','PerformUmrah']]){const optionValue=key==='previousNationality'?'0':String(f[key]);await fill({id,name,optionValue,kind:'radio',value:true});}
   for(const id of ['IsVisaEndDateOptional','Endorsement','IsPrivacyPolicyAgreed','terms_and_conditions']){const c=await control(id);if(c.type!=='checkbox')throw finite('PORTAL_FIELD_UNAVAILABLE',id);await fill({id,kind:'check',value:id!=='IsVisaEndDateOptional'});}
   const entryDateControl=await control('ExpectedEntryDate');verifyExpectedEntryDateField(entryDateControl);if(m.entryDateProvenance?.source==='office_estimate')r.entryDateEvidence=verifyExpectedEntryDate(entryDateControl,{provenance:m.entryDateProvenance,date:f.entryDate,now:ctx.now()});
   for(const [key,id]of Object.entries(DATE_FIELDS))await setDate(id,required(f,key));
   await waitForPhoneSection({inspect,wait,guard:ctx.checkLease,locate,now:ctx.now});
   const smsRoute=supervisorSmsRoute(ctx.supervisorSmsContract,ctx.now()),phonePrefix=await control('MobileInfo_MobilePrefix'),prefix=(phonePrefix.options||[]).filter(option=>{const codes=[...String(option.label||'').matchAll(/\((?:00|\+)?([1-9][0-9]{0,3})\)/g)];return codes.length===1&&codes[0][1]===smsRoute.dialCode&&/السعودي[ةه]|saudi/i.test(norm(option.label));});if(prefix.length!==1)throw finite('PHONE_PREFIX_UNCONFIRMED');await fill({id:'MobileInfo_MobilePrefix',kind:'select-label',value:prefix[0].label});await fill({id:'MobileInfo_Mobile',kind:'text',value:smsRoute.nationalNumber});
   for(const doc of m.documents){const id={passport:'PassportImageFile',residence:'IqamaOrVisaImageFile',portrait:'PersonalImage'}[doc.role];await control(id);const result=await api('upload-documents',{documents:[{id,role:doc.role,mimeType:doc.mimeType,name:doc.role+(doc.mimeType==='image/png'?'.png':'.jpg'),data:doc.data}]});if(result.uploadedCount!==1)throw finite('DOCUMENT_UPLOAD_UNCONFIRMED');doc.data='';}
   checkEstimatedDate();r.phase='application_sms';const sms=await api('inspect-application-sms',{},false);const buttons=(sms.verification?.buttons||[]).filter(button=>!button.disabled&&/send|request|ارسال|إرسال/i.test([button.id,button.name,button.label,button.title,button.ariaLabel].join(' '))&&!/resend|اعادة|إعادة/i.test([button.id,button.name,button.label,button.title,button.ariaLabel].join(' ')));if(buttons.length!==1)throw finite('APPLICATION_SMS_CONTROL_UNAVAILABLE');const requested=await api('request-application-sms',{id:buttons[0].id||undefined,label:buttons[0].label});confirmSmsRequest(r,requested);const nativeWindow=assertSmsWindow(requested,ctx.now());Object.assign(r,nativeWindow);r.smsWindow=Object.freeze(nativeWindow);r.stage='waiting_otp';return;
  }
 }
 if(resume){checkEstimatedDate();if(m.entryDateProvenance?.source==='office_estimate'){const dateControls=(await inspect()).controls?.filter(c=>c.id==='ExpectedEntryDate'&&!c.disabled)||[];if(dateControls.length!==1)throw finite('ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');verifyExpectedEntryDate(dateControls[0],{provenance:m.entryDateProvenance,date:f.entryDate,now:ctx.now()});}r.phase='application_sms';assertSmsWindow(r.smsWindow,ctx.now());let code=r.pendingCode;r.pendingCode='';try{if(typeof code!=='string')throw finite('OTP_CHALLENGE_STALE');const result=await api('enter-application-sms',{code,...assertSmsWindow(r.smsWindow,ctx.now())});if(!result.codeEntered)throw finite('APPLICATION_SMS_ENTRY_UNCONFIRMED');}finally{code='';}ctx.assertSubmissionAllowed?.();r.phase='save';assertSmsWindow(r.smsWindow,ctx.now());await api('refresh-form-captcha');await api('solve-form-captcha');const meta=await inspect();if(!Array.isArray(r.expectedDraft)||r.expectedDraft.length>40)throw finite('DRAFT_READBACK_UNCONFIRMED');checkEstimatedDate();const submittedDate=verifiedSubmittedEntryDate(f.entryDate);if(r.submittedEntryDate&&r.submittedEntryDate!==submittedDate)throw finite('SUBMITTED_ENTRY_DATE_CONFLICT');r.submittedEntryDate=submittedDate;assertSmsWindow(r.smsWindow,ctx.now());await originalButton(meta,'submit',r.expectedDraft);await wait(1000);let path=(await locate()).path;if(path==='/SmartForm/TraditionalApp'){const confirmation=await api('inspect-confirmation',{},false);if(confirmation.confirmation?.confirmationHash!==KNOWN_PLEDGE)throw finite('APPLICATION_PLEDGE_UNCONFIRMED');await api('confirm-application',{...assertSmsWindow(r.smsWindow,ctx.now()),label:'استمرار',confirmationHash:KNOWN_PLEDGE,expectedFields:[{id:'PASSPORTnumber',kind:'text',expectedValue:f.passportNumber}]});await wait(1200);path=(await locate()).path;}if(!/^\/SmartForm\/HealthInsuranceInfo\/[0-9]{1,20}$/.test(path))throw finite('SAVE_UNCERTAIN');r.savedRoute=path;r.smsWindow=null;
  // The list was observed before creating this draft. Revisit it read-only and
  // prove the unique passport row, then restore the original Health view with
  // native history. This records a saved draft even if insurance later blocks.
  r.phase='lookup';await ctx.checkLease();await ctx.withPage(async page=>{await ctx.checkLease();await page.goto(ORIGIN+'/SmartForm',{waitUntil:'domcontentloaded',timeout:30000});});const verified=await lookup();if(verified.matchCount!==1)throw finite('SAVED_CASE_UNCONFIRMED');r.reference=verified.matches[0].applicationReference;r.saved=true;r.savedEntryDateEvidence={source:'verified_current_run_submission',date:verifiedSubmittedEntryDate(r.submittedEntryDate),applicationReference:r.reference,caseSignature:m.caseSignature,applicantIndex:m.applicantIndex};await ctx.checkLease();await ctx.withPage(async page=>{await ctx.checkLease();await page.goBack({waitUntil:'domcontentloaded',timeout:30000});});if((await locate()).path!==path)throw finite('SAVED_CONTINUATION_UNCONFIRMED');}
 let state=await locate();
 if(/^\/SmartForm\/HealthInsuranceInfo\/[0-9]{1,20}$/.test(state.path)){
  r.phase='health';const insuranceDateControls=(await inspect()).controls?.filter(c=>c.id==='ExpectedEntryDate'&&!c.disabled)||[];if(insuranceDateControls.length!==1)throw finite('ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');const savedEntryDate=insuranceEntryDate(insuranceDateControls[0],{evidence:r.savedEntryDateEvidence,applicationReference:r.reference,caseSignature:m.caseSignature,applicantIndex:m.applicantIndex});for(const [id,key]of [['PostOfficeBox','postOfficeBox'],['City','city'],['ZipCode','postalCode'],['Email','contactEmail'],['Mobile','insurancePhone']])await fill({id,kind:'text',value:required(f,key)});await setDate('ExpectedEntryDate',savedEntryDate);
  const names=['DeclarationForms[0].Q1_IsReceivingEmergencyTreatment','DeclarationForms[0].Q2_HavePermenantInjury','DeclarationForms[0].Q3_HaveCongenitalDisorders'];for(let i=0;i<names.length;i++)await fill({kind:'radio',name:names[i],optionValue:String(f.health[HEALTH[i]]),value:true});await originalButton(await inspect(),'submit',[{id:'Email',kind:'text',expectedValue:f.contactEmail},...names.map((name,i)=>({kind:'radio',name,optionValue:String(f.health[HEALTH[i]]),expectedValue:true}))]);await wait(1200);state=await locate();
 }
 if(/^\/SmartForm\/HealthInsurance\/[0-9]{1,20}$/.test(state.path)){r.phase='insurance';const first=chooseCheapest(await inspect());await wait(900);const second=chooseCheapest(await inspect());if(first.fingerprint!==second.fingerprint)throw finite('INSURANCE_QUOTES_CHANGED');await fill({kind:'radio',name:'CompanyNumber',optionValue:first.choice,value:true});await originalButton(await inspect(),'submit',[{kind:'radio',name:'CompanyNumber',optionValue:first.choice,expectedValue:true}]);await wait(1000);state=await locate();}
 if(state.path!=='/Payment/Summary')throw finite('PAYMENT_SUMMARY_UNCONFIRMED');await finish();
}
module.exports={transportValues,loginPageEvidence,loginDiagnosticEvidence,loginGovernmentAccount,createProductionWorker,validateManifest,runGovernmentJob,chooseCheapest,uaePhone,readbackForField,finite};
