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
test('a failed price lookup is never logged as a successfully priced quote',async()=>{
 const logs=[];const stop=startQuotePolling({isReady:()=>true,run:async()=>({reply:'unconfirmed',outcome:'failed',coverage:[{status:'unverified',confirmed:0,failed:1}]})},{env,provider:'flycham',log:{log:x=>logs.push(x)},fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/claim')?{id:'job',lease:'lease',request:{}}:url.endsWith('/current')?{current:true}:{}})});
 await drain();await stop();assert.ok(!logs.includes('PORTAL_CUSTOMER_QUOTE_PRICED'));assert.ok(logs.includes('PORTAL_CUSTOMER_QUOTE_WITHOUT_VERIFIED_OFFER'));
});
test('a failed catalog search pauses only catalog work and checks customer jobs after three seconds',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const claims=[],completed=[];let jobs=0;
 const stop=startQuotePolling({isReady:()=>true,run:async()=>++jobs===1?{reply:'no flights',outcome:'failed',coverage:[]}:{reply:'customer result',outcome:'done',coverage:[{confirmed:1}] }},{env,provider:'flycham',log:{log:()=>{}},fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);let response={};
  if(url.endsWith('/claim')){claims.push(body);response=claims.length===1?{id:'catalog-one',lease:'one',request:{},catalog:true}:claims.length===2?{id:'customer-two',lease:'two',request:{}}:{};}
  if(url.endsWith('/current'))response={current:true};if(url.endsWith('/complete'))completed.push(body);
  return{ok:true,json:async()=>response};
 }});
 try{await drain();assert.equal(completed.length,1);t.mock.timers.tick(2999);await drain();assert.equal(claims.length,1);t.mock.timers.tick(1);await drain();assert.equal(claims.length,2);assert.equal(claims[1].includeCatalog,false);assert.equal(completed[1].id,'customer-two');t.mock.timers.tick(57000);await drain();assert.equal(claims[2].includeCatalog,undefined);}
 finally{await stop();t.mock.timers.reset();}
});
