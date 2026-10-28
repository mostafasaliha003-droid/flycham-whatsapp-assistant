'use strict';
const crypto=require('node:crypto');
const {FIELD_ALLOWLIST}=require('../raad-visa-workflow');
const {captureApplicationPdf}=require('./portal-print');
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
 return {jobId:input.jobId,leaseToken:input.leaseToken,caseId:input.caseId,applicantIndex:input.applicantIndex,caseSignature:input.caseSignature,clientConsent:{...consent},facts,documents,existingApplicationReference:existing||null,submissionUncertain:input.submissionUncertain===true};
}
function uaePhone(value){if(typeof value!=='string'||!/^\+?[0-9 ()-]{7,25}$/.test(value))throw finite('MISSING_FIELD','applicationPhone');let digits=value.replace(/[^0-9]/g,'');if(digits.startsWith('00971'))digits=digits.slice(5);else if(digits.startsWith('971')&&digits.length===12)digits=digits.slice(3);if(digits.startsWith('0')&&digits.length===10)digits=digits.slice(1);if(!/^5[0-9]{8}$/.test(digits))throw finite('PHONE_FORMAT_UNCONFIRMED','applicationPhone');return digits;}
function createProductionWorker({env=process.env,adapter,leaseFetch=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),runFlow=runGovernmentJob}={}){
 if(!adapter||typeof adapter.reserve!=='function'||typeof adapter.call!=='function')throw finite('WORKER_ADAPTER_REQUIRED');
 let active=null,admitting=false;const records=new Map();
 const configured=()=>{try{const u=new URL(env.RAAD_MAIN_URL||MAIN_ORIGIN);return typeof env.RAAD_JOB_BRIDGE_KEY==='string'&&env.RAAD_JOB_BRIDGE_KEY.length>=32&&u.origin===MAIN_ORIGIN&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password;}catch{return false;}};
 const status=record=>({jobId:record.id,stage:record.stage,phase:record.phase,reference:record.reference||null,saved:record.saved===true,submissionUncertain:record.submissionUncertain===true,requiresOtp:record.stage==='waiting_otp',challengeId:record.stage==='waiting_otp'?record.challengeId:null,challengeExpiresAt:record.stage==='waiting_otp'?record.challengeExpiresAt:null,artifactReady:record.stage==='completed'&&Boolean(record.artifact)&&record.saved&&record.returnedFromPayment,blocker:record.blocker||null,paymentAttempted:false,returnedFromPayment:record.returnedFromPayment===true,ownedBrowserClosed:record.ownedBrowserClosed===true,caseSignature:record.caseSignature,applicantIndex:record.applicantIndex,artifactSha256:record.artifact?.sha256||null});
 const scrub=record=>{if(record.manifest){for(const doc of record.manifest.documents||[])doc.data='';record.manifest.facts={};record.manifest.documents=[];record.manifest.clientConsent=null;record.manifest.leaseToken='';record.manifest=null;}};
 async function checkLease(record){
  if(record.cancelled||record.controller.signal.aborted)throw finite('JOB_CANCELLED');
  let current=false;try{const response=await leaseFetch(new URL('/internal/assistant/visa-portal/jobs/'+encodeURIComponent(record.id)+'/lease',env.RAAD_MAIN_URL||MAIN_ORIGIN),{method:'GET',headers:{Authorization:'Bearer '+env.RAAD_JOB_BRIDGE_KEY,'X-Raad-Lease-Token':record.leaseToken},redirect:'error',signal:AbortSignal.any([record.controller.signal,AbortSignal.timeout(5000)])});current=response.ok&&(await response.json()).current===true;}catch{}
  if(record.cancelled||record.controller.signal.aborted)throw finite('JOB_CANCELLED');if(!current)throw finite('LEASE_REVOKED');
 }
 async function closeOwned(record){
  if(record.ownedBrowserClosed)return true;let closed=false;try{closed=await adapter.close(record.reservation,record.sessionId)===true;}catch{}
  if(closed){record.ownedBrowserClosed=true;try{await adapter.release?.(record.reservation);}catch{}if(active===record)active=null;}return closed;
 }
 const apiFor=record=>async(action,data={},mutation=true)=>{if(mutation)await checkLease(record);if(record.cancelled)throw finite('JOB_CANCELLED');return adapter.call(action,{...data,...(record.sessionId?{sessionId:record.sessionId}:{})},{reservation:record.reservation,signal:record.controller.signal});};
 async function execute(record,resume=false){
  if(record.running)return;record.running=true;record.stage='running';record.blocker=null;
  try{
   await checkLease(record);
   const context={record,manifest:record.manifest,api:apiFor(record),checkLease:()=>checkLease(record),wait,now,withPage:fn=>adapter.withPage(record.reservation,record.sessionId,fn,()=>checkLease(record)),locate:()=>adapter.locate?.(record.reservation,record.sessionId),capturePdf:captureApplicationPdf};
   await runFlow(context,{resume});
   if(record.cancelled)throw finite('JOB_CANCELLED');
   if(record.stage==='waiting_otp'){const challenge=record.challengeId;clearTimeout(record.otpTimer);record.otpTimer=setTimeout(()=>{void expireOtp(record,challenge);},Math.max(1,record.challengeExpiresAt-now()));record.otpTimer.unref?.();return;}
   if(!record.artifact||!record.saved||!record.returnedFromPayment)throw finite('COMPLETION_PROOF_REQUIRED');
   if(!await closeOwned(record))throw finite('OWNED_BROWSER_CLEANUP_UNCONFIRMED');record.stage='completed';record.phase='done';scrub(record);
  }catch(error){
   if(record.cancelled)return;
   const code=/^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code||'')?error.code:'PRODUCTION_UNCONFIRMED';
   record.stage=code==='LEASE_REVOKED'?'lease_lost':'blocked';record.blocker={code,...(error?.field?{field:error.field}:{})};
   if(record.saveDispatched&&!record.saved){record.submissionUncertain=true;if(code!=='LEASE_REVOKED')record.blocker={code:'SAVE_UNCERTAIN'};}
   await closeOwned(record);scrub(record);
  }finally{if(record.cancelled&&record.artifact?.buffer){record.artifact.buffer.fill(0);record.artifact=null;}record.running=false;}
 }
 async function expireOtp(record,challenge){if(record.stage!=='waiting_otp'||record.challengeId!==challenge||record.cancelled)return;record.stage='blocked';record.blocker={code:'OTP_CHALLENGE_EXPIRED'};record.challengeId=null;record.challengeExpiresAt=null;record.pendingCode='';record.controller.abort();await closeOwned(record);scrub(record);}
 async function start(input){
  if(!configured())throw finite('BRIDGE_DISABLED');if(admitting)throw finite('WORKER_BUSY');admitting=true;
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
 async function otp(id,input){const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');if(record.stage!=='waiting_otp'||record.running||record.challengeId!==input?.challengeId||now()>record.challengeExpiresAt)throw finite('OTP_CHALLENGE_STALE');if(typeof input.code!=='string'||! /^[0-9]{4,8}$/.test(input.code))throw finite('OTP_INPUT_INVALID');await checkLease(record);if(record.stage!=='waiting_otp'||record.running||record.challengeId!==input?.challengeId||now()>record.challengeExpiresAt)throw finite('OTP_CHALLENGE_STALE');clearTimeout(record.otpTimer);record.pendingCode=input.code;record.challengeId=null;record.challengeExpiresAt=null;void execute(record,true);return {accepted:true,...status(record)};}
 async function cancel(id){if(typeof id!=='string'||!JOB.test(id))throw finite('JOB_ID_INVALID');const record=records.get(id)||(active?.id===id?active:null);if(!record)return {jobId:id,stage:'cancelled',ownedBrowserClosed:true,absent:true};record.cancelled=true;clearTimeout(record.otpTimer);record.controller.abort();if(record.pendingCode)record.pendingCode='';if(!await closeOwned(record)){record.stage='blocked';record.blocker={code:'OWNED_BROWSER_CLEANUP_UNCONFIRMED'};throw finite('OWNED_BROWSER_CLEANUP_UNCONFIRMED');}record.stage='cancelled';record.phase='done';record.blocker=null;record.challengeId=null;record.challengeExpiresAt=null;if(record.artifact?.buffer)record.artifact.buffer.fill(0);record.artifact=null;scrub(record);return status(record);}
 function get(id){const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');return status(record);}
 function artifact(id){const record=records.get(id);if(!record)throw finite('JOB_NOT_FOUND');if(record.stage!=='completed'||!record.saved||!record.returnedFromPayment||!record.artifact?.buffer)throw finite('ARTIFACT_NOT_READY');return record.artifact;}
 const authorized=value=>{if(!configured())return false;const wanted=Buffer.from('Bearer '+env.RAAD_JOB_BRIDGE_KEY),actual=Buffer.from(typeof value==='string'?value:'');return wanted.length===actual.length&&crypto.timingSafeEqual(wanted,actual);};
 async function handler(req,res,url,{readBody}={}){
  if(!url.pathname.startsWith('/internal/raad/'))return false;
  const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
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
 return {start,status:get,otp,cancel,artifact,handler,health:()=>({enabled:configured(),activeJob:active!==null}),async shutdown(){if(active)try{await cancel(active.id);}catch{}}};
}

const TEXT_FIELDS={latinFirstName:'EFIRSTNAME',latinFatherName:'EFATHER',latinGrandfatherName:'EGRAND',latinFamilyName:'EFAMILY',arabicFirstName:'AFIRSTNAME',arabicFatherName:'AFATHER',arabicGrandfatherName:'AGRAND',arabicFamilyName:'AFAMILY',passportNumber:'PASSPORTnumber',birthPlace:'BIRTH_PLACE',saudiAddress:'ADDRESS_HOME',emiratesId:'TourismEVisaIqamaOrVisaNo'};
const DATE_FIELDS={issueDate:'PASSPORT_ISSUE_DATE',expiryDate:'PASSPORT_EXPIRY_DATe',birthDate:'BIRTH_DATE',entryDate:'ExpectedEntryDate',residenceExpiry:'TourismEVisaIqamaOrVisaExpiryDate'};
const KNOWN_PLEDGE='345d81b52b2519097ac1f02e4c8b884d9c96030440ac04a730df6f908184054e';
function required(facts,key){const value=facts[key];if(value===undefined||value===null||value==='')throw finite('MISSING_FIELD',key);return value;}
function countryLabels(code){if(typeof code!=='string'||! /^[A-Z]{3}$/.test(code))return [code];const iso2={ARE:'AE',SYR:'SY',EGY:'EG',SAU:'SA',JOR:'JO',LBN:'LB',IRQ:'IQ',PSE:'PS',SDN:'SD',YEM:'YE',IND:'IN',PAK:'PK',BGD:'BD',PHL:'PH',GBR:'GB',USA:'US',CAN:'CA',TUR:'TR',DEU:'DE',FRA:'FR',KWT:'KW',QAT:'QA',BHR:'BH',OMN:'OM'}[code];return [code,...(iso2?['ar','en'].map(locale=>new Intl.DisplayNames([locale],{type:'region'}).of(iso2)):[])];}
function optionFor(control,values,field){const targets=values.filter(v=>v!==undefined&&v!==null).map(norm),matches=(control?.options||[]).filter(option=>option.value!==undefined&&!option.disabled&&!option.hidden&&option.value!==''&&(targets.includes(norm(option.value))||targets.includes(norm(option.label))));if(matches.length!==1)throw finite('PORTAL_OPTION_UNCONFIRMED',field);return matches[0];}
function readbackForField(field){if(field.kind==='select-label')return null;const expected={...field,expectedValue:field.value};delete expected.value;if(field.kind==='radio'&&!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(expected.id||''))delete expected.id;return expected;}
function chooseCheapest(inspection){
 const quotes=inspection?.insuranceQuotes;if(!quotes?.available||!Array.isArray(quotes.offers)||!quotes.offers.length)throw finite('INSURANCE_QUOTES_UNAVAILABLE');
 const offers=quotes.offers.map(offer=>{const amounts=[];for(const cell of offer.cells||[]){for(const match of String(cell).matchAll(/(?:\$|USD|US\s*dollars?|دولار(?:\s*امريكي)?)\s*([0-9]{1,5}(?:\.[0-9]{1,2})?)|([0-9]{1,5}(?:\.[0-9]{1,2})?)\s*(?:\$|USD|US\s*dollars?|دولار(?:\s*امريكي)?)/gi))amounts.push(Number(match[1]||match[2]));}const unique=[...new Set(amounts)];if(unique.length!==1||!Number.isFinite(unique[0])||unique[0]<=0||! /^[0-9]{3}$/.test(offer.publicChoice||''))throw finite('INSURANCE_PRICE_UNCONFIRMED');return {choice:offer.publicChoice,amount:unique[0],company:norm(offer.companyLabel)};});
 offers.sort((a,b)=>a.amount-b.amount||a.choice.localeCompare(b.choice));return {choice:offers[0].choice,fingerprint:crypto.createHash('sha256').update(JSON.stringify(offers)).digest('hex')};
}
async function runGovernmentJob(ctx,{resume=false}={}){
 const {record:r,manifest:m,api,wait}=ctx,f=m.facts;
 const inspect=async()=>{const result=await api('inspect-page',{},false);if(!result.inspection)throw finite('PORTAL_INSPECTION_UNAVAILABLE');return result.inspection;};
 const locate=async()=>{const state=await ctx.locate();if(!state||typeof state.path!=='string')throw finite('PORTAL_LOCATION_UNAVAILABLE');return state;};
 const settle=async()=>{await wait(1200);return inspect();};
 const fill=async(field)=>{const result=await api('fill-draft',{fields:[field]});if(result.filledCount!==1)throw finite('FIELD_FILL_UNCONFIRMED');if((await locate()).path==='/SmartForm/TraditionalApp'&&field.kind!=='select-label'){r.expectedDraft??=[];const expected=readbackForField(field);const index=r.expectedDraft.findIndex(item=>field.kind==='radio'?item.kind==='radio'&&item.name===field.name:item.id===field.id);if(index>=0)r.expectedDraft[index]=expected;else r.expectedDraft.push(expected);}};
 const setDate=async(id,isoDate)=>{const result=await api('set-dates',{dates:[{id,isoDate}]});if(result.filledCount!==1)throw finite('DATE_FILL_UNCONFIRMED');};
 const originalButton=async(inspection,mode,expectedFields=[])=>{const pattern=mode==='submit'?/^(?:حفظ|حفظ الطلب|Save)$/i:mode==='agreement'?/^(?:موافق|أوافق|اوافق|Agree|I Agree)$/i:/^(?:التالي|متابعة|Next|Continue)$/i;const matches=(inspection.buttons||[]).filter(button=>!button.disabled&&pattern.test(button.label));if(matches.length!==1)throw finite('PORTAL_BUTTON_AMBIGUOUS');r.saveDispatched=mode==='submit'&&(await locate()).path==='/SmartForm/TraditionalApp'||r.saveDispatched;return api('activate-control',{label:matches[0].label,mode,expectedFields});};
 const open=async(link,extra={})=>{if(!link)throw finite('PORTAL_LINK_UNAVAILABLE');return api('open-page',{path:link.path,label:link.label,...extra});};
 const lookup=async()=>{if((await locate()).path!=='/SmartForm')throw finite('CASE_LOOKUP_PAGE_REQUIRED');const result=await api('lookup-applications',{passportNumber:f.passportNumber},false);if(!result.lookupSupported||result.matchCount>1||result.matches?.length>1)throw finite('CASE_LOOKUP_UNCONFIRMED');return result;};
 const returnToList=async()=>{let metadata=await inspect();const links=(metadata.links||[]).filter(link=>link.path==='/SmartForm'&&/^(?:عودة|العودة|رجوع|Back|Return)$/i.test(link.label));if(links.length!==1)throw finite('OBSERVED_RETURN_UNAVAILABLE');await open(links[0]);if((await locate()).path!=='/SmartForm')throw finite('RETURN_UNCONFIRMED');return lookup();};
 const finish=async()=>{r.phase='return';const matches=await returnToList();if(matches.matchCount!==1)throw finite('SAVED_CASE_UNCONFIRMED');const match=matches.matches[0];if(r.reference&&r.reference!==match.applicationReference)throw finite('SAVED_REFERENCE_MISMATCH');r.reference=match.applicationReference;r.saved=true;r.returnedFromPayment=true;r.phase='print';await ctx.checkLease();const artifact=await ctx.withPage(page=>ctx.capturePdf(page,{applicationReference:r.reference,passportNumber:f.passportNumber,guard:ctx.checkLease,signal:r.controller.signal}));if(!artifact||!Buffer.isBuffer(artifact.buffer)||artifact.applicationReference!==r.reference||artifact.buffer.length>10000000||artifact.buffer.subarray(0,5).toString()!=='%PDF-'||crypto.createHash('sha256').update(artifact.buffer).digest('hex')!==artifact.sha256)throw finite('ARTIFACT_PROOF_INVALID');r.artifact=artifact;};
 if(!resume){
  // Validate human facts before opening a government session. Missing grandparent
  // names deliberately remain blank; no health/marital answer is inferred.
  for(const key of ['nationalityCode','passportNumber','passportType','issuingCountryCode','issueDate','expiryDate','birthDate','birthPlace','sex','latinFirstName','latinFatherName','latinFamilyName','arabicFirstName','arabicFatherName','arabicFamilyName','maritalStatus','previousNationality','travelledLastFiveYears','performUmrah','saudiAddress','transport','arrivalPort','gccResident','priorGccDeportation','priorGccRuleViolation','applicationPhone','contactEmail','insurancePhone','postalCode','city','postOfficeBox'])required(f,key);
  required(f,'entryDate');if(f.visitPurpose!=='tourism'||f.residenceCountryCode!=='ARE')throw finite('SUPPORTED_WORKFLOW_REQUIRED',f.visitPurpose!=='tourism'?'visitPurpose':'residenceCountryCode');const born=new Date(f.birthDate+'T00:00:00Z'),entry=new Date(f.entryDate+'T00:00:00Z');let age=entry.getUTCFullYear()-born.getUTCFullYear();if(entry.getUTCMonth()<born.getUTCMonth()||entry.getUTCMonth()===born.getUTCMonth()&&entry.getUTCDate()<born.getUTCDate())age--;if(!Number.isFinite(age)||age<18||Object.values(f.guardian||{}).some(Boolean))throw finite('MANUAL_REVIEW_REQUIRED','guardian');if(f.gccResident!==true)throw finite('GCC_RESIDENCY_REQUIRED','gccResident');for(const key of ['previousNationality','travelledLastFiveYears'])if(f[key]===true)throw finite('MANUAL_REVIEW_REQUIRED',key);if(f.priorGccDeportation||f.priorGccRuleViolation)throw finite('ELIGIBLE_ROUTE_REVIEW_REQUIRED',f.priorGccDeportation?'priorGccDeportation':'priorGccRuleViolation');for(const key of HEALTH)if(typeof f.health?.[key]!=='boolean')throw finite('MISSING_FIELD','health.'+key);required(f,'emiratesId');required(f,'residenceExpiry');uaePhone(f.applicationPhone);
  r.phase='login';let authenticated=false;
  for(let attempt=0;attempt<3&&!authenticated;attempt++){
   if(attempt){const stopped=await api('close');if(!stopped.closed)throw finite('OWNED_BROWSER_CLEANUP_UNCONFIRMED');r.sessionId=null;}
   const started=await api('start');r.sessionId=started.sessionId;if(!r.sessionId||started.automaticCaptcha!==true)throw finite('AUTOMATIC_LOGIN_UNAVAILABLE');const submitted=await api('auto-login');if(!submitted.submitted)continue;
   for(let poll=0;poll<8;poll++){await wait(1500);const state=await api('current',{},false);if(state.stage==='verification_required'&&state.automaticOtp===true){await api('auto-verify');continue;}if(state.stage==='authenticated'||state.accountSignals?.accountUiVerified){authenticated=true;break;}if(state.stage==='result_unverified'){await api('inspect-account-menu');const check=await api('current',{},false);if(check.authenticated||check.accountSignals?.accountUiVerified){authenticated=true;break;}}if(['login_not_completed','verification_unconfirmed','no_session'].includes(state.stage))break;}
  }
  if(!authenticated)throw finite('LOGIN_UNCONFIRMED');r.phase='lookup';
  let metadata=await inspect();for(let nav=0;(await locate()).path!=='/SmartForm'&&nav<3;nav++){const links=(metadata.links||[]).filter(link=>link.path==='/SmartForm'&&/طلب|تأشير|تاشير|application|visa/i.test(link.label));if(links.length!==1)throw finite('CASE_LIST_LINK_UNAVAILABLE');await open(links[0]);metadata=await settle();}
  const existing=await lookup();if(existing.matchCount){const match=existing.matches[0];if(!m.existingApplicationReference||match.applicationReference!==m.existingApplicationReference)throw finite('EXISTING_APPLICATION_REVIEW_REQUIRED');r.reference=match.applicationReference;r.saved=true;const continuations=match.continuations||[],link=continuations.find(item=>/^\/SmartForm\/HealthInsuranceInfo\/[0-9]+$/.test(item.path))||continuations.find(item=>/^\/SmartForm\/PayFee\/[0-9]+$/.test(item.path));if(!link)throw finite('SAVED_CONTINUATION_UNAVAILABLE');await open(link,{viewPaymentDetails:/\/PayFee\//.test(link.path)});}
  else{if(m.existingApplicationReference||m.submissionUncertain)throw finite('SAVED_CASE_UNCONFIRMED');r.phase='agreements';metadata=await inspect();let link=(metadata.links||[]).filter(item=>item.path==='/SmartForm/Agreement'&&/إضافة طلب جديد|اضافة طلب جديد/i.test(item.label));if(link.length!==1)throw finite('NEW_APPLICATION_LINK_UNAVAILABLE');await open(link[0]);for(let step=0;step<3&&(await locate()).path!=='/SmartForm/TraditionalApp';step++){metadata=await inspect();const path=(await locate()).path;if(!['/SmartForm/Agreement','/SmartForm/ElectronicAgreement'].includes(path))throw finite('AGREEMENT_FLOW_UNCONFIRMED');const links=(metadata.links||[]).filter(item=>/^\/SmartForm\/(?:ElectronicAgreement|TraditionalApp)$/.test(item.path)&&/^(?:موافق|أوافق|اوافق|Agree|I Agree)$/i.test(item.label));if(links.length===1)await open(links[0],{acceptAgreement:true});else if(path==='/SmartForm/Agreement')await originalButton(metadata,'agreement');else throw finite('AGREEMENT_CONTROL_UNAVAILABLE');await wait(700);}
   if((await locate()).path!=='/SmartForm/TraditionalApp')throw finite('DRAFT_FORM_UNAVAILABLE');r.phase='draft';
   const control=async id=>{const data=await inspect(),all=(data.controls||[]).filter(c=>c.id===id&&!c.disabled);if(all.length!==1)throw finite('PORTAL_FIELD_UNAVAILABLE',id);return all[0];};
   const select=async(id,values,key)=>{const c=await control(id),option=optionFor(c,values,key);await fill({id,kind:'select',value:option.value});};
   await select('VisaKind',['10'],'visitPurpose');await select('NATIONALITY',[f.nationalityCode,...countryLabels(f.nationalityCode)],'nationalityCode');await select('ddlResidenceCountry',['270',...countryLabels(f.residenceCountryCode||'ARE')],'residenceCountryCode');
   await fill({id:'3',name:'TourismEVisaRequestTypeId',optionValue:'3',kind:'radio',value:true});
   let data=await inspect();const noJob=(data.controls||[]).filter(c=>c.id==='Has_Job'&&!c.disabled&&c.required);if(noJob.length){if(f.noEmployment!==true)throw finite('MISSING_FIELD','noEmployment');await fill({id:'Has_Job',kind:'check',value:true});}
   for(const [id,key] of [['RELIGION','religion'],['JOB_OR_RELATION_Id','occupation']]){const visible=(await inspect()).controls.find(c=>c.id===id&&!c.disabled);if(visible&&(visible.required||f[key])){const values=key==='religion'&&/^(?:islam|muslim|اسلام|الاسلام|مسلم)$/i.test(norm(required(f,key)))?[f[key],'اسلام','الإسلام','مسلم','islam','muslim']:[required(f,key)];await select(id,values,key);}}
   for(const [key,id]of Object.entries(TEXT_FIELDS)){const value=f[key];if(key.includes('Grandfather')&&!value){if((await inspect()).controls.some(c=>c.id===id&&!c.disabled))await fill({id,kind:'text',value:''});continue;}if(value!==undefined&&value!=='')await fill({id,kind:'text',value});}
   await select('SOCIAL_STATUS',norm(f.maritalStatus)==='single'?['1','اعزب','single']:[f.maritalStatus,...({married:['متزوج'],divorced:['مطلق'],widowed:['ارمل','أرمل'],separated:['منفصل']}[f.maritalStatus]||[])],'maritalStatus');await select('Sex',/^(?:male|ذكر|m)$/i.test(f.sex)?['1','ذكر','male']:/^(?:female|انثى|أنثى|f)$/i.test(f.sex)?[f.sex,'انثى','أنثى','female']:[f.sex,'غير محدد'],'sex');await select('PASSPORType',/^(?:ordinary|normal|عادي)$/i.test(f.passportType)?['1','عادي','ordinary']:[f.passportType,...({diplomatic:['دبلوماسي'],service:['خدمة'],special:['خاص']}[f.passportType]||[])],'passportType');await select('PASSPORT_ISSUE_PLACE',countryLabels(f.issuingCountryCode),'issuingCountryCode');await select('EmbassyCode',/^(?:abu.?dhabi|ابو ظبي|أبو ظبي)$/i.test(f.mission||'')?['214','أبو ظبي','ابو ظبي']: [required(f,'mission')],'mission');await select('COMING_THROUGH',/^(?:air|جو|جوا)$/i.test(f.transport)?['2','جوا','air']:[f.transport],'transport');await select('ENTRY_POINT',/الملك خالد|king khalid/i.test(f.arrivalPort)?['1',f.arrivalPort]:[f.arrivalPort],'arrivalPort');await select('TourismEVisaIssuingCountryCode',countryLabels(f.residenceCountryCode||'ARE'),'residenceCountryCode');
   for(const [key,id,name]of [['previousNationality','No','Has_NATIONALITY_FIRST'],['travelledLastFiveYears','HaveTraveledToOtherCountriesNo','HaveTraveledToOtherCountries'],['performUmrah',f.performUmrah?'PerformUmrahYes':'PerformUmrahNo','PerformUmrah']]){const optionValue=key==='previousNationality'?'0':String(f[key]);await fill({id,name,optionValue,kind:'radio',value:true});}
   for(const id of ['IsVisaEndDateOptional','Endorsement','IsPrivacyPolicyAgreed','terms_and_conditions']){const c=await control(id);if(c.type!=='checkbox')throw finite('PORTAL_FIELD_UNAVAILABLE',id);await fill({id,kind:'check',value:id!=='IsVisaEndDateOptional'});}
   for(const [key,id]of Object.entries(DATE_FIELDS))await setDate(id,required(f,key));
   const phonePrefix=await control('MobileInfo_MobilePrefix'),prefix=(phonePrefix.options||[]).filter(option=>/00971/.test(option.label)&&/الامارات|emirates|uae/i.test(norm(option.label)));if(prefix.length!==1)throw finite('PHONE_PREFIX_UNCONFIRMED');await fill({id:'MobileInfo_MobilePrefix',kind:'select-label',value:prefix[0].label});await fill({id:'MobileInfo_Mobile',kind:'text',value:uaePhone(f.applicationPhone)});
   for(const doc of m.documents){const id={passport:'PassportImageFile',residence:'IqamaOrVisaImageFile',portrait:'PersonalImage'}[doc.role];await control(id);const result=await api('upload-documents',{documents:[{id,role:doc.role,mimeType:doc.mimeType,name:doc.role+(doc.mimeType==='image/png'?'.png':'.jpg'),data:doc.data}]});if(result.uploadedCount!==1)throw finite('DOCUMENT_UPLOAD_UNCONFIRMED');doc.data='';}
   r.phase='application_sms';const sms=await api('inspect-application-sms',{},false);const buttons=(sms.verification?.buttons||[]).filter(button=>!button.disabled&&/send|request|ارسال|إرسال/i.test([button.id,button.name,button.label,button.title,button.ariaLabel].join(' '))&&!/resend|اعادة|إعادة/i.test([button.id,button.name,button.label,button.title,button.ariaLabel].join(' ')));if(buttons.length!==1)throw finite('APPLICATION_SMS_CONTROL_UNAVAILABLE');const requested=await api('request-application-sms',{id:buttons[0].id||undefined,label:buttons[0].label});if(!requested.activationDispatched)throw finite('APPLICATION_SMS_REQUEST_UNCONFIRMED');r.stage='waiting_otp';r.challengeId=crypto.randomUUID();r.challengeExpiresAt=ctx.now()+8*60*1000;return;
  }
 }
 if(resume){r.phase='application_sms';let code=r.pendingCode;r.pendingCode='';try{if(typeof code!=='string')throw finite('OTP_CHALLENGE_STALE');const result=await api('enter-application-sms',{code});if(!result.codeEntered)throw finite('APPLICATION_SMS_ENTRY_UNCONFIRMED');}finally{code='';}r.phase='save';await api('refresh-form-captcha');await api('solve-form-captcha');const meta=await inspect();if(!Array.isArray(r.expectedDraft)||r.expectedDraft.length>40)throw finite('DRAFT_READBACK_UNCONFIRMED');await originalButton(meta,'submit',r.expectedDraft);await wait(1000);let path=(await locate()).path;if(path==='/SmartForm/TraditionalApp'){const confirmation=await api('inspect-confirmation',{},false);if(confirmation.confirmation?.confirmationHash!==KNOWN_PLEDGE)throw finite('APPLICATION_PLEDGE_UNCONFIRMED');await api('confirm-application',{label:'استمرار',confirmationHash:KNOWN_PLEDGE,expectedFields:[{id:'PASSPORTnumber',kind:'text',expectedValue:f.passportNumber}]});await wait(1200);path=(await locate()).path;}if(!/^\/SmartForm\/HealthInsuranceInfo\/[0-9]{1,20}$/.test(path))throw finite('SAVE_UNCERTAIN');r.savedRoute=path;
  // The list was observed before creating this draft. Revisit it read-only and
  // prove the unique passport row, then restore the original Health view with
  // native history. This records a saved draft even if insurance later blocks.
  r.phase='lookup';await ctx.checkLease();await ctx.withPage(async page=>{await ctx.checkLease();await page.goto(ORIGIN+'/SmartForm',{waitUntil:'domcontentloaded',timeout:30000});});const verified=await lookup();if(verified.matchCount!==1)throw finite('SAVED_CASE_UNCONFIRMED');r.reference=verified.matches[0].applicationReference;r.saved=true;await ctx.checkLease();await ctx.withPage(async page=>{await ctx.checkLease();await page.goBack({waitUntil:'domcontentloaded',timeout:30000});});if((await locate()).path!==path)throw finite('SAVED_CONTINUATION_UNCONFIRMED');}
 let state=await locate();
 if(/^\/SmartForm\/HealthInsuranceInfo\/[0-9]{1,20}$/.test(state.path)){
  r.phase='health';for(const [id,key]of [['PostOfficeBox','postOfficeBox'],['City','city'],['ZipCode','postalCode'],['Email','contactEmail'],['Mobile','insurancePhone']])await fill({id,kind:'text',value:required(f,key)});await setDate('ExpectedEntryDate',required(f,'entryDate'));
  const names=['DeclarationForms[0].Q1_IsReceivingEmergencyTreatment','DeclarationForms[0].Q2_HavePermenantInjury','DeclarationForms[0].Q3_HaveCongenitalDisorders'];for(let i=0;i<names.length;i++)await fill({kind:'radio',name:names[i],optionValue:String(f.health[HEALTH[i]]),value:true});await originalButton(await inspect(),'submit',[{id:'Email',kind:'text',expectedValue:f.contactEmail},...names.map((name,i)=>({kind:'radio',name,optionValue:String(f.health[HEALTH[i]]),expectedValue:true}))]);await wait(1200);state=await locate();
 }
 if(/^\/SmartForm\/HealthInsurance\/[0-9]{1,20}$/.test(state.path)){r.phase='insurance';const first=chooseCheapest(await inspect());await wait(900);const second=chooseCheapest(await inspect());if(first.fingerprint!==second.fingerprint)throw finite('INSURANCE_QUOTES_CHANGED');await fill({kind:'radio',name:'CompanyNumber',optionValue:first.choice,value:true});await originalButton(await inspect(),'submit',[{kind:'radio',name:'CompanyNumber',optionValue:first.choice,expectedValue:true}]);await wait(1000);state=await locate();}
 if(state.path!=='/Payment/Summary')throw finite('PAYMENT_SUMMARY_UNCONFIRMED');await finish();
}
module.exports={createProductionWorker,validateManifest,runGovernmentJob,chooseCheapest,uaePhone,readbackForField,finite};
