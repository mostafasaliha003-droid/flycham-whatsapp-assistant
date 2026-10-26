'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MessageBatcher}=require('../src/message-batcher');
const {routeService,noteIncoming}=require('../src/service-routing');
const {createServiceMenuSender}=require('../src/service-menu-delivery');
function setup(){const store={data:{},save(){}},sent=[],journaled=[];let human=false;const sender=createServiceMenuSender({store,inbox:{isHumanOwned:()=>human},send:async(to,payload)=>{sent.push({to,payload});return{messages:[{id:'synthetic-menu'}]};},journal:{hasCustomer:()=>true,recordOutbound:(to,payload)=>journaled.push({to,payload})}});return{store,sent,journaled,sender,setHuman:value=>{human=value;}};}
test('menu completes while a price delivery waits for a pending inbound batch to settle',async()=>{
 const {store,sent,sender}=setup(),id='synthetic-a';noteIncoming(store,id);const route=routeService(store,id,'الخدمات');
 const batcher=new MessageBatcher(()=>sender(id,route,1),{delay:10000});
 try{const incoming=batcher.push(id,{text:'الخدمات'}),priceDelivery=batcher.settled(id);await batcher.flush(id);await Promise.race([Promise.all([incoming,priceDelivery]),new Promise((_,reject)=>setTimeout(()=>reject(Error('menu blocked inbound settlement')),500))]);assert.equal(sent.length,1);assert.equal(batcher.busy(id),false);}finally{batcher.close();}
});
test('menu delivery suppresses stale revisions, stale menus and staff-owned customers; journals one accepted send',async()=>{
 const s=setup(),id='synthetic-a';noteIncoming(s.store,id);const old=routeService(s.store,id,'مرحبا'),current=routeService(s.store,id,'الخدمات');
 await s.sender(id,old,1);await s.sender(id,current,0);s.setHuman(true);await s.sender(id,current,1);assert.equal(s.sent.length,0);s.setHuman(false);await s.sender(id,current,1);assert.equal(s.sent.length,1);assert.equal(s.journaled.length,1);assert.equal(s.journaled[0].payload.id,'synthetic-menu');
});
