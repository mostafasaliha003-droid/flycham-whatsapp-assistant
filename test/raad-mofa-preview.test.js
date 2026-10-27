'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {buildMofaPreview} = require('../src/raad-mofa-preview');

function summary(overrides = {}) {
  return {
    jobId: 'synthetic-job', caseId: 'synthetic-case', revision: 7, state: 'draft',
    fields: {
      arabicFirstName: 'ليلى', arabicFatherName: 'محمد', arabicGrandfatherName: 'سليم', arabicFamilyName: 'تجريبي',
      latinFirstName: 'JANE  ALICE', latinFatherName: 'JOHN', latinGrandfatherName: 'JAMES', latinFamilyName: "O'NEIL-TEST",
      passportNumber: 'N001234567', nationalityCode: 'SYR', issuingCountryCode: 'EGY', passportType: 'ordinary',
      issueDate: '2025-01-02', expiryDate: '2030-02-03', birthDate: '1990-03-04', birthPlace: 'Synthetic City',
      saudiAddress: 'Synthetic KSA hotel address', entryDate: '2026-11-20', sex: 'F'
    },
    defaults: {visitPurpose: 'tourism', mission: 'Abu Dhabi', residenceCountryCode: 'ARE', proposedEntryDate: '2026-11-11', applicationPhone: '+971500000010', entries: 'multiple', visaValidityDays: 365},
    review: {complete: false, invalidated: false, confirmedFields: []},
    ...overrides
  };
}
const control = (preview, id) => preview.fields.find(field => field.controlId === id || field.controlName === id);
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('local preview preserves exact supplied names, passport prefix and known control casing', () => {
  const saved = deepFreeze(summary());
  const before = JSON.stringify(saved);
  const preview = buildMofaPreview(saved);
  assert.equal(preview.mode, 'preview_only');
  assert.equal(preview.canExecute, false);
  assert.equal(preview.draftRevision, 7);
  assert.equal(preview.caseId, 'synthetic-case');
  for (const [id, value] of Object.entries({AFIRSTNAME: 'ليلى', AFATHER: 'محمد', AGRAND: 'سليم', AFAMILY: 'تجريبي', EFIRSTNAME: 'JANE  ALICE', EFATHER: 'JOHN', EGRAND: 'JAMES', EFAMILY: "O'NEIL-TEST", PASSPORTnumber: 'N001234567', BIRTH_PLACE: 'Synthetic City', ADDRESS_HOME: 'Synthetic KSA hotel address'})) assert.equal(control(preview, id)?.value, value, id);
  assert.match(control(preview, 'ADDRESS_HOME').portalLabel, /KSA Home Address/);
  assert.ok(preview.notices.some(notice => notice.includes('التسمية الحالية')));
  assert.equal(JSON.stringify(saved), before);
  assert.equal(control(preview, 'PASSPORTnumber').status, 'saved_fact');
});

test('suggestions remain visible and distinct and known route option values require exact reviewed paths', () => {
  const unreviewed = buildMofaPreview(summary());
  assert.deepEqual(control(unreviewed, 'VisaKind'), {sourceField: 'defaults.visitPurpose', portalLabel: 'نوع التأشيرة: زيارة سياحية', controlName: 'VisaKind', kind: 'select', value: 'tourism', status: 'suggestion_requires_review'});
  assert.equal(control(unreviewed, 'EmbassyCode').value, 'Abu Dhabi');
  assert.equal(control(unreviewed, 'MobileInfo.Mobile').status, 'display_only_phone_format_unverified');
  assert.equal(control(unreviewed, 'MobileInfo.Mobile').value, '+971500000010');
  assert.ok(unreviewed.unresolved.some(notice => notice.includes('بادئة الدولة المنفصلة')));
  const reviewed = buildMofaPreview(summary({review: {complete: true, invalidated: false, confirmedFields: ['defaults.visitPurpose', 'defaults.mission']}}));
  assert.equal(control(reviewed, 'VisaKind').value, '19');
  assert.equal(control(reviewed, 'EmbassyCode').value, '214');
  assert.equal(control(reviewed, 'VisaKind').displayValue, 'زيارة سياحية');
  assert.equal(control(reviewed, 'EmbassyCode').displayValue, 'أبوظبي');
  assert.equal(control(reviewed, 'EmbassyCode').portalLabel, 'أقرب ممثلية سعودية');
  assert.equal(control(reviewed, 'VisaKind').status, 'suggestion_reviewed_option');
  assert.equal(reviewed.canExecute, false);
  const wrongPaths = buildMofaPreview(summary({review: {complete: true, confirmedFields: ['fields.visitPurpose', 'fields.mission']}}));
  assert.equal(control(wrongPaths, 'VisaKind').value, 'tourism');
  assert.equal(control(wrongPaths, 'EmbassyCode').value, 'Abu Dhabi');
});

