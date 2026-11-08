'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MessageBatcher}=require('../src/message-batcher');
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const state=()=>({data:{},save(){}});

for(const queued of [false,true])test(`unprocessed voice transfers once into ${queued?'queued':'pending'} followup and remains restart-safe`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
 const store=state(),turns=[];let firstRelease,secondRelease,carried=false,transferred;
 const b=new MessageBatcher(async(id,messages)=>{
  turns.push(messages.map(message=>message.id));
  if(turns.length===1){
   await new Promise(resolve=>{firstRelease=resolve;});
   const processed=messages.map(message=>({id:message.id,text:'أنا سوري',voiceTranscript:true}));
   carried=b.deferUnprocessed(id,processed,{canMerge:()=>true});
   transferred=structuredClone(store.data);
  }else{assert.equal(messages[0].text,'أنا سوري');assert.equal(messages[0].media,undefined);assert.equal(messages[0].voiceDeferredEarlier,true);await new Promise(resolve=>{secondRelease=resolve;});}
 },{store,delay:100});
 const first=b.push('customer',{id:'first',text:'[مرفق صوتي يحتاج تفريغاً]',media:{type:'audio',id:'101'}});
 t.mock.timers.tick(100);await drain();
 const second=b.push('customer',{id:'second',text:'لحالي'});
 if(queued){t.mock.timers.tick(100);await drain();}
 firstRelease();await first;await drain();
 assert.equal(carried,true);assert.deepEqual(transferred.inbox.customer.messages.map(message=>message.id),['first','second']);
 assert.equal(transferred.inbox.customer.messages[0].text,'[مرفق صوتي يحتاج تفريغاً]');assert.deepEqual(transferred.inbox.customer.messages[0].media,{type:'audio',id:'101'});
 assert.doesNotMatch(JSON.stringify(transferred),/أنا سوري|voiceDeferredEarlier|voiceTranscript/);
 if(!queued){t.mock.timers.tick(100);await drain();}
 assert.deepEqual(turns,[['first'],['first','second']]);
 const restoredStore={data:transferred,save(){}},replayed=[];
 const restored=new MessageBatcher(async(id,messages)=>replayed.push(messages.map(message=>message.id)),{store:restoredStore,delay:100});
 t.mock.timers.tick(100);await drain();
 assert.deepEqual(replayed,[['first','second']]);assert.deepEqual(restoredStore.data.inbox,{});restored.close();
 secondRelease();await second;b.close();assert.deepEqual(store.data.inbox,{});
});

test('incompatible control, absent successor and duplicate IDs cannot transfer an earlier turn',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});const store=state();let release;let attempted=false;
 const b=new MessageBatcher(async(id,messages)=>{
  if(messages[0].id!=='first')return;
  assert.equal(b.deferUnprocessed(id,messages,{canMerge:()=>true}),false,'no future batch');
  await new Promise(resolve=>{release=resolve;});
  const before=structuredClone(store.data.inbox);
  assert.equal(b.deferUnprocessed(id,messages,{canMerge:()=>false}),false,'independent control is not merged');
  assert.equal(b.deferUnprocessed(id,[...messages,...messages],{canMerge:()=>true}),false,'duplicate originals');
  assert.deepEqual(store.data.inbox,before);attempted=true;
 },{store,delay:100});
 const first=b.push('customer',{id:'first',text:'old voice'});t.mock.timers.tick(100);await drain();
 const control=b.push('customer',{id:'second',text:'الخدمات',serviceChoice:{id:'menu',service:'flight'}});t.mock.timers.tick(0);await drain();
 release();await Promise.all([first,control]);assert.equal(attempted,true);assert.deepEqual(store.data.inbox,{});b.close();
});
