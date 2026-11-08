'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {consultationIntent}=require('../src/visa-consultation');
const {schema,validateVisaDecision,createSaudiVisaUnderstanding}=require('../src/saudi-visa-nlu');
const make=options=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[]},...options});
const decision=(intent,informationIntents=[])=>({intent,informationIntents,fields:Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,k==='applicants'?[]:null])),target:null,correction:false,question:null,option:null});

test('objections across dialects are separate from operational instructions',()=>{
 for(const [text,intent] of [
  ['السعر غالي عليا','price_objection'],['وايد غالي','price_objection'],['غالية علي','price_objection'],
  ['بدي فكر','hesitation'],['هفكر وأرد عليك','hesitation'],['خلني أشاور الأهل','hesitation'],
  ['ما فهمت شو قصدك','clarify_question'],['مش فاهم سؤالك','clarify_question'],['وش تقصد','clarify_question'],
  ['كيف أثق فيكم قبل ما أدفع؟','trust_concern'],['خايف أحول','trust_concern'],
  ['المكتب الثاني أرخص','compare_service'],['بتضمن تطلع؟','approval_guarantee']
 ])assert.equal(consultationIntent(text),intent,text);
 assert.equal(consultationIntent('نزل السعر غالي'),null);
});

test('clarification explains the pending question and never restarts intake',async()=>{
 const e=make();await e.handle('a','سوري');
 const before=structuredClone(e.getCase('a'));
 const r=await e.handle('a','مش فاهم سؤالك');
 assert.match(r.reply,/نوع مستند السفر/);assert.match(r.reply,/غلاف المستند/);
 assert.doesNotMatch(r.reply,/رح أراجع|شو جنسية/);
 assert.deepEqual(e.getCase('a').applicants,before.applicants);
 assert.equal(e.getCase('a').lastQuestion,'documentType');
});

test('relative clarifications explain the active document and issuer question without changing the applicant',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');const primary=structuredClone(e.getCase('a').applicants);
 await e.handle('a','صديقي مصري');assert.equal(e.getCase('a').pendingRelative.awaiting,'documentType');
 const document=await e.handle('a','شو قصدك؟');assert.match(document.reply,/نوع مستند السفر/);assert.doesNotMatch(document.reply,/أي نقطة بدك أوضحها/);
 await e.handle('a','معه وثيقة سفر');assert.equal(e.getCase('a').pendingRelative.awaiting,'documentIssuer');
 const issuer=await e.handle('a','مش فاهم سؤالك');assert.match(issuer.reply,/البلد اللي أصدر وثيقة السفر/);
 assert.deepEqual(e.getCase('a').applicants,primary);assert.equal(e.getCase('a').pendingRelative.facts.nationality,'مصر');assert.equal(e.getCase('a').pendingRelative.facts.documentType,'travel_document');
});

test('English consultation keeps the pending field across short text and voice answers',async()=>{
 const e=make({understand:async()=>decision('apply')});
 const first=await e.handle('en','I need a Saudi visa');
 assert.match(first.reply,/Welcome to REMAL GROUP.*Ismail/s);
 assert.match(first.reply,/What nationality/);
 e.understand=null;
 const nationality=await e.handle('en','Syrian',{messages:[{text:'Syrian',voiceTranscript:true}]});
 assert.match(nationality.reply,/ordinary passport or a travel document/);
 const clarify=await e.handle('en','I don’t understand your question');
 assert.match(clarify.reply,/printed on its cover/);
 assert.doesNotMatch(clarify.reply,/\p{Script=Arabic}/u);
 assert.equal(e.getCase('en').lastQuestion,'documentType');
 const passport=await e.handle('en','ordinary passport');
 assert.match(passport.reply,/How many people/);
 assert.equal(e.getCase('en').applicants[0].nationality,'سوريا');
 assert.equal(e.getCase('en').applicants[0].documentType,'passport');
});

test('French intake and clarification stay in French when semantic understanding is unavailable',async()=>{
 const e=make();
 const entry=await e.handle('fr','Je veux un visa touristique pour l’Arabie saoudite.');
 assert.match(entry.reply,/Bienvenue chez REMAL GROUP/);
 assert.match(entry.reply,/Quelle nationalité/);
 const clarification=await e.handle('fr','Je ne comprends pas la question.');
 assert.match(clarification.reply,/pays de résidence/);
 assert.equal(e.getCase('fr').lastQuestion,'nationality');
 assert.equal(e.getCase('fr').applicants.length,0);
 const objection=await e.handle('fr','C’est trop cher.');
 assert.match(objection.reply,/coût adapté et clair/);
 assert.doesNotMatch(objection.reply,/\p{Script=Arabic}/u);
});

test('price objections compare value without automatically promising a discount',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');
 const before=structuredClone(e.getCase('a'));
 const r=await e.handle('a','وايد غالي');
 assert.match(r.reply,/السعر عامل مهم/);assert.doesNotMatch(r.reply,/رح نراجع إمكانية الخصم|مضمون|640|850/);
 assert.equal(e.getCase('a').operatorIntervention,undefined);
 assert.deepEqual(e.getCase('a').quote,before.quote);
 assert.deepEqual(e.getCase('a').applicants,before.applicants);
});

