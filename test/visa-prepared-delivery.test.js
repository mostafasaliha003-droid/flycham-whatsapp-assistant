'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createVisaPreparedDelivery} = require('../src/visa-prepared-delivery');
const {visaCaseSignature} = require('../src/visa-case-signature');
const CUSTOMER = '971500000001', OTHER = '971500000002';
const SOURCE = '12345678-1234-4321-abcd-123456789abc', IMAGE = '12345678-1234-4321-abcd-123456789abd', EVIDENCE = '12345678-1234-4321-abcd-123456789abe';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(options = {}) {
  let clock = 1000000, owned = false, window = true, saveFailure = false;
  const c = {id: 'synthetic-case', policyVersion: 'test', applicantCount: 1, applicants: [{nationality: 'مصر', documentType: 'passport'}], createdAt: 1000, documents: [], quote: {total: 240}};
  const sourceBytes = Buffer.from('SYNTHETIC ORIGINAL'), imageBytes = Buffer.from('SYNTHETIC PREPARED');
  const rawSource = {id: SOURCE, customer: CUSTOMER, type: 'image', mimeType: 'image/jpeg', receivedAt: 2000, expiresAt: 9999999999, checksum: digest(sourceBytes), size: sourceBytes.length};
  const rawImage = {id: IMAGE, customer: CUSTOMER, type: 'image', purpose: 'raad_portal_upload', kind: 'passport', mimeType: 'image/png', sourceIds: [SOURCE], receivedAt: 3000, expiresAt: 9999999999, checksum: digest(imageBytes), size: imageBytes.length};
  const state = {caseId: c.id, caseSignature: visaCaseSignature(c), generation: 1, status: 'ready', resultFingerprint: 'f'.repeat(64), policy: 'synthetic-policy', applicants: [{id: EVIDENCE, applicantIndex: 0, status: 'ready', identityReady: true, documents: {passport: IMAGE}, sourceManifest: [{mediaId: SOURCE, sha256: rawSource.checksum}], preparedManifest: [{kind: 'passport', mediaId: IMAGE, sha256: rawImage.checksum}]}]};
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {[SOURCE]: rawSource, [IMAGE]: rawImage}, visaDocumentIntake: {cases: {[CUSTOMER]: state}, jobs: {one: {customer: CUSTOMER, mediaId: SOURCE, caseId: c.id, caseSignature: state.caseSignature, generation: 1, status: 'ready', sourceSha256: rawSource.checksum}}}, conversationJournal: {customers: {[CUSTOMER]: {lastInboundAt: clock, messages: [{id: 'wamid.synthetic.request', direction: 'in', actor: 'customer', at: clock, text: 'أرسل الجواز'}]}}}}, save() { if (saveFailure) throw Error('PRIVATE_DISK_ERROR'); }};
  const reads = [], sends = [], bytes = {[SOURCE]: sourceBytes, [IMAGE]: imageBytes};
  const mediaStore = {records: store.data.visaMedia, read(id, binding) { reads.push({id, binding}); const raw = this.records[id]; if (!raw || raw.customer !== binding.customer) throw Error('PRIVATE'); return {metadata: {...raw}, bytes: Buffer.from(bytes[id])}; }};
  const journal = {get: id => store.data.conversationJournal.customers[id], summary: () => ({serviceWindowOpen: window})};
  const documentIntake = {policyFingerprint: 'synthetic-policy', knownReceipt: () => false, summary: () => ({enabled: true, ...structuredClone(store.data.visaDocumentIntake.cases[CUSTOMER])})};
  const inbox = {isHumanOwned: () => owned, isBlocked: () => false};
  const send = options.send || (async (to, payload, guard, metadata) => { guard(); sends.push({to, payload, metadata}); return {messages: [{id: 'wamid.synthetic.acceptance'}]}; });
  const config = {store, mediaStore, documentIntake, inbox, journal, send, now: () => clock};
  const service = createVisaPreparedDelivery(config);
  return {service, config, store, c, state, mediaStore, rawSource, rawImage, bytes, reads, sends, request: {kind: 'passport', requestId: 'wamid.synthetic.request'}, setOwned(value) { owned = value; }, setWindow(value) { window = value; }, setTime(value) { clock = value; }, setSaveFailure(value) { saveFailure = value; }};
}

test('prepared role can be sent before payment with its real current inbound; duplicate request never sends twice', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.sendPrepared(CUSTOMER, f.request), f.service.sendPrepared(CUSTOMER, f.request)]);
  assert.equal(a.accepted, true); assert.equal(b.accepted, true); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to, CUSTOMER); assert.equal(f.sends[0].payload.mediaId, IMAGE); assert.equal(f.sends[0].payload.type, 'image'); assert.equal(f.sends[0].metadata.customer, CUSTOMER);
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, f.request), {accepted: true, messageId: 'wamid.synthetic.acceptance', duplicate: true}); assert.equal(f.sends.length, 1);
  assert.equal(f.c.paymentStatus, undefined); assert.equal(f.c.staffVerification, undefined);
  const record = Object.values(f.store.data.visaPreparedDeliveries.items)[0];
  assert.equal(record.state, 'accepted'); assert.equal(record.binding.caseId, f.c.id);
  assert.equal(JSON.stringify(record).includes(f.request.requestId), false);
});

