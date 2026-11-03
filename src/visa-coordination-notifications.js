'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {visaCaseSignature}=require('./visa-case-signature');
const {OWNER}=require('./remal-service-policy');
const {operationsLink,guidanceFor}=require('./visa-operator-guidance');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const OPS='https://flycham-whatsapp-assistant.onrender.com/operations';
const REASONS=Object.freeze({payment_link:'العميل طلب رابط دفع بعمولة 5%. يرجى تجهيز الرابط وتأكيد الإجمالي.',tabby:'العميل طلب تابي بعمولة 9%. يرجى التنسيق وتأكيد الإجمالي.',discount:'العميل طلب خصمًا. يرجى مراجعة السعر والرد بالسعر المعتمد.',untrained_request:'استفسار يحتاج توجيهك. راجع محادثة العميل قبل الرد.',questions:'رعد يحتاج إجابة متحققًا منها لإكمال الملف. افتح آخر سؤال وأجب عنه هنا.',documents:'رعد يحتاج مراجعتك للمستندات أو البيانات. راجع النسخ الأصلية والبيانات المجهزة في لوحة العمليات.',blocked:'رعد يحتاج تدخلك لمتابعة التقديم. راجع حالة الملف في لوحة العمليات.'});
class VisaCoordinationNotifications{
 constructor({store,fulfilment,send,now=Date.now,report=()=>{}}){Object.assign(this,{store,fulfilment,send,now,report});store.data.visaCoordinationNotices||={items:{}};for(const i of Object.values(this.items()))if(i.state==='sending')i.state='uncertain';this.busy=false;}
 items(){return this.store.data.visaCoordinationNotices.items;}
 current(i){const c=this.store.data.visaCases?.[i.customer];if(!c||c.id!==i.caseId||visaCaseSignature(c)!==i.signature||i.expiresAt<=this.now())return false;if(i.reason==='blocked'){const job=this.fulfilment.data().jobs[i.jobId];return Boolean(job&&job.customer===i.customer&&job.caseId===i.caseId&&job.caseSignature===i.signature&&job.blockedReason&&(!i.blockedReason||job.blockedReason===i.blockedReason));}if(i.questionToken){const job=this.fulfilment.data().jobs[i.jobId];return job?.coordination?.recipient===OWNER&&job.customer===i.customer&&job.caseId===i.caseId&&job.caseSignature===i.signature&&(job.state==='awaiting_answers'&&job.questions?.[i.questionToken]?.state==='pending'||job.state==='awaiting_answer_confirmation'&&job.summary?.token===i.questionToken); }return true;}
 queue(customer,reason,key,extra={}){const c=this.store.data.visaCases?.[customer];if(!c||!REASONS[reason])return;const k=hash([customer,c.id,reason,key]);if(this.items()[k]||Object.keys(this.items()).length>=2000)return;this.items()[k]={id:randomUUID(),key:k,customer,caseId:c.id,signature:visaCaseSignature(c),reason,...extra,state:'pending',createdAt:this.now(),expiresAt:this.now()+7*86400000};this.store.save();}
 sync(){for(const [key,i]of Object.entries(this.items()))if(i.expiresAt<=this.now()){delete this.items()[key];this.store.save();}
  for(const [customer,c]of Object.entries(this.store.data.visaCases||{})){
   if(c.operatorIntervention)this.queue(customer,c.operatorIntervention.reason,c.operatorIntervention.at);
   const hasPaidJob=Object.values(this.fulfilment.data().jobs).some(j=>j.customer===customer&&j.caseId===c.id&&!['stale','cancelled','saved_application'].includes(j.state));
   const intake=this.store.data.visaDocumentIntake?.cases?.[customer];if(!hasPaidJob&&intake?.caseId===c.id&&['needs_review','needs_confirmation'].includes(intake.status))this.queue(customer,'documents',intake.resultFingerprint||intake.generation);
  }
  for(const job of Object.values(this.fulfilment.data().jobs)){
   if(job.coordination?.recipient!==OWNER||this.store.data.visaCases?.[job.customer]?.id!==job.caseId||visaCaseSignature(this.store.data.visaCases[job.customer])!==job.caseSignature)continue;
   const q=job.state==='awaiting_answers'?Object.values(job.questions||{}).find(q=>q.state==='pending'):job.state==='awaiting_answer_confirmation'?job.summary:null;
   if(q)this.queue(job.customer,'questions',q.token,{jobId:job.id,questionToken:q.token});
   else if(job.state==='portal_review_required'||job.blockedReason&&!['DOCUMENTS_READING','BROWSER_STARTING','OWNER_NOTIFICATION_NOT_READY'].includes(job.blockedReason))this.queue(job.customer,'blocked',job.id+':'+job.blockedReason,{jobId:job.id,blockedReason:job.blockedReason});
  }
 }
 text(i){
  const job=i.jobId&&this.fulfilment.data().jobs[i.jobId];
  const detail=i.reason==='blocked'?guidanceFor(job?.blockedReason,{phase:job?.portalStage||this.store.data.visaPortalRuns?.[i.jobId]?.lastStage,hasReference:Boolean(job?.applicationReference)}):null;
  const headline=detail?[detail.summary,detail.action,detail.referenceNote].filter(Boolean).join('\n'):REASONS[i.reason];
  return headline+'\nالعميل: +'+i.customer+'\nمرجع الملف: '+i.caseId+'\nفتح الملف مباشرة:\n'+operationsLink({customer:i.customer,caseId:i.caseId,jobId:i.jobId});
 }
 async flush(){if(this.busy)return;this.busy=true;try{this.sync();for(const i of Object.values(this.items())){
  if(i.state==='paused'&&i.retryAt<=this.now())i.state='pending';if(i.state!=='pending')continue;
  if(!this.current(i)){i.state='cancelled';this.store.save();continue;}
  // The bound interactive question is the notification when the owner window
  // is already open. This helper only opens a closed window through Meta's
  // actually approved utility template; no redundant text for each question.
  i.state='sending';this.store.save();const guard=()=>{if(!this.current(i))throw Object.assign(Error('COORDINATION_STALE'),{notDispatched:true});};
  try{const r=await this.send({recipient:OWNER,jobId:i.jobId||i.caseId,noticeId:i.id,questionOnly:i.reason==='questions',noticeMessageId:i.noticeMessageId,text:this.text(i)},guard);if(r.windowOpen){i.state='accepted';}else if(r.messages?.[0]?.id){i.state='accepted';i.messageId=r.messages[0].id;}else if(r.paused){i.state=r.noticeMessageId?'waiting_owner':'paused';i.noticeMessageId=r.noticeMessageId;i.retryAt=this.now()+60000;}else i.state='uncertain';}catch(e){i.state=e.notDispatched?'paused':'uncertain';i.retryAt=this.now()+60000;}
  this.store.save();this.report({caseHash:hash(i.caseId).slice(0,12),reason:i.reason,state:i.state});
 }}finally{this.busy=false;}}
 handles(m){return Boolean(m.visaCoordinationAction);}
 async receive(m){if(String(m.from).replace(/^\+/,'')!==OWNER)return{ok:false};const i=Object.values(this.items()).find(i=>i.id===m.visaCoordinationAction?.noticeId&&i.state==='waiting_owner'&&i.noticeMessageId===m.contextId&&this.current(i));if(!i){const known=Object.values(this.items()).find(n=>n.id===m.visaCoordinationAction?.noticeId&&n.noticeMessageId===m.contextId);return{ok:false,reply:'راجع حالة الملف المرتبط بالإشعار:\n'+operationsLink(known||{})};}i.state='pending';this.store.save();this.fulfilment.requeuePausedMessages(OWNER);await this.flush();return{ok:true};}
}
module.exports={VisaCoordinationNotifications};
