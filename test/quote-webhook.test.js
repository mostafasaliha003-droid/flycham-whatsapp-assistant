'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {createServer}=require('../src/server');
test('signed WhatsApp request queues privately and completes one reply using authenticated worker lease',async()=>{
 const saved={...process.env},originalFetch=global.fetch,out=[];
 const secret='test-signing-secret',key='k'.repeat(32);
 Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'fake-test-token',WHATSAPP_PHONE_NUMBER_ID:'fake-test-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key});
 global.fetch=async(url,options)=>{assert.ok(String(url).startsWith('https://graph.facebook.com/'));out.push(JSON.parse(options.body));return{ok:true,json:async()=>({messages:[{id:'test'}]})};};
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const post=(path,data,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(JSON.stringify(data));});
 try{
  assert.equal((await post('/internal/quotes/claim',{})).status,401);
  const auth={Authorization:'Bearer '+key};await post('/internal/quotes/claim',{},auth);
  const payload={entry:[{changes:[{field:'messages',value:{messages:[{from:'private-recipient',id:'unique-integration-test',type:'text',text:{body:'من الشارقة إلى دمشق، 11-11-2090، 18-11-2090، ذهاب وعودة، 1 بالغ، بدي 30 كيلو'}}]}}]}]};
  const signature='sha256='+crypto.createHmac('sha256',secret).update(JSON.stringify(payload)).digest('hex');
  assert.equal((await post('/webhooks/whatsapp',payload,{'x-hub-signature-256':signature})).status,200);
  const claimed=await post('/internal/quotes/claim',{},auth),job=JSON.parse(claimed.body);
  assert.ok(job.id);assert.ok(!claimed.body.includes('private-recipient'));assert.equal(job.request.baggageRequest.checkedWeightKg,30);
  const progress={id:job.id,lease:job.lease,seq:1,reply:'First verified date and timing'};
  assert.equal((await post('/internal/quotes/progress',{...progress,lease:'wrong'},auth)).status,409);
  assert.equal((await post('/internal/quotes/progress',progress,auth)).status,200);
  assert.equal((await post('/internal/quotes/progress',progress,auth)).status,409);
  const complete={id:job.id,lease:job.lease,reply:'Verified test result'};
  assert.equal((await post('/internal/quotes/complete',complete,auth)).status,200);
  assert.equal((await post('/internal/quotes/complete',complete,auth)).status,409);
  assert.equal(out.length,3);assert.equal(out[2].to,'private-recipient');
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
