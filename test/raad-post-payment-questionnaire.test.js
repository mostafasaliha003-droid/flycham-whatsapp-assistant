'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {visaCaseSignature} = require('../src/visa-case-signature');
const {postPaymentQuestion} = require('../src/raad-post-payment-questionnaire');

function fixture() {
  const visaCase = {id:'case-synthetic', policyVersion:'p', applicantCount:2,
    applicants:[{nationality:'SYR'}, {nationality:'SYR'}], quote:{total:1400},
    documents:[], paymentStatus:'verified', submissionStatus:'not_submitted'};
  const signature = visaCaseSignature(visaCase);
  visaCase.staffVerification = {payment:{caseSignature:signature, amount:1400}};
  return {visaCase, applicantIndex:1, draft:{jobId:'draft-synthetic',revision:1,state:'draft',caseId:visaCase.id, caseSignature:signature, applicantIndex:1, fields:{}}};
}
test('only the bound applicant with a current, verified paid case receives a proposal', () => {
  const x=fixture(), before=structuredClone(x);
  const q=postPaymentQuestion(x);
  assert.equal(q.status,'question'); assert.equal(q.question.key,'maritalStatus');
  assert.ok(q.question.choices.some(c=>c.value==='widowed'));
  assert.ok(q.question.choices.some(c=>c.value==='other'));
  assert.deepEqual(x,before);
  x.visaCase.paymentStatus='awaiting_verification'; assert.equal(postPaymentQuestion(x).status,'payment_or_case_not_verified');
  x.visaCase.paymentStatus='verified'; x.visaCase.staffVerification.payment.amount=1399; assert.equal(postPaymentQuestion(x).status,'payment_or_case_not_verified');
  x.visaCase.staffVerification.payment.amount=1400; x.visaCase.applicants[1].nationality='EGY'; assert.equal(postPaymentQuestion(x).status,'payment_or_case_not_verified');
});
test('a mismatched or unconfirmed applicant and an amended or submitted case never receive a proposal', () => {
  for (const change of [x=>x.draft.applicantIndex=0, x=>x.draft.caseId='other', x=>x.applicantIndex=2, x=>x.draft.state='stale', x=>x.draft.review={invalidated:true}, x=>x.draft.blockedReason='RAAD_COMPLAINT_ACTIVE']) {
    const x=fixture(); change(x); assert.equal(postPaymentQuestion(x).status,'case_or_applicant_unavailable');
  }
  for (const change of [x=>x.visaCase.pendingAmendment={state:'pending'}, x=>x.visaCase.stage='complaint_pending', x=>x.visaCase.stage='submitted', x=>x.visaCase.submissionStatus='submitted']) {
    const x=fixture();change(x);assert.equal(postPaymentQuestion(x).status,'staff_review_required');
  }
});
test('explicit true and false answers advance without inferred facts; affirmative details are requested', () => {
  const x=fixture(), f=x.draft.fields;
  f.maritalStatus='married'; assert.equal(postPaymentQuestion(x).question.key,'previousNationality');
  f.previousNationality=true; assert.equal(postPaymentQuestion(x).question.key,'previousNationalityDetails');
  f.previousNationalityDetails='Synthetic'; assert.equal(postPaymentQuestion(x).question.key,'travelledLastFiveYears');
  f.travelledLastFiveYears=true; assert.equal(postPaymentQuestion(x).question.key,'travelHistory');
  f.travelHistory='Synthetic destination'; assert.equal(postPaymentQuestion(x).question.key,'performUmrah');
  f.performUmrah=false; assert.equal(postPaymentQuestion(x).question.key,'health.hospitalizedOrEmergency');
  f.health={hospitalizedOrEmergency:true,accidentDisability:false,congenitalCondition:true};
  assert.deepEqual(postPaymentQuestion(x),{status:'questions_complete'});
});
test('ambiguous and stringified answers never count as yes or no', () => {
  const x=fixture();x.draft.fields={maritalStatus:'other'};
  assert.equal(postPaymentQuestion(x).question.key,'maritalStatus');
  x.draft.fields={maritalStatus:'single',previousNationality:'false'};
  const q=postPaymentQuestion(x);assert.equal(q.question.key,'previousNationality');
  assert.ok(q.question.choices.some(c=>c.value==='unsure'));
});
