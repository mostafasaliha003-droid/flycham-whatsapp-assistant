'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine'),{AssistantState}=require('../src/assistant-state');
const now=Date.parse('2026-10-26T17:00:00Z');
function engine(){return new AssistantEngine({store:new AssistantState({file:null,now:()=>now}),env:{CONSULTANT_ORCHESTRATOR_ENABLED:'true'},nlu:async()=>({intent:'goodbye',fields:{},question:null,option:null,consultant:{action:'answer',reply:'ماشي، ما في مشكلة',nextStep:'none',preferences:{}}})});}
for(const word of ['أبدا','ابدأ','تمام\nأبدا','بلش','ابحث'])test('start survives incorrect goodbye inference: '+word,async()=>{
 const e=engine();const s=e.state('start');s.base={request:{origin:'أبوظبي',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]}},submitted:false,awaiting:null,at:now};s.status='collecting';e.store.set('start',s);
 const r=await e.handle('start',word,{now});assert.equal(r.complete,true);assert.equal(r.request.origin,'أبوظبي');assert.equal(r.request.destination,'دمشق');assert.equal(r.cancel,undefined);assert.doesNotMatch(r.reply,/لاحقًا|ماشي، ما في مشكلة/);
});
for(const answer of ['دمشق','إلى دمشق','الشام'])test('Syrian departure answer preserves Abu Dhabi destination: '+answer,async()=>{
 const e=new AssistantEngine({store:new AssistantState({file:null}),env:{},nlu:async()=>null});await e.handle('route','بدي من سوريا لأبوظبي',{now});const r=await e.handle('route',answer,{now:now+1});const q=e.state('route').base.request;assert.equal(q.origin,'دمشق');assert.equal(q.destination,'أبوظبي');assert.doesNotMatch(r.reply,/من دمشق ولا حلب/);
});
test('a previously corrupted country route recovers from the actual explicit direction',async()=>{
 const e=new AssistantEngine({store:new AssistantState({file:null}),env:{},nlu:async()=>null});const s=e.state('corrupt');s.base={request:{originCountry:'سوريا',origin:null,destination:'دمشق',departureDate:'2026-10-26',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]}},awaiting:'origin',submitted:false,at:now};s.history=[{role:'user',text:'بدي من سوريا لابوظبي'},{role:'assistant',text:'من دمشق ولا حلب؟'},{role:'user',text:'إلى دمشق'}];s.status='collecting';e.store.set('corrupt',s);await e.handle('corrupt','دمشق',{now});assert.equal(e.state('corrupt').base.request.origin,'دمشق');assert.equal(e.state('corrupt').base.request.destination,'أبوظبي');assert.equal(e.state('corrupt').base.request.departureDate,null);
});
test('a fresh route hours after completed search asks its date instead of recycling today',async()=>{
 const e=new AssistantEngine({store:new AssistantState({file:null}),env:{},nlu:async()=>null});await e.handle('fresh','من الشارقة لحلب 26-10-2026 ذهاب فقط شخص واحد',{now:now-3*3600000});e.jobState('fresh','done');const r=await e.handle('fresh','بدي من ابوظبي إلى دمشق',{now});assert.equal(r.complete,false);assert.equal(e.state('fresh').base.request.departureDate,null);assert.match(r.reply,/تاريخ|يوم السفر|فترة/);
});
