'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const secret='synthetic-voice-recovery-secret',key='synthetic-voice-recovery-key',file=path.join(os.tmpdir(),'voice-recovery-webhook','state.enc');
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'25',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true',GEMINI_API_KEY:'synthetic-gemini-key',VOICE_TRANSCRIPTION:'on',VOICE_ACCEPTANCE_APPROVED:'true',VOICE_TRANSCRIPTION_PROVIDERS:'gemini'});
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
const customers={text:'15550008701',audio:'15550008702',unrelated:'15550008703',restarted:'15550008704'};
for(const id of Object.values(customers))seed.set(id,{introduced:true,status:'collecting',history:[],offers:[]});
seed.data.serviceSessions=Object.fromEntries(Object.values(customers).map(id=>[id,{service:'saudi_visa',at:Date.now(),revision:0}]));seed.save();
const {ConversationJournal}=require('../src/conversation-journal');
new ConversationJournal({store:seed}).recordOutbound(customers.restarted,{id:'recovery-before-restart',text:'أعد المقطع المحدد فقط.',kind:'voice_recovery_prompt'});
const {createServer}=require('../src/server');

test('signed batched voice recovery preserves complete turn order and never replays an abandoned turn',async t=>{
 const originalFetch=global.fetch,out=[],providerCalls=[],mediaCalls=[];
 const {encoded}=require('./helpers/voice-fixtures');
 const fixtures=new Map([
  ['101001',{bytes:encoded('ogg',{seconds:1}),transcript:'سوري جواز عادي لحالي، بدي ألغي'}],
  ['101002',{bytes:encoded('ogg',{seconds:1.1}),transcript:'مصري جواز عادي لحالي'}],
  ['101003',{bytes:encoded('ogg',{seconds:1.2}),transcript:'سوري جواز عادي'}],
  ['101004',{bytes:encoded('ogg',{seconds:1.3}),transcript:'لحالي'}]
 ]);
 const missing='909009',transcripts=new Map([...fixtures.values()].map(f=>[f.bytes.toString('base64'),f.transcript]));
 global.fetch=async(url,options={})=>{
  const address=String(url);
  if(address.includes('generativelanguage.googleapis.com')){
   const body=JSON.parse(options.body),audio=body.contents?.[0]?.parts?.[0]?.inline_data?.data;
   assert.ok(transcripts.has(audio),'only generated fixture audio may reach mocked transcription');
   providerCalls.push(transcripts.get(audio));
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:true,transcript:transcripts.get(audio)})}]}}]});
  }
  if(address.startsWith('https://lookaside.fbsbx.com/voice-recovery/')){
   const id=address.split('/').at(-1),fixture=fixtures.get(id);assert.ok(fixture);
   return new Response(fixture.bytes,{headers:{'content-type':'audio/ogg'}});
  }
  const mediaId=address.match(/^https:\/\/graph\.facebook\.com\/[^/]+\/(\d+)$/)?.[1];
  if(mediaId){
   mediaCalls.push(mediaId);
   if(mediaId===missing)return new Response('{}',{status:404});
   const fixture=fixtures.get(mediaId);assert.ok(fixture,'unknown synthetic media id');
   return Response.json({id:mediaId,mime_type:'audio/ogg',file_size:fixture.bytes.length,url:'https://lookaside.fbsbx.com/voice-recovery/'+mediaId});
  }
  assert.match(address,/^https:\/\/graph\.facebook\.com\/[^/]+\/synthetic-phone-id\/messages$/,'unexpected network request');
  const payload=JSON.parse(options.body),id='recovery-out-'+(out.length+1);out.push({id,payload});
  return Response.json({messages:[{id}]});
 };
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 const snapshot=()=>new AssistantState({file,key});
 const customerOut=id=>out.filter(item=>item.payload.to===id);
 const bodyOf=item=>item?.payload.text?.body||item?.payload.interactive?.body?.text||'';
 async function waitFor(predicate,label){
  const until=performance.now()+8000;
  while(performance.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Timed out waiting for '+label);
 }
 async function send(id,parts){
  const timestamp=Math.floor(Date.now()/1000)-10;
  const messages=parts.map((part,index)=>({from:id,id:'recovery-in-'+(++sequence),timestamp:String(timestamp+index),...(part.audio?{type:'audio',audio:{id:part.audio,mime_type:'audio/ogg; codecs=opus'}}:{type:'text',text:{body:part.text}}),...(part.context?{context:{id:part.context}}:{})}));
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages}}]}]});
  const status=await new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.end(body);
  });
  assert.equal(status,200);
 }
 async function waitTurn(id,before){await waitFor(()=>customerOut(id).length>before&&!snapshot().data.inbox?.[id],'complete reply and durable batch completion');return customerOut(id).at(-1);}
 async function failedBatch(id,firstAudio,lastText){
  const before=customerOut(id).length;
  await send(id,[{audio:firstAudio},{audio:missing},{text:lastText}]);
  const prompt=await waitTurn(id,before),copy=bodyOf(prompt);
  assert.match(copy,/(?:التسجيل|الصوتي|recording|voice)/i);
  assert.match(copy,/(?:الثاني|التاني|رقم\s*[2٢]|#?2|second)/i,'recovery identifies the missing second recording');
  assert.match(copy,/(?:رد|reply)/i,'replacement must be bound to the recovery prompt');
  assert.doesNotMatch(copy,/تفريغ|API|Gemini|gemini|دفعتك مؤكدة|تم إلغاء/);
  const state=snapshot();
  assert.equal(state.data.visaCases?.[id],undefined,'partial messages must not create or mutate a visa case');
  assert.equal(state.data.handoffs.filter(item=>item.customer===id).length,0);
  assert.equal(Object.values(state.data.visaFulfilment?.jobs||{}).filter(item=>item.customer===id).length,0);
  return prompt;
 }
 try{
  await t.test('quoted text replaces only the missing recording before later text and preserves negation',async()=>{
   const id=customers.text,lastText='بدي أعرف الأوراق المطلوبة',prompt=await failedBatch(id,'101001',lastText),before=customerOut(id).length,providerBefore=providerCalls.length;
   await send(id,[{text:'لا، ما بدي ألغي',context:prompt.id}]);await waitTurn(id,before);
   const c=snapshot().data.visaCases[id];assert.ok(c);assert.equal(c.applicantCount,1);assert.equal(c.applicants[0].nationality,'سوريا');assert.equal(c.applicants[0].documentType,'passport');
   assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');assert.ok(!c.cancellation||c.cancellation.state==='withdrawn','negated cancellation must not become a review request');
   const turn=c.history.filter(message=>message.role==='user').at(-1)?.text||'';
   assert.ok(turn.indexOf('سوري')>=0&&turn.indexOf('سوري')<turn.indexOf('ما بدي ألغي')&&turn.indexOf('ما بدي ألغي')<turn.indexOf(lastText),'recovery preserves original positions, including later text');
   assert.equal(providerCalls.length,providerBefore,'successful audio is not retranscribed on a text retry');
   assert.equal(mediaCalls.filter(media=>media==='101001').length,1);
  });
  await t.test('quoted audio replacement completes the same turn without retranscribing earlier audio',async()=>{
   const id=customers.audio,lastText='شو التكلفة؟',prompt=await failedBatch(id,'101003',lastText),before=customerOut(id).length,providerBefore=providerCalls.length;
   await send(id,[{audio:'101004',context:prompt.id}]);await waitTurn(id,before);
   const c=snapshot().data.visaCases[id];assert.ok(c);assert.equal(c.applicantCount,1);assert.equal(c.applicants[0].nationality,'سوريا');assert.equal(c.applicants[0].documentType,'passport');assert.ok(c.quote);
   assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');assert.equal(c.cancellation,undefined);
   const turn=c.history.filter(message=>message.role==='user').at(-1)?.text||'';
   assert.ok(turn.indexOf('سوري')<turn.indexOf('لحالي')&&turn.indexOf('لحالي')<turn.indexOf(lastText));
   assert.equal(providerCalls.length,providerBefore+1);assert.equal(mediaCalls.filter(media=>media==='101003').length,1);
  });
  await t.test('an unrelated turn abandons recovery and quoting its old prompt cannot replay prior facts',async()=>{
   const id=customers.unrelated,prompt=await failedBatch(id,'101002','شو التكلفة؟');let before=customerOut(id).length;
   await send(id,[{text:'مرحبا'}]);await waitTurn(id,before);
   let c=snapshot().data.visaCases[id];assert.ok(c);assert.equal(c.applicantCount,null);assert.equal(c.applicants.length,0);
   before=customerOut(id).length;const providerBefore=providerCalls.length;
   await send(id,[{text:'مصري',context:prompt.id}]);assert.match(bodyOf(await waitTurn(id,before)),/الاستفسار الحالي/);
   c=snapshot().data.visaCases[id];assert.equal(c.applicantCount,null);assert.equal(c.applicants.length,0);assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');
   assert.doesNotMatch(JSON.stringify(c.history),/مصري جواز/);assert.equal(providerCalls.length,providerBefore);assert.equal(mediaCalls.filter(media=>media==='101002').length,1);
  });
  await t.test('an outbound recovery prompt known after restart cannot amend the case from an isolated fragment',async()=>{
   const id=customers.restarted;
   await send(id,[{text:'سوري جواز عادي لحالي'}]);await waitTurn(id,0);
   const original=snapshot().data.visaCases[id];assert.equal(original.applicants[0].nationality,'سوريا');
   const before=customerOut(id).length;
   await send(id,[{text:'مصري',context:'recovery-before-restart'}]);assert.match(bodyOf(await waitTurn(id,before)),/الاستفسار الحالي/);
   assert.deepEqual(snapshot().data.visaCases[id],original);
  });
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;}
});
