'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');const {AssistantState}=require('../src/assistant-state');
const {validateLiveRequest}=require('../src/live-quote');const {airportCodeConfirmed,chooseAirport}=require('../src/portal-search-probe');
const now=Date.parse('2026-10-24T00:00:00Z');
for(const [name,code]of [['دبي','DXB'],['ابوظبي','AUH'],['ابو ظبي','AUH'],['مطار ال مكتوم','DWC'],['مطار آل مكتوم','DWC']])test('origin amendment searches '+name+' and retains remaining trip',async()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}};
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>({intent:'explain',fields:{},question:null,option:null})});
 e.store.set('u',{history:[],offers:[],base:{request,submitted:true,awaiting:null,at:now},status:'done'});
 const r=await e.handle('u','طيب شفلي من '+name,{now});assert.equal(r.complete,true);assert.equal(validateLiveRequest(r.request,now).origin,code);assert.equal(r.request.destination,'دمشق');assert.equal(r.request.departureDate,'2026-11-11');assert.equal(r.request.baggageRequest.checkedWeightKg,30);assert.doesNotMatch(r.reply,/من الشارقة إلى/);
});
for(const [code,label]of [['DXB','Dubai'],['AUH','Abu Dhabi'],['DWC','Al Maktoum']])test('portal only confirms exact '+code+' supplier selection',async()=>{
 assert.equal(airportCodeConfirmed(code+' - '+label,code),true);assert.equal(airportCodeConfirmed('DXB / DWC',code),false);
 let hidden='';const frame={evaluate:async(fn,args)=>({status:args.operation==='input'?'INPUT_READY':'READY'}),locator:()=>({fill:async()=>{},pressSequentially:async()=>{},press:async()=>{},inputValue:async()=>hidden}),evaluateHandle:async()=>({asElement:()=>({click:async()=>{hidden=code+' - '+label;}}),dispose:async()=>{}})};
 await chooseAirport(frame,'fAirport','fromAirport',code,{lookupMs:0});assert.equal(hidden,code+' - '+label);
});
test('failed airport selection ends same-provider monthly lookup without marking flights unavailable',()=>{
 const {QuoteJobs}=require('../src/quote-jobs');const q=new QuoteJobs({now:()=>now});q.workerAt=now;q.providerAt.set('flycham',now);
 const request={origin:'دبي',destination:'دمشق',departureDate:null,departureRange:{start:'2026-11-01',end:'2026-11-30'},tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]}};
 const parent=q.enqueueComparison('u',request);const job=q.claim('flycham');assert.ok(job.id);
 q.completeComparisonChild(job.id,job.lease,{status:'airport_unconfirmed',outcome:'failed'});
 const rest=[...q.jobs.values()];assert.equal(rest.length,30);assert.ok(rest.every(j=>j.request.provider==='airarabia'));
 const comparison=[...q.comparisons.values()][0];const failed=comparison.children.filter(c=>c.provider==='flycham');assert.ok(failed.every(c=>c.status==='unverified'));
 const {renderComparison}=require('../src/quote-comparison');const reply=renderComparison(comparison);assert.match(reply,/تعذر تأكيد اختيار المطار/);assert.doesNotMatch(reply,/الأسعار تشمل الرسوم/);assert.match(reply,/لا يعني عدم وجود رحلات/);
});
for(const text of ['شفلي من دبي','نفس الرحله'])test('explicit retry keeps known November range: '+text,async()=>{
 const request={origin:'دبي',destination:'دمشق',departureDate:null,departureRange:{start:'2026-11-01',end:'2026-11-30'},tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}};
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>({intent:'explain',fields:{},question:'أي فترة بتناسبك؟',option:null})});
 e.store.set('retry',{history:[],offers:[],base:{request,submitted:true,awaiting:null,at:now},status:'done'});
 const r=await e.handle('retry',text,{now});assert.equal(r.complete,true);assert.deepEqual(r.request.departureRange,request.departureRange);assert.equal(r.request.origin,'دبي');assert.equal(r.request.passengers.adults,1);assert.doesNotMatch(r.reply,/أي فترة|اي فترة|طلبك السابق مسجل/);
});
