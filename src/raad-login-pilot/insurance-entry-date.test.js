'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runGovernmentJob}=require('./production-worker');
const {insuranceEntryDate}=require('./estimated-entry-date');
const SIGNATURE='a'.repeat(64),REFERENCE='E12345678',DATE='2026-11-14';
const tagged=code=>Object.assign(Error(code),{code});
async function insuranceScenario({insuranceLabel='Expected entry date',afterSaveNow,changedManifestDate}={}){
 let path='/SmartForm/TraditionalApp',prior,at=Date.parse('2026-10-30T19:59:00Z');const calls=[];
 const facts={passportNumber:'X000001',entryDate:DATE,postOfficeBox:'000',city:'Synthetic City',postalCode:'00000',contactEmail:'synthetic@example.test',insurancePhone:'+971500000001',health:{hospitalizedOrEmergency:false,accidentDisability:false,congenitalCondition:false}};
 const manifest={facts,caseSignature:SIGNATURE,applicantIndex:0,entryDateProvenance:{source:'office_estimate',referenceDate:'2026-10-30',offsetDays:15}};
 const smsWindow=Object.freeze({challengeId:'insurance_synthetic_challenge',challengeRequestedAt:at,challengeExpiresAt:at+300000,accountBinding:'b'.repeat(64)});
 const record={smsWindow,pendingCode:'123456',expectedDraft:[],controller:new AbortController(),saved:false};
 const page={goto:async url=>{prior=path;path=new URL(url).pathname;},goBack:async()=>{path=prior;}};
 const api=async(action,data={})=>{
  calls.push({action,path,data:structuredClone(data)});
  if(action==='inspect-page')return {inspection:{path,controls:[{id:'ExpectedEntryDate',label:path==='/SmartForm/TraditionalApp'?'Expected entry date':insuranceLabel,disabled:false}],buttons:[{label:'Save',disabled:false}]}};
  if(action==='enter-application-sms'){assert.deepEqual(Object.fromEntries(['challengeId','challengeRequestedAt','challengeExpiresAt','accountBinding'].map(key=>[key,data[key]])),smsWindow);assert.equal(data.code,'123456');return {codeEntered:true};}
  if(action==='activate-control'){
   if(path==='/SmartForm/TraditionalApp'){path='/SmartForm/HealthInsuranceInfo/12345678';if(afterSaveNow)at=afterSaveNow;if(changedManifestDate)facts.entryDate=changedManifestDate;return {activationDispatched:true};}
   throw tagged('SYNTHETIC_TEST_STOP');
  }
  if(action==='lookup-applications')return {lookupSupported:true,matchCount:1,matches:[{applicationReference:REFERENCE}]};
  if(action==='fill-draft'||action==='set-dates')return {filledCount:1};
  if(['refresh-form-captcha','solve-form-captcha'].includes(action))return {};
  throw tagged('UNEXPECTED_SYNTHETIC_ACTION');
 };
 let error;try{await runGovernmentJob({record,manifest,api,wait:async()=>{},now:()=>at,locate:async()=>({path}),checkLease:async()=>{},withPage:async fn=>fn(page)},{resume:true});}catch(e){error=e;}
 return {record,manifest,calls,error,at};
}
const healthDates=t=>t.calls.filter(c=>c.action==='set-dates'&&c.path.startsWith('/SmartForm/HealthInsuranceInfo/'));
test('insurance confirmed-booking wording cannot inherit the application expected-date authorization',async()=>{
 const t=await insuranceScenario({insuranceLabel:'Confirmed booking date'});assert.equal(t.error?.code,'ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');
 assert.equal(t.record.saved,true);assert.equal(t.record.reference,REFERENCE);assert.equal(healthDates(t).length,0);
 assert.equal(t.calls.some(c=>c.path.startsWith('/SmartForm/HealthInsuranceInfo/')&&c.action==='fill-draft'),false);
 assert.equal(t.record.savedEntryDateEvidence.date,DATE);
});
test('the actual insurance expected-date field receives the verified submitted value after midnight, without adding fifteen days again',async()=>{
 const t=await insuranceScenario({afterSaveNow:Date.parse('2026-10-31T20:01:00Z')});
 assert.equal(t.error?.code,'SYNTHETIC_TEST_STOP');assert.equal(t.record.saved,true);assert.equal(healthDates(t).length,1);
 assert.equal(healthDates(t)[0].data.dates[0].isoDate,DATE);assert.equal(t.record.submittedEntryDate,DATE);
 assert.equal(t.record.savedEntryDateEvidence.date,DATE);
 assert.equal(t.calls.some(c=>c.action==='request-application-sms'),false);
});
test('post-save manifest changes cannot replace the date attested at Save',async()=>{
 const t=await insuranceScenario({changedManifestDate:'2026-12-31'});assert.equal(t.error?.code,'SYNTHETIC_TEST_STOP');
 assert.equal(t.manifest.facts.entryDate,'2026-12-31');assert.equal(healthDates(t)[0].data.dates[0].isoDate,DATE);
 assert.equal(t.record.savedEntryDateEvidence.date,DATE);
});
test('resumed insurance date evidence is reference/case/applicant bound and never falls back to an office estimate',()=>{
 const control={id:'ExpectedEntryDate',label:'Expected entry date',disabled:false};
 const evidence={source:'verified_current_run_submission',date:DATE,applicationReference:REFERENCE,caseSignature:SIGNATURE,applicantIndex:0};
 const context={evidence,applicationReference:REFERENCE,caseSignature:SIGNATURE,applicantIndex:0};
 assert.equal(insuranceEntryDate(control,context),DATE);
 for(const patch of [{evidence:null},{applicationReference:'E99999999'},{caseSignature:'b'.repeat(64)},{applicantIndex:1},{evidence:{...evidence,date:'2026-02-30'}}])assert.throws(()=>insuranceEntryDate(control,{...context,...patch}),e=>['SAVED_ENTRY_DATE_UNCONFIRMED','SUBMITTED_ENTRY_DATE_UNCONFIRMED'].includes(e.code));
 assert.throws(()=>insuranceEntryDate({...control,label:'Confirmed booking date'},context),e=>e.code==='ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');
});
test('a misleading insurance label containing the expected-date phrase still fails',async()=>{
 const t=await insuranceScenario({insuranceLabel:'Confirmed booking date, not Expected entry date'});assert.equal(t.error?.code,'ESTIMATED_ENTRY_DATE_FIELD_UNCONFIRMED');assert.equal(healthDates(t).length,0);
});
