'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MessageBatcher}=require('../src/message-batcher');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {FareCatalog,FRESH_MS,INDICATIVE_MS}=require('../src/fare-catalog');
const {handleMessage,resetSessions}=require('../src/conversation');
const {validateLiveRequest}=require('../src/live-quote');
const {capabilityIssue}=require('../src/assistant-policy');
const now=Date.parse('2026-10-23T08:00:00Z');
const request={provider:'airarabia',origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}};
const offer=(r=request,price='700.00')=>({request:r,timing:{out:{flight:r.provider==='flycham'?'XH744':'G9433',departure:'Wed 11Nov26 08:00',arrival:'Wed 11Nov26 10:00'},back:r.tripType==='round_trip'?{flight:'G9434',departure:'Wed 18Nov26 08:00',arrival:'Wed 18Nov26 10:00'}:null},price:{sellingTotal:price,weights:[{kg:30}],voucherValue:'10.00'}});
test('quiet window really waits35s and groups separately delivered fragments',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now});const calls=[];
 const b=new MessageBatcher(async(id,m)=>calls.push(m.map(x=>x.text)),{now:Date.now});
 const first=b.push('a',{text:'من الشام'});t.mock.timers.tick(34000);assert.equal(calls.length,0);
 const next=b.push('a',{text:'للشارقة'});t.mock.timers.tick(34999);assert.equal(calls.length,0);t.mock.timers.tick(1);await Promise.all([first,next]);assert.deepEqual(calls,[['من الشام','للشارقة']]);b.close();
});
test('continuous messages hit180s cap; next customer is independent',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now});const calls=[];const b=new MessageBatcher(async(id,m)=>calls.push([id,m.length]),{delay:90000});
 const a=b.push('a',{text:'route'});t.mock.timers.tick(80000);const a2=b.push('a',{text:'date'});const other=b.push('b',{text:'other'});t.mock.timers.tick(80000);const a3=b.push('a',{text:'count'});t.mock.timers.tick(10000);await other;assert.deepEqual(calls,[['b',1]]);t.mock.timers.tick(10000);await Promise.all([a,a2,a3]);assert.deepEqual(calls,[['b',1],['a',3]]);b.close();
});
test('pending messages restore from the configured snapshot and completion clears inbox',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now});const store=new AssistantState({now:Date.now});const first=new MessageBatcher(async()=>{}, {store});first.push('a',{id:'one',text:'من الشام'});first.close();const calls=[];const restored=new MessageBatcher(async(id,m)=>calls.push(m[0].text),{store});t.mock.timers.tick(35000);await restored.settled('a');assert.deepEqual(calls,['من الشام']);assert.deepEqual(store.data.inbox,{});restored.close();
});
test('flexible dates ask type and count rather than assuming either',()=>{
 resetSessions();const r=handleMessage('no-assumption','من الشارقة للشام بهل اسبوع',{now});assert.equal(r.complete,false);assert.match(r.reply,/ذهاب/);const n=handleMessage('no-assumption','ذهاب بس',{now});assert.match(n.reply,/عدد المسافرين/);const done=handleMessage('no-assumption','شخص واحد',{now});assert.equal(done.complete,true);assert.equal(done.request.baggageRequest.checkedWeightKg,30);assert.equal(done.request.baggageRequest.source,'default30');
});
test('direction and spoken count work without Cline',()=>{
 resetSessions();const r=handleMessage('direction','بدي من الشام للشارقة 11-11-2026 شخص واحد ذهاب بس',{now});assert.equal(r.complete,true);assert.equal(r.request.origin,'دمشق');assert.equal(r.request.destination,'الشارقة');assert.equal(r.request.passengers.adults,1);
});
test('status and thanks preserve the unresolved question and user turns',async()=>{
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),nlu:async()=>null,env:{}});await e.handle('ledger','من الشارقة للشام11-11-2026 ذهاب بس',{now});const q=e.state('ledger').lastQuestion;await e.handle('ledger','ناطر',{now});assert.equal(e.state('ledger').lastQuestion,q);await e.handle('ledger','شكرا',{now});assert.equal(e.state('ledger').lastQuestion,q);const r=await e.handle('ledger','شخص واحد',{now});assert.equal(r.complete,true);assert.equal(r.request.tripType,'one_way');assert.ok(e.state('ledger').history.some(m=>m.role==='user'&&m.text==='شكرا'));
});
test('same missing field is not asked again after an unrelated message',async()=>{
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),nlu:async()=>null,env:{}});await e.handle('once','من الشارقة للشام11-11-2026 ذهاب بس',{now});const r=await e.handle('once','لسا عم فكر',{now});assert.doesNotMatch(r.reply,/كم عدد المسافرين/);assert.equal(r.complete,false);
});
test('default30 is valid and FlyCham included30 does not trigger unsupported upgrade',()=>{
 assert.doesNotThrow(()=>validateLiveRequest(request,now));assert.equal(capabilityIssue({...request,provider:'flycham'}),null);assert.equal(capabilityIssue({...request,provider:'flycham',baggageRequest:{checkedWeightKg:40,requestedByCustomer:true}}),'constraints');
});
test('catalog retains only verified matching quotes and freshness is per offer',()=>{
 let time=now;const c=new FareCatalog({now:()=>time});assert.equal(c.acceptOffer(offer(),'airarabia'),true);assert.match(c.reply({destinationCountry:'سوريا'}),/700.00/);assert.match(c.reply(),/من الشارقة إلى دمشق/);assert.equal(c.acceptOffer(offer({...request,destination:'المنامة'}),'airarabia'),false);assert.equal(c.acceptOffer({...offer(),price:{sellingTotal:'700.00',weights:[]}},'airarabia'),false);time+=FRESH_MS+1;assert.equal(c.find().length,0);assert.match(c.reply(),/استرشادية/);time=now+INDICATIVE_MS+1;assert.equal(c.reply(),null);
});
test('route, return, weight and supplier cannot share an unrelated cached quote',()=>{
 const c=new FareCatalog({now:()=>now});c.acceptOffer(offer(),'airarabia');assert.equal(c.find({origin:'دمشق'}).length,0);assert.equal(c.find({provider:'flycham'}).length,0);assert.equal(c.find({tripType:'round_trip'}).length,0);assert.equal(c.find({baggageRequest:{checkedWeightKg:20}}).length,0);assert.equal(c.find({departureDate:'2026-11-12'}).length,0);
});
test('catalog leases are separate from customers and guard source request and expiry',()=>{
 let time=now;const c=new FareCatalog({now:()=>time});const job=c.claim('flycham');assert.equal(job.catalog,true);assert.equal(job.request.baggageRequest.checkedWeightKg,30);assert.equal(c.claim('flycham'),null);assert.equal(c.current(job.id,'wrong'),false);assert.equal(c.progress(job.id,job.lease,{offer:offer({...job.request,destination:'حلب'})}),true);assert.equal(c.records.size,0);time+=4*60000+1;assert.equal(c.current(job.id,job.lease),false);
});
test('month plan uses current and next Dubai month; return duration is explicit',()=>{
 const c=new FareCatalog({now:()=>now});const p=c.plan('airarabia');assert.equal(p.length,39*8*3);assert.equal(p[0].request.departureDate,'2026-10-23');assert.equal(p.at(-1).request.departureDate,'2026-11-30');assert.ok(p.some(t=>t.request.returnDate==='2026-12-14'&&t.request.stayNights===14));assert.equal(c.status().completeMonthlyCoverage,false);
});

test('a mistaken model clarification cannot prevent parsing the actual answer',async()=>{
 const {schema}=require('../src/assistant-nlu');let wrong=false;const fields=Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,['ages','excludedDates'].includes(k)?[]:null]));
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>wrong?{intent:'clarify',fields,question:'من أي مطار؟',option:null}:null});
 await e.handle('repair','للشارقة11-11-2026 ذهاب فقط شخص واحد',{now});wrong=true;const r=await e.handle('repair','من الشام',{now});assert.equal(r.complete,true);assert.equal(r.request.origin,'دمشق');assert.equal(r.request.destination,'الشارقة');
});
