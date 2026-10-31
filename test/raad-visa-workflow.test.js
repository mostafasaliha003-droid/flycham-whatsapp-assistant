'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {RaadVisaWorkflow} = require('../src/raad-visa-workflow');
const {visaCaseSignature} = require('../src/visa-case-signature');

const CUSTOMER = '971500000001';
const IDS = {
  passport: '10000000-0000-4000-8000-000000000001',
  residence: '10000000-0000-4000-8000-000000000002',
  photo: '10000000-0000-4000-8000-000000000003',
  derived: '10000000-0000-4000-8000-000000000004'
};
const NOW = Date.parse('2026-10-26T20:30:00Z'); // Already 27 October in Dubai.
const CONTACTS = {
  RAAD_APPLICATION_PHONE: '+971500000010',
  RAAD_CONTACT_EMAIL: 'application@example.test',
  RAAD_INSURANCE_PHONE: '+971500000011',
  RAAD_POSTAL_CODE: '00000'
};
function applicant(overrides = {}) {
  return {
    nationalityCode: 'SYR', passportNumber: 'TEST0001', passportType: 'ordinary',
    issuingCountryCode: 'SYR', issueDate: '2025-01-01', expiryDate: '2030-01-01',
    birthDate: '1990-04-03', birthPlace: 'Synthetic City', sex: 'M',
    latinFirstName: 'Synthetic', latinFamilyName: 'Applicant',
    emiratesId: '784199000000001', residenceExpiry: '2028-01-01',
    maritalStatus: 'single', previousNationality: false, travelledLastFiveYears: false,
    performUmrah: false, saudiAddress: 'Synthetic hotel, Synthetic Street',
    entryDate: '2026-11-20', transport: 'land', arrivalPort: 'Synthetic land port',
    gccResident: true, priorGccDeportation: false, priorGccRuleViolation: false,
    health: {hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false},
    ...overrides
  };
}
function verify(c) {
  const caseSignature = visaCaseSignature(c);
  c.paymentStatus = 'verified';
  c.staffVerification = {
    payment: {amount: c.quote.total, reference: 'synthetic-payment', caseSignature},
    documentsReviewed: true, documentsSignature: caseSignature
  };
}
function fixture({nationality = 'سوريا', documentType = 'passport', count = 1, contacts = true, evidence = true} = {}) {
  const c = {id: 'synthetic-case', policyVersion: 'synthetic-policy', applicantCount: count, applicants: Array.from({length: count}, () => ({nationality, documentType})), quote: {total: 700 * count}, paymentStatus: 'unverified', submissionStatus: 'not_submitted', documents: [], stage: 'quoted'};
  if (evidence) verify(c);
  const records = Object.fromEntries(Object.values(IDS).map((id, index) => [id, {id, customer: CUSTOMER, mimeType: 'image/jpeg', size: 1000, status: 'pending_review', receivedAt: NOW - 1000, expiresAt: NOW + 86400000, checksum: 'synthetic-digest-' + index}]));
  let saves = 0;
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: records}, save() { saves++; }};
  const mediaStore = {get(id, {customer} = {}) {
    const record = records[id];
    if (!record || record.customer !== customer || record.expiresAt <= NOW) throw Error('MEDIA_NOT_FOUND');
    // Production media metadata intentionally does not expose the checksum.
    const {checksum, ...publicMetadata} = record;
    return structuredClone(publicMetadata);
  }};
  const config = {store, mediaStore, now: () => NOW, env: contacts ? CONTACTS : {}};
  const workflow = new RaadVisaWorkflow(config);
  return {workflow, store, records, c, config, saves: () => saves};
}
function prepare(f, options = {}) {
  return f.workflow.prepare(CUSTOMER, {expectedRevision: 0, fields: applicant(), documents: {passport: IDS.passport, residence: IDS.residence, photo: IDS.photo}, confirm: true, ...options});
}
function review(f, summary) {
  return f.workflow.review(CUSTOMER, {applicantIndex: summary.applicantIndex, expectedRevision: summary.revision, confirmedFields: summary.reviewRequiredFields, confirm: true});
}

