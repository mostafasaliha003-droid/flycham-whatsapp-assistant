'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const file=path.join(os.tmpdir(),'voice-concurrent','state.enc'),key='synthetic-voice-concurrent-key',secret='synthetic-voice-concurrent-secret';
const scenarios=[{customer:'15550008821',kind:'followup',text:'لحالي، شو الأوراق المطلوبة؟'},{customer:'15550008822',kind:'service switch',text:'بدي طيران من الشارقة إلى دمشق'},{customer:'15550008823',kind:'control',text:'الخدمات'},{customer:'15550008824',kind:'control after failed prefix',text:'الخدمات',firstUnclear:true},{customer:'15550008825',kind:'three notes',text:'لحالي، بدي أعرف الأوراق',third:true},{customer:'15550008826',kind:'middle control',text:'الخدمات',third:true,thirdText:'شكراً'},{customer:'15550008827',kind:'middle privacy control',text:'احذف بياناتي',third:true,thirdText:'شكراً',deleted:true}];
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'25',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true',GEMINI_API_KEY:'synthetic-gemini-key',VOICE_TRANSCRIPTION:'on',VOICE_ACCEPTANCE_APPROVED:'true',VOICE_TRANSCRIPTION_PROVIDERS:'gemini'});
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
seed.data.serviceSessions={};for(const {customer}of scenarios){seed.set(customer,{introduced:true,status:'collecting',history:[],offers:[]});seed.data.serviceSessions[customer]={service:'saudi_visa',at:Date.now(),revision:0};}seed.save();
const {createServer}=require('../src/server');

for(const scenario of scenarios)test(`a voice ${scenario.kind} arriving during transcription preserves context only within the same request`,async()=>{
 const {customer}=scenario;
 const original=global.fetch,out=[],calls=[],{encoded}=require('./helpers/voice-fixtures');
 const fixtures=new Map([
  ['102001',{bytes:encoded('ogg',{seconds:1}),text:'أنا سوري وجوازي عادي'}],
  ['102002',{bytes:encoded('ogg',{seconds:1.1}),text:scenario.text}],
  ...(scenario.third?[['102003',{bytes:encoded('ogg',{seconds:1.2}),text:scenario.thirdText||'لا، ما بدي أقدم الآن، بس استفسار'}]]:[])
 ]);
 let releaseFirst,started;
 const blocked=new Promise(resolve=>{releaseFirst=resolve;}),entered=new Promise(resolve=>{started=resolve;});
 global.fetch=async(url,options={})=>{
  const address=String(url);
  if(address.includes('generativelanguage.googleapis.com')){
   const data=JSON.parse(options.body).contents[0].parts[0].inline_data.data;
   const fixture=[...fixtures.values()].find(item=>item.bytes.toString('base64')===data);assert.ok(fixture);calls.push(fixture.text);
   if(fixture===fixtures.get('102001')&&calls.length===1){started();await blocked;}
   const unclear=scenario.firstUnclear&&fixture===fixtures.get('102001');
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:!unclear,transcript:unclear?'':fixture.text})}]}}]});
  }
  if(address.startsWith('https://lookaside.fbsbx.com/voice-concurrent/'))return new Response(fixtures.get(address.split('/').at(-1)).bytes,{headers:{'content-type':'audio/ogg'}});
  const mediaId=address.match(/^https:\/\/graph\.facebook\.com\/[^/]+\/(\d+)$/)?.[1];
  if(mediaId){const fixture=fixtures.get(mediaId);assert.ok(fixture);return Response.json({id:mediaId,mime_type:'audio/ogg',file_size:fixture.bytes.length,url:'https://lookaside.fbsbx.com/voice-concurrent/'+mediaId});}
  assert.match(address,/^https:\/\/graph\.facebook\.com\/[^/]+\/synthetic-phone-id\/messages$/);
  const payload=JSON.parse(options.body);out.push(payload);return Response.json({messages:[{id:'concurrent-out-'+out.length}]});
 };
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let sequence=0;
 async function send(mediaId){
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[{from:customer,id:customer+'-concurrent-in-'+(++sequence),timestamp:String(Math.floor(Date.now()/1000)),type:'audio',audio:{id:mediaId,mime_type:'audio/ogg'}}]}}]}]});
  const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);});assert.equal(status,200);
 }
 try{
  await send('102001');let enteredTimer;
  try{await Promise.race([entered,new Promise((_,reject)=>{enteredTimer=setTimeout(()=>reject(Error('Timed out entering first ASR')),5000);})]);}finally{clearTimeout(enteredTimer);}
  await send('102002');
  // Let the newer batch finish its quiet window while the first ASR is pending.
  await new Promise(resolve=>setTimeout(resolve,55));
  if(scenario.third)await send('102003');
  releaseFirst();
  const deadline=performance.now()+8000;let snapshot;
  do{snapshot=new AssistantState({file,key});if((scenario.deleted?!snapshot.data.customers?.[customer]:out.length)&&!snapshot.data.inbox?.[customer])break;await new Promise(resolve=>setTimeout(resolve,10));}while(performance.now()<deadline);
  if(!scenario.deleted)assert.ok(out.length);assert.equal(snapshot.data.inbox?.[customer],undefined);
  assert.deepEqual(calls,[...(scenario.firstUnclear?[fixtures.get('102001').text]:[]),...[...fixtures.values()].map(item=>item.text)]);
  if(scenario.kind==='followup'||scenario.kind==='three notes'){
   const visaCase=snapshot.data.visaCases[customer];assert.ok(visaCase);
   assert.equal(visaCase.applicants[0]?.nationality,'سوريا');assert.equal(visaCase.applicantCount,1);
   const history=visaCase.history.filter(message=>message.role==='user').map(message=>message.text).join('\n');
   assert.ok(history.indexOf('سوري')>=0&&history.indexOf('سوري')<history.indexOf('لحالي'));
   if(scenario.third){const turns=visaCase.history.filter(message=>message.role==='user');assert.equal(turns.length,1,'never handle the earlier partial request before the third note');assert.match(turns[0].text,/ما بدي أقدم الآن/);}
   assert.equal(visaCase.paymentStatus,'unverified');assert.equal(visaCase.submissionStatus,'not_submitted');
  }else{
   assert.equal(snapshot.data.visaCases?.[customer],undefined,'a new control cannot revive the prior visa request');
   if(scenario.kind==='service switch'){assert.equal(snapshot.data.serviceSessions[customer].service,'flight');assert.doesNotMatch(JSON.stringify(snapshot.data.customers[customer].history),/سوري|جوازي/);}
   else if(scenario.deleted){assert.equal(snapshot.data.customers?.[customer],undefined);assert.equal(snapshot.data.serviceSessions?.[customer],undefined);}
   else assert.equal(snapshot.data.serviceSessions[customer].awaitingService,true);
  }
 }finally{releaseFirst();await new Promise(resolve=>server.close(resolve));global.fetch=original;}
});
