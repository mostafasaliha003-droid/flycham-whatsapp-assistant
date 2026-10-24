'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const key='test-only-catalog-key-xxxxxxxxxxxxxxxx',secret='test-only-catalog-signing';
Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'0',ASSISTANT_AI_PROVIDER:'none',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'true',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key,FARE_CATALOG_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true'});
const {createServer}=require('../src/server');
test('catalog exclusion never blocks a queued customer and never claims background work during cooldown',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=(path,data,inbound=false)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',...(inbound?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+key})}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s||'{}')));});q.on('error',reject);q.end(body);});
 try{
  await post('/internal/quotes/heartbeat',{provider:'flycham',ready:true});
  assert.deepEqual(await post('/internal/quotes/claim',{provider:'flycham',includeCatalog:false}),{});
  await post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:'synthetic-customer',id:'catalog-priority-inbound',type:'text',text:{body:'من ابوظبي إلى دمشق 18-11-2099 ذهاب بس شخص واحد فلاي شام فقط'}}]}}]}]},true);
  await new Promise(resolve=>setTimeout(resolve,30));
  const customer=await post('/internal/quotes/claim',{provider:'flycham',includeCatalog:false});assert.ok(customer.id);assert.ok(!customer.catalog);assert.equal(customer.request.origin,'دبي');assert.equal(customer.request.departureDate,'2099-11-18');
  const sharjah=await post('/internal/quotes/claim',{provider:'flycham',includeCatalog:false});assert.equal(sharjah.request.origin,'الشارقة');assert.equal(sharjah.request.departureDate,'2099-11-18');assert.deepEqual(await post('/internal/quotes/claim',{provider:'flycham',includeCatalog:false}),{});assert.deepEqual(await post('/internal/quotes/claim',{provider:'airarabia',includeCatalog:false}),{});
  const catalog=await post('/internal/quotes/claim',{provider:'flycham',includeCatalog:true});assert.equal(catalog.catalog,true);
 }finally{await new Promise(r=>server.close(r));}
});