test('explicit route overrides are preserved and flagged without replacing Dubai or Umrah with office defaults', () => {
  const saved = summary();
  saved.fields.mission = 'Dubai';
  saved.fields.visitPurpose = 'umrah';
  saved.review = {complete: true, invalidated: false, confirmedFields: ['fields.mission', 'fields.visitPurpose']};
  const preview = buildMofaPreview(saved);
  assert.equal(control(preview, 'EmbassyCode').value, 'Dubai');
  assert.equal(control(preview, 'EmbassyCode').status, 'route_requires_review');
  assert.equal(control(preview, 'VisaKind').value, 'umrah');
  assert.equal(control(preview, 'VisaKind').status, 'route_requires_review');
  assert.equal(preview.fields.some(field => ['19', '214', '230'].includes(field.value)), false);
  assert.ok(preview.unresolved.some(notice => notice.includes('لم تُستبدل')));
});

test('country and document dropdown values are never fabricated and issuer remains distinct from nationality', () => {
  const saved = summary();
  const preview = buildMofaPreview(saved);
  assert.equal(control(preview, 'ddlResidenceCountry').value, 'ARE');
  assert.equal(control(preview, 'ddlResidenceCountry').status, 'suggestion_needs_matching');
  assert.equal(control(preview, 'PASSPORType').value, 'ordinary');
  assert.equal(control(preview, 'PASSPORType').status, 'needs_matching');
  assert.equal(preview.fields.some(field => ['fields.nationalityCode', 'fields.issuingCountryCode', 'fields.sex'].includes(field.sourceField)), false);
  assert.equal(preview.fields.some(field => ['ddlNationality', 'NATIONALITY', 'select2-NATIONALITY-container'].includes(field.controlId)), false);
  assert.ok(preview.unresolved.some(notice => notice.includes('الجنسية الحالية')));
  assert.ok(preview.unresolved.some(notice => notice.includes('دولة إصدار الجواز مستقلة')));
  assert.equal(saved.fields.nationalityCode, 'SYR');
  assert.equal(saved.fields.issuingCountryCode, 'EGY');
});

test('dates are unchanged display values with an unresolved portal format, including suggested entry', () => {
  const saved = summary();
  const preview = buildMofaPreview(saved);
  for (const [id, date] of Object.entries({PASSPORT_ISSUE_DATE: '2025-01-02', PASSPORT_EXPIRY_DATe: '2030-02-03', BIRTH_DATE: '1990-03-04', ExpectedEntryDate: '2026-11-20'})) {
    assert.equal(control(preview, id).value, date);
    assert.equal(control(preview, id).status, 'display_only_date_format_unverified');
  }
  assert.ok(preview.unresolved.some(notice => notice.includes('صيغة التواريخ')));
  delete saved.fields.entryDate;
  const proposed = control(buildMofaPreview(saved), 'ExpectedEntryDate');
  assert.equal(proposed.value, '2026-11-11');
  assert.equal(proposed.sourceField, 'defaults.proposedEntryDate');
  assert.equal(proposed.status, 'suggestion_date_format_unverified');
  saved.fields.entryDate = '20/11/2026';
  assert.equal(control(buildMofaPreview(saved), 'ExpectedEntryDate').value, '20/11/2026');
});