test('client-only previews and uncommitted uploads cannot be bound as any applicant document, including hidden raw purposes', () => {
  for (const purpose of ['raad_pdf_preview','visa_client_preview','visa_upload_staged','visa_upload_withdrawn']) for (const kind of ['passport','residence','photo']) {
    const f=fixture();f.records[IDS.derived].purpose=purpose;
    const publicGet=f.config.mediaStore.get.bind(f.config.mediaStore);f.config.mediaStore.get=(...args)=>{const metadata=publicGet(...args);delete metadata.purpose;return metadata;};
    const documents={passport:IDS.passport,residence:IDS.residence,photo:IDS.photo,[kind]:IDS.derived};
    assert.throws(()=>prepare(f,{documents}),{code:'RAAD_DOCUMENT_PREVIEW_ONLY',statusCode:422},purpose+'/'+kind);
    assert.equal(f.store.data.raadApplications,undefined);
  }
});

test('a saved document reclassified as a client preview or staged upload invalidates its staff review', () => {
  for (const purpose of ['raad_pdf_preview','visa_client_preview','visa_upload_staged','visa_upload_withdrawn']) {
    const f=fixture(),saved=prepare(f);f.records[IDS.passport].purpose=purpose;
    const current=f.workflow.get(CUSTOMER);
    assert.ok(current.issues.some(item=>item.code==='DOCUMENT_PREVIEW_ONLY'),purpose);
    assert.notEqual(current.state,'ready_for_portal_review');
    assert.throws(()=>review(f,saved),{code:'RAAD_APPLICATION_STALE'});
  }
});

test('safe source purpose is part of the protected snapshot, and ordinary originals or portal derivatives remain reviewable', () => {
  for (const purpose of [undefined,'raad_portal_upload','staff_uploaded_original']) {
    const f=fixture();if(purpose!==undefined)f.records[IDS.passport].purpose=purpose;
    const saved=prepare(f);assert.equal(saved.documents.passport.purpose,purpose);
    assert.equal(saved.issues.some(item=>item.code==='DOCUMENT_PREVIEW_ONLY'),false);
    f.records[IDS.passport].purpose=purpose==='raad_portal_upload'?'staff_uploaded_original':'raad_portal_upload';
    assert.notEqual(f.workflow.observeDocument(IDS.passport,f.workflow.context(CUSTOMER,0)).fingerprint,saved.documents.passport.fingerprint);
    assert.throws(()=>review(f,saved),{code:'RAAD_APPLICATION_STALE'});
  }
});

test('get is read only and proposals do not invent applicant facts or actual travel', () => {
  const f = fixture({contacts: false});
  const before = JSON.stringify(f.store.data);
  const summary = f.workflow.get(CUSTOMER);
  assert.equal(summary.state, 'not_started');
  assert.equal(summary.revision, 0);
  assert.deepEqual(summary.fields, {});
  assert.equal(summary.defaults.proposedEntryDate, '2026-11-11');
  assert.equal(summary.officeHotelSuggestion, 'Hilton Al Riyadh');
  assert.equal(summary.defaults.mission, 'Abu Dhabi');
  assert.equal(summary.defaults.residenceCountryCode, 'ARE');
  assert.equal(summary.defaults.transport, 'air');
  assert.equal(summary.defaults.arrivalPort, 'مطار الملك خالد الدولي');
  for (const key of ['entryDate', 'saudiAddress', 'health', 'maritalStatus', 'previousNationality', 'performUmrah', 'gccResident', 'priorGccDeportation', 'priorGccRuleViolation', 'applicationPhone', 'contactEmail']) assert.equal(Object.hasOwn(summary.defaults, key), false, key);
  assert.deepEqual(summary.portal, {connected: false, mode: 'preparation', reason: 'PORTAL_NOT_CONNECTED'});
  assert.equal(JSON.stringify(f.store.data), before);
  assert.equal(f.saves(), 0);
  summary.defaults.mission = 'mutated';
  assert.equal(f.workflow.get(CUSTOMER).defaults.mission, 'Abu Dhabi');
});

