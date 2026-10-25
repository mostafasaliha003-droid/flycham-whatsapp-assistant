'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'request-choice-webhook-')),secret='synthetic-choice-signing',admin='synthetic-choice-admin-key-xxxxxxxx',queue='synthetic-choice-queue-key-yyyyyyyy';
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(dir,'state.enc'),ASSISTANT_STATE_KEY:'synthetic-choice-state-key',WHATSAPP_APP_SECRET:secret,ASSISTANT_ADMIN_KEY:admin,AIR_ARABIA_QUOTE_QUEUE_KEY:queue,AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',FLYCHAM_PORTAL_ENABLED:'true',FARE_CATALOG_ENABLED:'false',CONSULTANT_ORCHESTRATOR_ENABLED:'true',ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-choice-cline',ASSISTANT_DEBOUNCE_MS:'0',DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-choice-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-choice-phone',NODE_ENV:'production'});
const {AssistantState}=require('../src/assistant-state');
const seed=new AssistantState(),ids={continued:'971500000031',fresh:'971500000032',busy:'971500000033',staff:'971500000034'};
const initial=()=>({introduced:true,tripId:crypto.randomUUID(),history:[{role:'user',text:'الطلب القديم بتاريخ 2090-11-11، شخص واحد و40 كيلو'}],status:'done',offers:[],selected:null,base:{submitted:true,awaiting:null,at:Date.now(),request:{origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',departureRange:null,returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:40,source:'customer',requestedByCustomer:true},provider:'airarabia',providerExclusive:true,providerRestrictionSource:'customer'}}});
for(const id of Object.values(ids))seed.set(id,initial());
const staff=seed.get(ids.staff);staff.humanOwned=true;seed.set(ids.staff,staff);
const {schema}=require('../src/consultant-brain'),{createServer}=require('../src/server');
const snapshot=id=>new AssistantState().get(id);
test('signed request-choice webhooks preserve or start distinct journeys only after an actual customer choice',async t=>{
 const originalFetch=global.fetch,out=[],model=[];let sequence=0;
 global.fetch=async(url,options)=>{
  if(String(url)==='https://api.cline.bot/api/v1/chat/completions'){
   const input=JSON.parse(JSON.parse(options.body).messages[1].content);model.push(input);
   const fields=Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([key,value])=>[key,value.type==='array'?[]:null]));
   if(/حلب/.test(input.text))Object.assign(fields,{origin:'حلب',destination:'الشارقة'});
   else if(/دبي/.test(input.text))Object.assign(fields,{origin:'دبي',destination:'دمشق'});
   const continuation=Boolean(input.context.request?.departureDate),question=continuation?null:'بأي تاريخ حابب تسافر؟';
   const decision={intent:continuation?'change':'request',fields,question,option:null,consultant:{action:continuation?'amend':'clarify',reply:null,preferences:{priority:null,airportFlexibility:null},nextStep:continuation?'search':'ask_missing',knowledgeQuery:null}};
   return{ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}]})};
  }
  assert.match(String(url),/^https:\/\/graph.facebook.com\//);const message=JSON.parse(options.body),messageId='synthetic-choice-out-'+(out.length+1);out.push({...message,messageId});return{ok:true,json:async()=>({messages:[{id:messageId}]})};
 };
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const call=(route,{data,method='POST',auth='queue'}={})=>new Promise((resolve,reject)=>{
  const body=data===undefined?'':JSON.stringify(data),headers={'Content-Type':'application/json',...(auth==='signature'?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')}:{Authorization:'Bearer '+(auth==='admin'?admin:queue)})};
  const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>{let json;try{json=JSON.parse(text||'{}');}catch{}resolve({status:response.statusCode,json,text});});});request.on('error',reject);request.end(body);
 });
 const post=(route,data={},auth='queue')=>call(route,{data,auth});
 const inbound=(customer,text,button)=>post('/webhooks/whatsapp',{entry:[{changes:[{field:'messages',value:{messages:[{id:'synthetic-choice-in-'+(++sequence),from:customer,timestamp:String(Math.floor(Date.now()/1000)),...(button?{type:'interactive',context:{id:button.contextId},interactive:{type:'button_reply',button_reply:{id:button.id,title:'UNTRUSTED_BUTTON_TITLE'}}}:{type:'text',text:{body:text}})}]}}]}]},'signature');
 const waitFor=async fn=>{for(let i=0;i<300;i++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected bounded request-choice processing');};
 const messagesFor=customer=>out.filter(message=>message.to===customer);
 const menuFor=customer=>messagesFor(customer).find(message=>message.type==='interactive');
 const press=(customer,menu,action)=>inbound(customer,null,{id:menu.interactive.action.buttons.find(button=>button.reply.id.startsWith('request_'+action+':')).reply.id,contextId:menu.messageId});
 const claim=provider=>post('/internal/quotes/claim',{provider,includeCatalog:false});
 try{
  for(const provider of ['airarabia','flycham'])await post('/internal/quotes/heartbeat',{provider,ready:true});
  await t.test('the initial menu is persisted, actionable and cannot mutate the current itinerary before selection',async()=>{
   const before=snapshot(ids.continued),modelsBefore=model.length;
   await inbound(ids.continued,'بدي تذكرة من دبي للشام');const menu=await waitFor(()=>menuFor(ids.continued));
   assert.equal(model.length,modelsBefore);assert.deepEqual(snapshot(ids.continued).base.request,before.base.request);assert.equal(snapshot(ids.continued).tripId,before.tripId);
   assert.equal(menu.interactive.type,'button');assert.equal(menu.interactive.action.buttons.length,2);assert.deepEqual(menu.interactive.action.buttons.map(button=>button.reply.title),['متابعة طلبي الحالي','طلب جديد مختلف']);
   const pending=snapshot(ids.continued).requestChoice;assert.match(pending.id,/^[a-f0-9-]{36}$/);assert.equal(pending.text,'بدي تذكرة من دبي للشام');assert.equal(pending.messageId,menu.messageId);assert.equal(menu.interactive.action.buttons[0].reply.id,'request_continue:'+pending.id);
   assert.deepEqual((await claim('flycham')).json,{});assert.deepEqual((await claim('airarabia')).json,{});
  });
  await t.test('continue applies the pending route once and preserves the known party, dates and baggage',async()=>{
   const before=snapshot(ids.continued),menu=menuFor(ids.continued),modelsBefore=model.length;
   await press(ids.continued,menu,'continue');await waitFor(()=>snapshot(ids.continued).status==='queued');
   const current=snapshot(ids.continued);assert.equal(current.requestChoice,undefined);assert.equal(current.tripId,before.tripId);assert.equal(current.base.request.origin,'دبي');assert.equal(current.base.request.destination,'دمشق');assert.equal(current.base.request.departureDate,'2090-11-11');assert.deepEqual(current.base.request.passengers,before.base.request.passengers);assert.equal(current.base.request.baggageRequest.checkedWeightKg,40);assert.equal(model.length,modelsBefore+1);
   const first=(await claim('airarabia')).json;assert.ok(first.id);assert.equal(first.request.origin,'الشارقة');assert.equal(first.request.baggageRequest.checkedWeightKg,40);
   const currentComparison=current.activeComparisonId,request=structuredClone(current.base.request),countBefore=messagesFor(ids.continued).length;
   await press(ids.continued,menu,'continue');await waitFor(()=>messagesFor(ids.continued).length>countBefore);
   assert.equal(model.length,modelsBefore+1);assert.equal(snapshot(ids.continued).activeComparisonId,currentComparison);assert.deepEqual(snapshot(ids.continued).base.request,request);assert.equal((await post('/internal/quotes/current',{id:first.id,lease:first.lease})).json.current,true);assert.match(messagesFor(ids.continued).at(-1).text.body,/رسالة سابقة/);
   // Remove these synthetic searches so the busy-journey case has its own queue.
   await inbound(ids.continued,'وقف البحث');await waitFor(()=>snapshot(ids.continued).status==='cancelled');
  });
  await t.test('new request starts without inheriting old party, dates, weight, preferences or model context',async()=>{
   const before=snapshot(ids.fresh),modelsBefore=model.length;
   await inbound(ids.fresh,'بدي تذكرة من حلب للشارقة');const menu=await waitFor(()=>menuFor(ids.fresh));assert.equal(model.length,modelsBefore);
   await press(ids.fresh,menu,'new');await waitFor(()=>model.length>modelsBefore&&snapshot(ids.fresh).base?.request?.origin==='حلب');
   const current=snapshot(ids.fresh),input=model.at(-1);assert.notEqual(current.tripId,before.tripId);assert.equal(current.base.request.origin,'حلب');assert.equal(current.base.request.destination,'الشارقة');assert.equal(current.base.request.departureDate,null);assert.equal(current.base.request.departureRange,null);assert.equal(current.base.request.passengers,null);assert.ok(!current.base.request.baggageRequest||current.base.request.baggageRequest.checkedWeightKg===30);assert.notEqual(current.base.request.providerExclusive,true);assert.equal(current.offers.length,0);assert.equal(current.selected,null);assert.equal(current.requestChoice,undefined);assert.equal(current.activeComparisonId,null);
   assert.ok(!input.context.request?.departureDate);assert.ok(!input.context.request?.passengers);assert.doesNotMatch(JSON.stringify(input.context.history||[]),/الطلب القديم|2090-11-11|40 كيلو/);assert.equal(input.text,'بدي تذكرة من حلب للشارقة');
   assert.deepEqual((await claim('flycham')).json,{});assert.deepEqual((await claim('airarabia')).json,{});
   const after=structuredClone(current),countBefore=messagesFor(ids.fresh).length,modelCount=model.length;
   await press(ids.fresh,menu,'new');await waitFor(()=>messagesFor(ids.fresh).length>countBefore);
   assert.equal(snapshot(ids.fresh).tripId,after.tripId);assert.deepEqual(snapshot(ids.fresh).base,after.base);assert.equal(model.length,modelCount);assert.match(messagesFor(ids.fresh).at(-1).text.body,/رسالة سابقة/);
  });
  await t.test('a new independent journey waits behind actual current jobs and then receives a clean context',async()=>{
   await inbound(ids.busy,'أعد البحث');await waitFor(()=>snapshot(ids.busy).status==='queued');const before=snapshot(ids.busy),modelsBefore=model.length;
   await inbound(ids.busy,'بدي تذكرة من حلب للشارقة');const menu=await waitFor(()=>menuFor(ids.busy));assert.equal(snapshot(ids.busy).activeComparisonId,before.activeComparisonId);assert.deepEqual(snapshot(ids.busy).base.request,before.base.request);
   await press(ids.busy,menu,'new');await waitFor(()=>snapshot(ids.busy).pendingRequests?.length===1);assert.equal(model.length,modelsBefore);assert.equal(snapshot(ids.busy).activeComparisonId,before.activeComparisonId);assert.equal(snapshot(ids.busy).tripId,before.tripId);
   const jobs=[(await claim('airarabia')).json,(await claim('airarabia')).json];assert.ok(jobs.every(job=>job.id&&job.request.destination==='دمشق'&&job.request.departureDate==='2090-11-11'&&job.request.passengers.adults===1&&job.request.baggageRequest.checkedWeightKg===40));assert.equal(new Set(jobs.map(job=>job.request.origin)).size,2);
   for(const job of jobs)assert.equal((await post('/internal/quotes/complete',{id:job.id,lease:job.lease,status:'airport_unconfirmed',outcome:'failed',reply:''})).json.accepted,true);
   await waitFor(()=>snapshot(ids.busy).tripId!==before.tripId&&snapshot(ids.busy).base?.request?.origin==='حلب');
   const current=snapshot(ids.busy);assert.equal(current.pendingRequests.length,0);assert.equal(current.base.request.destination,'الشارقة');assert.equal(current.base.request.departureDate,null);assert.equal(current.base.request.passengers,null);assert.equal(model.length,modelsBefore+1);assert.doesNotMatch(JSON.stringify(model.at(-1).context.history||[]),/الطلب القديم|2090-11-11|40 كيلو/);
  });
  await t.test('staff ownership suppresses menu and model execution while retaining the incoming message',async()=>{
   const modelsBefore=model.length,countBefore=out.length;await inbound(ids.staff,'بدي تذكرة من دبي للشام');
   await waitFor(async()=>{const detail=await call('/internal/assistant/conversations/'+ids.staff,{method:'GET',auth:'admin'});return detail.json?.messages?.some(message=>message.direction==='in'&&message.text==='بدي تذكرة من دبي للشام');});await new Promise(resolve=>setTimeout(resolve,25));
   assert.equal(out.length,countBefore);assert.equal(model.length,modelsBefore);assert.equal(snapshot(ids.staff).requestChoice,undefined);assert.equal(snapshot(ids.staff).humanOwned,true);
  });
 }finally{await new Promise(resolve=>server.close(resolve));global.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true});}
});
