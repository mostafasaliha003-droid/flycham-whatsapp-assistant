'use strict';
process.env.SAUDI_VISA_COMPLAINT_RECIPIENT='971500000005';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ismail-integration-')),secret='fake-signed-hook',admin='synthetic-ismail-admin-xxxxxxxxx';
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(dir,'state.enc'),ASSISTANT_STATE_KEY:'synthetic-state-key',WHATSAPP_APP_SECRET:secret,ASSISTANT_ADMIN_KEY:admin,WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_GRAPH_API_VERSION:'v23.0',SAUDI_VISA_ENABLED:'true',ASSISTANT_DEBOUNCE_MS:'0',ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-cline',DRY_RUN:'false',FARE_CATALOG_ENABLED:'false'});
const {schema}=require('../src/saudi-visa-nlu');const {createServer}=require('../src/server');
test('signed multi-service webhook: Saudi quotes, real Cline contract, complaint takeover and manual block remain isolated',async()=>{
 const original=global.fetch,posts=[];let sequence=0,model=0;global.fetch=async(url,opt)=>{if(String(url).includes('api.cline.bot')){model++;const d={intent:'other',fields:Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null])),target:null,correction:false,question:null,option:null};return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(d)}}]})};}posts.push(JSON.parse(opt.body));return{ok:true,json:async()=>({messages:[{id:'synthetic-out-'+posts.length}]})};};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 function call(route,data,auth=true){return new Promise((resolve,reject)=>{const body=data?JSON.stringify(data):'',req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+admin}:{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')})}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,json});});});req.on('error',reject);req.end(body);});}
 const send=(from,text)=>call('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-in-'+(++sequence),from,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]},false);
 const wait=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('bounded local processing did not complete');};
 try{
  await send('971500000099','مرحبا');assert.equal(posts.at(-1).type,'interactive');assert.match(posts.at(-1).interactive.body.text,/أحمد/);assert.match(posts.at(-1).interactive.body.text,/إسماعيل/);
  const menuId=posts.at(-1).interactive.action.buttons[1].reply.id;
  await call('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-button-'+(++sequence),from:'971500000099',timestamp:String(Math.floor(Date.now()/1000)),type:'interactive',interactive:{type:'button_reply',button_reply:{id:menuId,title:'untrusted'}}}]}}]}]},false);
  assert.match(posts.at(-1).text.body,/إسماعيل/);assert.equal((await call('/internal/assistant/conversations/971500000099')).json.customer.service,'saudi_visa');
  await send('971500000099','بدي فيزا السعودية انا سوري جواز عادي شخص واحد');assert.ok(model);assert.match(posts.at(-1).text.body,/700/);
  let detail=(await call('/internal/assistant/conversations/971500000099')).json;assert.equal(detail.customer.service,'saudi_visa');assert.equal(detail.visaCase.quote.total,700);assert.equal(detail.customer.request,null);assert.equal(detail.visaCase.paymentStatus,'unverified');
  await send('971500000099','صرنا ثلاثة كلنا سوريين جوازات عادية');detail=(await call('/internal/assistant/conversations/971500000099')).json;assert.equal(detail.visaCase.quote.total,1950);
  await send('971500000005','مرحبا');let count=posts.length;
  await send('971500000099','دفعت وقدمت عندكن وماطلعت ومارجعتولي فلوسي');await wait(()=>posts.some(x=>x.to==='971500000005'&&/شكوى/.test(x.text?.body||'')));
  detail=(await call('/internal/assistant/conversations/971500000099')).json;assert.equal(detail.complaint.state,'pending');assert.equal(detail.customer.staffClaimed,false);assert.equal(detail.customer.humanOwned,true);assert.match(posts.find(x=>x.to==='971500000005'&&/شكوى/.test(x.text?.body||'')).text.body,/operations\?customer=/);
  count=posts.length;await send('971500000099','شو صار؟');assert.equal(posts.length,count);assert.equal((await call('/internal/assistant/conversations/971500000099/claim',{})).json.customer.staffClaimed,true);
  await send('971500000099','انا مقدم وعملتوا نصب علي');assert.equal(posts.length,count);
  await call('/internal/assistant/conversations/971500000099/release',{});await call('/internal/assistant/conversations/971500000099/block',{confirm:true,reason:'synthetic test',scope:'assistant'});await send('971500000099','فيزا السعودية');assert.equal(posts.length,count);
  await call('/internal/assistant/conversations/971500000099/unblock',{confirm:true,reason:'synthetic test',scope:'assistant'});await send('971500000098','بدي فيزا السعودية مصري جواز عادي شخص واحد');assert.match(posts.at(-1).text.body,/واحدة/);detail=(await call('/internal/assistant/conversations/971500000098')).json;assert.equal(detail.visaCase.applicantCount,1);assert.equal(detail.complaint,null);
  assert.equal((await call('/internal/assistant/visa-media/11111111-1111-4111-8111-111111111111?customer=971500000098')).status,404);
 }finally{await new Promise(r=>server.close(r));global.fetch=original;fs.rmSync(dir,{recursive:true,force:true});}
});
