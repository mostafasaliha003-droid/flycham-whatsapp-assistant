'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {schema}=require('../src/assistant-nlu');
const {CHOICE_TTL_MS}=require('../src/request-choice');
const NOW=Date.parse('2026-10-25T00:00:00Z');
const CID='scope-choice-customer';
const AMBIGUOUS='بدي تذكرة من دبي إلى حلب';
function decision(fields={},intent='change',extra={}){return{intent,fields:{...Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null])),...fields},question:null,option:null,...extra};}
function request(extra={}){return{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',departureRange:null,returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:40,source:'customer',requestedByCustomer:true},provider:'airarabia',providerExclusive:true,providerRestrictionSource:'customer',...extra};}
function make({status='done',nlu=async()=>null,env={}}={}){
 const e=new AssistantEngine({store:new AssistantState({now:()=>NOW}),nlu,env});
 e.store.set(CID,{tripId:'original-trip',introduced:true,greeted:true,history:[{role:'user',text:'OLD CUSTOMER MESSAGE'},{role:'assistant',text:'OLD ANSWER'}],offers:[],selected:null,previous:[],pendingRequests:[],lastQuestion:'OLD QUESTION؟',questions:{passengers:{answered:true}},consultant:{preferences:{priority:'cheapest',airportFlexibility:'strict'},objections:['old-objection']},base:{request:request(),submitted:true,awaiting:null,at:NOW},status,activeComparisonId:'original-comparison',offerPages:{privateOldPage:true},coverage:[{date:'2026-11-11',status:'confirmed'}],handoffId:'old-handoff'});
 return e;
}
function quote(e,reference,date){const r=request({departureDate:date});e.progress(CID,{offer:{provider:'airarabia',reference,request:r,timing:{out:{flight:'G9'+(430+reference),departure:'08:00',arrival:'10:00'}},price:{currency:'AED',sellingTotal:'650.00',weights:[{kg:40}]},checkedAt:NOW}},'quote-'+reference);}

test('an ambiguous request yields one real choice without NLU or any active trip mutation',async()=>{
 let calls=0;const e=make({status:'searching',nlu:async()=>{calls++;throw Error('choice must precede model');}}),before=structuredClone(e.state(CID));
 await e.prepare(CID,AMBIGUOUS,{now:NOW});const r=await e.handle(CID,AMBIGUOUS,{now:NOW});
 assert.equal(calls,0);assert.equal(r.complete,false);assert.ok(r.requestChoice?.id);assert.match(r.reply,/متابعة طلبي الحالي/);assert.match(r.reply,/طلب جديد مختلف/);
 const s=e.state(CID);for(const key of ['base','offers','selected','status','activeComparisonId','pendingRequests','consultant','lastQuestion','questions','offerPages','coverage','tripId'])assert.deepEqual(s[key],before[key],key);
 assert.equal(s.requestChoice.text,AMBIGUOUS);assert.equal(s.requestChoice.previousQuestion,before.lastQuestion);assert.equal(s.history.at(-1).text,r.reply);
});
test('continue replays the held customer request once on the current trip and does not show the menu again',async()=>{
 const seen=[];const e=make({nlu:async(text,context)=>{seen.push({text,context:structuredClone(context)});return decision({origin:'دبي',destination:'حلب'});}});
 await e.handle(CID,AMBIGUOUS,{now:NOW});const r=await e.handle(CID,'1',{now:NOW+1000});
 assert.equal(seen.length,1);assert.equal(seen[0].text,AMBIGUOUS);assert.equal(seen[0].context.request.destination,'دمشق');assert.equal(r.complete,true);assert.equal(r.request.origin,'دبي');assert.equal(r.request.destination,'حلب');assert.equal(r.request.departureDate,'2026-11-11');assert.equal(r.request.passengers.adults,1);assert.equal(r.request.baggageRequest.checkedWeightKg,40);assert.equal(r.request.providerExclusive,true);assert.equal(e.state(CID).tripId,'original-trip');assert.equal(e.state(CID).requestChoice,undefined);assert.equal(r.requestChoice,undefined);
});
test('the chosen current-request scope outranks a model that calls the held message an additional request',async()=>{
 const e=make({status:'searching',nlu:async()=>decision({origin:'دبي',destination:'حلب'},'additional_request')});
 await e.handle(CID,AMBIGUOUS,{now:NOW});const r=await e.handle(CID,'1',{now:NOW+1000});
 assert.equal(r.complete,true);assert.equal(r.request.origin,'دبي');assert.equal(r.request.destination,'حلب');assert.equal(r.request.departureDate,'2026-11-11');assert.equal(e.state(CID).pendingRequests.length,0);assert.equal(e.state(CID).tripId,'original-trip');
});
test('Cline additional-request answer semantics cannot override an explicit current-request choice',async()=>{
 const e=make({status:'searching',env:{CONSULTANT_ORCHESTRATOR_ENABLED:'true'},nlu:async()=>decision({origin:'دبي',destination:'حلب'},'additional_request',{consultant:{action:'answer',reply:'رح أبدأ بطلبك الجديد بعد طلبك الحالي.',preferences:{priority:null,airportFlexibility:null},nextStep:'none',knowledgeQuery:null}})});
 await e.handle(CID,AMBIGUOUS,{now:NOW});const r=await e.handle(CID,'متابعة طلبي الحالي',{now:NOW+1000});
 assert.equal(r.complete,true);assert.equal(r.request.origin,'دبي');assert.equal(r.request.destination,'حلب');assert.equal(e.state(CID).pendingRequests.length,0);assert.equal(e.state(CID).tripId,'original-trip');
});
test('an idle new request clears old itinerary, party, weight, supplier selection and model history',async()=>{
 const seen=[];const e=make({nlu:async(text,context)=>{seen.push({text,context:structuredClone(context)});return decision({origin:'دبي',destination:'حلب'},'request');}});
 await e.handle(CID,AMBIGUOUS,{now:NOW});const r=await e.handle(CID,'طلب جديد مختلف',{now:NOW+1000});
 assert.equal(seen.length,1);assert.equal(seen[0].text,AMBIGUOUS);assert.equal(seen[0].context.request,undefined);assert.deepEqual(seen[0].context.consultantMemory,{});assert.ok(seen[0].context.history.every(h=>!h.text.includes('OLD')));assert.equal(r.complete,false);assert.equal(r.cancel,true);
 const s=e.state(CID);assert.equal(s.base.request.origin,'دبي');assert.equal(s.base.request.destination,'حلب');assert.equal(s.base.request.departureDate,null);assert.equal(s.base.request.passengers,null);assert.equal(s.base.request.tripType,null);assert.equal(s.base.request.baggageRequest.checkedWeightKg,30);assert.equal(s.base.request.providerExclusive,undefined);assert.equal(s.base.request.provider,undefined);assert.notEqual(s.tripId,'original-trip');assert.equal(s.activeComparisonId,null);assert.deepEqual(s.offers,[]);assert.equal(s.offerPages,undefined);assert.equal(s.handoffId,undefined);assert.equal(s.requestChoice,undefined);assert.match(r.reply,/طلب جديد/);assert.doesNotMatch(JSON.stringify(s.history),/OLD CUSTOMER|OLD ANSWER/);
});
test('choosing a new request while busy keeps current work intact and queues the new text once',async()=>{
 let calls=0;const e=make({status:'searching',nlu:async()=>{calls++;return null;}}),before=structuredClone(e.state(CID));
 await e.handle(CID,AMBIGUOUS,{now:NOW});const id=e.state(CID).requestChoice.id;
 const r=await e.handle(CID,'طلب جديد مختلف',{now:NOW+1000,buttonChoice:{id,action:'new'}});assert.equal(r.complete,false);assert.equal(r.cancel,undefined);assert.match(r.reply,/بعدها ببدأ بطلبك الجديد/);assert.equal(calls,0);
 let s=e.state(CID);for(const key of ['base','offers','status','activeComparisonId','consultant','tripId'])assert.deepEqual(s[key],before[key],key);assert.deepEqual(s.pendingRequests,[{text:AMBIGUOUS,at:NOW+1000}]);assert.equal(s.requestChoice,undefined);
 const duplicate=await e.handle(CID,'طلب جديد مختلف',{now:NOW+2000,buttonChoice:{id,action:'new'}});assert.equal(duplicate.complete,false);s=e.state(CID);assert.equal(s.pendingRequests.length,1);assert.equal(calls,0);assert.equal(s.tripId,before.tripId);
});
test('the queued independent request starts with an empty model trip and no prior preferences',async()=>{
 const seen=[];const e=make({status:'searching',nlu:async(text,context)=>{seen.push({text,context:structuredClone(context)});return decision({origin:'دبي',destination:'حلب'},'request');}});
 await e.handle(CID,AMBIGUOUS,{now:NOW});await e.handle(CID,'2',{now:NOW+1000});assert.equal(e.beginNextRequest(CID),null);
 let s=e.state(CID);s.status='done';s.queueReady=true;e.store.set(CID,s);const next=e.beginNextRequest(CID);assert.equal(next.text,AMBIGUOUS);s=e.state(CID);assert.equal(s.base,null);assert.deepEqual(s.history,[]);assert.deepEqual(s.consultant,{});assert.notEqual(s.tripId,'original-trip');assert.equal(s.activeComparisonId,null);
 const r=await e.handle(CID,next.text,{now:NOW+2000});assert.equal(r.complete,false);assert.equal(seen.length,1);assert.equal(seen[0].context.request,undefined);assert.equal(e.state(CID).base.request.passengers,null);assert.equal(e.state(CID).base.request.baggageRequest.checkedWeightKg,30);
});
test('bare one or two remain offer selection outside a scope choice, including quoted offers',async()=>{
 const e=make({nlu:async()=>decision({},'select',{option:2})});quote(e,1,'2026-11-11');quote(e,2,'2026-11-12');e.jobState(CID,'done');
 const r=await e.handle(CID,'2',{now:NOW});assert.equal(r.requestChoice,undefined);assert.equal(e.state(CID).offers.find(o=>o.id===e.state(CID).selected).reference,2);assert.equal(e.state(CID).tripId,'original-trip');
 const again=await e.handle(CID,'2',{now:NOW+1000,quotedMessageId:'quote-2'});assert.equal(again.requestChoice,undefined);assert.equal(e.state(CID).base.request.departureDate,'2026-11-12');
});
test('a quoted fare operation is not mistaken for scope choice one/two while a menu is pending',async()=>{
 const e=make();quote(e,1,'2026-11-11');quote(e,2,'2026-11-12');e.jobState(CID,'done');
 await e.handle(CID,AMBIGUOUS,{now:NOW});assert.ok(e.state(CID).requestChoice);
 const r=await e.handle(CID,'الخيار 2',{now:NOW+1000,quotedMessageId:'quote-2'});assert.equal(r.requestChoice,undefined);assert.equal(e.state(CID).requestChoice,undefined);assert.equal(e.state(CID).base.request.departureDate,'2026-11-12');assert.equal(e.state(CID).tripId,'original-trip');
});
test('an old, expired or wrong-nonce choice cannot reset facts or launch a model turn',async()=>{
 let calls=0;const e=make({nlu:async()=>{calls++;return null;}});await e.handle(CID,AMBIGUOUS,{now:NOW});const before=structuredClone(e.state(CID)),id=before.requestChoice.id;
 const wrong=await e.handle(CID,'طلب جديد مختلف',{now:NOW+1000,buttonChoice:{id:'00000000-0000-4000-8000-000000000000',action:'new'}});assert.match(wrong.reply,/رسالة سابقة/);assert.equal(e.state(CID).requestChoice.id,id);assert.deepEqual(e.state(CID).base,before.base);assert.equal(calls,0);
 const expired=await e.handle(CID,'طلب جديد مختلف',{now:NOW+CHOICE_TTL_MS,buttonChoice:{id,action:'new'}});assert.match(expired.reply,/رسالة سابقة/);assert.deepEqual(e.state(CID).base,before.base);assert.equal(e.state(CID).tripId,before.tripId);assert.equal(calls,0);
 const numeric=await e.handle(CID,'2',{now:NOW+CHOICE_TTL_MS+1});assert.match(numeric.reply,/رسالة سابقة/);assert.equal(e.state(CID).requestChoice,undefined);assert.deepEqual(e.state(CID).base,before.base);assert.equal(calls,0);
});
test('an unresolved yes repeats only a narrow choice reminder and keeps the same choice',async()=>{
 let calls=0;const e=make({nlu:async()=>{calls++;return null;}});await e.handle(CID,AMBIGUOUS,{now:NOW});const id=e.state(CID).requestChoice.id;
 const r=await e.handle(CID,'نعم',{now:NOW+1000});assert.match(r.reply,/اختار 1 أو 2/);assert.equal(r.requestChoice.id,id);assert.equal(e.state(CID).requestChoice.id,id);assert.equal(calls,0);assert.equal(e.state(CID).base.request.origin,'الشارقة');
});
for(const [text,fields,date,weight]of [['بدي 30 كيلو',{weightKg:30},'2026-11-11',30],['12-11-2026',{departureDate:'2026-11-12'},'2026-11-12',40]])test('a clear current-trip change bypasses and dismisses the pending scope menu: '+text,async()=>{
 const e=make({nlu:async()=>decision(fields)});await e.handle(CID,AMBIGUOUS,{now:NOW});
 const r=await e.handle(CID,text,{now:NOW+1000});assert.equal(r.complete,true);assert.equal(r.request.departureDate,date);assert.equal(r.request.baggageRequest.checkedWeightKg,weight);assert.equal(r.request.origin,'الشارقة');assert.equal(r.request.destination,'دمشق');assert.equal(e.state(CID).tripId,'original-trip');assert.equal(e.state(CID).requestChoice,undefined);
});
test('status and thanks preserve the pending scope choice without repeating it or changing facts',async()=>{
 const e=make({status:'searching'});await e.handle(CID,AMBIGUOUS,{now:NOW});const before=structuredClone(e.state(CID));
 for(const text of ['شو صار','شكرا']){const r=await e.handle(CID,text,{now:NOW+1000});assert.equal(r.complete,false);assert.equal(r.requestChoice,undefined);assert.equal(e.state(CID).requestChoice.id,before.requestChoice.id);assert.deepEqual(e.state(CID).base,before.base);}
});
