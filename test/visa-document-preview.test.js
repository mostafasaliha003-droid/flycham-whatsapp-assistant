'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), sharp = require('sharp');
const {VisaMediaStore} = require('../src/visa-media');
const {VisaDocumentIntake} = require('../src/visa-document-intake');
const {createVisaDocumentPreview} = require('../src/visa-document-preview');
const {createVisaPreparedDelivery} = require('../src/visa-prepared-delivery');
const {preparePortalImage} = require('../src/raad-attachments');
const {visaCaseSignature} = require('../src/visa-case-signature');
const {POLICY_FINGERPRINT} = require('../src/visa-document-vision');
const CUSTOMER = '971500000001', NOW = Date.parse('2026-10-28T12:00:00Z'), SESSION = '12345678-1234-4321-abcd-123456789abc';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const extraction = (kind, fields = {}, rotation = 0) => ({version: 1, kind, readable: true, rotation, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {value, visible: true, confidence: 0.999}])), mrzLines: [], portraitBox: null});
async function fixture(t, items = [{kind: 'passport', fields: {latinFirstName: 'EXAMPLE'}, color: '#aa2222'}, {kind: 'passport', fields: {birthPlace: 'TEST CITY'}, color: '#2222aa'}]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remal-client-preview-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const c = {id: 'synthetic-case', createdAt: NOW - 10000, policyVersion: 'synthetic', applicantCount: 1, applicants: [{nationality: 'مصر', documentType: 'passport'}], documents: [], quote: {total: 240}, paymentStatus: 'unverified', submissionStatus: 'not_submitted'};
  const store = {file: path.join(dir, 'state.enc'), key: crypto.randomBytes(32), data: {visaCases: {[CUSTOMER]: c}, conversationJournal: {customers: {[CUSTOMER]: {lastInboundAt: NOW, messages: [{id: 'wamid.synthetic.merge', direction: 'in', actor: 'customer', at: NOW, text: 'ادمج الجواز'}]}}}}, save() {}};
  const mediaStore = new VisaMediaStore({store, now: () => NOW, env: {NODE_ENV: 'test'}});
  let held = false, owned = false;
  const lock = {tryAcquire() { if (held) return false; held = true; return true; }, release() { held = false; }};
  const inbox = {isHumanOwned: () => owned, isBlocked: () => false};
  const documentIntake = new VisaDocumentIntake({store, mediaStore, inbox, vision: {extract() { assert.fail('Preview never calls OCR'); }}, env: {RAAD_DOCUMENT_OCR_ENABLED: 'true'}, now: () => NOW, lock});
  const state = documentIntake.syncCase(CUSTOMER);
  const original = [];
  for (const item of items) {
    const bytes = item.bytes || await sharp({create: {width: 1200, height: 800, channels: 3, background: item.color || '#336633'}}).png().toBuffer();
    const saved = await mediaStore.storeUpload(CUSTOMER, {bytes, mimeType: 'image/png', role: item.kind === 'passport' ? 'passport' : item.kind === 'portrait' ? 'photo' : 'residence', sessionId: SESSION, caseId: c.id});
    mediaStore.activateUploads(CUSTOMER, {sessionId: SESSION, mediaIds: [saved.id]}); original.push(saved.id);
    const normalized = await preparePortalImage(bytes, {mimeType: 'image/png', kind: 'portrait'}), ref = {mediaId: saved.id, page: 1, sourceSha256: hash(bytes), sha256: hash(normalized.bytes), extraction: extraction(item.kind, item.fields, item.rotation || 0)};
    const job = {id: crypto.randomUUID(), customer: CUSTOMER, mediaId: saved.id, caseId: c.id, caseSignature: visaCaseSignature(c), generation: state.generation, policy: POLICY_FINGERPRINT, status: 'ready', sourceSha256: ref.sourceSha256, pages: {1: structuredClone(ref)}};
    store.data.visaDocumentIntake.jobs[job.id] = job; state.documents.push(ref);
  }
  state.status = 'needs_review'; state.inputFingerprint = 'a'.repeat(64); state.resultFingerprint = 'b'.repeat(64); state.applicants = [{id: crypto.randomUUID(), applicantIndex: 0, status: 'needs_review', identityReady: false, documents: {passport: null, residence: null, photo: null}, sourceManifest: [], preparedManifest: []}];
  const service = createVisaDocumentPreview({store, mediaStore, documentIntake, inbox, now: () => NOW, lock});
  return {service, store, mediaStore, documentIntake, inbox, state, c, original, lock, setOwned(v) { owned = v; }, journal: {get: customer => store.data.conversationJournal.customers[customer], summary: () => ({serviceWindowOpen: true})}};
}

test('partial two-page passport is joined as a separate client preview without identity readiness, photo, payment or OCR', async t => {
  const f = await fixture(t), result = await f.service.prepare(CUSTOMER, {kind: 'passport', requestId: 'wamid.synthetic.merge', guard() {}});
  assert.equal(result.combined, true); assert.equal(result.payload.purpose, 'visa_client_preview'); assert.match(result.payload.caption, /للمعاينة فقط/);
  const file = f.mediaStore.read(result.payload.mediaId, {customer: CUSTOMER}), info = await sharp(file.bytes).metadata();
  assert.equal(info.width, 1200); assert.equal(info.height, 1624); assert.equal(file.metadata.purpose, 'visa_client_preview');
  const pixels = await sharp(file.bytes).raw().toBuffer({resolveWithObject: true});
  const first = [...pixels.data.subarray(0, 3)], last = [...pixels.data.subarray((info.height - 1) * info.width * 3, (info.height - 1) * info.width * 3 + 3)];
  assert.notDeepEqual(first, last); assert.equal(f.service.current(result), true);
  assert.equal(f.state.applicants[0].identityReady, false); assert.deepEqual(f.state.applicants[0].preparedManifest, []);
  assert.equal(f.c.paymentStatus, 'unverified'); assert.equal(f.store.data.raadApplications, undefined);
  assert.equal(JSON.stringify(f.store.data.visaDocumentPreviews).includes('wamid.synthetic.merge'), false);
  assert.deepEqual(new Set(f.mediaStore.records[result.payload.mediaId].sourceIds), new Set(f.original));
});

