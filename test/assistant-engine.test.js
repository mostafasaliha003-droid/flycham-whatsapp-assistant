'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');const {AssistantState}=require('../src/assistant-state');
const now=Date.parse('2026-10-23T08:00:00Z');
const make=()=>new AssistantEngine({store:new AssistantState({now:()=>now}),nlu:async()=>null,env:{}});
const initial='من الشارقة على الشام بدي ارخص سعر بهل اسبوع، ذهاب فقط';
test('Ahmed identifies himself honestly and asks count before starting a flexible-date quote',async()=>{
 const e=make();assert.match((await e.handle('a','مرحبا',{now})).reply,/أحمد.*الافتراضي/);
 const r=await e.handle('a',initial,{now});assert.equal(r.complete,false);assert.match(r.reply,/كم عدد المسافرين/);
 const q=await e.handle('a','لحالي',{now});assert.equal(q.complete,true);assert.equal(q.request.passengers.adults,1);
});
test('waiting, negotiating and thanking never launch duplicate searches or change the itinerary',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});e.jobState('a','searching');const before=JSON.stringify(e.state('a').base.request);
 for(const text of ['بانتظاركن','شو صار','شكرا','زبطونا بالسعر']){const r=await e.handle('a',text,{now});assert.equal(r.complete,false);}
 assert.equal(JSON.stringify(e.state('a').base.request),before);assert.match((await e.handle('a','غالي',{now})).reply,/نهائي/);
});
test('a weight change retains dates; a hypothetical comparison preserves the base request',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});e.jobState('a','searching');
 const r=await e.handle('a','بدي 30 كيلو',{now});assert.equal(r.complete,true);assert.equal(r.request.baggageRequest.checkedWeightKg,30);
 const date=r.request.departureRange.start;const comparison=await e.handle('a','لو بدي 20 كيلو',{now});assert.equal(comparison.complete,true);assert.equal(comparison.comparison,true);assert.equal(e.state('a').base.request.baggageRequest.checkedWeightKg,30);assert.equal(comparison.request.departureRange.start,date);
});
test('goodbye pauses and cancellation clears the request; neither confirms a booking',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});assert.equal((await e.handle('a','خلص برجعلكن',{now})).cancel,true);
 const r=await e.handle('a','وقف البحث',{now});assert.equal(r.cancel,true);assert.equal(e.state('a').base,null);
});
test('unsupported party size is not priced by multiplying a single-person fare',async()=>{
 const e=make();const r=await e.handle('a',initial+'، 2 بالغين',{now});assert.equal(r.complete,false);assert.match(r.reply,/لا|ما رح/);assert.match(r.reply,/مجموعة/);
});
test('a selected verified offer queues a booking handoff without claiming ticket issuance',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});
 const o={reference:1,request:{origin:'الشارقة',destination:'دمشق',departureDate:'2026-10-24'},timing:{out:{flight:'G9433',departure:'08:00',arrival:'10:00'}},price:{sellingTotal:'750.50',weights:[{kg:30}]}};
 e.progress('a',{offer:o},'quoted-message');await e.handle('a','الخيار 1',{now});const r=await e.handle('a','كيف التثبيت',{now});assert.ok(r.handoff);assert.equal(r.cancel,true);assert.match(r.reply,/لم يتم حجز/);assert.equal(e.store.data.handoffs.length,1);
});
test('quoted offer context resolves a baggage change to that offer, not the latest result',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});const request=e.state('a').base.request;
 for(const [date,id,reference]of [['2026-10-24','older',1],['2026-10-25','newer',2]])e.progress('a',{offer:{reference,request:{...request,departureDate:date,departureRange:null},timing:{out:{flight:'G9433'}},price:{sellingTotal:'750.50',weights:[{kg:20}]}}},id);
 const r=await e.handle('a','بدي 30 كيلو',{now,quotedMessageId:'older'});assert.equal(r.request.departureDate,'2026-10-24');
});
test('invalid date cannot overwrite a valid stored itinerary',async()=>{
 const e=make();await e.handle('a',initial+'، 1 بالغ',{now});const before=JSON.stringify(e.state('a').base.request);
 await e.handle('a','31-02-2027',{now});assert.equal(JSON.stringify(e.state('a').base.request),before);
});
test('state survives encrypted snapshot reload without plaintext passenger or contact data',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remal-state-'));const file=path.join(dir,'state.enc');try{
 const store=new AssistantState({file,key:'test-key',now:()=>now});store.set('private-customer',{request:'private-trip'});assert.equal(fs.readFileSync(file).includes(Buffer.from('private-customer')),false);
 const restored=new AssistantState({file,key:'test-key',now:()=>now});assert.equal(restored.get('private-customer').request,'private-trip');assert.equal(restored.status().durableStorageConfirmed,false);
 }finally{fs.rmSync(dir,{recursive:true});}
});
test('per-customer batching combines bursts and serializes processing',async()=>{
 const {MessageBatcher}=require('../src/message-batcher');const calls=[];const b=new MessageBatcher(async(id,m)=>{calls.push([id,m.map(x=>x.text).join(' ')]);},{delay:5});await Promise.all([b.push('a',{text:'من الشارقة'}),b.push('a',{text:'على الشام'})]);assert.deepEqual(calls,[['a','من الشارقة على الشام']]);
});

