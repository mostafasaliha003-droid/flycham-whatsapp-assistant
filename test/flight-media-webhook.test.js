'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const secret='synthetic-flight-media-secret',key='synthetic-flight-media-key',file=path.join(os.tmpdir(),'flight-media-state.enc');
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true'});
const {AssistantState}=require('../src/assistant-state'),seed=new AssistantState({file,key});
const contexts=[{base:{request:{origin:'الشارقة',destination:'دمشق'}}},{selected:'synthetic-offer'}, {handoffId:'synthetic-handoff'}, {offers:[{id:'synthetic-offer'}]},{}];
const customers=contexts.map((state,i)=>{const id='1555000810'+i;seed.set(id,{introduced:true,status:'collecting',history:[],offers:[],...state});return id;});
seed.data.serviceSessions=Object.fromEntries(customers.map(id=>[id,{service:'flight',at:Date.now(),revision:0}]));seed.save();
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
