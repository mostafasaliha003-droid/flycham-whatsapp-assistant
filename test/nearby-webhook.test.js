'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const secret='nearby-webhook-test-secret',key='nearby-webhook-key-xxxxxxxxxxxxxxxx';
Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'nearby-test-token',WHATSAPP_PHONE_NUMBER_ID:'nearby-test-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key,FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none'});
const {createServer}=require('../src/server');

test('signed WhatsApp request suggests verified before/after one-day alternatives and selection retains the alternative date',async()=>{
 const originalFetch=global.fetch,out=[];
 global.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(options.body));return{ok:true,json:async()=>({messages:[{id:'nearby-sent-'+out.length}]})};};
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 const post=(path,data,inbound=false)=>new Promise((resolve,reject)=>{
  const body=JSON.stringify(data),headers={'Content-Type':'application/json',...(inbound?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+key})};
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}));});req.on('error',reject);req.end(body);
 });
 const inbound=text=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:'synthetic-nearby-customer',id:'nearby-inbound-'+(++sequence),type:'text',text:{body:text}}]}}]}]},true);
 const waitForReply=async count=>{for(let i=0;i<40&&out.length<count;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(out.length,count);};
 const claim=async()=>{const result=await post('/internal/quotes/claim',{provider:'flycham'});assert.equal(result.status,200);return result.body;};
 const complete=async(job,status)=>{const result=await post('/internal/quotes/complete',{id:job.id,lease:job.lease,reply:'SUPPLIER_PROSE_MUST_NOT_SET_CUSTOMER_PRICE',outcome:status==='no_flights'?'failed':'done',coverage:[{date:job.request.departureDate,status}]});assert.equal(result.status,200);};
 const progress=async(job,{flight,total,departure,arrival})=>{
  const result=await post('/internal/quotes/progress',{id:job.id,lease:job.lease,seq:1,reply:'SUPPLIER_PROSE_MUST_NOT_SET_CUSTOMER_PRICE',metadata:{offer:{provider:'flycham',request:job.request,price:{currency:'AED',sellingTotal:total,weights:[{kg:30}]},timing:{out:{flight,departure,arrival}}}}});assert.equal(result.status,200);
 };
 try{
  await post('/internal/quotes/heartbeat',{provider:'flycham',ready:true});
  assert.equal((await inbound('من الشارقة للشام 11-11-2090 ذهاب بس شخص واحد فلاي شام فقط')).status,200);await waitForReply(1);
  const exact=await claim();assert.ok(exact.id);assert.equal(exact.request.departureDate,'2090-11-11');assert.equal(exact.request.origin,'الشارقة');assert.equal(exact.request.destination,'دمشق');
  assert.deepEqual((await post('/internal/quotes/claim',{provider:'airarabia'})).body,{});
  await complete(exact,'no_flights');
  const before=await claim(),after=await claim();assert.equal(before.request.departureDate,'2090-11-10');assert.equal(after.request.departureDate,'2090-11-12');
  for(const job of [before,after]){assert.equal(job.request.origin,'الشارقة');assert.equal(job.request.destination,'دمشق');assert.equal(job.request.passengers.adults,1);assert.equal(job.request.baggageRequest.checkedWeightKg,30);assert.equal(job.request.tripType,'one_way');}
  assert.deepEqual(await claim(),{});
  await progress(before,{flight:'XH710',total:'610.00',departure:'10 Nov2090 08:00',arrival:'10 Nov2090 10:00'});await complete(before,'confirmed');
  await progress(after,{flight:'XH712',total:'620.00',departure:'12 Nov2090 14:30',arrival:'12 Nov2090 16:30'});await complete(after,'confirmed');await waitForReply(2);
  const card=out[1].text.body;assert.equal(out[1].to,'synthetic-nearby-customer');assert.match(card,/التاريخ المطلوب: 2090-11-11/);assert.match(card,/قبل موعدك بيوم/);assert.match(card,/بعد موعدك بيوم/);
  for(const detail of ['2090-11-10','2090-11-12','610.00','620.00','XH710','XH712','08:00','14:30','30 كيلو مسجل'])assert.ok(card.includes(detail),detail);
  assert.doesNotMatch(card,/SUPPLIER_PROSE_MUST_NOT_SET_CUSTOMER_PRICE/);assert.deepEqual(await claim(),{});
  await inbound('الخيار 1');await waitForReply(3);assert.match(out[2].text.body,/2090-11-10/);assert.match(out[2].text.body,/XH710/);assert.deepEqual(await claim(),{});
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;}
});