test('entry estimate refreshes at Dubai midnight without modifying a saved draft', () => {
  const f = fixture();
  for (const record of Object.values(f.records)) record.expiresAt = NOW + 10 * 86400000;
  let clock = Date.parse('2026-10-27T19:59:59Z'); // 23:59 on 27 October in Dubai.
  f.workflow.now = () => clock;
  const saved = prepare(f, {fields: applicant({entryDate: null})});
  const reviewed = review(f, saved);
  assert.equal(reviewed.defaults.proposedEntryDate, '2026-11-11');
  assert.equal(reviewed.review.complete, true);
  assert.equal(reviewed.state, 'needs_information');
  const revision = reviewed.revision, saves = f.saves();
  clock = Date.parse('2026-10-27T20:00:00Z'); // 00:00 on 28 October in Dubai.
  const refreshed = f.workflow.get(CUSTOMER);
  assert.equal(refreshed.defaults.proposedEntryDate, '2026-11-12');
  assert.equal(Object.hasOwn(refreshed.fields, 'entryDate'), false);
  assert.equal(refreshed.review.complete, false);
  assert.equal(refreshed.revision, revision);
  assert.equal(f.saves(), saves);
});

test('an explicit entry date is retained across midnight and reviewed normally', () => {
  const f = fixture();
  for (const record of Object.values(f.records)) record.expiresAt = NOW + 10 * 86400000;
  let clock = Date.parse('2026-10-27T19:59:59Z');
  f.workflow.now = () => clock;
  const reviewed = review(f, prepare(f));
  assert.equal(reviewed.review.complete, true);
  clock = Date.parse('2026-10-27T20:00:00Z');
  const refreshed = f.workflow.get(CUSTOMER);
  assert.equal(refreshed.fields.entryDate, '2026-11-20');
  assert.equal(refreshed.review.complete, true);
  assert.equal(refreshed.defaults.proposedEntryDate, '2026-11-11');
});

test('hotel suggestion is configurable but never becomes a claimed booked address or personal answer', () => {
  const f = fixture();
  const workflow = new RaadVisaWorkflow({...f.config, env: {...CONTACTS, RAAD_SAUDI_HOTEL_SUGGESTION: '  Test Hotel Riyadh  '}});
  const initial = workflow.get(CUSTOMER);
  assert.equal(initial.officeHotelSuggestion, 'Test Hotel Riyadh');
  assert.equal(initial.fields.saudiAddress, undefined);
  assert.equal(initial.defaults.saudiAddress, undefined);
  const draft = workflow.prepare(CUSTOMER, {expectedRevision: 0, fields: applicant({saudiAddress: null, maritalStatus: null, health: null, travelledLastFiveYears: null}), confirm: true});
  assert.equal(draft.officeHotelSuggestion, 'Test Hotel Riyadh');
  for (const key of ['saudiAddress','maritalStatus','health','travelledLastFiveYears']) {
    assert.equal(draft.fields[key], undefined);
    assert.equal(draft.defaults[key], undefined);
  }
  assert.ok(draft.missing.includes('saudiAddress'));
  assert.ok(!draft.reviewRequiredFields.includes('officeHotelSuggestion'));
});

test('only explicit save changes state, with exact optimistic revisions and no parent mutation', () => {
  const f = fixture();
  const parent = structuredClone(f.c);
  const preview = prepare(f, {confirm: false});
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.revision, 0);
  assert.equal(f.saves(), 0);
  assert.equal(f.store.data.raadApplications, undefined);
  for (const expectedRevision of [undefined, '0', -1, 1, 0.1, NaN]) assert.throws(() => prepare(f, {expectedRevision}), {code: 'RAAD_REVISION_CONFLICT'});
  const saved = prepare(f);
  assert.equal(saved.revision, 1);
  assert.equal(saved.state, 'draft');
  assert.equal(saved.fields.transport, 'land');
  assert.equal(saved.fields.arrivalPort, 'Synthetic land port');
  assert.equal(f.saves(), 1);
  assert.deepEqual(f.c, parent);
  assert.throws(() => prepare(f), {code: 'RAAD_REVISION_CONFLICT'});
  assert.throws(() => f.workflow.review(CUSTOMER, {expectedRevision: 0, confirm: true}), {code: 'RAAD_REVISION_CONFLICT'});
});

