'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {VisaConversationScope}=require('../src/visa-conversation-scope');
const {visaCaseSignature}=require('../src/visa-case-signature');
const QUESTION='شو نظام أولوية التأشيرة الاستثنائي؟';
function setup(options={}){
 const store={data:{},save(){}},engine=new SaudiVisaEngine({store,env:{VISA_TOURIST_AGE_PRICING:'on'},privateConfig:{banks:[]},...options});
 return{store,engine};
}
async function qualified(engine,id='customer',age=52){await engine.handle(id,`سوري جواز عادي لحالي وعمري ${age} سنة`);return engine.getCase(id);}

test('an unresolved request emits a turn-bound understanding review with or without semantic NLU',async()=>{
 for(const understand of [null,async()=>({intent:'other',fields:{},target:null})]){
  const {engine}=setup({understand}),c=await qualified(engine),signature=visaCaseSignature(c);
  const result=await engine.handle('customer',QUESTION),current=engine.getCase('customer');
  assert.equal(result.needsUnderstandingReview,true);assert.match(result.reply,/جواب دقيق/);
  assert.equal(current.operatorIntervention.reason,'untrained_request');assert.equal(current.operatorIntervention.understandingFailed,true);
  assert.equal(current.operatorIntervention.revision,result.revision);assert.equal(visaCaseSignature(current),signature);
  for(const text of ['شكرا','كم السعر؟','شو الأوراق المطلوبة؟']){
   const next=await engine.handle('customer',text);assert.equal(next.needsUnderstandingReview,undefined,text);
   assert.ok(engine.getCase('customer').operatorIntervention.revision<next.revision);
  }
 }
});

test('normal intake, clarification and completed quotes are not understanding failures',async()=>{
 const {engine}=setup();
 for(const text of ['مرحبا','سوري','ما فهمت شو قصدك','جواز عادي لحالي','52','كم السعر وكم يوم بتاخد؟','من وين بلش؟','تمام']){
  const result=await engine.handle('customer',text);assert.equal(result.needsUnderstandingReview,undefined,text);
  assert.notEqual(engine.getCase('customer').operatorIntervention?.understandingFailed,true,text);
 }
 assert.equal(engine.getCase('customer').quote.total,640);
});

test('known pricing and policy reviews retain their legacy intervention without misunderstanding markers',async()=>{
 const {engine}=setup();
 const age=await engine.handle('age','سوري جواز عادي لحالي وعمري 53 سنة');
 assert.equal(age.stage,'pricing_review');assert.equal(engine.getCase('age').operatorIntervention.reason,'untrained_request');
 assert.equal(age.needsUnderstandingReview,undefined);assert.equal(engine.getCase('age').operatorIntervention.understandingFailed,undefined);
 await qualified(engine,'insurance',54);const insurance=await engine.handle('insurance','أرسل الحساب البنكي');
 assert.equal(engine.getCase('insurance').operatorIntervention.reason,'untrained_request');assert.equal(insurance.needsUnderstandingReview,undefined);assert.equal(engine.getCase('insurance').operatorIntervention.understandingFailed,undefined);
 const unverified=engine.newCase();Object.assign(unverified,{applicantCount:1,applicants:[{nationality:'فيتنام',documentType:'passport',age:40}]});engine.save('unverified',unverified);
 const policy=await engine.handle('unverified','مرحبا');assert.equal(engine.getCase('unverified').operatorIntervention.reason,'untrained_request');assert.equal(policy.needsUnderstandingReview,undefined);assert.equal(engine.getCase('unverified').operatorIntervention.understandingFailed,undefined);
});

test('isolated unknown inquiries expose the marker and bound token while preserving the paid case',async()=>{
 const {store,engine}=setup(),c=await qualified(engine);c.paymentStatus='verified';engine.save('customer',c);
 store.data.visaFulfilment={jobs:{job:{id:'job',customer:'customer',caseId:c.id,caseSignature:visaCaseSignature(c),state:'manually_completed',applicationReference:'828601588'}}};
 const before=JSON.stringify(c),scope=new VisaConversationScope({store,engine}),menu=await scope.handle('customer','سلام');scope.bind('customer',menu.scopeMenu.token,'sent-menu');
 const select=await scope.handle('customer','استفسار جديد');assert.equal(select.needsUnderstandingReview,undefined);
 const result=await scope.handle('customer',QUESTION);
 assert.equal(result.needsUnderstandingReview,true);assert.equal(result.intervention.understandingFailed,true);assert.equal(result.intervention.reason,'untrained_request');
 assert.equal(result.scopeToken,menu.scopeMenu.token);assert.equal(result.intervention.revision,scope.current('customer').inquiry.revision);assert.equal(result.intervention.question,QUESTION);
 assert.equal(JSON.stringify(engine.getCase('customer')),before);
 const next=await scope.handle('customer','مصري جواز عادي لحالي وعمري 52 سنة');assert.equal(next.needsUnderstandingReview,undefined);assert.equal(next.intervention,undefined);
 assert.equal(JSON.stringify(engine.getCase('customer')),before);
});

test('superseded understanding cannot emit a review for an outdated turn',async()=>{
 const {engine}=setup();await qualified(engine);
 engine.understand=async()=>{const c=engine.getCase('customer');c.revision++;engine.save('customer',c);return{intent:'other',fields:{}};};
 const result=await engine.handle('customer',QUESTION);assert.equal(result.superseded,true);assert.equal(result.needsUnderstandingReview,undefined);assert.equal(engine.getCase('customer').operatorIntervention,undefined);
});
