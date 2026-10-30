'use strict';
const {randomUUID}=require('node:crypto');
const {visaCaseSignature}=require('./visa-case-signature');
const {QUESTION_CATALOG,questionFor,validateAnswer}=require('./visa-client-questions');
const at=(o,k)=>k.split('.').reduce((v,p)=>v?.[p],o);
const fail=code=>{throw Object.assign(Error(code),{code,statusCode:409});};
const clone=x=>structuredClone(x);
// Staff collection is a separate lane: it never changes a portal job state,
// releases ownership, confirms applicant answers, or starts browser work.
class VisaStaffQuestions{
 constructor({fulfilment,store,inbox,journal,now=Date.now}){
  Object.assign(this,{fulfilment,store,inbox,journal,now});this.locks=new Set();
  store.data.visaStaffQuestions||={sessions:{}};
  for(const s of Object.values(this.data()))if(s.state==='sending'){s.state='uncertain';store.save();}
 }
 data(){return this.store.data.visaStaffQuestions.sessions;}
 guard(customer,jobId){
  const job=this.fulfilment.job(jobId),c=this.fulfilment.case(customer);
  if(job.customer!==customer||job.caseId!==c.id||job.caseSignature!==visaCaseSignature(c)||job.state!=='portal_review_required')fail('STAFF_QUESTION_CONTEXT_STALE');
  const approval=this.fulfilment.data().cases[customer]?.approvals[job.approvalId];
  if(!this.fulfilment.approvalCurrent(customer,approval))fail('VISA_APPROVAL_STALE');
  if(!this.inbox.isOperatorOwned(customer))fail('CLAIM_REQUIRED');
  if(this.fulfilment.blocked(customer)!=='HUMAN_OWNERSHIP')fail('STAFF_QUESTION_BLOCKED');
  if(this.fulfilment.data().lease?.customer===customer||Object.entries(this.store.data.visaPortalRuns||{}).some(([id,r])=>this.fulfilment.data().jobs[id]?.customer===customer&&['starting','running','waiting_otp','uncertain'].includes(r.phase)))fail('STAFF_QUESTION_PORTAL_BUSY');
  return job;
 }
 current(s){const j=this.guard(s.customer,s.jobId);if(j.revision!==s.jobRevision||j.caseSignature!==s.caseSignature)fail('STAFF_QUESTION_CONTEXT_STALE');return j;}
 answered(job,field){
  try{validateAnswer(field,at(job.confirmedFields,field));return true;}catch{}
  return Object.values(this.data()).some(s=>s.jobId===job.id&&s.caseSignature===job.caseSignature&&s.state==='answered'&&s.field===field);
 }
 view(customer,jobId){
  const job=this.fulfilment.job(jobId);if(job.customer!==customer)fail('STAFF_QUESTION_CONTEXT_STALE');
  const sessions=Object.values(this.data()).filter(s=>s.customer===customer&&s.jobId===jobId&&s.caseSignature===job.caseSignature);
  let blocker=null;try{this.guard(customer,jobId);}catch(e){blocker=e.code;}
  const busy=sessions.some(s=>['sending','accepted','uncertain'].includes(s.state));
  return {jobId,jobRevision:job.revision,caseSignature:job.caseSignature,blockedReason:blocker,busy,
   confirmedAnswers:Object.entries(QUESTION_CATALOG).flatMap(([field,def])=>{try{const value=validateAnswer(field,at(job.confirmedFields,field));return [{field,prompt:def.prompt,label:def.options?.find(o=>o.value===value)?.label||String(value)}];}catch{return [];}}),
   // Values collected here still need staff review; no automatic application.
   collected:sessions.filter(s=>s.state==='answered').map(s=>({field:s.field,prompt:s.question.prompt,label:s.question.options?.find(o=>o.value===s.answer)?.label||String(s.answer),value:s.answer,answeredAt:s.answeredAt,messageId:s.answerMessageId})),
   questions:Object.keys(QUESTION_CATALOG).filter(field=>!this.answered(job,field)).map(field=>questionFor(field,{applicantIndex:job.applicantIndex})),
   attempts:sessions.map(s=>({id:s.id,field:s.field,state:s.state,createdAt:s.createdAt,messageId:s.messageId||null}))};
 }
 async request(customer,{jobId,field,expectedRevision,expectedCaseSignature,idempotencyKey}={}){
  if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))fail('VISA_IDEMPOTENCY_KEY_INVALID');
  const prior=Object.values(this.data()).find(s=>s.customer===customer&&s.idempotencyKey===idempotencyKey);
  if(prior){if(prior.jobId!==jobId||prior.field!==field||prior.jobRevision!==expectedRevision||prior.caseSignature!==expectedCaseSignature)fail('VISA_IDEMPOTENCY_CONFLICT');return clone(prior);}
  if(this.locks.has(customer))fail('STAFF_QUESTION_BUSY');
  const job=this.guard(customer,jobId);
  if(job.revision!==expectedRevision||job.caseSignature!==expectedCaseSignature)fail('STAFF_QUESTION_CONTEXT_STALE');
  if(this.answered(job,field))fail('STAFF_QUESTION_ALREADY_ANSWERED');
  if(Object.values(this.data()).some(s=>s.customer===customer&&['sending','accepted','uncertain'].includes(s.state)))fail('STAFF_QUESTION_BUSY');
  // Do not send an unneeded conditional question, or a new question while the
  // automatic lane still has an unresolved delivery.
  const def=QUESTION_CATALOG[field];if(!def)fail('VISA_QUESTION_UNKNOWN');
  if(def.dependsOn&&at(job.confirmedFields,def.dependsOn.field)!==def.dependsOn.value)fail('STAFF_QUESTION_DEPENDENCY_REQUIRED');
  if(Object.values(this.fulfilment.data().outbox).some(x=>x.customer===customer&&['applicant_question','applicant_answer_summary'].includes(x.kind)&&['pending','sending','uncertain'].includes(x.state)))fail('STAFF_QUESTION_AUTOMATIC_PENDING');
  if(this.journal.summary(customer)?.serviceWindowOpen!==true)fail('WINDOW_CLOSED');
  const question=questionFor(field,{applicantIndex:job.applicantIndex}),id=randomUUID();
  const s={id,token:id,customer,jobId,field,idempotencyKey,jobRevision:job.revision,caseSignature:job.caseSignature,question,state:'sending',createdAt:this.now()};
  this.data()[id]=s;this.store.save();this.locks.add(customer);
  const guard=()=>{this.current(s);if(s.state!=='sending'||this.journal.summary(customer)?.serviceWindowOpen!==true)fail('STAFF_QUESTION_CONTEXT_STALE');};
  try{
   const result=await this.fulfilment.send(customer,{type:'question',text:question.prompt,field,applicantIndex:job.applicantIndex,options:question.options||[],token:id},guard,{kind:'staff_applicant_question',customer,jobId,caseId:job.caseId});
   if(result?.paused||result?.dryRun||result?.notDispatched){s.state='not_sent';}
   else{const messageId=result?.messages?.[0]?.id||result?.messageId;if(typeof messageId!=='string'||!messageId||messageId.length>500)throw Error('INVALID_DELIVERY_RESULT');s.state='accepted';s.messageId=messageId;}
  }catch(e){s.state=e?.notDispatched===true?'not_sent':'uncertain';}
  finally{this.locks.delete(customer);this.store.save();}
  return clone(s);
 }
 handleCustomerMessage(sender,message={}){
  let s;
  if(message.visaAnswer?.token)s=this.data()[message.visaAnswer.token];
  else if(typeof message.text==='string'&&!message.media&&!message.visaConfirmation){
   const matches=Object.values(this.data()).filter(x=>x.customer===sender&&x.state==='accepted'&&x.question.type==='text'&&(!message.contextId||message.contextId===x.messageId));
   if(matches.length===1)s=matches[0];
  }
  if(!s)return {handled:false};
  if(s.customer!==sender)return {handled:true,ok:false,error:'STAFF_ANSWER_RECIPIENT_MISMATCH'};
  if(s.state==='answered'&&message.id===s.answerMessageId)return {handled:true,ok:true};
  if(s.state!=='accepted')return {handled:true,ok:false,error:'STAFF_ANSWER_STALE'};
  try{
   this.current(s);let value;
   if(s.question.type==='choice'){
    const selected=s.question.options.find(o=>o.id===message.visaAnswer?.option);
    if(!selected||message.visaAnswer?.value!==undefined)fail('VISA_ANSWER_OPTION_INVALID');value=selected.value;
   }else{if(message.visaAnswer?.option!==undefined)fail('VISA_ANSWER_OPTION_INVALID');value=message.visaAnswer?.value??message.text;}
   const answer=validateAnswer(s.field,value);
   s.answer=answer;s.answerMessageId=message.id||null;s.answeredAt=this.now();s.state='answered';this.store.save();
   return {handled:true,ok:true};
  }catch(e){return {handled:true,ok:false,error:e.code||'STAFF_ANSWER_INVALID'};}
 }
}
module.exports={VisaStaffQuestions};
