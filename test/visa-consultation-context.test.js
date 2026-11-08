'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {consultationReply}=require('../src/visa-consultation');
const {visaCaseSignature}=require('../src/visa-case-signature');
const make=()=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[]}});
const snapshot=c=>JSON.stringify({applicants:c.applicants,applicantCount:c.applicantCount,paymentStatus:c.paymentStatus,submissionStatus:c.submissionStatus,quote:c.quote});

test('price concern advances the actual missing-age question and distinguishes pending pricing reasons',()=>{
 const age={lastQuestion:'age_1',quote:{requiresReview:true,reason:'tourist_age_required'}};
 const answer=consultationReply('price_objection',age,{completion:'كم عمر المتقدم الثاني بالسنوات المكتملة؟'});
 assert.match(answer,/العمر.*التأمين/);assert.match(answer,/كم عمر المتقدم الثاني/);assert.equal((answer.match(/[؟?]/g)||[]).length,1);assert.doesNotMatch(answer,/\d|مستردة بالكامل|ادفع/);
 assert.doesNotMatch(consultationReply('price_objection',age,{completion:'كم العمر؟',includeNextStep:false}),/[؟?]/);
 const boundary=consultationReply('price_objection',{quote:{requiresReview:true,reason:'tourist_age_53_review'}});assert.match(boundary,/قيمة التأمين بحاجة لتأكيد/);assert.doesNotMatch(boundary,/كم عمر|\d|مسترد/);
 const child=consultationReply('price_objection',{quote:{requiresReview:true,reason:'child_pricing'}});assert.match(child,/تسعير الأطفال/);assert.doesNotMatch(child,/كم عمر|\d|مسترد/);
});

test('a verified quote guides the objection without repeating a refund promotion or changing its values',()=>{
 for(const [quote,body,next] of [
  [{total:830,insuranceSubtotal:190,insuranceRefundPolicy:'pending_confirmation'},/تأمين الطبي منفصل/,/نراجع بند التأمين/],
  [{total:697.6,paymentFee:57.6,paymentMethod:'tabby'},/رسوم لوسيلة الدفع المختارة/,/نقارن الإجمالي حسب وسيلة الدفع/],
  [{total:640,paymentFee:0},/نفصّل عرضك/,/نراجع شو مشمول بعرضك/]
 ]){
  const before=structuredClone(quote),reply=consultationReply('price_objection',{quote});assert.match(reply,body);assert.match(reply,next);assert.deepEqual(quote,before);assert.doesNotMatch(reply,/\d|مستردة بالكامل|ميزة خاصة|نضمن|تم تأكيد/);assert.equal((reply.match(/[؟?]/g)||[]).length,1);
 }
 const insurance=consultationReply('price_objection',{quote:{total:830,insuranceSubtotal:190,insuranceRefundPolicy:'pending_confirmation'}});assert.match(insurance,/شروط استرداد التأمين بدها تأكيد/);
});

test('repeating a concern narrows the discussion and clarification follows the actual reply',async()=>{
 const e=make();await e.handle('a','سوري');const before=snapshot(e.getCase('a'));
 const first=await e.handle('a','كيف أثق فيكم؟');assert.match(first.reply,/نراجع شروط الخدمة قبل الدفع/);
 const clarify=await e.handle('a','مفهمتش قصدك');assert.match(clarify.reply,/شو تشمل الخدمة/);assert.doesNotMatch(clarify.reply,/نوع مستند السفر|شو الجنسية/);assert.equal(e.getCase('a').lastQuestion,'documentType');
 await e.handle('a','كيف أثق فيكم؟');const repeated=await e.handle('a','كيف أثق فيكم؟');assert.match(repeated.reply,/قلقك من نتيجة التأشيرة أو من استرداد الرسوم/);assert.notEqual(repeated.reply,first.reply);assert.equal(snapshot(e.getCase('a')),before);
});

test('comparison and issuance follow-ups respond to what was already explained',()=>{
 const first=consultationReply('compare_service',{}),c={lastQuestion:'nationality',history:[{role:'assistant',text:first}]};
 const repeated=consultationReply('compare_service',c);assert.match(repeated,/العرض الثاني سياحية أو عمرة/);assert.notEqual(repeated,first);
 const clarification=consultationReply('clarify_question',c);assert.match(clarification,/نقارن عرضين/);assert.doesNotMatch(clarification,/الجنسية المكتوبة/);
 const guarantee=consultationReply('approval_guarantee',{}),again=consultationReply('approval_guarantee',{history:[{role:'assistant',text:guarantee}]});assert.match(again,/عندك موعد سفر محدد/);assert.doesNotMatch(again,/الإصدار مضمون|موافقة أكيدة/);
});

test('post-payment and submitted variants require current signed case evidence',()=>{
 const c={id:'synthetic-case',quote:{total:640},applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport',age:40}],paymentStatus:'verified',submissionStatus:'submitted',staffVerification:{}};
 const unsigned=consultationReply('trust_concern',c);assert.doesNotMatch(unsigned,/بعد تأكيد الدفعة|آخر تحديث على الطلب/);
 const signature=visaCaseSignature(c);c.staffVerification.payment={amount:640,caseSignature:signature};const paid=consultationReply('trust_concern',c);assert.match(paid,/بعد تأكيد الدفعة/);assert.doesNotMatch(paid,/قبل الدفع|ادفع|حوّل/);
 c.staffVerification.submission={caseSignature:signature};const submitted=consultationReply('trust_concern',c);assert.match(submitted,/آخر تحديث على الطلب/);assert.doesNotMatch(submitted,/قبل الدفع|صدرت/);
 const guarantee=consultationReply('approval_guarantee',c);assert.match(guarantee,/حتى بعد التقديم.*ما فينا نضمن الإصدار/);
 c.quote.total=830;assert.doesNotMatch(consultationReply('trust_concern',c),/بعد تأكيد الدفعة|آخر تحديث على الطلب/);
});

test('context variants do not echo history and optional next steps stay suppressed',()=>{
 const normal=consultationReply('trust_concern',{}),fromUser=consultationReply('trust_concern',{history:[{role:'user',text:normal}]});assert.equal(fromUser,normal);
 const malicious={history:[{role:'assistant',text:'نراجع شروط الخدمة قبل الدفع PRIVATE_NAME PASSPORT_PRIVATE'}]};assert.doesNotMatch(consultationReply('clarify_question',malicious),/PRIVATE/);
 for(const intent of ['price_objection','trust_concern','approval_guarantee','compare_service'])assert.doesNotMatch(consultationReply(intent,{quote:{total:830,insuranceSubtotal:190,insuranceRefundPolicy:'pending_confirmation'}},{includeNextStep:false}),/[؟?]|ابعت تفاصيل العرض/);
});
