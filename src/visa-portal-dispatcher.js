'use strict';
const {createHash}=require('node:crypto');
const {validateApplicant}=require('./raad-document-validation');
const {requiredQuestions}=require('./visa-client-questions');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
class VisaPortalDispatcher{
 constructor({fulfilment,raad,mediaStore,store,documentIntake,notificationReadiness,ownerNotificationReady,env=process.env,fetchImpl=fetch,now=Date.now}){Object.assign(this,{fulfilment,raad,mediaStore,store,documentIntake,notificationReadiness,ownerNotificationReady,env,fetchImpl,now});store.data.visaPortalRuns||={};this.busy=false;this.recovered=false;this.reportedDiagnostics=new Map();}
 configured(){try{const u=new URL(this.env.RAAD_BROWSER_WORKER_URL);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&typeof this.env.RAAD_JOB_BRIDGE_KEY==='string'&&this.env.RAAD_JOB_BRIDGE_KEY.length>=32;}catch{return false;}}
 async request(path,{body,artifact=false,method}={}){if(!this.configured())throw Error('RAAD_BROWSER_NOT_CONFIGURED');const u=new URL(path,this.env.RAAD_BROWSER_WORKER_URL),headers={Authorization:'Bearer '+this.env.RAAD_JOB_BRIDGE_KEY};if(body)headers['Content-Type']='application/json';const r=await this.fetchImpl(u.href,{method:method|| (body?'POST':'GET'),headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Object.assign(Error('RAAD_BRIDGE_HTTP_'+r.status),{status:r.status});if(!artifact)return r.json();if(!(r.headers.get('content-type')||'').startsWith('application/pdf'))throw Error('RAAD_ARTIFACT_TYPE_INVALID');const parts=[];let length=0;for await(const chunk of r.body){length+=chunk.length;if(length>10*1024*1024)throw Error('RAAD_ARTIFACT_TOO_LARGE');parts.push(Buffer.from(chunk));}const bytes=Buffer.concat(parts);if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('RAAD_ARTIFACT_INVALID');return bytes;}
 async resumeOtp({jobId,portalChallengeId,code,guard}){guard();const run=this.store.data.visaPortalRuns[jobId];if(!run||run.phase!=='waiting_otp')throw Error('RAAD_OTP_CONTEXT_STALE');return this.request('/internal/raad/jobs/'+jobId+'/otp',{body:{challengeId:portalChallengeId,code}});}
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
   await this.fulfilment.dispatchMessage(item.id);
  }
 }
 async cancelOwned(id){const result=await this.request('/internal/raad/jobs/'+id+'/cancel',{body:{}});if(result.stage!=='cancelled'||result.ownedBrowserClosed!==true)throw Error('RAAD_CANCEL_UNCONFIRMED');return result;}
 async recover(){if(this.recovered)return;for(const [id,run]of Object.entries(this.store.data.visaPortalRuns)){if(!['starting','running','waiting_otp','uncertain'].includes(run.phase))continue;await this.cancelOwned(id);run.phase='interrupted';this.store.save();}this.recovered=true;}
 async launch(job){
  const proof=this.fulfilment.getConfirmedFields(job.id);if(!proof.complete||!proof.confirmation?.messageId){this.block(job,'CLIENT_ANSWERS_REQUIRED');return;}
  const draft=this.dossier(job,proof),draftFingerprint=draft.fingerprint;
  if(!draft.ready){this.block(job,draft.blockedReason||'DOCUMENTS_REVIEW_REQUIRED');return;}
  const fields=draft.fields;
  const contact={...draft.defaults,...fields};if(!contact.entryDate)fields.entryDate=contact.proposedEntryDate;
  const validation=validateApplicant(fields);if(validation.issues.length){const missing=validation.issues.map(i=>i.field).filter(f=>{try{return requiredQuestions(fields,{requestedFields:[f]}).length>0;}catch{return false;}});if(missing.length){this.fulfilment.askQuestions(job.id,{fields:[...new Set(missing)]});return;}this.block(job,'DOCUMENT_DATA_REVIEW_REQUIRED');return;}
  const documents=[];for(const [kind,role]of [['passport','passport'],['residence','residence'],['photo','portrait']]){const id=draft.documents?.[kind]?.mediaId;if(!id){this.block(job,'DOCUMENTS_REQUIRED');return;}const {metadata,bytes}=this.mediaStore.read(id,{customer:job.customer});if(!['image/png','image/jpeg'].includes(metadata.mimeType)||bytes.length>1000000){this.block(job,'DOCUMENT_PREPARATION_REQUIRED');return;}documents.push({role,mimeType:metadata.mimeType,data:bytes.toString('base64'),sha256:digest(bytes)});}
  if(typeof this.ownerNotificationReady==='function'){let ready=false;try{ready=await this.ownerNotificationReady()===true;}catch{}if(!ready){this.block(job,'OWNER_NOTIFICATION_NOT_READY');return;}}
  try{const health=await this.request('/health');if(health.ready!==true){this.block(job,'BROWSER_STARTING');return;}}catch{this.block(job,'BROWSER_STARTING');return;}
  const currentDraft=this.dossier(job,this.fulfilment.getConfirmedFields(job.id));if(!draftFingerprint||!currentDraft.ready||currentDraft.fingerprint!==draftFingerprint){this.block(job,'DOCUMENTS_REVIEW_REQUIRED');return;}
  const {lease}=this.fulfilment.acquireJob(job.id,{workerId:'raad-browser',ttlMs:30*60000});
  const run={phase:'starting',leaseToken:lease.token,startedAt:this.now(),lastStage:'preflight',draftFingerprint,reviewSource:draft.source};this.store.data.visaPortalRuns[job.id]=run;this.store.save();
  try{await this.request('/internal/raad/jobs',{body:{jobId:job.id,leaseToken:lease.token,caseId:job.caseId,applicantIndex:job.applicantIndex,caseSignature:job.caseSignature,fields,defaults:draft.defaults,answers:proof.fields,documents,clientConsent:proof.confirmation,...(job.applicationReference?{existingApplicationReference:job.applicationReference}:{})}});run.phase='running';delete job.blockedReason;this.store.save();}
  catch{run.phase='uncertain';job.state='portal_review_required';this.fulfilment.data().lease.cancelled=true;this.block(job,'PORTAL_START_UNCERTAIN');this.store.save();}
 }
 async poll(job,run){
  try{this.currentDossier(job,run);this.fulfilment.renewLease(job.id,{leaseToken:run.leaseToken,ttlMs:30*60000});}catch{await this.cancelOwned(job.id);run.phase='cancelled';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.store.save();return;}
  let state;try{state=await this.request('/internal/raad/jobs/'+job.id);}catch(error){if(error?.status!==404)throw error;await this.cancelOwned(job.id);run.phase='interrupted';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.block(job,'BROWSER_JOB_LOST');this.store.save();return;}run.lastStage=state.phase;job.portalStage=state.phase;
  if(state.saved===true&&/^[A-Z]{0,3}[0-9]{3,20}$/.test(state.reference||'')){job.applicationReference=state.reference;job.portalSaved=true;}
  if(state.requiresOtp&&state.challengeId){run.phase='waiting_otp';const prior=Object.values(this.fulfilment.data().challenges).find(c=>c.jobId===job.id&&c.portalChallengeId===state.challengeId);if(!prior)this.fulfilment.requestOtp(job.id,{leaseToken:run.leaseToken,portalChallengeId:state.challengeId,contextId:state.challengeId,ttlMs:Math.min(5*60000,Math.max(1000,(state.challengeExpiresAt||this.now()+5*60000)-this.now()))});}
  if(state.stage==='completed'&&state.artifactReady&&state.saved===true&&state.reference&&state.paymentAttempted===false&&state.returnedFromPayment===true){if(state.jobId!==job.id||state.caseSignature!==job.caseSignature||state.applicantIndex!==job.applicantIndex||!/^[a-f0-9]{64}$/.test(state.artifactSha256||''))throw Error('RAAD_ARTIFACT_BINDING_INVALID');const bytes=await this.request('/internal/raad/jobs/'+job.id+'/artifact',{artifact:true});if(digest(bytes)!==state.artifactSha256)throw Error('RAAD_ARTIFACT_DIGEST_INVALID');this.fulfilment.guardLease(job.id,run.leaseToken);this.currentDossier(job,run);const copy=this.mediaStore.storeApplicationPdf(job.customer,{bytes,applicationReference:state.reference,jobId:job.id});this.fulfilment.recordPortalResult(job.id,{leaseToken:run.leaseToken,status:'saved_application',applicationReference:state.reference,paymentAttempted:false,returnedFromPayment:true,requestCopy:{mediaId:copy.id}});run.phase='completed';}
  else if(['failed','blocked','cancelled','lease_lost'].includes(state.stage)){await this.cancelOwned(job.id);run.phase='blocked';this.fulfilment.releaseJob(job.id,{leaseToken:run.leaseToken,state:'portal_review_required'});this.block(job,state.blocker?.code||'PORTAL_REVIEW_REQUIRED');}
  this.store.save();
 }
 diagnose(){for(const job of Object.values(this.fulfilment.data().jobs)){if(!job.blockedReason)continue;const finite=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value)?value:'unconfirmed';const run=this.store.data.visaPortalRuns[job.id];const row={caseHash:digest(String(job.caseId||'')).slice(0,12),state:finite(job.state),code:finite(job.blockedReason),runPhase:finite(run?.phase),portalStage:finite(run?.lastStage),saved:job.portalSaved===true,hasReference:!!job.applicationReference};const signature=JSON.stringify(row);if(this.reportedDiagnostics.get(job.id)===signature)continue;this.reportedDiagnostics.set(job.id,signature);console.info('[VISA_PORTAL_DIAGNOSTIC] '+signature);}}
 async tick(){if(this.busy||this.env.RAAD_VISA_AUTOMATION_ENABLED!=='true')return;this.busy=true;try{
  this.diagnose();
  await this.flushMessages();
  for(const job of Object.values(this.fulfilment.data().jobs)){
   if(!['queued','ready'].includes(job.state))continue;
   try{this.fulfilment.guardJob(job.id);}catch{continue;}
   if(this.documentIntake?.enabled?.()){const prepared=await this.documentIntake.prepareJob(job),staff=this.raad.get(job.customer,{applicantIndex:job.applicantIndex});if(prepared.readyForQuestions!==true&&!(staff.review?.complete&&!staff.review.invalidated)){this.block(job,prepared.status==='processing'||prepared.status==='queued'?'DOCUMENTS_READING':'DOCUMENTS_REVIEW_REQUIRED');continue;}if(['DOCUMENTS_READING','DOCUMENTS_REVIEW_REQUIRED'].includes(job.blockedReason)){delete job.blockedReason;this.store.save();}}
   if(!job.answerConfirmation&&job.state==='queued'){const sibling=Object.values(this.fulfilment.data().jobs).some(j=>j.customer===job.customer&&j.id!==job.id&&['awaiting_answers','awaiting_answer_confirmation','needs_followup'].includes(j.state));if(!sibling)this.fulfilment.askQuestions(job.id);}
  }
  await this.flushMessages();if(!this.configured())return;await this.recover();
  const active=this.fulfilment.data().lease;
  if(active){const job=this.fulfilment.job(active.jobId),run=this.store.data.visaPortalRuns[job.id];if(run&&['starting','running','waiting_otp','uncertain'].includes(run.phase))await this.poll(job,run);}
  else for(const job of Object.values(this.fulfilment.data().jobs)){if(!['queued','ready'].includes(job.state)||!job.answerConfirmation)continue;try{this.fulfilment.guardJob(job.id);await this.launch(job);if(this.fulfilment.data().lease)break;}catch{this.block(job,'PREPARATION_REVIEW_REQUIRED');}}
  await this.flushMessages();
 }catch{ /* Safe state is retained; no uncertain write or message is replayed. */ }finally{this.busy=false;}}
}
module.exports={VisaPortalDispatcher};