test('exact staff data review can make a complete draft ready only for future portal review', () => {
  const f = fixture();
  const saved = prepare(f);
  assert.deepEqual(saved.issues, []);
  assert.ok(saved.reviewRequiredFields.includes('fields.health.congenitalCondition'));
  assert.ok(saved.reviewRequiredFields.includes('defaults.mission'));
  assert.ok(saved.reviewRequiredFields.includes('documents.passport'));
  assert.throws(() => f.workflow.review(CUSTOMER, {expectedRevision: 1, confirmedFields: saved.reviewRequiredFields.slice(1), confirm: true}), {code: 'RAAD_REVIEW_FIELDS_MISMATCH'});
  assert.throws(() => f.workflow.review(CUSTOMER, {expectedRevision: 1, confirmedFields: [...saved.reviewRequiredFields, 'privacyAccepted'], confirm: true}), {code: 'RAAD_REVIEW_FIELDS_MISMATCH'});
  assert.throws(() => f.workflow.review(CUSTOMER, {expectedRevision: 1, confirmedFields: [...saved.reviewRequiredFields, saved.reviewRequiredFields[0]], confirm: true}), {code: 'RAAD_REVIEW_FIELDS_INVALID'});
  const preview = f.workflow.review(CUSTOMER, {expectedRevision: 1, confirmedFields: saved.reviewRequiredFields});
  assert.equal(preview.confirmationRequired, true);
  assert.equal(f.workflow.get(CUSTOMER).review.complete, false);
  const reviewed = review(f, saved);
  assert.equal(reviewed.state, 'ready_for_portal_review');
  assert.equal(reviewed.revision, 2);
  assert.equal(reviewed.review.scope, 'staff_data_review');
  assert.equal(reviewed.review.complete, true);
  assert.equal(reviewed.portal.connected, false);
  assert.equal(f.c.submissionStatus, 'not_submitted');
  assert.equal(f.c.staffVerification.submission, undefined);
  assert.equal(f.c.staffVerification.decision, undefined);
  assert.equal(Object.hasOwn(reviewed, 'finalPdf'), false);
  const restarted = new RaadVisaWorkflow(f.config);
  assert.equal(restarted.get(CUSTOMER).state, 'ready_for_portal_review');
  assert.equal(f.saves(), 2);
  assert.doesNotMatch(JSON.stringify(f.store.data.raadApplications), /"(?:otp|cookies|password|rawMrz|privacyAccepted|authorizationAccepted)"/i);
});

test('incomplete drafts save without invented negatives or configured contact values', () => {
  const f = fixture({contacts: false, evidence: false});
  const saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 0, fields: {latinFirstName: 'Synthetic'}, confirm: true});
  assert.equal(saved.state, 'needs_information');
  assert.equal(saved.fields.nationalityCode, 'SYR');
  assert.equal(saved.fields.latinFamilyName, undefined);
  assert.equal(saved.fields.previousNationality, undefined);
  assert.equal(saved.fields.priorGccDeportation, undefined);
  assert.equal(saved.fields.priorGccRuleViolation, undefined);
  assert.equal(saved.fields.health, undefined);
  assert.equal(saved.fields.applicationPhone, undefined);
  assert.equal(saved.missing.includes('applicationPhone'), false);
  for (const field of ['contactEmail', 'insurancePhone', 'postalCode', 'birthDate', 'entryDate', 'transport', 'health.congenitalCondition', 'previousNationality', 'priorGccDeportation', 'priorGccRuleViolation', 'documents.passport', 'evidence.payment', 'evidence.documents']) assert.ok(saved.missing.includes(field), field);
  assert.equal(review(f, saved).state, 'needs_information');
});

test('private contact suggestions need exact review and can be supplied without source-code defaults', () => {
  const f = fixture({contacts: false});
  const workflow = new RaadVisaWorkflow({...f.config, privateConfig: {applicationPhone: '+971500000012', contactEmail: 'private@example.test', insurancePhone: '+971500000013', postalCode: '00000'}});
  const summary = workflow.prepare(CUSTOMER, {expectedRevision: 0, fields: applicant(), documents: {passport: IDS.passport, residence: IDS.residence, photo: IDS.photo}, confirm: true});
  assert.equal(summary.fields.contactEmail, undefined);
  assert.equal(summary.defaults.contactEmail, 'private@example.test');
  assert.ok(summary.reviewRequiredFields.includes('defaults.contactEmail'));
  assert.equal(summary.state, 'draft');
});

