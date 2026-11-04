'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const file=path.join(os.tmpdir(),'cx-summit-webhook.enc'),key='synthetic-cx-key',secret='synthetic-cx-secret',admin='synthetic-cx-admin-01234567890123456789';
Object.assign(process.env,{ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:key,ASSISTANT_ADMIN_KEY:admin,ASSISTANT_DEBOUNCE_MS:'0',NODE_ENV:'test',WHATSAPP_APP_SECRET:secret,DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FARE_CATALOG_ENABLED:'false',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false',SAUDI_VISA_ENABLED:'true'});
const {AssistantState}=require('../src/assistant-state'),{SaudiVisaEngine}=require('../src/saudi-visa-engine');
const seed=new AssistantState({file,key}),id='15550007161',request={origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-15',tripType:'one_way',passengers:{adults:1,children:0,infants:0}};
seed.set(id,{introduced:true,status:'collecting',history:[],offers:[],base:{request,submitted:false,at:Date.now()}});
const engine=new SaudiVisaEngine({store:seed,env:{}}),c=engine.newCase();Object.assign(c,{greeted:true,stage:'quoted',applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],paymentStatus:'verified',quote:{total:640,currency:'AED'}});c.quote=require('../src/saudi-visa-policy').calculateQuote(c,{feesEnabled:true});engine.save(id,c);seed.data.serviceSessions={[id]:{service:'flight',revision:0}};seed.save();
const {createServer}=require('../src/server');
test('16–20 signed webhook preserves paid cases, decorates real switches once and restricts aggregate analytics to admin',async()=>{
 const original=global.fetch,out=[];global.fetch=async(url,opt)=>{assert.match(String(url),/^https:\/\/graph.facebook.com\/[^/]+\/synthetic-phone\/messages$/);const body=JSON.parse(opt.body);out.push(body);return{ok:true,json:async()=>({messages:[{id:'synthetic-cx-out-'+out.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));let serial=0;
 const call=(url,body=null,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method:body?'POST':'GET',headers},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,body:data,headers:res.headers}));});req.on('error',reject);req.end(body);});
 async function send(text,customer=id){const count=out.length,body=JSON.stringify({entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-cx-in-'+(++serial),from:customer,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]});assert.equal((await call('/webhooks/whatsapp',body,{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')})).status,200);for(let i=0;i<100&&out.length===count;i++)await new Promise(r=>setTimeout(r,5));assert.ok(out.length>count,'reply accepted');return out.at(-1).text?.body||out.at(-1).interactive?.body?.text;}
 try{
  assert.equal((await call('/internal/assistant/status')).status,401);
  const first=await send('فيزا السعودية');assert.match(first,/تفاصيل رحلتك محفوظة عند أحمد/);assert.equal(first.split('تفاصيل رحلتك محفوظة عند أحمد').length,2);assert.doesNotMatch(first,/رعد|Raad/i);
  const v=new AssistantState({file,key}).data.visaCases[id];assert.equal(v.id,c.id);assert.equal(v.paymentStatus,'verified');assert.deepEqual(v.quote,c.quote);
  const second=await send('طيران');assert.match(second,/ملف فيزا السعودية محفوظ عند إسماعيل/);assert.doesNotMatch(second,/رعد|Raad/i);
  const advice=await send('passport expires 2090-12-15');assert.match(advice,/30 يوماً/);assert.doesNotMatch(advice,/ملف فيزا السعودية محفوظ/);
  const after=new AssistantState({file,key});for(const k of ['origin','destination','departureDate','tripType','passengers'])assert.deepEqual(after.get(id).base.request[k],request[k]);assert.equal(after.data.visaCases[id].paymentStatus,'verified');assert.equal(after.data.handoffs.length,0);
  const status=await call('/internal/assistant/status',null,{Authorization:'Bearer '+admin});assert.equal(status.status,200);assert.equal(status.headers['cache-control'],'no-store');const cx=JSON.parse(status.body).cxAnalytics;assert.equal(cx.totalEvents,4);assert.equal(cx.byService.flight.resolved,1);assert.equal(cx.byService.saudi_visa.resolved,0);assert.equal(cx.languageCounts.en,2);assert.equal(cx.voice.transcribed,0);assert.doesNotMatch(JSON.stringify(cx),/155500|2090|passport|640/);
  const events=after.data.cxAnalytics.events;assert.equal(events.filter(e=>e.category==='cross_service_switch').length,2);assert.equal(events.filter(e=>e.category==='validity_warning').length,1);
  const publicStatus=await call('/health');assert.doesNotMatch(publicStatus.body,/cxAnalytics|escalationReasons/);
 }finally{await new Promise(r=>server.close(r));global.fetch=original;}
});
