'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const customer='15550001234',staff='15550009999',secret='synthetic-handoff-card-secret',key='synthetic-handoff-card-encryption-key';
const file=path.join(os.tmpdir(),'handoff-card-state.enc');
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'35000',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',HUMAN_HANDOFF_RECIPIENT:staff,AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'false'});
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
seed.set(customer,{introduced:true,status:'unsupported',history:[],offers:[],base:{request:{origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',tripType:'one_way',passengers:{adults:2,children:1,infants:0}},submitted:false}});
seed.data.serviceSessions={[customer]:{service:'flight',at:Date.now(),revision:0}};seed.save();
const {createServer}=require('../src/server');
test('signed urgent group handoff notifies staff promptly using an Arabic card once',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\//);out.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'synthetic-out-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const inbound=()=>new Promise((resolve,reject)=>{
  const body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-handoff-in',from:customer,type:'text',text:{body:'حوّلني للموظف'}}]}}]}]});
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/webhooks/whatsapp',method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(body);
 });
 try{
  assert.equal(await inbound(),200);
  const deadline=Date.now()+4000;while(!out.some(x=>x.to===staff)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  const card=out.find(x=>x.to===staff)?.text?.body;assert.ok(card,'Must notify before the 35-second quiet window');assert.match(card,/رقم العميل: \+15550001234/);assert.match(card,/https:\/\/wa.me\/15550001234/);assert.match(card,/2 بالغ، 1 طفل، 0 رضيع/);assert.match(card,/أعد التحقق من السعر والتوفر/);assert.doesNotMatch(card,/"request"|"customer"/);
  const snapshot=new AssistantState({file,key}).data;assert.equal(snapshot.handoffs.length,1);assert.equal(snapshot.handoffs[0].state,'notified');assert.equal(snapshot.handoffs[0].summary.offer,null);
  await inbound();assert.equal(out.filter(x=>x.to===staff).length,1);
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
