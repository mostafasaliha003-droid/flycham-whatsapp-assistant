'use strict';
const {visaCaseSignature}=require('./visa-case-signature');
const {createHash}=require('node:crypto');
const LABELS=Object.freeze({passportType:'نوع الجواز',issueDate:'تاريخ إصدار الجواز',birthPlace:'مكان الولادة'});
function documentConfirmationCopy(summary){
 const issues=[...(summary?.issues||[]),...(summary?.applicants||[]).flatMap(a=>a?.issues||[])];
 const fields=Object.keys(LABELS).filter(field=>issues.some(i=>i?.code==='DOCUMENT_FIELD_REQUIRED'&&i.field===field)||(summary?.applicants||[]).some(a=>a?.clientFieldsRequired?.includes(field)));
 return 'المرفقات محفوظة، لكن مراجعة بيانات المستندات لم تكتمل بعد.'+(fields.length?' الخانات التي لم تتأكد قراءتها: '+fields.map(f=>LABELS[f]).join('، ')+'.':' توجد خانات مستندية تحتاج مطابقة من القسم.')+' لا داعي لإعادة إرسال كل الصور. لم يتأكد حفظ الطلب بعد.';
}
// Only a current, accountant-approved job can supersede document status.
// Never infer execution from received attachment counts or a model's prose.
function workflowProgressReply(store,customer,summary,now=Date.now()){
 try{
  const data=store?.data,c=data?.visaCases?.[customer];if(!c||summary?.caseId!==c.id)return null;
  const signature=visaCaseSignature(c),finance=data.visaFulfilment?.cases?.[customer],approval=finance?.approvals?.[finance.activeApprovalId];
  if(!approval||approval.state!=='approved'||approval.caseId!==c.id||approval.caseSignature!==signature||approval.paymentFingerprint!==createHash('sha256').update(JSON.stringify(c.staffVerification?.payment||null)).digest('hex'))return null;
  const jobs=Object.values(data.visaFulfilment?.jobs||{}).filter(j=>j.customer===customer&&j.caseId===c.id&&j.caseSignature===signature&&j.approvalId===approval.id&&!['cancelled','stale'].includes(j.state));
  // Multiple applicants must be reported individually by the existing workflow.
  if(jobs.length!==1)return null;const job=jobs[0],run=data.visaPortalRuns?.[job.id];
  if(job.state==='portal_review_required')return job.blockedReason==='OTP_CHALLENGE_EXPIRED'
   ? 'توقف استكمال الطلب لأن صلاحية رمز التحقق انتهت. لم يتأكد حفظ الطلب. يلزم استئناف التحقق برمز جديد من المشرف؛ لا داعي لإعادة إرسال الأوراق.'
   : 'توقف التنفيذ الآلي ويحتاج متابعة من القسم قبل الاستكمال. لم يتأكد إتمام الطلب؛ المرفقات محفوظة ولا داعي لإعادة إرسالها.';
  if(['awaiting_answers','needs_followup'].includes(job.state))return 'استكمال الطلب بانتظار إجابات الأسئلة المرسلة لك في هذه المحادثة. جاوب على السؤال الحالي لنكمل على نفس الملف؛ لا داعي لإعادة إرسال الأوراق.';
  if(job.state==='awaiting_answer_confirmation')return 'بيانات الطلب بانتظار اعتمادك على ملخص الإجابات المرسل في هذه المحادثة. راجع الملخص وأكّد صحته لنكمل على نفس الملف.';
  const lease=data.visaFulfilment?.lease;
  if(!lease||lease.jobId!==job.id||lease.cancelled||lease.expiresAt<=now)return null;
  if(job.state==='waiting_otp'&&run?.phase==='waiting_otp')return 'استكمال الطلب بانتظار رمز تحقق صالح من المشرف. لم يتأكد حفظ الطلب بعد؛ لا داعي لإعادة إرسال الأوراق.';
  if(job.state==='running'&&['starting','running'].includes(run?.phase))return 'رعد يتابع تنفيذ الطلب حاليًا. لم يتأكد حفظه بعد، وسنبلغك بالنتيجة المتحققة؛ لا داعي لإعادة إرسال الأوراق.';
 }catch{}
 return null;
}
module.exports={documentConfirmationCopy,workflowProgressReply};
