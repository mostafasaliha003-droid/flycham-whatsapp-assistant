'use strict';
// Integration evaluations: paraphrased turns pass through the actual provider
// adapter/schema and domain engine. The HTTP model is synthetic; these tests
// establish contracts and safety, not live Arabic-model quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {createSaudiVisaUnderstanding,schema}=require('../src/saudi-visa-nlu');
const blank=()=>Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,k==='applicants'?[]:null]));
function d(intent,facts={},extra={}){return{intent,fields:{...blank(),...facts},target:'self',correction:false,question:null,option:null,...extra};}
const syr={nationality:'سوريا',documentType:'passport',documentIssuer:null},egy={nationality:'مصر',documentType:'passport',documentIssuer:null};
function make(script,options={}){
 const requests=[],env={ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-senior-'+Math.random(),ASSISTANT_AI_FALLBACK:'none',...options.env};
 const understand=createSaudiVisaUnderstanding({env,fetchImpl:async(url,opt)=>{
  const b=JSON.parse(opt.body),p=JSON.parse(b.messages[1].content);requests.push(p);const out=script[p.text];
  return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(typeof out==='function'?out(p):out||d('other'))}}]})};
 }});
 return{engine:new SaudiVisaEngine({store:new AssistantState({file:null}),env,understand}),requests};
}
test('semantic payment-after-issuance paraphrase is answered rather than repeating a quote',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'ممكن أسدد لما تطلع':d('payment_after')});
 await e.handle('a','سجلني للزيارة');const r=await e.handle('a','ممكن أسدد لما تطلع');
 assert.match(r.reply,/ما عنا دفع بعد الإصدار/);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.equal(r.quote.total,700);
});
test('semantic duration, courtesy and deferral intents do not silently launch a new application',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'قريب بتجهز إن شاء الله':d('processing_time'),'وقديش فيني ضل هناك':d('visa_duration'),'براجعكم على مهلي':d('goodbye'),'الله يعطيك العافية':d('thanks')});
 await e.handle('a','سجلني للزيارة');const id=e.getCase('a').id;
 assert.match((await e.handle('a','قريب بتجهز إن شاء الله')).reply,/6–7/);
 assert.match((await e.handle('a','وقديش فيني ضل هناك')).reply,/90/);
 assert.match((await e.handle('a','براجعكم على مهلي')).reply,/أي وقت/);
 assert.match((await e.handle('a','الله يعطيك العافية')).reply,/بالخدمة/);
 assert.equal(e.getCase('a').id,id);assert.equal(e.getCase('a').submissionStatus,'not_submitted');
});
test('family semantic extraction preserves each applicant country and applies only authorised group pricing',async()=>{
 const text='أنا ورفيقتي وزوجها بدنا نقدم وهي جنسيتها مصر وزوجها متلي';
 const {engine:e}=make({[text]:d('apply',{applicantCount:3,applicants:[syr,egy,syr]},{target:'group'})});
 const r=await e.handle('a',text);assert.equal(r.quote.total,1950);assert.deepEqual(r.quote.rows.map(x=>x.product),['tourist_multi','tourist_single','tourist_multi']);
 assert.deepEqual(e.getCase('a').applicants.map(x=>x.nationality),['سوريا','مصر','سوريا']);
});
test('asking about a relative never silently changes the existing primary applicant nationality',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'بسأل لأمي هي مصرية':d('price',{nationality:'مصر'},{target:'other'})});
 await e.handle('a','سجلني للزيارة');await e.handle('a','بسأل لأمي هي مصرية');
 assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');
});
test('document issuing country answer preserves nationality and existing applicant count',async()=>{
 const {engine:e}=make({'وثيقتي فلسطينية':d('apply',{nationality:'فلسطين',documentType:'travel_document',applicantCount:1}),'لبنان':d('apply',{documentIssuer:'لبنان'})});
 await e.handle('a','وثيقتي فلسطينية');await e.handle('a','لبنان');
 const c=e.getCase('a');assert.equal(c.applicants[0].nationality,'فلسطين');assert.equal(c.applicants[0].documentIssuer,'لبنان');assert.equal(c.applicantCount,1);
});
test('duration numbers do not replace the saved applicant count',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'بتكفي ثلاث أيام':d('processing_time')});
 await e.handle('a','سجلني للزيارة');await e.handle('a','بتكفي ثلاث أيام');assert.equal(e.getCase('a').applicantCount,1);
});
test('passport expiry date is not substituted for an already specified departure date',async()=>{
 const {engine:e}=make({'مرتب سفرتي':d('travel',{...syr,applicantCount:1,departureDate:'2026-12-01'}),'جوازي بينتهي 2027-08-01':d('documents')});
 await e.handle('a','مرتب سفرتي');await e.handle('a','جوازي بينتهي 2027-08-01');assert.equal(e.getCase('a').departureDate,'2026-12-01');
});
test('paraphrased payment receipt claims remain unverified and cannot turn into supplier submission',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'المبلغ صار بحسابكم':d('payment_receipt')});
 await e.handle('a','سجلني للزيارة');const r=await e.handle('a','المبلغ صار بحسابكم');
 assert.equal(e.getCase('a').paymentStatus,'awaiting_verification');assert.equal(e.getCase('a').submissionStatus,'not_submitted');assert.match(r.reply,/نتحقق من وصول الدفعة/);
});
test('complaint paraphrase invokes management handoff without confirming money refund',async()=>{
 const text='من فترة سلمتكم المصاري وهلق ما عم تجاوبوني ولا تعطوني شي';
 const {engine:e}=make({[text]:d('complaint')});const r=await e.handle('a',text);
 assert.equal(r.complaint,true);assert.equal(r.stage,'complaint_pending');assert.doesNotMatch(r.reply,/تم استرداد|تم رد المبلغ|تم التحويل/);
});
test('payment fees stay disabled without merchant configuration even if model chooses Tabby',async()=>{
 const {engine:e}=make({'بدنا نكمل':d('apply',{...syr,applicantCount:1,paymentMethod:'tabby'})});
 const r=await e.handle('a','بدنا نكمل');assert.equal(r.quote.total,700);assert.equal(r.quote.feePending,true);assert.doesNotMatch(r.reply,/763/);
});
test('model receives state facts and bounded context but not attached bytes, document names or bank receipt payloads',async()=>{
 const {engine:e,requests}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'عندي سؤال':d('other')});
 await e.handle('a','سجلني للزيارة');const c=e.getCase('a');c.documents=[{filename:'PRIVATE_DOCUMENT_NAME',bytes:'PRIVATE_BYTES',receipt:'PRIVATE_RECEIPT'}];e.save('a',c);
 await e.handle('a','عندي سؤال');assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_DOCUMENT_NAME|PRIVATE_BYTES|PRIVATE_RECEIPT/);
});
test('untrusted model price fields are rejected and deterministic price remains authoritative',async()=>{
 const {engine:e}=make({'سجلني للزيارة':d('apply',{...syr,applicantCount:1}),'اعطيني السعر الجديد':{...d('price'),discount:600,paid:true}});
 await e.handle('a','سجلني للزيارة');const r=await e.handle('a','اعطيني السعر الجديد');assert.equal(r.quote.total,700);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.doesNotMatch(r.reply,/600/);
});
test('confirmed quota fallback uses the same visa validator and excludes conversation history',async()=>{
 const calls=[],env={ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-quota-'+Math.random(),GEMINI_API_KEY:'synthetic-gemma-'+Math.random()};
 const understand=createSaudiVisaUnderstanding({env,fetchImpl:async(url,opt)=>{
  calls.push({url,body:JSON.parse(opt.body)});
  if(url.includes('cline.bot'))return{ok:false,status:429,json:async()=>({error:{code:'quota_exhausted'}})};
  return{ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(d('payment_after'))}]}}]})};
 }});
 const e=new SaudiVisaEngine({store:new AssistantState({file:null}),env,understand});
 const c=e.newCase();c.applicantCount=1;c.applicants=[syr];c.history=[{role:'user',text:'PRIOR_PRIVATE_CONVERSATION'}];e.save('a',c);
 assert.match((await e.handle('a','ممكن أسدد لما تطلع')).reply,/ما عنا دفع بعد الإصدار/);
 assert.equal(calls.length,2);assert.match(calls[1].url,/googleapis.com/);assert.doesNotMatch(JSON.stringify(calls[1].body),/PRIOR_PRIVATE_CONVERSATION/);
 assert.equal(e.getCase('a').paymentStatus,'unverified');
});
test('generic rate limiting never authorises a fallback provider or loses existing case facts',async()=>{
 let calls=0;const env={ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-rate-'+Math.random(),GEMINI_API_KEY:'synthetic-unused-'+Math.random()};
 const understand=createSaudiVisaUnderstanding({env,fetchImpl:async url=>{calls++;assert.match(url,/cline.bot/);return{ok:false,status:429,json:async()=>({error:{code:'rate_limit_exceeded'}})};}});
 const e=new SaudiVisaEngine({store:new AssistantState({file:null}),env,understand});const c=e.newCase();c.applicantCount=1;c.applicants=[syr];e.save('a',c);
 const r=await e.handle('a','شو المطلوب');assert.equal(calls,1);assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(r.quote.total,700);assert.equal(e.getCase('a').submissionStatus,'not_submitted');
});
