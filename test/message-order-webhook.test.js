'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const secret='order-test-secret',key='z'.repeat(32);
Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'35',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'fake-test-token',WHATSAPP_PHONE_NUMBER_ID:'fake-test-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key,FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none'});
const {createServer}=require('../src/server');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('one webhook burst creates one request; an in-flight old price waits for and loses to the new weight',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'sent-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=(path,data,auth=true)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),headers={'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+key}:{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')})};const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(b||'{}')}));});req.on('error',reject);req.end(body);});
 let seq=0;const inbound=texts=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:texts.map(text=>({from:'order-customer',id:'incoming-'+(++seq),type:'text',text:{body:text}}))}}]}]},false);
 try{
  await post('/internal/quotes/heartbeat',{provider:'airarabia'});
  await inbound(['من الشارقة للشام','11-11-2090','ذهاب بس','شخص واحد']);assert.equal(out.length,0);await wait(90);assert.equal(out.length,1);
  const first=(await post('/internal/quotes/claim',{})).body;assert.ok(first.id);assert.equal(first.request.passengers.adults,1);assert.equal(first.request.baggageRequest.checkedWeightKg,30);
  await inbound(['بدي40كيلو']);
  // Use a spaced follow-up too: both pieces must belong to the same turn.
  await inbound(['بدي 40 كيلو']);
  const accepted=await post('/internal/quotes/complete',{id:first.id,lease:first.lease,reply:'OLD_PRICE_MUST_NOT_SEND',outcome:'done'});assert.equal(accepted.body.deferred,true);
  await wait(100);assert.equal(out.some(x=>x.text.body.includes('OLD_PRICE_MUST_NOT_SEND')),false);
  const second=(await post('/internal/quotes/claim',{})).body;assert.notEqual(second.id,first.id);assert.equal(second.request.baggageRequest.checkedWeightKg,40);assert.equal(second.request.departureDate,'2090-11-11');assert.equal(second.request.origin,'الشارقة');
  await inbound(['شكرا ناطرك']);await post('/internal/quotes/progress',{id:second.id,lease:second.lease,seq:1,reply:'',metadata:{offer:{request:second.request,timing:{out:{flight:'G9433',departure:'11 Nov2090 08:00',arrival:'11 Nov2090 10:00'}},price:{currency:'AED',sellingTotal:'800.00',weights:[{kg:40}]}}}});await post('/internal/quotes/complete',{id:second.id,lease:second.lease,reply:'NEW_VERIFIED_RESULT',outcome:'done'});await wait(90);assert.ok(out.some(x=>x.text.body.includes('800.00')));assert.deepEqual((await post('/internal/quotes/claim',{})).body,{});
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
