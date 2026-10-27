'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {postPaymentQuestion}=require('../src/raad-post-payment-questionnaire');
const {guardMessage}=require('../src/raad-questionnaire-inbound-guard');

function fixture(){
 const customer='971500000001', token='a'.repeat(32),visaCase={id:'case-test',policyVersion:'p',applicantCount:1,applicants:[{nationality:'SYR'}],quote:{total:700},documents:[],paymentStatus:'verified'};
 const sig=visaCaseSignature(visaCase);visaCase.staffVerification={payment:{caseSignature:sig,amount:700}};
 const draft={jobId:'draft-test',revision:3,state:'draft',caseId:visaCase.id,caseSignature:sig,applicantIndex:0,fields:{saudiDeportationOrEntryBan:false,priorGccDeportation:false,maritalStatus:'single',previousNationality:false,travelledLastFiveYears:false,performUmrah:false}};
 const choices=postPaymentQuestion({visaCase,draft,applicantIndex:0}).question.choices;
 const choicesDigest=createHash('sha256').update(JSON.stringify(choices)).digest('hex');
 const session={customer,state:'awaiting_reply',token,caseId:visaCase.id,caseSignature:sig,jobId:draft.jobId,revision:3,applicantIndex:0,questionKey:'health.hospitalizedOrEmergency',questionMessageId:'wamid.question',choicesDigest,expiresAt:1000};
 const message={from:customer,id:'wamid.reply',context:{id:'wamid.question'},type:'interactive',interactive:{type:'button_reply',button_reply:{id:'rq1:'+token+':0',title:'private answer'}}};
 return {visaCase,draft,session,message,encryptedDurable:true,now:100};
}
test('valid health option is accepted only through encrypted atomic commit with no input returned',async()=>{
 const x=fixture(),records=[];const result=await guardMessage({...x,commit:async value=>{records.push(value);return 'saved';}});
 assert.deepEqual(result,{action:'accepted',duplicate:false});assert.equal(records.length,1);
 assert.equal(records[0].questionKey,'health.hospitalizedOrEmergency');assert.equal(records[0].value,'yes');
 assert.ok(!JSON.stringify(result).includes('private answer'));assert.ok(!JSON.stringify(records).includes('private answer'));
});
test('valid list reply works and atomic dedupe prevents repeat handling',async()=>{
 const x=fixture(),seen=new Set();x.message.interactive={type:'list_reply',list_reply:{id:'rq1:'+x.session.token+':1'}};
 const commit=async value=>{if(seen.has(value.messageId))return 'duplicate';seen.add(value.messageId);return 'saved';};
 assert.deepEqual(await guardMessage({...x,commit}),{action:'accepted',duplicate:false});
 assert.deepEqual(await guardMessage({...x,commit}),{action:'accepted',duplicate:true});
});
test('uncertain is not a health fact and the committer can record a stale race safely',async()=>{
 const x=fixture();x.message.interactive.button_reply.id='rq1:'+x.session.token+':2';let record;
 assert.equal((await guardMessage({...x,commit:async v=>{record=v;return 'saved';}})).action,'accepted');
 assert.equal(record.kind,'needs_private_review');assert.equal(record.value,'unsure');
 assert.equal(record.caseSignature,x.session.caseSignature);assert.equal(record.token,x.session.token);assert.equal(record.questionMessageId,x.session.questionMessageId);
 assert.deepEqual(await guardMessage({...x,commit:async()=> 'stale_recorded'}),{action:'quarantined',duplicate:false});
});
test('positive Saudi entry-ban answer is routed to private review rather than inferred as deportation',async()=>{
 const x=fixture(); delete x.draft.fields.saudiDeportationOrEntryBan;
 x.session.questionKey='saudiDeportationOrEntryBan';
 const question=postPaymentQuestion({visaCase:x.visaCase,draft:x.draft,applicantIndex:0}).question;
 x.session.choicesDigest=createHash('sha256').update(JSON.stringify(question.choices)).digest('hex');
 let record;const result=await guardMessage({...x,commit:async value=>{record=value;return 'saved';}});
 assert.equal(result.action,'accepted');assert.equal(record.kind,'needs_private_review');assert.equal(record.questionKey,'saudiDeportationOrEntryBan');assert.equal(record.value,'yes');
 assert.equal(Object.hasOwn(record,'priorGccDeportation'),false);
});
test('stale, mismatched, unpaid and out-of-context replies are quarantined without their contents',async()=>{
 for(const change of [x=>x.message.context.id='wamid.other',x=>x.message.interactive.button_reply.id='rq1:'+'b'.repeat(32)+':0',x=>x.now=1000,x=>x.draft.revision++,x=>x.visaCase.paymentStatus='unverified',x=>x.visaCase.applicants[0].nationality='EGY',x=>x.session.applicantIndex=1,x=>x.session.questionKey='health.accidentDisability',x=>x.session.choicesDigest='0'.repeat(64)]){
  const x=fixture();change(x);let record;const result=await guardMessage({...x,commit:async v=>{record=v;return 'saved';}});
  assert.equal(result.action,'quarantined');assert.deepEqual(Object.keys(record).sort(),['caseId','customer','kind','messageId']);
  assert.ok(!JSON.stringify(record).includes('private answer'));
 }
});
test('free text including sensitive details stays out of ordinary journal and AI handlers',async()=>{
 const x=fixture();x.message={from:x.session.customer,id:'wamid.free',type:'text',text:{body:'SYNTHETIC_PRIVATE_MEDICAL_CONTENT'}};
 const called=[],commit=async record=>{called.push(['private',record]);return 'saved';};
 const result=await guardMessage({...x,commit});if(result.action==='pass'){called.push(['journal',x.message]);called.push(['ai',x.message]);}
 assert.equal(result.action,'quarantined');assert.deepEqual(called.map(c=>c[0]),['private']);assert.ok(!JSON.stringify(called).includes('SYNTHETIC_PRIVATE_MEDICAL_CONTENT'));
});
test('failed or non-durable storage always retries and never routes sensitive content onward',async()=>{
 const x=fixture();for(const [encryptedDurable,commit] of [[false,async()=>{throw Error('never')}],[true,async()=>{throw Error('private')}],[true,async()=>false],[true,undefined]]){
  assert.deepEqual(await guardMessage({...x,encryptedDurable,commit}),{action:'retry'});
 }
});
test('foreign session is not credited and a message without a session remains ordinary',async()=>{
 const x=fixture();let called=false;x.session.customer='971500000002';assert.deepEqual(await guardMessage({...x,commit:async()=>{called=true;return 'saved';}}),{action:'retry'});assert.equal(called,false);
 assert.deepEqual(await guardMessage({...x,session:null}),{action:'pass'});
});
