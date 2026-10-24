'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DeliveryOutbox,failureKind}=require('../src/delivery-outbox');
function store(){return {data:{},saves:0,save(){this.saves++;}};}
const draft=(key='comparison-1')=>({key,recipient:'private-customer',chunks:['first','second'],metadata:{comparisonId:'opaque-id',final:true}});
const sent=id=>({messages:[{id}]});
test('comparison becomes complete only after all chunks accepted, enqueue is idempotent',async()=>{
 const s=store(),calls=[],chunks=[],complete=[];
 const box=new DeliveryOutbox({store:s,send:async(to,text)=>{calls.push(text);assert.equal(complete.length,0);return sent('m'+calls.length);},onChunkSent:async(item,index,chunk)=>chunks.push([index,chunk.messageId]),onComplete:async item=>complete.push(item.state)});
 box.enqueue(draft());box.enqueue(draft());assert.equal(s.data.outbox.length,1);assert.throws(()=>box.enqueue({...draft(),chunks:['different']}),/KEY_CONFLICT/);
 assert.equal((await box.flush('comparison-1')).state,'sent');assert.deepEqual(calls,['first','second']);assert.deepEqual(chunks,[[0,'m1'],[1,'m2']]);assert.deepEqual(complete,['sent']);
 await box.flush('comparison-1');assert.equal(calls.length,2);assert.equal(complete.length,1);assert.deepEqual(box.due(),[]);assert.equal(box.stats().sent,1);assert.ok(!JSON.stringify(box.stats()).includes('private-customer'));
});
test('HTTP 429 backs off and resumes next chunk without repeating accepted first chunk',async()=>{
 let now=10000,n=0;const s=store(),calls=[];
 const send=async(to,text)=>{calls.push(text);if(++n===2)throw Error('WHATSAPP_GRAPH_HTTP_429_CODE_130429_SUBCODE_0');return sent('m'+n);};
 let box=new DeliveryOutbox({store:s,send,now:()=>now});box.enqueue(draft());let state=await box.flush('comparison-1');assert.equal(state.state,'pending');assert.equal(state.chunks[0].state,'sent');assert.equal(state.nextAt,12000);assert.deepEqual(box.due(),[]);
 box=new DeliveryOutbox({store:s,send,now:()=>now});await box.flush('comparison-1');assert.equal(calls.length,2);now=12000;assert.deepEqual(box.due(),['comparison-1']);state=await box.flush('comparison-1');assert.equal(state.state,'sent');assert.deepEqual(calls,['first','second','second']);
});
test('timeout and 5xx are uncertain, never auto-resend',async()=>{
 for(const error of [Error('fetch failed'),Object.assign(Error('timeout'),{name:'TimeoutError'}),Error('WHATSAPP_GRAPH_HTTP_500_CODE_0_SUBCODE_0')]){
  const s=store();let n=0,now=1000;const send=async()=>{n++;throw error;};let box=new DeliveryOutbox({store:s,send,now:()=>now});box.enqueue(draft());assert.equal((await box.flush('comparison-1')).state,'uncertain');now+=600000;box=new DeliveryOutbox({store:s,send,now:()=>now});assert.deepEqual(box.due(),[]);await box.flush('comparison-1');assert.equal(n,1);
 }
});
test('restart during send preserves uncertain state and does not resend',async()=>{
 const s=store();let count=0;const box=new DeliveryOutbox({store:s,send:async()=>{count++;return sent('unused');}});box.enqueue(draft());s.data.outbox[0].state='sending';s.data.outbox[0].chunks[0].state='sending';
 const restarted=new DeliveryOutbox({store:s,send:async()=>{count++;return sent('unused');}});assert.equal(restarted.get('comparison-1').state,'uncertain');assert.deepEqual(restarted.due(),[]);await restarted.flush('comparison-1');assert.equal(count,0);
});
test('auth rejection is terminal and rate limiting has a bounded retry count',async()=>{
 let now=0;for(const status of [401,403,400]){
  const box=new DeliveryOutbox({store:store(),send:async()=>{throw Error(`WHATSAPP_GRAPH_HTTP_${status}_CODE_0_SUBCODE_0`);},now:()=>now});box.enqueue(draft());assert.equal((await box.flush('comparison-1')).state,'failed');assert.deepEqual(box.due(),[]);
 }
 let calls=0;const box=new DeliveryOutbox({store:store(),send:async()=>{calls++;throw Error('WHATSAPP_GRAPH_HTTP_429_CODE_0_SUBCODE_0');},now:()=>now,maxAttempts:2});box.enqueue(draft());await box.flush('comparison-1');now=2000;assert.equal((await box.flush('comparison-1')).state,'failed');now=100000;await box.flush('comparison-1');assert.equal(calls,2);
});
test('chunk notification failure resumes callback without resending accepted message',async()=>{
 let now=0,n=0,notified=0;const s=store();const box=new DeliveryOutbox({store:s,now:()=>now,send:async()=>sent('m'+(++n)),onChunkSent:async()=>{if(++notified===1)throw Error('store temporarily unavailable');}});box.enqueue(draft());assert.equal((await box.flush('comparison-1')).state,'pending');assert.equal(n,1);now=5000;assert.equal((await box.flush('comparison-1')).state,'sent');assert.equal(n,2);assert.equal(notified,3);
});
test('completion callback failure survives restart and never sends accepted chunks again',async()=>{
 let now=0,n=0,complete=0;const s=store(),send=async()=>sent('m'+(++n));let box=new DeliveryOutbox({store:s,send,now:()=>now,onComplete:async()=>{complete++;throw Error('callback temporary failure');}});box.enqueue(draft());let state=await box.flush('comparison-1');assert.equal(state.state,'sent');assert.equal(state.completionNotified,false);assert.equal(n,2);now=5000;box=new DeliveryOutbox({store:s,send,now:()=>now,onComplete:async()=>{complete++;}});assert.deepEqual(box.due(),['comparison-1']);state=await box.flush('comparison-1');assert.equal(state.completionNotified,true);assert.equal(n,2);assert.equal(complete,2);
});
test('superseded comparison stops after accepted first chunk, recipient sends remain serialized',async()=>{
 let valid=true,n=0;const box=new DeliveryOutbox({store:store(),send:async()=>{n++;valid=false;return sent('m'+n);},isCurrent:async()=>valid});box.enqueue(draft());assert.equal((await box.flush('comparison-1')).state,'cancelled');assert.equal(n,1);
 let active=0,max=0;const serial=new DeliveryOutbox({store:store(),send:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return sent('m');}});serial.enqueue(draft('one'));serial.enqueue(draft('two'));await Promise.all([serial.flush('one'),serial.flush('two'),serial.flush('one')]);assert.equal(max,1);
});
test('retention removes old completed items but retains unresolved uncertain and pending items',async()=>{
 let now=0;const box=new DeliveryOutbox({store:store(),send:async()=>sent('m'),now:()=>now,retentionMs:100,maxItems:3});box.enqueue(draft('done'));await box.flush('done');box.enqueue(draft('cancel'));box.cancel('cancel');box.enqueue(draft('pending'));now=200;box.prune();assert.equal(box.get('done'),undefined);assert.equal(box.get('cancel'),undefined);assert.ok(box.get('pending'));box.get('pending').state='uncertain';now=1000;box.prune();assert.ok(box.get('pending'));
});
test('malformed successful response is uncertain, never interpreted as delivery',async()=>{
 const box=new DeliveryOutbox({store:store(),send:async()=>({ok:true})});box.enqueue(draft());const state=await box.flush('comparison-1');assert.equal(state.state,'uncertain');assert.equal(state.completionNotified,false);assert.equal(failureKind(Error('WHATSAPP_GRAPH_HTTP_408_CODE_0_SUBCODE_0')).kind,'uncertain');
});
test('completed receipts do not permanently fill capacity reserved for pending sends',async()=>{const s={data:{},save(){}};const box=new DeliveryOutbox({store:s,maxItems:1,send:async()=>({messages:[{id:'sent'}]})});box.enqueue({key:'first',recipient:'c',chunks:['first']});await box.flush('first');assert.doesNotThrow(()=>box.enqueue({key:'second',recipient:'c',chunks:['second']}));assert.equal(box.get('first'),undefined);assert.equal(box.get('second').state,'pending');});
