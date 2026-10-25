'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {InboxService,handleInboxRequest}=require('../src/inbox-http');
const NOW=Date.parse('2026-10-25T00:00:00Z');
function setup({send,getSearch}={}){let now=NOW,calls=0,cancels=0;const store={data:{customers:{}},save(){},set(id,s){this.data.customers[id]=structuredClone(s);}},assistant={state:id=>structuredClone(store.data.customers[id]||{status:'searching',base:{request:{origin:'دبي',destination:'دمشق'}}})},service=new InboxService({store,assistant,getSearch,now:()=>now,onClaim:async()=>{cancels++;},send:async(id,text,guard)=>{calls++;if(send)return send(id,text,guard);guard();return{messages:[{id:'out-'+calls}]};}});service.journal.recordInbound('971500000001',{id:'in-1',text:'مرحبا'});return{service,store,assistant,advance:ms=>now+=ms,calls:()=>calls,cancels:()=>cancels};}
test('staff must claim an existing recent conversation before sending; notes and read are private',async()=>{
 const f=setup();await assert.rejects(f.service.sendMessage('971500000001',{text:'أهلا',idempotencyKey:'message-001'}),/CLAIM_REQUIRED/);await assert.rejects(f.service.sendMessage('arbitrary-number',{text:'أهلا',idempotencyKey:'message-001'}),/CONVERSATION_NOT_FOUND/);assert.equal(f.calls(),0);
 await f.service.claim('971500000001');assert.equal(f.cancels(),1);assert.equal(f.service.summary('971500000001').humanOwned,true);assert.equal((await f.service.sendMessage('971500000001',{text:'أهلا',idempotencyKey:'message-001'})).ok,true);assert.equal(f.service.detail('971500000001').messages.at(-1).actor,'staff');
 f.service.note('971500000001','ملاحظة داخلية');assert.equal(f.calls(),1);f.service.read('971500000001');assert.equal(f.service.summary('971500000001').unread,0);f.service.release('971500000001');assert.equal(f.service.summary('971500000001').humanOwned,false);
});
test('24-hour window uses inbound time, not a newer staff note or outbound message',async()=>{
 const f=setup();await f.service.claim('971500000001');f.advance(86400000);f.service.note('971500000001','ملاحظة جديدة');await assert.rejects(f.service.sendMessage('971500000001',{text:'أهلا',idempotencyKey:'message-001'}),/WINDOW_CLOSED/);assert.equal(f.calls(),0);
});
test('dispatch guard prevents a queued staff send after release or service-window expiry without a Meta call',async t=>{
 for(const reason of ['CLAIM_REQUIRED','WINDOW_CLOSED'])await t.test(reason,async()=>{
  let queued,resume,providerCalls=0;const entered=new Promise(resolve=>{queued=resolve;}),held=new Promise(resolve=>{resume=resolve;}),f=setup({send:async(id,text,guard)=>{queued();await held;guard();providerCalls++;return{messages:[{id:'queued-output'}]};}}),id='971500000001',body={text:'رد ينتظر انتهاء الإرسال السابق',idempotencyKey:'queued-message-001'};
  await f.service.claim(id);const pending=f.service.sendMessage(id,body);await entered;
  if(reason==='CLAIM_REQUIRED')f.service.release(id);else f.advance(86400000);
  resume();const result=await pending;assert.equal(providerCalls,0);assert.equal(result.ok,false);assert.equal(result.error,reason);assert.equal(result.attempt.state,'failed');assert.equal(result.attempt.failure,reason);assert.equal(f.service.detail(id).messages.length,1,'a message that never dispatched is not journaled as outbound');
  const replay=await f.service.sendMessage(id,body);assert.equal(replay.error,reason);assert.equal(replay.attempt.state,'failed');assert.equal(f.calls(),1,'same idempotency key does not requeue a failed dispatch');assert.equal(providerCalls,0);
 });
});
test('same idempotency key never repeats accepted or ambiguous network sends, including restart',async()=>{
 const f=setup();await f.service.claim('971500000001');const body={text:'رد واحد',idempotencyKey:'message-001'};await f.service.sendMessage('971500000001',body);await f.service.sendMessage('971500000001',body);assert.equal(f.calls(),1);await assert.rejects(f.service.sendMessage('971500000001',{...body,text:'نص مختلف'}),/IDEMPOTENCY_CONFLICT/);
 const g=setup({send:async()=>{throw Error('PRIVATE_NETWORK_DETAIL');}});await g.service.claim('971500000001');const first=await g.service.sendMessage('971500000001',body);assert.equal(first.error,'DELIVERY_UNCERTAIN');assert.equal(g.service.detail('971500000001').messages.length,1);await g.service.sendMessage('971500000001',body);assert.equal(g.calls(),1);const reload=new InboxService({store:g.store,assistant:g.assistant,send:async()=>{throw Error('must not resend');},now:()=>NOW});assert.equal((await reload.sendMessage('971500000001',body)).error,'DELIVERY_UNCERTAIN');
});
test('concurrent identical sends share one post and a conflicting in-flight body is rejected',async()=>{
 let release;const held=new Promise(r=>release=r),f=setup({send:async()=>{await held;return{messages:[{id:'held-output'}]};}});await f.service.claim('971500000001');const body={text:'رد واحد',idempotencyKey:'message-001'},one=f.service.sendMessage('971500000001',body),two=f.service.sendMessage('971500000001',body);await assert.rejects(f.service.sendMessage('971500000001',{...body,text:'رد مختلف'}),/IDEMPOTENCY_CONFLICT/);release();assert.equal((await one).ok,true);assert.equal((await two).ok,true);assert.equal(f.calls(),1);
});
test('durable ownership survives an in-flight assistant snapshot overwriting legacy state',async()=>{
 const f=setup();const stale=f.assistant.state('971500000001');await f.service.claim('971500000001');f.store.set('971500000001',stale);assert.equal(f.service.isHumanOwned('971500000001'),true);f.service.release('971500000001');assert.equal(f.service.isHumanOwned('971500000001'),false);
});
test('claiming a queued or searching conversation pauses cancelled work and release never restarts it',async t=>{
 for(const status of ['queued','searching'])await t.test(status,async()=>{
  const f=setup(),id='971500000001',context={status,queueReady:true,activeComparisonId:'cancelled-comparison',base:{request:{origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11'},awaiting:'passengers'},offers:[{reference:3}],lastQuestion:'كم مسافر؟',pendingRequests:[{text:'طلب ثاني',at:NOW}]};f.store.set(id,context);
  const claimed=await f.service.claim(id);assert.equal(claimed.customer.humanOwned,true);assert.equal(claimed.customer.status,'paused');assert.equal(f.cancels(),1);let state=f.assistant.state(id);assert.equal(state.queueReady,false);assert.equal(state.activeComparisonId,null);assert.deepEqual(state.base,context.base);assert.deepEqual(state.offers,context.offers);assert.equal(state.lastQuestion,context.lastQuestion);assert.deepEqual(state.pendingRequests,context.pendingRequests);assert.equal(f.service.journal.get(id).pausedSearch,true);
  // Simulate the already-running model writing its pre-claim snapshot. The
  // cancellation marker is outside that snapshot and survives a service reload.
  f.store.set(id,context);const reload=new InboxService({store:f.store,assistant:f.assistant,send:async()=>{assert.fail('release must not send or resume work');},now:()=>NOW});assert.equal(reload.isHumanOwned(id),true);const released=reload.release(id);assert.equal(released.customer.humanOwned,false);assert.equal(released.customer.status,'paused');state=f.assistant.state(id);assert.equal(state.queueReady,false);assert.equal(state.activeComparisonId,null);assert.deepEqual(state.base,context.base);assert.deepEqual(state.offers,context.offers);assert.deepEqual(state.pendingRequests,context.pendingRequests);assert.equal(reload.journal.get(id).pausedSearch,undefined);
 });
 const f=setup(),id='971500000001';f.store.set(id,{status:'done',queueReady:false,offers:[]});await f.service.claim(id);assert.equal(f.service.summary(id).status,'done','completed conversations are not mislabelled as cancelled searches');f.service.release(id);assert.equal(f.service.summary(id).status,'done');
});
test('claiming while collecting cannot release a fake search restored by an older model turn',async()=>{
 const f=setup(),id='971500000001',request={origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11'};f.store.set(id,{status:'collecting',base:{request},offers:[],lastQuestion:'كم مسافر؟'});await f.service.claim(id);assert.equal(f.service.summary(id).status,'collecting');assert.equal(f.service.journal.get(id).pausedSearch,undefined);
 f.store.set(id,{status:'queued',queueReady:true,activeComparisonId:'never-enqueued',base:{request},offers:[],lastQuestion:'كم مسافر؟'});const released=f.service.release(id);assert.equal(released.customer.status,'paused');assert.equal(released.customer.humanOwned,false);const state=f.assistant.state(id);assert.equal(state.activeComparisonId,null);assert.equal(state.queueReady,false);assert.deepEqual(state.base.request,request);assert.equal(state.lastQuestion,'كم مسافر؟');assert.equal(f.calls(),0);
 for(const status of ['done','handoff']){f.store.set(id,{status,offers:[]});await f.service.claim(id);f.service.release(id);assert.equal(f.service.summary(id).status,status);}
});
test('interrupted pending send recovers as uncertain; provider rejections are not journaled as sent',async()=>{
 const f=setup();await f.service.claim('971500000001');f.service.journal.get('971500000001').sendAttempts.interrupted={key:'interrupted',fingerprint:'x',state:'sending',at:NOW};const reload=new InboxService({store:f.store,assistant:f.assistant,send:async()=>({}),now:()=>NOW});assert.equal(reload.detail('971500000001').sendAttempts[0].state,'uncertain');
 const g=setup({send:async()=>{throw Error('WHATSAPP_GRAPH_HTTP_400_CODE_1_SUBCODE_0');}});await g.service.claim('971500000001');assert.equal((await g.service.sendMessage('971500000001',{text:'رد',idempotencyKey:'message-001'})).error,'DELIVERY_FAILED');assert.equal(g.service.detail('971500000001').messages.length,1);
});
test('HTTP routes validate scope, ids, method and JSON without exposing internal errors',async()=>{
 const f=setup();async function invoke(path,method='GET',body={}){let status,data;const response={writeHead(code){status=code;return this;},end(text){data=JSON.parse(text);}},handled=await handleInboxRequest({method},response,new URL('https://example.test'+path),async()=>Buffer.from(typeof body==='string'?body:JSON.stringify(body)),f.service);return{handled,status,data};}
 assert.equal((await invoke('/internal/assistant/status')).handled,false);assert.equal((await invoke('/internal/assistant/conversations')).data.items.length,1);assert.equal((await invoke('/internal/assistant/conversations/971500000001')).data.messages.length,1);assert.equal((await invoke('/internal/assistant/conversations/unknown')).status,404);assert.equal((await invoke('/internal/assistant/conversations/971500000001/send','GET')).status,405);assert.equal((await invoke('/internal/assistant/conversations/971500000001/claim','POST','bad JSON')).status,400);assert.equal((await invoke('/internal/assistant/conversations/971500000001/claim','POST')).status,200);assert.equal((await invoke('/internal/assistant/conversations/971500000001/send','POST',{text:'test',idempotencyKey:'message-001'})).status,200);
});
test('detail attaches safe current search and vetted bounded offers without raw supplier payloads',()=>{
 const f=setup({getSearch:id=>({state:'searching',id})}),r={origin:'دبي',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0}};
 f.store.set('971500000001',{status:'searching',offers:[null,{provider:'flycham',reference:2,request:r,checkedAt:NOW,timing:{out:{flight:'XH123',departure:'10:00',arrival:'12:00',debug:'PRIVATE_SUPPLIER_DATA'}},price:{currency:'AED',sellingTotal:'600.00',weights:[{kg:30,debug:'PRIVATE_WEIGHT_DATA'}]},raw:'PRIVATE_RAW_DATA'},{provider:'airarabia',request:r,price:{sellingTotal:'500.00'}}]});
 const d=f.service.detail('971500000001');assert.equal(d.search.state,'searching');assert.equal(d.offers.length,1);assert.equal(d.offers[0].reference,2);assert.equal(d.offers[0].price.sellingTotal,'600.00');assert.equal(d.offers[0].fresh,true);assert.equal(d.offers[0].requiresRecheck,true);assert.doesNotMatch(JSON.stringify(d.offers),/PRIVATE_/);d.offers[0].price.sellingTotal='1.00';assert.equal(f.service.detail('971500000001').offers[0].price.sellingTotal,'600.00');
 f.service.getSearch=()=>{throw Error('PRIVATE_SEARCH_ERROR');};assert.equal(f.service.detail('971500000001').search,null);
});
test('claiming a migrated legacy customer still cannot send without a new real inbound event',async()=>{
 const f=setup();f.service.journal.importLegacy('old',{history:[{role:'user',text:'قديم'}],updatedAt:NOW});await f.service.claim('old');await assert.rejects(f.service.sendMessage('old',{text:'أهلا',idempotencyKey:'legacy-001'}),/WINDOW_CLOSED/);assert.equal(f.calls(),0);
});
