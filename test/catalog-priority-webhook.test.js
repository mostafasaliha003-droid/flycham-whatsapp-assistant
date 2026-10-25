'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-global-priority-')),secret='synthetic-global-catalog-signing',queue='synthetic-global-catalog-queue-key-xxxxxxxx',admin='synthetic-global-catalog-admin-key-yyyyyyyy';
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(temp,'state.enc'),ASSISTANT_STATE_KEY:'synthetic-catalog-state-key',ASSISTANT_DEBOUNCE_MS:'0',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,WHATSAPP_ACCESS_TOKEN:'synthetic-catalog-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-catalog-phone',DRY_RUN:'false',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:queue,ASSISTANT_ADMIN_KEY:admin,FARE_CATALOG_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true'});
const {createServer}=require('../src/server');

test('customer requests preempt catalog across providers while pending and claimed, and catalog resumes afterward',async()=>{
 const original=global.fetch,sends=[];global.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);sends.push(JSON.parse(options.body));return{ok:true,json:async()=>({messages:[{id:'synthetic-priority-output-'+sends.length}]})};};
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 const call=(route,data,auth='queue')=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),headers={'Content-Type':'application/json',...(auth==='webhook'?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+(auth==='admin'?admin:queue)})};const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:'POST',headers},response=>{let raw='';response.on('data',part=>raw+=part);response.on('end',()=>{let json;try{json=JSON.parse(raw||'{}');}catch{return reject(Error('Invalid local test response'));}resolve({status:response.statusCode,json});});});request.on('error',reject);request.end(body);});
 const waitFor=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Synthetic inbound request did not finish its bounded local processing');};
 const inbound=async(customer,date)=>{const before=sends.length;assert.equal((await call('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{from:customer,id:'synthetic-global-priority-in-'+(++sequence),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'من دبي إلى دمشق '+date+' ذهاب بس شخص واحد فلاي شام فقط'}}]}}]}]},'webhook')).status,200);await waitFor(()=>sends.length>before);};
 const claim=async provider=>(await call('/internal/quotes/claim',{provider,includeCatalog:true})).json;
 const current=async job=>(await call('/internal/quotes/current',{id:job.id,lease:job.lease})).json.current;
 const complete=async(job,outcome='done')=>assert.equal((await call('/internal/quotes/complete',{id:job.id,lease:job.lease,reply:'',outcome,coverage:[]})).status,200);
 try{
  await call('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});await call('/internal/quotes/heartbeat',{provider:'flycham',ready:true});
  const initial=await claim('airarabia');assert.equal(initial.catalog,true);assert.equal(await current(initial),true);
  await inbound('synthetic-priority-customer-one','18-11-2099');
  // No Air Arabia customer work exists: Fly Cham alone must preempt its catalog.
  assert.equal(await current(initial),false);assert.deepEqual(await claim('airarabia'),{});await complete(initial,'cancelled');
  const first=await claim('flycham'),second=await claim('flycham');assert.ok(first.id&&!first.catalog);assert.ok(second.id&&!second.catalog);assert.equal(first.request.provider,'flycham');assert.equal(second.request.provider,'flycham');
  // Both jobs have left pending state, but claimed work still has priority.
  assert.deepEqual(await claim('airarabia'),{});assert.deepEqual(await claim('flycham'),{});
  await complete(first);assert.deepEqual(await claim('airarabia'),{});await complete(second);
  const resumed=await claim('airarabia');assert.equal(resumed.catalog,true);assert.equal(await current(resumed),true);
  // A separate customer's cancellation also releases the global priority gate.
  await inbound('synthetic-priority-customer-two','19-11-2099');assert.equal(await current(resumed),false);assert.deepEqual(await claim('airarabia'),{});
  assert.equal((await call('/internal/assistant/conversations/synthetic-priority-customer-two/claim',{},'admin')).status,200);
  assert.equal(await current(resumed),true);await complete(resumed,'cancelled');assert.equal((await claim('airarabia')).catalog,true);
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=original;fs.rmSync(temp,{recursive:true,force:true});}
});
