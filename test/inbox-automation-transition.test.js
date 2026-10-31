'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {InboxService}=require('../src/inbox-http');
const CUSTOMER='15550001991',NOW=Date.parse('2026-10-31T08:00:00Z');
function fixture(hook=()=>{}){
 const events=[],store={data:{customers:{}},save(){events.push('save');},set(id,state){this.data.customers[id]=structuredClone(state);}},assistant={state:id=>structuredClone(store.data.customers[id]||{status:'done',offers:[]})};
 const inbox=new InboxService({store,assistant,send:async()=>assert.fail('no message'),now:()=>NOW,onAutomationTransition:id=>{events.push('revoke');return hook(id,inbox);},onClaim:()=>{events.push('cancel');},changeBlock:async()=>{events.push('provider');return{ok:true};}});
 inbox.journal.recordInbound(CUSTOMER,{id:'synthetic-inbound',text:'اختبار'});events.length=0;return{inbox,store,events};
}
test('staff claim and release synchronously revoke before ownership changes and retain quote cancellation',async()=>{
 let calls=0;const f=fixture((id,inbox)=>{assert.equal(id,CUSTOMER);assert.equal(inbox.isOperatorOwned(id),calls===1);calls++;});
 await f.inbox.claim(CUSTOMER);assert.equal(f.events[0],'revoke');assert(f.events.includes('cancel'));assert.equal(f.inbox.isOperatorOwned(CUSTOMER),true);f.events.length=0;f.inbox.release(CUSTOMER);assert.equal(f.events[0],'revoke');assert.equal(f.inbox.isOperatorOwned(CUSTOMER),false);assert.equal(calls,2);
});
test('assistant block and unblock both revoke before changing automation authority',()=>{
 let calls=0;const f=fixture((id,inbox)=>{assert.equal(inbox.isBlocked(id),calls===1);calls++;});f.inbox.block(CUSTOMER,{confirm:true,reason:'synthetic-review'});assert.equal(f.inbox.isBlocked(CUSTOMER),true);f.inbox.unblock(CUSTOMER,{confirm:true,reason:'synthetic-complete'});assert.equal(f.inbox.isBlocked(CUSTOMER),false);assert.equal(calls,2);
});
test('WhatsApp block and unblock revoke before pending state or any provider action',async()=>{
 let calls=0;const f=fixture((id,inbox)=>{assert.notEqual(inbox.journal.get(id).whatsappBlockState,'pending');calls++;});await f.inbox.block(CUSTOMER,{confirm:true,reason:'synthetic-review',scope:'whatsapp'});await f.inbox.unblock(CUSTOMER,{confirm:true,reason:'synthetic-complete',scope:'whatsapp'});assert.equal(calls,2);assert.equal(f.events.filter(item=>item==='provider').length,2);for(let i=0;i<f.events.length;i++)if(f.events[i]==='provider')assert(f.events.slice(0,i).includes('revoke'));
});
test('unconfirmed persistence or an async hook blocks claim, release and both block scopes',async()=>{
 for(const asyncHook of [false,true])for(const action of ['claim','release','block','unblock','whatsapp-block','whatsapp-unblock']){
  const f=fixture(()=>{if(asyncHook)return Promise.resolve();throw Error('SYNTHETIC_SAVE_UNCONFIRMED');}),before=structuredClone(f.inbox.journal.get(CUSTOMER));
  const invoke=()=>action==='claim'?f.inbox.claim(CUSTOMER):action==='release'?f.inbox.release(CUSTOMER):f.inbox[action.endsWith('unblock')?'unblock':'block'](CUSTOMER,{confirm:true,reason:'synthetic-transition',scope:action.startsWith('whatsapp')?'whatsapp':'assistant'});
  if(action==='claim'||action.startsWith('whatsapp'))await assert.rejects(invoke);else assert.throws(invoke);assert.deepEqual(f.inbox.journal.get(CUSTOMER),before);assert.equal(f.events.includes('provider'),false);assert.equal(f.events.includes('cancel'),false);
 }
});
test('invalid transitions do not revoke consent and an omitted hook preserves prior behavior',async()=>{
 const f=fixture(()=>assert.fail('invalid request cannot revoke'));assert.throws(()=>f.inbox.block(CUSTOMER,{confirm:false,reason:'synthetic'}));assert.throws(()=>f.inbox.release('not-a-customer'));
 const store={data:{customers:{}},save(){},set(id,state){this.data.customers[id]=structuredClone(state);}},inbox=new InboxService({store,assistant:{state:()=>({status:'done'})},send:async()=>({}),now:()=>NOW});inbox.journal.recordInbound(CUSTOMER,{id:'default-inbound',text:'اختبار'});await inbox.claim(CUSTOMER);assert.equal(inbox.isOperatorOwned(CUSTOMER),true);inbox.release(CUSTOMER);assert.equal(inbox.isOperatorOwned(CUSTOMER),false);
});
