'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {VisaStaffQuestions}=require('../src/visa-staff-questions');
const {visaCaseSignature}=require('../src/visa-case-signature');
function fixture(send){
 let claimed=true,block='HUMAN_OWNERSHIP',open=true,sends=0;
 const customer='15550001001',c={id:'case-example',applicantCount:1,applicants:[{name:'Example'}],revision:3};
 const job={id:'job-example',customer,caseId:c.id,caseSignature:visaCaseSignature(c),revision:7,state:'portal_review_required',applicantIndex:0,approvalId:'approval-example',confirmedFields:{previousNationality:false,health:{accidentDisability:false}}};
 const store={data:{visaCases:{[customer]:c},visaPortalRuns:{},visaFulfilment:{jobs:{[job.id]:job},cases:{[customer]:{approvals:{[job.approvalId]:{}}}},outbox:{}}},save(){}};
 const fulfilment={store,job:id=>{assert.equal(id,job.id);return job;},case:id=>{assert.equal(id,customer);return c;},data:()=>store.data.visaFulfilment,approvalCurrent:()=>true,blocked:()=>block,
 send:send||(async(to,payload,guard)=>{guard();assert.equal(to,customer);sends++;return {messages:[{id:'synthetic-message-'+sends}]};})};
 const inbox={isOperatorOwned:()=>claimed},journal={summary:()=>({serviceWindowOpen:open})};
 const service=new VisaStaffQuestions({fulfilment,store,inbox,journal,now:()=>1000});
 const request=(field='performUmrah',patch={})=>service.request(customer,{jobId:job.id,field,expectedRevision:job.revision,expectedCaseSignature:job.caseSignature,idempotencyKey:'attempt-example-'+field,...patch});
 return {customer,c,job,store,fulfilment,inbox,journal,service,request,sends:()=>sends,claim:v=>{claimed=v;},block:v=>{block=v;},window:v=>{open=v;}};
}
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);
test('one native choice is accepted without restarting or modifying the portal job',async()=>{
 const f=fixture();const before=structuredClone(f.job);const s=await f.request();assert.equal(s.state,'accepted');assert.deepEqual(f.job,before);
 assert.equal(s.question.type,'choice');assert.equal(s.question.options.length,2);assert.equal(f.sends(),1);
 await rejects(f.request('transport'),'STAFF_QUESTION_BUSY');
 assert.equal(f.service.handleCustomerMessage(f.customer,{id:'answer-1',visaAnswer:{token:s.token,option:'no'}}).ok,true);
 assert.equal(f.job.state,'portal_review_required');assert.equal(f.sends(),1);
 assert.equal(f.service.view(f.customer,f.job.id).collected[0].value,false);
 await f.request('transport');assert.equal(f.sends(),2);
});
test('duplicate idempotency never sends twice, conflicts and confirmed answers fail',async()=>{
 const f=fixture();const s=await f.request();assert.equal((await f.request()).id,s.id);assert.equal(f.sends(),1);
 await rejects(f.request('transport',{idempotencyKey:'attempt-example-performUmrah'}),'VISA_IDEMPOTENCY_CONFLICT');
 const g=fixture();await rejects(g.request('previousNationality'),'STAFF_QUESTION_ALREADY_ANSWERED');
 await rejects(g.request('health.accidentDisability',{idempotencyKey:'health-example'}),'STAFF_QUESTION_ALREADY_ANSWERED');assert.equal(g.sends(),0);
});
test('uncertain provider outcome and process restart cannot produce another send',async()=>{
 const f=fixture(async()=>{throw Error('timeout');});const s=await f.request();assert.equal(s.state,'uncertain');
 assert.equal((await f.request()).state,'uncertain');await rejects(f.request('entryDate'),'STAFF_QUESTION_BUSY');
 s.state='sending';f.store.data.visaStaffQuestions.sessions[s.id]=s;
 const resumed=new VisaStaffQuestions(f);assert.equal(resumed.data()[s.id].state,'uncertain');
});
test('wrong sender, stale job and invalid choices cannot mutate answers',async()=>{
 const f=fixture();const s=await f.request();
 assert.equal(f.service.handleCustomerMessage('15550001002',{visaAnswer:{token:s.token,option:'yes'}}).ok,false);
 assert.equal(f.service.handleCustomerMessage(f.customer,{visaAnswer:{token:s.token,option:'unknown'}}).ok,false);
 f.job.revision++;assert.equal(f.service.handleCustomerMessage(f.customer,{visaAnswer:{token:s.token,option:'yes'}}).ok,false);
 assert.equal(f.service.data()[s.id].state,'accepted');assert.equal(f.job.confirmedFields.performUmrah,undefined);
});
test('free text validates real dates and does not auto-send the next question',async()=>{
 const f=fixture();const s=await f.request('entryDate');
 assert.equal(f.service.handleCustomerMessage(f.customer,{id:'text-1',text:'2026-02-30'}).ok,false);
 assert.equal(f.service.handleCustomerMessage(f.customer,{id:'text-2',text:'2026-11-20',contextId:s.messageId}).ok,true);
 assert.equal(f.sends(),1);assert.equal(f.job.state,'portal_review_required');assert.equal(f.job.confirmedFields.entryDate,undefined);
});
test('closed window, ownership loss, complaint, case change and active portal block dispatch',async()=>{
 for(const mutate of [f=>f.window(false),f=>f.claim(false),f=>f.block('COMPLAINT_ACTIVE'),f=>{f.c.applicantCount=2;},f=>{f.store.data.visaPortalRuns[f.job.id]={phase:'waiting_otp'};}]){const f=fixture();mutate(f);await assert.rejects(f.request());assert.equal(f.sends(),0);}
});
test('automatic pending questions block manual collection and unknown answers remain unknown',async()=>{
 const f=fixture();f.store.data.visaFulfilment.outbox.x={customer:f.customer,kind:'applicant_question',state:'uncertain'};
 await rejects(f.request(),'STAFF_QUESTION_AUTOMATIC_PENDING');assert.equal(f.sends(),0);
 const g=fixture();await g.request('entryDate');assert.equal(g.service.handleCustomerMessage(g.customer,{text:'غير مؤكد'}).ok,false);
 assert.equal(g.service.view(g.customer,g.job.id).busy,true);
});
test('arrival choices use the three directly observed portal modes',async()=>{
 const f=fixture();const s=await f.request('transport');assert.deepEqual(s.question.options.map(o=>o.label),['جوًا','برًا','بحرًا']);
 assert.equal(f.service.handleCustomerMessage(f.customer,{id:'answer-mode',visaAnswer:{token:s.token,option:'air'}}).ok,true);
 assert.equal(f.service.view(f.customer,f.job.id).collected[0].value,'air');
});

