'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-server-')),secret='synthetic-inbox-webhook-secret',admin='synthetic-inbox-admin-key-xxxxxxxxxx',queue='synthetic-inbox-queue-key-yyyyyyyyyy',customer='971500000010';
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(temp,'state.enc'),ASSISTANT_STATE_KEY:'synthetic-inbox-state-key',WHATSAPP_APP_SECRET:secret,ASSISTANT_ADMIN_KEY:admin,AIR_ARABIA_QUOTE_QUEUE_KEY:queue,AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',CONSULTANT_ORCHESTRATOR_ENABLED:'true',ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-inbox-cline',ASSISTANT_DEBOUNCE_MS:'0',DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-inbox-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-inbox-phone',NODE_ENV:'production'});
const {AssistantState}=require('../src/assistant-state');
const seed=new AssistantState();seed.set('historical-customer',{history:[{role:'user',text:'نص تاريخي جزئي'},{role:'assistant',text:'رد تاريخي جزئي'}],status:'done',offers:[]});
const {schema}=require('../src/consultant-brain'),{createServer}=require('../src/server');
test('protected dashboard, real webhook inbox and redacted portal preview are integrated without external sends',async t=>{
 const original=global.fetch,out=[];let modelCalls=0,sequence=0,holdNext=false,modelEntered,modelRelease;
 global.fetch=async(url,opt)=>{
  if(String(url)==='https://api.cline.bot/api/v1/chat/completions'){
   modelCalls++;if(holdNext){holdNext=false;modelEntered();await new Promise(resolve=>{modelRelease=resolve;});}const fields=Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([key,value])=>[key,value.type==='array'?[]:null]));const d={intent:'greeting',fields,question:null,option:null,consultant:{action:'answer',reply:'أهلًا وسهلًا فيك، كيف فيني ساعدك؟',preferences:{priority:null,airportFlexibility:null},nextStep:'ask_missing',knowledgeQuery:null}};return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})};
  }
  assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'inbox-output-'+out.length}]})};
 };
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(route,{method='GET',data,auth='admin'}={})=>new Promise((resolve,reject)=>{
  const body=data===undefined?'':JSON.stringify(data),headers={...(data===undefined?{}:{'Content-Type':'application/json'}),...(auth==='admin'?{Authorization:'Bearer '+admin}:auth==='queue'?{Authorization:'Bearer '+queue}:auth==='signature'?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{})};
  const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:response.statusCode,headers:response.headers,bytes,text,json});});});request.on('error',reject);request.end(body);
 });
 const post=(route,data={},auth='admin')=>call(route,{method:'POST',data,auth});
 const inbound=text=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{id:'inbox-input-'+(++sequence),from:customer,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]},'signature');
 const waitFor=async fn=>{for(let i=0;i<200;i++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected bounded local event processing');};
 try{
  await t.test('public assets contain only the shell and private APIs require the correct administrative key',async()=>{
   const html=await call('/operations',{auth:null});assert.equal(html.status,200);assert.match(html.text,/مركز أحمد|مركز محادثات الرمال/);assert.match(html.text,/operations.css/);assert.doesNotMatch(html.text,/نص تاريخي جزئي|synthetic-inbox-admin-key/);
   const css=await call('/operations.css',{auth:null});assert.equal(css.status,200);assert.match(css.headers['content-type'],/text\/css/);assert.ok(css.bytes.length>1000);
   const logo=await call('/operations-logo.jpg',{auth:null});assert.equal(logo.status,200);assert.match(logo.headers['content-type'],/image\/jpeg/);assert.equal(logo.bytes[0],255);assert.equal(logo.bytes[1],216);
   for(const route of ['/internal/assistant/conversations','/internal/assistant/conversations/historical-customer','/internal/assistant/portal-monitor','/internal/assistant/portal-monitor/airarabia/preview'])assert.equal((await call(route,{auth:null})).status,401);
   assert.equal((await call('/internal/assistant/conversations',{auth:'queue'})).status,401);assert.equal((await post('/internal/quotes/monitor',{provider:'airarabia',stage:'idle'},'admin')).status,401);
   const history=await call('/internal/assistant/conversations/historical-customer');assert.equal(history.status,200);assert.equal(history.json.messages.length,2);assert.equal(history.json.archive.legacyImported,true);assert.equal(history.json.customer.serviceWindowOpen,false);assert.ok(history.json.messages.every(m=>m.timestampApproximate&&m.status==='historical'));
  });
  await t.test('inbound and staff messages are journaled, claiming pauses AI, receipts and deletion reach the real endpoints',async()=>{
   await inbound('مرحبا');const first=await waitFor(async()=>{const result=await call('/internal/assistant/conversations/'+customer);return result.json?.messages?.some(m=>m.direction==='out')?result.json:null;});assert.equal(first.customer.id,customer);assert.equal(first.messages[0].actor,'customer');assert.equal(first.messages[0].text,'مرحبا');assert.equal(first.messages.at(-1).actor,'assistant');assert.ok(first.customer.serviceWindowOpen);assert.ok(modelCalls>0);
   // Claim while a model call already holds an older assistant-state snapshot.
   const entered=new Promise(resolve=>{modelEntered=resolve;});holdNext=true;const beforeOut=out.length;await inbound('مرحبا بدي استفسر');await entered;assert.equal((await post('/internal/assistant/conversations/'+customer+'/claim')).json.customer.humanOwned,true);modelRelease();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(out.length,beforeOut);assert.equal((await call('/internal/assistant/conversations/'+customer)).json.customer.humanOwned,true);
   const beforeModel=modelCalls;await inbound('بدي اسأل الموظف عن رحلتي');await waitFor(async()=>{const d=await call('/internal/assistant/conversations/'+customer);return d.json.messages.some(m=>m.text==='بدي اسأل الموظف عن رحلتي');});assert.equal(out.length,beforeOut);assert.equal(modelCalls,beforeModel);
   const note='<script>PRIVATE_INTERNAL_NOTE</script>';assert.equal((await post('/internal/assistant/conversations/'+customer+'/notes',{text:note})).status,200);assert.equal(out.length,beforeOut);
   const staffBody={text:'أهلًا فيك، معك موظف الحجوزات.',idempotencyKey:'inbox-test-send-001'},sent=await post('/internal/assistant/conversations/'+customer+'/send',staffBody);assert.equal(sent.status,200);assert.equal(sent.json.attempt.state,'sent');assert.equal(out.length,beforeOut+1);assert.equal((await post('/internal/assistant/conversations/'+customer+'/send',staffBody)).status,200);assert.equal(out.length,beforeOut+1);
   const detail=(await call('/internal/assistant/conversations/'+customer)).json;assert.equal(detail.messages.at(-1).actor,'staff');assert.equal(detail.messages.at(-1).text,staffBody.text);assert.equal(detail.notes.at(-1).text,note);assert.ok(!out.some(m=>m.text.body.includes('PRIVATE_INTERNAL_NOTE')));
   await post('/webhooks/whatsapp',{entry:[{changes:[{value:{statuses:[{id:sent.json.attempt.messageId,status:'read',timestamp:String(Math.floor(Date.now()/1000))}]}}]}]},'signature');assert.equal((await call('/internal/assistant/conversations/'+customer)).json.messages.at(-1).status,'read');
   assert.equal((await post('/internal/assistant/conversations/'+customer+'/release')).json.customer.humanOwned,false);await inbound('مرحبا');await waitFor(()=>out.length>beforeOut+1);
   await inbound('احذف بياناتي');await waitFor(async()=>(await call('/internal/assistant/conversations/'+customer)).status===404);assert.equal((await call('/internal/assistant/conversations?q='+customer)).json.items.length,0);
  });
  await t.test('protected portal monitor accepts only a trusted queue update and withholds preview during authentication',async()=>{
   assert.equal((await call('/internal/assistant/portal-monitor/airarabia/preview')).status,404);
   const jpeg=await require('sharp')({create:{width:4,height:4,channels:3,background:'#dddddd'}}).jpeg().toBuffer();
   const update={provider:'airarabia',stage:'flights',ready:true,state:'ready',activeJob:{request:{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way',password:'PRIVATE_FORM_VALUE',passenger:'PRIVATE_PASSENGER'}},preview:{redacted:true,jpeg:jpeg.toString('base64')}};
   assert.equal((await post('/internal/quotes/monitor',update,'queue')).json.accepted,true);await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:true},'queue');const monitor=await call('/internal/assistant/portal-monitor');const row=monitor.json.providers.find(p=>p.provider==='airarabia');assert.equal(row.previewAvailable,true);assert.equal(row.stage,'flights');assert.doesNotMatch(JSON.stringify(row),/PRIVATE_FORM_VALUE|PRIVATE_PASSENGER/);
   const preview=await call('/internal/assistant/portal-monitor/airarabia/preview');assert.equal(preview.status,200);assert.match(preview.headers['cache-control'],/no-store/);assert.ok(preview.bytes.equals(jpeg));assert.equal((await call('/internal/assistant/portal-monitor/airarabia/preview',{auth:null})).status,401);
   await post('/internal/quotes/monitor',{provider:'airarabia',stage:'authentication',ready:false,state:'verification',previewWithheld:true},'queue');assert.equal((await call('/internal/assistant/portal-monitor/airarabia/preview')).status,404);
  });
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=original;fs.rmSync(temp,{recursive:true,force:true});}
});
