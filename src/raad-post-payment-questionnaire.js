'use strict';

// Pure, non-sending proposal. The caller must separately authenticate the
// conversation and select a reviewed applicant draft; no data is persisted.
const {currentVisaEvidence} = require('./visa-case-signature');

const YES_NO = Object.freeze([
  {value: 'yes', label: 'نعم'},
  {value: 'no', label: 'لا'},
  {value: 'unsure', label: 'غير متأكد'}
]);
const QUESTIONS = Object.freeze([
  {key: 'maritalStatus', prompt: 'ما هي حالتك الاجتماعية الحالية؟', choices: [
    {value: 'single', label: 'أعزب أو عزباء'},
    {value: 'married', label: 'متزوج أو متزوجة'},
    {value: 'divorced', label: 'مطلق أو مطلقة'},
    {value: 'widowed', label: 'أرمل أو أرملة'},
    {value: 'other', label: 'حالة أخرى أو غير متأكد'}
  ]},
  {key: 'previousNationality', prompt: 'هل لديك جنسية سابقة؟', choices: YES_NO},
  {key: 'travelledLastFiveYears', prompt: 'هل سبق لك السفر إلى دول أخرى خلال السنوات الخمس الماضية؟', choices: YES_NO},
  {key: 'performUmrah', prompt: 'هل ترغب في أداء مناسك العمرة خلال الزيارة؟', choices: YES_NO},
  {key: 'health.hospitalizedOrEmergency', prompt: 'هل هناك حالة تنويم في المستشفى حاليًا أو تتلقى علاج الطوارئ؟', choices: YES_NO},
  {key: 'health.accidentDisability', prompt: 'هل تعرضت لحادث أدى إلى إصابتك بعلة أو إعاقة؟', choices: YES_NO},
  {key: 'health.congenitalCondition', prompt: 'هل لديك حالات ضعف أو تشوه خلقي؟', choices: YES_NO}
]);
const RECORD = v => v && typeof v === 'object' && !Array.isArray(v);
const BOOLEAN = v => typeof v === 'boolean';
const HAS_TEXT = v => typeof v === 'string' && v.trim().length > 0;
const STATUSES = new Set(['single', 'married', 'divorced', 'widowed', 'widow', 'separated']);

function answer(fields, key) {
  return key.startsWith('health.') ? fields.health?.[key.slice(7)] : fields[key];
}

function postPaymentQuestion({visaCase, draft, applicantIndex} = {}) {
  if (!RECORD(visaCase) || typeof visaCase.id !== 'string' || !visaCase.id ||
      !Number.isSafeInteger(visaCase.applicantCount) || visaCase.applicantCount < 1 ||
      !Number.isSafeInteger(applicantIndex) || applicantIndex < 0 || applicantIndex >= visaCase.applicantCount ||
      !RECORD(draft) || draft.caseId !== visaCase.id || draft.applicantIndex !== applicantIndex || !RECORD(draft.fields) ||
      typeof draft.jobId !== 'string' || !draft.jobId || !Number.isSafeInteger(draft.revision) || draft.revision < 1 ||
      !['draft', 'needs_information', 'ready_for_portal_review'].includes(draft.state) || draft.review?.invalidated === true || draft.blockedReason) {
    return {status: 'case_or_applicant_unavailable'};
  }
  const total = visaCase.quote?.total, evidence = currentVisaEvidence(visaCase);
  if (!Number.isFinite(total) || total <= 0 || !evidence.payment || draft.caseSignature !== evidence.signature) {
    return {status: 'payment_or_case_not_verified'};
  }
  const amendment = visaCase.pendingAmendment;
  if (visaCase.submissionStatus === 'submitted' || visaCase.stage === 'submitted' || visaCase.staffVerification?.decision ||
      visaCase.stage === 'complaint_pending' ||
      amendment && !['applied', 'rejected', 'cancelled', 'resolved'].includes(amendment.state)) {
    return {status: 'staff_review_required'};
  }
  const fields = draft.fields;
  for (const item of QUESTIONS) {
    const value = answer(fields, item.key);
    if (item.key === 'maritalStatus' ? !HAS_TEXT(value) || !STATUSES.has(value.toLowerCase()) : !BOOLEAN(value)) {
      return {status: 'question', question: {key: item.key, prompt: item.prompt, choices: item.choices.map(x => ({...x}))}};
    }
    if (item.key === 'previousNationality' && value && !HAS_TEXT(fields.previousNationalityDetails)) {
      return {status: 'question', question: {key: 'previousNationalityDetails', prompt: 'ما جنسيتك السابقة؟', choices: []}};
    }
    if (item.key === 'travelledLastFiveYears' && value && !(HAS_TEXT(fields.travelHistory) || Array.isArray(fields.travelHistory) && fields.travelHistory.some(HAS_TEXT))) {
      return {status: 'question', question: {key: 'travelHistory', prompt: 'ما الدول التي سافرت إليها خلال السنوات الخمس الماضية؟', choices: []}};
    }
  }
  return {status: 'questions_complete'};
}

module.exports = {postPaymentQuestion};
