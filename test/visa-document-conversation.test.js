'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createVisaDocumentConversation,detectDocumentIntent,detectDocumentStep,statusReply}=require('../src/visa-document-conversation');
const P=require('../src/saudi-visa-policy');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {visaCaseSignature}=require('../src/visa-case-signature');
const CUSTOMER='15550004444';
const ready=()=>({caseId:'case-one',status:'ready',applicants:[{applicantIndex:0,documents:{passport:'prepared-passport',residence:'prepared-residence',photo:'prepared-photo'}}],issues:[]});
const make=(summary,options={})=>createVisaDocumentConversation({documentIntake:{summary:()=>summary},...options});

test('received-document followups use actual saved attachments instead of repeating the requirements',async()=>{
 const stamp=1000000,c={id:'case-one',createdAt:stamp-1000,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'verified'};c.quote=P.calculateQuote(c);
 const media=Object.fromEntries(Array.from({length:5},(_,i)=>['source-'+i,{id:'source-'+i,customer:CUSTOMER,type:'image',mimeType:'image/jpeg',receivedAt:stamp-100,expiresAt:stamp+100000}]));
 const store={data:{visaCases:{[CUSTOMER]:c},visaMedia:media},save(){}},before=structuredClone(c);
 for(const status of ['not_started','processing','needs_review','ready']){
  const summary={caseId:c.id,status,applicants:status==='ready'?ready().applicants:[],issues:status==='needs_review'?[{code:'DOCUMENT_UNASSIGNED'}]:[]};
  const conversation=make(summary,{store,now:()=>stamp});
  for(const text of ['طيب شو المطلوب','الأوراق بعتلك ياهن','الأوراق بعتلك ياهن؟ مو كاملين ؟','مو كاملين ؟','شو صار معكن']){
   const result=await conversation.handle(CUSTOMER,text);
   assert.equal(result.handled,true,text+' '+status);assert.match(result.reply,/أوراقك|منكمل مراجعتها/);assert.doesNotMatch(result.reply,/للبداية ابعت|وجهي الهوية الإماراتية|للتقديم السياحي أونلاين بنحتاج|لم تصل|تم التقديم|دفعة/);
   if(status!=='ready')assert.doesNotMatch(result.reply,/اكتمل تجهيز/);
  }
 }
 assert.deepEqual(c,before);
});

test('short completeness questions need a current document context and do not capture future sends or edits',()=>{
 assert.equal(detectDocumentIntent('مو كاملين ؟'),null);
 assert.equal(detectDocumentIntent('شو صار معكن'),null);
 assert.equal(detectDocumentIntent('عدل رقم جوازي الناقص'),null);
 assert.equal(detectDocumentIntent('بدي ابعت الأوراق'),null);
 assert.deepEqual(detectDocumentIntent('رح ابعتلك الأوراق'),{intent:'will_send',kind:null});
});

