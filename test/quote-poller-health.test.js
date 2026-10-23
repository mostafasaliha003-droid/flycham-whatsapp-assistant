'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startQuotePolling}=require('../src/quote-poller');
const env={AIR_ARABIA_QUOTE_QUEUE_URL:'https://flycham-whatsapp-assistant.onrender.com/internal/quotes',AIR_ARABIA_QUOTE_QUEUE_KEY:'test-only-queue-key-xxxxxxxxxxxxxxxxxx'};
const drain=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
test('an unverified supplier session withdraws readiness and never claims work',async()=>{
 const calls=[];const stop=startQuotePolling({isReady:()=>false,healthStatus:()=>({state:'recovering'})},{env,log:{log(){}},provider:'flycham',fetchImpl:async(url,options)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(options.body)});return{ok:true,json:async()=>({})};}});
 await drain();await stop();assert.equal(calls.length,1);assert.match(calls[0].path,/heartbeat$/);assert.equal(calls[0].body.ready,false);assert.equal(calls[0].body.status,'recovering');
});
test('a security challenge sends one unavailable signal and stops polling',async()=>{
 const calls=[];const stop=startQuotePolling({authBlocked:true,isReady:()=>false,healthStatus:()=>({state:'verification_required'})},{env,log:{log(){}},fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return{ok:true,json:async()=>({})};}});
 await drain();await stop();assert.deepEqual(calls,[{provider:'airarabia',ready:false,status:'verification_required'}]);
});
test('verified session propagates typed inventory results independently of prose',async()=>{
 const calls=[];const stop=startQuotePolling({isReady:()=>true,run:async()=>({reply:'verified result',outcome:'failed',coverage:[],status:'no_flights',availabilityEvidence:'supplier-explicit'})},{env,log:{log(){}},provider:'flycham',fetchImpl:async(url,options)=>{const path=new URL(url).pathname;calls.push({path,body:JSON.parse(options.body)});return{ok:true,json:async()=>path.endsWith('/claim')?{id:'job',lease:'lease',request:{}}:path.endsWith('/current')?{current:true}:{}};}});
 await drain();await stop();const final=calls.find(c=>c.path.endsWith('/complete'));assert.equal(final.body.status,'no_flights');assert.equal(final.body.availabilityEvidence,'supplier-explicit');assert.equal(final.body.reply,'verified result');
});
