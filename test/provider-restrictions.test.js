'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const legacy=require('../src/conversation');
const NOW=Date.parse('2026-10-24T23:01:00Z');
const request=(extra={})=>({origin:'أبوظبي',destination:'دمشق',departureDate:null,departureRange:{start:'2026-12-01',end:'2026-12-31'},tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},provider:'airarabia',providerExclusive:true,...extra});
function seeded(extra={},history=[],env={}){const e=new AssistantEngine({store:new AssistantState({now:()=>NOW}),env,nlu:async()=>null});e.store.set('customer',{history,offers:[],base:{request:request(extra),submitted:true,awaiting:null,at:NOW},status:'done'});return e;}
test('screenshot correction releases an old unproven airline restriction and preserves party, month and baggage',async()=>{
 const e=seeded();const r=await e.handle('customer','لا اخي بدي سافر من الإمارات على سوريا بس من دبي، او ارخص شي، الشهر القادم كامل، شو ارخص سعر',{now:NOW});
 assert.equal(r.complete,true);assert.equal(r.request.origin,'دبي');assert.equal(r.request.destination,'دمشق');assert.equal(r.request.providerExclusive,false);assert.equal(r.request.providerRestrictionSource,undefined);
 assert.deepEqual(r.request.departureRange,{start:'2026-11-01',end:'2026-11-30',kind:'confirmed_whole_month'});assert.deepEqual(r.request.passengers,{adults:1,children:0,infants:0,ages:[]});assert.equal(r.request.baggageRequest.checkedWeightKg,30);assert.doesNotMatch(r.reply,/كم عدد|ذهاب فقط أم|ذهاب ولا/);
});
test('general cheaper search releases selection scope even when the airport stays the same',async()=>{
 const e=seeded({origin:'دبي',providerRestrictionSource:'selection'});const r=await e.handle('customer','بدي ارخص سعر بالشهر القادم كامل',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.providerExclusive,false);assert.equal(r.request.origin,'دبي');
});
test('genuine customer-only airline scope survives route and date amendments',async()=>{
 const e=seeded({providerRestrictionSource:'customer'});let r=await e.handle('customer','طيب شفلي من دبي الشهر القادم كامل',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.providerExclusive,true);assert.equal(r.request.providerRestrictionSource,'customer');assert.equal(r.request.provider,'airarabia');
 r=await e.handle('customer','بدي ارخص سعر خلال شهر 11 كامل',{now:NOW});assert.equal(r.request.providerExclusive,true);assert.equal(r.request.providerRestrictionSource,'customer');
});
test('legacy exclusivity is migrated only from customer words, never assistant offer labels',async()=>{
 const e=seeded({},[{role:'assistant',text:'العربية حصرا'},{role:'user',text:'مرحبا'}]);const r=await e.handle('customer','شفلي من دبي الشهر القادم كامل',{now:NOW});assert.equal(r.request.providerExclusive,false);
 const explicit=seeded({},[{role:'user',text:'العربية للطيران فقط'}]);const kept=await explicit.handle('customer','شفلي من دبي الشهر القادم كامل',{now:NOW});assert.equal(kept.request.providerExclusive,true);assert.equal(kept.request.providerRestrictionSource,'customer');
});
test('customer explicit airline restriction outranks a conflicting model preference and can be cleared',()=>{
 const id='model-restriction';legacy.importSession(id,{request:request({providerExclusive:false}),submitted:false,awaiting:null,at:NOW});
 let r=legacy.handleMessage(id,'العربية للطيران فقط',{now:NOW,patch:{provider:'flycham'}});assert.equal(r.request.provider,'airarabia');assert.equal(r.request.providerExclusive,true);assert.equal(r.request.providerRestrictionSource,'customer');
 r=legacy.handleMessage(id,'أي شركة ما بتفرق معي الشركة',{now:NOW});assert.equal(r.request.providerExclusive,false);assert.equal(r.request.providerRestrictionSource,undefined);
});
test('weight-only amendment to a quoted offer keeps that selected supplier, with selection provenance',async()=>{
 const e=seeded({origin:'الشارقة',departureDate:'2026-11-11',departureRange:null,providerExclusive:false});const r=request({origin:'الشارقة',departureDate:'2026-11-11',departureRange:null,providerExclusive:false});
 e.progress('customer',{offer:{provider:'airarabia',request:r,timing:{out:{flight:'G9123',departure:'10:00',arrival:'12:00'}},price:{sellingTotal:'600.00',weights:[{kg:30}]}}},'quoted-offer');
 const updated=await e.handle('customer','بدي 40 كيلو',{now:NOW,quotedMessageId:'quoted-offer'});assert.equal(updated.complete,true);assert.equal(updated.request.providerExclusive,true);assert.equal(updated.request.providerRestrictionSource,'selection');assert.equal(updated.request.provider,'airarabia');assert.equal(updated.request.baggageRequest.checkedWeightKg,40);
});
test('terminal no-offer proposal accepts شفلي without another model call or repeated trip questions',async()=>{
 const e=seeded({origin:'دبي',providerExclusive:false,departureRange:{start:'2026-11-01',end:'2026-11-30'}},[],{CONSULTANT_ORCHESTRATOR_ENABLED:'true'});let calls=0;e.nlu=async()=>{calls++;throw Error('bound proposal must not ask model');};e.jobState('customer','failed');
 const p=e.proposeSearchExpansion('customer',{now:NOW});assert.equal(p.start,'2026-12-01');assert.equal(p.end,'2026-12-07');const before=structuredClone(e.state('customer').base.request);
 await e.prepare('customer','شفلي',{now:NOW});const r=await e.handle('customer','شفلي',{now:NOW});assert.equal(calls,0);assert.equal(r.complete,true);assert.deepEqual(r.request.departureRange,{start:'2026-12-01',end:'2026-12-07',kind:'accepted_proposal'});assert.equal(r.request.origin,before.origin);assert.equal(r.request.destination,before.destination);assert.deepEqual(r.request.passengers,before.passengers);assert.deepEqual(r.request.baggageRequest,before.baggageRequest);assert.equal(r.request.providerExclusive,false);assert.equal(e.state('customer').base.proposal,undefined);assert.doesNotMatch(r.reply,/كم عدد|ذهاب فقط أم|أي فترة/);
});
test('retrying a historical no-offer request removes only unproven legacy exclusivity',async()=>{
 const e=seeded({origin:'دبي'});e.jobState('customer','failed');const r=await e.handle('customer','أعد البحث',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.providerExclusive,false);assert.equal(r.request.origin,'دبي');
 const explicit=seeded({origin:'دبي',providerRestrictionSource:'customer'});explicit.jobState('customer','failed');const kept=await explicit.handle('customer','أعد البحث',{now:NOW});assert.equal(kept.request.providerExclusive,true);
});
test('legacy restriction cleanup preserves the exact accepted expansion fingerprint',async()=>{
 const e=seeded({origin:'دبي',departureRange:{start:'2026-11-01',end:'2026-11-30'}});e.jobState('customer','failed');e.proposeSearchExpansion('customer',{now:NOW});const r=await e.handle('customer','شفلي',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.providerExclusive,false);assert.equal(r.request.departureRange.start,'2026-12-01');assert.equal(r.request.departureRange.end,'2026-12-07');
});