test('optional Arabic father and grandfather names are saved exactly and never inferred', () => {
  const f = fixture();
  let saved = prepare(f);
  assert.equal(saved.fields.arabicFatherName, undefined);
  assert.equal(saved.fields.arabicGrandfatherName, undefined);
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 1, fields: {arabicFatherName: 'محمد', arabicGrandfatherName: 'عبد الله'}, confirm: true});
  assert.equal(saved.fields.arabicFatherName, 'محمد');
  assert.equal(saved.fields.arabicGrandfatherName, 'عبد الله');
  assert.ok(saved.reviewRequiredFields.includes('fields.arabicFatherName'));
  assert.ok(saved.reviewRequiredFields.includes('fields.arabicGrandfatherName'));
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 3, fields: {arabicFatherName: 'INVALID LATIN'}, confirm: true});
  assert.equal(saved.state, 'needs_information');
  assert.equal(saved.review.complete, false);
  assert.ok(saved.issues.some(item => item.field === 'arabicFatherName' && item.code === 'invalid_arabic_name'));
});

test('Egyptian entry suggestions depend on nationality, never on passport issuing country', () => {
  const egyptian = fixture({nationality: 'مصر'});
  const egyptianDraft = prepare(egyptian, {fields: applicant({nationalityCode: 'EGY', issuingCountryCode: 'EGY'})});
  assert.equal(egyptianDraft.defaults.entries, 'single');
  assert.equal(egyptianDraft.defaults.visaValidityDays, 90);
  const syrian = fixture();
  const syrianDraft = prepare(syrian, {fields: applicant({issuingCountryCode: 'EGY'})});
  assert.equal(syrianDraft.fields.nationalityCode, 'SYR');
  assert.equal(syrianDraft.defaults.entries, 'multiple');
  assert.equal(syrianDraft.defaults.visaValidityDays, 365);
  const conflict = syrian.workflow.prepare(CUSTOMER, {expectedRevision: 1, fields: {entries: 'single', visaValidityDays: 90}, confirm: true});
  assert.ok(conflict.issues.some(item => item.code === 'OFFICE_POLICY_MISMATCH'));
  assert.equal(review(syrian, conflict).state, 'needs_information');
});

test('German MRZ D<< and ISO DEU are recognized as equivalent explicit country codes', () => {
  const f = fixture({nationality: 'ألمانيا'});
  const saved = prepare(f, {fields: applicant({nationalityCode: 'D<<', issuingCountryCode: 'D<<'})});
  assert.equal(saved.fields.nationalityCode, 'DEU');
  assert.equal(saved.fields.issuingCountryCode, 'DEU');
  assert.equal(saved.issues.some(item => item.code === 'CASE_FACT_MISMATCH'), false);
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
  const original = fixture();
  original.c.applicants[0] = {nationalityCode: 'D<<', documentType: 'passport'};
  verify(original.c);
  assert.equal(original.workflow.get(CUSTOMER).blockedReason, undefined);
  assert.equal(original.workflow.get(CUSTOMER).defaults.entries, 'multiple');
});

test('a negative GCC residence declaration blocks this route, and flight suggestions never supply missing actual travel', () => {
  const f = fixture();
  let saved = prepare(f, {fields: applicant({gccResident: false, transport: null, arrivalPort: null})});
  assert.equal(saved.defaults.transport, 'air');
  assert.equal(saved.fields.transport, undefined);
  assert.equal(saved.fields.arrivalPort, undefined);
  assert.ok(saved.missing.includes('transport'));
  assert.ok(saved.missing.includes('arrivalPort'));
  assert.ok(saved.issues.some(item => item.code === 'GCC_RESIDENCE_REQUIRED'));
  assert.equal(review(f, saved).state, 'needs_information');
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, fields: {transport: 'air', arrivalPort: 'Confirmed synthetic airport'}, confirm: true});
  assert.equal(review(f, saved).state, 'needs_information');
});

