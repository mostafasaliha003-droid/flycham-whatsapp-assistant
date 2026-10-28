'use strict';
const {createHash,randomUUID}=require('node:crypto');
const sharp=require('sharp');
const {validCustomer}=require('./conversation-journal');
const {visaCaseSignature,currentVisaEvidence}=require('./visa-case-signature');
const {preparePortalImage,prepareResidenceImage,prepareDocumentImage}=require('./raad-attachments');
const {rasterizePdf}=require('./raad-pdf');
const {reconcileDocumentEvidence}=require('./visa-document-matching');
const {validateDocumentExtraction,POLICY_FINGERPRINT,COMPATIBLE_PREVIOUS_POLICIES}=require('./visa-document-vision');
const sharedLock=require('./raad-preparation-lock');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;const MAX_SOURCES=20,MAX_ATTEMPTS=2,MAX_TOTAL_PAGES=100;
// Changing matching/preparation reuses the existing OCR page checkpoints.
// It must not silently send all existing originals to the provider again.
const PREPARATION_POLICY='raad-document-preparation-2026-10-28.v2';
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value===undefined?null:value;}
const digest=value=>hash(JSON.stringify(canonical(value)));
function extractionDigestFor(documents,matched){return digest({documents,applicantIndex:matched.applicantIndex,fields:matched.fields,matchedDocuments:matched.documents,evidence:matched.evidence});}
const reason=(code,field='documents')=>({code,field,message:({DOCUMENT_OCR_INTERRUPTED:'انقطعت قراءة أحد المرفقات؛ يلزم مراجعتها قبل اعتماد البيانات.',DOCUMENT_SOURCE_LIMIT:'تجاوز عدد المرفقات حد القراءة الآلية؛ يلزم مراجعة القسم.',DOCUMENT_SOURCE_CHANGED:'تغير أحد المرفقات أثناء المعالجة.',DOCUMENT_PDF_UNSUPPORTED:'ملف PDF غير مدعوم؛ الحد الأقصى عشر صفحات واضحة.',DOCUMENT_PAGE_LIMIT:'تجاوز مجموع صفحات المرفقات حد المئة صفحة؛ يلزم مراجعة القسم.',DOCUMENT_PORTRAIT_REQUIRED:'يلزم صورة شخصية واضحة أو صورة جواز تتضمن صورة شخصية قابلة للاقتصاص دون تكبير.',DOCUMENT_IMAGE_UNSUITABLE:'تعذر تجهيز صورة واضحة ضمن الحجم المطلوب.',DOCUMENT_APPLY_PAUSED:'قراءة المستندات محفوظة، لكن اعتمادها متوقف حتى انتهاء مراجعة القسم.',DOCUMENT_APPLY_UNCONFIRMED:'لم يتم تأكيد إدراج قراءة المستندات في ملف رعد.',DOCUMENT_READ_FAILED:'تعذرت قراءة المستند آلياً؛ يلزم مراجعة القسم أو إرساله بوضوح أكبر.',DOCUMENT_PROVIDER_UNAVAILABLE:'خدمة قراءة المستندات غير متاحة حالياً.',DOCUMENT_SOURCE_UNAVAILABLE:'أحد المرفقات لم يعد متاحاً.',DOCUMENT_WAITING_CASE:'بانتظار إنشاء ملف التأشيرة لربط المرفق الصحيح.'})[code]||'تحتاج المستندات إلى مراجعة قبل المتابعة.'});
const finite=code=>Object.assign(Error(code),{code});
const originals=record=>record&&!record.purpose&&(['image/jpeg','image/png','image/webp'].includes(record.mimeType)&&record.type==='image'||record.mimeType==='application/pdf'&&record.type==='document');
function dubaiDate(at){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));return ['year','month','day'].map(type=>parts.find(part=>part.type===type).value).join('-');}
const activeStatus=status=>['queued','running','retry','waiting_case'].includes(status);
class VisaDocumentIntake{
 constructor({store,mediaStore,vision,raad,fulfilment,inbox,env=process.env,now=Date.now,onUpdate=()=>{},lock=sharedLock,rasterize=rasterizePdf,prepare=preparePortalImage,prepareResidence=prepareResidenceImage,prepareDocument=prepareDocumentImage,reconcile=reconcileDocumentEvidence,policyFingerprint=POLICY_FINGERPRINT}={}){
  if(!store?.data||typeof store.save!=='function'||!mediaStore?.read||!vision?.extract)throw finite('DOCUMENT_INTAKE_CONFIGURATION_REQUIRED');
  Object.assign(this,{store,mediaStore,vision,raad,fulfilment,inbox,env,now,onUpdate,lock,rasterize,prepare,prepareResidence,prepareDocument,reconcile,policyFingerprint});
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
 retirePolicies(){
  const affected=new Set();let changed=false;
  // This compatible prompt update changes formatting/readability instructions,
  // not the allowed facts. Reuse completed legible pages after strict validation;
  // only failed or unreadable supported pages need another bounded reading.
  if(this.policyFingerprint===POLICY_FINGERPRINT)for(const job of Object.values(this.data().jobs)){
   if(!COMPATIBLE_PREVIOUS_POLICIES.includes(job.policy)||job.status!=='ready'||!Object.keys(job.pages||{}).length)continue;
   try{const source=this.rawSource(job.customer,job.mediaId);if(!source||source.checksum!==job.sourceSha256)continue;const pages=Object.values(job.pages);if(pages.some(page=>{const valid=validateDocumentExtraction(page.extraction);return valid.readable!==true&&valid.kind!=='other';}))continue;job.policy=this.policyFingerprint;changed=true;}catch{}
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
 backfill(){if(!this.enabled())return;for(const [customer,c]of Object.entries(this.store.data.visaCases||{})){if(!validCustomer(customer)||!Number.isFinite(c.createdAt))continue;const sources=Object.values(this.mediaStore.records||this.store.data.visaMedia||{}).filter(r=>r.customer===customer&&!this.knownReceipt(customer,r.id)&&originals(r)&&r.expiresAt>this.now()&&r.receivedAt>=c.createdAt).sort((a,b)=>a.receivedAt-b.receivedAt||a.id.localeCompare(b.id)).slice(0,MAX_SOURCES+1);for(const source of sources)this.enqueue(customer,source.id);}}
 bindWaiting(){for(const job of Object.values(this.data().jobs)){if(job.status!=='waiting_case'||job.policy!==this.policyFingerprint)continue;const c=this.caseFor(job.customer);if(!c)continue;const source=this.rawSource(job.customer,job.mediaId);if(!source){job.status='failed';job.issues=[reason('DOCUMENT_SOURCE_UNAVAILABLE')];continue;}const state=this.syncCase(job.customer);job.caseId=c.id;job.caseSignature=state.caseSignature;job.generation=state.generation;job.status='queued';job.updatedAt=this.now();state.status='processing';}}
 snapshot(job){return {id:job.id,customer:job.customer,mediaId:job.mediaId,caseId:job.caseId,signature:job.caseSignature,generation:job.generation,epoch:this.epoch,mediaEpoch:this.mediaStore.epochs?.get(job.customer)||0,policy:job.policy,sourceSha256:job.sourceSha256};}
 guard(snapshot){
  if(this.stopped||this.epoch!==snapshot.epoch||!this.enabled()||(this.mediaStore.epochs?.get(snapshot.customer)||0)!==snapshot.mediaEpoch)throw finite('DOCUMENT_INTAKE_STALE');
  const job=this.data().jobs[snapshot.id],state=this.data().cases[snapshot.customer],c=this.caseFor(snapshot.customer),source=this.rawSource(snapshot.customer,snapshot.mediaId);
  if(!job||!state||!c||!source||job.caseId!==snapshot.caseId||c.id!==snapshot.caseId||state.generation!==snapshot.generation||job.generation!==snapshot.generation||state.caseSignature!==snapshot.signature||visaCaseSignature(c)!==snapshot.signature||job.policy!==snapshot.policy||job.policy!==this.policyFingerprint||state.policy!==this.policyFingerprint||snapshot.sourceSha256&&source.checksum&&source.checksum!==snapshot.sourceSha256)throw finite('DOCUMENT_INTAKE_STALE');return {job,state,c,source};
 }
 sourceBytes(snapshot){this.guard(snapshot);const file=this.mediaStore.read(snapshot.mediaId,{customer:snapshot.customer});const actual=hash(file.bytes);if(snapshot.sourceSha256&&actual!==snapshot.sourceSha256){file.bytes.fill(0);throw finite('DOCUMENT_INTAKE_STALE');}const source=this.rawSource(snapshot.customer,snapshot.mediaId);if(source?.checksum&&actual!==source.checksum){file.bytes.fill(0);throw finite('DOCUMENT_INTAKE_STALE');}return {...file,sha256:actual};}
 async pageBytes(file,page,guard){
  if(file.metadata.mimeType!=='application/pdf'){if(page!==1)throw finite('DOCUMENT_NO_PAGE');return {bytes:Buffer.from(file.bytes),mimeType:file.metadata.mimeType};}
  const parts=await this.rasterize(file.bytes,{kind:'passport',page});guard();if(!Array.isArray(parts)||parts.length!==1||!Buffer.isBuffer(parts[0].bytes)||!['image/png','image/jpeg'].includes(parts[0].mimeType))throw finite('DOCUMENT_PDF_INVALID');return parts[0];
 }
 pageCount(customer,caseId){return Object.values(this.data().jobs).filter(job=>job.customer===customer&&job.caseId===caseId&&job.policy===this.policyFingerprint&&job.status!=='stale').reduce((sum,job)=>sum+Object.keys(job.pages||{}).length,0);}
 async process(job){
  let snap=this.snapshot(job),file;
  try{
   file=this.sourceBytes(snap);snap.sourceSha256=file.sha256;
   this.commit(()=>{this.guard(snap);job=this.data().jobs[snap.id];job.sourceSha256=file.sha256;job.status='running';job.updatedAt=this.now();});
   // Exact duplicate bytes in this case reuse completed checkpoints. No provider
   // request is repeated merely because WhatsApp assigned another media UUID.
   const duplicate=Object.values(this.data().jobs).find(other=>other.id!==job.id&&other.customer===job.customer&&other.caseId===job.caseId&&other.policy===job.policy&&other.sourceSha256===file.sha256&&other.status==='ready');
   if(duplicate){if(this.pageCount(job.customer,job.caseId)-Object.keys(job.pages||{}).length+Object.keys(duplicate.pages).length>MAX_TOTAL_PAGES)throw finite('DOCUMENT_PAGE_LIMIT');this.commit(()=>{this.guard(snap);job=this.data().jobs[snap.id];job.pages=Object.fromEntries(Object.entries(duplicate.pages).map(([page,value])=>[page,{...clone(value),mediaId:job.mediaId}]));job.status='ready';job.updatedAt=this.now();});return;}
   for(let page=1;page<=10;page++){
    this.guard(snap);job=this.data().jobs[snap.id];if(job.pages[page])continue;
    let image,normalized;try{image=await this.pageBytes(file,page,()=>this.guard(snap));this.guard(snap);}catch(error){if(page>1&&error?.code==='PDF_INVALID')break;if(page>1&&error?.code==='DOCUMENT_NO_PAGE')break;throw error;}
    try{
     if(this.pageCount(job.customer,job.caseId)>=MAX_TOTAL_PAGES)throw finite('DOCUMENT_PAGE_LIMIT');normalized=await this.prepare(image.bytes,{mimeType:image.mimeType,kind:'portrait'});this.guard(snap);const pageSha=hash(normalized.bytes);
     const cached=Object.values(this.data().jobs).flatMap(other=>other.customer===job.customer&&other.caseId===job.caseId&&other.policy===job.policy?Object.values(other.pages||{}):[]).find(result=>result.sourceSha256===file.sha256&&result.page===page&&result.sha256===pageSha);
     if(cached){this.commit(()=>{this.guard(snap);this.data().jobs[snap.id].pages[page]={...clone(cached),mediaId:snap.mediaId};});continue;}
     const attempts=job.pageAttempts[page]||0;if(attempts>=MAX_ATTEMPTS)throw finite('DOCUMENT_OCR_RETRY_LIMIT');
     this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];current.activePage=page;current.pageAttempts[page]=attempts+1;current.updatedAt=this.now();});
     const extraction=validateDocumentExtraction(await this.vision.extract({bytes:normalized.bytes,mimeType:normalized.mimeType,guard:()=>this.guard(snap)}));this.guard(snap);
     this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];current.pages[page]={mediaId:snap.mediaId,page,sha256:pageSha,sourceSha256:file.sha256,extraction};delete current.activePage;current.updatedAt=this.now();});
    }finally{if(normalized?.bytes&&normalized.bytes!==image?.bytes)normalized.bytes.fill(0);image?.bytes?.fill(0);}
   }
   this.commit(()=>{this.guard(snap);const current=this.data().jobs[snap.id];if(!Object.keys(current.pages).length)throw finite('DOCUMENT_READ_FAILED');current.status='ready';current.issues=[];delete current.activePage;delete current.nextAttemptAt;current.updatedAt=this.now();});
  }catch(error){
   try{this.guard(snap);this.commit(()=>{const current=this.data().jobs[snap.id];const retryable=error?.retryable===true&&(current.pageAttempts[current.activePage]||0)<MAX_ATTEMPTS;if(retryable){current.status='retry';current.nextAttemptAt=this.now()+Math.max(5000,Math.min(300000,Number(error.retryAfterMs)||5000));current.issues=[reason('DOCUMENT_PROVIDER_UNAVAILABLE')];}else{current.status='failed';current.issues=[reason(error?.code==='DOCUMENT_PAGE_LIMIT'?'DOCUMENT_PAGE_LIMIT':error?.code==='PDF_PAGE_COUNT_UNSUPPORTED'?'DOCUMENT_PDF_UNSUPPORTED':error?.code==='DOCUMENT_INTAKE_STALE'?'DOCUMENT_SOURCE_CHANGED':'DOCUMENT_READ_FAILED')];}current.updatedAt=this.now();});}catch{}
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
  const documents=jobs.flatMap(job=>Object.values(job.pages||{})).sort((a,b)=>jobs.findIndex(job=>job.mediaId===a.mediaId)-jobs.findIndex(job=>job.mediaId===b.mediaId)||a.page-b.page),pending=jobs.some(job=>activeStatus(job.status)),sourceIssues=jobs.flatMap(job=>job.status==='failed'?job.issues||[reason('DOCUMENT_READ_FAILED')]:[]);
  const blocked=this.blockReason(customer);
  const fingerprint=digest({signature,generation,preparationPolicy:PREPARATION_POLICY,documents,sourceIssues,pending,limit:state.limitExceeded===true});if(!force&&state.inputFingerprint===fingerprint)return false;
  const people=Number.isInteger(c.applicantCount)&&c.applicantCount>0&&c.applicantCount<=30?Array.from({length:c.applicantCount},(_,index)=>c.applicants?.[index]||{}):[];
  const matched=this.reconcile({documents,applicants:people,referenceDate:dubaiDate(this.now())}),previous=state.applicants||[];
  this.commit(()=>{guard();state=this.data().cases[customer];state.documents=clone(documents);state.inputFingerprint=fingerprint;state.status=pending?'processing':'needs_review';state.updatedAt=this.now();state.issues=clone([...(matched.issues||[]),...sourceIssues,...(state.limitExceeded?[reason('DOCUMENT_SOURCE_LIMIT')]:[])]);});
  const snapshots=[];for(const applicant of matched.applicants||[]){
   const extractionDigest=extractionDigestFor(documents,applicant),old=previous.find(item=>item.applicantIndex===applicant.applicantIndex&&item.extractionDigest===extractionDigest);
   const item={id:old?.id||randomUUID(),applicantIndex:applicant.applicantIndex,status:'needs_review',identityReady:applicant.identityReady===true||applicant.status==='ready',clientFieldsRequired:clone(applicant.clientFieldsRequired||[]),fields:clone(applicant.fields||{}),documents:{passport:null,residence:null,photo:null},sourceManifest:jobs.filter(job=>SHA.test(job.sourceSha256||'')).map(job=>({mediaId:job.mediaId,sha256:job.sourceSha256})).sort((a,b)=>a.mediaId.localeCompare(b.mediaId)),preparedManifest:[],evidence:clone(applicant.evidence),issues:clone(applicant.issues||[]),extractionDigest};
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
   const job=Object.values(this.data().jobs).filter(item=>item.policy===this.policyFingerprint&&['queued','retry'].includes(item.status)&&(!item.nextAttemptAt||item.nextAttemptAt<=this.now())&&this.caseFor(item.customer)?.id===item.caseId).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))[0];
   if(job&&this.available()){await this.process(job);processed=true;}
   for(const customer of Object.keys(this.data().cases)){try{await this.reconcileCase(customer);}catch{}}
   return Boolean(job);
  }finally{this.busy=false;if(acquired)this.lock.release();if(this.started&&processed&&Object.values(this.data().jobs).some(job=>job.status==='queued'))this.wake();}
 }
 summary(customer){
  const state=validCustomer(customer)?this.data().cases[customer]:null,waiting=!state&&Object.values(this.data().jobs).some(job=>job.customer===customer&&job.status==='waiting_case');
  return {enabled:this.enabled(),configured:this.configured(),status:!this.enabled()?'disabled':state?.status||(waiting?'waiting_case':'not_started'),...(state?{caseId:state.caseId,caseSignature:state.caseSignature,generation:state.generation,awaitingPayment:state.awaitingPayment===true,resultFingerprint:state.resultFingerprint||null,updatedAt:state.updatedAt,applicants:state.applicants.map(app=>({applicantIndex:app.applicantIndex,evidenceId:app.id,status:app.status,awaitingPayment:state.awaitingPayment===true,identityReady:app.identityReady===true,clientFieldsRequired:clone(app.clientFieldsRequired||[]),fields:clone(app.fields),documents:clone(app.documents),issues:clone(app.issues||[]),evidence:clone(app.evidence)})),issues:clone(state.issues||[])}:{updatedAt:null,applicants:[],issues:waiting?[reason('DOCUMENT_WAITING_CASE')]:[]})};
 }
 status(){return {enabled:this.enabled(),configured:this.configured(),running:this.busy,cases:Object.keys(this.data().cases).length,queued:Object.values(this.data().jobs).filter(job=>activeStatus(job.status)).length};}
}
module.exports={VisaDocumentIntake,extractionDigestFor};
