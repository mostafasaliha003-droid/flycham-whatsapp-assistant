'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {knownTripFollowup}=require('../src/travel-followups');
const now=Date.parse('2026-10-24T12:30:00Z');
const request={origin:'أبوظبي',destination:'دمشق',departureDate:'2026-11-18',tripType:'one_way',returnDate:null,stayNights:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,requestedByCustomer:true},provider:'flycham',providerExclusive:true};
function make({r=request,status='failed',awaiting=null}={}){
 let calls=0;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>{calls++;throw Error('NLU_TIMEOUT');}});
 e.store.set('followup',{introduced:true,history:[],offers:[],selected:null,base:{request:structuredClone(r),submitted:true,awaiting,at:now},status});
 return{e,calls:()=>calls};
}
for(const text of ['في من ابوظبي','اي نفس التواريخ','بدي من ابوظبي لسوريا','بدي نفس التاريخ','بدي من ابو ظبي إلى دمشق','أعد البحث','اعد البحث','عيد البحث','أعد البحث.'])test('known trip is rechecked without NLU or a repeated date question: '+text,async()=>{
 const {e,calls}=make();await e.prepare('followup',text,{now});const result=await e.handle('followup',text,{now});
 assert.equal(result.complete,true);assert.equal(calls(),0);for(const key of Object.keys(request))assert.deepEqual(result.request[key],request[key]);
 assert.doesNotMatch(result.reply,/أي فترة|اي فترة|أي تاريخ|طلبك السابق مسجل/);assert.equal(e.state('followup').status,'queued');
});
test('repeated confirmations during the same search do not enqueue duplicate requests',async()=>{
 const {e}=make();assert.equal((await e.handle('followup','في من ابوظبي',{now})).complete,true);
 for(const text of ['اي نفس التواريخ','بدي من ابوظبي لسوريا','أعد البحث']){const r=await e.handle('followup',text,{now});assert.equal(r.complete,false);assert.ok(!r.cancel);assert.match(r.reply,/البحث مستمر/);assert.doesNotMatch(r.reply,/أي فترة/);}
});
test('same dates retains the whole date range and return while clearing a stale expansion prompt',async()=>{
 const r={...request,departureDate:null,departureRange:{start:'2026-11-18',end:'2026-11-24'},tripType:'round_trip',returnDate:'2026-12-05',searchMode:'cheapest'};
 const {e}=make({r,awaiting:'searchExpansion'});const s=e.store.get('followup');s.base.proposal={rangeStart:'2026-12-01',rangeEnd:'2026-12-31'};e.store.set('followup',s);
 const result=await e.handle('followup','اي نفس التواريخ',{now});assert.equal(result.complete,true);assert.deepEqual(result.request.departureRange,r.departureRange);assert.equal(result.request.returnDate,r.returnDate);assert.equal(result.request.tripType,'round_trip');assert.equal(e.state('followup').base.proposal,undefined);
});
test('a missing passenger count still needs an answer despite known travel dates',async()=>{
 const {e}=make({r:{...request,passengers:null}});const result=await e.handle('followup','نفس التواريخ',{now});assert.equal(result.complete,false);assert.match(result.reply,/عدد|كم شخص/);assert.equal(e.state('followup').base.request.passengers,null);
});
test('a country reference never invents a Syrian city when none is known',async()=>{
 assert.equal(knownTripFollowup('بدي من ابوظبي لسوريا',{...request,destination:null}),null);
 const {e}=make({r:{...request,destination:null}});const result=await e.handle('followup','بدي من ابوظبي لسوريا',{now});assert.equal(result.complete,false);assert.equal(e.state('followup').base.request.destination,null);
});
test('negation, booking, new dates and another trip are not mistaken for an exact confirmation',()=>{
 for(const text of ['لا بدي نفس التاريخ','بدي من ابوظبي بكرا','بدي تواريخ تانية','ثبتلي نفس التواريخ','رحلة تانية من ابوظبي','اذا من ابوظبي ارخص؟','لا تعيد البحث','اعد البحث من دبي بكرا'])assert.equal(knownTripFollowup(text,request),null,text);
 assert.equal(knownTripFollowup('نفس التواريخ',{...request,departureDate:null}),null);
});
test('unrecognised text does not erase the date or ask for it again',async()=>{
 const {e,calls}=make();const result=await e.handle('followup','مممم',{now});assert.equal(result.complete,false);assert.equal(calls(),1);assert.match(result.reply,/18-11-2026/);assert.doesNotMatch(result.reply,/أي فترة|اي فترة/);
});
test('complex amendments still use the language model',async()=>{
 const {e,calls}=make();await e.prepare('followup','بدي من ابوظبي بكرا',{now});await e.handle('followup','بدي من ابوظبي بكرا',{now});assert.equal(calls(),1);
});
test('a real origin change during searching is still applied and keeps the known dates',async()=>{
 const {e}=make({status:'searching'});const result=await e.handle('followup','بدي من دبي',{now});assert.equal(result.complete,true);assert.equal(result.request.origin,'دبي');assert.equal(result.request.destination,'دمشق');assert.equal(result.request.departureDate,'2026-11-18');
});
