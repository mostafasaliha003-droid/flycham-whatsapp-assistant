'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const secret='synthetic-flight-media-secret',key='synthetic-flight-media-key',file=path.join(os.tmpdir(),'flight-media-state.enc');
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true'});
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
const contexts=[{base:{request:{origin:'الشارقة',destination:'دمشق'}}},{selected:'synthetic-offer'}, {handoffId:'synthetic-handoff'}, {offers:[{id:'synthetic-offer'}]},{}];
const customers=contexts.map((state,i)=>{const id='1555000810'+i;seed.set(id,{introduced:true,status:'collecting',history:[],offers:[],...state});return id;});
seed.data.serviceSessions=Object.fromEntries(customers.map(id=>[id,{service:'flight',at:Date.now(),revision:0}]));seed.save();
const cx={voice:'15550008201',failed:'15550008202',rating:'15550008203',skip:'15550008204',handoff:'15550008205',empathy:'15550008206',visaVoice:'15550008207',owned:'15550008208',low:'15550008209',button:'15550008210'};
for(const [kind,id]of Object.entries(cx)){seed.set(id,{introduced:true,status:'collecting',history:[],offers:[],...(kind==='handoff'?{status:'unsupported',base:{request:{origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',tripType:'one_way',passengers:{adults:2,children:0,infants:0}}}}:{}),...(kind==='owned'?{humanOwned:true}:{} )});seed.data.serviceSessions[id]={service:['rating','skip','visaVoice','button'].includes(kind)?'saudi_visa':'flight',at:Date.now(),revision:0};}
const {requestRating}=require('../src/service-rating');for(const name of ['rating','skip','low','button'])requestRating(seed,cx[name],{service:'saudi_visa'});seed.save();
const before=structuredClone(seed.data.customers),{createServer}=require('../src/server');
test('Package 8 signed flight attachments acknowledge their own trip without vision, price changes or automatic handoff',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\/[^/]+\/synthetic-phone-id\/messages$/);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'synthetic-flight-out-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 async function send(from){const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-in-'+from,from,timestamp:String(Math.floor(Date.now()/1000)),type:'image',image:{id:'123456789',mime_type:'image/jpeg',caption:'synthetic passport N12345678'}}]}}]}]});return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);});}
 try{
  for(let i=0;i<customers.length;i++){
   assert.equal(await send(customers[i]),200);const reply=out.find(x=>x.to===customers[i])?.text?.body;assert.ok(reply);
   assert.match(reply,i<4?/ضمن محادثة الطيران.*سيراجعه موظف الحجوزات/:/اكتب تفاصيل الرحلة برسالة نصية/);assert.doesNotMatch(reply,/N12345678|تم تأكيد|تم حجز/);
  }
  const after=new AssistantState({file,key});for(const id of customers)for(const field of ['base','selected','offers','handoffId'])assert.deepEqual(after.get(id)[field],before[id][field]);assert.equal(after.data.handoffs.length,0);assert.equal(Object.keys(after.data.visaCases||{}).length,0);assert.equal(out.length,customers.length);
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});