function nluDecision(fields,intent='request') {
 const {schema}=require('../src/assistant-nlu');
 return {intent,fields:{...Object.fromEntries(Object.keys(schema.properties.fields.properties).map(k=>[k,['ages','excludedDates'].includes(k)?[]:null])),...fields},question:null,option:null};
}
test('structured extraction preserves original relative dates when model only supplies route and count',async()=>{
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>nluDecision({origin:'الشارقة',destination:'دمشق',adults:1,weightKg:30,tripType:'one_way'})});
 const r=await e.handle('nlu-dates','من شارق للشام الأسبوع الجاي، لحالي، ذهاب فقط، ثلاثين كيلو',{now});
 assert.equal(r.complete,true);assert.ok(r.request.departureRange);assert.equal(r.request.baggageRequest.checkedWeightKg,30);assert.equal(r.request.baggageRequest.requestedByCustomer,true);assert.equal(e.state('nlu-dates').lastQuestion,null);
});
test('greeting classification cannot discard a travel request containing structured facts',async()=>{
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>nluDecision({origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',adults:1,tripType:'one_way'},'greeting')});
 const r=await e.handle('nlu-greet','اهلين بدي سافر',{now});assert.equal(r.complete,true);assert.equal(r.request.destination,'دمشق');
});
test('structured baggage amendment preserves route and the whole date range',async()=>{
 let first=true;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>first?(first=false,nluDecision({origin:'الشارقة',destination:'دمشق',rangeStart:'2026-10-26',rangeEnd:'2026-11-01',adults:1,tripType:'one_way'})):nluDecision({weightKg:30},'change')});
 await e.handle('nlu-weight','بدي سافر الأسبوع الجاي لحالي',{now});e.jobState('nlu-weight','searching');
 const r=await e.handle('nlu-weight','خلي الشنطة ثلاثين',{now});assert.equal(r.complete,true);assert.equal(r.request.departureRange.end,'2026-11-01');assert.equal(r.request.origin,'الشارقة');assert.equal(r.request.baggageRequest.checkedWeightKg,30);
});
test('structured child ages update the existing party rather than repeating the age question',async()=>{
 let first=true;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>first?(first=false,nluDecision({origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',adults:1,children:1,tripType:'one_way'})):nluDecision({ages:[7]},'change')});
 assert.match((await e.handle('nlu-child','معي ابني',{now})).reply,/أعمار/);
 const r=await e.handle('nlu-child','عمره سبعة',{now});assert.doesNotMatch(r.reply,/كم أعمار/);assert.deepEqual(e.state('nlu-child').base.request.passengers.ages,[7]);
});

test('model-selected offer becomes the context for later baggage amendments',async()=>{
 let select=false;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>select?{...nluDecision({},'select'),option:2}:null});
 await e.handle('select-context',initial+'، 1 بالغ',{now});const request=e.state('select-context').base.request;
 for(const [date,reference]of [['2026-10-24',1],['2026-10-25',2]])e.progress('select-context',{offer:{reference,request:{...request,departureDate:date,departureRange:null},timing:{out:{flight:'G9433'}},price:{sellingTotal:'750.50',weights:[{kg:20}]}}},'offer-'+reference);
 select=true;const picked=await e.handle('select-context','عجبني التاني خلينا عليه',{now});assert.equal(picked.complete,false);assert.match(picked.reply,/الخيار 2/);
 select=false;const amendment=await e.handle('select-context','بدي 30 كيلو',{now});assert.equal(amendment.complete,true);assert.equal(amendment.request.departureDate,'2026-10-25');assert.equal(amendment.request.departureRange,null);assert.equal(amendment.request.baggageRequest.checkedWeightKg,30);
});
test('brief acknowledgements while queued or searching retain the request without a new search',async()=>{
 const e=make();await e.handle('queued-ack',initial+'، 1 بالغ',{now});const before=JSON.stringify(e.state('queued-ack').base.request);
 for(const state of ['queued','searching']){e.jobState('queued-ack',state);for(const text of ['تمام','اوكي','حاضر']){const r=await e.handle('queued-ack',text,{now});assert.equal(r.complete,false);assert.match(r.reply,/البحث مستمر/);assert.doesNotMatch(r.reply,/أي خيار|طلبك السابق/);}}
 assert.equal(JSON.stringify(e.state('queued-ack').base.request),before);
});
test('waiting words cannot swallow a concrete dated amendment',async()=>{
 let calls=0;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>{calls++;return calls===1?null:nluDecision({departureDate:'2026-11-02'},'change');}});
 await e.handle('status-amend',initial+'، 1 بالغ',{now});e.jobState('status-amend','searching');const r=await e.handle('status-amend','ناطر بس خلينا 2 نوفمبر',{now});assert.equal(r.complete,true);assert.equal(r.request.departureDate,'2026-11-02');assert.equal(calls,2);
});
test('pending duplicate intent retains the queued job and replies with progress',async()=>{
 const e=make();await e.handle('duplicate',initial+'، 1 بالغ',{now});
 const r=await e.handle('duplicate','لحالي',{now});assert.equal(r.complete,false);assert.match(r.reply,/البحث مستمر/);assert.equal(e.state('duplicate').status,'queued');
});
test('semantic booking intent sends a verified selection to staff without claiming issuance',async()=>{
 let booking=false;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>booking?nluDecision({},'booking'):null});await e.handle('semantic-book',initial+'، 1 بالغ',{now});
 const request=e.state('semantic-book').base.request;e.progress('semantic-book',{offer:{reference:1,request:{...request,departureDate:'2026-10-24',departureRange:null},timing:{out:{flight:'G9433'}},price:{sellingTotal:'750.50',weights:[{kg:20}]}}},'offer');
 booking=true;const r=await e.handle('semantic-book','شو الخطوة اللي بعدها لحتى تصير التذكرة باسمي',{now});assert.ok(r.handoff);assert.match(r.reply,/لم يتم حجز أو إصدار/);assert.equal(e.store.data.handoffs.length,1);
});
test('selecting an offer with a baggage amendment applies both instructions',async()=>{
 let amend=false;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>amend?{...nluDecision({weightKg:30},'select'),option:1}:null});await e.handle('select-amend',initial+'، 1 بالغ',{now});
 const request=e.state('select-amend').base.request;e.progress('select-amend',{offer:{reference:1,request:{...request,departureDate:'2026-10-25',departureRange:null},timing:{out:{flight:'G9433'}},price:{sellingTotal:'750.50',weights:[{kg:20}]}}},'offer');
 amend=true;const r=await e.handle('select-amend','بدي هاد الخيار بس مع ثلاثين كيلو',{now});assert.equal(r.complete,true);assert.equal(r.request.departureDate,'2026-10-25');assert.equal(r.request.baggageRequest.checkedWeightKg,30);
});
test('NLU sees bounded verified offer identities and price ranks without prices or customer payloads',async()=>{
 let captured=null;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async(text,context)=>{captured=context;return null;}});
 await e.handle('offer-context',initial+'، 1 بالغ',{now});const request=e.state('offer-context').base.request;
 for(const [reference,total,time]of [[1,'750.50','08:00'],[2,'700.01','13:00'],[3,'700.01','21:00']])e.progress('offer-context',{offer:{reference,customerName:'PRIVATE_NAME',rawPayload:'PRIVATE_RAW',request:{...request,customerName:'PRIVATE_REQUEST_NAME',departureDate:'2026-10-25',departureRange:null},timing:{out:{flight:'G943'+reference,departure:time,arrival:'23:00'},back:null},price:{sellingTotal:total,private:'PRIVATE_PRICE'}}},'offer-'+reference);
 await e.handle('offer-context','بفضل الرحلة الصبح',{now});assert.equal(captured.offerSummaries.length,3);assert.deepEqual(captured.offerSummaries.map(o=>[o.reference,o.cheapestRank]),[[1,2],[2,1],[3,1]]);assert.equal(captured.offerSummaries[0].departureTime,'08:00');assert.equal(captured.offerSummaries[0].flight,'G9431');
 const serialized=JSON.stringify(captured.offerSummaries);assert.doesNotMatch(serialized,/PRIVATE_|750\.50|700\.01|sellingTotal|price|rawPayload|customerName/);
});