test('GCC pledge facts require explicit declarations and are never inferred or accepted as legal consent', () => {
  const f = fixture();
  const fields = applicant();
  delete fields.priorGccDeportation;
  delete fields.priorGccRuleViolation;
  const saved = prepare(f, {fields});
  assert.equal(saved.state, 'needs_information');
  for (const field of ['priorGccDeportation', 'priorGccRuleViolation']) {
    assert.equal(Object.hasOwn(saved.fields, field), false);
    assert.equal(Object.hasOwn(saved.defaults, field), false);
    assert.ok(saved.missing.includes(field));
    assert.ok(saved.issues.some(item => item.field === field && item.code === 'explicit_boolean_required'));
    assert.throws(() => f.workflow.prepare(CUSTOMER, {expectedRevision: 1, fields: {[field]: 'false'}, confirm: true}), {code: 'RAAD_FIELDS_INVALID'});
  }
  assert.equal(review(f, saved).state, 'needs_information');
  assert.equal(f.c.submissionStatus, 'not_submitted');
  assert.equal(f.c.staffVerification.decision, undefined);
  assert.equal(f.c.staffVerification.submission, undefined);
  assert.doesNotMatch(JSON.stringify(f.store.data.raadApplications), /"(?:automaticAccept|legalConsent|pledgeAccepted)"/);
});

test('a true GCC declaration requires staff applicability review and invalidates previous draft review', () => {
  for (const field of ['priorGccDeportation', 'priorGccRuleViolation']) {
    const f = fixture();
    const parent = structuredClone(f.c);
    const ready = review(f, prepare(f));
    assert.equal(ready.state, 'ready_for_portal_review');
    const changed = f.workflow.prepare(CUSTOMER, {expectedRevision: ready.revision, fields: {[field]: true}, confirm: true});
    assert.equal(changed.revision, 3);
    assert.equal(changed.state, 'needs_information');
    assert.equal(changed.fields[field], true);
    assert.equal(changed.review.complete, false);
    assert.deepEqual(changed.review.confirmedFields, []);
    assert.ok(changed.reviewRequiredFields.includes('fields.' + field));
    assert.ok(changed.issues.some(item => item.field === field && item.code === 'APPLICANT_PLEDGE_REQUIRES_REVIEW'));
    assert.throws(() => review(f, ready), {code: 'RAAD_REVISION_CONFLICT'});
    const reviewed = review(f, changed);
    assert.equal(reviewed.state, 'needs_information');
    assert.equal(reviewed.review.scope, 'staff_data_review');
    assert.equal(reviewed.portal.connected, false);
    assert.deepEqual(f.c, parent);
    const corrected = f.workflow.prepare(CUSTOMER, {expectedRevision: reviewed.revision, fields: {[field]: false}, confirm: true});
    assert.equal(corrected.state, 'draft');
    assert.equal(corrected.review.complete, false);
    assert.deepEqual(corrected.review.confirmedFields, []);
    assert.equal(review(f, corrected).state, 'ready_for_portal_review');
  }
});

test('Umrah, travel documents, suspended and unknown products cannot be coerced into tourist drafts', () => {
  for (const options of [{nationality: 'العراق'}, {nationality: 'لبنان', documentType: 'travel_document'}, {nationality: 'أفغانستان'}, {nationality: 'unverified-country'}]) {
    const f = fixture(options);
    assert.equal(f.workflow.get(CUSTOMER).blockedReason, 'RAAD_TOURIST_CASE_REQUIRED');
    assert.throws(() => prepare(f, {fields: applicant({nationalityCode: 'SYR', visitPurpose: 'tourism'})}), {code: 'RAAD_TOURIST_CASE_REQUIRED'});
    assert.equal(f.saves(), 0);
  }
  const f = fixture();
  const saved = prepare(f, {fields: applicant({visitPurpose: 'umrah'})});
  assert.ok(saved.issues.some(item => item.code === 'TOURIST_ONLY'));
  assert.equal(review(f, saved).state, 'needs_information');
});

test('an issued guardian visa reference is required for minors; a prepared parent is insufficient', () => {
  const f = fixture();
  const minor = applicant({birthDate: '2015-04-03', issueDate: '2025-01-01', emiratesId: '784201500000001', guardian: {relationship: 'father', status: 'prepared', visaReference: 'synthetic-draft'}});
  let saved = prepare(f, {fields: minor});
  assert.equal(saved.isMinor, true);
  assert.ok(saved.issues.some(item => item.field === 'guardian.status' && item.code === 'issued_guardian_visa_required'));
  assert.equal(review(f, saved).state, 'needs_information');
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, fields: {guardian: {status: 'issued', visaReference: null}}, confirm: true});
  assert.ok(saved.issues.some(item => item.code === 'guardian_reference_required'));
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 3, fields: {guardian: {status: 'issued', visaReference: 'synthetic-issued-visa-reference'}}, confirm: true});
  assert.ok(saved.reviewRequiredFields.includes('fields.guardian.visaReference'));
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
});