test('missing role, multiple applicants, stale request and closed ownership/window fail without disclosure', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, {requestId: f.request.requestId}), {accepted: false, reason: 'kind_required'});
  f.c.applicantCount = 2;
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, f.request), {accepted: false, reason: 'multiple_applicants'});
  f.c.applicantCount = 1;
  for (const mutate of [
    isolated => isolated.setOwned(true),
    isolated => isolated.setWindow(false),
    isolated => isolated.store.data.conversationJournal.customers[CUSTOMER].messages.push({id: 'newer-request', direction: 'in', actor: 'customer', at: 1000000})
  ]) {
    const isolated = fixture();
    mutate(isolated);
    assert.equal((await isolated.service.sendPrepared(CUSTOMER, isolated.request)).accepted, false); assert.equal(isolated.sends.length, 0);
  }
  assert.equal((await f.service.sendPrepared(OTHER, f.request)).accepted, false); assert.equal(f.sends.length, 0);
});

test('original checksum/bytes, prepared ownership/manifest, missing source or newly uploaded source invalidate selection', async () => {
  for (const mutate of [
    f => { f.bytes[SOURCE] = Buffer.from('CHANGED ORIGINAL'); },
    f => { f.rawSource.checksum = 'a'.repeat(64); },
    f => { f.rawSource.customer = OTHER; },
    f => { f.rawImage.customer = OTHER; },
    f => { f.rawImage.purpose = undefined; },
    f => { f.bytes[IMAGE] = Buffer.from('CHANGED DERIVATIVE'); },
    f => { f.state.applicants[0].preparedManifest[0].sha256 = 'a'.repeat(64); },
    f => { delete f.store.data.visaMedia[SOURCE]; },
    f => { f.rawSource.expiresAt = 0; },
    f => { f.store.data.visaMedia['12345678-1234-4321-abcd-123456789abf'] = {...f.rawSource, id: '12345678-1234-4321-abcd-123456789abf'}; },
    f => { f.store.data.visaDocumentIntake.jobs.one.status = 'queued'; },
    f => { f.state.policy = 'old-policy'; }
  ]) {
    const f = fixture(); mutate(f);
    assert.equal((await f.service.sendPrepared(CUSTOMER, f.request)).accepted, false); assert.equal(f.sends.length, 0);
  }
});

test('queue guard rechecks case/result, source and latest inbound immediately before dispatch', async () => {
  for (const mutate of [
    f => { f.c.applicants[0].nationality = 'سوريا'; },
    f => { f.state.resultFingerprint = 'e'.repeat(64); },
    f => { f.setOwned(true); },
    f => { f.bytes[SOURCE] = Buffer.from('CHANGED AFTER QUEUE'); },
    f => { f.store.data.conversationJournal.customers[CUSTOMER].messages.push({id: 'later-inbound', direction: 'in', actor: 'customer', at: 1000000}); }
  ]) {
    let release; const blocked = new Promise(resolve => { release = resolve; }); let dispatched = 0;
    const f = fixture({send: async (to, payload, guard) => { await blocked; guard(); dispatched++; return {messages: [{id: 'wamid.synthetic.done'}]}; }});
    const result = f.service.sendPrepared(CUSTOMER, f.request); await Promise.resolve(); mutate(f); release();
    assert.equal((await result).accepted, false); assert.equal(dispatched, 0);
  }
});

test('uncertain network or interrupted attempts are durable and never replay the same inbound', async () => {
  let sends = 0;
  const f = fixture({send: async () => { sends++; throw Error('PRIVATE_PROVIDER_TEXT'); }});
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, f.request), {accepted: false, reason: 'delivery_uncertain'});
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, f.request), {accepted: false, reason: 'delivery_uncertain'});
  const restart = createVisaPreparedDelivery(f.config);
  assert.deepEqual(await restart.sendPrepared(CUSTOMER, f.request), {accepted: false, reason: 'delivery_uncertain'}); assert.equal(sends, 1);
  assert.equal(JSON.stringify(f.store.data.visaPreparedDeliveries).includes('PRIVATE_PROVIDER_TEXT'), false);
  Object.values(f.store.data.visaPreparedDeliveries.items)[0].state = 'sending';
  createVisaPreparedDelivery(f.config);
  assert.equal(Object.values(f.store.data.visaPreparedDeliveries.items)[0].state, 'uncertain');
});

test('provider acceptance remains recorded after takeover in flight; paused and dry run never claim sent', async () => {
  let f;
  f = fixture({send: async () => { f.setOwned(true); return {messages: [{id: 'wamid.synthetic.accepted-after-claim'}]}; }});
  assert.deepEqual(await f.service.sendPrepared(CUSTOMER, f.request), {accepted: true, messageId: 'wamid.synthetic.accepted-after-claim'});
  assert.equal(Object.values(f.store.data.visaPreparedDeliveries.items)[0].supersededAfterDispatch, true);
  for (const result of [{dryRun: true}, {paused: true}, {}, {messages: [{id: 'invalid message id'}]}]) {
    const g = fixture({send: async () => result});
    assert.equal((await g.service.sendPrepared(CUSTOMER, g.request)).accepted, false);
  }
});