test('document actions distinguish kind and ignore ordinary visa, insurance and requirements messages',()=>{
 for(const [text,intent,kind]of [['ادمج صور الهوية','merge','residence'],['اجمع صورتين الجواز بصورة واحدة','merge','passport'],['حسن جودة صورة الجواز','enhance','passport'],['وضحلي صورتي الشخصية','enhance','photo'],['ابعثلي نسخة الهوية المجهزة','send_prepared','residence'],['send me my passport image','send_prepared','passport'],['هل قرأت الصور؟','status',null],['ارسل رابط رفع المستندات','upload_link',null]])assert.deepEqual(detectDocumentIntent(text),{intent,kind},text);
 for(const text of ['شو جودة الصورة المطلوبة؟','رابط الدفع','ارسل رابط التأمين','ادمج الاسعار','عدل رقم جوازي','لا تدمج صور الجواز','بدي ابعت صورة جوازي'])assert.equal(detectDocumentIntent(text),null,text);
 for(const text of ['بدي قدم فيزا','شو المستندات المطلوبة؟'])assert.deepEqual(detectDocumentIntent(text),{intent:'prepare_application',kind:null},text);
 assert.deepEqual(detectDocumentIntent('ادمجهم',{hasAttachments:true}),{intent:'merge',kind:null});assert.equal(detectDocumentIntent('ادمجهم'),null);
  for(const text of ['تم رفع المستندات','تم ارسال الاوراق','رفعت الصور'])assert.deepEqual(detectDocumentIntent(text),{intent:'status',kind:null});assert.equal(detectDocumentIntent('تم'),null);
});
test('processing replies reflect actual reading state and never claim completed editing or image delivery',async()=>{
 let sent=0;const app=make({status:'processing',applicants:[]},{sendPrepared:async()=>{sent++;return {accepted:true,messageId:'accepted'};}});
 const result=await app.handle(CUSTOMER,'ادمج صور الجواز',{hasAttachments:true,requestId:'actual-inbound'});
 assert.equal(result.handled,true);assert.match(result.reply,/عم نجهّز ملفك/);assert.doesNotMatch(result.reply,/أرسلت|تم الدمج|حسنت/);assert.equal(sent,0);
});
test('prepared delivery passes actual inbound request id and only confirms accepted provider send',async()=>{
 const calls=[],app=make(ready(),{sendPrepared:async(...args)=>{calls.push(args);return {accepted:true,messageId:'wamid.real-acceptance'};}});
 const result=await app.handle(CUSTOMER,'ابعثلي نسخة الهوية المجهزة',{requestId:'wamid.actual-inbound'});
 assert.deepEqual(calls,[[CUSTOMER,{kind:'residence',intent:'send_prepared',requestId:'wamid.actual-inbound'}]]);assert.equal(result.sent,true);assert.match(result.reply,/أرسلت لك النسخة المجهزة/);assert.doesNotMatch(result.reply,/wamid|prepared/);
});
test('Meta acceptance shape also permits truthful confirmation and arbitrary success boolean does not',async()=>{
 assert.equal((await make(ready(),{sendPrepared:async()=>({messages:[{id:'wamid.accepted'}]})}).handle(CUSTOMER,'ارسل صورة الجواز')).sent,true);
 for(const response of [{ok:true},{sent:true},{accepted:true},{accepted:true,messageId:'bad id'},{dryRun:true,messages:[{id:'fake'}]},{paused:true,messages:[{id:'fake'}]},{uncertain:true,messages:[{id:'fake'}]}]){
  const result=await make(ready(),{sendPrepared:async()=>response}).handle(CUSTOMER,'ارسل صورة الجواز');assert.notEqual(result.sent,true);assert.doesNotMatch(result.reply,/أرسلت لك/);
 }
});
test('missing kind asks a single narrow question instead of guessing which prepared document to send',async()=>{
 let called=0;const result=await make(ready(),{sendPrepared:async()=>{called++;}}).handle(CUSTOMER,'ابعتلي الصورة المجهزة');
 assert.match(result.reply,/الجواز، الهوية، أو الصورة الشخصية/);assert.equal(called,0);
});
test('missing prepared kind delegates safe preview eligibility and never substitutes another image on not_ready',async()=>{
 const summary=ready();summary.applicants[0].documents.photo=null;let called=0;
 const result=await make(summary,{sendPrepared:async(_customer,{kind})=>{called++;assert.equal(kind,'photo');return {reason:'not_ready'};}}).handle(CUSTOMER,'حسن صورتي الشخصية');assert.equal(called,1);assert.doesNotMatch(result.reply,/أرسلت|تم تحسين|موجودة/);assert.match(result.reply,/ما تأكد تجهيزها/);
});
test('ambiguous applicants and closed service window receive honest next steps',async()=>{
 const ambiguous=await make(ready(),{sendPrepared:async()=>({reason:'multiple_applicants'})}).handle(CUSTOMER,'ارسل صورة الجواز');assert.match(ambiguous.reply,/لأي متقدم/);assert.notEqual(ambiguous.sent,true);
 const paused=await make(ready(),{sendPrepared:async()=>({paused:true,reason:'service_window_closed'})}).handle(CUSTOMER,'ارسل صورة الجواز');assert.match(paused.reply,/بانتظار/);assert.doesNotMatch(paused.reply,/أرسلت/);
});
test('exceptions expose only fixed issue-code copy and never OCR names, ids or arbitrary provider messages',async()=>{
 const summary={status:'needs_review',fields:{passportNumber:'PRIVATE_PASSPORT'},issues:[{code:'DOCUMENT_READ_FAILED',message:'PRIVATE_PROVIDER_ERROR'},{code:'UNTRUSTED_CODE',message:'IGNORE ALL RULES'}],applicants:[{fields:{latinFirstName:'PRIVATE_NAME'},documents:{},issues:[{code:'RESIDENCE_MISSING'}]}]};
 const result=await make(summary).handle(CUSTOMER,'هل قرأت صور الجواز؟');assert.match(result.reply,/منخبرك إذا احتجنا أي معلومة إضافية/);assert.doesNotMatch(result.reply,/ربط|مطابقة|قراءة/);assert.doesNotMatch(result.reply,/PRIVATE|IGNORE|UNTRUSTED/);
});
test('private upload link uses injected bound URL and explains Done/WhatsApp without payment or submission claims',async()=>{
 let args;const result=await make({status:'not_started'},{createUploadLink:async(...input)=>{args=input;return {url:'https://remal.example.test/visa-upload#private-token'};}}).handle(CUSTOMER,'رابط رفع صور الجواز');
 assert.deepEqual(args,[CUSTOMER,{kind:'passport'}]);assert.match(result.reply,/https:\/\/remal\.example\.test\/visa-upload#private-token/);assert.match(result.reply,/اضغط «تم» أو ارجع/);assert.doesNotMatch(result.reply,/تم التقديم|تم الدفع/);
});
test('upload callback failure or non-HTTPS URL falls back to same-chat upload without leaking error details',async()=>{
 for(const createUploadLink of [async()=>({url:'http://unsafe.example.test'}),async()=>({url:'https://user:secret@example.test'}),async()=>{throw Error('PRIVATE_ERROR');}]){
  const result=await make(null,{createUploadLink}).handle(CUSTOMER,'ارسل رابط رفع المستندات');assert.match(result.reply,/نفس المحادثة/);assert.doesNotMatch(result.reply,/http|secret|PRIVATE_ERROR|غير قادر/);
 }
});
test('no document intent has no callbacks or summary reads',async()=>{
 let calls=0;const app=createVisaDocumentConversation({documentIntake:{summary(){calls++;throw Error('unexpected');}},createUploadLink:async()=>{calls++;}});
 assert.deepEqual(await app.handle(CUSTOMER,'بعتلي حسابك البنكي'),{handled:false});assert.equal(calls,0);
});
test('fixed status copy does not imply accountant approval, official filing or all-family consent',()=>{
 for(const status of ['ready','needs_confirmation','processing','needs_review','not_started'])assert.doesNotMatch(statusReply({...ready(),status}),/تم تأكيد استلام دفعتك|تم تقديم|صدرت التأشيرة|أرسلت/);
});
test('short pronouns and document progress questions require document context and explicit application status remains separate',()=>{
 for(const text of ['ادمجهم','حسنها','ارسلها','خلصت؟','جهزتهم؟']){
  assert.equal(detectDocumentIntent(text),null,text);
  assert.ok(detectDocumentIntent(text,{hasDocumentContext:true}),text);
 }
 for(const text of ['تم','خلصت التأشيرة؟','خلصت طلب الفيزا؟','حسن الأسعار','ادمج التأمين مع السعر','خلصت الحجز؟'])assert.equal(detectDocumentIntent(text,{hasDocumentContext:true}),null,text);
});
test('photo turn establishes minimal role context and a following pronoun preserves that role without raw caption storage',async()=>{
 const summary=ready(),store={data:{serviceSessions:{[CUSTOMER]:{service:'saudi_visa'}}},save(){}},calls=[];
 const app=make(summary,{store,sendPrepared:async(...args)=>{calls.push(args);return {accepted:true,messageId:'wamid.preview',preview:true};}});
 assert.deepEqual(await app.handle(CUSTOMER,'صورة الهوية',{hasAttachments:true,requestId:'wamid.photo'}),{handled:false});
 const result=await app.handle(CUSTOMER,'حسنها',{requestId:'wamid.followup'});
 assert.equal(result.handled,true);assert.equal(result.preview,true);assert.match(result.reply,/نسخة للمعاينة/);assert.doesNotMatch(result.reply,/نهائي|تم التقديم|تمت المطابقة/);
 assert.deepEqual(calls,[[CUSTOMER,{kind:'residence',intent:'enhance',requestId:'wamid.followup'}]]);
 const state=store.data.serviceSessions[CUSTOMER].documentConversation;assert.deepEqual(Object.keys(state).sort(),['caseId','pendingIntent','lastKind','expiresAt','uploadOfferedAt'].sort());assert.equal(state.lastKind,'residence');assert.equal(state.pendingIntent,null);assert.equal(store.data.serviceSessions[CUSTOMER].service,'saudi_visa');
 assert.doesNotMatch(JSON.stringify(state),/صورة|wamid|preview/);
});
test('generic merge question persists its pending role across factory restart and exact role answer resumes actual latest inbound',async()=>{
 const store={data:{serviceSessions:{}},save(){}},calls=[],options={store,sendPrepared:async(...args)=>{calls.push(args);return {accepted:true,messageId:'wamid.accepted'};}};
 const first=make(ready(),options),question=await first.handle(CUSTOMER,'ادمجهم',{requestId:'wamid.first'});
 assert.match(question.reply,/أي نسخة/);assert.equal(store.data.serviceSessions[CUSTOMER].documentConversation.pendingIntent,'merge');assert.equal(calls.length,0);
 const restarted=make(ready(),options),answer=await restarted.handle(CUSTOMER,'الهوية',{requestId:'wamid.actual-role-answer'});
 assert.equal(answer.sent,true);assert.equal(answer.intent,'merge');assert.equal(answer.kind,'residence');assert.deepEqual(calls,[[CUSTOMER,{kind:'residence',intent:'merge',requestId:'wamid.actual-role-answer'}]]);
 assert.equal(store.data.serviceSessions[CUSTOMER].documentConversation.pendingIntent,null);
});
test('pending role in Map fallback resumes send request but a bare role without a pending action does not send',async()=>{
 const calls=[],app=make(ready(),{sendPrepared:async(...args)=>{calls.push(args);return {messages:[{id:'wamid.accepted'}]};}});
 assert.deepEqual(await app.handle(CUSTOMER,'الهوية',{requestId:'wamid.no-request'}),{handled:false});
 await app.handle(CUSTOMER,'ابعتلي الصورة المجهزة',{requestId:'wamid.ask'});
 const result=await app.handle(CUSTOMER,'الجواز',{requestId:'wamid.answer'});assert.equal(result.sent,true);assert.equal(calls[0][1].kind,'passport');assert.equal(calls[0][1].requestId,'wamid.answer');
});
test('changed case and expired context discard pending role instead of sending from an old request',async()=>{
 for(const change of ['case','expiry']){
  let summary=ready(),clock=100000,calls=0;const store={data:{serviceSessions:{}},save(){}},app=createVisaDocumentConversation({store,now:()=>clock,documentIntake:{summary:()=>summary},sendPrepared:async()=>{calls++;return {accepted:true,messageId:'bad'};}});
  await app.handle(CUSTOMER,'ابعتلي الصورة المجهزة',{requestId:'wamid.ask'});
  if(change==='case')summary={...ready(),caseId:'case-two'};else clock+=15*60*1000+1;
  assert.deepEqual(await app.handle(CUSTOMER,'الهوية',{requestId:'wamid.answer'}),{handled:false});assert.equal(calls,0);assert.equal(store.data.serviceSessions[CUSTOMER].documentConversation,undefined);
 }
});
test('unrelated conversation clears pending image selection and generic Done never becomes image consent',async()=>{
 for(const text of ['بعتلي حسابك البنكي','تم','بدّي حجز طيران']){
  let calls=0;const app=make(ready(),{sendPrepared:async()=>{calls++;return {accepted:true,messageId:'bad'};}});
  await app.handle(CUSTOMER,'ابعتلي الصورة المجهزة',{requestId:'wamid.ask'});assert.deepEqual(await app.handle(CUSTOMER,text,{requestId:'wamid.other'}),{handled:false});
  assert.deepEqual(await app.handle(CUSTOMER,'الهوية',{requestId:'wamid.role'}),{handled:false});assert.equal(calls,0);
 }
});
test('settled reading with incomplete identity can return an actual preview without asserting matched final documents',async()=>{
 const summary={caseId:'case-one',status:'needs_review',applicants:[],issues:[{code:'PASSPORT_MISSING'}]},calls=[];
 const result=await make(summary,{sendPrepared:async(...args)=>{calls.push(args);return {accepted:true,messageId:'wamid.preview',preview:true,combined:true};}}).handle(CUSTOMER,'ادمج صور الهوية',{requestId:'wamid.merge'});
 assert.equal(calls.length,1);assert.equal(result.sent,true);assert.equal(result.preview,true);assert.match(result.reply,/نسخة للمعاينة/);assert.match(result.reply,/نسخة للمعاينة قبل استخدامها بالطلب/);assert.doesNotMatch(result.reply,/نهائية|تم التقديم|اكتملت.*مطابقة/);
});
test('unknown or failing preview result retains truthful exception copy instead of claiming a prepared image exists',async()=>{
 const summary={caseId:'case-one',status:'needs_review',applicants:[],issues:[{code:'PASSPORT_MISSING'}]};
 for(const sendPrepared of [async()=>({reason:'delivery_uncertain'}),async()=>{throw Error('PRIVATE_ERROR');}]){
  const result=await make(summary,{sendPrepared}).handle(CUSTOMER,'ادمج صور الهوية',{requestId:'wamid.merge'});assert.match(result.reply,/ما قدرت ابعت النسخة هلأ/);assert.match(result.reply,/أوراقك محفوظة معنا/);assert.doesNotMatch(result.reply,/أرسلت|موجودة|PRIVATE_ERROR/);
 }
});
test('actual apply/how-to/will-send sequence offers one private link and never repeats known quote or rotates the opened link',async()=>{
 let at=1000000,links=0;const store={data:{},save(){}},engine=new SaudiVisaEngine({store,now:()=>at,env:{},privateConfig:{banks:[]}});
 const initial=await engine.handle(CUSTOMER,'سوري جواز عادي لحالي');assert.match(initial.reply,/700/);const before=structuredClone(engine.getCase(CUSTOMER)),signature=visaCaseSignature(before);
 const summary={status:'not_started',caseId:before.id,applicants:[],issues:[]},conversation=createVisaDocumentConversation({store,now:()=>at,documentIntake:{summary:()=>summary},createUploadLink:async()=>({url:'https://remal.example.test/documents#private-'+(++links)})});
 const replies=[];
 for(const text of ['هلا، بدي قدم فيزا السعودية لو سمحت','كيف بقدم شو ابعتلك','طيب رح ابعتلك']){
  const c=engine.getCase(CUSTOMER),result=await conversation.handle(CUSTOMER,text,{requestId:'wamid-'+replies.length});assert.equal(result.handled,true,text);replies.push(result.reply);engine.recordDocumentTurn(CUSTOMER,text,result.reply,{caseId:c.id,expectedRevision:c.revision});at+=1000;
 }
 assert.match(replies[0],/صفحة بيانات الجواز/);assert.match(replies[0],/وجهي الهوية الإماراتية/);assert.match(replies[0],/https:\/\/remal\.example\.test/);
 assert.match(replies[1],/رابط الرفع اللي أرسلته قبل شوي/);assert.doesNotMatch(replies[1],/https:/);assert.match(replies[2],/^تمام، ابعتهن هون/);assert.ok(replies[2].length<160);assert.equal(links,1);
 assert.doesNotMatch(replies.join('\n'),/700|650|إجمالي رسوم|عرض تأشيرات|تم تأكيد.*دفعتك|تم تقديم الطلب/);assert.equal(visaCaseSignature(engine.getCase(CUSTOMER)),signature);assert.deepEqual(engine.getCase(CUSTOMER).quote,before.quote);assert.equal(engine.getCase(CUSTOMER).paymentStatus,'unverified');
 const context=store.data.serviceSessions[CUSTOMER].documentConversation;assert.equal(context.caseId,before.id);assert.ok(Number.isFinite(context.uploadOfferedAt));assert.doesNotMatch(JSON.stringify(context),/https|private-|token|الجواز/);
 const fresh=await conversation.handle(CUSTOMER,'ارسل رابط رفع جديد');assert.match(fresh.reply,/https:/);assert.equal(links,2);
});
test('existing five original attachments are acknowledged once without requesting all files again or calling unassigned pages missing',async()=>{
 const stamp=1000000,current={id:'case-one',createdAt:stamp-1000,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'unverified'};current.quote=P.calculateQuote(current);
 const source=(id,patch={})=>({id,customer:CUSTOMER,type:'image',mimeType:'image/jpeg',receivedAt:stamp-500,expiresAt:stamp+100000,...patch});
 const media=Object.fromEntries(Array.from({length:5},(_,index)=>['source-'+index,source('source-'+index)]));
 Object.assign(media,{derived:source('derived',{purpose:'visa_client_preview'}),staged:source('staged',{purpose:'visa_upload_staged'}),old:source('old',{receivedAt:stamp-2000}),expired:source('expired',{expiresAt:stamp-1}),receipt:source('receipt'),other:source('other',{customer:'15550005555'})});
 const store={data:{visaCases:{[CUSTOMER]:current},visaMedia:media,visaFulfilment:{cases:{[CUSTOMER]:{receipts:{receipt:{}}}}}},save(){}},summary={caseId:'case-one',status:'needs_review',applicants:[],issues:[{code:'PASSPORT_MISSING'},{code:'DOCUMENT_UNASSIGNED'}]};
 const result=await make(summary,{store,now:()=>stamp,createUploadLink:async()=>({url:'https://remal.example.test/documents#bound'})}).handle(CUSTOMER,'كيف بقدم شو ابعتلك');
 assert.match(result.reply,/أوراقك|منكمل مراجعتها/);assert.match(result.reply,/أوراقك محفوظة معنا/);assert.doesNotMatch(result.reply,/إعادة إرسال|اعد ارسال|ابعت الصور/);assert.doesNotMatch(result.reply,/بقيت صورة صفحة بيانات الجواز|للبداية ابعت|وجهي الهوية/);assert.doesNotMatch(result.reply,/رابط ملفك|إذا بدك تضيف صورة ناقصة/);
});
test('qualified will-send variants are short and never create upload capabilities',async()=>{
 const current={id:'case-one',createdAt:1,applicantCount:1,applicants:[{nationality:'مصر',documentType:'passport'}]};current.quote=P.calculateQuote(current);let links=0;
 const store={data:{visaCases:{[CUSTOMER]:current}},save(){}},conversation=make({caseId:'case-one',status:'not_started',applicants:[],issues:[]},{store,createUploadLink:async()=>{links++;return {url:'https://remal.example.test/documents#should-not-create'};}});
 for(const text of ['طيب رح ابعتلك','تمام رح ابعت','ابعتلك الاوراق']){assert.equal(detectDocumentStep(text),'will_send');const result=await conversation.handle(CUSTOMER,text);assert.equal(result.handled,true);assert.match(result.reply,/^تمام/);assert.ok(result.reply.length<160);assert.doesNotMatch(result.reply,/http|700|الجواز|الإماراتية/);}
 assert.equal(links,0);
});
test('qualification, original-document products, fees and personal answers remain outside proactive upload',async()=>{
 for(const nationality of ['فلسطين','أفغانستان']){
  const current={id:'case-one',createdAt:1,applicantCount:1,applicants:[{nationality,documentType:'passport'}]};current.quote=P.calculateQuote(current);let links=0;
  const result=await make({caseId:'case-one',status:'not_started',applicants:[],issues:[]},{store:{data:{visaCases:{[CUSTOMER]:current}},save(){}},createUploadLink:async()=>{links++;}}).handle(CUSTOMER,'بدي قدم فيزا');assert.deepEqual(result,{handled:false});assert.equal(links,0);
 }
 for(const text of ['كيف بقدم وقديش السعر','شو ابعتلك للتأمين','شو ابعتلك عن حالتي الصحية','بدي قدم وبعتلي حسابك البنكي'])assert.equal(detectDocumentStep(text),null,text);
 let links=0;const unqualified=await make({status:'not_started',applicants:[],issues:[]},{createUploadLink:async()=>{links++;}}).handle(CUSTOMER,'بدي قدم فيزا');assert.deepEqual(unqualified,{handled:false});assert.equal(links,0);
});
test('proactive upload failure keeps the useful next step without invented URLs or external error details',async()=>{
 const current={id:'case-one',createdAt:1,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}]};current.quote=P.calculateQuote(current);
 const result=await make({status:'not_started',caseId:'case-one',applicants:[],issues:[]},{store:{data:{visaCases:{[CUSTOMER]:current}},save(){}},createUploadLink:async()=>{throw Error('PRIVATE_PROVIDER_ERROR');}}).handle(CUSTOMER,'كيف بقدم شو ابعتلك');
 assert.match(result.reply,/صفحة بيانات الجواز/);assert.match(result.reply,/الهوية الإماراتية/);assert.doesNotMatch(result.reply,/http|PRIVATE|غير قادر|700/);
});

 test('matched existing documents continue internally without asking customer to teach staff or reopening uploads',async()=>{
 const c={id:'case-one',createdAt:1,applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'unverified'};c.quote=P.calculateQuote(c);
 const before=structuredClone(c),store={data:{visaCases:{[CUSTOMER]:c},visaMedia:{original:{id:'original',customer:CUSTOMER,type:'image',mimeType:'image/jpeg',receivedAt:2,expiresAt:9999999999999}}},save(){}},summary={...ready(),status:'needs_confirmation'};let links=0;
 const result=await make(summary,{store,createUploadLink:async()=>{links++;throw Error('must not open upload');}}).handle(CUSTOMER,'بدي قدم فيزا');
 assert.equal(result.handled,true);assert.equal(links,0);assert.match(result.reply,/منخبرك إذا احتجنا أي معلومة إضافية/);assert.doesNotMatch(result.reply,/رح نطلب منك تأكيدها|https:|رابط الرفع|تم تقديم|تم استلام دفعتك/);assert.deepEqual(c,before);
 });