test('parent facts and case evidence changes invalidate review without writes in get', () => {
  const f = fixture();
  review(f, prepare(f));
  const saves = f.saves();
  f.c.applicants[0].nationality = 'مصر';
  const before = JSON.stringify(f.store.data.raadApplications);
  const stale = f.workflow.get(CUSTOMER);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.review.complete, false);
  assert.deepEqual(stale.review.confirmedFields, []);
  assert.equal(f.saves(), saves);
  assert.equal(JSON.stringify(f.store.data.raadApplications), before);
  assert.throws(() => review(f, stale), {code: 'RAAD_APPLICATION_STALE'});
  const rebased = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, confirm: true});
  assert.equal(rebased.fields.nationalityCode, 'EGY');
  assert.equal(rebased.defaults.entries, 'single');
  assert.ok(rebased.issues.some(item => item.code === 'PAYMENT_NOT_VERIFIED'));
  assert.equal(rebased.review.complete, false);
  verify(f.c);
  assert.equal(f.workflow.get(CUSTOMER).state, 'stale');
});

test('selected document content and metadata changes invalidate review, including protected checksums', () => {
  for (const mutate of [record => record.checksum = 'different-synthetic-content', record => record.size++, record => record.mimeType = 'image/png', record => record.needsVisualReview = true, record => record.expiresAt = NOW - 1]) {
    const f = fixture();
    review(f, prepare(f));
    mutate(f.records[IDS.passport]);
    assert.equal(f.workflow.get(CUSTOMER).state, 'stale');
    assert.equal(f.workflow.get(CUSTOMER).review.complete, false);
    assert.equal(f.saves(), 2);
  }
});

test('derived images have their own exact job review without changing the parent evidence', () => {
  const f = fixture();
  Object.assign(f.records[IDS.derived], {purpose: 'raad_portal_upload', sourceIds: [IDS.passport], needsVisualReview: true});
  const parent = structuredClone(f.c);
  const saved = prepare(f, {documents: {passport: IDS.derived, residence: IDS.residence, photo: IDS.photo}});
  assert.equal(saved.state, 'draft');
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
  assert.deepEqual(f.c, parent);
  assert.equal(f.records[IDS.derived].needsVisualReview, true);
  f.records[IDS.derived].sourceIds = [IDS.photo];
  assert.equal(f.workflow.get(CUSTOMER).state, 'stale');
});

test('only owned JPEG and PNG media up to the decimal byte limit can become ready', () => {
  const f = fixture();
  f.records[IDS.passport].customer = 'other-customer';
  assert.throws(() => prepare(f), {code: 'RAAD_DOCUMENT_UNAVAILABLE'});
  assert.equal(f.saves(), 0);
  f.records[IDS.passport].customer = CUSTOMER;
  f.records[IDS.passport].mimeType = 'application/pdf';
  f.records[IDS.photo].size = 1000001;
  let saved = prepare(f);
  assert.ok(saved.issues.some(item => item.code === 'DOCUMENT_FORMAT_INVALID'));
  assert.ok(saved.issues.some(item => item.code === 'DOCUMENT_SIZE_INVALID'));
  assert.equal(review(f, saved).state, 'needs_information');
  f.records[IDS.passport].mimeType = 'image/png';
  f.records[IDS.photo].size = 1000000;
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, confirm: true});
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
});

test('current exact payment and original document review evidence remain mandatory', () => {
  const f = fixture({evidence: false});
  let saved = prepare(f);
  assert.equal(review(f, saved).state, 'needs_information');
  verify(f.c);
  f.c.staffVerification.payment.amount = 1;
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, confirm: true});
  assert.ok(saved.issues.some(item => item.code === 'PAYMENT_NOT_VERIFIED'));
  assert.equal(review(f, saved).state, 'needs_information');
  f.c.staffVerification.payment.amount = 700;
  saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 4, confirm: true});
  assert.equal(review(f, saved).state, 'ready_for_portal_review');
  f.c.paymentStatus = 'unverified';
  assert.equal(f.workflow.get(CUSTOMER).state, 'stale');
});

