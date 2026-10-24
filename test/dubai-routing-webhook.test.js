'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubai-routing-')),secret='synthetic-routing-secret',admin='synthetic-routing-admin-key-xxxxxxxxxx',customer='synthetic-routing-customer',NOW=Date.parse('2026-10-24T23:01:00Z');
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(dir,'state.enc'),WHATSAPP_APP_SECRET:secret,ASSISTANT_ADMIN_KEY:admin,AIR_ARABIA_QUOTE_QUEUE_KEY:admin,AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',CONSULTANT_ORCHESTRATOR_ENABLED:'true',ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-routing-cline',ASSISTANT_DEBOUNCE_MS:'10',DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-number',NODE_ENV:'production'});
const {AssistantState}=require('../src/assistant-state');
const seed=new AssistantState({now:()=>NOW});seed.set(customer,{history:[],offers:[],introduced:true,status:'done',base:{submitted:true,awaiting:null,at:NOW,request:{origin:'أبوظبي',destination:'دمشق',departureRange:{start:'2026-12-01',end:'2026-12-31'},departureDate:null,returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},provider:'airarabia',providerExclusive:true}}});
const {schema}=require('../src/consultant-brain'),{createServer}=require('../src/server');
test('the screenshot conversation searches both suppliers at valid airports and accepts its actual next-step proposal',async()=>{
 const originalFetch=global.fetch,originalNow=Date.now;Date.now=()=>NOW;const out=[];let modelCalls=0,seq=0;
 global.fetch=async(url,opt)=>{
  if(String(url).includes('api.cline.bot')){modelCalls++;const fields=Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null]));Object.assign(fields,{origin:'دبي',rangeStart:'2026-11-01',rangeEnd:'2026-11-30'});const d={intent:'change',fields,question:null,option:null,consultant:{action:'amend',reply:null,preferences:{priority:'cheapest',airportFlexibility:'flexible'},nextStep:'search',knowledgeQuery:null}};return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})};}
  assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body).text.body);return {ok:true,json:async()=>({messages:[{id:'synthetic-output-'+out.length}]})};
 };
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=(route,data,inbound=false)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),q=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:'POST',headers:{'Content-Type':'application/json',...(inbound?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+admin})}},r=>{let text='';r.on('data',c=>text+=c);r.on('end',()=>resolve(JSON.parse(text||'{}')));});q.on('error',reject);q.end(body);});
 const inbound=texts=>call('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:texts.map(body=>({id:'synthetic-in-'+(++seq),from:customer,type:'text',text:{body}}))}}]}]},true);
 const waitFor=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected bounded async delivery');};
 const claim=provider=>call('/internal/quotes/claim',{provider,includeCatalog:false});
 try{
  await call('/internal/quotes/heartbeat',{provider:'flycham',ready:true});await call('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});
  await inbound(['لا اخي بدي سافر من الإمارات على سوريا بس من دبي','او ارخص شي','الشهر القادم','شو ارخص سعر']);await waitFor(()=>out.some(x=>x.includes('جاري البحث')));
  const ack=out.find(x=>x.includes('جاري البحث'));assert.match(ack,/فلاي شام/);assert.match(ack,/العربية للطيران/);assert.match(ack,/الشارقة وأبوظبي/);assert.match(ack,/2026-11-01/);assert.match(ack,/2026-11-30/);
  const seen=[];for(const provider of ['flycham','airarabia'])for(let i=0;i<2;i++){
   const j=await claim(provider);assert.ok(j.id);seen.push([provider,j.request.origin]);assert.equal(j.request.passengers.adults,1);assert.equal(j.request.baggageRequest.checkedWeightKg,30);assert.match(j.request.departureDate,/^2026-11-/);
   assert.equal((await call('/internal/quotes/complete',{id:j.id,lease:j.lease,status:'airport_unconfirmed',outcome:'failed',reply:''})).accepted,true);
  }
  assert.deepEqual(seen,[['flycham','دبي'],['flycham','الشارقة'],['airarabia','الشارقة'],['airarabia','أبوظبي']]);
  await waitFor(()=>out.some(x=>x.includes('سبعة أيام بعد آخر تاريخ')));const final=out.filter(x=>x.includes('مقارنة رحلتك')).join('\n');assert.match(final,/فلاي شام/);assert.match(final,/العربية للطيران/);assert.doesNotMatch(final,/؛ ما في رحلات متاحة/);
  const callsBefore=modelCalls;await inbound(['شفلي']);await waitFor(()=>out.some(x=>x.includes('2026-12-01')&&x.includes('جاري البحث')));assert.equal(modelCalls,callsBefore);
  const next=await claim('flycham');assert.equal(next.request.origin,'دبي');assert.equal(next.request.departureDate,'2026-12-01');assert.equal(next.request.baggageRequest.checkedWeightKg,30);assert.equal(next.request.passengers.adults,1);
 }finally{await new Promise(r=>server.close(r));global.fetch=originalFetch;Date.now=originalNow;fs.rmSync(dir,{recursive:true,force:true});}
});
