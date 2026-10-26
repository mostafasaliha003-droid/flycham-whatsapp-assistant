'use strict';
process.env.SAUDI_VISA_COMPLAINT_RECIPIENT='971500000005';
const test=require('node:test'),assert=require('node:assert/strict');
const {ComplaintHandoff,COMPLAINT_RECIPIENT}=require('../src/complaint-handoff');
const {InboxService}=require('../src/inbox-http');
const ID='971500000001',NOW=Date.parse('2026-10-27T04:00:00Z');
function fixture(sendNotification,changeBlock){
 const store={data:{customers:{}},save(){},set(id,s){this.data.customers[id]=structuredClone(s);}},assistant={state:id=>structuredClone(store.data.customers[id]||{status:'idle',offers:[]})};
 const inbox=new InboxService({store,assistant,now:()=>NOW,changeBlock,send:async(id,text,guard)=>{guard();return{messages:[{id:'staff-send'}]};}});inbox.journal.recordInbound(ID,{id:'inbound',text:'شكوى',timestamp:NOW});inbox.complaints.sendNotification=sendNotification;return{store,assistant,inbox,complaints:inbox.complaints};
}
test('complaint creates one durable priority handoff and pauses AI without granting staff ownership',async()=>{
 const f=fixture(),a=f.complaints.create(ID,{caseId:'visa-1',summary:'PASSPORT_SECRET'}),b=f.complaints.create(ID,{caseId:'visa-1'});
 assert.equal(a.id,b.id);assert.equal(f.store.data.complaints.length,1);assert.equal(f.inbox.isHumanOwned(ID),true);assert.equal(f.inbox.summary(ID).staffClaimed,false);assert.equal(f.inbox.summary(ID).complaint.state,'pending');assert.equal(f.inbox.list({status:'complaint'}).items.length,1);assert.doesNotMatch(JSON.stringify(a),/PASSPORT_SECRET/);
 await assert.rejects(f.inbox.sendMessage(ID,{text:'staff',idempotencyKey:'staff-1234'}),/CLAIM_REQUIRED/);
 await f.inbox.claim(ID);assert.equal(f.complaints.active(ID).state,'claimed');assert.equal(f.inbox.summary(ID).staffClaimed,true);f.inbox.release(ID);assert.equal(f.inbox.isHumanOwned(ID),false);assert.equal(f.complaints.active(ID),null);assert.equal(f.complaints.latest(ID).state,'resolved');
});
test('pending complaint survives legacy state overwrite and reload',()=>{
 const f=fixture();f.complaints.create(ID);f.store.set(ID,{humanOwned:false,status:'idle'});const reload=new InboxService({store:f.store,assistant:f.assistant,now:()=>NOW,send:async()=>assert.fail()});assert.equal(reload.isHumanOwned(ID),true);assert.equal(reload.summary(ID).staffClaimed,false);
});
test('notification requires valid service window or approved template; accepted is not claimed',async()=>{
 let calls=0,payload;const f=fixture(async p=>{calls++;payload=p;return{messages:[{id:'notification-1'}]};}),c=f.complaints.create(ID);
 assert.equal((await f.complaints.flush(c.id)).error,'TEMPLATE_OR_SERVICE_WINDOW_REQUIRED');assert.equal(calls,0);
 assert.deepEqual(await f.complaints.flush(c.id,{templateConfigured:true}),{ok:true,state:'accepted'});assert.equal(payload.recipient,COMPLAINT_RECIPIENT);assert.equal(payload.requiresTemplate,true);assert.equal(f.complaints.active(ID).state,'pending');await f.complaints.flush(c.id,{templateConfigured:true});assert.equal(calls,1);
});
test('ambiguous notification result never automatically resends, also after restart',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('PRIVATE_TRANSPORT');}),c=f.complaints.create(ID);assert.equal((await f.complaints.flush(c.id,{serviceWindowOpen:true})).state,'uncertain');await f.complaints.flush(c.id,{serviceWindowOpen:true});const reload=new ComplaintHandoff({store:f.store,now:()=>NOW,sendNotification:async()=>{calls++;}});await reload.flush(c.id,{serviceWindowOpen:true});assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(f.store.data.complaints),/PRIVATE_TRANSPORT/);
});
test('notification in progress at restart becomes uncertain and failed HTTP is not marked sent',async()=>{
 const f=fixture(async()=>{throw Object.assign(Error('REJECTED'),{status:400});}),c=f.complaints.create(ID);assert.equal((await f.complaints.flush(c.id,{serviceWindowOpen:true})).state,'failed');f.complaints.records[0].notification.state='sending';new ComplaintHandoff({store:f.store,now:()=>NOW});assert.equal(f.complaints.records[0].notification.state,'uncertain');
});
test('concurrent notification flushes share one send',async()=>{
 let done,calls=0;const held=new Promise(r=>done=r),f=fixture(async()=>{calls++;await held;return{messages:[{id:'once'}]};}),c=f.complaints.create(ID);const a=f.complaints.flush(c.id,{serviceWindowOpen:true}),b=f.complaints.flush(c.id,{serviceWindowOpen:true});done();await Promise.all([a,b]);assert.equal(calls,1);
});
test('manual local pause requires reason and confirmation, never deletes case or implies native WhatsApp block',async()=>{
 const f=fixture();f.store.data.visaCases={[ID]:{id:'visa',quote:{total:700}}};assert.throws(()=>f.inbox.block(ID,{reason:'test'}),/BLOCK_CONFIRMATION_REQUIRED/);assert.throws(()=>f.inbox.block(ID,{confirm:true,reason:''}),/INVALID_BLOCK_REASON/);f.inbox.block(ID,{confirm:true,reason:'إساءة'});assert.equal(f.inbox.isHumanOwned(ID),true);assert.equal(f.inbox.summary(ID).whatsappBlocked,false);assert.equal(f.inbox.list({status:'blocked'}).items.length,1);await f.inbox.claim(ID);await assert.rejects(f.inbox.sendMessage(ID,{text:'test',idempotencyKey:'blocked-123'}),/NUMBER_BLOCKED/);f.inbox.unblock(ID,{confirm:true,reason:'مراجعة'});assert.ok(f.store.data.visaCases[ID]);assert.equal(f.inbox.isOperatorOwned(ID),true);
});
test('native block confirms only proven callback success and suppresses AI while pending',async()=>{
 let done;const held=new Promise(r=>done=r),f=fixture(null,async()=>{await held;return{ok:true};});const work=f.inbox.block(ID,{confirm:true,reason:'إساءة',scope:'whatsapp'});assert.equal(f.inbox.isHumanOwned(ID),true);assert.equal(f.inbox.summary(ID).whatsappBlocked,false);done();assert.equal((await work).scope,'whatsapp');assert.equal(f.inbox.summary(ID).whatsappBlocked,true);await f.inbox.unblock(ID,{confirm:true,reason:'مراجعة',scope:'whatsapp'});assert.equal(f.inbox.isBlocked(ID),false);
 const g=fixture(null,async()=>({ok:false,dryRun:true}));await assert.rejects(g.inbox.block(ID,{confirm:true,reason:'test',scope:'whatsapp'}),/WHATSAPP_BLOCK_FAILED/);assert.equal(g.inbox.summary(ID).whatsappBlocked,false);assert.equal(g.inbox.summary(ID).whatsappBlockState,'failed');
});
test('visa updates require actual staff claim, exact quoted amount and evidence references',async()=>{
 const f=fixture();f.store.data.visaCases={[ID]:{id:'visa',revision:1,quote:{total:700},paymentStatus:'unverified',submissionStatus:'not_submitted'}};f.complaints.create(ID);
 assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'confirm_payment',amount:700,reference:'bank-ref'}),/CLAIM_REQUIRED/);await f.inbox.claim(ID);
 assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'confirm_payment',amount:1,reference:'bank-ref'}),/INVALID_PAYMENT/);
 assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'confirm_payment',amount:700}),/REFERENCE_REQUIRED/);
 f.inbox.updateVisa(ID,{confirm:true,action:'confirm_payment',amount:700,reference:'bank-ref'});
 assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'application-1'}),/INVALID_VISA_ACTION/);
 f.inbox.updateVisa(ID,{confirm:true,action:'documents_reviewed',approved:true});f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'application-1'});f.inbox.updateVisa(ID,{confirm:true,action:'decision',decision:'refused',reference:'decision-1'});
 const c=f.inbox.detail(ID).visaCase;assert.equal(c.paymentStatus,'verified');assert.equal(c.submissionStatus,'submitted');assert.equal(c.stage,'refused');assert.equal(c.revision,5);assert.equal(c.staffVerification.audit.length,4);assert.equal(f.inbox.list({service:'saudi_visa'}).items.length,1);
});
test('ambiguous native block remains paused across restart and cannot be repeated blindly',async()=>{
 let calls=0;const f=fixture(null,async()=>{calls++;throw Error('WHATSAPP_BLOCK_OUTCOME_UNCERTAIN');});
 await assert.rejects(f.inbox.block(ID,{confirm:true,reason:'test',scope:'whatsapp'}),/WHATSAPP_BLOCK_UNCERTAIN/);assert.equal(f.inbox.summary(ID).whatsappBlocked,false);assert.equal(f.inbox.summary(ID).whatsappBlockState,'uncertain');assert.equal(f.inbox.isHumanOwned(ID),true);
 const reload=new InboxService({store:f.store,assistant:f.assistant,now:()=>NOW,changeBlock:async()=>{calls++;return{ok:true};},send:async()=>assert.fail()});
 await assert.rejects(reload.unblock(ID,{confirm:true,reason:'test',scope:'whatsapp'}),/WHATSAPP_BLOCK_UNCERTAIN/);assert.equal(calls,1);assert.equal(reload.isHumanOwned(ID),true);
 const g=fixture(null,async()=>{throw Object.assign(Error('HTTP_REJECTED'),{status:400});});await assert.rejects(g.inbox.block(ID,{confirm:true,reason:'test',scope:'whatsapp'}),/WHATSAPP_BLOCK_FAILED/);assert.equal(g.inbox.summary(ID).whatsappBlockState,'failed');assert.equal(g.inbox.isHumanOwned(ID),false);
});
test('notification receipts distinguish acceptance, delivery and reading without claiming or unsafe retries',async()=>{
 const f=fixture(async()=>({messages:[{id:'meta-notice'}]})),c=f.complaints.create(ID);await f.complaints.flush(c.id,{serviceWindowOpen:true});
 assert.equal(f.complaints.status(ID).notificationState,'accepted');assert.throws(()=>f.complaints.requestRetry(c.id),/NOTIFICATION_RETRY_UNSAFE/);
 assert.equal(f.complaints.handleReceipt({id:'meta-notice',status:'delivered',recipient_id:'different'}),false);
 assert.equal(f.complaints.handleReceipt({id:'meta-notice',status:'delivered',recipient_id:COMPLAINT_RECIPIENT,timestamp:NOW/1000}),true);assert.equal(f.complaints.status(ID).notificationState,'delivered');assert.equal(f.complaints.active(ID).state,'pending');assert.equal(f.inbox.summary(ID).staffClaimed,false);
 assert.equal(f.complaints.handleReceipt({id:'meta-notice',status:'sent'}),false);assert.equal(f.complaints.handleReceipt({id:'meta-notice',status:'failed'}),false);f.complaints.handleReceipt({id:'meta-notice',status:'read'});assert.equal(f.complaints.status(ID).notificationState,'read');assert.throws(()=>f.complaints.requestRetry(c.id),/NOTIFICATION_RETRY_UNSAFE/);
});
test('only explicit confirmed retry of definite failure or pending configuration can send again',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;if(calls===1)throw Object.assign(Error('reject'),{status:400});return{messages:[{id:'retry-success'}]};}),c=f.complaints.create(ID);
 await f.complaints.flush(c.id,{serviceWindowOpen:true});assert.throws(()=>f.inbox.retryComplaintNotification(ID),/RETRY_CONFIRMATION_REQUIRED/);assert.equal(calls,1);f.inbox.retryComplaintNotification(ID,{confirm:true});await f.complaints.flush(c.id,{serviceWindowOpen:true});assert.equal(calls,2);
 const g=fixture(async()=>{throw Error('network');}),other=g.complaints.create(ID);await g.complaints.flush(other.id,{serviceWindowOpen:true});assert.throws(()=>g.inbox.retryComplaintNotification(ID,{confirm:true}),/NOTIFICATION_RETRY_UNSAFE/);
});
test('staff evidence cannot validate a changed person, amount or document set',async()=>{
 const f=fixture();f.store.data.visaCases={[ID]:{id:'visa',revision:1,applicantCount:1,applicants:[{nationality:'سوريا'}],documents:[{id:'doc-1'}],quote:{total:700},paymentStatus:'unverified',submissionStatus:'not_submitted'}};await f.inbox.claim(ID);f.inbox.updateVisa(ID,{confirm:true,action:'confirm_payment',amount:700,reference:'payment'});f.inbox.updateVisa(ID,{confirm:true,action:'documents_reviewed',approved:true});
 const c=f.store.data.visaCases[ID],original=structuredClone(c);c.applicants[0].nationality='مصر';assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'apply'}),/INVALID_VISA_ACTION/);
 Object.assign(c,structuredClone(original));c.quote.total=1950;assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'apply'}),/INVALID_VISA_ACTION/);
 Object.assign(c,structuredClone(original));c.documents.push({id:'doc-2'});assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'apply'}),/INVALID_VISA_ACTION/);
 Object.assign(c,structuredClone(original));f.inbox.updateVisa(ID,{confirm:true,action:'submitted',reference:'apply'});c.applicantCount=3;assert.throws(()=>f.inbox.updateVisa(ID,{confirm:true,action:'decision',decision:'approved',reference:'decision'}),/INVALID_VISA_ACTION/);
});
