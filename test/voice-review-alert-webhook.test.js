'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const secret='synthetic-voice-review-secret',key='synthetic-voice-review-key',file=path.join(os.tmpdir(),'voice-review-alert','state.enc');
const {OWNER}=require('../src/remal-service-policy');
const customers={first:'15550008921',clear:'15550008922',flight:'15550008923',off:'15550008925',unavailable:'15550008926'};
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'15551230001',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true',GEMINI_API_KEY:'synthetic-key',VOICE_TRANSCRIPTION:'on',VOICE_ACCEPTANCE_APPROVED:'true',VOICE_TRANSCRIPTION_PROVIDERS:'gemini'});
delete process.env.ISMAIL_UNDERSTANDING_REVIEW;
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
seed.data.serviceSessions={};
for(const [kind,id]of Object.entries(customers)){seed.set(id,{introduced:true,status:'collecting',history:[],offers:[]});if(kind!=='first')seed.data.serviceSessions[id]={service:kind==='flight'?'flight':'saudi_visa',at:Date.now(),revision:0};}
seed.save();new (require('../src/conversation-journal').ConversationJournal)({store:seed}).recordInbound(OWNER,{id:'synthetic-owner-window',text:'متابعة',timestamp:Date.now()});
const {createServer}=require('../src/server');

test('finalized Ismail voice failures alert the owner without taking over',async t=>{
 const originalFetch=global.fetch,out=[],audio=require('./helpers/voice-fixtures').encoded('ogg',{seconds:1});let mode='unclear';
 global.fetch=async(url,options={})=>{
  const address=String(url);
  if(address.includes('generativelanguage.googleapis.com'))return mode==='unavailable'?new Response('{}',{status:503}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:mode==='clear',transcript:mode==='clear'?'سوري جواز عادي لحالي':''})}]}}]});
  if(address.startsWith('https://lookaside.fbsbx.com/voice-review/'))return new Response(audio,{headers:{'content-type':'audio/ogg'}});
  const mediaId=address.match(/^https:\/\/graph\.facebook\.com\/[^/]+\/(\d+)$/)?.[1];
  if(mediaId)return Response.json({id:mediaId,mime_type:'audio/ogg',file_size:audio.length,url:'https://lookaside.fbsbx.com/voice-review/'+mediaId});
  assert.match(address,/^https:\/\/graph\.facebook\.com\/[^/]+\/15551230001\/messages$/,'all delivery remains mocked');
  const payload=JSON.parse(options.body);out.push(payload);return Response.json({messages:[{id:'voice-review-out-'+out.length}]});
 };
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 const snapshot=()=>new AssistantState({file,key});
 const reviews=customer=>Object.values(snapshot().data.visaCoordinationNotices?.items||{}).filter(item=>item.customer===customer&&item.reason==='voice_unresolved');
 const stored=customer=>Object.values(snapshot().data.visaMedia||{}).filter(item=>item.customer===customer);
 const customerReply=customer=>out.filter(item=>item.to===customer).at(-1)?.text?.body||'';
 async function waitFor(predicate,label){const deadline=performance.now()+5000;while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for '+label);}
 async function send(customer,{messageId='voice-review-in-'+(++sequence),mediaId=String(103000+sequence),text}={}){
  const message={from:customer,id:messageId,timestamp:String(Math.floor(Date.now()/1000)),...(text?{type:'text',text:{body:text}}:{type:'audio',audio:{id:mediaId,mime_type:'audio/ogg'}})};
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[message]}}]}]});
  const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);});assert.equal(status,200);return {messageId,mediaId};
 }
 try{
  await t.test('first unclear voice alerts the owner before a visa case exists',async()=>{
   const inbound=await send(customers.first);
   await waitFor(()=>reviews(customers.first)[0]?.state==='accepted','owner alert');
   await waitFor(()=>customerReply(customers.first),'customer response');
   const state=snapshot();
   assert.equal(state.data.visaCases?.[customers.first],undefined);
   assert.equal(stored(customers.first).length,0);
   assert.equal(state.get(customers.first).humanOwned,undefined);assert.equal(state.data.handoffs.filter(item=>item.customer===customers.first).length,0);
   const ownerMessages=out.filter(item=>item.to===OWNER);assert.equal(ownerMessages.length,1);assert.equal(ownerMessages[0].type,'text');assert.match(ownerMessages[0].text.body,/تسجيل صوتي/);assert.doesNotMatch(ownerMessages[0].text.body,/synthetic|gemini|VOICE_|OggS/);
   assert.match(customerReply(customers.first),/الصوت ما كان واضح/);assert.doesNotMatch(customerReply(customers.first),/تنزيل|API|تفريغ/);
   await send(customers.first,inbound);
   assert.equal(reviews(customers.first).length,1);
   assert.equal(out.filter(item=>item.to===OWNER).length,1);
  });
  await t.test('successful and explicitly flight-scoped recordings do not trigger an Ismail alert',async()=>{
   mode='clear';await send(customers.clear);await waitFor(()=>customerReply(customers.clear),'successful voice response');assert.equal(stored(customers.clear).length,0);assert.equal(reviews(customers.clear).length,0);
   mode='unclear';await send(customers.flight);await waitFor(()=>customerReply(customers.flight),'flight fallback');assert.equal(stored(customers.flight).length,0);assert.equal(reviews(customers.flight).length,0);
  });
  await t.test('provider failures also require review while explicit opt-out suppresses alerts',async()=>{
   mode='unavailable';await send(customers.unavailable);await waitFor(()=>reviews(customers.unavailable)[0]?.state==='accepted','unavailable speech alert');assert.equal(stored(customers.unavailable).length,0);
   process.env.ISMAIL_UNDERSTANDING_REVIEW='off';await send(customers.off);await waitFor(()=>customerReply(customers.off),'opt-out response');assert.equal(reviews(customers.off).length,0);assert.equal(stored(customers.off).length,0);delete process.env.ISMAIL_UNDERSTANDING_REVIEW;
  });
  await t.test('a case-less customer can delete the alert metadata with their conversation',async()=>{
   await send(customers.first,{text:'احذف بياناتي'});
   await waitFor(()=>reviews(customers.first).length===0,'deleted alert metadata');
  });
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;delete process.env.ISMAIL_UNDERSTANDING_REVIEW;}
});