test('Packages 12–15 signed webhook voice routing, failure isolation, ratings, staff hours and empathy',async()=>{
 const original=global.fetch,originalNow=Date.now,out=[],staff='15550008999',calls=[];let transcript='من الشارقة إلى دمشق 15/11/2026 ذهاب فقط لحالي',failure=false;
 Object.assign(process.env,{GEMINI_API_KEY:'synthetic-gemini-key',VOICE_TRANSCRIPTION_PROVIDERS:'gemini',HUMAN_HANDOFF_RECIPIENT:staff,ASSISTANT_ADMIN_KEY:'synthetic-cx-admin-key-xxxxxxxxxxxx'});
 Date.now=()=>Date.UTC(2026,10,4,19); // 23:00 in Dubai.
 const audio=Buffer.from('OggS-synthetic-audio');
 global.fetch=async(url,opt)=>{
  calls.push(String(url));
  if(String(url).includes('generativelanguage.googleapis.com'))return failure?new Response('{}',{status:503}):Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:true,transcript})}]}}]});
  if(String(url).includes('lookaside.fbsbx.com'))return new Response(audio,{headers:{'content-type':'audio/ogg'}});
  if(String(url).endsWith('/123456'))return Response.json({id:'123456',mime_type:'audio/ogg',file_size:audio.length,url:'https://lookaside.fbsbx.com/synthetic-voice'});
  assert.match(String(url),/^https:\/\/graph.facebook.com\/[^/]+\/synthetic-phone-id\/messages$/);out.push(JSON.parse(opt.body));return Response.json({messages:[{id:'cx-out-'+out.length}]});
 };
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let seq=0;
 async function send(from,text,{voice=false,button=false}={}){
  const message={from,id:'cx-in-'+(++seq),timestamp:String(Math.floor(Date.now()/1000)),type:voice?'audio':button?'interactive':'text',...(voice?{audio:{id:'123456',mime_type:'audio/ogg; codecs=opus'}}:button?{interactive:{type:'button_reply',button_reply:{id:'not-a-rating',title:text}}}:{text:{body:text}})};
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[message]}}]}]});
  const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);});assert.equal(status,200);return out.filter(x=>x.to===from).at(-1)?.text?.body;
 }
 try{
  const success=await send(cx.voice,'',{voice:true});assert.match(success,/^سمعت رسالتك الصوتية/);assert.match(success,/الشارقة/);let snapshot=new AssistantState({file,key});assert.equal(snapshot.data.customers[cx.voice].base.request.destination,'دمشق');assert.equal(snapshot.data.visaCases?.[cx.voice],undefined);assert.equal(Object.keys(snapshot.data.visaMedia||{}).length,0);
  failure=true;const failed=await send(cx.failed,'',{voice:true});assert.match(failed,/ما قدرت أفرّغها/);snapshot=new AssistantState({file,key});assert.equal(snapshot.data.customers[cx.failed].base,undefined);assert.equal(snapshot.data.customers[cx.failed].history.length,0);assert.equal(snapshot.data.visaCases?.[cx.failed],undefined);failure=false;
  const rated=await send(cx.rating,'5');assert.match(rated,/شكراً كتير لتقييمك/);snapshot=new AssistantState({file,key});assert.equal(snapshot.data.visaCases?.[cx.rating],undefined);
  await send(cx.skip,'مرحبا');const normal=await send(cx.skip,'2');assert.doesNotMatch(normal,/تقييمك/);snapshot=new AssistantState({file,key});assert.equal(snapshot.data.serviceRatings.history.find(x=>x.customer===cx.skip).skipped,true);
  const handoff=await send(cx.handoff,'ضروري حوّلني للموظف');assert.match(handoff,/بكرا من الساعة 10 الصبح/);assert.match(out.filter(x=>x.to===staff).at(-1).text.body,/أولوية: عميل مستعجل\/منزعج/);
  const handoffRecord=new AssistantState({file,key}).data.handoffs.find(h=>h.customer===cx.handoff);
  async function admin(action,data){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/internal/assistant/handoffs/'+handoffRecord.id+'/'+action,method:'POST',headers:{Authorization:'Bearer synthetic-cx-admin-key-xxxxxxxxxxxx','Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(data));});}
  assert.equal(await admin('claim',{}),200);const sentBefore=out.filter(x=>x.to===cx.handoff).length;
  assert.equal(await admin('issued',{ticketConfirmed:false}),409);assert.equal(out.filter(x=>x.to===cx.handoff).length,sentBefore);
  assert.equal(await admin('issued',{ticketConfirmed:true}),200);const issuedTexts=out.filter(x=>x.to===cx.handoff).slice(sentBefore).map(x=>x.text.body);assert.equal(issuedTexts.length,2);assert.match(issuedTexts[0],/تأكيد إصدار/);assert.match(issuedTexts[1],/أحمد/);
  assert.equal(await admin('issued',{ticketConfirmed:true}),409);assert.equal(out.filter(x=>x.to===cx.handoff).length,sentBefore+2);
  const empathy=await send(cx.empathy,'صرلي ساعة ناطر');assert.equal((empathy.match(/حقك علينا/g)||[]).length,1);
  transcript='سوري جواز عادي لحالي';const visa=await send(cx.visaVoice,'',{voice:true});assert.match(visa,/^سمعت رسالتك الصوتية/);snapshot=new AssistantState({file,key});assert.equal(snapshot.data.visaCases[cx.visaVoice].applicants[0].nationality,'سوريا');assert.equal(Object.keys(snapshot.data.visaMedia||{}).length,0);
  const beforeCalls=calls.length;await send(cx.owned,'',{voice:true});assert.equal(calls.length,beforeCalls);
  const low=await send(cx.low,'1');assert.match(low,/بكرا من الساعة 10 الصبح/);assert.ok(out.some(x=>x.to===staff&&/تقييم منخفض 1\/5/.test(x.text?.body)));
  const button=await send(cx.button,'5',{button:true});assert.doesNotMatch(button||'',/شكراً كتير لتقييمك/);
 }finally{Date.now=originalNow;global.fetch=original;delete process.env.GEMINI_API_KEY;delete process.env.HUMAN_HANDOFF_RECIPIENT;await new Promise(r=>server.close(r));}
});
