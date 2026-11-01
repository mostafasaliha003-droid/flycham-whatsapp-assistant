'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {VisaFulfilment}=require('../src/visa-fulfilment');
const {visaCaseSignature}=require('../src/visa-case-signature');
const CUSTOMER='15550001001',OWNER='971507993145',OTHER='15550001002';
const RECEIPT='4bcb3aaa-67be-405b-854e-ebc4f962bc00',PDF='c444dc53-ab4e-4f46-9e6a-4f080ab1d742';
function fixture({send, resumeOtp, count = 2, canAutomate} = {}) {
  let at = 1000000, claimed = true, saves = 0, paymentCalls = 0, sends = 0;
  const c = {id: 'case-example', revision: 3, policyVersion: 'example', applicantCount: count, applicants: Array.from({length: count}, (_, index) => ({nationality: 'مصر', latinFirstName: index ? 'Bela' : 'Ari', latinFamilyName: 'Example'})), quote: {total: 240, currency: 'AED'}, documents: [], paymentStatus: 'awaiting_verification', submissionStatus: 'not_submitted'};
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {[RECEIPT]: {id: RECEIPT, customer: CUSTOMER, mimeType: 'image/png', size: 120, checksum: 'a'.repeat(64), expiresAt: at + 10000000}, [PDF]: {id: PDF, customer: CUSTOMER, mimeType: 'application/pdf', size: 450, checksum: 'b'.repeat(64), expiresAt: at + 10000000}}, conversationJournal: {customers: {[CUSTOMER]: {}}}, complaints: []}, save() { saves++; }};
  const mediaStore = {get(id, {customer}) { const record = store.data.visaMedia[id]; if (!record || customer !== record.customer) throw Error('NOT_FOUND'); return structuredClone(record); }};
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false, updateVisa(customer, input) {
    assert.equal(customer, CUSTOMER); assert.equal(input.action, 'confirm_payment'); paymentCalls++;
    c.staffVerification ||= {}; c.staffVerification.payment = {amount: input.amount, reference: input.reference, actor: 'staff', verifiedAt: at, caseSignature: visaCaseSignature(c)};
    c.paymentStatus = 'verified'; c.revision++; store.save();
  }};
  const drafts = new Map(), applied = [];
  const raad = {get(customer, {applicantIndex}) { assert.equal(customer, CUSTOMER); return structuredClone(drafts.get(applicantIndex) || {revision: 0, fields: {}}); }, prepare(customer, input) { assert.equal(customer, CUSTOMER); const old = drafts.get(input.applicantIndex) || {revision: 0, fields: {}}; assert.equal(input.expectedRevision, old.revision); const next = {revision: old.revision + 1, fields: {...old.fields, ...structuredClone(input.fields)}}; drafts.set(input.applicantIndex, next); applied.push(structuredClone(input)); return next; }};
  const options = {store, inbox, mediaStore, raad, now: () => at, env: {RAAD_OTP_OWNER_WHATSAPP: '+' + OWNER}, canAutomate, send: send || (async (recipient, payload, guard) => { guard(); sends++; return {messages: [{id: 'outbound-' + sends}]}; }), resumeOtp};
  const service = new VisaFulfilment(options);
  const input = (patch = {}) => ({receiptId: RECEIPT, amount: 240, reference: 'BANK-EXAMPLE-8', actor: {id: 'accountant-example', role: 'accountant'}, actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(c), idempotencyKey: 'accountant-key-1', ...patch});
  const receive = () => service.receiveReceipt(CUSTOMER, {receiptId: RECEIPT});
  const approve = () => { receive(); return service.confirmPayment(CUSTOMER, input()); };
  const activate = async () => { const approval = approve(); claimed = false; await service.dispatchMessage(approval.jobs[0].paymentNoticeId); return approval; };
  return {service, options, store, c, inbox, mediaStore, input, receive, approve, activate, drafts, applied, tick: ms => { at += ms; }, claim: value => { claimed = value; }, stats: () => ({saves, paymentCalls, sends})};
}
const nativeBinding = (f, delay=0) => ({portalChallengeId:'native-request-1',contextId:'native-request-1',challengeRequestedAt:f.options.now()-delay,challengeExpiresAt:f.options.now()-delay+300000,accountBinding:'a'.repeat(64)});
async function waiting({resumeOtp,send,delay=0,dispatch=true}={}){
 const f=fixture({resumeOtp,send}),approved=await f.activate(),work=f.service.acquireJob(approved.jobs[0].id,{workerId:'synthetic-worker'}),binding=nativeBinding(f,delay);
 const request=f.service.requestOtp(work.job.id,{leaseToken:work.lease.token,...binding});
 const notification=dispatch?await f.service.dispatchMessage(request.messageId):null;
 return {...f,work,binding,request,notification,challenge:()=>f.service.data().challenges[request.challengeId],reply:(code='453291',extra={})=>({sender:OWNER,contextId:notification?.messageId,messageId:'synthetic-inbound-1',text:code,...extra})};
}
test('delayed polling and prompt preserve the original native expiry without a new five-minute interval',async()=>{
 let calls=0;const f=await waiting({delay:240000,dispatch:false,resumeOtp:async()=>{calls++;return {accepted:true};}});
 assert.equal(f.request.expiresAt,f.binding.challengeExpiresAt);assert.equal(f.challenge().challengeRequestedAt,f.binding.challengeRequestedAt);
 const message=f.service.data().outbox[f.request.messageId];assert.ok(message.payload.text.includes(new Date(f.binding.challengeExpiresAt).toISOString()));
 f.tick(60000);const result=await f.service.dispatchMessage(message.id);assert.equal(result.state,'cancelled');assert.equal(f.stats().sends,1);assert.equal(calls,0);
});
test('missing, future, expired or overlong native windows fail instead of manufacturing a fresh TTL',async()=>{
 for(const patch of [{challengeRequestedAt:undefined},{challengeExpiresAt:undefined},{accountBinding:undefined},{challengeRequestedAt:1000001},{challengeExpiresAt:1000000},{challengeExpiresAt:1300001},{accountBinding:'not-an-account'}]){
  const f=fixture(),approved=await f.activate(),work=f.service.acquireJob(approved.jobs[0].id,{workerId:'invalid-window'});
  assert.throws(()=>f.service.requestOtp(work.job.id,{leaseToken:work.lease.token,...nativeBinding(f),ttlMs:300000,...patch}),e=>e.code==='SUPERVISOR_SMS_CHALLENGE_STALE');
  assert.equal(Object.keys(f.service.data().challenges).length,0);
 }
});
test('owner input needs exact accepted reply and inbound ID; wrong sender known replies are intercepted and scrubbed',async()=>{
 let calls=0;const f=await waiting({resumeOtp:async()=>{calls++;return {accepted:true};}});
 for(const [patch,reason]of [[{contextId:undefined},'OTP_REPLY_CONTEXT_REQUIRED'],[{messageId:undefined},'OTP_MESSAGE_ID_INVALID'],[{sender:OTHER},'OTP_SENDER_INVALID'],[{sender:'966591182035'},'OTP_SENDER_INVALID'],[{contextId:'unrelated'},'OTP_NOT_PENDING']]){
  const input=f.reply('453291',patch);assert.equal(f.service.isOtpMessage(input),true);const r=await f.service.consumeOtp(input);assert.equal(r.reason,reason);assert.equal(input.text,'');
 }
 assert.equal(calls,0);
});
test('a conflicting or removed recipient configuration never authorizes a different sender or journals supervisor digits',async()=>{
 for(const env of [{},{RAAD_OTP_OWNER_WHATSAPP:OTHER},{RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_OTP_OWNER_RECIPIENT:OTHER}]){
  const f=await waiting({resumeOtp:async()=>{throw Error('must not call');}});f.service.env=env;const input=f.reply();assert.equal(f.service.otpOwner(),null);assert.equal(f.service.isOtpMessage(input),true);assert.equal((await f.service.consumeOtp(input)).reason,'OTP_SENDER_INVALID');assert.equal(input.text,'');
 }
});
test('a valid code is transient, bound to account/request/expiry, and handed off at most once',async()=>{
 let received,captured,calls=0;const f=await waiting({resumeOtp:async input=>{calls++;input.guard();received=input.code;captured=input;return {accepted:true,privateEcho:input.code};}});
 const input=f.reply(),out=await f.service.consumeOtp(input);assert.equal(out.ok,true);assert.equal(received,'453291');assert.equal(captured.code,'');assert.equal(input.text,'');
 assert.equal(captured.accountBinding,f.binding.accountBinding);assert.equal(captured.challengeExpiresAt,f.binding.challengeExpiresAt);assert.equal(captured.challengeRequestedAt,f.binding.challengeRequestedAt);
 assert.equal((await f.service.consumeOtp(f.reply('876543',{messageId:'second-inbound'}))).ok,false);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(f.store.data),/453291|876543|privateEcho/);
});
test('explicit rejection and thrown adapter errors exhaust a challenge instead of allowing another code',async()=>{
 for(const throws of [false,true]){let calls=0;const f=await waiting({resumeOtp:async({code})=>{calls++;if(throws)throw Error('secret '+code);return {accepted:false};}});
  const out=await f.service.consumeOtp(f.reply());assert.equal(out.reason,throws?'OTP_RESUME_UNCERTAIN':'OTP_REJECTED');
  assert.equal((await f.service.consumeOtp(f.reply('876543',{messageId:'different-message'}))).ok,false);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(f.store.data),/453291|876543|secret/);
 }
});
test('exact expiry during an awaited adapter guard prevents dispatch and never revives the challenge',async()=>{
 let release,started,dispatched=0;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
 const f=await waiting({delay:299000,resumeOtp:async input=>{started();await gate;input.guard();dispatched++;return {accepted:true};}});
 const input=f.reply(),pending=f.service.consumeOtp(input);await entered;f.tick(1000);release();const out=await pending;
 assert.equal(out.reason,'OTP_RESUME_UNCERTAIN');assert.equal(dispatched,0);assert.equal(input.text,'');assert.equal(f.challenge().state,'uncertain');
});
test('account, challenge, applicant and delivery binding mutations after an await stop the original handoff',async()=>{
 for(const kind of ['account','portal','expiry','applicant','delivery','owner']){
  let release,started,dispatched=0;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await waiting({resumeOtp:async input=>{started();await gate;input.guard();dispatched++;return {accepted:true};}});
  const pending=f.service.consumeOtp(f.reply());await entered;
  if(kind==='account')f.challenge().accountBinding='b'.repeat(64);if(kind==='portal')f.challenge().portalChallengeId='changed-request';if(kind==='expiry')f.challenge().challengeExpiresAt++;
  if(kind==='applicant')f.service.job(f.work.job.id).applicantIndex++;if(kind==='delivery')f.service.data().outbox[f.request.messageId].state='failed';if(kind==='owner')f.service.env.RAAD_OTP_OWNER_WHATSAPP=OTHER;
  release();assert.equal((await pending).ok,false);assert.equal(dispatched,0);
 }
});
test('reservation survives persistence rollback without dispatch or a second-code retry',async()=>{
 let calls=0;const f=await waiting({resumeOtp:async()=>{calls++;return {accepted:true};}}),save=f.store.save;
 f.store.save=()=>{throw Error('private persistence failure');};assert.equal((await f.service.consumeOtp(f.reply())).reason,'OTP_RESUME_UNCERTAIN');
 f.store.save=save;assert.equal((await f.service.consumeOtp(f.reply('876543',{messageId:'after-save-recovery'}))).ok,false);assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(f.store.data),/453291|876543|private persistence/);
});
test('a consumed native challenge cannot be reissued under a new coordinator challenge',async()=>{
 const f=await waiting({resumeOtp:async()=>({accepted:true})});await f.service.consumeOtp(f.reply());assert.throws(()=>f.service.requestOtp(f.work.job.id,{leaseToken:f.work.lease.token,...f.binding}),e=>e.code==='VISA_OTP_ALREADY_REQUESTED');
});
test('Arabic digits normalize only within an exact digit-only reply and never get persisted',async()=>{
 let received;const f=await waiting({resumeOtp:async input=>{received=input.code;return {accepted:true};}});
 const prose=f.reply('رمز ٤٥٣٢٩١');assert.equal((await f.service.consumeOtp(prose)).reason,'OTP_FORMAT_INVALID');assert.equal(prose.text,'');
 const input=f.reply('٤٥٣٢٩١',{messageId:'arabic-code'});assert.equal((await f.service.consumeOtp(input)).ok,true);assert.equal(received,'453291');assert.equal(input.text,'');assert.doesNotMatch(JSON.stringify(f.store.data),/453291|٤٥٣٢٩١/);
});
test('provider message replay and code replay cannot be transplanted to a new native challenge',async()=>{
 let calls=0;const f=await waiting({resumeOtp:async()=>{calls++;return {accepted:true};}});assert.equal((await f.service.consumeOtp(f.reply())).ok,true);
 const request=f.service.requestOtp(f.work.job.id,{leaseToken:f.work.lease.token,...nativeBinding(f),portalChallengeId:'native-request-2',contextId:'native-request-2'}),notification=await f.service.dispatchMessage(request.messageId);
 assert.equal((await f.service.consumeOtp(f.reply('876543',{contextId:notification.messageId}))).reason,'OTP_MESSAGE_REPLAY_REJECTED');
 assert.equal((await f.service.consumeOtp(f.reply('453291',{contextId:notification.messageId,messageId:'new-inbound'}))).reason,'OTP_REPLAY_REJECTED');
 assert.equal((await f.service.consumeOtp(f.reply('876543',{contextId:notification.messageId,messageId:'different-inbound'}))).ok,true);assert.equal(calls,2);
 assert.doesNotMatch(JSON.stringify(f.store.data),/453291|876543/);
});
test('in-flight prompt or notice acceptance never rebinds to a replacement challenge',async()=>{
 for(const notice of [false,true]){
  let release,started,ownerSends=0;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await waiting({dispatch:false,send:async(_to,_payload,guard,meta)=>{guard();if(meta.kind!=='owner_otp_request')return {messageId:'payment-accepted'};ownerSends++;started();await gate;return notice?{paused:true,reason:'owner_action_required',noticeMessageId:'stale-notice-acceptance'}:{messageId:'stale-prompt-acceptance'};}});
  const pending=f.service.dispatchMessage(f.request.messageId);await entered;
  const replacement={...f.challenge(),id:'replacement-challenge',portalChallengeId:'replacement-native-request',accountBinding:'b'.repeat(64)};f.service.data().challenges[replacement.id]=replacement;
  f.service.data().outbox[f.request.messageId].challengeId=replacement.id;release();const out=await pending;
  assert.equal(out.state,'uncertain');assert.equal(out.failure,'DELIVERY_OUTCOME_UNCERTAIN');assert.equal(out.messageId,undefined);assert.equal(out.noticeMessageId,undefined);
  assert.equal(replacement.messageId,undefined);assert.equal(replacement.noticeMessageId,undefined);assert.equal(f.challenge().state,'uncertain');
  assert.equal(f.service.requeuePausedMessages(OWNER).requeued,0);assert.equal(f.service.requeueApprovedNotifications({ownerTemplateApproved:true}).requeued,0);await f.service.dispatchMessage(f.request.messageId);assert.equal(ownerSends,1);
 }
});
test('every immutable destination/job/lease/native binding is checked after an awaited send',async()=>{
 for(const kind of ['recipient','job','lease','requested','expires','account','payload']){
  let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await waiting({dispatch:false,send:async(_to,_payload,guard,meta)=>{guard();if(meta.kind!=='owner_otp_request')return {messageId:'payment-accepted'};started();await gate;return {messageId:'must-not-correlate'};}});
  const pending=f.service.dispatchMessage(f.request.messageId);await entered;const item=f.service.data().outbox[f.request.messageId];
  if(kind==='recipient')item.recipient=OTHER;if(kind==='job')f.service.job(f.work.job.id).applicantIndex++;if(kind==='lease')f.service.data().lease.token='replacement-lease-token';
  if(kind==='requested')f.challenge().challengeRequestedAt--;if(kind==='expires'){f.challenge().expiresAt++;f.challenge().challengeExpiresAt++;}if(kind==='account')f.challenge().accountBinding='b'.repeat(64);if(kind==='payload')item.payload.text='changed prompt';
  release();const out=await pending;assert.equal(out.state,'uncertain');assert.equal(out.messageId,undefined);assert.equal(f.challenge().messageId,undefined);
 }
});
test('unchanged identity preserves real prompt/notice acceptance arriving after original expiry without permitting OTP',async()=>{
 for(const notice of [false,true]){
  let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await waiting({delay:299000,dispatch:false,resumeOtp:async()=>{throw Error('expired native action');},send:async(_to,_payload,guard,meta)=>{guard();if(meta.kind!=='owner_otp_request')return {messageId:'payment-accepted'};started();await gate;return notice?{paused:true,reason:'owner_action_required',noticeMessageId:'late-notice'}:{messageId:'late-prompt'};}});
  const pending=f.service.dispatchMessage(f.request.messageId);await entered;f.tick(1000);release();const out=await pending;
  assert.equal(out.state,notice?'cancelled':'accepted');assert.equal(notice?out.noticeMessageId:out.messageId,notice?'late-notice':'late-prompt');
  assert.equal(notice?f.challenge().noticeMessageId:f.challenge().messageId,notice?'late-notice':'late-prompt');
  const result=await f.service.consumeOtp({sender:OWNER,contextId:notice?'late-notice':'late-prompt',messageId:'late-reply',text:'453291'});assert.equal(result.ok,false);assert.equal(f.service.requeuePausedMessages(OWNER).requeued,0);
 }
});