test('model cannot ask trip type again after an explicit one-way answer',async()=>{
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>({...nluDecision({origin:'الشارقة',destination:'دمشق',adults:1},'clarify'),question:'هل الرحلة ذهاب وعودة؟'})});
 const r=await e.handle('trip-repeat','من الشارقة للشام الأسبوع الجاي، لشخص واحد، ذهاب بس',{now});
 assert.equal(r.complete,true);assert.equal(r.request.tripType,'one_way');assert.doesNotMatch(r.reply,/هل الرحلة/);
});
test('stored trip type survives a redundant model question on the next turn',async()=>{
 let first=true;const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>first?(first=false,null):({...nluDecision({},'clarify'),question:'ذهاب فقط أو ذهاب وعودة؟'})});
 const a=await e.handle('trip-stored',initial,{now});assert.match(a.reply,/عدد المسافرين/);
 const b=await e.handle('trip-stored','شخص واحد',{now});assert.equal(b.complete,true);assert.equal(b.request.tripType,'one_way');
});
test('trip type synonyms parse without needing an external model',()=>{
 const {parseTripType}=require('../src/conversation');
 for(const text of ['ذهاب بس','بس روحة','روحه','اتجاه واحد','رايح فقط'])assert.equal(parseTripType(text),'one_way',text);
 for(const text of ['روحة ورجعة','روحه و رجعه','ذهاب واياب','رايح وراجع','ذهاب وعودة'])assert.equal(parseTripType(text),'round_trip',text);
 assert.equal(parseTripType('نعم'),null);
});
