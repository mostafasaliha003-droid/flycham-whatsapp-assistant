'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const secret='consultant-webhook-secret',key='consultant-queue-key-xxxxxxxxxxxxxxxx';
Object.assign(process.env,{CONSULTANT_ORCHESTRATOR_ENABLED:'true',ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'production',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'test-token',WHATSAPP_PHONE_NUMBER_ID:'test-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_KEY:key,ASSISTANT_ADMIN_KEY:key,FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'test-consultant-key'});
const {schema}=require('../src/consultant-brain'),{createServer}=require('../src/server');
function decision(intent,action,patch={}){return{intent,fields:Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,k in patch?patch[k]:v.type==='array'?[]:null])),question:null,option:null,consultant:{action,reply:null,preferences:{priority:null,airportFlexibility:null},nextStep:action==='search'?'search':'none',knowledgeQuery:null}};}
test('signed fragmented customer turn flows through Cline to a validated provider command and grounded cards',async()=>{
 const original=global.fetch,out=[],model=[];global.fetch=async(url,opt)=>{
  if(String(url)==='https://api.cline.bot/api/v1/chat/completions'){
   const input=JSON.parse(JSON.parse(opt.body).messages[1].content);model.push(input);let d;
   if(input.text.includes('الخيار 1')){d=decision('select','answer');d.option=1;}
   else if(input.text.includes('بدي ثبت'))d=decision('booking','handoff');
   else if(input.text.includes('شخص واحد'))d=decision('request','search',{adults:1,children:0,infants:0});
   else d=decision('request','clarify',{origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',tripType:'one_way'});
   if(d.consultant.action==='clarify'){d.question='كم عدد المسافرين؟';d.consultant.reply=d.question;d.consultant.nextStep='ask_missing';}
   return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})};
  }
  assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'consultant-sent-'+out.length}]})};
 };
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let n=0;
 const post=(path,data,inbound=false)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),q=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{'Content-Type':'application/json',...(inbound?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+key})}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve(JSON.parse(s||'{}')));});q.on('error',reject);q.end(body);});
 const inbound=messages=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:messages.map(text=>({id:'consultant-in-'+(++n),from:'synthetic-consultant-customer',type:'text',text:{body:text}}))}}]}]},true);
 const wait=()=>new Promise(r=>setTimeout(r,30));
 try{
  await post('/internal/quotes/heartbeat',{provider:'airarabia',ready:true});await post('/internal/quotes/heartbeat',{provider:'flycham',ready:true});
  await inbound(['من الشارقة للشام 11-11-2090 ذهاب بس']);await wait();assert.match(out[0].text.body,/عدد المسافرين/);assert.match(out[0].text.body,/الافتراضي/);assert.deepEqual(await post('/internal/quotes/claim',{provider:'flycham'}),{});
  await inbound(['شخص واحد']);await wait();assert.match(out.at(-1).text.body,/جاري البحث/);assert.ok(model.at(-1).context.request.origin==='الشارقة');
  const fly=await post('/internal/quotes/claim',{provider:'flycham'});assert.ok(fly.id);assert.equal(fly.request.origin,'الشارقة');assert.equal(fly.request.passengers.adults,1);assert.equal(fly.request.departureDate,'2090-11-11');
  // Fail the two first-page FlyCham probes without inventing absence.
  await post('/internal/quotes/complete',{id:fly.id,lease:fly.lease,outcome:'failed',reply:'PRIVATE_UNTRUSTED_PROSE'});
  const dubai=await post('/internal/quotes/claim',{provider:'flycham'});assert.equal(dubai.request.origin,'دبي');await post('/internal/quotes/complete',{id:dubai.id,lease:dubai.lease,outcome:'failed',reply:'PRIVATE_UNTRUSTED_PROSE'});
  const air=await post('/internal/quotes/claim',{provider:'airarabia'});assert.ok(air.id);
  await post('/internal/quotes/progress',{id:air.id,lease:air.lease,seq:1,reply:'PRIVATE_UNTRUSTED_PROSE',metadata:{offer:{provider:'airarabia',request:air.request,timing:{out:{flight:'G9123',departure:'10:00',arrival:'12:00'}},price:{sellingTotal:'650.00',weights:[{kg:30}]}}}});
  await post('/internal/quotes/complete',{id:air.id,lease:air.lease,outcome:'done',reply:'PRIVATE_UNTRUSTED_PROSE',coverage:[{date:'2090-11-11',status:'confirmed'}]});const abu=await post('/internal/quotes/claim',{provider:'airarabia'});assert.equal(abu.request.origin,'أبوظبي');await post('/internal/quotes/complete',{id:abu.id,lease:abu.lease,outcome:'failed',reply:''});await wait();
  const card=out.at(-1).text.body;assert.match(card,/650.00/);assert.match(card,/اقتراح أحمد/);assert.doesNotMatch(card,/PRIVATE_UNTRUSTED_PROSE/);assert.match(card,/10:00/);
  await inbound(['الخيار 1']);await wait();await inbound(['بدي ثبت']);await wait();
  const get=path=>new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path,headers:{Authorization:'Bearer '+key}},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>resolve(JSON.parse(data||'{}')));}).on('error',reject);});
  const handoffs=await get('/internal/assistant/handoffs');assert.equal(handoffs.length,1);const h=handoffs[0];
  assert.deepEqual(await post('/internal/assistant/handoffs/'+h.id+'/issued',{ticketConfirmed:true}),{});
  assert.equal((await post('/internal/assistant/handoffs/'+h.id+'/claim',{})).ok,true);
  assert.equal((await post('/internal/assistant/handoffs/'+h.id+'/issued',{ticketConfirmed:true})).ok,true);
  const status=await get('/internal/assistant/status');assert.equal(status.consultant.metrics.counts.issued,1);assert.equal(status.consultant.metrics.counts.handoff,1);

 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
