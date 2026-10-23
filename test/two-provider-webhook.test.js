'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const secret='two-provider-test-secret',key='x'.repeat(32);
Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'test-token',WHATSAPP_PHONE_NUMBER_ID:'test-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key,FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none'});
const {createServer}=require('../src/server');
const wait=()=>new Promise(r=>setTimeout(r,25));
test('one customer request compares both airlines and does not send prices supplied only in prose',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'sent-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let message=0;
 const post=(path,data,auth=true)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),headers={'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+key}:{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')})};const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(s||'{}')}));});q.on('error',reject);q.end(body);});
 const inbound=text=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:'test-comparison-customer',id:'two-'+(++message),type:'text',text:{body:text}}]}}]}]},false);
 const progress=async(job,flight,total)=>post('/internal/quotes/progress',{id:job.id,lease:job.lease,seq:1,reply:'DO_NOT_TRUST_THIS_PRICE',metadata:{offer:{provider:job.request.provider,request:job.request,timing:{out:{flight,departure:'11 Nov2090 08:00',arrival:'11 Nov2090 10:00'}},price:{currency:'AED',sellingTotal:total,weights:[{kg:30}]}}}});
 const complete=job=>post('/internal/quotes/complete',{id:job.id,lease:job.lease,reply:'UNVERIFIED_PROSE_1_DIRHAM',outcome:'done',coverage:[{date:job.request.departureDate,status:'confirmed'}]});
 try{
  for(const provider of ['airarabia','flycham'])await post('/internal/quotes/heartbeat',{provider,ready:true});
  await inbound('من الشارقة للشام 11-11-2090 ذهاب بس شخص واحد');await wait();
  const air=(await post('/internal/quotes/claim',{provider:'airarabia'})).body,fly=(await post('/internal/quotes/claim',{provider:'flycham'})).body;
  assert.ok(air.id&&fly.id);assert.notEqual(air.id,fly.id);assert.equal(air.request.provider,'airarabia');assert.equal(fly.request.provider,'flycham');
  await progress(air,'G9433','600.00');await complete(air);await wait();assert.equal(out.length,1);
  await progress(fly,'XH744','650.00');await complete(fly);await wait();
  assert.equal(out.length,2);assert.match(out[1].text.body,/العربية للطيران/);assert.match(out[1].text.body,/فلاي شام/);assert.match(out[1].text.body,/600.00/);assert.match(out[1].text.body,/650.00/);assert.match(out[1].text.body,/10.00/);assert.doesNotMatch(out[1].text.body,/UNVERIFIED_PROSE|DO_NOT_TRUST/);
  await inbound('الخيار 2');await wait();assert.match(out.at(-1).text.body,/XH744/);
  await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:false,status:'verification_required'});
  assert.deepEqual((await post('/internal/quotes/claim',{provider:'flycham'})).body,{});
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
test('Aleppo requests enter both provider queues; the second journey starts only after the first final is sent',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'queue-sent-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let message=0;
 const post=(path,data,auth=true)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),headers={'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+key}:{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')})};const q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s||'{}')));});q.on('error',reject);q.end(body);});
 const inbound=text=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:'aleppo-queue-customer',id:'aleppo-'+(++message),type:'text',text:{body:text}}]}}]}]},false);
 const complete=job=>post('/internal/quotes/complete',{id:job.id,lease:job.lease,reply:'NO_PRICE_IN_PROSE',outcome:'failed',coverage:[{date:job.request.departureDate,status:'unverified'}]});
 try{
  for(const provider of ['airarabia','flycham'])await post('/internal/quotes/heartbeat',{provider,ready:true});
  await inbound('هلا من الشارقة لحلب 11-11-2090 ذهاب بس شخص واحد');await wait();assert.match(out.at(-1).text.body,/معك أحمد/);
  const air=await post('/internal/quotes/claim',{provider:'airarabia'}),fly=await post('/internal/quotes/claim',{provider:'flycham'});assert.equal(air.request.destination,'حلب');assert.equal(fly.request.destination,'حلب');
  await inbound('طلب تاني من دمشق للشارقة 15-11-2090 ذهاب بس شخص واحد');await wait();assert.match(out.at(-1).text.body,/طلبك الأول.*طلبك التاني/);
  await complete(air);await wait();assert.deepEqual(await post('/internal/quotes/claim',{provider:'airarabia'}),{});
  await complete(fly);await wait();await wait();const second=await post('/internal/quotes/claim',{provider:'airarabia'});assert.ok(second.id);assert.equal(second.request.origin,'دمشق');assert.equal(second.request.destination,'الشارقة');assert.equal(second.request.departureDate,'2090-11-15');assert.ok(out.findIndex(x=>/مقارنة رحلتك/.test(x.text.body))<out.findIndex(x=>/15-11|2090-11-15/.test(x.text.body)));
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
