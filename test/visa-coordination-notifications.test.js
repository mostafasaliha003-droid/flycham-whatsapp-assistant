'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VisaCoordinationNotifications}=require('../src/visa-coordination-notifications');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {OWNER}=require('../src/remal-service-policy');
const CUSTOMER='971500000001';
function fixture(){let at=1000000,calls=[];const c={id:'12345678-1234-4321-abcd-123456789abc',applicants:[],operatorIntervention:{reason:'payment_link',at}};const store={data:{visaCases:{[CUSTOMER]:c}},save(){}};const f={data:()=>({jobs:{}}),pendingMessages:()=>[],requeuePausedMessages:to=>{assert.equal(to,OWNER);}};let reply={paused:true,noticeMessageId:'meta-notice'};const n=new VisaCoordinationNotifications({store,fulfilment:f,now:()=>at,send:async(input,guard)=>{guard();calls.push(input);return reply;}});return{c,store,n,calls,f,setReply:r=>reply=r,tick:ms=>at+=ms};}
test('owner requests use a durable case-bound template handoff and reject other senders, wrong context and replay',async()=>{const x=fixture();await x.n.flush();assert.equal(x.calls.length,1);const i=Object.values(x.n.items())[0];assert.equal(i.state,'waiting_owner');assert.equal(x.calls[0].recipient,OWNER);assert.match(x.calls[0].text,/5%/);await x.n.flush();assert.equal(x.calls.length,1);
 for(const m of [{from:CUSTOMER,contextId:'meta-notice'},{from:OWNER,contextId:'wrong'}])assert.equal((await x.n.receive({...m,visaCoordinationAction:{noticeId:i.id}})).ok,false);
 x.setReply({messages:[{id:'owner-details'}]});assert.equal((await x.n.receive({from:OWNER,contextId:'meta-notice',visaCoordinationAction:{noticeId:i.id}})).ok,true);assert.equal(i.state,'accepted');await x.n.flush();assert.equal(x.calls.length,2);
 assert.equal((await x.n.receive({from:OWNER,contextId:'meta-notice',visaCoordinationAction:{noticeId:i.id}})).ok,false);
});
test('stale cases and uncertain deliveries cannot be replayed as new owner alerts',async()=>{const x=fixture();x.setReply({});await x.n.flush();assert.equal(Object.values(x.n.items())[0].state,'uncertain');await x.n.flush();assert.equal(x.calls.length,1);x.c.id='new-case';assert.equal(x.n.current(Object.values(x.n.items())[0]),false);});
test('one operational question points at its actual customer and expires after the answer',async()=>{const x=fixture();delete x.c.operatorIntervention;const job={id:'12345678-1234-4321-abcd-123456789abd',customer:CUSTOMER,caseId:x.c.id,caseSignature:visaCaseSignature(x.c),state:'awaiting_answers',coordination:{recipient:OWNER},questions:{q:{token:'q',state:'pending'}}};x.f.data=()=>({jobs:{j:job,[job.id]:job}});x.setReply({windowOpen:true});await x.n.flush();assert.equal(x.calls.length,1);assert.equal(x.calls[0].questionOnly,true);assert.match(x.calls[0].text,new RegExp(CUSTOMER));job.questions.q.state='answered';assert.equal(x.n.current(Object.values(x.n.items())[0]),false);});
test('technical blockage notices name the phase, give the correct action and deep link to the exact case; resolved blockers cancel pending notices',async()=>{
 const x=fixture();delete x.c.operatorIntervention;const job={id:'12345678-1234-4321-abcd-123456789abd',customer:CUSTOMER,caseId:x.c.id,caseSignature:visaCaseSignature(x.c),coordination:{actor:'operator',recipient:OWNER},state:'portal_review_required',blockedReason:'PORTAL_BUTTON_VALIDATION_FAILED',portalStage:'health',applicationReference:'E12345678'};x.f.data=()=>({jobs:{[job.id]:job}});
 x.setReply({messages:[{id:'accepted-blocker'}]});await x.n.flush();assert.equal(x.calls.length,1);const text=x.calls[0].text;assert.match(text,/الإفصاح الصحي/);assert.match(text,/لا توجد بيانات ناقصة/);const url=new URL(text.split('\n').at(-1));assert.equal(url.searchParams.get('customer'),CUSTOMER);assert.equal(url.searchParams.get('case'),job.caseId);assert.equal(url.searchParams.get('job'),job.id);assert.equal(url.searchParams.get('view'),'visas');const item=Object.values(x.n.items())[0];assert.equal(x.n.current(item),true);job.blockedReason=null;job.state='running';assert.equal(x.n.current(item),false);
});

test('understanding alerts bind to a real conversation without a visa case and deduplicate overlapping recordings',async()=>{
 const x=fixture();delete x.store.data.visaCases[CUSTOMER];
 x.n.reviewCurrent=id=>id===CUSTOMER;
 x.n.reviewLink=id=>'https://example.test/operations?customer='+id;
 assert.equal(x.n.queueUnderstanding(CUSTOMER,'voice_unresolved',['audio-a','audio-b']),true);
 assert.equal(x.n.queueUnderstanding(CUSTOMER,'voice_unresolved',['audio-b','audio-a']),false);
 assert.equal(x.n.queueUnderstanding(CUSTOMER,'voice_unresolved',['audio-b','audio-c']),true);
 assert.equal(x.n.queueUnderstanding(OWNER,'voice_unresolved',['audio-d']),false);
 assert.equal(x.n.queueUnderstanding(CUSTOMER,'unsupported_kind',['audio-d']),false);
 assert.equal(JSON.stringify(x.n.items()).includes('audio-a'),false);
 await x.n.flush();assert.equal(x.calls.length,2);
 const first=Object.values(x.n.items())[0];
 assert.equal(first.state,'waiting_owner');
 assert.equal(x.calls[0].recipient,OWNER);assert.equal(x.calls[0].jobId,first.id);
 assert.match(x.calls[0].text,/تسجيل صوتي.*استلام المحادثة/s);
 assert.equal(new URL(x.calls[0].text.split('\n').at(-1)).searchParams.get('customer'),CUSTOMER);
 assert.doesNotMatch(x.calls[0].text,/audio-a|audio-b|مرجع الملف/);
 x.setReply({messages:[{id:'details'}]});
 const action={from:OWNER,contextId:'meta-notice',visaCoordinationAction:{noticeId:first.id}};
 assert.equal((await x.n.receive({...action,contextId:'wrong'})).ok,false);
 assert.equal((await x.n.receive(action)).ok,true);assert.equal(first.state,'accepted');
 assert.equal((await x.n.receive(action)).ok,false);assert.equal(x.calls.length,3);
});

test('a staff-owned or deleted conversation cancels queued review and a classified text failure does not send a legacy duplicate',async()=>{
 const x=fixture();let active=true;
 x.n.reviewCurrent=id=>active&&id===CUSTOMER;
 x.n.reviewLink=id=>'https://example.test/operations?customer='+id;
 x.c.operatorIntervention={reason:'untrained_request',understandingFailed:true,at:1000000};
 assert.equal(x.n.queueUnderstanding(CUSTOMER,'reply_unresolved',['incoming-1']),true);
 active=false;await x.n.flush();
 assert.equal(x.calls.length,0);
 const records=Object.values(x.n.items());assert.equal(records.length,1);assert.equal(records[0].state,'cancelled');
});
