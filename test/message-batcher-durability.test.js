'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MessageBatcher}=require('../src/message-batcher');
const {AssistantState}=require('../src/assistant-state');
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('a slow first Cline turn cannot erase a second flushed durable turn',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-23T10:00:00Z')});
 const store=new AssistantState();let releaseFirst,releaseSecond;const calls=[];
 const b=new MessageBatcher(async(id,m)=>{calls.push(m[0].id);await new Promise(r=>{if(calls.length===1)releaseFirst=r;else releaseSecond=r;});},{store});
 const one=b.push('same',{id:'one',text:'طلب أول'});t.mock.timers.tick(35000);await drain();
 const two=b.push('same',{id:'two',text:'تعديل'});t.mock.timers.tick(35000);await drain();
 assert.deepEqual(store.data.inbox.same.messages.map(m=>m.id),['one','two']);
 releaseFirst();await one;await drain();assert.deepEqual(calls,['one','two']);
 assert.deepEqual(store.data.inbox.same.messages.map(m=>m.id),['two']);
 releaseSecond();await two;assert.deepEqual(store.data.inbox,{});b.close();
});
test('35 second default begins exactly at35000ms and explicit start flushes early',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:0});const calls=[];
 const b=new MessageBatcher(async(id,m)=>calls.push(m.map(x=>x.text)));
 const waiting=b.push('a',{text:'رحلتي'});t.mock.timers.tick(34999);await drain();assert.equal(calls.length,0);
 t.mock.timers.tick(1);await waiting;assert.equal(calls.length,1);
 const urgent=b.push('b',{text:'خلص ابحث'});t.mock.timers.tick(0);await urgent;assert.equal(calls.length,2);b.close();
});
