'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QuoteJobs}=require('../src/quote-jobs');
const {readFlyChamConfig,formatFlyChamOffers,runFlyCham}=require('../src/flycham-worker');
const {priceFlyChamQuote}=require('../src/flycham-pricing');
test('FlyCham jobs cannot be claimed by the Air Arabia consumer and readiness is supplier-specific',()=>{
 let now=100000;const q=new QuoteJobs({now:()=>now});q.claim();assert.equal(q.ready(),true);assert.equal(q.ready('flycham'),false);
 assert.throws(()=>q.enqueue('a',{provider:'flycham'}),/QUEUE_UNAVAILABLE/);q.claim('flycham');const id=q.enqueue('a',{provider:'flycham'});assert.equal(q.claim(),null);const j=q.claim('flycham');assert.equal(j.id,id);now+=21000;q.current(j.id,j.lease);assert.equal(q.ready('flycham'),true);assert.equal(q.ready(),false);
});
test('switching an existing request to an unavailable supplier cannot bypass readiness',()=>{
 const q=new QuoteJobs({now:()=>100000});q.claim();q.enqueue('a',{});assert.throws(()=>q.enqueue('a',{provider:'flycham'}),/QUEUE_UNAVAILABLE/);assert.throws(()=>q.claim('other'),/QUEUE_PROVIDER_INVALID/);
});
test('FlyCham runtime is inert before its explicit enable flag',async()=>{
 let launched=false;await runFlyCham({env:{},launch:async()=>{launched=true;}});assert.equal(launched,false);
});
test('worker reads credentials only from its own environment without any network distribution',async()=>{
 const config=await readFlyChamConfig({FLYCHAM_AGENT_USERNAME:'test-user',FLYCHAM_AGENT_PASSWORD:'test-password'});assert.equal(config.username,'test-user');
 await assert.rejects(readFlyChamConfig({}),/FLYCHAM_CONFIG_MISSING/);
 await assert.rejects(readFlyChamConfig({FLYCHAM_AGENT_USERNAME:'test-user'}),/FLYCHAM_CONFIG_MISSING/);
});
test('FlyCham customer card uses FlyCham margin and future gift without Air Arabia meal or seat fees',()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'};
 const price=priceFlyChamQuote({currency:'AED',baseTotal:'643.00',tripType:'one_way',verifiedFirstPage:true});
 const text=formatFlyChamOffers(request,[{request,price,timing:{out:{origin:'SHJ',destination:'DAM',flight:'XH744',departure:'05:30',arrival:'08:00'}}}],{dates:['2026-11-11']});
 assert.match(text,/683.00/);assert.match(text,/10.00/);assert.match(text,/XH744/);assert.match(text,/لم يكتمل/);assert.match(text,/بعد تأكيد التذكرة/);assert.doesNotMatch(text,/العربية للطيران/);
});
test('explicit FlyCham preference is retained through a short amendment',()=>{
 const c=require('../src/conversation');const now=Date.parse('2026-10-23T08:00:00Z');
 const a=c.handleMessage('fly-preference','من الشارقة على الشام، 11-11-2026، ذهاب فقط، 1 بالغ، فلاي شام',{now});assert.equal(a.request.provider,'flycham');
 const b=c.handleMessage('fly-preference','12-11-2026',{now});assert.equal(b.request.provider,'flycham');assert.equal(b.request.departureDate,'2026-11-12');
});