test('a collected other-port choice unlocks only its current-job detail and preserves ready state',async()=>{
 const f=fixture();f.job.state='ready';assert.equal(f.service.view(f.customer,f.job.id).questions.some(q=>q.field==='arrivalPortDetails'),false);
 const s=await f.request('arrivalPort');assert.equal(f.service.handleCustomerMessage(f.customer,{id:'other-port-answer',visaAnswer:{token:s.token,option:'other'}}).ok,true);
 assert.equal(f.service.view(f.customer,f.job.id).questions.some(q=>q.field==='arrivalPortDetails'),true);
 const detail=await f.request('arrivalPortDetails');assert.equal(detail.state,'accepted');
 assert.equal(f.service.handleCustomerMessage(f.customer,{id:'other-port-detail',text:'Synthetic verified port'}).ok,true);assert.equal(f.job.state,'ready');
});
test('a stale collected controller cannot authorize another job revision detail',async()=>{
 const f=fixture();const s=await f.request('arrivalPort');f.service.handleCustomerMessage(f.customer,{id:'controller-answer',visaAnswer:{token:s.token,option:'other'}});f.job.revision++;
 await assert.rejects(f.request('arrivalPortDetails'),e=>e.code==='STAFF_QUESTION_DEPENDENCY_REQUIRED');assert.equal(f.sends(),1);
});
