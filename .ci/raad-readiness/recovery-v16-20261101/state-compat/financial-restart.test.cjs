'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const {verifyApprovedSource}=require('./verify-source.cjs');
const approved=verifyApprovedSource({source:process.env.INTEGRATION_LAB_SOURCE,freeze:process.env.INTEGRATION_LAB_FREEZE});
const appRequire=createRequire(path.join(approved.source,'package.json'));
const {AssistantState}=appRequire('./src/assistant-state');
const {InboxService}=appRequire('./src/inbox-http');
const {VisaFulfilment}=appRequire('./src/visa-fulfilment');
const {VisaPortalDispatcher}=appRequire('./src/visa-portal-dispatcher');
const {visaCaseSignature}=appRequire('./src/visa-case-signature');
const {provisionDurableMrzBudgetOffline}=appRequire('./src/visa-mrz-durable-budget');
const {MRZ_PRODUCTION_POLICY_FINGERPRINT:POLICY}=appRequire('./src/visa-mrz-profiles');
const NOW=Date.parse('2026-11-01T12:00:00Z'),KEY='synthetic-state-compat-recovery-key-not-real';
const ROOT=process.env.STATE_COMPAT_FIXTURES,PHASE=process.env.STATE_COMPAT_PHASE;
assert(ROOT&&path.isAbsolute(ROOT)&&['seed','recover'].includes(PHASE));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const kinds=['accepted','sending','pending_otp','consuming_otp'];
const customer=i=>'1555000200'+i;
function fixture(i){const directory=path.join(ROOT,kinds[i]);return{directory,state:path.join(directory,'assistant.enc'),ledger:path.join(directory,'visa-mrz-budget.enc'),control:path.join(directory,'controls.json')};}
function pair(p){return{ledger:sha(fs.readFileSync(p.ledger)),anchor:sha(fs.readFileSync(p.ledger+'.anchor'))};}
function open(p){const store=new AssistantState({file:p.state,key:KEY,now:()=>NOW});let finance=0,sends=0;
 const assistant={state:id=>structuredClone(store.data.customers[id]||{status:'collecting',humanOwned:false,offers:[]})};
 const inbox=new InboxService({store,assistant,now:()=>NOW,send:async()=>assert.fail('staff send forbidden')});
 const update=inbox.updateVisa.bind(inbox);inbox.updateVisa=(...args)=>{finance++;return update(...args);};
 const mediaStore={get(id,{customer}){const m=store.data.visaMedia?.[id];assert(m&&m.customer===customer);return structuredClone(m);}};
 const service=new VisaFulfilment({store,inbox,mediaStore,canAutomate:()=>true,now:()=>NOW,env:{RAAD_OTP_OWNER_WHATSAPP:'971507993145',RAAD_MRZ_PRODUCTION_ENABLED:'false'},send:async(_to,_payload,guard)=>{guard();sends++;return{messages:[{id:'synthetic-accepted-'+sends}]};}});
 return{store,inbox,service,mediaStore,stats:()=>({finance,sends})};
}
function input(r,c,receipt){return{receiptId:receipt,amount:240,reference:'SYNTHETIC-STATE-COMPAT',actor:{id:'synthetic-accountant',role:'accountant'},actualReceived:true,confirm:true,expectedCaseSignature:visaCaseSignature(r.store.data.visaCases[c]),idempotencyKey:'synthetic-state-compat-approval'};}
for(let i=0;i<kinds.length;i++)test(PHASE+' '+kinds[i]+' encrypted payment and interrupted state',async()=>{
 const p=fixture(i),c=customer(i),kind=kinds[i];
 if(PHASE==='seed'){
  fs.mkdirSync(p.directory,{recursive:true,mode:0o700});assert(!fs.existsSync(p.state));
  const r=open(p),receipt='45000000-0000-4000-8000-'+String(i).padStart(12,'0');
  r.store.data.visaCases||={};r.store.data.visaCases[c]={id:'synthetic-state-case-'+i,revision:1,createdAt:NOW,updatedAt:NOW,policyVersion:'synthetic-only',applicantCount:1,applicants:[{nationality:'مصر',latinFirstName:'SYNTHETIC',latinFamilyName:'EXAMPLE'}],quote:{total:240,currency:'AED'},documents:[],paymentStatus:'awaiting_verification',submissionStatus:'not_submitted'};
  r.store.data.visaMedia||={};r.store.data.visaMedia[receipt]={id:receipt,customer:c,mimeType:'image/png',size:100,checksum:'a'.repeat(64),receivedAt:NOW,expiresAt:NOW+86400000};r.store.save();
  r.inbox.journal.recordInbound(c,{id:'synthetic-inbound-'+i,text:'طلب صناعي للاختبار',timestamp:NOW});await r.inbox.claim(c);
  r.service.receiveReceipt(c,{receiptId:receipt});const approved=r.service.confirmPayment(c,input(r,c,receipt));r.inbox.release(c);const job=approved.jobs[0];
  assert.equal(r.stats().finance,1);assert.equal(Object.keys(r.service.data().jobs).length,1);
  if(kind==='sending'){r.service.data().outbox[job.paymentNoticeId].state='sending';r.service.data().outbox[job.paymentNoticeId].attempts=1;}
  else {assert.equal((await r.service.dispatchMessage(job.paymentNoticeId)).state,'accepted');assert.equal(r.stats().sends,1);}
  let otp=null;
  if(kind.endsWith('_otp')){
   const acquired=r.service.acquireJob(job.id,{workerId:'synthetic-state-worker'});
   otp=r.service.requestOtp(job.id,{leaseToken:acquired.lease.token,portalChallengeId:'synthetic-challenge-'+i,contextId:'synthetic-context-'+i,challengeRequestedAt:NOW,challengeExpiresAt:NOW+300000,accountBinding:'b'.repeat(64)});
   if(kind==='consuming_otp')r.service.data().challenges[otp.challengeId].state='consuming';
   r.store.data.visaPortalRuns={[job.id]:{phase:'waiting_otp',leaseToken:acquired.lease.token}};
  }
  r.store.save();assert.notEqual(fs.readFileSync(p.state).subarray(0,1).toString(),'{');
  provisionDurableMrzBudgetOffline({file:p.ledger,key:r.store.key,policyFingerprint:POLICY,capUsd:1.2,persistentStateConfirmed:true,ownerApproved:true,historyReconciled:true,historyEvidenceSha256:sha(Buffer.from('synthetic-only-offline-history')),historicalSpentUsd:0.96});
  const control={kind,customer:c,receipt,approvalId:approved.approval.id,jobId:job.id,noticeId:job.paymentNoticeId,challengeId:otp?.challengeId||null,payment:r.store.data.visaCases[c].staffVerification.payment,paymentAuditCount:r.store.data.visaCases[c].staffVerification.audit.filter(a=>a.action==='confirm_payment').length,pair:pair(p)};
  fs.writeFileSync(p.control,JSON.stringify(control),{mode:0o600,flush:true});
  assert.equal(control.paymentAuditCount,1);assert.equal(Object.keys(r.service.data().challenges).length,otp?1:0);
 }else{
  const ctrl=JSON.parse(fs.readFileSync(p.control)),before=pair(p),r=open(p);
  assert.deepEqual(before,ctrl.pair);assert.equal(r.store.data.visaCases[c].paymentStatus,'verified');assert.deepEqual(r.store.data.visaCases[c].staffVerification.payment,ctrl.payment);
  const result=r.service.confirmPayment(c,input(r,c,ctrl.receipt));assert(result.duplicate);assert.equal(result.approval.id,ctrl.approvalId);assert.equal(result.jobs[0].id,ctrl.jobId);assert.equal(r.stats().finance,0);assert.equal(Object.keys(r.service.data().jobs).length,1);
  const notice=r.service.data().outbox[ctrl.noticeId];assert.equal(notice.kind,'payment_confirmation');
  if(kind==='accepted'){assert.equal(notice.state,'accepted');assert.equal((await r.service.dispatchMessage(ctrl.noticeId)).state,'accepted');assert.equal(r.stats().sends,0);assert.equal(r.service.job(ctrl.jobId).state,'queued');}
  if(kind==='sending'){assert.equal(notice.state,'uncertain');assert.equal(notice.failure,'PROCESS_INTERRUPTED');assert.equal((await r.service.dispatchMessage(ctrl.noticeId)).state,'uncertain');assert.equal(r.stats().sends,0);assert.throws(()=>r.service.acquireJob(ctrl.jobId,{workerId:'synthetic-restart-worker'}),{code:'VISA_PAYMENT_NOTICE_UNCONFIRMED'});}
  if(kind.endsWith('_otp')){
   assert.equal(r.service.data().lease,null);assert.equal(r.service.job(ctrl.jobId).state,'portal_review_required');assert.equal(r.service.job(ctrl.jobId).blockedReason,'BROWSER_INTERRUPTED');assert.equal(r.service.data().challenges[ctrl.challengeId].state,'interrupted');
   assert.throws(()=>r.service.acquireJob(ctrl.jobId,{workerId:'synthetic-restart-worker'}),{code:'VISA_JOB_STALE'});
   let cancels=0,otherCalls=0;
   const dispatcher=new VisaPortalDispatcher({fulfilment:r.service,raad:{},mediaStore:r.mediaStore,store:r.store,now:()=>NOW,startupGraceMs:0,env:{RAAD_VISA_AUTOMATION_ENABLED:'true',RAAD_BROWSER_WORKER_URL:'https://synthetic.invalid/',RAAD_JOB_BRIDGE_KEY:'synthetic-state-bridge-key-never-sent-0000'},fetchImpl:async(url,init)=>{
    if(url==='https://synthetic.invalid/internal/raad/jobs/'+ctrl.jobId+'/cancel'&&init.method==='POST'){cancels++;return{ok:true,json:async()=>({stage:'cancelled',ownedBrowserClosed:true})};}otherCalls++;assert.fail('fresh start/resume/external bridge forbidden');
   }});
   await dispatcher.tick();await dispatcher.tick();assert.equal(cancels,1);assert.equal(otherCalls,0);assert.equal(r.stats().sends,0);assert.equal(r.store.data.visaPortalRuns[ctrl.jobId].phase,'interrupted');
  }
  assert.equal(r.store.data.visaCases[c].staffVerification.audit.filter(a=>a.action==='confirm_payment').length,1);assert.equal(Object.values(r.service.data().outbox).filter(m=>m.kind==='payment_confirmation').length,1);assert.deepEqual(pair(p),before);
  const resultPath=path.join(p.directory,'verified-result.json');fs.writeFileSync(resultPath,JSON.stringify({kind,setupFinanceActions:ctrl.paymentAuditCount,recoveryFinanceActions:r.stats().finance,recoverySends:r.stats().sends,paymentAndJobIdentityPreserved:true,budgetPairUnchanged:true,otpValueEverSupplied:false,syntheticOnly:true}),{mode:0o600,flush:true});
 }
});
test.after(()=>verifyApprovedSource({source:approved.source,freeze:approved.freeze}));
