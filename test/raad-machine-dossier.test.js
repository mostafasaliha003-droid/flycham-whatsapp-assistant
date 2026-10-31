'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {RaadVisaWorkflow, verifyMachineDossier} = require('../src/raad-visa-workflow');
const {reconcileDocumentEvidence} = require('../src/visa-document-matching');
const {visaCaseSignature, currentVisaEvidence} = require('../src/visa-case-signature');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CUSTOMER = '15550001201', OTHER = '15550001202';
const NOW = Date.parse('2026-10-28T10:00:00Z');
const IDS = Object.fromEntries(['passportSource', 'residenceSource', 'photoSource', 'passport', 'residence', 'photo', 'evidence'].map((kind, index) => [kind, `35000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const sha = value => createHash('sha256').update(value).digest('hex');
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value === undefined ? null : value; }
const hash = value => sha(JSON.stringify(canonical(value)));
function digit(value) { return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10); }
function mrz() {
  const first = 'P<EGYEXAMPLE<<SYNTHETIC'.padEnd(44, '<'), number = 'N12345678', birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const body = number + digit(number) + 'EGY' + birth + digit(birth) + 'F' + expiry + digit(expiry) + optional + digit(optional);
  return [first, body + digit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43))];
}
const DOC_FIELDS = {nationalityCode: 'EGY', passportNumber: 'N12345678', passportType: 'ordinary', issuingCountryCode: 'EGY', issueDate: '2025-01-01', expiryDate: '2031-01-01', birthDate: '1990-01-15', birthPlace: 'Synthetic City', sex: 'F', latinFirstName: 'Synthetic', latinFamilyName: 'Example'};
const CLIENT_FIELDS = {maritalStatus: 'single', previousNationality: false, travelledLastFiveYears: false, performUmrah: false, gccResident: true, priorGccDeportation: false, priorGccRuleViolation: false, saudiAddress: 'Fictitious hotel, Riyadh', health: {hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false}};
const CONTACTS = {RAAD_APPLICATION_PHONE: '+15550001210', RAAD_CONTACT_EMAIL: 'visa@example.test', RAAD_INSURANCE_PHONE: '+15550001211', RAAD_POSTAL_CODE: '00000'};
const extraction = (kind, fields = {}, extra = {}) => ({version: 1, kind, readable: true, rotation: 0, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {value, visible: true, confidence: 0.999}])), mrzLines: kind === 'passport' ? mrz() : [], portraitBox: null, ...extra});
function fixture({canAutomate = () => true, gaps = [], cropPhoto = false, mrzProfiles = null} = {}) {
  const c = {id: 'fictitious-machine-case', policyVersion: 'fictitious-policy', revision: 4, applicantCount: 1, applicants: [{nationality: 'مصر', documentType: 'passport'}], quote: {total: 240}, documents: [], paymentStatus: 'verified', submissionStatus: 'not_submitted'};
  c.staffVerification = {payment: {amount: 240, reference: 'BANK-MACHINE-EXAMPLE', caseSignature: visaCaseSignature(c)}};
  let saves = 0;
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {}}, save() { saves++; }};
  const bytes = new Map();
  function put(id, label, raw = {}) {
    const value = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from(label)]); bytes.set(id, value);
    store.data.visaMedia[id] = {id, customer: CUSTOMER, mimeType: 'image/jpeg', size: value.length, checksum: sha(value), receivedAt: NOW - 1000, expiresAt: NOW + 86400000, status: 'pending_review', ...raw};
  }
  put(IDS.passportSource, 'original-passport'); put(IDS.residenceSource, 'original-residence'); put(IDS.photoSource, 'original-photo');
  put(IDS.passport, 'prepared-passport', {purpose: 'raad_portal_upload', kind: 'passport', sourceIds: [IDS.passportSource]});
  put(IDS.residence, 'prepared-residence', {purpose: 'raad_portal_upload', kind: 'residence', sourceIds: [IDS.residenceSource]});
  put(IDS.photo, 'prepared-photo', {purpose: 'raad_portal_upload', kind: 'photo', sourceIds: [cropPhoto ? IDS.passportSource : IDS.photoSource]});
  const mediaStore = {
    get(id, {customer}) { const value = store.data.visaMedia[id]; if (!value || value.customer !== customer || value.expiresAt <= NOW) throw Error('MEDIA_NOT_FOUND'); const {checksum, ...metadata} = value; return structuredClone(metadata); },
    read(id, {customer}) { return {metadata: this.get(id, {customer}), bytes: Buffer.from(bytes.get(id))}; }
  };
  const passportFields = Object.fromEntries(Object.entries(DOC_FIELDS).filter(([key]) => !gaps.includes(key)));
  // This complete ORIGINAL-page fixture separately labels Passport No. Keep
  // that private observation out of DOC_FIELDS and client/manual proofs.
  if (!gaps.includes('passportNumber') && !gaps.includes('visiblePassportNumber')) passportFields.visiblePassportNumber = DOC_FIELDS.passportNumber;
  const documents = [
    {mediaId: IDS.passportSource, page: 1, sha256: sha('passport-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.passportSource].checksum, extraction: extraction('passport', passportFields, cropPhoto ? {portraitBox: {x: 0.1, y: 0.2, width: 0.2, height: 0.3, confidence: 0.999}} : {})},
    {mediaId: IDS.residenceSource, page: 1, sha256: sha('residence-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.residenceSource].checksum, extraction: extraction('uae_id_front', {passportNumber: DOC_FIELDS.passportNumber, birthDate: DOC_FIELDS.birthDate, latinFullName: 'Synthetic Example', emiratesId: '784199000000001', residenceExpiry: '2029-01-01'})},
    ...(!cropPhoto ? [{mediaId: IDS.photoSource, page: 1, sha256: sha('photo-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.photoSource].checksum, extraction: extraction('portrait')}] : [])
  ];
  const matched = reconcileDocumentEvidence({documents, applicants: c.applicants, referenceDate: '2026-10-28'}).applicants[0];
  assert(['ready', 'needs_confirmation'].includes(matched.status), JSON.stringify(matched.issues));
  const app = {id: IDS.evidence, applicantIndex: 0, status: matched.status, clientFieldsRequired: matched.clientFieldsRequired, fields: structuredClone(matched.fields), documents: {passport: IDS.passport, residence: IDS.residence, photo: IDS.photo}, evidence: structuredClone(matched.evidence), sourceManifest: [IDS.passportSource, IDS.residenceSource, ...(!cropPhoto ? [IDS.photoSource] : [])].sort().map(mediaId => ({mediaId, sha256: store.data.visaMedia[mediaId].checksum})), preparedManifest: ['passport', 'residence', 'photo'].map(kind => ({kind, mediaId: IDS[kind], sha256: store.data.visaMedia[IDS[kind]].checksum})), extractionDigest: hash({documents, applicantIndex: 0, fields: matched.fields, matchedDocuments: matched.documents, evidence: matched.evidence})};
  store.data.visaDocumentIntake = {version: 1, cases: {[CUSTOMER]: {caseId: c.id, caseSignature: visaCaseSignature(c), generation: 1, status: matched.status, documents, applicants: [app]}}};
  const workflow = new RaadVisaWorkflow({store, mediaStore, mrzProfiles, now: () => NOW, env: CONTACTS, canAutomate});
  const verify = () => verifyMachineDossier({store, mediaStore, mrzProfiles, customer: CUSTOMER, applicantIndex: 0, expectedCaseSignature: visaCaseSignature(c), evidenceId: IDS.evidence, now: () => NOW});
  const apply = options => workflow.applyMachineDossier(CUSTOMER, {applicantIndex: 0, expectedRevision: 0, expectedCaseSignature: visaCaseSignature(c), evidenceId: IDS.evidence, ...options});
  function proof(patch = {}) {
    const verified = verify(), documentEvidence = {id: IDS.evidence, evidenceFingerprint: verified.evidenceFingerprint};
    const fields = {...DOC_FIELDS, emiratesId: '784199000000001', residenceExpiry: '2029-01-01', ...structuredClone(CLIENT_FIELDS), ...patch};
    const confirmation = {granted: true, at: NOW, grantedAt: NOW, scope: 'saudi_visa_application', sender: CUSTOMER, messageId: 'fictitious-confirmation-message', caseSignature: visaCaseSignature(c), documentEvidence};
    const job = {id: 'machine-client-job', customer: CUSTOMER, caseId: c.id, caseSignature: visaCaseSignature(c), applicantIndex: 0, approvalId: 'machine-approval', revision: 5, state: 'ready', confirmedFields: fields, answerConfirmation: confirmation, documentFacts: {evidenceId: IDS.evidence, evidenceFingerprint: verified.evidenceFingerprint}};
    const approval = {id: 'machine-approval', state: 'approved', caseId: c.id, caseSignature: visaCaseSignature(c), paymentFingerprint: sha(JSON.stringify(c.staffVerification.payment))};
    store.data.visaFulfilment = {jobs: {[job.id]: job}, cases: {[CUSTOMER]: {activeApprovalId: approval.id, approvals: {[approval.id]: approval}}}};
    return {complete: true, jobId: job.id, jobRevision: job.revision, customer: CUSTOMER, caseId: c.id, caseSignature: visaCaseSignature(c), applicantIndex: 0, fields: structuredClone(fields), confirmation: structuredClone(confirmation), documentEvidence, proof: 'f'.repeat(64)};
  }
  return {store, c, app, bytes, mediaStore, workflow, verify, apply, proof, saves: () => saves};
}

test('machine verification binds exact source/prepared media and matches documents without changing financial or staff truth', () => {
  const f = fixture(), before = structuredClone(f.c), verification = f.verify();
  assert.equal(verification.ready, true); assert.equal(verification.evidenceId, IDS.evidence); assert.match(verification.evidenceFingerprint, /^[a-f0-9]{64}$/);
  const applied = f.apply(); assert.equal(applied.ok, true); assert.equal(applied.machineReview.scope, 'machine_document_consistency'); assert.equal(applied.machineReview.authenticityVerified, false);
  const raw = f.store.data.raadApplications[CUSTOMER].applicants[0];
  assert.equal(raw.review.scope, 'staff_data_review'); assert.deepEqual(raw.review.confirmedFields, []); assert.equal(raw.review.reviewedAt, undefined);
  assert.equal(raw.fields.health, undefined); assert.equal(raw.fields.maritalStatus, undefined); assert.equal(raw.fields.gccResident, undefined);
  assert.deepEqual(f.c, before); assert.equal(currentVisaEvidence(f.c).payment, true); assert.equal(currentVisaEvidence(f.c).documents, false);
  assert.equal(f.apply({expectedRevision: 1}).duplicate, true); assert.equal(f.saves(), 1);
});

test('machine apply fails closed without automation permission and never overwrites manual drafts or staff edits', () => {
  const disabled = fixture({canAutomate: undefined}); disabled.workflow.canAutomate = () => false;
  assert.throws(() => disabled.apply(), {code: 'RAAD_MACHINE_AUTOMATION_PAUSED'}); assert.equal(disabled.store.data.raadApplications, undefined);
  const f = fixture(); f.workflow.prepare(CUSTOMER, {expectedRevision: 0, fields: {latinFirstName: 'Manual'}, confirm: true});
  const before = structuredClone(f.store.data.raadApplications);
  assert.throws(() => f.apply({expectedRevision: 1}), {code: 'RAAD_MANUAL_DRAFT_PROTECTED'}); assert.deepEqual(f.store.data.raadApplications, before);
  const edited = fixture(); edited.apply(); edited.workflow.prepare(CUSTOMER, {expectedRevision: 1, fields: {birthPlace: 'Staff correction'}, confirm: true});
  assert.throws(() => edited.apply({expectedRevision: 2}), {code: 'RAAD_MANUAL_DRAFT_PROTECTED'});
});

test('ready and identity-ready dossiers require exact CAS, paid case, finalized intake and current evidence UUID', () => {
  for (const patch of [f => { f.store.data.visaDocumentIntake.cases[CUSTOMER].status = 'processing'; }, f => { f.c.paymentStatus = 'unverified'; }, f => { f.app.status = 'needs_review'; }, f => { f.app.id = IDS.photo; }, f => { f.store.data.visaDocumentIntake.cases[CUSTOMER].caseSignature = 'f'.repeat(64); }]) {
    const f = fixture(); patch(f); assert.equal(f.verify().ready, false); assert.equal(f.store.data.raadApplications, undefined);
  }
  const f = fixture(); assert.throws(() => f.apply({expectedRevision: 1}), {code: 'RAAD_REVISION_CONFLICT'}); assert.throws(() => f.apply({expectedCaseSignature: 'f'.repeat(64)}), {code: 'RAAD_CASE_SIGNATURE_CONFLICT'});
});

test('byte changes, owner swaps, expiry, metadata-only flags and lineage changes cannot reuse machine evidence', () => {
  const mutations = [
    f => { f.bytes.set(IDS.passportSource, Buffer.from('changed raw source')); },
    f => { f.bytes.set(IDS.passport, Buffer.from('changed prepared image')); },
    f => { f.store.data.visaMedia[IDS.passport].customer = OTHER; },
    f => { f.store.data.visaMedia[IDS.photo].expiresAt = NOW; },
    f => { f.store.data.visaMedia[IDS.residence].kind = 'passport'; },
    f => { f.store.data.visaMedia[IDS.photo].purpose = 'raad_pdf_preview'; },
    f => { f.store.data.visaMedia[IDS.residence].sourceIds = [IDS.passportSource]; },
    f => { f.app.preparedManifest[0].sha256 = 'f'.repeat(64); },
    f => { f.app.sourceManifest[0].sha256 = 'f'.repeat(64); },
    f => { f.app.evidence.passportMrzChecked = false; },
    f => { f.app.fields.passportNumber = 'FAKE123'; },
    f => { f.app.extractionDigest = 'f'.repeat(64); }
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.equal(f.verify().ready, false); }
});

test('matcher is rerun so forged ready flags and snapshot hashes cannot restore conflicting identity', () => {
  const f = fixture(), record = f.store.data.visaDocumentIntake.cases[CUSTOMER];
  record.documents[1].extraction.fields.passportNumber.value = 'OTHER1234';
  const matched = reconcileDocumentEvidence({documents: record.documents, applicants: f.c.applicants, referenceDate: '2026-10-28'}).applicants[0];
  f.app.extractionDigest = hash({documents: record.documents, applicantIndex: 0, fields: matched.fields, matchedDocuments: matched.documents, evidence: matched.evidence});
  f.app.fields = matched.fields; f.app.evidence = matched.evidence; f.app.status = 'ready';
  assert.equal(f.verify().ready, false);
});

test('prepared passport portrait crop is accepted only for an exact matched source with a clear in-bounds rectangle', () => {
  const f = fixture({cropPhoto: true}); assert.equal(f.verify().ready, true);
  f.store.data.visaDocumentIntake.cases[CUSTOMER].documents[0].extraction.portraitBox.confidence = 0.5;
  assert.equal(f.verify().ready, false);
});

test('machine portal dossier merges trusted policy defaults with explicit current client consent and keeps staff evidence untouched', () => {
  const f = fixture(); f.apply(); const proof = f.proof(), before = JSON.stringify(f.store.data), result = f.workflow.portalDossier(CUSTOMER, {clientProof: proof});
  assert.equal(result.ready, true, JSON.stringify(result.issues)); assert.equal(result.source, 'machine'); assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.fields.transport, 'air'); assert.equal(result.fields.arrivalPort, 'مطار الملك خالد الدولي'); assert.equal(result.fields.entryDate, '2026-11-12');
  assert.equal(result.fields.entries, 'single'); assert.equal(result.fields.visaValidityDays, 90); assert.equal(result.fields.health.hospitalizedOrEmergency, false);
  assert.equal(JSON.stringify(f.store.data), before); assert.equal(currentVisaEvidence(f.c).documents, false);
});

test('portal requires live bound client authorization and exact document evidence, not a forged complete flag', () => {
  const mutations = [
    proof => { proof.jobRevision++; },
    proof => { proof.confirmation.granted = false; },
    proof => { proof.confirmation.scope = 'other'; },
    proof => { proof.confirmation.messageId = null; },
    proof => { proof.confirmation.sender = OTHER; },
    proof => { proof.fields.health.hospitalizedOrEmergency = undefined; },
    proof => { proof.documentEvidence.evidenceFingerprint = 'f'.repeat(64); },
    proof => { proof.applicantIndex = 1; }
  ];
  for (const mutate of mutations) { const f = fixture(); f.apply(); const proof = f.proof(); mutate(proof); const result = f.workflow.portalDossier(CUSTOMER, {clientProof: proof}); assert.equal(result.ready, false); assert(result.issues.some(value => value.code === 'RAAD_CLIENT_CONSENT_REQUIRED')); }
  const f = fixture(); f.apply(); const proof = f.proof(); delete f.store.data.visaFulfilment.jobs[proof.jobId]; assert.equal(f.workflow.portalDossier(CUSTOMER, {clientProof: proof}).ready, false);
});

test('client-confirmed GCC No, document conflicts, unsafe visa products and contact mistakes remain blocked', () => {
  for (const [patch, expected] of [[{gccResident: false}, 'GCC_RESIDENCE_REQUIRED'], [{passportNumber: 'CHANGED99'}, 'DOCUMENT_DATA_CONFLICT'], [{visitPurpose: 'work'}, 'TOURIST_ONLY'], [{entries: 'multiple'}, 'OFFICE_POLICY_MISMATCH'], [{contactEmail: 'not-an-email'}, 'CONTACT_INVALID'], [{priorGccDeportation: true}, 'APPLICANT_PLEDGE_REQUIRES_REVIEW']]) {
    const f = fixture(); f.apply(); const proof = f.proof(patch), result = f.workflow.portalDossier(CUSTOMER, {clientProof: proof}); assert.equal(result.ready, false); assert(result.issues.some(value => value.code === expected), JSON.stringify(result.issues));
  }
});

test('only optional nonidentity gaps may be client-confirmed while exact document evidence stays stable', () => {
  const f = fixture({gaps: ['passportType', 'issueDate', 'birthPlace']}), verified = f.verify();
  assert.equal(verified.ready, true); assert.deepEqual(verified.clientFieldsRequired, ['passportType', 'issueDate', 'birthPlace']);
  assert.equal(verified.fields.passportType, undefined); f.apply();
  const incomplete = f.proof(); delete incomplete.fields.passportType; delete f.store.data.visaFulfilment.jobs[incomplete.jobId].confirmedFields.passportType;
  const blocked = f.workflow.portalDossier(CUSTOMER, {clientProof: incomplete}); assert.equal(blocked.ready, false); assert(blocked.issues.some(value => value.code === 'RAAD_CLIENT_DOCUMENT_FACTS_REQUIRED'));
  const complete = f.proof(), allowed = f.workflow.portalDossier(CUSTOMER, {clientProof: complete}); assert.equal(allowed.ready, true, JSON.stringify(allowed.issues)); assert.equal(f.verify().evidenceFingerprint, verified.evidenceFingerprint);
});

test('execution fingerprint changes with current client answers or configured defaults and stales after any source mutation', () => {
  const f = fixture(); f.apply(); const first = f.workflow.portalDossier(CUSTOMER, {clientProof: f.proof()}), second = f.workflow.portalDossier(CUSTOMER, {clientProof: f.proof({saudiAddress: 'Another confirmed address'})});
  assert.equal(first.ready, true); assert.equal(second.ready, true); assert.notEqual(first.fingerprint, second.fingerprint);
  f.workflow.env.RAAD_CONTACT_EMAIL = 'updated@example.test'; const third = f.workflow.portalDossier(CUSTOMER, {clientProof: f.proof()}); assert.equal(third.ready, true); assert.notEqual(first.fingerprint, third.fingerprint);
  f.bytes.set(IDS.passportSource, Buffer.from('changed input'));
  const stale = f.workflow.portalDossier(CUSTOMER, {clientProof: f.proof()}); assert.equal(stale.ready, false); assert(stale.issues.some(value => value.code === 'RAAD_MACHINE_EVIDENCE_STALE'));
});

test('failed machine save restores previous draft state and does not mutate the case', () => {
  const f = fixture(), before = structuredClone(f.c); f.store.save = () => { throw Error('fictitious disk failure'); };
  assert.throws(() => f.apply(), /fictitious disk failure/); assert.equal(f.store.data.raadApplications, undefined); assert.deepEqual(f.c, before);
});

test('journal ownership and blocking pause machine apply and portal execution even when hook incorrectly permits it', () => {
  for (const [flags, code] of [[{operatorOwned: true}, 'RAAD_HUMAN_OWNERSHIP'], [{blocked: true}, 'RAAD_CUSTOMER_BLOCKED'], [{whatsappBlocked: true}, 'RAAD_CUSTOMER_BLOCKED'], [{whatsappBlockState: 'uncertain'}, 'RAAD_CUSTOMER_BLOCKED']]) {
    const f = fixture(); f.apply(); const proof = f.proof();
    f.store.data.conversationJournal = {customers: {[CUSTOMER]: flags}};
    assert.throws(() => f.apply({expectedRevision: 1}), {code});
    const result = f.workflow.portalDossier(CUSTOMER, {clientProof: proof}); assert.equal(result.ready, false); assert(result.issues.some(value => value.code === code));
  }
});

test('legacy staff dossier also refuses execution during human ownership while legacy review remains intact', () => {
  const f = fixture();
  f.c.staffVerification.documentsReviewed = true; f.c.staffVerification.documentsSignature = visaCaseSignature(f.c);
  const fields = {...DOC_FIELDS, emiratesId: '784199000000001', residenceExpiry: '2029-01-01', ...structuredClone(CLIENT_FIELDS), transport: 'air', arrivalPort: 'Synthetic airport', entryDate: '2026-11-12'};
  const saved = f.workflow.prepare(CUSTOMER, {expectedRevision: 0, fields, documents: {passport: IDS.passport, residence: IDS.residence, photo: IDS.photo}, confirm: true});
  f.workflow.review(CUSTOMER, {expectedRevision: saved.revision, confirmedFields: saved.reviewRequiredFields, confirm: true});
  const proof = f.proof(); proof.documentEvidence = null; proof.confirmation.documentEvidence = null;
  const live = f.store.data.visaFulfilment.jobs[proof.jobId]; delete live.documentFacts; live.answerConfirmation = structuredClone(proof.confirmation);
  const ready = f.workflow.portalDossier(CUSTOMER, {clientProof: proof}); assert.equal(ready.ready, true, JSON.stringify(ready.issues)); assert.equal(ready.source, 'staff');
  f.store.data.conversationJournal = {customers: {[CUSTOMER]: {operatorOwned: true}}};
  assert.equal(f.workflow.portalDossier(CUSTOMER, {clientProof: proof}).ready, false);
  assert.equal(f.workflow.get(CUSTOMER).review.complete, true, 'staff review itself is not erased by a temporary claim');
});

test('verified facts add to an unreviewed staff draft without replacing supplied facts or asserting staff review',()=>{
 const f=fixture({gaps:['passportType','issueDate']});f.workflow.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary',issueDate:'2025-01-01'},confirm:true});const before=structuredClone(f.c);
 const result=f.apply({expectedRevision:1});assert.equal(result.staffReviewRequired,true);assert.equal(result.machineReview,undefined);
 const raw=f.store.data.raadApplications[CUSTOMER].applicants[0];assert.equal(raw.fields.passportType,'ordinary');assert.equal(raw.fields.issueDate,'2025-01-01');assert.equal(raw.fields.passportNumber,DOC_FIELDS.passportNumber);assert.equal(raw.documents.passport.mediaId,IDS.passport);assert.deepEqual(raw.review.confirmedFields,[]);assert.equal(raw.review.reviewedAt,undefined);assert.deepEqual(f.c,before);
 assert.equal(f.apply({expectedRevision:2}).duplicate,true);assert.equal(f.store.data.raadApplications[CUSTOMER].applicants[0].revision,2);
});
test('staff-reviewed drafts and contradictory manual or document choices remain protected',()=>{
 const f=fixture();f.workflow.prepare(CUSTOMER,{expectedRevision:0,fields:{passportNumber:'OTHER'},confirm:true});const prior=structuredClone(f.store.data.raadApplications);assert.throws(()=>f.apply({expectedRevision:1}),{code:'RAAD_MANUAL_DRAFT_PROTECTED'});assert.deepEqual(f.store.data.raadApplications,prior);
 const g=fixture();g.workflow.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary'},confirm:true});g.store.data.raadApplications[CUSTOMER].applicants[0].review.reviewedAt=NOW;const previous=structuredClone(g.store.data.raadApplications);assert.throws(()=>g.apply({expectedRevision:1}),{code:'RAAD_MANUAL_DRAFT_PROTECTED'});assert.deepEqual(g.store.data.raadApplications,previous);
});

test('stale staff drafts are never carried into current case evidence',()=>{
 const f=fixture();f.workflow.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary'},confirm:true});f.store.data.raadApplications[CUSTOMER].applicants[0].caseSignature='f'.repeat(64);const before=structuredClone(f.store.data.raadApplications);
 assert.throws(()=>f.apply({expectedRevision:1}),{code:'RAAD_MANUAL_DRAFT_PROTECTED'});assert.deepEqual(f.store.data.raadApplications,before);
});

test('payment confirmation refreshes an otherwise unchanged manual draft without marking it staff reviewed',()=>{
 const f=fixture({gaps:['passportType','issueDate']});f.c.paymentStatus='unverified';f.workflow.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary',issueDate:'2025-01-01'},confirm:true});
 f.c.paymentStatus='verified';assert.equal(f.workflow.get(CUSTOMER).state,'stale');const result=f.apply({expectedRevision:1});assert.equal(result.staffReviewRequired,true);const draft=f.workflow.get(CUSTOMER);assert.notEqual(draft.state,'stale');assert.equal(draft.fields.passportType,'ordinary');assert.equal(draft.review.complete,false);assert.equal(f.c.submissionStatus,'not_submitted');
});

function bindProfiledPassport(f){
  const record=f.store.data.visaDocumentIntake.cases[CUSTOMER],document=record.documents.find(item=>item.mediaId===IDS.passportSource),profile={version:1,provider:'openai',consentId:'synthetic-grant',consentDigest:'a'.repeat(64)},binding=hash(profile),jobId='35000000-0000-4000-8000-000000000090';
  document.mrzProfileKey=binding;
  const job={id:jobId,customer:CUSTOMER,caseId:f.c.id,caseSignature:visaCaseSignature(f.c),generation:record.generation,status:'ready',mediaId:IDS.passportSource,sourceSha256:document.sourceSha256,mrzProfile:profile,pages:{1:structuredClone(document)}};
  f.store.data.visaDocumentIntake.jobs={[jobId]:job};
  const matched=reconcileDocumentEvidence({documents:record.documents,applicants:f.c.applicants,referenceDate:'2026-10-28'}).applicants[0];
  f.app.extractionDigest=hash({documents:record.documents,applicantIndex:0,fields:matched.fields,matchedDocuments:matched.documents,evidence:matched.evidence});
  return{job,document,record};
}
test('profiled machine evidence requires exact live approval at apply and final portal acceptance',()=>{
 let approved=true,checks=0;const profiles={guard(binding,context){checks++;assert.equal(context.source,f.store.data.visaMedia[IDS.passportSource]);assert.equal(context.customer,CUSTOMER);assert.equal(context.caseId,f.c.id);assert.equal(context.caseSignature,visaCaseSignature(f.c));return approved;}};
 const f=fixture({mrzProfiles:profiles});bindProfiledPassport(f);assert.equal(f.verify().ready,true);const result=f.apply();assert.equal(result.ok,true);const proof=f.proof();assert.equal(f.workflow.portalDossier(CUSTOMER,{clientProof:proof}).ready,true);approved=false;
 assert.equal(f.verify().ready,false);assert.throws(()=>f.apply({expectedRevision:1}));const portal=f.workflow.portalDossier(CUSTOMER,{clientProof:proof});assert.equal(portal.ready,false);assert(portal.issues.some(item=>item.code==='RAAD_MACHINE_EVIDENCE_STALE'));assert.equal(portal.fingerprint,null);assert(checks>=6);
});
test('profiled cached evidence fails closed for an absent guard, false/void/async approval, missing job or marker',()=>{
 for(const variant of ['missing-guard','false','void','async','missing-job','missing-marker','changed-page','stale-job']){
  const profiles=variant==='missing-guard'?null:{guard:()=>variant==='false'?false:variant==='void'?undefined:variant==='async'?Promise.resolve(true):true},f=fixture({mrzProfiles:profiles}),{job,document}=bindProfiledPassport(f);
  if(variant==='missing-job')f.store.data.visaDocumentIntake.jobs={};if(variant==='missing-marker')delete document.mrzProfileKey;if(variant==='changed-page')job.pages[1].extraction.rotation=90;if(variant==='stale-job')job.status='stale';
  assert.equal(f.verify().ready,false,variant);assert.throws(()=>f.apply(),undefined,variant);assert.equal(f.store.data.raadApplications,undefined,variant);
 }
});
test('a revoked profile cannot become accepted between repeated decrypted-media reads',()=>{
 let approved=true,readCount=0;const f=fixture({mrzProfiles:{guard:()=>approved}});bindProfiledPassport(f);const read=f.mediaStore.read.bind(f.mediaStore);f.mediaStore.read=(...args)=>{if(++readCount===5)approved=false;return read(...args);};assert.equal(f.verify().ready,false);assert.equal(f.store.data.raadApplications,undefined);
});
test('a replaced live profile job cannot reuse the captured verification even with the same valid grant',()=>{
 let checks=0;const f=fixture({mrzProfiles:{guard:()=>{if(++checks===2){const jobs=f.store.data.visaDocumentIntake.jobs,key=Object.keys(jobs)[0];jobs[key]=structuredClone(jobs[key]);}return true;}}});bindProfiledPassport(f);assert.equal(f.verify().ready,false);
});

// Exercise the actual payment-created fulfilment job with the same machine
// evidence used by Raad. Provider transport is synthetic and never leaves this
// process; the fixture's pre-existing verified payment is adopted, not repeated.
async function fulfilmentFixture({mrzProfiles = null, profiled = true} = {}) {
  const f = fixture({mrzProfiles});
  if (profiled) bindProfiledPassport(f);
  let claimed = true, sends = 0;
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false,
    updateVisa() { assert.fail('already verified payment must not be repeated'); }};
  const service = new VisaFulfilment({store: f.store, inbox, mediaStore: f.mediaStore,
    raad: f.workflow, mrzProfiles, canAutomate: () => true, now: () => NOW,
    send: async (_to, _payload, guard) => {
      guard(); sends++; return {messages: [{id: 'synthetic-profile-payment-acceptance'}]};
    }});
  const receiptId = '35000000-0000-4000-8000-000000000099';
  f.store.data.visaMedia[receiptId] = {id: receiptId, customer: CUSTOMER,
    mimeType: 'image/png', size: 20, checksum: sha('synthetic-transfer-receipt'),
    receivedAt: NOW - 1000, expiresAt: NOW + 86400000};
  service.receiveReceipt(CUSTOMER, {receiptId});
  const approved = service.confirmPayment(CUSTOMER, {receiptId, amount: 240,
    reference: 'BANK-MACHINE-EXAMPLE', actor: {id: 'synthetic-accountant', role: 'accountant'},
    actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(f.c),
    idempotencyKey: 'synthetic-profile-approval'});
  const job = service.job(approved.jobs[0].id);
  assert.throws(() => service.guardJob(job.id), {code: 'HUMAN_OWNERSHIP'});
  claimed = false;
  assert.throws(() => service.guardJob(job.id), {code: 'VISA_PAYMENT_NOTICE_UNCONFIRMED'});
  assert.equal((await service.dispatchMessage(job.paymentNoticeId)).state, 'accepted');
  assert.equal(sends, 1); assert.equal(service.guardJob(job.id), job);
  return {...f, service, job, inbox};
}

test('fulfilment stages approved profiled facts with the same live guard as Raad and retains idempotency', async () => {
  let checks = 0, f;
  const profiles = {guard(_profile, context) {
    checks++; assert.equal(context.customer, CUSTOMER);
    assert.equal(context.caseId, f.c.id);
    assert.equal(context.caseSignature, visaCaseSignature(f.c));
    assert.equal(context.source, f.store.data.visaMedia[IDS.passportSource]);
    return true;
  }};
  f = await fulfilmentFixture({mrzProfiles: profiles});
  assert.equal(f.verify().ready, true);
  const before = structuredClone(f.c), result = f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence});
  assert.equal(result.ok, true); assert.equal(result.duplicate, false);
  assert.equal(result.stagedFields.passportNumber, DOC_FIELDS.passportNumber);
  assert.equal(f.service.assertDocumentFactsCurrent(f.job).evidenceFingerprint, result.documentEvidence.evidenceFingerprint);
  assert.equal(f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence}).duplicate, true);
  assert.deepEqual(f.c, before); assert.equal(currentVisaEvidence(f.c).documents, false);
  assert(checks >= 8);
});

test('fulfilment rechecks profile approval after staging and stops downstream questions on revocation', async () => {
  let approved = true;
  const f = await fulfilmentFixture({mrzProfiles: {guard: () => approved}});
  f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence});
  approved = false;
  const before = JSON.stringify(f.store.data);
  assert.equal(f.verify().ready, false);
  assert.throws(() => f.service.assertDocumentFactsCurrent(f.job), {code: 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});
  assert.throws(() => f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence}), {code: 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});
  assert.throws(() => f.service.askQuestions(f.job.id, {fields: ['maritalStatus']}), {code: 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});
  assert.equal(JSON.stringify(f.store.data), before);
});

for (const [variant, profiles] of [
  ['missing', null], ['false', {guard: () => false}], ['void', {guard() {}}],
  ['async', {guard: async () => true}], ['throwing', {guard() { throw Error('synthetic-disabled-profile'); }}]
]) test(`fulfilment refuses profiled facts with ${variant} approval without mutating the job`, async () => {
  const f = await fulfilmentFixture({mrzProfiles: profiles}), before = JSON.stringify(f.store.data);
  assert.equal(f.verify().ready, false);
  assert.throws(() => f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence}), {code: 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});
  assert.equal(JSON.stringify(f.store.data), before); assert.equal(f.job.documentFacts, undefined);
});

test('fulfilment preserves legacy unprofiled facts without requiring or invoking a remote guard', async () => {
  for (const profiles of [null, {guard() { assert.fail('unprofiled evidence must not invoke remote approval'); }}]) {
    const f = await fulfilmentFixture({mrzProfiles: profiles, profiled: false});
    assert.equal(f.verify().ready, true);
    const result = f.service.stageDocumentFacts(f.job.id, {evidenceId: IDS.evidence});
    assert.equal(result.ok, true); assert.equal(f.service.assertDocumentFactsCurrent(f.job).ready, true);
  }
});

test('server composition supplies its shared profile factory to the real fulfilment coordinator', async () => {
  const profiles = {guard: () => true}, f = await fulfilmentFixture({mrzProfiles: profiles});
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const initializer = source.split('\n').find(line => line.startsWith('const visaFulfilment=new VisaFulfilment('));
  assert(initializer, 'current server fulfilment initializer must be present');
  const unexpected = () => assert.fail('composition check must not send, resume or journal anything');
  const context = vm.createContext({VisaFulfilment, assistant: {store: f.store},
    inbox: {isHumanOwned: () => false, isBlocked: () => false}, journal: {}, visaMedia: f.mediaStore,
    raad: f.workflow, mrzProfiles: profiles, process: {env: {}}, orderedDelivery: unexpected,
    visaWhatsApp: {send: unexpected}, visaDispatcher: {resumeOtp: unexpected}});
  vm.runInContext(initializer + '\nthis.composedFulfilment = visaFulfilment;', context);
  const composed = context.composedFulfilment;
  assert.equal(composed.mrzProfiles, profiles);
  // The production initializer uses wall time; this old synthetic dossier has
  // its own fixed reference date, just like the other coordinator fixtures.
  composed.now = () => NOW;
  assert.equal(composed.verifiedDocumentFacts(f.job, IDS.evidence).ready, true);
});
