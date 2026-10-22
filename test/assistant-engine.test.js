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
