'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {RaadVisaWorkflow, verifyMachineDossier} = require('../src/raad-visa-workflow');
const {reconcileDocumentEvidence} = require('../src/visa-document-matching');
const {visaCaseSignature, currentVisaEvidence} = require('../src/visa-case-signature');

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
function fixture({canAutomate = () => true, gaps = [], cropPhoto = false} = {}) {
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
  const documents = [
    {mediaId: IDS.passportSource, page: 1, sha256: sha('passport-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.passportSource].checksum, extraction: extraction('passport', passportFields, cropPhoto ? {portraitBox: {x: 0.1, y: 0.2, width: 0.2, height: 0.3, confidence: 0.999}} : {})},
    {mediaId: IDS.residenceSource, page: 1, sha256: sha('residence-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.residenceSource].checksum, extraction: extraction('uae_id_front', {passportNumber: DOC_FIELDS.passportNumber, birthDate: DOC_FIELDS.birthDate, latinFullName: 'Synthetic Example', emiratesId: '784199000000001', residenceExpiry: '2029-01-01'})},
    ...(!cropPhoto ? [{mediaId: IDS.photoSource, page: 1, sha256: sha('photo-ocr-pixels'), sourceSha256: store.data.visaMedia[IDS.photoSource].checksum, extraction: extraction('portrait')}] : [])
  ];
  const matched = reconcileDocumentEvidence({documents, applicants: c.applicants, referenceDate: '2026-10-28'}).applicants[0];
  assert(['ready', 'needs_confirmation'].includes(matched.status), JSON.stringify(matched.issues));
  const app = {id: IDS.evidence, applicantIndex: 0, status: matched.status, clientFieldsRequired: matched.clientFieldsRequired, fields: structuredClone(matched.fields), documents: {passport: IDS.passport, residence: IDS.residence, photo: IDS.photo}, evidence: structuredClone(matched.evidence), sourceManifest: [IDS.passportSource, IDS.residenceSource, ...(!cropPhoto ? [IDS.photoSource] : [])].sort().map(mediaId => ({mediaId, sha256: store.data.visaMedia[mediaId].checksum})), preparedManifest: ['passport', 'residence', 'photo'].map(kind => ({kind, mediaId: IDS[kind], sha256: store.data.visaMedia[IDS[kind]].checksum})), extractionDigest: hash({documents, applicantIndex: 0, fields: matched.fields, matchedDocuments: matched.documents, evidence: matched.evidence})};
  store.data.visaDocumentIntake = {version: 1, cases: {[CUSTOMER]: {caseId: c.id, caseSignature: visaCaseSignature(c), generation: 1, status: matched.status, documents, applicants: [app]}}};
  const workflow = new RaadVisaWorkflow({store, mediaStore, now: () => NOW, env: CONTACTS, canAutomate});
  const verify = () => verifyMachineDossier({store, mediaStore, customer: CUSTOMER, applicantIndex: 0, expectedCaseSignature: visaCaseSignature(c), evidenceId: IDS.evidence, now: () => NOW});
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
