'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine,countFrom,extractLocal}=require('../src/saudi-visa-engine');
const make=options=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[]},...options});
const qualified=async options=>{const e=make(options);await e.handle('customer','سوري جواز عادي لحالي');return e;};
const facts=c=>({applicants:c.applicants,applicantCount:c.applicantCount,hasMinors:c.hasMinors,transport:c.transport,departureDate:c.departureDate,returnDate:c.returnDate,paymentMethod:c.paymentMethod,paymentStatus:c.paymentStatus,submissionStatus:c.submissionStatus,quote:c.quote});

test('unbounded family words never manufacture applicants or a group price, even with a guessed model count',async()=>{
 for(const text of ['أنا وأهلي','أنا وعيالي','أنا وأولادي','أنا وعيلتي','أنا وعائلتي']){
  assert.equal(countFrom(text),null,text);
  const e=make({understand:async()=>({intent:'apply',fields:{nationality:'سوريا',documentType:'passport',applicantCount:3,applicants:[{nationality:'سوريا'},{nationality:'سوريا'},{nationality:'سوريا'}]}})});
  await e.handle('customer',text+' سوريين جواز عادي');
  assert.equal(e.getCase('customer').applicantCount,null,text);assert.equal(e.getCase('customer').quote,null,text);
 }
});

test('mixed families preserve spoken order, document type and each document issuer locally and with semantic extraction',async()=>{
 const text='أنا سوري جواز عادي وزوجتي فلسطينية وثيقة لبنانية';
 const expected=[{nationality:'سوريا',documentType:'passport'},{nationality:'فلسطين',documentType:'travel_document',documentIssuer:'لبنان'}];
 assert.deepEqual(extractLocal(text,{}).applicants,expected);
 for(const understand of [null,async()=>({intent:'apply',target:'group',fields:{applicantCount:2,applicants:expected}})]){
  const e=make({understand});await e.handle('customer',text);assert.deepEqual(e.getCase('customer').applicants,expected);assert.equal(e.getCase('customer').quote.total,1490);
 }
 const reverse='أنا فلسطيني وثيقة لبنانية وزوجتي سورية جواز عادي';assert.deepEqual(extractLocal(reverse,{}).applicants,[expected[1],expected[0]]);
});

test('hypothetical comparisons cannot amend a qualified or paid application even when the model extracts them',async()=>{
 for(const paid of [false,true]){
  const e=await qualified();if(paid)e.getCase('customer').paymentStatus='verified';const before=structuredClone(facts(e.getCase('customer')));
  e.understand=async()=>({intent:'price',target:'group',correction:true,fields:{nationality:'مصر',documentType:'travel_document',applicantCount:2,applicants:[{nationality:'مصر',documentType:'travel_document'}],travelMode:'car',departureDate:'2026-12-10'}});
  for(const text of ['لو كنت مصري ومعي وثيقة قديش السعر؟','افترض أنا وزوجتي مصريين شو الرسوم؟','إذا سافرت بالسيارة يوم 10/12/2026 نفس الشروط؟']){
   await e.handle('customer',text);assert.deepEqual(facts(e.getCase('customer')),before,text);assert.equal(e.getCase('customer').pendingAmendment,undefined,text);
  }
 }
});

test('negated dialect declarations cannot replace identity or mark an unreported transfer',async()=>{
 for(const text of ['أنا مو مصري','أنا مش مصري','أنا مب مصري','ماني مصري','ما معي وثيقة سفر','مش معايا وثيقة سفر']){
  const e=await qualified(),before=structuredClone(facts(e.getCase('customer')));await e.handle('customer',text);assert.deepEqual(facts(e.getCase('customer')),before,text);
 }
 for(const text of ['لسه ما حولت','أنا ما دفعت','مادفعت بعد','إذا حولت بكرا شو بصير؟','لو دفعت على البنك بتبلشوا؟','هل دفعت أنا؟']){
  const e=await qualified();e.understand=async()=>({intent:'payment_receipt',fields:{}});await e.handle('customer',text);assert.equal(e.getCase('customer').paymentStatus,'unverified',text);assert.notEqual(e.getCase('customer').stage,'payment_review',text);
 }
 const e=await qualified();await e.handle('customer','مو سوري، أنا مصري');assert.equal(e.getCase('customer').applicants[0].nationality,'مصر');
});

