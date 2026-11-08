'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {consultationIntent,consultationReply,CONSULTATION_INTENTS}=require('../src/visa-consultation');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const make=()=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{VISA_TOURIST_AGE_PRICING:'on'},privateConfig:{banks:[]}});
const facts=c=>structuredClone({applicants:c.applicants,applicantCount:c.applicantCount,paymentStatus:c.paymentStatus,submissionStatus:c.submissionStatus,quote:c.quote});

test('short practical questions reuse clarification without intercepting specific or negated questions',()=>{
 assert.equal(CONSULTATION_INTENTS.length,6);
 for(const text of ['من وين بلش؟','شو الخطوة الجاية؟','طيب، وش الخطوة التالية؟','أبدأ منين؟','ايه اعمل بعد كده؟','شو المانع؟','طيب ايش المانع؟'])assert.equal(consultationIntent(text),'clarify_question',text);
 for(const text of ['شو المانع إذا جوازي منتهي؟','شو المانع من إلغاء الطلب؟','ما بدي أعرف من وين بلش؛ بدي أعرف متى بترجع المصاري؟','ما بدي بلش هلق، بس شو الخطوة الجاية؟'])assert.equal(consultationIntent(text),null,text);
});

test('next step and blocker questions use the pending fact or review without declaring eligibility',()=>{
 const c={lastQuestion:'documentType',history:[{role:'assistant',text:'بتحب نراجع شروط الخدمة قبل الدفع؟'}]};
 const next=consultationReply('clarify_question',c,{text:'من وين بلش؟',completion:'معه جواز سفر عادي أو وثيقة سفر؟',nextQuestion:'documentType'});
 assert.match(next,/جواز سفر عادي أو وثيقة سفر/);assert.doesNotMatch(next,/شروط الخدمة|الرسوم|المسؤول/);
 const blocker=consultationReply('clarify_question',c,{text:'شو المانع؟'});assert.match(blocker,/نوع مستند السفر/);assert.doesNotMatch(blocker,/مرفوض|ممنوع|مؤهل|ما في مانع/);
 const relative={...c,pendingRelative:{awaiting:'documentIssuer',facts:{nationality:'مصر',documentType:'travel_document'}}},before=structuredClone(relative);
 const answer=consultationReply('clarify_question',relative,{text:'شو الخطوة الجاية؟',completion:'كم عمرك؟',nextQuestion:'age_0'});
 assert.match(answer,/البلد اللي أصدر وثيقة السفر/);assert.doesNotMatch(answer,/كم عمرك/);assert.deepEqual(relative,before);
 for(const [quote,expected] of [[{requiresReview:true,reason:'tourist_age_53_review'},/قيمة التأمين/],[{requiresReview:true,reason:'child_pricing'},/تسعير الأطفال/],[{insuranceRefundPolicy:'pending_confirmation'},/شروط استرداد التأمين/]]){
  const answer=consultationReply('clarify_question',{quote},{text:'شو المانع؟'});assert.match(answer,expected);assert.doesNotMatch(answer,/\d|مؤهل|ضمان الموافقة|حول الآن/);
 }
 assert.match(consultationReply('clarify_question',{}, {text:'شو المانع؟'}),/ما عندي سبب منع موثّق/);
});

