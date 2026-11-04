'use strict';
const {randomUUID}=require('node:crypto');
const P=require('./saudi-visa-policy');
const SERVICE=require('./remal-service-policy');
const {loadVisaPrivateConfig}=require('./saudi-visa-private');
const {currentVisaEvidence}=require('./visa-case-signature');
const {redactVisaText}=require('./saudi-visa-nlu');
const {detectDocumentStep}=require('./visa-document-conversation');
const {documentClarificationCopy}=require('./visa-workflow-progress');
const {referenceKey,applicationReference,conversationIntent}=require('./visa-conversation-intent');
const INTRO='أهلاً وسهلاً فيك بمجموعة الرمال 🌷 أنا إسماعيل، المساعد الافتراضي المختص بفيز السعودية.';
const EGYPT_SINGLE_COPY='حسب سياسة منصة التقديم الحالية، التأشيرة السياحية المتاحة للجنسية المصرية خلال هذا الموسم هي سفرة واحدة، والتأشيرة متعددة الدخول غير متاحة حاليًا.';
const MONEY=x=>Number(x).toLocaleString('en-US',{maximumFractionDigits:2});
function countFrom(text){const n=P.normalize(text);if(/لحالي|لوحدي|شخص واحد|شخص بالغ|انا فقط|انا بس|one person|just me/.test(n))return 1;const m=n.match(/(?:نحن|نحنا|صرنا|عددنا|عدد الاشخاص|عدد المتقدمين)\s*(\d{1,2})|\b(\d{1,2})\s*(?:اشخاص|شخص|افراد|متقدم)/);if(m)return Number(m[1]||m[2]);if(/(?:ثلاثه|ثلاث|تلاته|تلات)\s*(?:اشخاص|افراد|متقدمين)|(?:نحن|نحنا|صرنا|عددنا)\s*(?:ثلاثه|ثلاث|تلاته|تلات)/.test(n))return 3;if(/شخصين|(?:نحن|نحنا|صرنا|عددنا)\s*(?:اتنين|اثنين)|انا و(?:مرتي|زوجتي)/.test(n))return /(?:ابني|بنتي|الولد|الطفل)/.test(n)?3:2;if(/اربعه اشخاص|اربع اشخاص/.test(n))return 4;if(/خمسه اشخاص|خمس اشخاص/.test(n))return 5;return null;}
function isComplaint(text){const n=P.normalize(text);const accusation=/نصاب|نصبتم|نصبتو|نصبتوا|حراميه|سرقتو|سرقتوا/.test(n),existing=/قدمت|مقدم|معاملتي|معامله|دفعت|حولت|فلوسي|مصرياتي|مصاري|مبلغ|ترجعو|رجعتو/.test(n);return existing&&(accusation||/(?:ما|لم|مو|ليس).{0,25}(?:طلعت|صدرت|رجعت|رجعتو|رجعوا|رجعتوا|استلمت)|شكوي|اشتك/.test(n));}
function safeText(s,max=120){return typeof s==='string'?s.trim().slice(0,max):null;}
function dateValue(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;}
function conversationText(text,{hasAttachments=false}={}){
 const withoutPlaceholders=hasAttachments?String(text||'').replace(/\[[^\[\]\n]{0,80}(?:مرفق|ملف|مراجعة|مراجعه)[^\[\]\n]{0,80}\]/g,''):String(text||'');
 const safe=redactVisaText(withoutPlaceholders).trim();
 // Redaction markers alone are not a customer question. Images, OCR output,
 // identifiers and credentials never enter semantic conversation understanding.
 const words=safe.replace(/\[(?:document omitted|document number|number|credential|name|redacted|email|bank account)\]/g,'').replace(/[،,\s]+/g,' ').trim();
 return /[A-Za-z\u0621-\u064a]/.test(words)?safe:'';
}
function relativeReply(pending,{group=false,question=''}={}){
 const person=pending.facts||{};
 if(group){pending.awaiting='scope';return 'أكيد، منراجع طلبات رفقاتك كل واحد حسب جنسيته ومستنده. بتحب نضيفهم معك بنفس المجموعة، أو كل واحد بملف مستقل؟';}
 if(!person.nationality){pending.awaiting='nationality';return 'أكيد، فينا نراجع حالة صديقك كمان. شو جنسيته؟';}
 const product=P.productFor(person);if(product.code==='umrah'&&P.umrahQuestion(question))return P.umrahConsultation(person,{objection:true});let lead='';
 if(product.code==='suspended'){pending.awaiting='scope';return 'حسب حالة التقديم الحالية عندنا، التقديم لهالجنسية متوقف. ما رح نطلب منه دفع أو نوعده بموعد فتح غير معتمد.';}
 if(person.nationality==='فلسطين')lead='للحالة الفلسطينية، '+P.UMRAH_ROUTE+' التقديم بأصل الجواز وأصل الهوية، والتكلفة 850 درهم مع ميزة استرداد الرسوم في حال الرفض الرسمي حسب شروط الخدمة، وما في ضمان للموافقة.';
 else if(!person.documentType&&product.code==='tourist_single')lead='إذا معه جواز مصري عادي: '+EGYPT_SINGLE_COPY;
 else if(product.code==='tourist_single')lead=EGYPT_SINGLE_COPY;
 else if(!person.documentType&&product.code==='tourist_multi')lead='إذا معه جواز عادي، المسار عندنا سياحية متعددة الدخول حسب سياسة المكتب.';
 else if(product.code==='unverified')lead='نوع التأشيرة لهالحالة يحتاج تحققًا قبل تأكيد الأهلية أو طلب الدفع.';
 else lead='حسب سياسة التقديم الحالية عندنا، المسار لهالحالة هو '+product.label+'، من دون ضمان للموافقة.';
 if(!person.documentType){pending.awaiting='documentType';return lead+' معه جواز سفر عادي أو وثيقة سفر؟';}
 if(person.documentType==='travel_document'&&!person.documentIssuer){pending.awaiting='documentIssuer';return lead+' وثيقته صادرة من أي بلد؟';}
 pending.awaiting='scope';return lead+' بدك نضيفه لنفس المجموعة أو تفتح له طلب مستقل؟';
}
function extractLocal(text,c){
 const n=P.normalize(text),ns=P.nationalities(n),fields={},number=countFrom(n);
 if(number)fields.applicantCount=number;
 const doc=/وثيقه|وثيقة|وثائق|travel document/.test(n)?'travel_document':/جواز|passport/.test(n)?'passport':null;
 if(ns.length===1&&!(doc==='travel_document'&&!/فلسطين/.test(n)))fields.nationality=ns[0];if(doc)fields.documentType=doc;
 if(ns.length>1&&/(?:انا|زوج|مرتي|امي|ابي|والد|ابني|بنتي)/.test(n)&&!doc){fields.applicants=ns.map(nationality=>({nationality}));fields.applicantCount=number||Math.max(c.applicantCount||0,ns.length);}
 if(/كلنا|جميعنا|نحن.{0,10}سوريين|نحنا.{0,10}سوريين/.test(n)&&ns.length===1&&number)fields.applicants=Array.from({length:number},()=>({nationality:ns[0],...(doc?{documentType:doc}:{})}));
 if(/مصريه|مصري/.test(n)&&doc==='travel_document')fields.documentIssuer='مصر';else if(/لبنان/.test(n)&&doc==='travel_document')fields.documentIssuer='لبنان';else if(/سوريا|سوري/.test(n)&&doc==='travel_document')fields.documentIssuer='سوريا';
 if(/تحويل|حساب بنكي|حسابات|ايبان|iban|bank/.test(n))fields.paymentMethod='bank';else if(/تابي|tabby/.test(n))fields.paymentMethod='tabby';else if(/رابط الدفع|لينك|payment link/.test(n))fields.paymentMethod='link';
 if(/بالسياره|بري|سيارتي/.test(n))fields.transport='car';else if(/بالطيران|بالطياره|جوي/.test(n))fields.transport='air';
 if(/عندي مستضيف|معي هويه مستضيف|عندي مضيف/.test(n))fields.hasHost=true;
 if(/ما عندي مستضيف|ماعندي مستضيف|بدي فندق/.test(n))fields.hasHost=false;
 const dates=[...n.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(x=>dateValue(x[1])).filter(Boolean);if(/سفر|مسافر|ذهاب|رجعه|عوده|مغادر/.test(n)&&!/انتهاء|ينتهي|تنتهي|صلاحيه/.test(n)){if(dates.length)fields.departureDate=dates[0];if(dates[1])fields.returnDate=dates[1];}
 return fields;
}
function personFields(f){const p={};if(f&&typeof f==='object'){
 if(typeof f.nationality==='string'&&f.nationality.trim())p.nationality=P.canonicalNationality(f.nationality);
 if(['passport','travel_document'].includes(f.documentType))p.documentType=f.documentType;
 if(typeof f.documentIssuer==='string'&&f.documentIssuer.trim())p.documentIssuer=safeText(f.documentIssuer,70);
 if(Number.isInteger(f.age)&&f.age>=0&&f.age<120)p.age=f.age;
 }return p;}
function mergeFacts(c,f){
 if(!f||typeof f!=='object'||Array.isArray(f))return;
 if(Number.isInteger(f.applicantCount)&&f.applicantCount>=1&&f.applicantCount<=30){c.applicantCount=f.applicantCount;c.applicants=c.applicants.slice(0,c.applicantCount);}
 if(Array.isArray(f.applicants)&&f.applicants.length&&f.applicants.length<=30){
  if(!c.applicantCount)c.applicantCount=f.applicants.length;
  for(let i=0;i<Math.min(f.applicants.length,c.applicantCount);i++)c.applicants[i]={...c.applicants[i],...personFields(f.applicants[i])};
 }
 const primary=personFields(f);if(Object.keys(primary).length)c.applicants[0]={...c.applicants[0],...primary};
 for(const key of ['departureDate','returnDate'])if(dateValue(f[key]))c[key]=f[key];
 if(['air','car'].includes(f.transport||f.travelMode))c.transport=f.transport||f.travelMode;
 if(typeof f.hasHost==='boolean')c.hasHost=f.hasHost;
 if(['bank','link','tabby'].includes(f.paymentMethod))c.paymentMethod=f.paymentMethod;
}
function quoteText(q){
 if(!q)return '';
 if(q.requiresReview)return 'حتى نعطيك سعر الأطفال بشكل دقيق، بدنا نراجع تسعير الحالة قبل تأكيد المبلغ؛ ما رح نحسب الطفل تلقائياً بسعر البالغ.'+(q.adultReferenceAmount?'\n(للإرشاد: رسوم الشخص البالغ لـ'+q.adultLabel+' هي '+MONEY(q.adultReferenceAmount)+' درهم، ويُؤكد الإجمالي بعد مراجعة تسعير الطفل مع المسؤول).':'');
 let text='*عرض تأشيرات السعودية 🇸🇦*\n'+q.rows.map(r=>`• المتقدم ${r.applicant}: ${r.label} — ${MONEY(r.amount)} درهم`).join('\n');
 if(q.rows.some(row=>row.product==='tourist_multi'))text+='\n✨ السياحية المتعددة: صلاحية سنة مع إقامة تصل إلى 90 يوماً حسب شروط التأشيرة الصادرة.';
 if(q.rows.some(row=>row.product==='tourist_single'))text+='\n\n'+EGYPT_SINGLE_COPY;
 text+=`\n*إجمالي رسوم التأشيرات: ${MONEY(q.subtotal)} درهم*`;
 if(q.groupDiscount)text+='\nتم احتساب سعر المجموعة: '+P.PRICES.touristGroup+' درهماً للشخص.';
 if(q.mixedGroupReview)text+='\nالمجموعة فيها أنواع تأشيرات مختلفة؛ أي خصم إضافي يحتاج سياسة معتمدة، ولم يُحتسب تلقائياً.';
 if(q.paymentFee)text+=`\nرسوم طريقة الدفع: ${MONEY(q.paymentFee)} درهم\n*المجموع بهذه الطريقة: ${MONEY(q.total)} درهم*`;
 else if(q.feePending)text+='\nرسوم وسيلة الدفع تحتاج تأكيداً قبل إصدار رابط الدفع. التحويل البنكي دون عمولة إضافية من المكتب.';
 else text+='\nالتحويل البنكي دون عمولة إضافية من المكتب.';
 text+='\n\n'+P.REFUND_BENEFIT;
 if(q.paymentFee||q.feePending)text+='\nرسوم وسيلة الدفع وأي خدمات إضافية تُوضح منفصلة قبل الاتفاق.';
 return text;
}
class SaudiVisaEngine{
 constructor({store,now=Date.now,understand=null,env=process.env,privateConfig=loadVisaPrivateConfig({env})}={}){
  if(!store?.data||typeof store.save!=='function')throw Error('VISA_STORE_REQUIRED');Object.assign(this,{store,now,understand,env,privateConfig});store.data.visaCases||={};
 }
 getCase(id){return this.store.data.visaCases[id]||null;}
 status(){return {enabled:true,policyVersion:P.POLICY_VERSION,cases:Object.keys(this.store.data.visaCases).length,feesEnabled:true};}
 delete(id){delete this.store.data.visaConversationScopes?.[id];delete this.store.data.pendingNewVisaMedia?.[id];if(this.store.data.serviceSessions?.[id])delete this.store.data.serviceSessions[id].documentConversation;for(const [key,item]of Object.entries(this.store.data.visaDocumentPreviews?.items||{}))if(item.customer===id)delete this.store.data.visaDocumentPreviews.items[key];delete this.store.data.visaCases[id];if(this.store.data.visaCaseArchives)delete this.store.data.visaCaseArchives[id];if(this.store.data.raadApplications)delete this.store.data.raadApplications[id];if(this.store.data.visaDocumentIntake){delete this.store.data.visaDocumentIntake.cases?.[id];for(const [key,item]of Object.entries(this.store.data.visaDocumentIntake.jobs||{}))if(item.customer===id)delete this.store.data.visaDocumentIntake.jobs[key];}for(const [key,item]of Object.entries(this.store.data.visaDocumentNotifications?.items||{}))if(item.customer===id)delete this.store.data.visaDocumentNotifications.items[key];for(const [key,item]of Object.entries(this.store.data.visaUpload?.sessions||{}))if(item.customer===id)delete this.store.data.visaUpload.sessions[key];for(const [key,item]of Object.entries(this.store.data.visaPreparedDeliveries?.items||{}))if(item.customer===id)delete this.store.data.visaPreparedDeliveries.items[key];this.store.save();}
 save(id,c){c.updatedAt=this.now();this.store.data.visaCases[id]=c;this.store.save();}
 recordDocumentTurn(id,text,reply,{caseId,expectedRevision,hasAttachments=false}={}){
  const current=this.getCase(id);if(!current||current.id!==caseId||current.revision!==expectedRevision)return{reply:null,superseded:true};
  const c=structuredClone(current);c.history||=[];c.history.push({role:'user',text:(hasAttachments?'[attachment received] ':'')+redactVisaText(String(text)).slice(0,1500)},{role:'assistant',text:redactVisaText(String(reply)).slice(0,2500)});c.history=c.history.slice(-16);c.revision++;this.save(id,c);return{reply,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage};
 }
 newCase(){return {id:randomUUID(),service:'saudi_visa',policyVersion:P.POLICY_VERSION,revision:0,stage:'inquiry',createdAt:this.now(),updatedAt:this.now(),applicantCount:null,applicants:[],askedQuestions:[],history:[],paymentStatus:'unverified',documents:[],submissionStatus:'not_submitted',greeted:false};}
 ask(c,key,text){const repeated=c.lastQuestion===key;c.lastQuestion=key;if(!c.askedQuestions.includes(key))c.askedQuestions.push(key);return repeated?'حتى نكمل من نفس النقطة: '+text:text;}
 nextQuestion(c){
  if(!c.applicants[0]?.nationality)return this.ask(c,'nationality','شو جنسية الشخص اللي بدنا نقدّم له؟');
  if(!c.applicants[0]?.documentType)return this.ask(c,'documentType','معه جواز سفر عادي أو وثيقة سفر؟');
  if(!c.applicantCount)return this.ask(c,'applicantCount','كم شخص حابب يقدّم؟');
  for(let i=0;i<c.applicantCount;i++){
   const p=c.applicants[i]||{};if(!p.nationality)return this.ask(c,'nationality_'+i,`شو جنسية المتقدم ${i+1}؟`);
   if(!p.documentType)return this.ask(c,'documentType_'+i,`المتقدم ${i+1} معه جواز عادي أو وثيقة سفر؟`);
   if(p.documentType==='travel_document'&&!p.documentIssuer)return this.ask(c,'issuer_'+i,`وثيقة المتقدم ${i+1} صادرة من أي بلد؟`);
  }
  return null;
 }
 conversationReply(id,c,text,reply){
  c.revision++;c.history.push({role:'user',text:redactVisaText(text).slice(0,1500)},{role:'assistant',text:redactVisaText(reply).slice(0,2500)});c.history=c.history.slice(-16);this.save(id,c);return{reply,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage};
 }
 ownedApplications(id){
  const cases=[this.getCase(id),...(this.store.data.visaCaseArchives?.[id]||[])].filter(Boolean);
  return Object.values(this.store.data.visaFulfilment?.jobs||{}).filter(job=>job.customer===id&&job.applicationReference&&cases.some(c=>c.id===job.caseId&&currentVisaEvidence(c).signature===job.caseSignature));
 }
 followupReply(id,c,text,intent){
  const jobs=this.ownedApplications(id),reference=applicationReference(text,{awaiting:c.followupAwaitingReference===true,known:jobs.map(job=>job.applicationReference)});
  if(!reference&&intent!=='status'&&intent!=='existing_application')return null;
  if(reference){const matches=jobs.filter(job=>referenceKey(job.applicationReference)===reference);if(matches.length!==1){c.followupAwaitingReference=true;return 'ما قدرت أربط رقم الطلب بملف مقدم من رقم واتسابك الحالي. تواصل من نفس الرقم اللي قدمت منه حتى نراجع الطلب الصحيح؛ ما في داعي تعيد الأوراق أو الدفع.';}delete c.followupAwaitingReference;return this.applicationUpdate(matches[0]);}
  const currentJobs=jobs.filter(job=>job.caseId===c.id);
  if(currentJobs.length===1){delete c.followupAwaitingReference;return this.applicationUpdate(currentJobs[0]);}
  if(currentJobs.length>1){c.followupAwaitingReference=true;return 'عندك أكثر من طلب محفوظ معنا: '+currentJobs.map(job=>job.applicationReference).slice(0,10).join('، ')+'. أي رقم طلب حابب تتابع؟';}
  const review=this.store.data.visaDocumentIntake?.cases?.[id];if(review?.caseId===c.id&&review.caseSignature===currentVisaEvidence(c).signature&&!['processing','queued'].includes(review.status)){return SERVICE.response('processing');}
  if(c.paymentStatus==='verified'||c.submissionStatus==='submitted'||c.documents?.length||c.staffVerification?.decision)return null;
  c.followupAwaitingReference=true;return 'أكيد، بساعدك بمتابعة طلبك. ابعت رقم الطلب، وتابع من نفس رقم واتساب اللي قدمت منه حتى نربطه بملفك الصحيح.';
 }
 applicationUpdate(job){
  const c=[this.getCase(job.customer),...(this.store.data.visaCaseArchives?.[job.customer]||[])].find(c=>c?.id===job.caseId),evidence=c&&currentVisaEvidence(c),decision=c?.staffVerification?.decision;
  if(decision?.caseSignature===evidence?.signature&&decision?.value==='approved')return 'طلبك رقم '+job.applicationReference+' مسجل عليه قرار موافقة من القسم. منتابع إرسال التأشيرة إلك.';
  if(decision?.caseSignature===evidence?.signature&&decision?.value==='rejected')return 'طلبك رقم '+job.applicationReference+' مسجل عليه قرار رفض من القسم. منراجع معك الخطوة التالية حسب سياسة الخدمة.';
  return 'طلبك رقم '+job.applicationReference+' محفوظ معنا، ومنتابع عليه. ما وصلنا تحديث مسجل بصدور التأشيرة بعد؛ أول ما تصدر بنبعتها إلك مباشرة.';
 }
 async handle(id,text,{messages=[]}={}){
  text=String(text||'').trim().slice(0,12000);const n=P.normalize(text);let c=structuredClone(this.getCase(id)||this.newCase()),decision=null;
  const initialRevision=c.revision;
  if(/^(?:احذف بياناتي|امسح بياناتي)$/.test(n)){this.delete(id);return{reply:'تم حذف ملف فيزا السعودية المحفوظ لدينا. إذا عندك معاملة مقدمة فعلياً أو التزام مالي، مراجعتها بتكون مع القسم المختص.',deleted:true,service:'saudi_visa'};}
  // General validity guidance must not turn document mentions into applicant facts.
  if(/صلاحي[ته]|كم باقي|ينتهي|تنتهي|انتهاء/.test(n)&&/جواز|اقامه|هويه/.test(n)&&!isComplaint(text)){
   const reply='بالنسبة لصلاحية المستندات المطلوبة للتقديم عبر مجموعة الرمال:\n• *جواز السفر:* 6 أشهر على الأقل عند السفر.\n• *الإقامة / الهوية الخليجية للمقيمين:* نراجع بقاء 3 أشهر على الأقل ضمن متطلبات ملفك.\n\nمنراجع تواريخ المستندات ضمن الملف قبل استكمال الطلب؛ هالإرشاد ما بيؤكد قبول التأشيرة.';
   return {...this.conversationReply(id,c,text,reply),intent:'visa_info'};
  }
  // Only privacy-filtered conversation text enters semantic understanding.
  // Preserve a real caption/question beside an attachment, never its pixels.
  const hasAttachments=messages.some(m=>m.media),semanticText=conversationText(text,{hasAttachments});
  if(this.understand&&semanticText){
   try{decision=await this.understand(semanticText,{caseId:c.id,revision:c.revision,lastQuestion:c.lastQuestion,applicantCount:c.applicantCount,applicants:c.applicants.map(personFields),transport:c.transport,hasHost:c.hasHost,paymentMethod:c.paymentMethod,history:c.history.slice(-8),stage:c.stage});}catch{}
  }
  // Do not overwrite a case updated by an operator while understanding ran.
  const latest=this.getCase(id);if(latest&&latest.revision!==initialRevision)return{reply:null,superseded:true,caseId:latest.id,revision:latest.revision,service:'saudi_visa'};
  const localIntent=conversationIntent(text),intentForConversation=isComplaint(text)||decision?.intent==='complaint'?'complaint':localIntent||decision?.intent;
  const confirmNew=c.pendingNewApplication&&c.pendingNewApplication.requestedAt+15*60000>this.now()&&c.history.at(-1)?.text.endsWith('تأكدلي: بدك نفتح طلب جديد؟')&&/^(?:نعم|اي|تمام|اوافق|موافق|اكد|نعم طلب جديد|طلب جديد مستقل|yes)(?:[.! ]*)$/.test(n);
  if(c.pendingNewApplication&&/^(?:لا|الغاء|الغيه|خليك عالقديم|متابعه القديم)(?:[.! ]*)$/.test(n)){delete c.pendingNewApplication;return this.conversationReply(id,c,text,'تمام، منكمل على ملفك الحالي. شو حابب تعرف عن طلبك؟');}
  if(confirmNew){
   const jobs=Object.values(this.store.data.visaFulfilment?.jobs||{}).filter(job=>job.customer===id&&job.caseId===c.id),active=jobs.some(job=>!['saved_application','manually_completed','stale','cancelled'].includes(job.state));
   if(active||c.paymentStatus==='verified'&&!jobs.some(job=>['saved_application','manually_completed'].includes(job.state)))return this.conversationReply(id,c,text,'سجلت رغبتك بطلب جديد مستقل. طلبك الحالي ما زال قيد الإجراء؛ يلزم تنسيق فتح الملف الجديد مع الفريق حتى نحافظ على المعاملة والدفعة الحالية.');
   const facts=c.pendingNewApplication.facts;delete c.pendingNewApplication;this.store.data.visaCaseArchives||={};this.store.data.visaCaseArchives[id]||=[];this.store.data.visaCaseArchives[id].push(structuredClone(c));c=this.newCase();c.greeted=true;mergeFacts(c,facts);
  }else if(intentForConversation==='new_application'&&this.getCase(id)&&!c.pendingRelative){
   c.pendingNewApplication={requestedAt:this.now(),facts:extractLocal(text,this.newCase())};return this.conversationReply(id,c,text,'أكيد، فينا نبدأ طلب جديد مستقل مع الاحتفاظ بطلبك الحالي. تأكدلي: بدك نفتح طلب جديد؟');
  }else{
   const reply=intentForConversation==='complaint'?null:this.followupReply(id,c,text,intentForConversation);if(reply)return this.conversationReply(id,c,text,reply);
  }
  const beforeFacts=JSON.stringify({applicantCount:c.applicantCount,applicants:c.applicants,departureDate:c.departureDate,returnDate:c.returnDate,transport:c.transport,hasHost:c.hasHost,hasMinors:c.hasMinors}),beforeCase=structuredClone(c);
  const aiFields=structuredClone(decision?.fields||decision?.facts||{}),localFields=extractLocal(text,c),awaiting=c.lastQuestion;
  if(Array.isArray(aiFields.applicants)&&aiFields.applicants.length){delete localFields.nationality;delete localFields.applicants;}
  if(/ايام|اسبوع|شهر|ساعات|دقايق/.test(n)&&!/(?:نحن|نحنا|صرنا|عددنا|شخص|اشخاص|متقدم)/.test(n)){delete aiFields.applicantCount;delete localFields.applicantCount;}
  if(/انتهاء|ينتهي|تنتهي|صلاحيه/.test(n)){delete aiFields.departureDate;delete aiFields.returnDate;}
  if(awaiting?.startsWith('issuer_'))for(const f of [aiFields,localFields]){delete f.nationality;delete f.documentType;delete f.applicants;}
  const relativeMention=/(?:^|[^\p{L}])(?:[وبل])?(?:صديق(?:ي|تي|ه|ته|ها|تها)?|رفيق(?:ي|تي|ه|ته|ها|تها)?|صاحبي|زوجتي|مرتي|والدتي|والدي|امي|ابي|اختي|اخي|ابني|بنتي)(?=$|[^\p{L}])/u.test(n),pending=c.pendingRelative,ns=P.nationalities(n);
  const ownCorrection=decision?.correction&&decision?.target==='self'&&!pending||/جنسيتي|انا (?:مو|مش|لست)|بالنسبه الي/.test(n)||/^انا\s/.test(n)&&ns.length===1&&!relativeMention;
  const operational=/حساب|ايبان|بنك|دفع|حولت|ايصال|الغاء|كنسل|ارسل(?:ت)? الاوراق|ابعتلك الاوراق/.test(n);
  const shortRelativeAnswer=pending&&!ownCorrection&&!operational&&text.length<100&&(pending.awaiting==='nationality'&&ns.length===1||pending.awaiting==='documentType'&&/^(?:معه |معو |هو )?(?:جواز(?: سفر)?(?: عادي)?|عادي|وثيقه(?: سفر)?)(?:[.!؟? ]*)$/.test(n)||pending.awaiting==='documentIssuer'&&ns.length===1);
  const relativeFollowup=pending&&!ownCorrection&&!operational&&(/كمان بدن يقدمو|كمان بدهم يقدمو|هنن.*(?:يقدمو|يقدموا)/.test(n)||/حتى|له|الو|بتطلع|بيطلع|تفاصيل/.test(n)&&(!ns.length||ns.includes(pending.facts?.nationality)));
  const explicitGroup=countFrom(n)>1&&/نحن|نحنا|صرنا|عددنا|انا و/.test(n)||decision?.target==='group'&&Number.isInteger(aiFields.applicantCount)&&aiFields.applicantCount>1;
  const relativeInquiry=Boolean(c.applicants[0]?.nationality)&&!ownCorrection&&!explicitGroup&&!/(?:ضيف|اضف|اضيف).{0,15}(?:معنا|معي|المجموعه|الطلب)|ضيفها|ضيفه/.test(n)&&(relativeMention||shortRelativeAnswer||relativeFollowup||decision?.target==='other');
  if(relativeInquiry){
   const nextFacts=personFields({...aiFields,...localFields,...(Array.isArray(aiFields.applicants)&&aiFields.applicants.length===1?aiFields.applicants[0]:{})});
   if(shortRelativeAnswer&&pending.awaiting==='documentType'&&/عادي/.test(n))nextFacts.documentType='passport';
   const newPerson=relativeMention&&pending&&(/تاني|ثاني|اخر/.test(n)||nextFacts.nationality&&pending.facts?.nationality&&nextFacts.nationality!==pending.facts.nationality);
   if(newPerson){c.relativeInquiries=[...(c.relativeInquiries||[]),{facts:pending.facts,at:pending.at}].slice(-6);}
   const previous=newPerson?{}:pending?.facts||{};
   if(shortRelativeAnswer&&pending.awaiting==='documentIssuer'){nextFacts.documentIssuer=nextFacts.nationality;delete nextFacts.nationality;}
   c.pendingRelative={facts:{...previous,...nextFacts},at:this.now(),awaiting:pending?.awaiting||null};
   for(const f of [aiFields,localFields])for(const k of Object.keys(f))delete f[k];
  }
  const target=awaiting?.match(/^(nationality|documentType)_(\d+)$/);
  if(target){for(const f of [aiFields,localFields]){if(f[target[1]]){const i=Number(target[2]);f.applicants=Array.from({length:i+1},(_,j)=>j===i?{[target[1]]:f[target[1]]}:{});delete f[target[1]];}}}
  if(awaiting==='applicantCount'&&/^\d{1,2}$/.test(n))localFields.applicantCount=Number(n);
  if(decision?.correction&&aiFields.nationality){delete localFields.applicants;delete localFields.applicantCount;localFields.nationality=aiFields.nationality;}
  if(c.pendingRelative&&!relativeInquiry&&/(?:ضيف|اضف|اضيف).{0,15}(?:معنا|معي|المجموعه|الطلب)|ضيفها|ضيفه/.test(n)){
   const f=c.pendingRelative.facts,people=Array.isArray(f.applicants)&&f.applicants.length?f.applicants:[f];c.applicants.push(...people.map(personFields));c.applicantCount=(c.applicantCount||1)+people.length;delete c.pendingRelative;
  }
  let independentRelative=false;
  if(c.pendingRelative&&!relativeInquiry&&/طلب مستقل|طلب جديد|منفصل|مستقل/.test(n)){
   const relative=c.pendingRelative.facts;this.store.data.visaCaseArchives||={};this.store.data.visaCaseArchives[id]||=[];this.store.data.visaCaseArchives[id].push({...beforeCase,pendingRelative:undefined});this.store.data.visaCaseArchives[id]=this.store.data.visaCaseArchives[id].slice(-10);
   c=this.newCase();c.greeted=true;mergeFacts(c,relative);independentRelative=true;
  }
  mergeFacts(c,aiFields);mergeFacts(c,localFields);
  // Short answers apply only to the field actually requested.
  if(!relativeInquiry){
   if(c.lastQuestion?.startsWith('nationality_')){const index=Number(c.lastQuestion.slice(12)),ns=P.nationalities(text);if(ns.length===1)c.applicants[index]={...c.applicants[index],nationality:ns[0]};}
   if(c.lastQuestion?.startsWith('documentType_')){const index=Number(c.lastQuestion.slice(13)),doc=/وثيق/.test(n)?'travel_document':/عادي|جواز|passport/.test(n)?'passport':null;if(doc)c.applicants[index]={...c.applicants[index],documentType:doc};}
   if(c.lastQuestion?.startsWith('issuer_')){const i=Number(c.lastQuestion.slice(7));if(text.length<80)c.applicants[i]={...c.applicants[i],documentIssuer:safeText(text,70)};}
   if(c.lastQuestion==='documentType'&&/^(?:عادي|عاديه|نظامي|جواز عادي)$/.test(n))c.applicants[0]={...c.applicants[0],documentType:'passport'};
  }
  if(!relativeInquiry&&/طفل|اطفال|رضيع|قاصر|عمره (?:سنه|سنتين|ثلاث|اربع|خمس|ست|سبع|ثمان|تسع|عشر)/.test(n))c.hasMinors=true;
  let pendingAmendment=false;
  const afterFacts=JSON.stringify({applicantCount:c.applicantCount,applicants:c.applicants,departureDate:c.departureDate,returnDate:c.returnDate,transport:c.transport,hasHost:c.hasHost,hasMinors:c.hasMinors});
  if(!independentRelative&&(beforeCase.paymentStatus==='verified'||beforeCase.submissionStatus==='submitted')&&afterFacts!==beforeFacts){
   c.pendingAmendment={facts:JSON.parse(afterFacts),requestedAt:this.now()};for(const k of ['applicantCount','applicants','departureDate','returnDate','transport','hasHost','hasMinors']){if(Object.hasOwn(beforeCase,k))c[k]=beforeCase[k];else delete c[k];}c.stage='amendment_review';pendingAmendment=true;
  }
  c.revision++;const first=!c.greeted;c.greeted=true;let reply='',complaint=false;
  const products=c.applicants.map(P.productFor),hasUmrah=products.some(p=>p.code==='umrah');
  c.quote=P.calculateQuote(c,{feesEnabled:true});
  if(beforeCase.paymentStatus==='verified'&&beforeCase.quote&&(pendingAmendment||beforeFacts===afterFacts)&&c.quote?.total!==beforeCase.quote.total)c.quote=beforeCase.quote;
  const previousQuestion=c.lastQuestion,previousAsked=[...c.askedQuestions],completion=this.nextQuestion(c),nextQuestion=c.lastQuestion,nextAsked=[...c.askedQuestions];
  c.lastQuestion=previousQuestion;c.askedQuestions=previousAsked;
  const intent=({documents:'requirements',payment_after:'pay_after_issue',negotiation:'negotiate',bank:'bank_details',address:'address',payment:'payment_options'})[decision?.intent]||localIntent||decision?.intent;
  const documentStep=detectDocumentStep(n),quoteUnchanged=Boolean(beforeCase.quote&&c.quote&&JSON.stringify(beforeCase.quote)===JSON.stringify(c.quote));
  const priceRequested=/سعر|تكلفه|بكم|قديش|رسوم/.test(n)||intent==='price';
  const substantiveCaption=hasAttachments&&semanticText&&(/[؟?]|حسابك|حسابكم|حساب بنكي|الحساب البنكي|ايبان|\bbank\b|كيف احول|بدي احول|كيف ادفع|طرق الدفع/.test(n)||['price','bank_details','payment_options','payment_receipt','pay_after_issue','refund','cancel','address','courier','processing_time','visa_duration'].includes(intent));
  const intervention=reason=>{c.operatorIntervention={reason,at:this.now(),revision:c.revision};};
  if(hasUmrah&&P.umrahQuestion(text))reply=P.umrahConsultation(c.applicants.find(p=>P.productFor(p).code==='umrah'),{objection:true});
  else if(/(?:بدي|كيف|اريد|حابب|حابه|بدنا|بدنا ن|بدي ا).{0,12}(?:ثبت|تثبيت)|^(?:ثبت|ثبتلي|تثبيت)$/.test(n))reply=SERVICE.applicationStart(hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS);
  else if(/(?:رابط|لينك|link).{0,15}(?:دفع|pay)|(?:بدي|ارسل|ابعت|اريد|عطيني|ممكن).{0,15}(?:رابط|لينك)|^(?:رابط|لينك)$/.test(n)){intervention('payment_link');reply=SERVICE.response('link')+(c.quote&&!c.quote.requiresReview?'\n\n'+quoteText(c.quote):'');}
  else if(/تابي|tabby/.test(n)&&!/طرق|خيارات|وسائل/.test(n)){intervention('tabby');reply=SERVICE.response('tabby')+(c.quote&&!c.quote.requiresReview?'\n\n'+quoteText(c.quote):'');}
  else if(intent==='negotiate'||/خصم|تخفيض|ارخص|اخر سعر/.test(n)){intervention('discount');reply=SERVICE.response('discount')+'\n'+P.REFUND_BENEFIT;}
  else if(isComplaint(text)||intent==='complaint'){
   complaint=true;c.stage='complaint_pending';reply='منفهم انزعاجك، وبدنا نراجع الموضوع بدقة. رح أرفع المحادثة للإدارة لمراجعة المعاملة والدفعات المرتبطة فيها، من دون ما تحتاج تعيد التفاصيل.';
  }else if(relativeInquiry&&!operational)reply=relativeReply(c.pendingRelative,{question:text,group:/كمان بدن يقدمو|كمان بدهم يقدمو|هنن.*(?:يقدمو|يقدموا)/.test(n)});
  else if(pendingAmendment)reply='وصل طلب التعديل. لأن الدفعة مؤكدة أو المعاملة مقدمة، حفظنا التعديل للمراجعة مع القسم قبل اعتماده. بيانات المعاملة والدفعة الحالية بقيت محفوظة؛ ما تم تعديل تقديم أو احتساب دفعة جديدة تلقائياً.';
  else if(!first&&(/^(?:مرحبا|هلا|اهلا(?: وسهلا)?|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|هاي|hello|hi|صباح الخير|مساء الخير)[،,!؟?. 🌷]*$/i.test(n)))reply='أهلاً فيك 🌷 أنا معك، ومنكمل على نفس طلب التأشيرة.';
  else if(/عنوان|وين مكتب|مكان المكتب|موقع المكتب|location|address/.test(n))reply=SERVICE.OFFICE;
  else if(intent==='status'||/حاله الطلب|حاله المعامله|تم التقديم|تقدم الطلب|وصلت الدفعه/.test(n)){
   const verified=c.staffVerification||{},evidence=currentVisaEvidence(c);
   if(verified.decision&&verified.decision.caseSignature===evidence.signature)reply=(verified.decision.value||verified.decision)==='approved'?'بحسب تحديث القسم المسجل، صدر قرار الموافقة على طلبك. تسليم التأشيرة وتفاصيلها يكون من القسم المختص.':'بحسب تحديث القسم المسجل، صدر رفض رسمي لطلبك. تتم مراجعة الاسترداد وفق سياسة المكتب؛ لا يعني هذا أن التحويل المالي نُفّذ.';
   else if(c.submissionStatus==='submitted'&&evidence.submission)reply='بحسب تأكيد القسم المسجل، تم تقديم المعاملة فعلياً وهي بانتظار النتيجة. لا يوجد قرار مسجل حتى الآن.';
   else if(c.paymentStatus==='verified'&&evidence.payment)reply=SERVICE.response('processing');
   else if(c.paymentStatus==='verified'||c.submissionStatus==='submitted')reply=SERVICE.response('processing');
   else reply=SERVICE.response('update');
  }
  else if(/(?:دفع|بدفع|الدفع).{0,15}(?:بعد|لما|بس).{0,15}(?:اصدار|تطلع|تجهز|تصدر)|بعد الاصدار/.test(n)||intent==='pay_after_issue')reply='منفهم رغبتك، لكن التقديم عنا بيبدأ بعد استكمال الأوراق وتسديد الرسوم، وما عنا دفع بعد الإصدار. فيك تختار التحويل البنكي أو تطلب تفاصيل وسائل الدفع الأخرى.';
  else if(/(?:انا|نحن|نحنا).{0,15}(?:مقدم|قدمنا|قدمت)|متابعه معامل|وين معاملتي|طلعت معاملتي|طلعت الفيزا|شو صار بالطلب/.test(n)||intent==='existing_application')reply='لمتابعة معاملتك الحالية، تواصل حصراً من نفس الرقم اللي قدّمت منه ومع نفس رقم الشركة اللي استلم بياناتك. أقسامنا منفصلة، والقسم اللي قدّمت معه هو اللي بيقدر يراجع ملفك والدفعات المرتبطة فيه.';
  else if(/الغاء|الغي|كنسل|الغ[ىي]|بدي الغي|cancel/.test(n)||intent==='cancel'){
   c.cancellation={state:'awaiting_confirmation',feePerApplication:P.PRICES.cancellation,requestedAt:this.now()};
   reply='أكيد، فينا نراجع طلب الإلغاء. رسوم الإلغاء 200 درهم لكل معاملة ملغاة. قبل التأكيد لازم نتحقق من حالة التقديم والدفعات ونوضحلك المبلغ المسترد. هل تريد تسجيل طلب مراجعة الإلغاء؟ لم يتم إلغاء معاملة أو تنفيذ استرداد.';
  }else if(c.cancellation?.state==='awaiting_confirmation'&&/^(?:اي|نعم|تمام|اكد|اوافق|موافق)(?:\s.*)?$/.test(n)){
   c.cancellation.state='review_requested';c.stage='cancellation_review';reply='وصل تأكيدك، وسجلنا طلب مراجعة الإلغاء برسوم 200 درهم لكل معاملة ملغاة. يلزم مراجعة القسم لحالة المعاملة والمبلغ القابل للاسترداد قبل تنفيذ الإلغاء؛ لم يُنفّذ إلغاء أو تحويل مالي بعد.';
  }else if(hasAttachments&&!substantiveCaption||!hasAttachments&&/ارسل[ت]? (?:الجواز|الهويه|الاوراق)|بعت[ت]? (?:الجواز|الهويه|الاوراق)/.test(n)){
   if(!c.staffVerification?.documentsReviewed&&c.submissionStatus!=='submitted')c.stage='documents_pending_review';reply=SERVICE.response('received');
  }else if(/(?:حولت|دفعت|سددت|تم التحويل|ايصال|وصل التحويل)/.test(n)||intent==='payment_receipt'){
   if(c.paymentStatus==='verified')reply='الدفعة مؤكدة بالفعل من القسم بحسب السجل، شكراً إلك 🌷 ما في داعي تعيد التحويل. منتابع الخطوة التالية حسب حالة المعاملة.';
   else{c.paymentStatus='awaiting_verification';c.stage='payment_review';reply='شكراً إلك 🌷 رح نتحقق من وصول الدفعة للحساب قبل تأكيدها واستكمال الإجراء. إذا ما أرسلت إيصال التحويل، ابعته مع رقم طلبك إن وُجد. صورة الإيصال وحدها ما بتأكد وصول المبلغ.';}
  }else if(/حسابات|حسابك|حسابكم|حساب بنكي|الحساب البنكي|ايبان|iban|bank details|بدي احول|كيف احول/.test(n)||intent==='bank_details'){
   reply=SERVICE.response('bank');
  }else if(/رفض|مسترد|استرداد|ترجع المصاري|ترجعو الرسوم/.test(n)||intent==='refund')reply='من ميزات التقديم معنا: رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي، حسب شروط خدمتنا الموضحة قبل الدفع. هذا التزام من مكتبنا وليس وعداً برد الرسوم من السفارة. التأخير أو التعليق ليس رفضاً، والإلغاء بطلب العميل له رسوم 200 درهم للمعاملة. رسوم الدفع والزاجل والفندق تحتاج توضيحاً منفصلاً قبل الاتفاق.';
  else if(/كم يوم|قديش وقت|مده|مدة|متي تطلع|ايمت تطلع|بسرعه|مستعجل|بكرا|اليوم/.test(n)||intent==='processing_time')reply='المدة المعتادة حسب إجراءاتنا 6–7 أيام عمل، والإنجاز مرتبط بالسفارة. السبت والأحد والعطل المعتمدة ما بتنحسب ضمن أيام المعالجة. ما فينا نضمن الموافقة أو الصدور قبل موعد محدد. إذا سفرك قريب، شو تاريخ السفر؟';
  else if(/زاجل|توصيل|استلام الجواز|ابعت مندوب/.test(n)||intent==='courier')reply='فينا ننسّق استلام أصل الجواز والهوية عن طريق زاجل برسوم 35 درهماً، أو بتسلمهم بالمكتب. قبل ترتيب الاستلام منأكد معك نطاق الخدمة وهل الإعادة مشمولة؛ ما حُجز مندوب بعد.';
  else if(/كيف ادفع|طرق الدفع|طريقه الدفع|وسائل الدفع/.test(n)||intent==='payment_options')reply=SERVICE.response('payment');
  else if(/90|تسعين|مده الاقامه|مده الفيزا|كم شهر|كل دخول/.test(n)||intent==='visa_duration')reply='السياحية المتعددة في عرضنا صلاحيتها سنة، والإقامة تصل إلى 90 يوماً حسب شروط التأشيرة الصادرة. صلاحية السنة تختلف عن مدة الإقامة؛ ما منعتبر الـ90 يوماً تلقائياً لكل دخول. السفرة الواحدة والعمرة إلهم شروط مختلفة حسب التأشيرة الفعلية.';
  else if(documentStep==='will_send')reply='تمام، ابعتهن هون لما تجهز، ومنكمل على نفس طلبك.';
  else if(documentStep==='requirements'||documentStep==='apply'&&quoteUnchanged||/اوراق|مطلوب|مستندات|كيف اقدم|طريقه التقديم/.test(n)||intent==='requirements')reply=(hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS)+(completion?'\n\n'+completion:'\nابعتهن هون، ومنرتب المستندات قبل الخطوة التالية.');
  else if(/غالي|خصم|ارخص|زبط|نزل|فاصل|600|٦٠٠|650|٦٥٠/.test(n)||intent==='negotiate')reply='تكرم عينك 🌷 السعر المعتمد للسياحية 640 درهم للشخص. العمرة 850 درهماً للشخص. ما في خصم إضافي غير المعتمد، والتحويل البنكي بيوفر عليك رسوم طريقة الدفع.'+(c.quote?'\n\n'+quoteText(c.quote):products.some(p=>['suspended','unverified'].includes(p.code))?'':'\n\n'+P.REFUND_BENEFIT);
  else if(/برجع|بعدين|وقت تاني|مو هلق|لاحقا|بفكر/.test(n)||intent==='goodbye')reply='أهلاً وسهلاً فيك بأي وقت 🌷 بس تكون جاهز ابعتلنا، ومنكمل من آخر نقطة وصلنالها.';
  else if(/^(?:شكرا|شكراً|يسلمو|مشكور|تسلم)[!. 🌷]*$/.test(n)||intent==='thanks')reply='أهلاً وسهلاً فيك، بالخدمة دائماً 🌷';
  else if(/منتظر|ناطر|بانتظار|جاري/.test(n)||intent==='waiting')reply='شكراً لانتظارك 🌷 تفاصيلك موجودة معنا. '+(c.stage==='documents_pending_review'?'المستندات بانتظار المراجعة، ومنأكدلك الخطوة التالية بعد التحقق.':completion||'إذا حابب نكمل، فينا نرتب مراجعة الأوراق وطريقة الدفع.');
  else if(products.some(p=>p.code==='suspended'))reply='حسب حالة التقديم الحالية لدى مكتبنا، التقديم لهذه الجنسية متوقف حالياً. ما رح نطلب منك دفع أو نعطيك وعد بموعد فتح قبل وجود تحديث معتمد.';
  else if(products.some(p=>p.code==='unverified')&&c.applicants[0]?.nationality){intervention('untrained_request');reply='حتى أعطيك مسار تقديم دقيق، رح أراجع هالجنسية أو الوثيقة مع المسؤول ونرجعلك. ما منطلب منك دفع قبل التحقق 🌷';}
  else if((intent==='other'||!intent)&&!priceRequested&&semanticText&&!documentStep&&afterFacts===beforeFacts&&!/^(?:(?:فيزا|تاشيره)(?: السعوديه)?|سلام|مرحبا|هلا|اهلا|السلام عليكم)[؟?!. ]*$/.test(n)){intervention('untrained_request');reply=SERVICE.response('unknown');}
  else if(completion){
   const price=priceRequested;
   const known=products[0];
   reply=(price?'السياحية 640 درهم للشخص، والعمرة 850 درهماً.\n\n'+P.REFUND_BENEFIT+'\n\n':known?.code==='umrah'?P.UMRAH_ROUTE+' التكلفة 850 درهم، والتقديم بأصل الجواز وأصل الهوية. ':known?.code==='tourist_single'?EGYPT_SINGLE_COPY+' ':'')+completion;
  }else{
   if(!c.staffVerification?.decision&&c.submissionStatus!=='submitted'&&c.paymentStatus!=='verified')c.stage=c.paymentStatus==='awaiting_verification'?'payment_review':'quoted';c.lastQuestion=null;
   if(quoteUnchanged&&!priceRequested&&afterFacts===beforeFacts&&!c.quote?.requiresReview)reply=SERVICE.response('processing');
   else{
    reply=hasUmrah&&c.applicantCount===1?P.umrahConsultation(c.applicants.find(p=>P.productFor(p).code==='umrah')):quoteText(c.quote);
    if(c.quote?.requiresReview){c.stage='pricing_review';intervention('untrained_request');}
    else if(!(hasUmrah&&c.applicantCount===1))reply+='\n\n'+(hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS)+'\n\n⏱️ المدة المعتادة 6–7 أيام عمل حسب السفارة، دون ضمان للموافقة أو موعد الصدور.\n\n'+(hasUmrah?'خلّينا نبدأ بالخطوة المناسبة إلك 🌷 بتفضّل تسلّم أصل الجواز والهوية بالمكتب، أو ننسّق استلامهم عبر زاجل برسوم 35 درهماً؟':'خلّينا نبدأ بخطوة بسيطة 🌷 ابعت صور المستندات المطلوبة هون، ومنراجعها معك قبل استكمال التقديم.');
   }
  }
  const compoundInfo=[[/كم يوم|قديش وقت|متى تطلع|ايمت تطلع|مدة المعالجة|مده المعالجه/.test(n)||intent==='processing_time','المدة المعتادة 6–7 أيام عمل حسب السفارة؛ السبت والأحد والعطل لا تُحتسب، دون ضمان لموعد الصدور.'],[/زاجل|توصيل|استلام الجواز|ابعت مندوب/.test(n)||intent==='courier','فينا ننسّق استلام أصول المستندات عبر زاجل برسوم 35 درهماً بعد تأكيد نطاق الخدمة؛ لم يُحجز مندوب.'],[/كيف ادفع|طرق الدفع|وسائل الدفع/.test(n)||intent==='payment_options',SERVICE.response('payment')],[/مده الاقامه|مده الفيزا|كم شهر|كل دخول/.test(n)||intent==='visa_duration','صلاحية السياحية المتعددة سنة، والإقامة تصل إلى 90 يوماً حسب التأشيرة الصادرة؛ السفرة الواحدة والعمرة تختلف شروطهما.'],[/اوراق|مطلوب|مستندات/.test(n)||intent==='requirements',hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS]].filter(([yes])=>yes);
  if(!hasAttachments&&compoundInfo.length&&(afterFacts!==beforeFacts||compoundInfo.length>1||priceRequested)&&(!intent||['processing_time','courier','payment_options','visa_duration','requirements','price'].includes(intent)))reply=[...compoundInfo.map(([,copy])=>copy),c.quote&&(priceRequested||afterFacts!==beforeFacts)?quoteText(c.quote):null,completion].filter(Boolean).join('\n\n');
  if(completion&&reply.includes(completion)){c.lastQuestion=nextQuestion;c.askedQuestions=nextAsked;}
  if(first)reply=INTRO+'\n\n'+reply;
  c.history.push({role:'user',text:(hasAttachments?'[attachment received]'+(semanticText?' '+semanticText:''):redactVisaText(text)).slice(0,1500)},{role:'assistant',text:redactVisaText(reply).slice(0,2500)});c.history=c.history.slice(-16);
  this.save(id,c);return{reply,complaint,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage,quote:c.quote};
 }
}
module.exports={SaudiVisaEngine,extractLocal,mergeFacts,countFrom,isComplaint,quoteText};
