'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {createServer}=require('../src/server');
test('signed WhatsApp request queues privately and completes one reply using authenticated worker lease',async()=>{
 const saved={...process.env},originalFetch=global.fetch,out=[];
 const secret='test-signing-secret',key='k'.repeat(32);
 Object.assign(process.env,{ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'fake-test-token',WHATSAPP_PHONE_NUMBER_ID:'fake-test-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key});
 global.fetch=async(url,options)=>{assert.ok(String(url).startsWith('https://graph.facebook.com/'));out.push(JSON.parse(options.body));return{ok:true,json:async()=>({messages:[{id:'test'}]})};};
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const post=(path,data,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end(JSON.stringify(data));});
 try{
  assert.equal((await post('/internal/quotes/claim',{})).status,401);
  assert.equal((await post('/internal/quotes/flycham-config',{})).status,401);
  const auth={Authorization:'Bearer '+key};await post('/internal/quotes/heartbeat',{provider:'airarabia'},auth);
  const payload={entry:[{changes:[{field:'messages',value:{messages:[{from:'private-recipient',id:'unique-integration-test',type:'text',text:{body:'من الشارقة إلى دمشق، 11-11-2090، 18-11-2090، ذهاب وعودة، 1 بالغ، بدي 30 كيلو'}}]}}]}]};
  const signature='sha256='+crypto.createHmac('sha256',secret).update(JSON.stringify(payload)).digest('hex');
  assert.equal((await post('/webhooks/whatsapp',payload,{'x-hub-signature-256':signature})).status,200);
  const claimed=await post('/internal/quotes/claim',{},auth),job=JSON.parse(claimed.body);
  assert.ok(job.id);assert.ok(!claimed.body.includes('private-recipient'));assert.equal(job.request.baggageRequest.checkedWeightKg,30);
  const offer={request:job.request,timing:{out:{flight:'G9433',departure:'11 Nov2090 08:00',arrival:'11 Nov2090 10:00'},back:{flight:'G9434',departure:'18 Nov2090 08:00',arrival:'18 Nov2090 10:00'}},price:{currency:'AED',sellingTotal:'700.00',weights:[{kg:30}]}};
  const progress={id:job.id,lease:job.lease,seq:1,reply:'First verified date and timing',metadata:{offer}};
  assert.equal((await post('/internal/quotes/progress',{...progress,lease:'wrong'},auth)).status,409);
  assert.equal((await post('/internal/quotes/progress',progress,auth)).status,200);
  assert.equal((await post('/internal/quotes/progress',progress,auth)).status,409);
  const complete={id:job.id,lease:job.lease,reply:'MODEL_PRICE_MUST_NOT_BE_USED',outcome:'done',coverage:[{date:'2090-11-11',status:'confirmed'}]};
  assert.equal((await post('/internal/quotes/complete',complete,auth)).status,200);
  assert.equal((await post('/internal/quotes/complete',complete,auth)).status,409);
  await new Promise(r=>setTimeout(r,30));assert.equal(out.length,2);assert.equal(out[1].to,'private-recipient');assert.match(out[1].text.body,/700.00/);assert.doesNotMatch(out[1].text.body,/MODEL_PRICE_MUST_NOT_BE_USED/);
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