test('negative cancellation and fee questions never create cancellation intent; unrelated acceptance cannot confirm an old request',async()=>{
 for(const text of ['ما بدي ألغي','مش عاوز ألغي','ما أبي ألغي','لا أريد إلغاء','ما اشتي الغي','كم رسوم الإلغاء؟','لو بدي ألغي شو الشروط؟']){
  const e=await qualified();e.understand=async()=>({intent:'cancel',fields:{}});await e.handle('customer',text);assert.equal(e.getCase('customer').cancellation,undefined,text);
 }
 const e=await qualified();await e.handle('customer','بدي الغي');await e.handle('customer','ما بدي الغي');assert.equal(e.getCase('customer').cancellation.state,'withdrawn');
 await e.handle('customer','بدي الغي');await e.handle('customer','كم يوم بتحتاج الفيزا؟');await e.handle('customer','تمام');assert.equal(e.getCase('customer').cancellation.state,'awaiting_confirmation');assert.notEqual(e.getCase('customer').stage,'cancellation_review');
 await e.handle('customer','بدي الغي');await e.handle('customer','نعم');assert.equal(e.getCase('customer').cancellation.state,'review_requested');
});

test('semantic understanding receives actual awaited field, travel dates and bounded conversation history',async()=>{
 const e=await qualified();const c=e.getCase('customer');c.departureDate='2026-12-10';c.returnDate='2026-12-20';c.lastQuestion='documentType_1';c.applicantCount=2;c.applicants.push({nationality:'مصر'});
 c.history=Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',text:'context '+i}));let received;
 e.understand=async(_text,context)=>{received=context;return {intent:'other',fields:{}};};await e.handle('customer','عادي');
 assert.equal(received.awaiting,'documentType_1');assert.equal(received.lastQuestion,'documentType_1');assert.equal(received.departureDate,'2026-12-10');assert.equal(received.returnDate,'2026-12-20');assert.equal(received.history.length,16);assert.deepEqual(received.applicants,[{nationality:'سوريا',documentType:'passport'},{nationality:'مصر'}]);
});

test('asserted action clauses retain punctuation and beat negated payment or discount choices',async()=>{
 for(const text of ['خلاص بدي الغي','خلاص الغي']){const e=await qualified();await e.handle('customer',text);assert.equal(e.getCase('customer').cancellation.state,'awaiting_confirmation',text);}
 const english=await qualified();english.understand=async()=>({intent:'payment_receipt',fields:{}});await english.handle('customer','I paid.');assert.equal(english.getCase('customer').paymentStatus,'awaiting_verification');
 const bank=await qualified();await bank.handle('customer','ما بدي تابي، حولت بنكي');assert.equal(bank.getCase('customer').paymentStatus,'awaiting_verification');assert.notEqual(bank.getCase('customer').operatorIntervention?.reason,'tabby');
 const link=await qualified();const answer=await link.handle('customer','مش عايز رابط دفع، عايز حساب البنك');assert.notEqual(link.getCase('customer').operatorIntervention?.reason,'payment_link');assert.doesNotMatch(answer.reply,/ننسّق لك رابط/);
 const discount=await qualified();await discount.handle('customer','ما بدي خصم، بدي أعرف الأوراق');assert.notEqual(discount.getCase('customer').operatorIntervention?.reason,'discount');
});

test('Unicode languages and short numeric answers reach semantic understanding without admitting bare private identifiers',async()=>{
 for(const text of ['मेरा पासपोर्ट साधारण है','Мой паспорт обычный','२','٣','2']){
  let received;const e=make({understand:async(value)=>{received=value;return {intent:'other',fields:{}};}});await e.handle('customer',text);assert.equal(received,text,text);
 }
 let calls=0;const e=make({understand:async()=>{calls++;return {intent:'other',fields:{}};}});await e.handle('customer','784199000000001');assert.equal(calls,0);
});
