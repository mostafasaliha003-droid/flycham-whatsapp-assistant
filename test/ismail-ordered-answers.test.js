'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {visaCaseSignature}=require('../src/visa-case-signature');
const NOW=Date.parse('2026-11-08T16:30:00Z');
const make=()=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{VISA_TOURIST_AGE_PRICING:'on'},privateConfig:{banks:[]},now:()=>NOW});
async function qualified(e,id){await e.handle(id,'سوري جواز عادي لحالي وعمري 52 سنة');return visaCaseSignature(e.getCase(id));}

test('one reply answers price, timing and documents in customer order, including transcribed speech',async()=>{
 const e=make(),id='ordered',signature=await qualified(e,id);let calls=0;e.understand=async()=>{calls++;return null;};
 const text='كم السعر، كم يوم بتاخد، وشو الأوراق؟';
 const r=await e.handle(id,text,{messages:[{text,voiceTranscript:true}]});
 const indexes=['640 درهم','6–7 أيام عمل','نسخة جواز'].map(part=>r.reply.indexOf(part));
 assert.ok(indexes[0]>=0&&indexes[0]<indexes[1]&&indexes[1]<indexes[2],r.reply);
 assert.equal((r.reply.match(/نسخة جواز/g)||[]).length,1);
 assert.equal(calls,0);assert.equal(visaCaseSignature(e.getCase(id)),signature);
});

test('interest in applying does not hide the quoted price or start a payment or submission',async()=>{
 const e=make(),id='apply',signature=await qualified(e,id);
 const r=await e.handle(id,'بدي أقدم، كم السعر وقديش وقت؟');
 assert.match(r.reply,/640.*6–7 أيام عمل/s);assert.doesNotMatch(r.reply,/IBAN|بعد التحويل|تم تقديم/);
 const c=e.getCase(id);assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');assert.equal(visaCaseSignature(c),signature);
});

test('a timing question uses its date as a deadline without changing the stated departure',async()=>{
 const e=make(),id='deadline';await qualified(e,id);await e.handle(id,'سفري 20/11/2026');
 const before=visaCaseSignature(e.getCase(id));
 const r=await e.handle(id,'كم السعر وبتطلع بكرا؟');
 assert.match(r.reply,/640.*2026-11-09.*يوم عمل واحد.*الوقت ضيق/s);
 assert.doesNotMatch(r.reply,/شو تاريخ السفر/);assert.equal(e.getCase(id).departureDate,'2026-11-20');assert.equal(visaCaseSignature(e.getCase(id)),before);
 const ambiguous=await e.handle(id,'بتلحق الخميس أو الجمعة؟');
 assert.match(ambiguous.reply,/شو تاريخ السفر الكامل/);assert.doesNotMatch(ambiguous.reply,/2026-11-20/);assert.equal(visaCaseSignature(e.getCase(id)),before);
 for(const [text,date] of [['لو قدمت اليوم بتطلع الخميس؟','2026-11-12'],['لو قدمت بكرا بتطلع الجمعة؟','2026-11-13']]){
  const conditional=await e.handle(id,text);assert.match(conditional.reply,new RegExp(date));assert.equal(visaCaseSignature(e.getCase(id)),before);
 }
});

test('a new travel date is acknowledged with the timing risk and does not repeat the quote',async()=>{
 const e=make(),id='travel';await qualified(e,id);await e.handle(id,'كم يوم بتاخد؟');
 const r=await e.handle(id,'سفري 10/11/2026');
 assert.equal(e.getCase(id).departureDate,'2026-11-10');
 assert.match(r.reply,/2026-11-10.*يومين عمل.*الوقت ضيق/s);assert.doesNotMatch(r.reply,/640|صور المستندات/);
});

test('a compound deadline and an incomplete price ask only one missing question',async()=>{
 const e=make(),id='one-question';await e.handle(id,'سوري جواز عادي لحالي');
 const r=await e.handle(id,'كم السعر وبتطلع قبل سفري؟');
 assert.match(r.reply,/640.*6–7/s);assert.equal((r.reply.match(/[؟?]/g)||[]).length,1);
 assert.equal(e.getCase(id).lastQuestion,'age_0');assert.equal(e.getCase(id).departureDate,undefined);
});