test('delivery fallback sends a real partial preview only for an explicit image utility request', async t => {
  const f = await fixture(t); let sends = 0;
  const delivery = createVisaPreparedDelivery({...f, send: async (customer, payload, guard) => { guard(); sends++; assert.equal(customer, CUSTOMER); assert.equal(payload.purpose, 'visa_client_preview'); return {messages: [{id: 'wamid.synthetic.preview.sent'}]}; }, now: () => NOW});
  assert.deepEqual(await delivery.sendPrepared(CUSTOMER, {kind: 'passport', requestId: 'wamid.synthetic.merge'}), {accepted: false, reason: 'not_ready'});
  const result = await delivery.sendPrepared(CUSTOMER, {kind: 'passport', intent: 'merge', requestId: 'wamid.synthetic.merge'});
  assert.deepEqual(result, {accepted: true, messageId: 'wamid.synthetic.preview.sent', preview: true, combined: true}); assert.equal(sends, 1);
  assert.equal((await delivery.sendPrepared(CUSTOMER, {kind: 'passport', intent: 'merge', requestId: 'wamid.synthetic.merge'})).duplicate, true); assert.equal(sends, 1);
});

test('ID front/back ordering is stable, one side remains a single preview and exact duplicate images do not add a side', async t => {
  const f = await fixture(t, [{kind: 'uae_id_back', fields: {emiratesId: '784199000000001'}, color: '#2222aa'}, {kind: 'uae_id_front', fields: {emiratesId: '784199000000001'}, color: '#aa2222'}]);
  const result = await f.service.prepare(CUSTOMER, {kind: 'residence', requestId: 'wamid.synthetic.id', guard() {}});
  assert.deepEqual(result.binding.pages.map(page => f.state.documents.find(raw => raw.mediaId === page.mediaId).extraction.kind), ['uae_id_front', 'uae_id_back']);
  const one = await fixture(t, [{kind: 'uae_id_front', fields: {emiratesId: '784199000000001'}}]);
  assert.equal((await one.service.prepare(CUSTOMER, {kind: 'residence', requestId: 'wamid.synthetic.single', guard() {}})).combined, false);
  const duplicateBytes = await sharp({create: {width: 1200, height: 800, channels: 3, background: '#778899'}}).png().toBuffer();
  const duplicates = await fixture(t, [{kind: 'passport', fields: {}, bytes: duplicateBytes}, {kind: 'passport', fields: {}, bytes: duplicateBytes}]);
  assert.equal((await duplicates.service.prepare(CUSTOMER, {kind: 'passport', requestId: 'wamid.synthetic.duplicate', guard() {}})).combined, false);
});

test('extra pages, multiple people, visibly conflicting identifiers or name and birth date fail closed', async t => {
  for (const items of [
    [{kind: 'passport', fields: {passportNumber: 'A1234567'}}, {kind: 'passport', fields: {passportNumber: 'B1234567'}}],
    [{kind: 'passport', fields: {latinFullName: 'ONE TEST', birthDate: '1990-01-01'}}, {kind: 'passport', fields: {latinFullName: 'OTHER TEST', birthDate: '1990-01-01'}}],
    [{kind: 'uae_id_front', fields: {emiratesId: '784199000000001'}}, {kind: 'uae_id_back', fields: {emiratesId: '784199000000002'}}],
    [{kind: 'passport', color: '#112233'}, {kind: 'passport', color: '#223344'}, {kind: 'passport', color: '#334455'}]
  ]) {
    const f = await fixture(t, items), kind = items[0].kind === 'passport' ? 'passport' : 'residence';
    await assert.rejects(f.service.prepare(CUSTOMER, {kind, requestId: 'wamid.synthetic.conflict', guard() {}}), /DOCUMENT_PREVIEW_(CONFLICT|AMBIGUOUS)/);
    assert.equal(Object.values(f.mediaStore.records).some(raw => raw.purpose === 'visa_client_preview'), false);
  }
  const group = await fixture(t); group.c.applicantCount = 2;
  await assert.rejects(group.service.prepare(CUSTOMER, {kind: 'passport', requestId: 'wamid.synthetic.group', guard() {}}), /DOCUMENT_PREVIEW_NOT_READY/);
});

test('new upload, queued OCR, source expiry/tampering and operator takeover invalidate prepared previews', async t => {
  for (const mutate of [
    f => { f.state.resultFingerprint = 'c'.repeat(64); },
    f => { Object.values(f.store.data.visaDocumentIntake.jobs)[0].status = 'queued'; },
    f => { f.mediaStore.records[f.original[0]].expiresAt = 0; },
    f => { f.mediaStore.records[f.original[0]].checksum = 'd'.repeat(64); },
    f => { f.setOwned(true); },
    f => { f.store.data.visaMedia[crypto.randomUUID()] = {...f.mediaStore.records[f.original[0]], id: crypto.randomUUID()}; }
  ]) {
    const f = await fixture(t), result = await f.service.prepare(CUSTOMER, {kind: 'passport', requestId: 'wamid.synthetic.guard', guard() {}});
    assert.equal(f.service.current(result), true); mutate(f); assert.equal(f.service.current(result), false);
  }
});