test('practical progress replies require current evidence and never infer payment from text',()=>{
 const c={id:'synthetic-practical',applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport',age:40}],quote:{total:640},paymentStatus:'verified',submissionStatus:'submitted',staffVerification:{}};
 const options={text:'شو الخطوة الجاية؟'};
 assert.doesNotMatch(consultationReply('clarify_question',c,options),/الدفعة مؤكدة|آخر تحديث مسجّل على الطلب/);
 c.staffVerification.payment={caseSignature:visaCaseSignature(c),amount:640};
 assert.match(consultationReply('clarify_question',c,options),/الدفعة مؤكدة.*اكتمال المستندات/);
 c.staffVerification.submission={caseSignature:visaCaseSignature(c)};
 assert.match(consultationReply('clarify_question',c,options),/آخر تحديث مسجّل على الطلب/);
 c.quote.total=830;assert.doesNotMatch(consultationReply('clarify_question',c,options),/الدفعة مؤكدة|آخر تحديث مسجّل على الطلب/);
 const review=consultationReply('clarify_question',{paymentStatus:'awaiting_verification'},options);assert.match(review,/مطابقة التحويل/);assert.doesNotMatch(review,/الدفعة مؤكدة|تم التقديم/);
});

test('company authenticity and licence questions ask for verification without inventing credentials',()=>{
 for(const text of ['كيف أتأكد إن المكتب حقيقي؟','عندكم ترخيص؟','ممكن أشوف ترخيصكم؟','عندكم ترخيص تجاري ولا اعتماد من السفارة؟']){
  assert.equal(consultationIntent(text),'trust_concern',text);
  const reply=consultationReply('trust_concern',{}, {text});assert.match(reply,/بيانات (?:موثقة|الشركة)/);assert.match(reply,/الترخيص/);assert.doesNotMatch(reply,/نحن مرخص|معتمدون|معتمدين|نضمن|حول|\d/);
 }
 assert.match(consultationReply('trust_concern',{}, {text:'عندكم ترخيص تجاري ولا اعتماد من السفارة؟'}),/ترخيص الشركة واعتماد السفارة موضوعين مختلفين/);
 assert.doesNotMatch(consultationReply('trust_concern',{}, {text:'عندكم ترخيص؟',includeNextStep:false}),/خلّينا نبدأ/);
});

test('written offers are compared by concrete terms without quoting or adopting third-party claims',()=>{
 const c={quote:{total:830,insuranceSubtotal:190,insuranceRefundPolicy:'pending_confirmation'},applicants:[{nationality:'سوريا',documentType:'passport',age:60}],paymentStatus:'unverified'},before=structuredClone(c);
 for(const text of ['لقيت عرض شامل التأمين، كيف أقارنه بعرضكم؟','العرض التاني شامل كل شي ولا لأ؟','العرض الثاني سياحية سنة شامل التأمين بستمئة، بعرضكم شو المشمول؟']){
  assert.equal(consultationIntent(text),'compare_service',text);
  const reply=consultationReply('compare_service',c,{text});assert.match(reply,/نوع التأشيرة.*رسوم التأمين.*وسيلة الدفع.*استرداد كل بند/);assert.match(reply,/بعرضك في بند تأمين منفصل/);assert.match(reply,/شروط استرداده بحاجة لتأكيد/);assert.match(reply,/بنود العرض الثاني المكتوبة/);assert.doesNotMatch(reply,/ستمئة|830|190|مستردة بالكامل|نضمن|عرضنا أفضل/);
 }
 assert.deepEqual(c,before);
 assert.doesNotMatch(consultationReply('compare_service',c,{text:'العرض التاني شامل التأمين',includeNextStep:false}),/ابعت|[؟?]/);
});

test('routed practical questions preserve intake and avoid generic escalation',async()=>{
 for(const text of ['من وين بلش؟','شو الخطوة الجاية؟','شو المانع؟','كيف أتأكد إن المكتب حقيقي؟']){
  const e=make();await e.handle('a','سوري');const before=facts(e.getCase('a'));
  const {reply}=await e.handle('a',text);
  assert.doesNotMatch(reply,/رح أراجع هالنقطة مع المسؤول|تأكيد الدفعة|تم التقديم/);assert.deepEqual(facts(e.getCase('a')),before);assert.equal(e.getCase('a').lastQuestion,'documentType');assert.equal(e.getCase('a').operatorIntervention,undefined);
  if(text.includes('المكتب'))assert.match(reply,/بيانات الشركة والترخيص/);else assert.match(reply,/جواز سفر عادي أو وثيقة سفر/);
 }
});

test('routed written-offer comparisons leave the actual applicant and quote intact',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي عمري 40');const before=facts(e.getCase('a'));
 for(const text of ['لقيت عرض شامل التأمين، كيف أقارنه بعرضكم؟','العرض الثاني سياحية سنة شامل التأمين بستمئة، بعرضكم شو المشمول؟']){
  const {reply}=await e.handle('a',text);assert.match(reply,/نوع التأشيرة.*رسوم التأمين.*وسيلة الدفع.*استرداد كل بند/);assert.deepEqual(facts(e.getCase('a')),before);assert.equal(e.getCase('a').operatorIntervention,undefined);
 }
});
