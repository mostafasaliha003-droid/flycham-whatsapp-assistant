'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {validateLiveRequest}=require('../src/live-quote');
const {airportCodeConfirmed,chooseAirport}=require('../src/portal-search-probe');
const now=Date.parse('2026-10-23T17:00:00Z');
const make=nlu=>new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:nlu||asyncNull});
async function asyncNull(){return null;}
const request={origin:'الشارقة',destination:'حلب',departureDate:'2026-10-25',tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]}};
test('Aleppo is a searchable candidate, with exact supplier airport confirmation still required',async()=>{
 assert.equal(validateLiveRequest(request,now).destination,'ALP');
 assert.equal(airportCodeConfirmed('ALP - Aleppo','ALP'),true);
 assert.equal(airportCodeConfirmed('ALP / DAM','ALP'),false);
 assert.equal(airportCodeConfirmed('Aleppo','ALP'),false);
 let hidden='',clicked=0;
 const frame={evaluate:async(fn,args)=>({status:args.operation==='input'?'INPUT_READY':'READY'}),locator:()=>({fill:async()=>{},pressSequentially:async()=>{},press:async()=>{},inputValue:async()=>hidden}),evaluateHandle:async()=>({asElement:()=>({click:async()=>{clicked++;hidden='ALP - Aleppo';}}),dispose:async()=>{}})};
 await chooseAirport(frame,'tAirport','toAirport','ALP',{lookupMs:0});assert.equal(clicked,1);
});
test('waiting on a previously blocked Aleppo request actually resubmits known trip facts',async()=>{
 const e=make();e.store.set('old',{history:[],offers:[],selected:null,base:{request,submitted:true,awaiting:null,at:now},status:'unsupported'});
 const result=await e.handle('old','لا أنا بانتظار الأسعار',{now});
 assert.equal(result.complete,true);assert.equal(result.request.destination,'حلب');assert.equal(result.request.passengers.adults,1);assert.equal(e.state('old').status,'queued');assert.doesNotMatch(result.reply,/ابعتلي تفاصيل|ما في بحث|يغطي|المتصل الحالي/);
});
test('greeting and travel facts in one batch introduce Ahmed once while retaining the itinerary',async()=>{
 const e=make();const result=await e.handle('greet','هلا، كيفكن، من الشارقة لحلب يوم الأحد ذهاب بس شخص واحد',{now});assert.equal(result.complete,true);assert.match(result.reply,/معك أحمد/);
 const waiting=await e.handle('greet','بانتظار الأسعار',{now});assert.doesNotMatch(waiting.reply,/معك أحمد/);assert.match(waiting.reply,/قيد العمل|البحث مستمر/);
});
test('a distinct journey queues behind the first, while baggage edits remain amendments',async()=>{
 const e=make();await e.handle('queue','من الشارقة للشام 25-10-2026 ذهاب بس شخص واحد',{now});e.jobState('queue','searching');const before=structuredClone(e.state('queue').base);
 const queued=await e.handle('queue','طلب تاني من حلب للشارقة 11-11-2026 ذهاب فقط شخص واحد',{now});assert.equal(queued.complete,false);assert.match(queued.reply,/طلبك الأول.*طلبك التاني/);assert.deepEqual(e.state('queue').base,before);assert.equal(e.state('queue').pendingRequests.length,1);assert.equal(e.beginNextRequest('queue'),null);
 const amendment=await e.handle('queue','بدي 30 كيلو',{now});assert.equal(amendment.complete,true);assert.equal(amendment.request.origin,'الشارقة');assert.equal(e.state('queue').pendingRequests.length,1);
 e.jobState('queue','done');assert.equal(e.beginNextRequest('queue'),null);const state=e.state('queue');state.queueReady=true;e.store.set('queue',state);const next=e.beginNextRequest('queue');assert.ok(next);const second=await e.handle('queue',next.text,{now});assert.equal(second.complete,true);assert.equal(second.request.origin,'حلب');assert.equal(second.request.destination,'الشارقة');assert.equal(second.request.departureDate,'2026-11-11');assert.equal(e.state('queue').pendingRequests.length,0);
});
test('NLU prefetch changes no trip state and is reused only with exactly matching context',async()=>{
 let calls=0;const e=make(async()=>{calls++;return null;});await e.prepare('prep','من الشارقة للشام',{now});await Promise.resolve();assert.equal(e.store.get('prep'),undefined);assert.equal(calls,1);await e.handle('prep','من الشارقة للشام',{now:now+25000});assert.equal(calls,1);
 await e.prepare('prep','ذهاب بس',{now:now+30000});await e.handle('prep','ذهاب وعودة',{now:now+55000});assert.equal(calls,3);
});
