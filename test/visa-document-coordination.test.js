'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createVisaDocumentConversation}=require('../src/visa-document-conversation');
const P=require('../src/saudi-visa-policy');
const SERVICE=require('../src/remal-service-policy');
const CUSTOMER='15550004444',NOW=1000000;
function fixture({status='not_started',nationality='سوريا',documentType='passport',summary:extra={},media=false}={}){
 const current={id:'case-one',createdAt:NOW-1000,revision:4,applicantCount:1,applicants:[{nationality,documentType}],paymentStatus:'unverified',submissionStatus:'not_submitted'};
 current.quote=P.calculateQuote(current);
 const summary={caseId:current.id,status,applicants:[],issues:[],...extra},store={data:{visaCases:{[CUSTOMER]:current}},save(){}};
 if(media)store.data.visaMedia={source:{id:'source',customer:CUSTOMER,type:'image',mimeType:'image/jpeg',receivedAt:NOW-500,expiresAt:NOW+1000}};
 let links=0;
 const app=createVisaDocumentConversation({operatorCoordination:true,store,now:()=>NOW,documentIntake:{summary:()=>summary},createUploadLink:async()=>({url:'https://remal.example.test/documents#private-'+(++links)})});
 return {app,current,summary,store,links:()=>links};
}

test('operator coordination answers document requirements and reuses an explicitly requested upload link',async()=>{
 for(const status of ['not_started','processing','needs_review','waiting_case','disabled']){
  const f=fixture({status,summary:status==='needs_review'?{applicants:[{evidenceId:'placeholder',documents:{passport:null,residence:null,photo:null},issues:[{code:'PASSPORT_MISSING'}]}],issues:[{code:'RESIDENCE_MISSING'}]}:{}}),before=structuredClone(f.current);
  const first=await f.app.handle(CUSTOMER,'شو الأوراق المطلوبة؟');
  assert.equal(first.handled,true,status);assert.match(first.reply,/صفحة بيانات الجواز كاملة/);assert.match(first.reply,/وجهي الهوية الإماراتية/);assert.match(first.reply,/صورة شخصية واضحة بخلفية بيضاء/);
  assert.doesNotMatch(first.reply,/https:|عم نتابعه|رقم الطلب بعد|تم تقديم|تم الدفع|640|850/);assert.equal(f.links(),0);
  const upload=await f.app.handle(CUSTOMER,'ارسل رابط رفع المستندات');assert.match(upload.reply,/https:\/\/remal\.example\.test\/documents#private-1/);
  const second=await f.app.handle(CUSTOMER,'كيف بقدم شو ابعتلك');
  assert.match(second.reply,/صفحة بيانات الجواز/);assert.match(second.reply,/رابط الرفع اللي أرسلته قبل شوي/);assert.doesNotMatch(second.reply,/https:/);assert.equal(f.links(),1);
  assert.deepEqual(f.current,before);
 }
});

test('Umrah, mixed groups and unqualified cases defer to the visa policy without offering digital completion',async()=>{
 for(const type of ['umrah','document','mixed','unqualified','suspended']){
  const f=fixture({nationality:type==='umrah'?'فلسطين':type==='suspended'?'أفغانستان':'سوريا',documentType:type==='document'?'travel_document':'passport'});
  if(type==='mixed'){f.current.applicantCount=2;f.current.applicants.push({nationality:'فلسطين',documentType:'travel_document'});f.current.quote=P.calculateQuote(f.current);}
  if(type==='unqualified')f.current.quote=null;
  const before=structuredClone(f.current),result=await f.app.handle(CUSTOMER,'شو الأوراق المطلوبة؟');
  assert.deepEqual(result,{handled:false},type);assert.equal(f.links(),0);assert.deepEqual(f.current,before);
 }
});

test('a text-only claim of sending documents never becomes evidence of receipt or processing',async()=>{
 for(const text of ['أرسلت لكم الأوراق','بعتلك الأوراق','تم إرسال الأوراق'])for(const status of ['not_started','processing','needs_review']){
  const f=fixture({status,summary:status==='needs_review'?{applicants:[{evidenceId:'placeholder',documents:{},issues:[{code:'PASSPORT_MISSING'}]}]}:{}}),before=structuredClone(f.current);
  const result=await f.app.handle(CUSTOMER,text);
  assert.equal(result.handled,true,text);assert.match(result.reply,/لسه ما تأكد وصول المستندات/);assert.match(result.reply,/قبل ما نطلب منك تعيدها/);assert.doesNotMatch(result.reply,/وصلت أوراقك|أوراقك محفوظة|عم نتابعه|رقم الطلب|تم تقديم|تم استلام/);assert.equal(f.links(),0);assert.deepEqual(f.current,before);
 }
});

test('real saved documents preserve coordinated status without asking for all files or reopening uploads',async()=>{
 for(const status of ['not_started','processing','needs_review','needs_confirmation','ready']){
  const f=fixture({status,media:true}),before=structuredClone(f.current);
  for(const text of ['شو الأوراق المطلوبة؟','أرسلت لكم الأوراق','شو صار معكن']){
   const result=await f.app.handle(CUSTOMER,text);assert.equal(result.handled,true);assert.equal(result.reply,SERVICE.response('processing'));assert.doesNotMatch(result.reply,/صفحة بيانات الجواز|ابعث|ابعت|رابط|مكتمل|تم تقديم/);
  }
  assert.equal(f.links(),0);assert.deepEqual(f.current,before);
 }
});

test('prepared documents and current intake work count as evidence, stale and other-customer jobs do not',async()=>{
 for(const mode of ['prepared','current','old-case','other-customer','stale','wrong-signature','unknown-status']){
  const f=fixture({status:'processing'});
  if(mode==='wrong-signature')f.summary.caseSignature='current-signature';
  if(mode==='prepared')f.summary.applicants=[{documents:{passport:'private-prepared-id'}}];
  else f.store.data.visaDocumentIntake={jobs:{job:{customer:mode==='other-customer'?'15550005555':CUSTOMER,caseId:mode==='old-case'?'old-case':f.current.id,mediaId:'private-source-id',status:mode==='stale'?'stale':mode==='unknown-status'?'invented':'running',...(mode==='wrong-signature'?{caseSignature:'old-signature'}:{})}}};
  const result=await f.app.handle(CUSTOMER,'شو الأوراق المطلوبة؟');
  if(['prepared','current'].includes(mode)){assert.equal(result.reply,SERVICE.response('processing'));assert.equal(f.links(),0);}
 else{assert.match(result.reply,/صفحة بيانات الجواز/);assert.equal(f.links(),0);}
  assert.doesNotMatch(result.reply,/private-prepared-id|private-source-id|running/);
 }
});

test('coordinated identity mismatch remains generic without exposing private data or prompting unbound field choices',async()=>{
 const f=fixture({status:'needs_review',summary:{issues:[{code:'CASE_DATA_MISMATCH',field:'nationalityCode',message:'PRIVATE_NATIONALITY'}],applicants:[{fields:{passportNumber:'PRIVATE_PASSPORT'},issues:[{code:'DOCUMENT_FIELD_REQUIRED',field:'passportType'}]}]}}),before=structuredClone(f.current);
 for(const text of ['شو الأوراق المطلوبة؟','أرسلت لكم الأوراق']){
  const result=await f.app.handle(CUSTOMER,text);assert.equal(result.reply,SERVICE.response('processing'));assert.doesNotMatch(result.reply,/PRIVATE|لنفس الشخص|شخص تاني|نوع جواز السفر|القائمة|CASE_DATA/);
 }
 assert.equal(f.links(),0);assert.deepEqual(f.current,before);
});

test('an older case summary cannot suppress the current checklist or confirm old documents as received',async()=>{
 for(const media of [false,true]){
  const f=fixture({media,summary:{caseId:'old-case',status:'ready',sourceCount:3,applicants:[{documents:{passport:'old-private-passport',residence:'old-private-residence',photo:'old-private-photo'}}]}}),before=structuredClone(f.current);
  const result=await f.app.handle(CUSTOMER,'شو الأوراق المطلوبة؟');
  if(media){assert.equal(result.reply,SERVICE.response('processing'));assert.equal(f.links(),0);}
 else{assert.match(result.reply,/صفحة بيانات الجواز/);assert.equal(f.links(),0);}
  assert.doesNotMatch(result.reply,/old-private|أوراقك جاهزة/);assert.deepEqual(f.current,before);
 }
 const f=fixture({summary:{caseId:'old-case',status:'ready',sourceCount:3,applicants:[{documents:{passport:'old-private-passport'}}]}});
 const claim=await f.app.handle(CUSTOMER,'أرسلت لكم الأوراق');assert.match(claim.reply,/لسه ما تأكد وصول المستندات/);
});

test('operator coordination keeps prepared previews bound to actual accepted delivery',async()=>{
 const f=fixture({status:'needs_review'}),calls=[];
 const app=createVisaDocumentConversation({operatorCoordination:true,store:f.store,documentIntake:{summary:()=>f.summary},sendPrepared:async(...args)=>{calls.push(args);return {accepted:true,messageId:'actual-preview',preview:true};}});
 const result=await app.handle(CUSTOMER,'ادمج صور الهوية',{requestId:'actual-inbound'});
 assert.equal(result.preview,true);assert.equal(result.sent,true);assert.match(result.reply,/نسخة للمعاينة/);assert.doesNotMatch(result.reply,/نهائية|تم التقديم|private/);
 assert.deepEqual(calls,[[CUSTOMER,{kind:'residence',intent:'merge',requestId:'actual-inbound'}]]);
});
