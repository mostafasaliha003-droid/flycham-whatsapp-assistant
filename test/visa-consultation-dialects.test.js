'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {consultationIntent,consultationReply}=require('../src/visa-consultation');
const make=()=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[]}});

test('common Egyptian Gulf Yemeni Jordanian and Lebanese concerns have useful local meaning',()=>{
 const examples=[
  ['مفهمتش قصدك','clarify_question'],['مش مستوعب سؤالك','clarify_question'],['السعر عالي عليا','price_objection'],['إزاي أضمن حقي؟','trust_concern'],
  ['مب فاهم السؤال','clarify_question'],['ما يناسب ميزانيتي','price_objection'],['وش يضمن لي حقي؟','trust_concern'],['خلني استشير الأهل','hesitation'],
  ['اش تقصد؟','clarify_question'],['اش يضمن لي حقي؟','trust_concern'],['ما اشتي استعجل خليني افكر','hesitation'],['ما اشتي اقدم حاليا','hesitation'],
  ['شو يعني هالحكي؟','clarify_question'],['خليني أتروى شوي','hesitation'],['عند غيركم أوفر','compare_service'],['يعني بتطلع أكيد؟','approval_guarantee'],
  ['فسرلي سؤالك','clarify_question'],['خليني شاور الأهل','hesitation'],['شو ميزتكم؟','compare_service'],['كيف باوثق فيكم قبل ما أحول؟','trust_concern']
 ];
 for(const [text,intent] of examples)assert.equal(consultationIntent(text),intent,text);
});

test('negated concerns and direct discount requests are not turned into persuasion',()=>{
 for(const text of ['السعر مش عالي عليا','مش فوق ميزانيتي','مو غالي','مش خايف أحول','ما بدي أفكر بدي أقدم','مش هفكر عايز أقدم','I trust you','نزل السعر غالي','عايز خصم السعر عالي عليا'])assert.equal(consultationIntent(text),null,text);
 assert.equal(consultationIntent('ما بدي خصم، السعر عالي عليا'),'price_objection');
});

test('colloquial clarification preserves the actual pending applicant and relative question',async()=>{
 for(const text of ['مفهمتش قصدك','مب فاهم السؤال','اش تقصد؟','شو يعني هالحكي؟','مش مستوعب سؤالك','يعني؟']){
  const e=make();await e.handle('a','سوري');const before=structuredClone(e.getCase('a'));
  const r=await e.handle('a',text);assert.match(r.reply,/نوع مستند السفر/,text);assert.equal(e.getCase('a').lastQuestion,'documentType');assert.deepEqual(e.getCase('a').applicants,before.applicants);assert.equal(e.getCase('a').operatorIntervention,undefined);
 }
 const e=make();await e.handle('a','سوري جواز عادي لحالي');const primary=structuredClone(e.getCase('a').applicants);await e.handle('a','صديقي مصري');await e.handle('a','معه وثيقة سفر');
 const r=await e.handle('a','اش تقصد؟');assert.match(r.reply,/البلد اللي أصدر وثيقة السفر/);assert.deepEqual(e.getCase('a').applicants,primary);assert.equal(e.getCase('a').pendingRelative.awaiting,'documentIssuer');
});

test('natural concerns produce one concrete next step without inventing a price or operational result',async()=>{
 for(const [text,pattern,next] of [
  ['إزاي أضمن حقي؟',/من حقك تتأكد/,/نراجع شروط الخدمة/],
  ['يعني بتطلع أكيد؟',/ما فينا نضمن الإصدار/,/أوضح لك شروط استرداد/],
  ['عند غيركم أوفر',/من حقك تقارن/,/ابعت تفاصيل العرض الثاني/],
  ['السعر عالي عليا',/السعر عامل مهم/,/نراجع شو مشمول بعرضك/],
  ['ما يناسب ميزانيتي',/السعر عامل مهم/,/نراجع شو مشمول بعرضك/]
 ]){
  const e=make();await e.handle('a','سوري جواز عادي لحالي');const before=structuredClone(e.getCase('a'));const r=await e.handle('a',text);
  assert.match(r.reply,pattern,text);assert.match(r.reply,next,text);assert.ok((r.reply.match(/[؟?]/g)||[]).length<=1,text);
  assert.doesNotMatch(r.reply,/\d|تم تأكيد|تم تقديم|موافقة أكيدة|نضمن لك|ادفع الآن|حوّل الآن/);assert.deepEqual(e.getCase('a').quote,before.quote);assert.equal(e.getCase('a').paymentStatus,before.paymentStatus);assert.equal(e.getCase('a').operatorIntervention,undefined);
 }
});

test('a pause adds no sales question and secondary information suppresses extra concern prompts',async()=>{
 for(const text of ['ما اشتي استعجل خليني افكر','خليني شاور الأهل','ما اشتي اقدم حاليا','مش عايز أكمل دلوقتي']){
  const e=make();await e.handle('a','سوري جواز عادي لحالي');const before=structuredClone(e.getCase('a'));const r=await e.handle('a',text);
  assert.match(r.reply,/خذ راحتك/);assert.doesNotMatch(r.reply,/[؟?]|\d|ادفع|إلغاء/);assert.deepEqual(e.getCase('a').quote,before.quote);assert.equal(e.getCase('a').cancellation,undefined);
 }
 for(const intent of ['trust_concern','approval_guarantee','compare_service','price_objection']){
  const r=consultationReply(intent,{quote:{total:640}},{includeNextStep:false});assert.doesNotMatch(r,/[؟?]|ابعت تفاصيل العرض الثاني/);
 }
});