test('submission, a recorded decision, unresolved amendments and active complaints reject mutations', () => {
  const scenarios = [
    [f => f.c.submissionStatus = 'submitted', 'RAAD_CASE_ALREADY_PROCESSED'],
    [f => f.c.staffVerification.decision = {value: 'approved', reference: 'synthetic-official-reference'}, 'RAAD_CASE_ALREADY_PROCESSED'],
    [f => f.c.pendingAmendment = {facts: {applicantCount: 2}}, 'RAAD_CASE_AMENDMENT_PENDING'],
    [f => f.store.data.complaints = [{customer: CUSTOMER, state: 'claimed'}], 'RAAD_COMPLAINT_ACTIVE'],
    [f => f.store.data.conversationJournal = {customers: {[CUSTOMER]: {complaintPending: 'synthetic-complaint'}}}, 'RAAD_COMPLAINT_ACTIVE']
  ];
  for (const [mutate, code] of scenarios) {
    const f = fixture();
    const saved = prepare(f);
    mutate(f);
    assert.equal(f.workflow.get(CUSTOMER).blockedReason, code);
    assert.throws(() => f.workflow.prepare(CUSTOMER, {expectedRevision: saved.revision, confirm: true}), {code});
    assert.throws(() => review(f, saved), {code});
    assert.equal(f.saves(), 1);
  }
});

test('applicant jobs are isolated and a replacement case cannot inherit identity documents', () => {
  const f = fixture({count: 2});
  const first = prepare(f);
  const second = prepare(f, {applicantIndex: 1, fields: applicant({latinFirstName: 'Second'})});
  assert.notEqual(first.jobId, second.jobId);
  assert.equal(f.workflow.get(CUSTOMER).fields.latinFirstName, 'Synthetic');
  assert.equal(f.workflow.get(CUSTOMER, {applicantIndex: 1}).fields.latinFirstName, 'Second');
  for (const applicantIndex of ['0', -1, 2, 0.2, NaN]) assert.throws(() => f.workflow.get(CUSTOMER, {applicantIndex}), {code: 'RAAD_APPLICANT_INDEX_INVALID'});
  f.c.id = 'replacement-case';
  assert.equal(f.workflow.get(CUSTOMER).state, 'stale');
  const replacement = f.workflow.prepare(CUSTOMER, {expectedRevision: 1, confirm: true});
  assert.notEqual(replacement.jobId, first.jobId);
  assert.equal(replacement.fields.latinFirstName, undefined);
  assert.deepEqual(replacement.documents, {});
  assert.equal(replacement.revision, 2);
});

test('facts use a strict bounded allowlist and never retain raw MRZ or authorization data', () => {
  const f = fixture();
  for (const fields of [{otp: '123456'}, {mrz: 'P<SYNTHETIC'}, {privacyAccepted: true}, {health: {hospitalizedOrEmergency: 'false'}}, {guardian: {cookie: 'synthetic'}}, {latinFirstName: 'A'.repeat(201)}, {latinFirstName: 'line\nbreak'}]) {
    assert.throws(() => prepare(f, {fields}), error => /^RAAD_FIELD/.test(error.code));
    assert.equal(f.saves(), 0);
  }
  assert.throws(() => prepare(f, {documents: {passport: IDS.passport, otp: '123456'}}), {code: 'RAAD_DOCUMENTS_INVALID'});
  assert.throws(() => f.workflow.get('missing-case'), {code: 'VISA_CASE_NOT_FOUND'});
  assert.throws(() => f.workflow.get('__proto__'), {code: 'INVALID_CUSTOMER'});
});

test('saving a changed field invalidates every old review and failed saves roll back memory', () => {
  const f = fixture();
  review(f, prepare(f));
  const edited = f.workflow.prepare(CUSTOMER, {expectedRevision: 2, fields: {latinFirstName: 'Corrected'}, confirm: true});
  assert.equal(edited.state, 'draft');
  assert.equal(edited.review.complete, false);
  assert.deepEqual(edited.review.confirmedFields, []);
  const before = structuredClone(f.store.data.raadApplications);
  f.store.save = () => { throw Error('synthetic-write-failure'); };
  assert.throws(() => f.workflow.prepare(CUSTOMER, {expectedRevision: 3, fields: {latinFirstName: 'Unsaved'}, confirm: true}), /synthetic-write-failure/);
  assert.deepEqual(f.store.data.raadApplications, before);
});