test('missing names are omitted instead of being split, inferred, or populated from defaults', () => {
  const saved = summary({fields: {latinFirstName: 'JANE ALICE', passportNumber: 'N0001'}, defaults: {latinFatherName: 'INVENTED', arabicFatherName: 'INVENTED', __no_default__: 'INVENTED'}});
  const preview = buildMofaPreview(saved);
  assert.equal(control(preview, 'EFIRSTNAME').value, 'JANE ALICE');
  for (const id of ['EFATHER', 'EGRAND', 'EFAMILY', 'AFIRSTNAME', 'AFATHER', 'AGRAND', 'AFAMILY']) assert.equal(control(preview, id), undefined, id);
  assert.doesNotMatch(JSON.stringify(preview), /INVENTED/);
});

test('not-started, unsaved, stale and invalidated drafts have safe conflict errors', () => {
  for (const saved of [null, {}, summary({jobId: null}), summary({caseId: ''}), summary({revision: 0}), summary({state: 'not_started'}), summary({confirmationRequired: true})]) assert.throws(() => buildMofaPreview(saved), {code: 'RAAD_PREVIEW_DRAFT_REQUIRED', statusCode: 409});
  for (const saved of [summary({state: 'stale'}), summary({invalidated: true}), summary({review: {invalidated: true}})]) assert.throws(() => buildMofaPreview(saved), {code: 'RAAD_PREVIEW_DRAFT_STALE', statusCode: 409});
  assert.throws(() => buildMofaPreview(summary({state: 'submitted'})), {code: 'RAAD_PREVIEW_DRAFT_INVALID', statusCode: 409});
});

test('unknown, legal, health, history, OTP and insurance values never become bindings or acceptance actions', () => {
  const saved = summary({state: 'ready_for_portal_review', canExecute: true, mode: 'execute'});
  Object.assign(saved.fields, {otp: 'SENSITIVE-OTP', captcha: 'SENSITIVE-CAPTCHA', automaticAccept: 'SENSITIVE-ACCEPT', legalConsent: 'SENSITIVE-CONSENT', occupation: 'SENSITIVE-JOB', religion: 'SENSITIVE-RELIGION', sponsor: 'SENSITIVE-SPONSOR', qualification: 'SENSITIVE-QUALIFICATION', health: {hospitalizedOrEmergency: true}, priorGccDeportation: true, priorGccRuleViolation: true, travelledLastFiveYears: true, insurancePrice: 'SENSITIVE-PRICE'});
  const preview = buildMofaPreview(saved);
  assert.equal(preview.canExecute, false);
  assert.equal(preview.mode, 'preview_only');
  assert.doesNotMatch(JSON.stringify(preview), /SENSITIVE-/);
  assert.equal(preview.fields.some(field => /otp|captcha|accept|pledge|health|insurance|deport|violation|occupation|religion|sponsor|qualification|Entries|Validity/i.test(field.controlId || field.controlName || '')), false);
  assert.ok(preview.unresolved.some(notice => notice.includes('المهنة')));
  assert.ok(preview.unresolved.some(notice => notice.includes('عدد الدخول')));
  assert.ok(preview.unresolved.some(notice => notice.includes('رقم الهوية الإماراتية')));
  assert.ok(preview.unresolved.some(notice => notice.includes('عناصر رفع الجواز')));
  assert.ok(preview.notices.some(notice => notice.includes('ليست موافقة')));
});

test('preview has no provider, storage, or network interaction even for a reviewed ready draft', () => {
  let networkCalls = 0;
  const previous = global.fetch;
  global.fetch = () => { networkCalls++; throw Error('network must not be used'); };
  try {
    const saved = summary({state: 'ready_for_portal_review', review: {complete: true, invalidated: false, confirmedFields: ['defaults.visitPurpose', 'defaults.mission']}});
    assert.deepEqual(buildMofaPreview(saved), buildMofaPreview(saved));
    assert.equal(networkCalls, 0);
  } finally { global.fetch = previous; }
});
