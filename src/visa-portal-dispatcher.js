'use strict';
const {createHash}=require('node:crypto');
const {validateApplicant}=require('./raad-document-validation');
const {requiredQuestions}=require('./visa-client-questions');
const PREFLIGHT_CLIENT_FIELDS=Object.freeze(['latinFatherName','arabicFirstName','arabicFatherName','arabicFamilyName']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
class VisaPortalDispatcher{
 constructor({fulfilment,raad,mediaStore,store,documentIntake,notificationReadiness,ownerNotificationReady,operatorNotice,env=process.env,fetchImpl=fetch,now=Date.now,startupGraceMs=30000}){Object.assign(this,{fulfilment,raad,mediaStore,store,documentIntake,notificationReadiness,ownerNotificationReady,operatorNotice,env,fetchImpl,now});store.data.visaPortalRuns||={};this.busy=false;this.recovered=false;this.reportedDiagnostics=new Map();this.portalReadyAt=this.now()+Math.max(0,startupGraceMs);}
 configured(){try{const u=new URL(this.env.RAAD_BROWSER_WORKER_URL);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&typeof this.env.RAAD_JOB_BRIDGE_KEY==='string'&&this.env.RAAD_JOB_BRIDGE_KEY.length>=32;}catch{return false;}}
 async request(path,{body,artifact=false,method}={}){if(!this.configured())throw Error('RAAD_BROWSER_NOT_CONFIGURED');const u=new URL(path,this.env.RAAD_BROWSER_WORKER_URL),headers={Authorization:'Bearer '+this.env.RAAD_JOB_BRIDGE_KEY};if(body)headers['Content-Type']='application/json';const r=await this.fetchImpl(u.href,{method:method|| (body?'POST':'GET'),headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Object.assign(Error('RAAD_BRIDGE_HTTP_'+r.status),{status:r.status});if(!artifact)return r.json();if(!(r.headers.get('content-type')||'').startsWith('application/pdf'))throw Error('RAAD_ARTIFACT_TYPE_INVALID');const parts=[];let length=0;for await(const chunk of r.body){length+=chunk.length;if(length>10*1024*1024)throw Error('RAAD_ARTIFACT_TOO_LARGE');parts.push(Buffer.from(chunk));}const bytes=Buffer.concat(parts);if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('RAAD_ARTIFACT_INVALID');return bytes;}
 async resumeOtp({jobId,portalChallengeId,code,guard}){guard();const run=this.store.data.visaPortalRuns[jobId];if(!run||run.phase!=='waiting_otp')throw Error('RAAD_OTP_CONTEXT_STALE');return this.request('/internal/raad/jobs/'+jobId+'/otp',{body:{challengeId:portalChallengeId,code}});}
 async operatorChallenge(jobId,input){
  const check=()=>{const job=this.fulfilment.job(jobId),run=this.store.data.visaPortalRuns[jobId];if(run?.phase!=='waiting_operator'||!run.operatorChallenge||run.operatorChallenge.expiresAt<=this.now())throw Error('OPERATOR_CHALLENGE_STALE');this.fulfilment.guardLease(jobId,run.leaseToken);this.currentDossier(job,run);return{job,run};};
  const {job,run}=check(),id=run.operatorChallenge.id;
  if(input&&(Object.keys(input).sort().join(',')!=='challengeId,imageId,value'||input.challengeId!==id||typeof input.value!=='string'||!/^[A-Za-z0-9]{1,32}$/.test(input.value)))throw Error('OPERATOR_INPUT_INVALID');
  try{
   const result=await this.request('/internal/raad/jobs/'+jobId+'/operator',input?{body:input}:{});check();
   if(input){if(result.accepted!==true)throw Error('OPERATOR_SUBMISSION_UNCONFIRMED');run.phase='running';delete run.operatorChallenge;job.state='running';this.store.save();return{accepted:true};}
   if(result.challengeId!==id||!['login','form'].includes(result.kind)||result.kind!==run.operatorChallenge.kind||typeof result.image!=='string'||result.image.length>280000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(result.image)||!/^[a-f0-9]{64}$/.test(result.imageId||''))throw Error('OPERATOR_IMAGE_UNCONFIRMED');
   const bytes=Buffer.from(result.image.slice(22),'base64');try{if(bytes.length>200000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||digest(bytes)!==result.imageId)throw Error('OPERATOR_IMAGE_UNCONFIRMED');}finally{bytes.fill(0);}
   return{challengeId:id,kind:result.kind,expiresAt:run.operatorChallenge.expiresAt,imageId:result.imageId,image:result.image};
  }finally{if(input)input.value='';}
 }
 async resumeAfterSaveDiagnostic(jobId){
  const job=this.fulfilment.job(jobId),run=this.store.data.visaPortalRuns[jobId];
  const verify=()=>{if(job.state!=='portal_review_required'||job.blockedReason!=='SAVE_PREFLIGHT_PASSED'||run?.phase!=='blocked'||run.lastStage!=='save_preflight'||job.diagnosticOnly!==true||job.saveAfterDiagnosticResumed===true||job.portalSaved||job.applicationReference||this.fulfilment.data().lease)throw Error('SAVE_DIAGNOSTIC_RESUME_UNAVAILABLE');let proof,draft;job.state='ready';try{proof=this.fulfilment.getConfirmedFields(jobId);draft=this.dossier(job,proof);}finally{if(job.state==='ready')job.state='portal_review_required';}if(!proof.complete||!draft.ready||!draft.fingerprint)throw Error('SAVE_DIAGNOSTIC_RESUME_UNAVAILABLE');return draft.fingerprint;};
  const fingerprint=verify(),health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false||health.production?.operatorCaptcha!==true||health.production?.savePreflightSupported!==true)throw Error('SAVE_DIAGNOSTIC_RESUME_UNAVAILABLE');await this.cancelOwned(jobId);if(verify()!==fingerprint)throw Error('SAVE_DIAGNOSTIC_RESUME_UNAVAILABLE');
  const before={reason:job.blockedReason,phase:run.phase};job.state='ready';job.diagnosticOnly=false;job.saveAfterDiagnosticResumed=true;delete job.blockedReason;run.phase='retry_ready';try{this.store.save();}catch{job.state='portal_review_required';job.diagnosticOnly=true;delete job.saveAfterDiagnosticResumed;job.blockedReason=before.reason;run.phase=before.phase;throw Error('SAVE_DIAGNOSTIC_RESUME_UNCONFIRMED');}return{resumeQueued:true};
 }
 async recoverExistingApplication(jobId,reference){
  if(this.env.RAAD_OPERATOR_CAPTCHA_ENABLED!=='true'||! /^[0-9]{3,20}$/.test(reference||''))throw Error('EXISTING_RECOVERY_UNAVAILABLE');
  const job=this.fulfilment.job(jobId),run=this.store.data.visaPortalRuns[jobId];
  const verify=()=>{if(job.state!=='portal_review_required'||job.blockedReason!=='SAVE_UNCERTAIN'||run?.phase!=='blocked'||!['save','lookup'].includes(run.lastStage)||job.portalSaved||job.applicationReference||job.existingRecoveryRequested||this.fulfilment.data().lease)throw Error('EXISTING_RECOVERY_UNAVAILABLE');let proof,draft;job.state='ready';try{proof=this.fulfilment.getConfirmedFields(jobId);draft=this.dossier(job,proof);}finally{if(job.state==='ready')job.state='portal_review_required';}if(!proof.complete||!draft.ready||!draft.fingerprint)throw Error('EXISTING_RECOVERY_UNAVAILABLE');return draft.fingerprint;};
  const fingerprint=verify(),health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false||health.production?.operatorCaptcha!==true)throw Error('EXISTING_RECOVERY_UNAVAILABLE');await this.cancelOwned(jobId);if(verify()!==fingerprint)throw Error('EXISTING_RECOVERY_UNAVAILABLE');
  const before={job:structuredClone(job),run:structuredClone(run)};job.state='ready';job.diagnosticOnly=false;job.existingRecoveryRequested=true;job.recoveryApplicationReference=reference;delete job.blockedReason;run.phase='retry_ready';
  try{this.store.save();}catch{for(const key of Object.keys(job))delete job[key];Object.assign(job,before.job);for(const key of Object.keys(run))delete run[key];Object.assign(run,before.run);throw Error('EXISTING_RECOVERY_UNCONFIRMED');}return{recoveryQueued:true,createNewApplication:false};
 }
 async startSaveDiagnostic(jobId){
  if(this.env.RAAD_OPERATOR_CAPTCHA_ENABLED!=='true')throw Error('OPERATOR_UNAVAILABLE');
  const job=this.fulfilment.job(jobId),run=this.store.data.visaPortalRuns[jobId];
  const verify=()=>{if(job.state!=='portal_review_required'||job.blockedReason!=='SAVE_UNCERTAIN'||run?.phase!=='blocked'||run.lastStage!=='save'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||(job.saveDiagnosticAttempts||0)>=1)throw Error('SAVE_DIAGNOSTIC_UNAVAILABLE');let proof,draft;job.state='ready';try{proof=this.fulfilment.getConfirmedFields(jobId);draft=this.dossier(job,proof);}finally{if(job.state==='ready')job.state='portal_review_required';}if(!proof.complete||!draft.ready||!draft.fingerprint)throw Error('SAVE_DIAGNOSTIC_UNAVAILABLE');return draft.fingerprint;};
  const fingerprint=verify(),health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false||health.production?.operatorCaptcha!==true||health.production?.savePreflightSupported!==true)throw Error('SAVE_DIAGNOSTIC_UNAVAILABLE');
  await this.cancelOwned(jobId);if(verify()!==fingerprint)throw Error('SAVE_DIAGNOSTIC_UNAVAILABLE');
  const before={reason:job.blockedReason,phase:run.phase,attempts:job.saveDiagnosticAttempts,diagnosticOnly:job.diagnosticOnly};job.state='ready';job.diagnosticOnly=true;job.saveDiagnosticAttempts=1;delete job.blockedReason;run.phase='retry_ready';
  try{this.store.save();}catch{job.state='portal_review_required';job.blockedReason=before.reason;run.phase=before.phase;for(const [key,value]of Object.entries({saveDiagnosticAttempts:before.attempts,diagnosticOnly:before.diagnosticOnly}))if(value===undefined)delete job[key];else job[key]=value;throw Error('SAVE_DIAGNOSTIC_UNCONFIRMED');}
  return{diagnosticQueued:true,submissionEnabled:false};
 }
 async restartOperatorLogin(jobId){
  if(this.env.RAAD_OPERATOR_CAPTCHA_ENABLED!=='true')throw Error('OPERATOR_UNAVAILABLE');
  const job=this.fulfilment.job(jobId),run=this.store.data.visaPortalRuns[jobId];
  const verify=()=>{if(job.state!=='portal_review_required'||!((run?.phase==='blocked'&&run.lastStage==='login'&&['LOGIN_CAPTCHA_TIMEOUT','OPERATOR_CHALLENGE_EXPIRED','LOGIN_REJECTED','PILOT_UNAVAILABLE'].includes(job.blockedReason))||(run?.phase==='cancelled'&&run.lastStage==='preflight'&&job.blockedReason==='PORTAL_START_UNCERTAIN'))||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||(job.diagnosticOnly===true?(job.diagnosticLoginRestarts||0)>=5:(job.operatorManualStarts||0)>=2))throw Error('OPERATOR_RESTART_UNAVAILABLE');let proof,draft;job.state='ready';try{proof=this.fulfilment.getConfirmedFields(jobId);draft=this.dossier(job,proof);}finally{if(job.state==='ready')job.state='portal_review_required';}if(!proof.complete||!draft.ready||!draft.fingerprint)throw Error('OPERATOR_RESTART_UNAVAILABLE');return draft.fingerprint;};
  const fingerprint=verify(),health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false||health.production?.operatorCaptcha!==true)throw Error('OPERATOR_UNAVAILABLE');
  await this.cancelOwned(jobId);if(verify()!==fingerprint)throw Error('OPERATOR_RESTART_UNAVAILABLE');
  const before={reason:job.blockedReason,phase:run.phase,count:job.operatorManualStarts,diagnosticCount:job.diagnosticLoginRestarts};job.state='ready';delete job.blockedReason;if(job.diagnosticOnly===true)job.diagnosticLoginRestarts=(job.diagnosticLoginRestarts||0)+1;else job.operatorManualStarts=(job.operatorManualStarts||0)+1;run.phase='retry_ready';
  try{this.store.save();}catch{job.state='portal_review_required';job.blockedReason=before.reason;run.phase=before.phase;if(before.diagnosticCount===undefined)delete job.diagnosticLoginRestarts;else job.diagnosticLoginRestarts=before.diagnosticCount;if(before.count===undefined)delete job.operatorManualStarts;else job.operatorManualStarts=before.count;throw Error('OPERATOR_RESTART_UNCONFIRMED');}
  return{restartQueued:true};
 }
 block(job,reason){if(job.blockedReason!==reason){job.blockedReason=reason;job.updatedAt=this.now();this.store.save();}}
 dossier(job,proof){
  if(typeof this.raad.portalDossier==='function')return this.raad.portalDossier(job.customer,{applicantIndex:job.applicantIndex,clientProof:proof});
  const draft=this.raad.get(job.customer,{applicantIndex:job.applicantIndex}),fingerprint=this.store.data.raadApplications?.[job.customer]?.applicants?.[job.applicantIndex]?.review?.fingerprint;
  if(!draft.review?.complete||draft.review.invalidated)return {ready:false,blockedReason:'DOCUMENTS_REVIEW_REQUIRED'};
  for(const [key,value]of Object.entries(proof.fields)){if(['health','guardian','maritalStatus','previousNationality','previousNationalityDetails','travelledLastFiveYears','travelHistory','performUmrah','priorGccDeportation','priorGccRuleViolation','saudiAddress'].includes(key))continue;if(Object.hasOwn(draft.fields,key)&&JSON.stringify(draft.fields[key])!==JSON.stringify(value))return {ready:false,blockedReason:'DOCUMENT_DATA_CONFLICT'};}
  return {ready:true,source:'staff',fingerprint,fields:{...draft.fields,...proof.fields,health:{...draft.fields?.health,...proof.fields.health},guardian:{...draft.fields?.guardian,...proof.fields.guardian}},defaults:draft.defaults,documents:draft.documents};
 }
 currentDossier(job,run){const proof=this.fulfilment.getConfirmedFields(job.id),dossier=this.dossier(job,proof);if(!proof.complete||!dossier.ready||!dossier.fingerprint||dossier.fingerprint!==run.draftFingerprint)throw Error('RAAD_DRAFT_CHANGED');return dossier;}
 async flushMessages(){
  const paused=Object.values(this.fulfilment.data().outbox).some(item=>item.state==='cancelled'&&item.failure==='DELIVERY_PAUSED'&&(item.kind==='payment_confirmation'||item.kind==='owner_otp_request'&&!item.noticeMessageId));
  if(paused&&typeof this.notificationReadiness==='function'){try{this.fulfilment.requeueApprovedNotifications(await this.notificationReadiness());}catch{ /* Unverified templates do not authorize an automatic retry. */ }}
  for(const item of this.fulfilment.pendingMessages()){
   if(item.kind==='applicant_question'){const job=this.fulfilment.data().jobs[item.jobId],first=Object.values(job?.questions||{}).find(q=>q.state==='pending');if(first?.token!==item.payload.token)continue;const sibling=Object.values(this.fulfilment.data().jobs).find(j=>j.customer===item.customer&&j.applicantIndex<job.applicantIndex&&['awaiting_answers','awaiting_answer_confirmation','needs_followup'].includes(j.state));if(sibling)continue;}
   const sent=await this.fulfilment.dispatchMessage(item.id);
   if(['applicant_question','applicant_answer_summary','owner_otp_request'].includes(item.kind)){
    const job=this.fulfilment.data().jobs[item.jobId];
    console.info('[VISA_WORKFLOW_DELIVERY] '+JSON.stringify({caseHash:digest(String(job?.caseId||'')).slice(0,12),kind:item.kind,state:['accepted','delivered','cancelled','failed','uncertain'].includes(sent?.state)?sent.state:'unconfirmed'}));
   }
  }
 }
 async cancelOwned(id){const result=await this.request('/internal/raad/jobs/'+id+'/cancel',{body:{}});if(result.stage!=='cancelled'||result.ownedBrowserClosed!==true)throw Error('RAAD_CANCEL_UNCONFIRMED');return result;}
 async recover(){if(this.recovered)return;for(const [id,run]of Object.entries(this.store.data.visaPortalRuns)){if(!['starting','running','waiting_otp','waiting_operator','uncertain'].includes(run.phase))continue;await this.cancelOwned(id);run.phase='interrupted';this.store.save();}this.recovered=true;}
 async launch(job){
  const proof=this.fulfilment.getConfirmedFields(job.id);if(!proof.complete||!proof.confirmation?.messageId){this.block(job,'CLIENT_ANSWERS_REQUIRED');return;}
  const draft=this.dossier(job,proof),draftFingerprint=draft.fingerprint;
  if(!draft.ready){this.block(job,draft.blockedReason||'DOCUMENTS_REVIEW_REQUIRED');return;}
  const fields=draft.fields;
  const missingNames=PREFLIGHT_CLIENT_FIELDS.filter(key=>fields[key]===undefined||fields[key]===null||fields[key]==='');
  if(missingNames.length){this.fulfilment.askQuestions(job.id,{fields:missingNames});delete job.blockedReason;this.store.save();return;}
  const contact={...draft.defaults,...fields};if(!contact.entryDate)fields.entryDate=contact.proposedEntryDate;
  const validation=validateApplicant(fields);if(validation.issues.length){const missing=validation.issues.map(i=>i.field).filter(f=>{try{return requiredQuestions(fields,{requestedFields:[f]}).length>0;}catch{return false;}});if(missing.length){this.fulfilment.askQuestions(job.id,{fields:[...new Set(missing)]});return;}this.block(job,'DOCUMENT_DATA_REVIEW_REQUIRED');return;}
  const documents=[];for(const [kind,role]of [['passport','passport'],['residence','residence'],['photo','portrait']]){const id=draft.documents?.[kind]?.mediaId;if(!id){this.block(job,'DOCUMENTS_REQUIRED');return;}const {metadata,bytes}=this.mediaStore.read(id,{customer:job.customer});if(!['image/png','image/jpeg'].includes(metadata.mimeType)||bytes.length>1000000){this.block(job,'DOCUMENT_PREPARATION_REQUIRED');return;}documents.push({role,mimeType:metadata.mimeType,data:bytes.toString('base64'),sha256:digest(bytes)});}
  if(typeof this.ownerNotificationReady==='function'){let ready=false;try{ready=await this.ownerNotificationReady()===true;}catch{}if(!ready){this.block(job,'OWNER_NOTIFICATION_NOT_READY');return;}}
  try{const health=await this.request('/health');if(health.ready!==true){this.block(job,'BROWSER_STARTING');return;}if(job.diagnosticOnly===true&&health.production?.savePreflightSupported!==true){this.block(job,'DIAGNOSTIC_WORKER_REQUIRED');return;}}catch{this.block(job,'BROWSER_STARTING');return;}
  const currentDraft=this.dossier(job,this.fulfilment.getConfirmedFields(job.id));if(!draftFingerprint||!currentDraft.ready||currentDraft.fingerprint!==draftFingerprint){this.block(job,'DOCUMENTS_REVIEW_REQUIRED');return;}
  const {lease}=this.fulfilment.acquireJob(job.id,{workerId:'raad-browser',ttlMs:30*60000});
  const run={phase:'starting',leaseToken:lease.token,startedAt:this.now(),lastStage:'preflight',draftFingerprint,reviewSource:draft.source,preparedDocuments:['passport','residence','photo'].map(kind=>({kind,mediaId:draft.documents[kind].mediaId,sha256:documents.find(doc=>doc.role===(kind==='photo'?'portrait':kind)).sha256}))};this.store.data.visaPortalRuns[job.id]=run;this.store.save();
  try{await this.request('/internal/raad/jobs',{body:{jobId:job.id,leaseToken:lease.token,caseId:job.caseId,applicantIndex:job.applicantIndex,caseSignature:job.caseSignature,fields,defaults:draft.defaults,answers:proof.fields,documents,clientConsent:proof.confirmation,...(job.diagnosticOnly===true?{diagnosticOnly:true}:{}),...((job.applicationReference||job.recoveryApplicationReference)?{existingApplicationReference:job.applicationReference||job.recoveryApplicationReference}:{})}});run.phase='running';delete job.blockedReason;this.store.save();}
  catch{run.phase='uncertain';job.state='portal_review_required';this.fulfilment.data().lease.cancelled=true;this.block(job,'PORTAL_START_UNCERTAIN');this.store.save();}
 }
 async poll(job,run){
  try{this.currentDossier(job,run);this.fulfilment.renewLease(job.id,{leaseToken:run.leaseToken,ttlMs:30*60000});}catch{await this.cancelOwned(job.id);run.phase='cancelled';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.store.save();return;}
  let state;try{state=await this.request('/internal/raad/jobs/'+job.id);}catch(error){if(error?.status!==404)throw error;await this.cancelOwned(job.id);run.phase='interrupted';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.block(job,'BROWSER_JOB_LOST');this.store.save();return;}run.lastStage=state.phase;job.portalStage=state.phase;
  if(state.saved===true&&/^[A-Z]{0,3}[0-9]{3,20}$/.test(state.reference||'')){job.applicationReference=state.reference;job.portalSaved=true;}
  if(state.requiresOperator===true){const c=state.operatorChallenge;if(state.jobId!==job.id||state.caseSignature!==job.caseSignature||state.applicantIndex!==job.applicantIndex||!c||!/^[a-f0-9-]{36}$/.test(c.id||'')||!['login','form'].includes(c.kind)||!Number.isFinite(c.expiresAt)||c.expiresAt<=this.now()||c.expiresAt>this.now()+310000)throw Error('OPERATOR_CHALLENGE_UNCONFIRMED');if(run.operatorChallenge?.id!==c.id)console.info('[VISA_OPERATOR_READY] '+JSON.stringify({caseHash:digest(String(job.caseId)).slice(0,12),kind:c.kind,expiresAt:c.expiresAt}));run.phase='waiting_operator';run.operatorChallenge={id:c.id,kind:c.kind,expiresAt:c.expiresAt};job.state='waiting_otp';}
  if(state.requiresOtp&&state.challengeId){run.phase='waiting_otp';const prior=Object.values(this.fulfilment.data().challenges).find(c=>c.jobId===job.id&&c.portalChallengeId===state.challengeId);if(!prior)this.fulfilment.requestOtp(job.id,{leaseToken:run.leaseToken,portalChallengeId:state.challengeId,contextId:state.challengeId,ttlMs:Math.min(5*60000,Math.max(1000,(state.challengeExpiresAt||this.now()+5*60000)-this.now()))});}
  if(state.stage==='completed'&&state.artifactReady&&state.saved===true&&state.reference&&state.paymentAttempted===false&&state.returnedFromPayment===true){if(state.jobId!==job.id||state.caseSignature!==job.caseSignature||state.applicantIndex!==job.applicantIndex||!/^[a-f0-9]{64}$/.test(state.artifactSha256||''))throw Error('RAAD_ARTIFACT_BINDING_INVALID');const bytes=await this.request('/internal/raad/jobs/'+job.id+'/artifact',{artifact:true});if(digest(bytes)!==state.artifactSha256)throw Error('RAAD_ARTIFACT_DIGEST_INVALID');this.fulfilment.guardLease(job.id,run.leaseToken);this.currentDossier(job,run);const copy=this.mediaStore.storeApplicationPdf(job.customer,{bytes,applicationReference:state.reference,jobId:job.id});this.fulfilment.recordPortalResult(job.id,{leaseToken:run.leaseToken,status:'saved_application',applicationReference:state.reference,paymentAttempted:false,returnedFromPayment:true,requestCopy:{mediaId:copy.id}});run.phase='completed';}
  else if(['failed','blocked','cancelled','lease_lost'].includes(state.stage)){await this.cancelOwned(job.id);run.phase='blocked';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.block(job,state.blocker?.code||'PORTAL_REVIEW_REQUIRED');}
  this.store.save();
  if(state.requiresOperator===true&&typeof this.operatorNotice==='function')await this.operatorNotice(job);
 }
 async recoverPreflightLease(){
  for(const job of Object.values(this.fulfilment.data().jobs)){
   const run=this.store.data.visaPortalRuns[job.id];
   if(job.state!=='portal_review_required'||job.blockedReason!=='LEASE_REVOKED'||!run||run.phase!=='blocked'||run.lastStage!=='preflight'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||(job.preflightRecoveryAttempts||0)>=1)continue;
   const previous=job.state;job.state='ready';let dossier;
   try{const proof=this.fulfilment.getConfirmedFields(job.id);if(!proof.complete)continue;dossier=this.dossier(job,proof);}catch{continue;}finally{job.state=previous;}
   if(!dossier?.ready)continue;
   try{const health=await this.request('/health');if(health.ready!==true||health.production?.activeJob===true)continue;await this.cancelOwned(job.id);}catch{continue;}
   job.state='ready';job.preflightRecoveryAttempts=(job.preflightRecoveryAttempts||0)+1;delete job.blockedReason;run.phase='retry_ready';this.store.save();
  }
 }
 async recoverStoppedLogin(){
  for(const job of Object.values(this.fulfilment.data().jobs)){
   const run=this.store.data.visaPortalRuns[job.id];
   const policyRetry=job.loginPolicyRecovery!=='protected_applications_v7'&&(job.blockedReason==='LOGIN_UNCONFIRMED'||job.blockedReason==='PILOT_UNAVAILABLE'&&['single_observed_v2','otp_before_menu_v3'].includes(job.loginPolicyRecovery)||job.blockedReason==='LOGIN_EMAIL_OTP_UNCONFIRMED'&&['otp_before_menu_v3','account_menu_ready_v4','account_navigation_v5','account_menu_diagnostic_v6'].includes(job.loginPolicyRecovery));
   const captchaTimeoutRetry=job.blockedReason==='LOGIN_CAPTCHA_TIMEOUT'&&job.loginPolicyRecovery==='account_menu_ready_v4'&&job.captchaTimeoutRecovery!=='bounded30s_v1';
   const transportRetry=job.blockedReason==='PILOT_UNAVAILABLE'&&(job.loginRecoveryAttempts||0)<1;
   if(job.state!=='portal_review_required'||(!policyRetry&&!transportRetry&&!captchaTimeoutRetry)||!run||run.phase!=='blocked'||run.lastStage!=='login'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease)continue;
   const previous=job.state;job.state='ready';let dossier;
   try{const proof=this.fulfilment.getConfirmedFields(job.id);if(!proof.complete)continue;dossier=this.dossier(job,proof);}catch{continue;}finally{job.state=previous;}
   if(!dossier?.ready)continue;
   try{const health=await this.request('/health');if(health.ready!==true||health.production?.activeJob===true)continue;await this.cancelOwned(job.id);}catch{continue;}
   job.state='ready';job.loginRecoveryAttempts=(job.loginRecoveryAttempts||0)+1;if(policyRetry)job.loginPolicyRecovery='protected_applications_v7';if(captchaTimeoutRetry)job.captchaTimeoutRecovery='bounded30s_v1';delete job.blockedReason;run.phase='retry_ready';this.store.save();
  }
 }
 async recoverOperatorLogin(){
  if(this.env.RAAD_OPERATOR_CAPTCHA_ENABLED!=='true')return;
  for(const job of Object.values(this.fulfilment.data().jobs)){
   const run=this.store.data.visaPortalRuns[job.id];
   if(job.state!=='portal_review_required'||!['LOGIN_CAPTCHA_TIMEOUT','OPERATOR_CHALLENGE_EXPIRED'].includes(job.blockedReason)||run?.phase!=='blocked'||run.lastStage!=='login'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||(job.operatorLoginRecoveryAttempts||0)>=1)continue;
   const verify=()=>{if(job.state!=='portal_review_required'||run.phase!=='blocked'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||(job.operatorLoginRecoveryAttempts||0)>=1)return null;let draft;job.state='ready';try{const proof=this.fulfilment.getConfirmedFields(job.id);if(proof.complete)draft=this.dossier(job,proof);}catch{}finally{if(job.state==='ready')job.state='portal_review_required';}return draft?.ready?draft.fingerprint:null;};
   const fingerprint=verify();if(!fingerprint)continue;
   try{const health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false||health.production?.operatorCaptcha!==true)continue;await this.cancelOwned(job.id);}catch{continue;}
   if(verify()!==fingerprint)continue;
   const before={reason:job.blockedReason,phase:run.phase};job.state='ready';job.operatorLoginRecoveryAttempts=1;delete job.blockedReason;run.phase='retry_ready';
   try{this.store.save();}catch{job.state='portal_review_required';job.blockedReason=before.reason;run.phase=before.phase;delete job.operatorLoginRecoveryAttempts;}

  }
 }
 async recoverExpiredApplicationOtp(){
  if(this.env.RAAD_EXPIRED_OTP_RECOVERY_ENABLED!=='true'||!this.configured())return;
  for(const job of Object.values(this.fulfilment.data().jobs)){
   const run=this.store.data.visaPortalRuns[job.id];
   const retryRequest=this.env.RAAD_EXPIRED_OTP_RETRY_REQUEST;
   const explicitRetry=/^[a-f0-9]{32}$/.test(retryRequest||'')&&this.env.RAAD_EXPIRED_OTP_RETRY_CASE_HASH===digest(String(job.caseId)).slice(0,12)&&job.expiredOtpRetryRequest!==retryRequest;
   if(job.state!=='portal_review_required'||job.blockedReason!=='OTP_CHALLENGE_EXPIRED'||run?.phase!=='blocked'||run.lastStage!=='application_sms'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease||((job.expiredOtpRecoveryAttempts||0)>=1&&!explicitRetry))continue;
   const diagnostic=code=>{const key=job.id+':otp_recovery';if(this.reportedDiagnostics.get(key)===code)return;this.reportedDiagnostics.set(key,code);console.info('[VISA_OTP_RECOVERY] '+JSON.stringify({caseHash:digest(String(job.caseId)).slice(0,12),code}));};
   let phase='authorization',refreshDocuments=false;
   try{
    const verify=expected=>{
     phase='authorization';
     if(this.fulfilment.data().lease||job.state!=='portal_review_required'||job.blockedReason!=='OTP_CHALLENGE_EXPIRED'||run.phase!=='blocked'||job.portalSaved||job.applicationReference||((job.expiredOtpRecoveryAttempts||0)>=1&&!explicitRetry))throw Error('CURRENT_JOB_REQUIRED');
     let proof,draft,requiresRefresh=false;
     job.state='ready';
     try{
      this.fulfilment.guardJob(job.id);phase='document_evidence';
      try{proof=this.fulfilment.getConfirmedFields(job.id);}
      catch(error){
       const consent=job.answerConfirmation;
       if(!['VISA_DOCUMENT_EVIDENCE_UNVERIFIED','VISA_DOCUMENT_EVIDENCE_STALE'].includes(error?.code||error?.message)||typeof this.documentIntake?.refresh!=='function'||consent?.granted!==true||consent.scope!=='saudi_visa_application'||consent.caseSignature!==job.caseSignature||consent.sender!==job.customer||typeof consent.messageId!=='string'||!consent.messageId)throw error;
       requiresRefresh=true;proof={complete:true};
       draft={ready:true,fingerprint:'document_refresh:'+digest(JSON.stringify({confirmation:consent,fields:job.confirmedFields,revision:job.revision,caseSignature:job.caseSignature}))};
      }
      if(!requiresRefresh){phase='dossier';draft=this.dossier(job,proof);}
     }finally{if(job.state==='ready')job.state='portal_review_required';}
     if(!proof.complete||!draft.ready||!draft.fingerprint||expected&&draft.fingerprint!==expected)throw Error('CURRENT_DOSSIER_REQUIRED');
     refreshDocuments=requiresRefresh;return draft.fingerprint;
    };
    // Releasing a lease increments the job revision, so the old execution
    // fingerprint cannot be reused. Independently verify current authorization
    // and retain its new fingerprint across every asynchronous check.
    const expectedFingerprint=verify();
    phase='owner_delivery';if(typeof this.ownerNotificationReady!=='function'||await this.ownerNotificationReady()!==true){diagnostic('OWNER_NOTIFICATION_NOT_READY');continue;}
    phase='remote_record';
    let remote,recordMissing=false;
    try{remote=await this.request('/internal/raad/jobs/'+job.id);}catch(error){if(error?.status===404&&(refreshDocuments||explicitRetry))recordMissing=true;else throw error;}
    // Cancellation retains save/uncertainty and binding proof. A missing
    // record requires an explicit case-scoped retry (or document-only refresh).
    // The worker always looks up existing applications before creating one.
    if(!recordMissing&&(remote.jobId!==job.id||remote.caseSignature!==job.caseSignature||remote.applicantIndex!==job.applicantIndex||remote.saved!==false||remote.reference!==null||remote.submissionUncertain!==false||remote.paymentAttempted!==false||remote.ownedBrowserClosed!==true||!(remote.stage==='cancelled'&&remote.phase==='done'||remote.stage==='blocked'&&remote.phase==='application_sms'&&remote.blocker?.code==='OTP_CHALLENGE_EXPIRED'))){diagnostic('REMOTE_UNSAVED_PROOF_REQUIRED');continue;}
    phase='worker_health';const health=await this.request('/health');if(health.ready!==true||health.production?.activeJob!==false){diagnostic('WORKER_NOT_IDLE');continue;}
    phase='remote_cleanup';
    const cleanup=await this.cancelOwned(job.id);
    // Require absence and idle proof after eviction. Only the explicit
    // operator request permits execution with current consent; ordinary
    // eviction recovery remains document-only. Existing-application lookup
    // in the worker refuses any matching request before creating another.
    if(recordMissing&&(cleanup.absent!==true||cleanup.jobId!==job.id)){diagnostic('REMOTE_ABSENCE_UNCONFIRMED');continue;}
    verify(expectedFingerprint);
    if(refreshDocuments){
     // Changed document evidence invalidates the old consent. Restage only
     // after remote unsaved proof, and require a fresh applicant confirmation.
     const before=structuredClone(job),previousPhase=run.phase;
     job.expiredOtpRecoveryAttempts=(job.expiredOtpRecoveryAttempts||0)+1;if(explicitRetry)job.expiredOtpRetryRequest=retryRequest;job.state='queued';job.revision++;delete job.blockedReason;delete job.answerConfirmation;run.phase='followup';
     try{this.store.save();}catch{for(const key of Object.keys(job))delete job[key];Object.assign(job,before);run.phase=previousPhase;throw Error('RECOVERY_SAVE_FAILED');}
     try{phase='document_refresh';const result=await this.documentIntake.refresh(job.customer,{applicantIndex:job.applicantIndex});if(result?.readyForQuestions!==true)throw Error('DOCUMENT_REFRESH_REVIEW_REQUIRED');if(!job.stagedFields)job.stagedFields=structuredClone(job.confirmedFields);this.fulfilment.askQuestions(job.id);diagnostic('DOCUMENTS_REBOUND_CONFIRMATION_REQUIRED');}
     catch{job.state='portal_review_required';job.blockedReason='DOCUMENTS_REVIEW_REQUIRED';run.phase='blocked';this.store.save();diagnostic('DOCUMENT_REFRESH_REVIEW_REQUIRED');}
     continue;
    }
    const before={state:job.state,blockedReason:job.blockedReason,attempts:job.expiredOtpRecoveryAttempts,retryRequest:job.expiredOtpRetryRequest,phase:run.phase};
    job.expiredOtpRecoveryAttempts=(job.expiredOtpRecoveryAttempts||0)+1;if(explicitRetry)job.expiredOtpRetryRequest=retryRequest;job.state='ready';delete job.blockedReason;run.phase='retry_ready';
    try{this.store.save();}catch{job.state=before.state;job.blockedReason=before.blockedReason;run.phase=before.phase;if(before.retryRequest===undefined)delete job.expiredOtpRetryRequest;else job.expiredOtpRetryRequest=before.retryRequest;if(before.attempts===undefined)delete job.expiredOtpRecoveryAttempts;else job.expiredOtpRecoveryAttempts=before.attempts;throw Error('RECOVERY_SAVE_FAILED');}
    diagnostic('READY_FOR_FRESH_OTP');
   }catch(error){const codes=['CURRENT_DOSSIER_REQUIRED','CURRENT_JOB_REQUIRED','RECOVERY_SAVE_FAILED','VISA_DOCUMENT_EVIDENCE_STALE','VISA_DOCUMENT_EVIDENCE_UNVERIFIED','VISA_PAYMENT_NOTICE_UNCONFIRMED','VISA_JOB_STALE','HUMAN_OWNERSHIP'];const code=error?.code||error?.message;diagnostic(codes.includes(code)?code:error?.status===404&&phase==='remote_record'?'REMOTE_RECORD_NOT_FOUND':'CHECK_'+phase.toUpperCase()+'_UNCONFIRMED');}
  }
 }
 async recoverMissingPreflight(){
  for(const job of Object.values(this.fulfilment.data().jobs)){
   const run=this.store.data.visaPortalRuns[job.id];
   if(job.state!=='portal_review_required'||job.blockedReason!=='MISSING_FIELD'||!run||run.phase!=='blocked'||run.lastStage!=='preflight'||job.portalSaved||job.applicationReference||this.fulfilment.data().lease)continue;
   // A blocked preflight has not opened the government session. Verify remote
   // owned-browser cleanup again before asking only the missing name facts.
   const oldState=job.state;job.state='ready';let draft;
   try{const proof=this.fulfilment.getConfirmedFields(job.id);if(!proof.complete)continue;draft=this.dossier(job,proof);}catch{continue;}finally{job.state=oldState;}
   if(!draft?.ready)continue;
   const fields=PREFLIGHT_CLIENT_FIELDS.filter(key=>draft.fields[key]===undefined||draft.fields[key]===null||draft.fields[key]==='');if(!fields.length)continue;
   try{await this.cancelOwned(job.id);}catch{continue;}
   job.state='ready';
   try{this.fulfilment.askQuestions(job.id,{fields});run.phase='followup';delete job.blockedReason;this.store.save();}catch{job.state=oldState;}
  }
 }
 diagnose(){for(const job of Object.values(this.fulfilment.data().jobs)){if(!job.blockedReason)continue;const finite=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value)?value:'unconfirmed';const run=this.store.data.visaPortalRuns[job.id];const row={caseHash:digest(String(job.caseId||'')).slice(0,12),state:finite(job.state),code:finite(job.blockedReason),runPhase:finite(run?.phase),portalStage:finite(run?.lastStage),saved:job.portalSaved===true,hasReference:!!job.applicationReference};const signature=JSON.stringify(row);if(this.reportedDiagnostics.get(job.id)===signature)continue;this.reportedDiagnostics.set(job.id,signature);console.info('[VISA_PORTAL_DIAGNOSTIC] '+signature);}
  if(typeof this.documentIntake?.summary!=='function')return;
  for(const [customer,c]of Object.entries(this.store.data.visaCases||{}).slice(-50)){try{const s=this.documentIntake.summary(customer);if(s.caseId!==c.id||!['ready','needs_confirmation','needs_review','processing'].includes(s.status))continue;const row={caseHash:digest(String(c.id)).slice(0,12),status:s.status,awaitingPayment:s.awaitingPayment===true,applicants:(s.applicants||[]).slice(0,30).map(a=>({index:a.applicantIndex,status:['ready','needs_confirmation','needs_review'].includes(a.status)?a.status:'unconfirmed',gaps:['passportType','issueDate','birthPlace'].filter(f=>a.clientFieldsRequired?.includes(f)),prepared:['passport','residence','photo'].filter(k=>typeof a.documents?.[k]==='string'&&a.documents[k])})),readFailures:Object.values(this.store.data.visaDocumentIntake?.jobs||{}).filter(j=>j.customer===customer&&j.caseId===c.id&&j.status==='failed').slice(0,10).map(j=>({attempts:Math.min(10,Math.max(0,Number(Object.values(j.pageAttempts||{}).reduce((a,b)=>a+b,0))||0)),pages:Object.keys(j.pages||{}).length,issues:(j.issues||[]).slice(0,3).map(i=>({code:['DOCUMENT_READ_FAILED','DOCUMENT_FIELD_INVALID','DOCUMENT_PROVIDER_UNAVAILABLE','DOCUMENT_PDF_UNSUPPORTED'].includes(i.code)?i.code:'OTHER',failure:require('./visa-document-vision').DOCUMENT_VISION_ERROR_CODES.includes(i.failureCode)?i.failureCode:'OTHER',...(require('./visa-document-vision').SCHEMA_SECTIONS.includes(i.schemaSection)?{section:i.schemaSection}:{}),...(require('./visa-document-vision').DOCUMENT_FIELD_NAMES.includes(i.fieldName)?{field:i.fieldName}:{}),...(require('./visa-document-vision').SCHEMA_ISSUES.includes(i.schemaIssue)?{issue:i.schemaIssue}:{})}))}))};const key='documents:'+c.id,signature=JSON.stringify(row);if(this.reportedDiagnostics.get(key)===signature)continue;this.reportedDiagnostics.set(key,signature);console.info('[VISA_DOCUMENT_READINESS] '+signature);}catch{}}
 }
 async tick(){if(this.busy||this.env.RAAD_VISA_AUTOMATION_ENABLED!=='true')return;this.busy=true;try{
  this.diagnose();
  if(this.now()<this.portalReadyAt){await this.flushMessages();return;}
  await this.recoverPreflightLease();
  await this.recoverMissingPreflight();
  await this.recoverStoppedLogin();
  await this.recoverOperatorLogin();
  await this.recoverExpiredApplicationOtp();
  await this.flushMessages();
  for(const job of Object.values(this.fulfilment.data().jobs)){
   if(!['queued','ready'].includes(job.state))continue;
   try{this.fulfilment.guardJob(job.id);}catch{continue;}
   if(this.documentIntake?.enabled?.()){const prepared=await this.documentIntake.prepareJob(job),staff=this.raad.get(job.customer,{applicantIndex:job.applicantIndex});if(prepared.readyForQuestions!==true&&!(staff.review?.complete&&!staff.review.invalidated)){this.block(job,prepared.status==='processing'||prepared.status==='queued'?'DOCUMENTS_READING':'DOCUMENTS_REVIEW_REQUIRED');continue;}if(['DOCUMENTS_READING','DOCUMENTS_REVIEW_REQUIRED'].includes(job.blockedReason)){delete job.blockedReason;this.store.save();}}
   if(!job.answerConfirmation&&job.state==='queued'){const sibling=Object.values(this.fulfilment.data().jobs).some(j=>j.customer===job.customer&&j.id!==job.id&&['awaiting_answers','awaiting_answer_confirmation','needs_followup'].includes(j.state));if(!sibling)this.fulfilment.askQuestions(job.id);}
  }
  await this.flushMessages();if(!this.configured())return;await this.recover();
  const active=this.fulfilment.data().lease;
  if(active){const job=this.fulfilment.job(active.jobId),run=this.store.data.visaPortalRuns[job.id];if(run&&['starting','running','waiting_otp','waiting_operator','uncertain'].includes(run.phase))await this.poll(job,run);}
  else for(const job of Object.values(this.fulfilment.data().jobs)){if(!['queued','ready'].includes(job.state)||!job.answerConfirmation)continue;try{this.fulfilment.guardJob(job.id);await this.launch(job);if(this.fulfilment.data().lease)break;}catch{this.block(job,'PREPARATION_REVIEW_REQUIRED');}}
  await this.flushMessages();
 }catch{ /* Safe state is retained; no uncertain write or message is replayed. */ }finally{this.busy=false;}}
}
module.exports={VisaPortalDispatcher};
