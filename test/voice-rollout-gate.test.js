'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {voiceEnabled}=require('../src/voice-transcription');
test('speech rollout fails closed unless both explicit enablement and acceptance are present',()=>{
 for(const env of [{},{VOICE_TRANSCRIPTION:'on'},{VOICE_ACCEPTANCE_APPROVED:'true'},{VOICE_TRANSCRIPTION:'off',VOICE_ACCEPTANCE_APPROVED:'true'},{VOICE_TRANSCRIPTION:'on',VOICE_ACCEPTANCE_APPROVED:'false'}])assert.equal(voiceEnabled(env),false);
 assert.equal(voiceEnabled({VOICE_TRANSCRIPTION:'on',VOICE_ACCEPTANCE_APPROVED:'true'}),true);
});
test('default and legacy-on signed voice notes preserve facts, avoid models, acknowledge professionally and remain erasable',async()=>{
 const secret='synthetic-voice-gate-secret',key='synthetic-voice-gate-key',admin='synthetic-voice-gate-admin-xxxxxxxx',file=path.join(os.tmpdir(),'voice-gate','state.enc');
 Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_ADMIN_KEY:admin,ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true',GEMINI_API_KEY:'synthetic-key'});
 delete process.env.VOICE_TRANSCRIPTION;delete process.env.VOICE_ACCEPTANCE_APPROVED;
 const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
 const ids=['15550008301','15550008302','15550008303','15550008304'];
 for(const id of ids)seed.set(id,{introduced:true,status:'collecting',history:[],offers:[],base:{request:{origin:'الشارقة',destination:'دمشق'}}});
 seed.data.serviceSessions=Object.fromEntries(ids.map(id=>[id,{service:'flight',at:Date.now(),revision:0}]));seed.save();
 const before=structuredClone(seed.data.customers),original=global.fetch,out=[],audio=Buffer.from('OggS-synthetic-audio-for-gate');let failed=false;
 global.fetch=async(url,opt)=>{
  if(String(url).includes('lookaside.fbsbx.com'))return new Response(audio,{headers:{'content-type':'audio/ogg'}});
  if(String(url).endsWith('/123456'))return failed?new Response('{}',{status:503}):Response.json({id:'123456',mime_type:'audio/ogg',file_size:audio.length,url:'https://lookaside.fbsbx.com/synthetic-audio'});
  assert.match(String(url),/^https:\/\/graph.facebook.com\/[^/]+\/synthetic-phone-id\/messages$/,'unexpected provider call');out.push(JSON.parse(opt.body));return Response.json({messages:[{id:'gate-out-'+out.length}]});
 };
 const {createServer}=require('../src/server'),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let seq=0;
 function request(endpoint,{body,authorized=false}={}){return new Promise((resolve,reject)=>{
  const headers={'Content-Type':'application/json'};if(authorized)headers.Authorization='Bearer '+admin;if(body)headers['x-hub-signature-256']='sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex');
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:endpoint,method:body?'POST':'GET',headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);
 });}
 async function send(from,text){const message={from,id:'gate-in-'+(++seq),timestamp:String(Math.floor(Date.now()/1000)),...(text?{type:'text',text:{body:text}}:{type:'audio',audio:{id:'123456',mime_type:'audio/ogg'}})};assert.equal((await request('/webhooks/whatsapp',{body:JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[message]}}]}]})})).status,200);}
 try{
  await send(ids[0]);process.env.VOICE_TRANSCRIPTION='on';await send(ids[1]);
  for(const id of ids.slice(0,2)){assert.equal(out.find(x=>x.to===id)?.text.body,'وصلتني رسالتك الصوتية، شكرًا إلك 🌷');const snapshot=new AssistantState({file,key});assert.deepEqual(snapshot.get(id).base,before[id].base);assert.deepEqual(snapshot.get(id).history,[]);assert.equal(snapshot.data.visaCases?.[id],undefined);}
  let snapshot=new AssistantState({file,key});const records=Object.values(snapshot.data.visaMedia);assert.equal(records.length,2);
  for(const record of records){const encrypted=fs.readFileSync(path.join(path.dirname(file),'visa-media',record.id+'.enc'));assert.equal(encrypted.includes(audio),false);}
  assert.equal((await request('/internal/assistant/status')).status,401);const status=await request('/internal/assistant/status',{authorized:true});assert.equal(status.status,200);assert.equal(status.headers['cache-control'],'no-store');const data=JSON.parse(status.text);assert.equal(data.voice.enabled,false);assert.equal(data.visa.media.transcriptionConfigured,false);
  failed=true;await send(ids[2]);assert.match(out.find(x=>x.to===ids[2]).text.body,/ما وصلني التسجيل الصوتي كامل/);assert.doesNotMatch(out.find(x=>x.to===ids[2]).text.body,/حفظ|تنزيل|تفريغ|آمن/);
  await send(ids[0],'احذف بياناتي');snapshot=new AssistantState({file,key});assert.equal(Object.values(snapshot.data.visaMedia).filter(r=>r.customer===ids[0]).length,0);assert.equal(fs.existsSync(path.join(path.dirname(file),'visa-media',records.find(r=>r.customer===ids[0]).id+'.enc')),false);
 }finally{global.fetch=original;await new Promise(r=>server.close(r));}
});
