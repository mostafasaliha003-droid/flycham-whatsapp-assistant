'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'portal-demand-')),secret='synthetic-demand-signing-secret',queue='synthetic-demand-queue-key-xxxxxxxxxxxxxxxx',admin='synthetic-demand-admin-key-yyyyyyyyyyyyyyyy',stateKey='synthetic-demand-state-key';
const realNow=Date.now;let now=Date.parse('2026-10-25T02:00:00Z');Date.now=()=>now;
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(temp,'state.enc'),ASSISTANT_STATE_KEY:stateKey,ASSISTANT_DEBOUNCE_MS:'0',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,WHATSAPP_ACCESS_TOKEN:'synthetic-demand-access-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-demand-number',DRY_RUN:'false',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:queue,ASSISTANT_ADMIN_KEY:admin,FARE_CATALOG_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true'});
const {AssistantState}=require('../src/assistant-state');
const {FRESH_MS}=require('../src/fare-catalog');
const {createServer}=require('../src/server');
const snapshot=()=>new AssistantState({file:process.env.ASSISTANT_STATE_PATH,key:stateKey,now:()=>now}).data;

test('cold-worker demand probes are authorized, read-only and budget-aware without advertising authentication',async t=>{
 const original=global.fetch,sends=[];global.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);sends.push(JSON.parse(options.body));return{ok:true,json:async()=>({messages:[{id:'synthetic-demand-out-'+sends.length}]})};};
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 const call=(route,{data,method='POST',auth='queue'}={})=>new Promise((resolve,reject)=>{
  const body=data===undefined?'':JSON.stringify(data),headers={'Content-Type':'application/json',...(auth==='webhook'?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:auth==='none'?{}:{Authorization:'Bearer '+(auth==='admin'?admin:queue)})};
  const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers},response=>{let raw='';response.on('data',part=>raw+=part);response.on('end',()=>{let json;try{json=JSON.parse(raw||'{}');}catch{}resolve({status:response.statusCode,json,headers:response.headers});});});request.on('error',reject);request.end(body);
 });
 const post=(route,data={},auth='queue')=>call(route,{data,auth}),health=async()=>(await call('/health',{method:'GET',auth:'none'})).json;
 const probe=async(provider,includeCatalog=true)=>(await post('/internal/quotes/pending',{provider,includeCatalog})).json;
 const waitFor=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Synthetic demand request did not finish bounded local processing');};
 const inbound=async customer=>{const before=sends.length;assert.equal((await post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:customer,id:'synthetic-demand-in-'+(++sequence),timestamp:String(Math.floor(now/1000)),type:'text',text:{body:'من الشارقة إلى دمشق 18-11-2099 ذهاب بس شخص واحد العربية فقط'}}]}}]}]},'webhook')).status,200);await waitFor(()=>sends.length>before&&snapshot().customers[customer]?.status==='queued');};
 const claim=async provider=>(await post('/internal/quotes/claim',{provider,includeCatalog:true})).json;
 const complete=async job=>assert.equal((await post('/internal/quotes/complete',{id:job.id,lease:job.lease,reply:'',outcome:'failed',coverage:[]})).status,200);
 try{
  await t.test('only the queue key can probe supported providers',async()=>{
   assert.equal((await post('/internal/quotes/pending',{provider:'airarabia'},'none')).status,401);
   assert.equal((await post('/internal/quotes/pending',{provider:'airarabia'},'admin')).status,401);
   assert.equal((await call('/internal/quotes/pending',{method:'GET'})).status,405);
   assert.equal((await post('/internal/quotes/pending',{provider:'unknown'})).status,400);
   const response=await post('/internal/quotes/pending',{provider:'airarabia',includeCatalog:false});assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');assert.deepEqual(response.json,{pending:false,customerPending:false,catalogPending:false,activeWork:false});
  });
  await t.test('catalog demand can be announced while cold without a claim, spent start or ready flag',async()=>{
   const before=snapshot();assert.equal((await health()).assistant.airarabiaWorkerReady,false);
   for(let i=0;i<3;i++)assert.deepEqual(await probe('airarabia'),{pending:true,customerPending:false,catalogPending:true,activeWork:false});
   assert.equal((await health()).assistant.airarabiaWorkerReady,false);assert.equal((await health()).assistant.flychamWorkerReady,false);assert.deepEqual(snapshot(),before);assert.equal(snapshot().catalogBudget,undefined);
  });
  await t.test('cold customer jobs stay pending through probes and are claimed only in the authenticated worker path',async()=>{
   await inbound('synthetic-demand-customer');const before=snapshot(),comparison=before.quoteQueue.comparisons[0][1];
   assert.equal(comparison.waitForProviders,true);assert.equal(before.quoteQueue.jobs.length,2);assert.ok(before.quoteQueue.jobs.every(([,job])=>job.state==='pending'&&!job.lease));assert.equal((await health()).assistant.airarabiaWorkerReady,false);
   for(let i=0;i<3;i++)assert.deepEqual(await probe('airarabia'),{pending:true,customerPending:true,catalogPending:false,activeWork:true});
   assert.deepEqual(await probe('flycham'),{pending:false,customerPending:false,catalogPending:false,activeWork:false});assert.deepEqual(snapshot(),before);assert.equal((await health()).assistant.airarabiaWorkerReady,false);
   await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});assert.equal((await health()).assistant.airarabiaWorkerReady,true);
   const first=await claim('airarabia');assert.ok(first.id&&first.lease&&!first.catalog);assert.equal(snapshot().quoteQueue.jobs.filter(([,job])=>job.state==='claimed').length,1);assert.deepEqual(await probe('airarabia'),{pending:true,customerPending:true,catalogPending:false,activeWork:true});
   const second=await claim('airarabia');assert.ok(second.id&&second.id!==first.id&&!second.catalog);const claimedState=snapshot();assert.deepEqual(await probe('airarabia'),{pending:false,customerPending:false,catalogPending:false,activeWork:true});assert.deepEqual(snapshot(),claimedState);assert.deepEqual(await probe('flycham'),{pending:false,customerPending:false,catalogPending:false,activeWork:false});
   await complete(first);await complete(second);await waitFor(()=>snapshot().customers['synthetic-demand-customer'].status==='failed');
  });
  await t.test('budget exhaustion makes cold demand false and rollover announces work without spending it',async()=>{
   const first=await claim('airarabia');assert.equal(first.catalog,true);assert.equal(snapshot().catalogBudget.providers.airarabia.used,1);const activeCatalogState=snapshot();assert.deepEqual(await probe('airarabia'),{pending:false,customerPending:false,catalogPending:false,activeWork:true});assert.deepEqual(snapshot(),activeCatalogState);await complete(first);
   await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:false});const before=snapshot();assert.deepEqual(await probe('airarabia'),{pending:true,customerPending:false,catalogPending:true,activeWork:false});assert.deepEqual(snapshot(),before);assert.equal((await health()).assistant.airarabiaWorkerReady,false);
   await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});const second=await claim('airarabia');assert.equal(second.catalog,true);await complete(second);assert.equal(snapshot().catalogBudget.providers.airarabia.used,2);
   await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:false});const spent=snapshot();assert.deepEqual(await probe('airarabia'),{pending:false,customerPending:false,catalogPending:false,activeWork:false});assert.deepEqual(snapshot(),spent);assert.equal((await health()).assistant.airarabiaWorkerReady,false);
   now+=FRESH_MS;const rolled=snapshot();for(let i=0;i<2;i++)assert.deepEqual(await probe('airarabia'),{pending:true,customerPending:false,catalogPending:true,activeWork:false});assert.deepEqual(snapshot(),rolled);assert.equal(snapshot().catalogBudget.providers.airarabia.used,2);assert.equal((await health()).assistant.airarabiaWorkerReady,false);
  });
  await t.test('expired pending customer rows are ignored without pruning or changing readiness',async()=>{
   await inbound('synthetic-demand-expiring-customer');assert.equal((await health()).assistant.airarabiaWorkerReady,false);now+=60*60000+1;const before=snapshot();assert.equal(before.quoteQueue.jobs.length,2);assert.ok(before.quoteQueue.jobs.every(([,job])=>job.state==='pending'&&job.expires<now));
   assert.deepEqual(await probe('airarabia',false),{pending:false,customerPending:false,catalogPending:false,activeWork:false});assert.deepEqual(snapshot(),before);assert.equal((await health()).assistant.airarabiaWorkerReady,false);
  });
  await t.test('catalog active-work pin expires without a probe clearing the lease or spending another start',async()=>{
   await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});const lease=await claim('airarabia');assert.equal(lease.catalog,true);const active=snapshot();
   assert.deepEqual(await probe('airarabia',false),{pending:false,customerPending:false,catalogPending:false,activeWork:true});assert.deepEqual(snapshot(),active);
   now+=4*60000+1;const expired=snapshot();assert.deepEqual(await probe('airarabia',false),{pending:false,customerPending:false,catalogPending:false,activeWork:false});assert.deepEqual(snapshot(),expired);assert.equal(snapshot().catalogBudget.providers.airarabia.used,1);
  });
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=original;Date.now=realNow;fs.rmSync(temp,{recursive:true,force:true});}
});