test('hesitation and trust concerns preserve the case without payment or sales pressure',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');
 const before=structuredClone(e.getCase('a'));
 const trust=await e.handle('a','كيف أثق فيكم قبل ما أدفع؟');
 assert.match(trust.reply,/من حقك تتأكد/);assert.doesNotMatch(trust.reply,/تم تأكيد|عرض تأشيرات|حول الآن/);
 const pause=await e.handle('a','هفكر وأرد عليك');
 assert.match(pause.reply,/خذ راحتك/);assert.doesNotMatch(pause.reply,/[؟?]|ادفع|عرض تأشيرات/);
 assert.equal(e.getCase('a').paymentStatus,before.paymentStatus);
 assert.deepEqual(e.getCase('a').applicants,before.applicants);
 assert.deepEqual(e.getCase('a').quote,before.quote);
});

test('approval guarantee question does not mutate the application or claim approval',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');
 const r=await e.handle('a','بتضمن تطلع؟');
 assert.match(r.reply,/ما فينا نضمن الإصدار/);assert.match(r.reply,/استرداد الرسوم/);
 assert.equal(e.getCase('a').submissionStatus,'not_submitted');
 assert.equal(e.getCase('a').paymentStatus,'unverified');
});

test('semantic multi-question turn renders all requested information without new actions',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');
 e.understand=async()=>decision('price',['price','processing_time','documents']);
 const before=structuredClone(e.getCase('a'));
 const r=await e.handle('a','How much, how long and which documents?');
 assert.match(r.reply,/إجمالي رسوم التأشيرات/);assert.match(r.reply,/أيام عمل/);assert.match(r.reply,/نسخة جواز/);
 assert.equal(e.getCase('a').paymentStatus,before.paymentStatus);
 assert.deepEqual(e.getCase('a').quote,before.quote);
});

test('secondary topics are bounded information, never authority to execute actions',()=>{
 for(const topics of [['cancel'],['payment_receipt'],['bank','bank'],['invented'],Array(7).fill('price'),'bank'])assert.throws(()=>validateVisaDecision(decision('other',topics)),/VISA_NLU_INVALID/);
 assert.deepEqual(validateVisaDecision(decision('price',['price','documents'])).informationIntents,['price','documents']);
});

test('concerns do not hide explicit questions or repeat a generic follow-up',async()=>{
 for(const [text,intent,topics,patterns] of [
  ['هل الموافقة مضمونة وكم يوم بتاخد؟','approval_guarantee',['processing_time'],[/ما فينا نضمن الإصدار/,/أيام عمل/]],
  ['خايف ادفع، شو عنوانكم؟','trust_concern',['address'],[/من حقك تتأكد/,/610/]],
  ['السعر غالي، شو الأوراق المطلوبة؟','price_objection',['documents'],[/السعر عامل مهم/,/نسخة جواز/]],
  ['هفكر وأرد عليك بس قولي الأوراق المطلوبة','hesitation',['documents'],[/خذ راحتك/,/نسخة جواز/]]
 ]){
  const e=make();await e.handle('a','سوري جواز عادي لحالي');e.understand=async()=>decision(intent,topics);
  const r=await e.handle('a',text);for(const pattern of patterns)assert.match(r.reply,pattern,text);
  assert.doesNotMatch(r.reply,/شو النقطة اللي حابب تتأكد|حابب أوضح تفصيل/);
  assert.equal((r.reply.match(/[؟?]/g)||[]).length,0,text);
  assert.equal(e.getCase('a').paymentStatus,'unverified');
 }
});

test('visa validity is distinguished from processing time',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');
 const r=await e.handle('a','شو مدة الفيزا؟');assert.match(r.reply,/صلاحيتها سنة/);assert.doesNotMatch(r.reply,/المدة المعتادة.*أيام عمل/);
});

test('comparison with a price-only question uses the verified quote or one missing fact',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');e.understand=async()=>decision('compare_service',['price']);
 const r=await e.handle('a','المكتب الثاني أرخص، كم سعركم؟');assert.match(r.reply,/من حقك تقارن/);assert.match(r.reply,/إجمالي رسوم التأشيرات: 640/);
 assert.equal(e.getCase('a').operatorIntervention,undefined);
 const fresh=make({understand:async()=>decision('compare_service',['price'])});const missing=await fresh.handle('b','المكتب الثاني أرخص، كم سعركم؟');
 assert.match(missing.reply,/شو جنسية/);assert.doesNotMatch(missing.reply,/640|850/);assert.equal((missing.reply.match(/[؟?]/g)||[]).length,1);
});

test('provider contract includes dialect guidance and returns only validated semantic topics',async()=>{
 let body;
 const understand=createSaudiVisaUnderstanding({env:{ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-consultation',ASSISTANT_AI_FALLBACK:'none'},fetchImpl:async(_url,options)=>{
  body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision('clarify_question'))}}]})};
 }});
 const result=await understand('مش فاهم سؤالك',{awaiting:'documentType',applicants:[{nationality:'سوريا'}]});
 assert.equal(result.intent,'clarify_question');assert.deepEqual(result.informationIntents,[]);
 assert.match(body.messages[0].content,/Syrian, Egyptian, Gulf, Jordanian, Lebanese and Yemeni/);
 assert.match(body.messages[0].content,/never as unconditional consent/);
 assert.equal(JSON.parse(body.messages[1].content).context.awaiting,'documentType');
 assert.equal(result.reply,undefined);
});
