'use strict';
const {visaCaseSignature}=require('./visa-case-signature');
const {createHash}=require('node:crypto');
const LABELS=Object.freeze({passportType:'نوع الجواز',issueDate:'تاريخ إصدار الجواز',birthPlace:'مكان الولادة'});
function documentClarificationCopy(summary){
 const issues=[...(summary?.issues||[]),...(summary?.applicants||[]).flatMap(a=>a?.issues||[])];
 const prepared=summary?.applicants?.length>0&&summary.applicants.every(a=>['passport','residence','photo'].every(k=>a.documents?.[k]));
 if(prepared&&summary.receiptPendingReview===true)return 'الجواز والهوية والصورة الشخصية جاهزين. إيصال التحويل وصل وبانتظار المراجعة، ومنأكد لك استلام الدفعة بعد التحقق.';
 if(prepared&&summary.unidentifiedAttachment===true)return 'الجواز والهوية والصورة الشخصية جاهزين، وما في داعي تعيد إرسالهم.';
 if(issues.some(i=>i?.code==='CASE_DATA_MISMATCH'&&i.field==='nationalityCode'))return 'للتأكيد، الجواز المرسل لنفس الشخص اللي عم نقدّم له، أو لشخص تاني؟';
 const reviewed=(summary?.recovery?.attempts||Object.values(summary?.documentReviews||{}).map(r=>r.state)).some(state=>['completed','conflict','failed','uncertain'].includes(state));
 if(reviewed&&issues.some(i=>i?.code==='PASSPORT_MRZ_DATE_AMBIGUOUS'))return 'بقي تأكيد بعض بيانات الجواز قبل استكمال الطلب. ابعت نسخة أوضح من صفحة بيانات الجواز بحجمها الأصلي، بحيث تاريخ الميلاد وتاريخ الانتهاء ظاهرين كاملين. الهوية وباقي المرفقات محفوظة؛ ما في داعي تعيد إرسالها.';
 if(issues.some(i=>i?.code==='MULTIPLE_PASSPORTS'))return 'وصل أكثر من جواز مختلف. بدك تقديم لكل أصحاب الجوازات، أو في جواز محدد بدنا نستخدمه؟ المرفقات محفوظة.';
 return null;
}
function documentConfirmationCopy(summary){
 const clarification=documentClarificationCopy(summary);if(clarification)return clarification;
 const issues=[...(summary?.issues||[]),...(summary?.applicants||[]).flatMap(a=>a?.issues||[])];
 const fields=Object.keys(LABELS).filter(field=>!((summary?.applicants||[]).some(a=>a?.clientFieldsRequired?.includes(field))&&(summary?.applicants||[]).filter(a=>a?.clientFieldsRequired?.includes(field)).every(a=>a?.clientConfirmedFields?.[field]))&&(issues.some(i=>i?.code==='DOCUMENT_FIELD_REQUIRED'&&i.field===field)||(summary?.applicants||[]).some(a=>a?.clientFieldsRequired?.includes(field))));
 const questions={passportType:'اختار نوع جواز السفر من القائمة اللي أرسلتها إلك 👇',issueDate:'شو تاريخ إصدار الجواز؟',birthPlace:'شو مكان الولادة المكتوب بالجواز؟'};
 return fields.length?'وصلت أوراقك، شكرًا إلك. '+questions[fields[0]]:'وصلت أوراقك، شكرًا إلك. منخبرك إذا احتجنا أي معلومة إضافية.';
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
   ? 'طلبك معنا، ومنبلغك بأول تحديث. ما مطلوب منك أي إجراء حاليًا.'
   : 'طلبك معنا، ومنبلغك بأول تحديث. ما مطلوب منك أي إجراء حاليًا.';
  if(['awaiting_answers','needs_followup'].includes(job.state))return 'استكمال الطلب بانتظار إجابات الأسئلة المرسلة لك في هذه المحادثة. جاوب على السؤال الحالي لنكمل على نفس الملف؛ لا داعي لإعادة إرسال الأوراق.';
  if(job.state==='awaiting_answer_confirmation')return 'بيانات الطلب بانتظار اعتمادك على ملخص الإجابات المرسل في هذه المحادثة. راجع الملخص وأكّد صحته لنكمل على نفس الملف.';
  const lease=data.visaFulfilment?.lease;
  if(!lease||lease.jobId!==job.id||lease.cancelled||lease.expiresAt<=now)return null;
  if(job.state==='waiting_otp'&&run?.phase==='waiting_operator')return 'عم نتابع إجراءات طلبك، ومنبلغك أول ما تكتمل خطوة التقديم.';
  if(job.state==='waiting_otp'&&run?.phase==='waiting_otp')return 'عم نتابع إجراءات طلبك، ومنبلغك أول ما تكتمل خطوة التقديم.';
  if(job.state==='running'&&['starting','running'].includes(run?.phase))return 'عم نتابع إجراءات طلبك، ومنبلغك أول ما تكتمل خطوة التقديم.';
 }catch{}
 return null;
}
module.exports={documentClarificationCopy,documentConfirmationCopy,workflowProgressReply};
