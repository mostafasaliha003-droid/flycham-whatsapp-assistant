'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {recordDeliveryStatuses,comparisonDeliverySummary}=require('../src/delivery-status');
const sha=id=>crypto.createHash('sha256').update(id).digest('hex');
const now=Date.parse('2026-10-24T13:20:00Z');
const event=(id,state,offset=0)=>({id:sha(id),state,at:now+offset});
const payload=statuses=>({entry:[{changes:[{field:'messages',value:{statuses}}]}]});
function store(deliveries=[],ids=['final-message']){return{data:{customers:{'private-customer':{history:[{text:'private conversation'}],offerMessages:Object.fromEntries(ids.map(id=>[id,[]]))}},deliveries}};}

test('valid status callbacks are persisted and log only fixed states and numeric error codes',()=>{
 const saved=[],logs=[];
 const statuses=[{id:'private-message-a',status:'sent'},{id:'private-message-a',status:'delivered'},{id:'private-message-a',status:'read'},{id:'private-message-b',status:'failed',recipient_id:'private-phone',errors:[{code:131047,title:'private supplier prose',message:'private secret'},{code:131047},{code:'131026'},{code:-1},{code:10000000},{code:0},{code:1.5}]}];
 recordDeliveryStatuses(payload(statuses),{delivery:(...args)=>saved.push(args)},{log:{log:line=>logs.push(line)}});
 assert.deepEqual(saved,statuses.map(s=>[s.id,s.status]));
 assert.deepEqual(logs,['WHATSAPP_DELIVERY_STATE_SENT','WHATSAPP_DELIVERY_STATE_DELIVERED','WHATSAPP_DELIVERY_STATE_READ','WHATSAPP_DELIVERY_STATE_FAILED_CODE_131047_CODE_0']);
 assert.doesNotMatch(JSON.stringify(logs),/private|131026|10000000/);
});
test('malformed callback containers and unsupported status records are ignored',()=>{
 const saved=[],logs=[],target={delivery:(...args)=>saved.push(args)},options={log:{log:line=>logs.push(line)}};
 for(const p of [null,{}, {entry:{}},{entry:[{changes:{}}]},payload([null,{}, {id:123,status:'sent'}, {id:'',status:'sent'}, {id:'x',status:'pending'}, {id:'x',status:'SENT'}])])recordDeliveryStatuses(p,target,options);
 assert.deepEqual(saved,[]);assert.deepEqual(logs,[]);
});
test('failed event codes are bounded without copying arbitrary error payloads',()=>{
 const logs=[];recordDeliveryStatuses(payload([{id:'m',status:'failed',errors:Array.from({length:12},(_,i)=>({code:i,details:'hidden'}))}]),{delivery:()=>{}},{log:{log:x=>logs.push(x)}});
 assert.equal(logs[0],'WHATSAPP_DELIVERY_STATE_FAILED_CODE_0_CODE_1_CODE_2_CODE_3_CODE_4');
});
test('comparison summary matches hashed IDs and excludes unrelated messages and stale evidence',()=>{
 const s=store([event('final-message','read',-1000),event('ordinary-reply','read',-500),event('old-final','delivered',-900001),event('future-final','sent',1)],['final-message','old-final','future-final']);
 assert.deepEqual(comparisonDeliverySummary(s,{now}),{windowMinutes:15,messages:1,states:{sent:0,delivered:0,read:1,failed:0},latest:{state:'read',atISO:new Date(now-1000).toISOString()}});
 assert.doesNotMatch(JSON.stringify(comparisonDeliverySummary(s,{now})),/private|final-message|ordinary-reply|[a-f0-9]{64}/);
});
test('out-of-order sent or failed callbacks never erase a read or delivered receipt',()=>{
 const s=store([event('final-message','read',-5000),event('final-message','sent',-1000),event('final-message','failed',-500),event('second-final','delivered',-3000),event('second-final','sent',-100)],['final-message','second-final']);
 assert.deepEqual(comparisonDeliverySummary(s,{now}),{windowMinutes:15,messages:2,states:{sent:0,delivered:1,read:1,failed:0},latest:{state:'delivered',atISO:new Date(now-3000).toISOString()}});
});
test('a failure without delivered/read evidence remains visible even if sent arrives later',()=>{
 const s=store([event('final-message','failed',-3000),event('final-message','sent',-1000)]);
 const result=comparisonDeliverySummary(s,{now});assert.equal(result.states.failed,1);assert.equal(result.states.sent,0);assert.equal(result.latest.atISO,new Date(now-3000).toISOString());
});
test('duplicate receipts count one message and retain the latest strongest evidence time',()=>{
 const s=store([event('final-message','delivered',-5000),event('final-message','read',-4000),event('final-message','read',-2000),event('final-message','delivered',-500)]);
 const result=comparisonDeliverySummary(s,{now});assert.equal(result.messages,1);assert.equal(result.states.read,1);assert.equal(result.latest.atISO,new Date(now-2000).toISOString());
});
test('invalid timestamps and malformed states never enter the delivery summary',()=>{
 const s=store([event('final-message','unknown',-1),...['2026-10-24',NaN,Infinity,null,8640000000000001].map(at=>({...event('final-message','read'),at}))]);
 assert.deepEqual(comparisonDeliverySummary(s,{now}),{windowMinutes:15,messages:0,states:{sent:0,delivered:0,read:0,failed:0},latest:null});
 assert.equal(comparisonDeliverySummary(store([event('final-message','read')]),{now:NaN}).messages,0);
});
test('custom windows include the exact lower boundary and handle missing store data',()=>{
 const s=store([event('final-message','sent',-60000)]);assert.equal(comparisonDeliverySummary(s,{now,windowMs:60000}).messages,1);assert.equal(comparisonDeliverySummary(s,{now,windowMs:59999}).messages,0);
 assert.equal(comparisonDeliverySummary(null,{now}).latest,null);
});
