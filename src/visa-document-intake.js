'use strict';
const {createHash,randomUUID}=require('node:crypto');
const sharp=require('sharp');
const {validCustomer}=require('./conversation-journal');
const {visaCaseSignature,currentVisaEvidence}=require('./visa-case-signature');
const {preparePortalImage,prepareResidenceImage,prepareDocumentImage}=require('./raad-attachments');
const {rasterizePdf}=require('./raad-pdf');
const {reconcileDocumentEvidence}=require('./visa-document-matching');
const {parseTD3MRZ}=require('./raad-document-validation');
const {parseTD1MRZ}=require('./visa-id-mrz');
const {MRZ_POLICY_FINGERPRINT,MRZ_VISION_ERROR_CODES,MAX_MRZ_IMAGE_BYTES,MAX_MRZ_IMAGE_PIXELS}=require('./visa-mrz-vision');
const {MRZ_OPTICAL_ERROR_CODES}=require('./visa-mrz-optical');
const {validateDocumentExtraction,POLICY_FINGERPRINT,COMPATIBLE_PREVIOUS_POLICIES,COMPATIBLE_COMPLETED_FAILURE_POLICIES=[],DOCUMENT_VISION_ERROR_CODES,DOCUMENT_FIELD_NAMES,SCHEMA_SECTIONS,SCHEMA_ISSUES,RETRYABLE_CODES}=require('./visa-document-vision');
const sharedLock=require('./raad-preparation-lock');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;const MAX_SOURCES=20,MAX_ATTEMPTS=2,MAX_TOTAL_PAGES=100;
// Changing matching/preparation reuses the existing OCR page checkpoints.
// It must not silently send all existing originals to the provider again.
const PREPARATION_POLICY='raad-document-preparation-2026-10-29.v7';
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value===undefined?null:value;}
const digest=value=>hash(JSON.stringify(canonical(value)));
function extractionDigestFor(documents,matched){return digest({documents,applicantIndex:matched.applicantIndex,fields:matched.fields,matchedDocuments:matched.documents,evidence:matched.evidence});}
const reason=(code,field='documents')=>({code,field,message:({DOCUMENT_OCR_INTERRUPTED:'انقطعت قراءة أحد المرفقات؛ يلزم مراجعتها قبل اعتماد البيانات.',DOCUMENT_SOURCE_LIMIT:'تجاوز عدد المرفقات حد القراءة الآلية؛ يلزم مراجعة القسم.',DOCUMENT_SOURCE_CHANGED:'تغير أحد المرفقات أثناء المعالجة.',DOCUMENT_PDF_UNSUPPORTED:'ملف PDF غير مدعوم؛ الحد الأقصى عشر صفحات واضحة.',DOCUMENT_PAGE_LIMIT:'تجاوز مجموع صفحات المرفقات حد المئة صفحة؛ يلزم مراجعة القسم.',DOCUMENT_PORTRAIT_REQUIRED:'يلزم صورة شخصية واضحة أو صورة جواز تتضمن صورة شخصية قابلة للاقتصاص دون تكبير.',DOCUMENT_IMAGE_UNSUITABLE:'تعذر تجهيز صورة واضحة ضمن الحجم المطلوب.',DOCUMENT_APPLY_PAUSED:'قراءة المستندات محفوظة، لكن اعتمادها متوقف حتى انتهاء مراجعة القسم.',DOCUMENT_APPLY_UNCONFIRMED:'لم يتم تأكيد إدراج قراءة المستندات في ملف رعد.',DOCUMENT_READ_FAILED:'تعذرت قراءة المستند آلياً؛ يلزم مراجعة القسم أو إرساله بوضوح أكبر.',DOCUMENT_FIELD_INVALID:'رقم الهوية الإماراتية في القراءة غير صالح؛ يلزم مراجعة صورة الأصل أو التحقق من الرقم الصحيح دون تخمين.',DOCUMENT_PROVIDER_UNAVAILABLE:'خدمة قراءة المستندات غير متاحة حالياً.',DOCUMENT_SOURCE_UNAVAILABLE:'أحد المرفقات لم يعد متاحاً.',DOCUMENT_WAITING_CASE:'بانتظار إنشاء ملف التأشيرة لربط المرفق الصحيح.'})[code]||'تحتاج المستندات إلى مراجعة قبل المتابعة.'});
const finite=code=>Object.assign(Error(code),{code});
const MANUAL_OUTPUT_RETRY_CODES=new Set(['DOCUMENT_VISION_INVALID_JSON','DOCUMENT_VISION_SCHEMA_INVALID','DOCUMENT_VISION_INVALID_OUTPUT','DOCUMENT_VISION_INCOMPLETE']);
const FAILURE_LABELS={DOCUMENT_VISION_INVALID_JSON:'تعذر تحليل صيغة نتيجة القراءة.',DOCUMENT_VISION_SCHEMA_INVALID:'نتيجة القراءة لا تطابق الصيغة المطلوبة.',DOCUMENT_VISION_INVALID_OUTPUT:'محتوى نتيجة القراءة غير صالح.',DOCUMENT_VISION_INCOMPLETE:'نتيجة القراءة غير مكتملة.',DOCUMENT_VISION_INVALID_IMAGE:'الصورة غير صالحة لخدمة القراءة.',DOCUMENT_VISION_RESPONSE_TOO_LARGE:'تجاوزت نتيجة القراءة الحجم المسموح.',DOCUMENT_VISION_DISABLED:'خدمة القراءة غير مفعلة.',DOCUMENT_VISION_NOT_CONFIGURED:'إعداد خدمة القراءة غير مكتمل.',DOCUMENT_VISION_MODEL_NOT_ALLOWED:'نموذج القراءة غير مسموح.',DOCUMENT_VISION_STALE:'تغيرت الحالة أثناء القراءة.',DOCUMENT_VISION_PROVIDER_UNAVAILABLE:'خدمة القراءة غير متاحة.',DOCUMENT_VISION_NETWORK:'تعذر الاتصال بخدمة القراءة.',DOCUMENT_VISION_TIMEOUT:'انتهت مهلة خدمة القراءة.',DOCUMENT_VISION_RATE_LIMITED:'بلغت خدمة القراءة حد الطلبات.',DOCUMENT_VISION_COOLDOWN:'خدمة القراءة في فترة انتظار.',DOCUMENT_VISION_BUSY:'خدمة القراءة مشغولة.'};
Object.assign(FAILURE_LABELS,{MRZ_VISION_INVALID_IMAGE:'صورة المنطقة الآلية لا تحقق حدود القراءة المركزة.',MRZ_VISION_RESPONSE_TOO_LARGE:'تجاوزت نتيجة المنطقة الآلية الحجم المسموح.',MRZ_VISION_INVALID_JSON:'تعذر تحليل صيغة قراءة المنطقة الآلية.',MRZ_VISION_INVALID_OUTPUT:'بنية قراءة المنطقة الآلية غير مطابقة.',MRZ_VISION_CHECKS_FAILED:'لم تجتز المنطقة المقروءة آليًا جميع فحوص التحقق اللازمة.'});
Object.assign(FAILURE_LABELS,{MRZ_OPTICAL_MODEL_UNAVAILABLE:'نموذج القراءة البصرية المحلي غير متاح.',MRZ_OPTICAL_INVALID_IMAGE:'الصورة غير مناسبة للقارئ البصري المحلي.',MRZ_OPTICAL_ENGINE_UNAVAILABLE:'محرك القراءة البصرية المحلي غير متاح.',MRZ_OPTICAL_TIMEOUT:'انتهت مهلة القراءة البصرية المحلية.',MRZ_OPTICAL_READ_FAILED:'لم تكتمل القراءة البصرية المحلية.',MRZ_OPTICAL_DISAGREEMENT:'اختلفت قراءتان بصريتان صحيحتان للمنطقة الآلية؛ يلزم مراجعتهما.'});
const SECTION_LABELS={root:'بنية النتيجة',fields:'البيانات المقروءة',mrzLines:'المنطقة المقروءة آليًا',portraitBox:'حدود الصورة الشخصية'};
const ISSUE_LABELS={root_shape:'بنية غير مطابقة',root_value:'قيمة غير مقبولة',field_shape:'بنية المعلومة غير مطابقة',null_metadata:'وصف المعلومة غير المقروءة غير مطابق',field_metadata:'وصف الثقة أو الظهور غير مطابق',value_type:'نوع القيمة غير مطابق',value_format:'صيغة القيمة غير صالحة',mrz_format:'صيغة المنطقة الآلية غير صالحة',portrait_bounds:'حدود الصورة الشخصية غير صالحة'};
const FIELD_LABELS={latinFirstName:'الاسم الأول باللاتينية',latinFamilyName:'اسم العائلة باللاتينية',latinFatherName:'اسم الأب باللاتينية',latinGrandfatherName:'اسم الجد باللاتينية',latinFullName:'الاسم الكامل باللاتينية',arabicFirstName:'الاسم الأول بالعربية',arabicFatherName:'اسم الأب بالعربية',arabicGrandfatherName:'اسم الجد بالعربية',arabicFamilyName:'اسم العائلة بالعربية',arabicFullName:'الاسم الكامل بالعربية',passportNumber:'رقم الجواز',passportNationalNumber:'الرقم الوطني المطبوع بالجواز',passportType:'نوع الجواز',nationalityCode:'الجنسية',issuingCountryCode:'دولة إصدار الجواز',birthDate:'تاريخ الميلاد',birthPlace:'مكان الميلاد',sex:'الجنس',issueDate:'تاريخ الإصدار',expiryDate:'تاريخ انتهاء الجواز',emiratesId:'الهوية الإماراتية',residenceExpiry:'تاريخ انتهاء الإقامة',printedPassportExpiry:'انتهاء الجواز المطبوع',printedResidenceExpiry:'انتهاء الإقامة المطبوع'};
function failureReason(error,code='DOCUMENT_READ_FAILED',field='documents'){
 const issue=reason(code,field);if(!DOCUMENT_VISION_ERROR_CODES.includes(error?.code))return issue;
 issue.failureCode=error.code;if(SCHEMA_SECTIONS.includes(error.schemaSection)){issue.schemaSection=error.schemaSection;if(error.schemaSection==='fields'&&DOCUMENT_FIELD_NAMES.includes(error.fieldName))issue.fieldName=error.fieldName;if(SCHEMA_ISSUES.includes(error.schemaIssue))issue.schemaIssue=error.schemaIssue;}
 issue.message=[issue.message,FAILURE_LABELS[issue.failureCode],SECTION_LABELS[issue.schemaSection],FIELD_LABELS[issue.fieldName],ISSUE_LABELS[issue.schemaIssue]].filter(Boolean).join(' · ');return issue;
}
function checkedMrz(lines,at,format='TD3'){if(format==='TD1'){const parsed=parseTD1MRZ(lines);return parsed.ok===true&&parsed.format==='TD1'&&['documentNumber','birthDate','expiryDate','composite'].every(name=>parsed.checks?.[name]?.ok===true);}const parsed=parseTD3MRZ(lines,{referenceDate:dubaiDate(at)});return format==='TD3'&&parsed.format==='TD3'&&['documentNumber','birthDate','expiryDate','optionalData','composite'].every(name=>parsed.checks?.[name]?.ok===true)&&parsed.issues.every(item=>item.code==='ambiguous_century');}
function focusedPassportPage(extraction){const shown=name=>extraction.fields?.[name]?.visible===true&&typeof extraction.fields[name].value==='string'&&extraction.fields[name].value.length>0;return extraction.kind==='passport'&&(extraction.mrzLines.length>0||extraction.portraitBox||shown('birthDate')&&(shown('latinFirstName')&&shown('latinFamilyName')||shown('arabicFirstName')&&shown('arabicFamilyName')));}
function mrzReason(code,failureCode){const messages={DOCUMENT_MRZ_READ_FAILED:'لم تكتمل قراءة المنطقة الآلية المركزة؛ بقيت بيانات الصفحة المقروءة محفوظة للمراجعة.',DOCUMENT_MRZ_UNREADABLE:'لم تُعد القراءة المركزة سطور المنطقة المقروءة آليًا بوضوح؛ لا تُستكمل أحرفها بالتخمين.',DOCUMENT_MRZ_INTERRUPTED:'انقطعت قراءة المنطقة الآلية المركزة؛ لن يُكرر اتصال غير مؤكّد تلقائيًا.',SOURCE_CONFLICT:'اختلفت قراءتان مجتازتان للتحقق للمنطقة الآلية من الأصل نفسه؛ يلزم مراجعتها دون استبدال إحداهما بالأخرى.'};const issue={code,field:'mrzLines',message:messages[code]||messages.DOCUMENT_MRZ_READ_FAILED};if(MRZ_VISION_ERROR_CODES.includes(failureCode)||MRZ_OPTICAL_ERROR_CODES.includes(failureCode)||DOCUMENT_VISION_ERROR_CODES.includes(failureCode)){issue.failureCode=failureCode;if(FAILURE_LABELS[failureCode])issue.message+=' · '+FAILURE_LABELS[failureCode];}return issue;}
const originals=record=>record&&!record.purpose&&(['image/jpeg','image/png','image/webp'].includes(record.mimeType)&&record.type==='image'||record.mimeType==='application/pdf'&&record.type==='document');
function dubaiDate(at){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');}
const activeStatus=status=>['queued','running','retry','waiting_case'].includes(status);
class VisaDocumentIntake{
 constructor({store,mediaStore,vision,mrzVision=null,raad,fulfilment,inbox,env=process.env,now=Date.now,onUpdate=()=>{},report=()=>{},lock=sharedLock,rasterize=rasterizePdf,prepare=preparePortalImage,prepareResidence=prepareResidenceImage,prepareDocument=prepareDocumentImage,reconcile=reconcileDocumentEvidence,policyFingerprint=POLICY_FINGERPRINT}={}){
  if(!store?.data||typeof store.save!=='function'||!mediaStore?.read||!vision?.extract)throw finite('DOCUMENT_INTAKE_CONFIGURATION_REQUIRED');
  Object.assign(this,{store,mediaStore,vision,mrzVision,raad,fulfilment,inbox,env,now,onUpdate,report,lock,rasterize,prepare,prepareResidence,prepareDocument,reconcile,policyFingerprint});
  if(!store.data.visaDocumentIntake)store.data.visaDocumentIntake={version:1,cases:{},jobs:{}};
  if(store.data.visaDocumentIntake.version!==1)throw finite('DOCUMENT_INTAKE_STATE_UNSUPPORTED');
  this.started=false;this.stopped=false;this.busy=false;this.epoch=0;this.timer=null;this.scheduled=false;this.unsubscribe=null;
  this.recover();
 }
 data(){return this.store.data.visaDocumentIntake;}
 enabled(){return this.env.RAAD_DOCUMENT_OCR_ENABLED==='true';}
 configured(){try{const state=this.vision.status?.();return state?state.configured===true:this.vision.ready?.()===true;}catch{return false;}}
 available(){try{return this.enabled()&&this.vision.ready?.()===true;}catch{return false;}}
 commit(change){const previous=clone(this.data());try{const result=change();this.store.save();return result;}catch{this.store.data.visaDocumentIntake=previous;throw finite('DOCUMENT_INTAKE_STATE_FAILED');}}
 notify(customer){try{this.onUpdate(customer,this.summary(customer));}catch{}}
 localTd1Capable(){try{return typeof this.mrzVision?.extract==='function'&&this.mrzVision.supports?.('TD1')===true&&this.mrzVision.status?.()?.local===true;}catch{return false;}}
 reportBindingReview(customer,c,documents,matched){
  if(!Array.isArray(matched.unassigned)||!matched.unassigned.length)return;
  try{
   const listed=typeof this.mediaStore.list==='function'?this.mediaStore.list(customer):Object.values(this.mediaStore.records||this.store.data.visaMedia||{}).filter(file=>file.customer===customer&&file.expiresAt>this.now()).sort((a,b)=>b.receivedAt-a.receivedAt).slice(0,50);
   const originals=listed.filter(file=>typeof file?.id==='string'&&!file.purpose&&!file.derived&&!file.isDerived&&!file.sourceIds?.length&&(!file.customer||file.customer===customer)&&!['unavailable','failed','expired','application_copy'].includes(file.status)&&/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimeType||''));
   const allowedReasons=new Set(['DOCUMENT_UNASSIGNED','DOCUMENT_UNREADABLE','INVALID_EXTRACTION','SOURCE_CONFLICT','MULTIPLE_PASSPORTS']),kinds=new Set(['passport','uae_id_front','uae_id_back','portrait','other']),references=[];
   for(const ref of matched.unassigned){if(references.length>=10)break;const ordinal=originals.findIndex(file=>file.id===ref?.mediaId)+1,document=documents.find(item=>item.mediaId===ref?.mediaId&&item.page===ref.page&&item.sha256===ref.sha256);if(!ordinal||!document||!Number.isInteger(ref.page)||ref.page<1||ref.page>10)continue;const extraction=document.extraction||{},fields=DOCUMENT_FIELD_NAMES.filter(name=>Object.hasOwn(extraction.fields||{},name)&&extraction.fields[name]?.visible===true).slice(0,20).map(name=>{const confidence=extraction.fields[name]?.confidence;return {name,...(typeof confidence==='number'&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1?{confidence}:{})};});
    references.push({ordinal,page:ref.page,kind:kinds.has(extraction.kind)?extraction.kind:'other',readable:extraction.readable===true,fields,mrzLineLengths:Array.isArray(extraction.mrzLines)?extraction.mrzLines.slice(0,3).map(line=>typeof line==='string'?Math.min(256,line.length):0):[],reason:allowedReasons.has(ref.reason)?ref.reason:'DOCUMENT_UNASSIGNED'});
   }
   this.report('DOCUMENT_BINDING_REVIEW',{caseHash:hash(c.id).slice(0,12),references});
  }catch{}
 }
 retirePolicies(){
  const affected=new Set();let changed=false;
  // Reuse strictly validated completed evidence. A diagnostics-only policy also
  // retains terminal failures/unreadable outcomes: a rollout must not replay them.
  if(this.policyFingerprint===POLICY_FINGERPRINT)for(const job of Object.values(this.data().jobs)){
   const keepCompleted=COMPATIBLE_COMPLETED_FAILURE_POLICIES.includes(job.policy);
   if(!COMPATIBLE_PREVIOUS_POLICIES.includes(job.policy)||!(job.status==='ready'&&Object.keys(job.pages||{}).length||keepCompleted&&job.status==='failed'))continue;
   let sourceBound=false;try{const source=this.rawSource(job.customer,job.mediaId),c=this.caseFor(job.customer),state=this.data().cases[job.customer];if(!source||source.checksum!==job.sourceSha256||!c||job.caseId!==c.id||job.caseSignature!==visaCaseSignature(c)||!state||state.caseId!==c.id||job.generation!==state.generation)continue;sourceBound=true;const pages=Object.values(job.pages||{});if(pages.some(page=>{const valid=validateDocumentExtraction(page.extraction);return !keepCompleted&&valid.readable!==true&&valid.kind!=='other';}))continue;
    // Older page checkpoints omitted the immutable raw-source binding already
    // established by their ready job. Retain that exact known binding only;
    // never repair an existing digest, page reference, extraction or image hash.
    if(job.status==='ready'&&SHA.test(job.sourceSha256||''))for(const [key,page]of Object.entries(job.pages||{})){
     if(page&&typeof page==='object'&&!Array.isArray(page)&&!Object.hasOwn(page,'sourceSha256')&&page.mediaId===job.mediaId&&Number.isInteger(page.page)&&page.page>=1&&page.page<=10&&String(page.page)===key&&SHA.test(page.sha256||''))page.sourceSha256=job.sourceSha256;
     if(page&&page.mediaId===job.mediaId&&Number.isInteger(page.page)&&page.page>=1&&page.page<=10&&String(page.page)===key&&SHA.test(page.sha256||'')&&page.sourceSha256===job.sourceSha256&&page.extraction?.kind==='uae_id_back'&&page.extraction.readable===true&&!checkedMrz(page.extraction.mrzLines,this.now(),'TD1')&&this.localTd1Capable()){page.mrzFocusPending=true;job.mrzFocusOnly=true;}
    }
    if(job.mrzFocusOnly&&job.status==='ready'&&Object.values(job.pages||{}).some(page=>page.mrzFocusPending))job.status='queued';
    job.policy=this.policyFingerprint;changed=true;}catch(error){if(keepCompleted&&sourceBound){job.policy=this.policyFingerprint;job.status='failed';job.pages={};job.issues=[failureReason(error)];changed=true;}}
  }
  for(const [customer,state]of Object.entries(this.data().cases))if(state.policy!==this.policyFingerprint)affected.add(customer);
  for(const job of Object.values(this.data().jobs)){
   if(job.policy===this.policyFingerprint)continue;
   const dirty=job.status!=='stale'||Object.keys(job.pages||{}).length||Object.keys(job.pageAttempts||{}).length||job.activePage!==undefined||job.nextAttemptAt!==undefined||(job.issues||[]).length;
   if(!dirty)continue;job.status='stale';job.pages={};job.pageAttempts={};job.issues=[];delete job.activePage;delete job.nextAttemptAt;job.updatedAt=this.now();changed=true;
   const state=this.data().cases[job.customer];if(state&&state.caseId===job.caseId)affected.add(job.customer);
  }
  for(const customer of affected){const state=this.data().cases[customer];state.policy=this.policyFingerprint;state.generation=Number.isSafeInteger(state.generation)&&state.generation>0?state.generation+1:1;state.status='processing';state.documents=[];state.applicants=[];state.issues=[];delete state.inputFingerprint;delete state.resultFingerprint;delete state.awaitingPayment;state.updatedAt=this.now();changed=true;
   for(const job of Object.values(this.data().jobs))if(job.customer===customer&&job.caseId===state.caseId&&job.policy===this.policyFingerprint){job.generation=state.generation;job.caseSignature=state.caseSignature;}
  }
  return changed;
 }
 recover(){const hasChanges=Object.values(this.data().cases).some(state=>state.policy!==this.policyFingerprint)||Object.values(this.data().jobs).some(job=>job.status==='running'||job.policy!==this.policyFingerprint&&(job.status!=='stale'||Object.keys(job.pages||{}).length||Object.keys(job.pageAttempts||{}).length||job.activePage!==undefined||job.nextAttemptAt!==undefined||(job.issues||[]).length));if(!hasChanges)return;
  this.commit(()=>{this.retirePolicies();for(const job of Object.values(this.data().jobs)){if(job.status!=='running'||job.policy!==this.policyFingerprint)continue;if(job.activePage&&!job.pages?.[job.activePage]){job.status='failed';job.issues=[reason('DOCUMENT_OCR_INTERRUPTED')];}else job.status='queued';job.updatedAt=this.now();}});
 }
 start(){if(this.started)return;this.started=true;this.stopped=false;this.epoch++;this.recover();this.unsubscribe=this.lock.onRelease?.(()=>this.wake());this.timer=setInterval(()=>this.wake(true),2000);this.timer.unref?.();this.wake(true);}
 stop(){this.started=false;this.stopped=true;this.epoch++;clearInterval(this.timer);this.timer=null;this.unsubscribe?.();this.unsubscribe=null;}
 wake(force=false){if(!force&&!this.available())return;if(!force&&!Object.values(this.data().jobs).some(job=>['queued','retry'].includes(job.status)&&(!job.nextAttemptAt||job.nextAttemptAt<=this.now())))return;if(!this.started||!this.enabled()||this.scheduled||this.busy)return;this.scheduled=true;const handle=setImmediate(()=>{this.scheduled=false;if(!this.started)return;this.tick().catch(()=>{});});handle.unref?.();}
 caseFor(customer){const c=this.store.data.visaCases?.[customer];return c&&typeof c.id==='string'&&Number.isFinite(c.createdAt)?c:null;}
 knownReceipt(customer,id){const receipts=this.store.data.visaFulfilment?.cases?.[customer]?.receipts;return Boolean(receipts&&Object.hasOwn(receipts,id));}
 rawSource(customer,id){if(this.knownReceipt(customer,id))return null;const raw=this.mediaStore.records?.[id]||this.store.data.visaMedia?.[id];return raw&&raw.customer===customer&&raw.expiresAt>this.now()&&originals(raw)?raw:null;}
 blockReason(customer){
  try{const blocked=this.fulfilment?.blocked?.(customer);if(blocked)return String(blocked);}catch{return 'CASE_UNAVAILABLE';}
  const c=this.caseFor(customer),journal=this.store.data.conversationJournal?.customers?.[customer];
  if(!c)return 'CASE_UNAVAILABLE';if(journal?.blocked||journal?.whatsappBlocked||['pending','uncertain'].includes(journal?.whatsappBlockState)||this.inbox?.isBlocked?.(customer))return 'CUSTOMER_BLOCKED';
  if(journal?.operatorOwned||this.store.data.conversations?.[customer]?.humanOwned||this.inbox?.isOperatorOwned?.(customer)||this.inbox?.isHumanOwned?.(customer))return 'HUMAN_OWNERSHIP';
  if(journal?.complaintPending||c.stage==='complaint_pending'||(this.store.data.complaints||[]).some(item=>item.customer===customer&&['pending','claimed'].includes(item.state)))return 'COMPLAINT_ACTIVE';
  if(c.pendingAmendment&&!['applied','rejected','cancelled','resolved'].includes(c.pendingAmendment.state)||c.submissionStatus==='submitted'||c.staffVerification?.decision)return 'CASE_REVIEW_REQUIRED';return null;
 }
 syncCase(customer){
  const c=this.caseFor(customer);if(!c)return null;const signature=visaCaseSignature(c);let state=this.data().cases[customer];
  if(!state||state.caseId!==c.id){const generation=(state?.generation||0)+1;state={caseId:c.id,caseSignature:signature,policy:this.policyFingerprint,generation,status:'processing',documents:[],applicants:[],issues:[],createdAt:this.now(),updatedAt:this.now()};this.data().cases[customer]=state;for(const job of Object.values(this.data().jobs))if(job.customer===customer&&job.caseId&&job.caseId!==c.id){job.status='stale';job.pages={};job.updatedAt=this.now();}}
  else if(state.caseSignature!==signature||state.policy!==this.policyFingerprint){state.caseSignature=signature;state.policy=this.policyFingerprint;state.generation++;state.status='processing';state.applicants=[];state.updatedAt=this.now();for(const job of Object.values(this.data().jobs))if(job.customer===customer&&job.caseId===c.id){if(job.policy!==this.policyFingerprint){job.status='stale';job.pages={};continue;}job.caseSignature=signature;job.generation=state.generation;if(job.status==='running'&&job.activePage&&!job.pages?.[job.activePage]){job.status='failed';job.issues=[reason('DOCUMENT_OCR_INTERRUPTED')];}else if(job.status==='running')job.status='queued';}}
  return state;
 }
 enqueue(customer,mediaId){
  if(!this.enabled()||!validCustomer(customer)||typeof mediaId!=='string'||!UUID.test(mediaId))return false;
  const source=this.rawSource(customer,mediaId);if(!source||!this.caseFor(customer)&&this.data().cases[customer])return false;const c=this.caseFor(customer),existing=Object.values(this.data().jobs).find(job=>job.customer===customer&&job.mediaId===mediaId&&job.policy===this.policyFingerprint&&(!c||job.caseId===c.id));if(existing)return false;
  if(c&&source.receivedAt<c.createdAt)return false;if(c&&this.data().cases[customer]?.caseId===c.id&&this.data().cases[customer].limitExceeded)return false;
  this.commit(()=>{const state=c?this.syncCase(customer):null;const count=Object.values(this.data().jobs).filter(job=>job.customer===customer&&(!c?!job.caseId:job.caseId===c.id)&&job.policy===this.policyFingerprint&&job.status!=='stale').length;if(count>=MAX_SOURCES){if(state){state.limitExceeded=true;state.status='needs_review';state.issues=[reason('DOCUMENT_SOURCE_LIMIT')];state.updatedAt=this.now();}return;}
   const id=randomUUID();this.data().jobs[id]={id,customer,mediaId,caseId:c?.id||null,caseSignature:state?.caseSignature||null,generation:state?.generation||null,pendingFirstCase:!c,policy:this.policyFingerprint,status:c?'queued':'waiting_case',pages:{},pageAttempts:{},issues:[],receivedAt:source.receivedAt,createdAt:this.now(),updatedAt:this.now()};if(state){state.status='processing';state.updatedAt=this.now();}
  });this.notify(customer);this.wake();return true;
 }
 rereadBinding(customer,{caseId,mediaId,sourceSha256,generation}={}){
  if(!validCustomer(customer)||typeof caseId!=='string'||!caseId||caseId.length>160||!UUID.test(mediaId||'')||!SHA.test(sourceSha256||'')||!Number.isSafeInteger(generation)||generation<1)throw finite('DOCUMENT_REREAD_INVALID');
  if(!this.enabled()||!this.configured()||this.stopped)throw finite('DOCUMENT_REREAD_UNAVAILABLE');
  const c=this.caseFor(customer),state=this.data().cases[customer],source=this.rawSource(customer,mediaId);
  if(!c||!state||c.id!==caseId||state.caseId!==caseId||state.policy!==this.policyFingerprint||state.caseSignature!==visaCaseSignature(c)||state.generation!==generation)throw finite('DOCUMENT_REREAD_STALE');
  if(!source||source.checksum!==sourceSha256)throw finite('DOCUMENT_REREAD_SOURCE_CHANGED');
  const job=Object.values(this.data().jobs).find(item=>item.customer===customer&&item.mediaId===mediaId&&item.caseId===caseId&&item.caseSignature===state.caseSignature&&item.generation===generation&&item.policy===this.policyFingerprint&&['ready','failed'].includes(item.status));
  if(!job||job.sourceSha256&&job.sourceSha256!==sourceSha256)throw finite('DOCUMENT_REREAD_NOT_READY');
  const key=digest({caseId,sourceSha256,policy:this.policyFingerprint});if(state.manualRereads?.[key])throw finite('DOCUMENT_REREAD_ALREADY_REQUESTED');
  if(this.busy||state.status==='processing'||Object.values(this.data().jobs).some(item=>item.customer===customer&&item.caseId===caseId&&item.policy===this.policyFingerprint&&activeStatus(item.status)))throw finite('DOCUMENT_REREAD_BUSY');
  if(this.blockReason(customer))throw finite('DOCUMENT_REREAD_PAUSED');
  return {c,state,source,job,key};
 }
 rereadSource(customer,binding){
  this.rereadBinding(customer,binding);let file;
  try{file=this.mediaStore.read(binding.mediaId,{customer});if(hash(file.bytes)!==binding.sourceSha256)throw finite('DOCUMENT_REREAD_SOURCE_CHANGED');this.rereadBinding(customer,binding);
   this.commit(()=>{const {state,key}=this.rereadBinding(customer,binding),previousGeneration=state.generation;let affectedSources=0;
    // Duplicate uploads of the exact same original must lose their checkpoints
    // together, otherwise the old extraction could silently refill this job.
    for(const job of Object.values(this.data().jobs)){
     if(job.customer!==customer||job.caseId!==binding.caseId)continue;
     const source=this.rawSource(customer,job.mediaId),sameSource=job.sourceSha256===binding.sourceSha256||source?.checksum===binding.sourceSha256;
     if(sameSource){job.pages={};job.pageAttempts={};job.issues=[];job.mrzIssues={};delete job.activePage;delete job.nextAttemptAt;delete job.mrzFocusOnly;
      if(job.policy===this.policyFingerprint&&source?.checksum===binding.sourceSha256){job.sourceSha256=binding.sourceSha256;job.status='queued';job.manualRereadKey=key;affectedSources++;}else job.status='stale';job.updatedAt=this.now();
     }
     if(job.policy===this.policyFingerprint){job.generation=previousGeneration+1;job.caseSignature=state.caseSignature;}
    }
    if(!affectedSources)throw finite('DOCUMENT_REREAD_SOURCE_CHANGED');
    state.manualRereads||={};state.manualRereads[key]={mediaId:binding.mediaId,sourceSha256:binding.sourceSha256,policy:this.policyFingerprint,requestedAt:this.now(),previousGeneration,generation:previousGeneration+1,affectedSources,pageAttempts:{}};
    state.generation=previousGeneration+1;state.status='processing';state.documents=[];state.applicants=[];state.issues=[];delete state.inputFingerprint;delete state.resultFingerprint;delete state.awaitingPayment;state.updatedAt=this.now();
   });
  }finally{file?.bytes?.fill(0);}
  this.notify(customer);this.wake();return {ok:true,queued:true,caseId:binding.caseId,mediaId:binding.mediaId,generation:this.data().cases[customer].generation};
 }
 rereadSources(customer,state){
  if(!state)return [];
  return Object.values(this.data().jobs).filter(job=>job.customer===customer&&job.caseId===state.caseId&&job.policy===this.policyFingerprint&&['ready','failed'].includes(job.status)).flatMap(job=>{const source=this.rawSource(customer,job.mediaId);if(!source||!SHA.test(source.checksum||''))return [];const binding={caseId:state.caseId,mediaId:job.mediaId,sourceSha256:source.checksum,generation:state.generation};let reason;try{this.rereadBinding(customer,binding);}catch(error){reason=/^DOCUMENT_REREAD_[A-Z_]+$/.test(error.code||'')?error.code:'DOCUMENT_REREAD_UNAVAILABLE';}const kinds=[...new Set(Object.values(job.pages||{}).map(page=>page.extraction?.kind).filter(kind=>['passport','uae_id_front','uae_id_back','portrait','other'].includes(kind)))];return [{...binding,kind:kinds[0]||'other',kinds,receivedAt:source.receivedAt,allowed:!reason,...(reason?{reason}:{})}];}).sort((a,b)=>b.receivedAt-a.receivedAt||a.mediaId.localeCompare(b.mediaId));
 }
 backfill(){if(!this.enabled())return;for(const [customer,c]of Object.entries(this.store.data.visaCases||{})){if(!validCustomer(customer)||!Number.isFinite(c.createdAt))continue;const sources=Object.values(this.mediaStore.records||this.store.data.visaMedia||{}).filter(r=>r.customer===customer&&!this.knownReceipt(customer,r.id)&&originals(r)&&r.expiresAt>this.now()&&r.receivedAt>=c.createdAt).sort((a,b)=>a.receivedAt-b.receivedAt||a.id.localeCompare(b.id)).slice(0,MAX_SOURCES+1);for(const source of sources)this.enqueue(customer,source.id);}}
 bindWaiting(){for(const job of Object.values(this.data().jobs)){if(job.status!=='waiting_case'||job.policy!==this.policyFingerprint)continue;const c=this.caseFor(job.customer);if(!c)continue;const source=this.rawSource(job.customer,job.mediaId);if(!source){job.status='failed';job.issues=[reason('DOCUMENT_SOURCE_UNAVAILABLE')];continue;}const state=this.syncCase(job.customer);job.caseId=c.id;job.caseSignature=state.caseSignature;job.generation=state.generation;job.status='queued';job.updatedAt=this.now();state.status='processing';}}
 snapshot(job){return {id:job.id,customer:job.customer,mediaId:job.mediaId,caseId:job.caseId,signature:job.caseSignature,generation:job.generation,epoch:this.epoch,mediaEpoch:this.mediaStore.epochs?.get(job.customer)||0,policy:job.policy,sourceSha256:job.sourceSha256};}
 guard(snapshot){
  if(this.stopped||this.epoch!==snapshot.epoch||!this.enabled()||(this.mediaStore.epochs?.get(snapshot.customer)||0)!==snapshot.mediaEpoch)throw finite('DOCUMENT_INTAKE_STALE');
  const job=this.data().jobs[snapshot.id],state=this.data().cases[snapshot.customer],c=this.caseFor(snapshot.customer),source=this.rawSource(snapshot.customer,snapshot.mediaId);
  if(!job||!state||!c||!source||job.caseId!==snapshot.caseId||c.id!==snapshot.caseId||state.generation!==snapshot.generation||job.generation!==snapshot.generation||state.caseSignature!==snapshot.signature||visaCaseSignature(c)!==snapshot.signature||job.policy!==snapshot.policy||job.policy!==this.policyFingerprint||state.policy!==this.policyFingerprint||snapshot.sourceSha256&&source.checksum&&source.checksum!==snapshot.sourceSha256)throw finite('DOCUMENT_INTAKE_STALE');if((job.manualRereadKey||job.mrzFocusOnly)&&this.blockReason(snapshot.customer))throw finite('DOCUMENT_REREAD_PAUSED');return {job,state,c,source};
 }
 sourceBytes(snapshot){this.guard(snapshot);const file=this.mediaStore.read(snapshot.mediaId,{customer:snapshot.customer});const actual=hash(file.bytes);if(snapshot.sourceSha256&&actual!==snapshot.sourceSha256){file.bytes.fill(0);throw finite('DOCUMENT_INTAKE_STALE');}const source=this.rawSource(snapshot.customer,snapshot.mediaId);if(source?.checksum&&actual!==source.checksum){file.bytes.fill(0);throw finite('DOCUMENT_INTAKE_STALE');}return {...file,sha256:actual};}
 async pageBytes(file,page,guard){
  if(file.metadata.mimeType!=='application/pdf'){if(page!==1)throw finite('DOCUMENT_NO_PAGE');return {bytes:Buffer.from(file.bytes),mimeType:file.metadata.mimeType};}
  const parts=await this.rasterize(file.bytes,{kind:'passport',page});guard();if(!Array.isArray(parts)||parts.length!==1||!Buffer.isBuffer(parts[0].bytes)||!['image/png','image/jpeg'].includes(parts[0].mimeType))throw finite('DOCUMENT_PDF_INVALID');return parts[0];
 }
 pageCount(customer,caseId){return Object.values(this.data().jobs).filter(job=>job.customer===customer&&job.caseId===caseId&&job.policy===this.policyFingerprint&&job.status!=='stale').reduce((sum,job)=>sum+Object.keys(job.pages||{}).length,0);}
 async focusedMrzCrop(image,extraction,guard){
  let corrected,cropped;try{corrected=await sharp(image.bytes,{failOn:'warning',limitInputPixels:20000000,sequentialRead:true}).autoOrient().rotate(extraction.rotation).png().toBuffer();guard();const meta=await sharp(corrected).metadata();guard();const top=Math.floor(meta.height*0.55),height=meta.height-top,width=meta.width,scale=Math.min(1,4096/width,4096/height,Math.sqrt(MAX_MRZ_IMAGE_PIXELS/(width*height)));let pipeline=sharp(corrected,{limitInputPixels:20000000}).extract({left:0,top,width,height});if(scale<1)pipeline=pipeline.resize({width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale)),fit:'inside',withoutEnlargement:true});cropped=await pipeline.png().toBuffer();guard();if(cropped.length>MAX_MRZ_IMAGE_BYTES){const small=await sharp(cropped).jpeg({quality:90,chromaSubsampling:'4:4:4'}).toBuffer();cropped.fill(0);cropped=small;guard();if(cropped.length>MAX_MRZ_IMAGE_BYTES)throw finite('MRZ_VISION_INVALID_IMAGE');return {bytes:cropped,mimeType:'image/jpeg'};}return {bytes:cropped,mimeType:'image/png'};}catch(error){cropped?.fill(0);throw error;}finally{corrected?.fill(0);}
 }
 async focusMrzPage(snap,page,image){
  const guard=()=>this.guard(snap);guard();let job=this.data().jobs[snap.id],checkpoint=job.pages[page];const format=checkpoint?.extraction?.kind==='passport'?'TD3':checkpoint?.extraction?.kind==='uae_id_back'?'TD1':null;if(!this.mrzVision?.extract||!format)return false;
  const scope={sourceSha256:snap.sourceSha256,page,format,policy:this.policyFingerprint,mrzPolicy:SHA.test(this.mrzVision.policyFingerprint||'')?this.mrzVision.policyFingerprint:MRZ_POLICY_FINGERPRINT,rereadKey:job.mrzFocusOnly?null:job.manualRereadKey||null},key=digest(scope),state=this.data().cases[snap.customer],record=state.mrzFocusReads?.[key],primaryValid=checkedMrz(checkpoint.extraction.mrzLines,this.now(),format);
  const priorChecked=Object.values(state.mrzFocusReads||{}).filter(item=>item.sourceSha256===scope.sourceSha256&&item.page===page&&item.format===format&&item.policy===scope.policy&&item.mrzPolicy===scope.mrzPolicy&&item.status==='ready'&&checkedMrz(item.mrzLines,this.now(),format));
  const finish=(result,issue)=>this.commit(()=>{guard();const current=this.data().jobs[snap.id],saved=current.pages[page];if(result&&!checkedMrz(saved.extraction.mrzLines,this.now(),format))saved.extraction=validateDocumentExtraction({...saved.extraction,mrzLines:result.mrzLines});delete saved.mrzFocusPending;saved.mrzFocusStatus=issue?'needs_review':result?'checked':'original_checked';current.mrzIssues||={};if(issue){current.mrzIssues[page]=clone(issue);saved.mrzIssue=clone(issue);}else{delete current.mrzIssues[page];delete saved.mrzIssue;}});
  if(primaryValid){const conflict=priorChecked.some(item=>JSON.stringify(item.mrzLines)!==JSON.stringify(checkpoint.extraction.mrzLines));finish(null,conflict?mrzReason('SOURCE_CONFLICT'):null);return false;}
  if(record&&record.status!=='waiting'){
   if(record.status==='ready'&&checkedMrz(record.mrzLines,this.now(),format)){const conflict=priorChecked.some(item=>JSON.stringify(item.mrzLines)!==JSON.stringify(record.mrzLines));finish(conflict?null:{mrzLines:record.mrzLines},conflict?mrzReason('SOURCE_CONFLICT'):null);}
   else {const issue=record.status==='running'?mrzReason('DOCUMENT_MRZ_INTERRUPTED'):record.issue||mrzReason('DOCUMENT_MRZ_READ_FAILED');this.commit(()=>{guard();const current=this.data().cases[snap.customer].mrzFocusReads[key];current.status='failed';current.issue=clone(issue);});finish(null,issue);}return false;
  }
  const defer=()=>{this.commit(()=>{guard();const current=this.data().jobs[snap.id];current.status='retry';current.nextAttemptAt=this.now()+Math.max(2000,Math.min(300000,Number(this.mrzVision.status?.()?.retryAfterMs||this.vision.status?.()?.retryAfterMs)||2000));});return true;};
  const readerReady=()=>{if(this.mrzVision.status?.()?.configured===false)throw finite('MRZ_OPTICAL_MODEL_UNAVAILABLE');return (this.mrzVision.ready?.()??this.vision.ready?.())===true;};
  let crop;try{if(format==='TD1'&&!this.localTd1Capable())throw finite('MRZ_OPTICAL_ENGINE_UNAVAILABLE');if(!readerReady())return defer();crop=await this.focusedMrzCrop(image,checkpoint.extraction,guard);guard();if(!readerReady())return defer();
   this.commit(()=>{guard();const current=this.data().cases[snap.customer];current.mrzFocusReads||={};current.mrzFocusReads[key]={...scope,status:'running',cropSha256:hash(crop.bytes),startedAt:this.now()};});
   const output=await this.mrzVision.extract({bytes:crop.bytes,mimeType:crop.mimeType,guard,format});guard();
   if(!output||output.version!==1||!Array.isArray(output.mrzLines)||Object.keys(output).some(name=>!['version','mrzLines','checks'].includes(name)))throw finite('MRZ_VISION_INVALID_OUTPUT');
   const checks=format==='TD1'?['documentNumber','birthDate','expiryDate','composite']:['documentNumber','birthDate','expiryDate','optionalData','composite'],valid=checkedMrz(output.mrzLines,this.now(),format);if(output.mrzLines.length&&(!valid||output.checks&&checks.some(name=>output.checks[name]!==true)))throw finite('MRZ_VISION_CHECKS_FAILED');const conflict=valid&&priorChecked.some(item=>JSON.stringify(item.mrzLines)!==JSON.stringify(output.mrzLines)),issue=conflict?mrzReason('SOURCE_CONFLICT'):valid?null:mrzReason('DOCUMENT_MRZ_UNREADABLE');
   this.commit(()=>{guard();const current=this.data().cases[snap.customer].mrzFocusReads[key];current.status=valid?'ready':'unreadable';if(valid)current.mrzLines=[...output.mrzLines];if(issue)current.issue=clone(issue);current.completedAt=this.now();});finish(valid&&!conflict?output:null,issue);return false;
  }catch(error){guard();if(['DOCUMENT_VISION_BUSY','DOCUMENT_VISION_COOLDOWN'].includes(error?.code)){this.commit(()=>{guard();const current=this.data().cases[snap.customer];current.mrzFocusReads||={};current.mrzFocusReads[key]={...scope,status:'waiting'};});return defer();}const issue=mrzReason('DOCUMENT_MRZ_READ_FAILED',error?.code);this.commit(()=>{guard();const current=this.data().cases[snap.customer];current.mrzFocusReads||={};current.mrzFocusReads[key]={...scope,status:'failed',issue:clone(issue),completedAt:this.now()};});finish(null,issue);return false;
  }finally{crop?.bytes?.fill(0);}
 }
 async process(job){
  let snap=this.snapshot(job),file,failedPage;
  try{
   file=this.sourceBytes(snap);snap.sourceSha256=file.sha256;
   this.commit(()=>{this.guard(snap);job=this.data().jobs[snap.id];job.sourceSha256=file.sha256;job.status='running';job.updatedAt=this.now();});
   // Exact duplicate bytes in this case reuse completed checkpoints. No provider
   // request is repeated merely because WhatsApp assigned another media UUID.
   const duplicate=!job.mrzFocusOnly&&Object.values(this.data().jobs).find(other=>other.id!==job.id&&other.customer===job.customer&&other.caseId===job.caseId&&other.policy===job.policy&&other.sourceSha256===file.sha256&&other.status==='ready');
   if(duplicate){if(this.pageCount(job.customer,job.caseId)-Object.keys(job.pages||{}).length+Object.keys(duplicate.pages).length>MAX_TOTAL_PAGES)throw finite('DOCUMENT_PAGE_LIMIT');this.commit(()=>{this.guard(snap);job=this.data().jobs[snap.id];job.pages=Object.fromEntries(Object.entries(duplicate.pages).map(([page,value])=>[page,{...clone(value),mediaId:job.mediaId}]));job.status='ready';job.updatedAt=this.now();});return;}
   for(let page=1;page<=10;page++){
    this.guard(snap);job=this.data().jobs[snap.id];if(job.mrzFocusOnly&&!job.pages[page]||job.pages[page]&&!job.pages[page].mrzFocusPending)continue;failedPage=page;
    let image,normalized;try{image=await this.pageBytes(file,page,()=>this.guard(snap));this.guard(snap);}catch(error){if(page>1&&error?.code==='PDF_INVALID')break;if(page>1&&error?.code==='DOCUMENT_NO_PAGE')break;throw error;}
    try{
     if(job.pages[page]?.mrzFocusPending){if(await this.focusMrzPage(snap,page,image))return;continue;}
     if(this.pageCount(job.customer,job.caseId)>=MAX_TOTAL_PAGES)throw finite('DOCUMENT_PAGE_LIMIT');normalized=await this.prepare(image.bytes,{mimeType:image.mimeType,kind:'portrait'});this.guard(snap);const pageSha=hash(normalized.bytes);
     const cached=Object.values(this.data().jobs).flatMap(other=>other.customer===job.customer&&other.caseId===job.caseId&&other.policy===job.policy?Object.values(other.pages||{}):[]).find(result=>result.sourceSha256===file.sha256&&result.page===page&&result.sha256===pageSha);
     if(cached){this.commit(()=>{this.guard(snap);this.data().jobs[snap.id].pages[page]={...clone(cached),mediaId:snap.mediaId};});if(cached.mrzFocusPending&&await this.focusMrzPage(snap,page,image))return;continue;}
     const manual=job.manualRereadKey&&this.data().cases[job.customer].manualRereads?.[job.manualRereadKey],attempts=manual?.policy===job.policy?manual.pageAttempts?.[page]||0:job.pageAttempts[page]||0;if(attempts>=MAX_ATTEMPTS||manual?.policy===job.policy&&manual.pageFailures?.[page]?.terminal)throw finite('DOCUMENT_OCR_RETRY_LIMIT');
     this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];current.activePage=page;current.pageAttempts[page]=attempts+1;const shared=current.manualRereadKey&&this.data().cases[current.customer].manualRereads?.[current.manualRereadKey];if(shared?.policy===current.policy){shared.pageAttempts||={};shared.pageAttempts[page]=attempts+1;}current.updatedAt=this.now();});
     const extraction=validateDocumentExtraction(await this.vision.extract({bytes:normalized.bytes,mimeType:normalized.mimeType,guard:()=>this.guard(snap)}));this.guard(snap);
     this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];current.pages[page]={mediaId:snap.mediaId,page,sha256:pageSha,sourceSha256:file.sha256,extraction,...(this.mrzVision?.extract&&(focusedPassportPage(extraction)||extraction.kind==='uae_id_back'&&extraction.readable===true&&this.localTd1Capable())?{mrzFocusPending:true}:{})};const shared=current.manualRereadKey&&this.data().cases[current.customer].manualRereads?.[current.manualRereadKey];if(shared?.policy===current.policy&&shared.pageFailures)delete shared.pageFailures[page];delete current.activePage;current.updatedAt=this.now();});
     if(this.data().jobs[snap.id].pages[page].mrzFocusPending&&await this.focusMrzPage(snap,page,image))return;
    }finally{if(normalized?.bytes&&normalized.bytes!==image?.bytes)normalized.bytes.fill(0);image?.bytes?.fill(0);}
   }
   this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];if(!Object.keys(current.pages).length)throw finite('DOCUMENT_READ_FAILED');current.status='ready';current.issues=[];delete current.activePage;delete current.nextAttemptAt;current.updatedAt=this.now();});
  }catch(error){
   if(error?.code==='DOCUMENT_REREAD_PAUSED'){
    const current=this.data().jobs[snap.id],state=this.data().cases[snap.customer],c=this.caseFor(snap.customer);
    if(!this.stopped&&this.epoch===snap.epoch&&(current?.manualRereadKey||current?.mrzFocusOnly)&&current.caseId===snap.caseId&&c?.id===snap.caseId&&state?.generation===snap.generation&&state.caseSignature===snap.signature&&visaCaseSignature(c)===snap.signature){try{this.commit(()=>{const paused=this.data().jobs[snap.id];if(paused.mrzFocusOnly){paused.status='ready';for(const page of Object.values(paused.pages||{}))if(page.mrzFocusPending){delete page.mrzFocusPending;page.mrzIssue=reason('DOCUMENT_APPLY_PAUSED','mrzLines');}}else{paused.status='failed';paused.pages={};}paused.issues=[reason('DOCUMENT_APPLY_PAUSED')];delete paused.activePage;delete paused.nextAttemptAt;paused.updatedAt=this.now();});}catch{}}return;
   }
   try{this.guard(snap);this.commit(()=>{const current=this.data().jobs[snap.id],shared=current.manualRereadKey&&this.data().cases[current.customer].manualRereads?.[current.manualRereadKey],manual=shared?.policy===current.policy,attempts=manual?shared.pageAttempts?.[failedPage]||0:current.pageAttempts[current.activePage]||0;
    const outputRetry=manual&&MANUAL_OUTPUT_RETRY_CODES.has(error?.code),transportRetry=error?.retryable===true&&RETRYABLE_CODES.includes(error?.code)&&(!manual||error.code!=='DOCUMENT_VISION_PROVIDER_UNAVAILABLE'),retryable=(outputRetry||transportRetry)&&attempts<MAX_ATTEMPTS;
    const inherited=manual&&error?.code==='DOCUMENT_OCR_RETRY_LIMIT'&&shared.pageFailures?.[failedPage]?.issue;
    const eid=error?.code==='DOCUMENT_VISION_SCHEMA_INVALID'&&error.schemaSection==='fields'&&error.fieldName==='emiratesId'&&error.schemaIssue==='value_format';
    const issue=inherited?clone(inherited):failureReason(error,eid?'DOCUMENT_FIELD_INVALID':retryable&&!outputRetry?'DOCUMENT_PROVIDER_UNAVAILABLE':error?.code==='DOCUMENT_PAGE_LIMIT'?'DOCUMENT_PAGE_LIMIT':error?.code==='PDF_PAGE_COUNT_UNSUPPORTED'?'DOCUMENT_PDF_UNSUPPORTED':error?.code==='DOCUMENT_INTAKE_STALE'?'DOCUMENT_SOURCE_CHANGED':'DOCUMENT_READ_FAILED',eid?'emiratesId':'documents');
    if(retryable){current.status='retry';current.nextAttemptAt=this.now()+Math.max(5000,Math.min(300000,Number(error.retryAfterMs)||5000));}else{current.status='failed';delete current.nextAttemptAt;}current.issues=[issue];
    if(manual&&Number.isSafeInteger(failedPage)&&failedPage>=1&&failedPage<=10){shared.pageFailures||={};shared.pageFailures[failedPage]={issue:clone(issue),terminal:!retryable};}current.updatedAt=this.now();});}catch{}
  }finally{file?.bytes?.fill(0);}
 }
 async loadReference(customer,ref,guard){
  guard();const job=Object.values(this.data().jobs).find(item=>item.customer===customer&&item.policy===this.policyFingerprint&&item.mediaId===ref.mediaId&&item.pages?.[ref.page]?.sha256===ref.sha256&&item.status==='ready');if(!job)throw finite('DOCUMENT_SOURCE_UNAVAILABLE');
  const snap=this.snapshot(job);let file,image,normalized;try{file=this.sourceBytes(snap);image=await this.pageBytes(file,ref.page,()=>{guard();this.guard(snap);});guard();normalized=await this.prepare(image.bytes,{mimeType:image.mimeType,kind:'portrait'});guard();this.guard(snap);if(hash(normalized.bytes)!==ref.sha256)throw finite('DOCUMENT_SOURCE_CHANGED');const extraction=job.pages[ref.page].extraction;return {bytes:Buffer.from(image.bytes),mimeType:image.mimeType,extraction,sourceId:ref.mediaId};}finally{if(normalized?.bytes&&normalized.bytes!==image?.bytes)normalized.bytes.fill(0);image?.bytes?.fill(0);file?.bytes?.fill(0);}
 }
 async rotateImage(image){const rotation=image.extraction.rotation;if(!rotation)return {bytes:image.bytes,mimeType:image.mimeType};const bytes=await sharp(image.bytes,{failOn:'warning',limitInputPixels:20000000,sequentialRead:true}).autoOrient().rotate(rotation).flatten({background:'#ffffff'}).toColourspace('srgb').png().toBuffer();return {bytes,mimeType:'image/png'};}
 async portraitCrop(image){
  const box=image.extraction.portraitBox;if(!box||box.confidence<0.98||!['x','y','width','height','confidence'].every(key=>Number.isFinite(box[key]))||box.x<0||box.y<0||box.width<=0||box.height<=0||box.x+box.width>1||box.y+box.height>1||box.width*box.height>=0.5)throw finite('DOCUMENT_PORTRAIT_REQUIRED');
  const meta=await sharp(image.bytes,{failOn:'warning',limitInputPixels:20000000}).metadata();const swap=meta.orientation>=5&&meta.orientation<=8,width=swap?meta.height:meta.width,height=swap?meta.width:meta.height;
  const left=Math.floor(box.x*width),top=Math.floor(box.y*height),right=Math.ceil((box.x+box.width)*width),bottom=Math.ceil((box.y+box.height)*height);if(right-left<300||bottom-top<300||right>width||bottom>height)throw finite('DOCUMENT_PORTRAIT_REQUIRED');
  const bytes=await sharp(image.bytes,{failOn:'warning',limitInputPixels:20000000,sequentialRead:true}).autoOrient().extract({left,top,width:right-left,height:bottom-top}).rotate(image.extraction.rotation).flatten({background:'#ffffff'}).toColourspace('srgb').png().toBuffer();return {bytes,mimeType:'image/png'};
 }
 storedPrepared(customer,kind,prepared,sourceIds,guard){
  guard();if(!Buffer.isBuffer(prepared?.bytes)||!prepared.bytes.length||prepared.bytes.length>1000000||!['image/jpeg','image/png'].includes(prepared.mimeType))throw finite('DOCUMENT_IMAGE_UNSUITABLE');
  const saved=this.mediaStore.storeDerived(customer,{sourceIds:[...new Set(sourceIds)],bytes:prepared.bytes,mimeType:prepared.mimeType,kind});guard();if(!UUID.test(saved?.id||''))throw finite('DOCUMENT_IMAGE_UNSUITABLE');const file=this.mediaStore.read(saved.id,{customer});try{const raw=this.mediaStore.records?.[saved.id]||this.store.data.visaMedia?.[saved.id],sha256=hash(file.bytes);if(file.bytes.length>1000000||raw?.purpose!=='raad_portal_upload'||raw.kind!==kind||raw.customer!==customer||raw.checksum!==sha256||sha256!==hash(prepared.bytes))throw finite('DOCUMENT_IMAGE_UNSUITABLE');return {kind,mediaId:saved.id,sha256};}finally{file.bytes.fill(0);}
 }
 async prepareDossier(customer,matched,guard){
  const preparedManifest=[],documents={passport:null,residence:null,photo:null};let passport,passportParts=[],residence=[],photo,rotated,result;
  try{
   if(!matched.documents.passport||!Array.isArray(matched.documents.residence)||!matched.documents.residence.length||matched.documents.residence.length>2)throw finite('DOCUMENT_SOURCE_UNAVAILABLE');
   const passportRefs=matched.documents.passportParts||[matched.documents.passport];
   if(!Array.isArray(passportRefs)||passportRefs.length<1||passportRefs.length>2||!passportRefs.some(ref=>ref.mediaId===matched.documents.passport.mediaId&&ref.page===matched.documents.passport.page&&ref.sha256===matched.documents.passport.sha256))throw finite('DOCUMENT_SOURCE_UNAVAILABLE');
   for(const ref of passportRefs){const image=await this.loadReference(customer,ref,guard);guard();const corrected=await this.rotateImage(image);guard();passportParts.push({image,corrected});if(ref.mediaId===matched.documents.passport.mediaId&&ref.page===matched.documents.passport.page)passport=image;}
   result=passportParts.length===1?await this.prepare(passportParts[0].corrected.bytes,{mimeType:passportParts[0].corrected.mimeType,kind:'document'}):await this.prepareDocument(passportParts.map(item=>({bytes:item.corrected.bytes,mimeType:item.corrected.mimeType})),{kind:'passport'});guard();let prepared=this.storedPrepared(customer,'passport',result,passportParts.map(part=>part.image.sourceId),guard);preparedManifest.push(prepared);documents.passport=prepared.mediaId;result.bytes.fill(0);result=null;
   for(const ref of matched.documents.residence){const image=await this.loadReference(customer,ref,guard);guard();const corrected=await this.rotateImage(image);guard();residence.push({image,corrected});}
   result=await this.prepareResidence(residence.map(item=>({bytes:item.corrected.bytes,mimeType:item.corrected.mimeType})));guard();prepared=this.storedPrepared(customer,'residence',result,residence.map(item=>item.image.sourceId),guard);preparedManifest.push(prepared);documents.residence=prepared.mediaId;result.bytes.fill(0);result=null;
   if(matched.documents.photo){photo=await this.loadReference(customer,matched.documents.photo,guard);guard();rotated=await this.rotateImage(photo);}else{photo=[...passportParts,...residence].map(part=>part.image).find(image=>image.extraction?.portraitBox?.confidence>=0.98)||passport;rotated=await this.portraitCrop(photo);}guard();
   result=await this.prepare(rotated.bytes,{mimeType:rotated.mimeType,kind:'portrait'});guard();prepared=this.storedPrepared(customer,'photo',result,[photo.sourceId],guard);preparedManifest.push(prepared);documents.photo=prepared.mediaId;return {documents,preparedManifest};
  }finally{if(result?.bytes)result.bytes.fill(0);if(rotated?.bytes&&rotated.bytes!==photo?.bytes)rotated.bytes.fill(0);if(photo&&![...passportParts,...residence].some(part=>part.image===photo))photo.bytes.fill(0);for(const part of [...passportParts,...residence]){if(part.corrected.bytes!==part.image.bytes)part.corrected.bytes.fill(0);part.image.bytes.fill(0);}}
 }
 currentCaseGuard(customer,caseId,signature,generation,epoch){
  if(this.stopped||this.epoch!==epoch||!this.enabled())throw finite('DOCUMENT_INTAKE_STALE');const c=this.caseFor(customer),state=this.data().cases[customer];if(!c||!state||state.policy!==this.policyFingerprint||c.id!==caseId||visaCaseSignature(c)!==signature||state.caseSignature!==signature||state.generation!==generation)throw finite('DOCUMENT_INTAKE_STALE');
  for(const job of Object.values(this.data().jobs))if(job.customer===customer&&job.caseId===caseId&&job.status==='ready'){const source=this.rawSource(customer,job.mediaId);if(!source||source.checksum&&source.checksum!==job.sourceSha256)throw finite('DOCUMENT_INTAKE_STALE');}
  return {c,state};
 }
 parentFingerprint(c){return digest({paymentStatus:c.paymentStatus,submissionStatus:c.submissionStatus,verification:c.staffVerification||{},amendment:c.pendingAmendment||null});}
 async reconcileCase(customer,{force=false}={}){
  let state=this.data().cases[customer],c=this.caseFor(customer);if(!state||!c||state.caseId!==c.id)return false;if(state.policy!==this.policyFingerprint||Object.values(this.data().jobs).some(job=>job.customer===customer&&job.caseId===c.id&&job.policy!==this.policyFingerprint&&job.status!=='stale')){this.commit(()=>this.retirePolicies());state=this.data().cases[customer];}const signature=state.caseSignature,generation=state.generation,epoch=this.epoch;
  const guard=()=>this.currentCaseGuard(customer,c.id,signature,generation,epoch);guard();
  const jobs=Object.values(this.data().jobs).filter(job=>job.customer===customer&&job.caseId===c.id&&job.caseSignature===signature&&job.generation===generation&&job.policy===this.policyFingerprint&&job.status!=='stale').sort((a,b)=>a.receivedAt-b.receivedAt||a.mediaId.localeCompare(b.mediaId));
  const documents=jobs.flatMap(job=>Object.values(job.pages||{})).sort((a,b)=>jobs.findIndex(job=>job.mediaId===a.mediaId)-jobs.findIndex(job=>job.mediaId===b.mediaId)||a.page-b.page),pending=jobs.some(job=>activeStatus(job.status)),sourceIssues=jobs.flatMap(job=>[...(job.status==='failed'?job.issues||[reason('DOCUMENT_READ_FAILED')]:[]),...Object.values(job.pages||{}).flatMap(page=>page.mrzIssue?[page.mrzIssue]:[])]);
  const blocked=this.blockReason(customer);
  const fingerprint=digest({signature,generation,preparationPolicy:PREPARATION_POLICY,documents,sourceIssues,pending,limit:state.limitExceeded===true});if(!force&&state.inputFingerprint===fingerprint)return false;
  const people=Number.isInteger(c.applicantCount)&&c.applicantCount>0&&c.applicantCount<=30?Array.from({length:c.applicantCount},(_,index)=>c.applicants?.[index]||{}):[];
  const inputChanged=state.inputFingerprint!==fingerprint,matched=this.reconcile({documents,applicants:people,referenceDate:dubaiDate(this.now())}),previous=state.applicants||[];
  this.commit(()=>{guard();state=this.data().cases[customer];state.documents=clone(documents);state.inputFingerprint=fingerprint;state.status=pending?'processing':'needs_review';state.updatedAt=this.now();state.issues=clone([...(matched.issues||[]),...sourceIssues,...(state.limitExceeded?[reason('DOCUMENT_SOURCE_LIMIT')]:[])]);});
  if(inputChanged)this.reportBindingReview(customer,c,documents,matched);
  const snapshots=[];for(const applicant of matched.applicants||[]){
   const extractionDigest=extractionDigestFor(documents,applicant),old=previous.find(item=>item.applicantIndex===applicant.applicantIndex&&item.extractionDigest===extractionDigest);
   const item={id:old?.id||randomUUID(),applicantIndex:applicant.applicantIndex,status:'needs_review',identityReady:applicant.identityReady===true||applicant.status==='ready',clientFieldsRequired:clone(applicant.clientFieldsRequired||[]),fields:clone(applicant.fields||{}),documents:{passport:null,residence:null,photo:null},sourceManifest:jobs.filter(job=>SHA.test(job.sourceSha256||'')).map(job=>({mediaId:job.mediaId,sha256:job.sourceSha256})).sort((a,b)=>a.mediaId.localeCompare(b.mediaId)),preparedManifest:[],evidence:clone(applicant.evidence),issues:clone(applicant.issues||[]),extractionDigest};
   const passportRefs=applicant.documents?.passportParts||[applicant.documents?.passport],selectedRefs=[...passportRefs,...(applicant.documents?.residence||[])];if(documents.some(document=>document.mrzIssue?.code==='SOURCE_CONFLICT'&&selectedRefs.some(ref=>ref&&ref.mediaId===document.mediaId&&ref.page===document.page&&ref.sha256===document.sha256))){item.identityReady=false;item.issues.push(mrzReason('SOURCE_CONFLICT'));}
   if(!pending&&item.identityReady&&['ready','needs_confirmation'].includes(applicant.status)){
    try{const prepared=await this.prepareDossier(customer,applicant,guard);guard();item.documents=prepared.documents;item.preparedManifest=prepared.preparedManifest;item.status=applicant.status;if(old&&digest(old.preparedManifest)!==digest(item.preparedManifest))item.id=randomUUID();}
    catch(error){guard();item.status='needs_review';item.issues.push(reason(error?.code==='DOCUMENT_PORTRAIT_REQUIRED'?'DOCUMENT_PORTRAIT_REQUIRED':'DOCUMENT_IMAGE_UNSUITABLE'));}
   }
   snapshots.push(item);
  }
  guard();this.commit(()=>{guard();state=this.data().cases[customer];state.applicants=snapshots;state.status=pending?'processing':snapshots.length&&snapshots.every(item=>['ready','needs_confirmation'].includes(item.status))&&!state.issues.length?(snapshots.some(item=>item.status==='needs_confirmation')?'needs_confirmation':'ready'):'needs_review';state.updatedAt=this.now();});
  // The verifier reads only a completed checkpoint; publishing processing=false
  // does not itself authorize any application or overwrite a human answer.
  if(!pending&&snapshots.some(item=>['ready','needs_confirmation'].includes(item.status))){
   if(!currentVisaEvidence(this.caseFor(customer)).payment){this.commit(()=>{guard();const current=this.data().cases[customer];current.awaitingPayment=true;for(const app of current.applicants)app.applied=false;});}
   else if(blocked){this.commit(()=>{guard();state=this.data().cases[customer];state.status='needs_review';state.issues.push(reason('DOCUMENT_APPLY_PAUSED'));});}
   else for(const item of snapshots.filter(item=>['ready','needs_confirmation'].includes(item.status))){
    try{state.awaitingPayment=false;
     guard();if(this.blockReason(customer))throw finite('DOCUMENT_APPLY_PAUSED');const draft=this.raad?.get?.(customer,{applicantIndex:item.applicantIndex});if(!draft||typeof this.raad?.applyMachineDossier!=='function')throw finite('DOCUMENT_APPLY_UNCONFIRMED');
     const applied=await this.raad.applyMachineDossier(customer,{applicantIndex:item.applicantIndex,expectedRevision:draft.revision,expectedCaseSignature:signature,evidenceId:item.id});guard();if(!applied||applied.evidenceId!==undefined&&applied.evidenceId!==item.id)throw finite('DOCUMENT_APPLY_UNCONFIRMED');item.applied=true;
     for(const job of Object.values(this.fulfilment?.data?.()?.jobs||{})){if(job.customer!==customer||job.caseId!==c.id||job.caseSignature!==signature||job.applicantIndex!==item.applicantIndex||job.state!=='queued')continue;guard();if(this.blockReason(customer))throw finite('DOCUMENT_APPLY_PAUSED');const staged=await this.fulfilment.stageDocumentFacts(job.id,{fields:clone(item.fields),evidenceId:item.id});guard();if(staged?.ok!==true)throw finite('DOCUMENT_APPLY_UNCONFIRMED');item.stagedJobs||={};item.stagedJobs[job.id]=item.id;}
    }catch{guard();this.commit(()=>{guard();const current=this.data().cases[customer];current.status='needs_review';current.issues.push(reason('DOCUMENT_APPLY_UNCONFIRMED'));const target=current.applicants.find(app=>app.id===item.id);if(target){target.applied=false;target.issues.push(reason('DOCUMENT_APPLY_UNCONFIRMED'));}});continue;}
   }
  }
  this.commit(()=>{guard();const current=this.data().cases[customer];current.resultFingerprint=digest({caseId:current.caseId,caseSignature:current.caseSignature,generation:current.generation,status:current.status,awaitingPayment:current.awaitingPayment===true,documents:current.documents,applicants:current.applicants.map(({applied,stagedJobs,...applicant})=>applicant),issues:current.issues});current.updatedAt=this.now();});this.notify(customer);return true;
 }
 async refresh(customer,{applicantIndex}={}){
  if(!this.enabled()||!validCustomer(customer)||this.stopped)return {readyForQuestions:false,status:this.enabled()?'needs_review':'disabled',issues:[reason('DOCUMENT_APPLY_PAUSED')]};
  if(this.busy)return {...this.summary(customer),readyForQuestions:false};
  let acquired=false,binding=null;this.busy=true;
  try{
   this.commit(()=>{this.retirePolicies();this.syncCase(customer);});const state=this.data().cases[customer];if(!state||!['ready','needs_confirmation','needs_review'].includes(state.status))return {...this.summary(customer),readyForQuestions:false};const selected=state.applicants.filter(app=>(applicantIndex===undefined||app.applicantIndex===applicantIndex)&&['ready','needs_confirmation'].includes(app.status));if(!selected.length)return {...this.summary(customer),readyForQuestions:false};
   if(this.blockReason(customer)||!this.lock.tryAcquire())return {...this.summary(customer),readyForQuestions:false};acquired=true;
   const epoch=this.epoch;binding={caseId:state.caseId,signature:state.caseSignature,generation:state.generation,epoch};const guard=()=>this.currentCaseGuard(customer,state.caseId,state.caseSignature,state.generation,epoch);guard();if(!currentVisaEvidence(this.caseFor(customer)).payment)return {...this.summary(customer),readyForQuestions:false};
   for(const item of selected){if(!['ready','needs_confirmation'].includes(item.status))return {...this.summary(customer),readyForQuestions:false};guard();if(this.blockReason(customer))throw finite('DOCUMENT_APPLY_PAUSED');const draft=this.raad.get(customer,{applicantIndex:item.applicantIndex});await this.raad.applyMachineDossier(customer,{applicantIndex:item.applicantIndex,expectedRevision:draft.revision,expectedCaseSignature:state.caseSignature,evidenceId:item.id});guard();item.applied=true;
    for(const job of Object.values(this.fulfilment?.data?.()?.jobs||{})){if(job.customer!==customer||job.caseId!==state.caseId||job.caseSignature!==state.caseSignature||job.applicantIndex!==item.applicantIndex||!['queued','ready','awaiting_answers','needs_followup','awaiting_answer_confirmation'].includes(job.state))continue;guard();if(this.blockReason(customer))throw finite('DOCUMENT_APPLY_PAUSED');const staged=await this.fulfilment.stageDocumentFacts(job.id,{fields:clone(item.fields),evidenceId:item.id});guard();if(staged?.ok!==true)throw finite('DOCUMENT_APPLY_UNCONFIRMED');item.stagedJobs||={};item.stagedJobs[job.id]=item.id;}
   }
   state.awaitingPayment=false;state.issues=state.issues.filter(item=>!['DOCUMENT_APPLY_PAUSED','DOCUMENT_APPLY_UNCONFIRMED'].includes(item.code));state.status=state.applicants.every(app=>['ready','needs_confirmation'].includes(app.status))&&!state.issues.length?(state.applicants.some(app=>app.status==='needs_confirmation')?'needs_confirmation':'ready'):'needs_review';state.resultFingerprint=digest({caseId:state.caseId,caseSignature:state.caseSignature,generation:state.generation,status:state.status,awaitingPayment:false,documents:state.documents,applicants:state.applicants.map(({applied,stagedJobs,...applicant})=>applicant),issues:state.issues});this.store.save();return {...this.summary(customer),readyForQuestions:true};
  }catch{const current=this.data()?.cases?.[customer];if(binding&&current&&current.caseId===binding.caseId&&current.caseSignature===binding.signature&&current.generation===binding.generation&&this.epoch===binding.epoch&&!this.stopped){try{this.commit(()=>{const failed=this.data().cases[customer];failed.status='needs_review';failed.issues=[...failed.issues,reason('DOCUMENT_APPLY_UNCONFIRMED')];for(const app of failed.applicants)app.applied=false;failed.updatedAt=this.now();});}catch{}}return {readyForQuestions:false,status:'needs_review',issues:[reason('DOCUMENT_APPLY_UNCONFIRMED')]};}
  finally{this.busy=false;if(acquired)this.lock.release();}
 }
 async prepareJob(job){
  if(!job||!validCustomer(job.customer))return {readyForQuestions:false,status:'needs_review',issues:[reason('DOCUMENT_APPLY_UNCONFIRMED')]};
  try{const draft=this.raad.get(job.customer,{applicantIndex:job.applicantIndex}),c=this.caseFor(job.customer);if(!this.blockReason(job.customer)&&draft?.review?.complete===true&&draft.review.invalidated!==true&&draft.caseId===c?.id&&draft.caseSignature===visaCaseSignature(c))return {readyForQuestions:true,status:'ready',source:'staff',issues:[]};}catch{}
  const result=await this.refresh(job.customer,{applicantIndex:job.applicantIndex});if(!result.readyForQuestions)return result;const current=this.fulfilment?.data?.()?.jobs?.[job.id],state=this.data().cases[job.customer],applicant=state?.applicants?.find(item=>item.applicantIndex===job.applicantIndex);
  return {...result,readyForQuestions:Boolean(current&&current.caseId===state.caseId&&current.caseSignature===state.caseSignature&&applicant?.applied&&applicant.stagedJobs?.[job.id]===applicant.id&&['ready','needs_confirmation'].includes(applicant.status))};
 }
 async tick(){
  if(this.busy||this.stopped||!this.enabled())return false;this.busy=true;let acquired=false,processed=false;
  try{
   this.commit(()=>{this.retirePolicies();for(const customer of Object.keys(this.store.data.visaCases||{}))if(validCustomer(customer))this.syncCase(customer);this.bindWaiting();for(const job of Object.values(this.data().jobs)){if(job.status==='stale'||job.status==='waiting_case')continue;if(this.knownReceipt(job.customer,job.mediaId)){job.status='stale';job.pages={};delete job.activePage;continue;}const source=this.rawSource(job.customer,job.mediaId);if(!source||job.sourceSha256&&source.checksum&&job.sourceSha256!==source.checksum){job.status='failed';job.pages={};delete job.activePage;job.issues=[reason(source?'DOCUMENT_SOURCE_CHANGED':'DOCUMENT_SOURCE_UNAVAILABLE')];}}});this.backfill();
   if(!this.lock.tryAcquire())return false;acquired=true;
   const externalAvailable=this.available(),job=Object.values(this.data().jobs).filter(item=>item.policy===this.policyFingerprint&&['queued','retry'].includes(item.status)&&(!item.nextAttemptAt||item.nextAttemptAt<=this.now())&&this.caseFor(item.customer)?.id===item.caseId&&(item.mrzFocusOnly||externalAvailable)).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))[0];
   if(job&&(job.mrzFocusOnly||this.available())){await this.process(job);processed=true;}
   for(const customer of Object.keys(this.data().cases)){try{await this.reconcileCase(customer);}catch{}}
   return Boolean(job);
  }finally{this.busy=false;if(acquired)this.lock.release();if(this.started&&processed&&Object.values(this.data().jobs).some(job=>job.status==='queued'))this.wake();}
 }
 summary(customer){
  const state=validCustomer(customer)?this.data().cases[customer]:null,waiting=!state&&Object.values(this.data().jobs).some(job=>job.customer===customer&&job.status==='waiting_case');
  return {enabled:this.enabled(),configured:this.configured(),status:!this.enabled()?'disabled':state?.status||(waiting?'waiting_case':'not_started'),...(state?{caseId:state.caseId,caseSignature:state.caseSignature,generation:state.generation,awaitingPayment:state.awaitingPayment===true,resultFingerprint:state.resultFingerprint||null,updatedAt:state.updatedAt,rereadSources:this.rereadSources(customer,state),applicants:state.applicants.map(app=>({applicantIndex:app.applicantIndex,evidenceId:app.id,status:app.status,awaitingPayment:state.awaitingPayment===true,identityReady:app.identityReady===true,clientFieldsRequired:clone(app.clientFieldsRequired||[]),fields:clone(app.fields),documents:clone(app.documents),issues:clone(app.issues||[]),evidence:clone(app.evidence)})),issues:clone(state.issues||[])}:{updatedAt:null,applicants:[],issues:waiting?[reason('DOCUMENT_WAITING_CASE')]:[]})};
 }
 status(){return {enabled:this.enabled(),configured:this.configured(),running:this.busy,cases:Object.keys(this.data().cases).length,queued:Object.values(this.data().jobs).filter(job=>activeStatus(job.status)).length};}
}
module.exports={VisaDocumentIntake,extractionDigestFor};
