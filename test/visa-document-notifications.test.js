'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {VisaDocumentNotifications} = require('../src/visa-document-notifications');
const {visaCaseSignature} = require('../src/visa-case-signature');
const {ConversationJournal} = require('../src/conversation-journal');
const CUSTOMER = '15550007001', OTHER = '15550007002';
const PASSPORT = '12345678-1234-4321-abcd-123456789abc';
const NEW_FILE = '12345678-1234-4321-abcd-123456789abd';
const NOW = 1900000000000;

function fixture({status = 'ready', send, owned = false, blocked = false, open = true, quietMs = 0, isInboundBusy = () => false} = {}) {
  let clock = NOW, ownership = owned, blocking = blocked, sequence = 0, sends = 0, saves = 0;
  const c = {id: 'synthetic-document-case', createdAt: clock - 1000, revision: 1, applicantCount: 1, applicants: [{nationality: 'مصر', latinFirstName: 'PRIVATE_NAME'}], quote: {total: 240}, paymentStatus: 'unverified', submissionStatus: 'not_submitted', documents: []};
  const source = {id: PASSPORT, customer: CUSTOMER, type: 'image', mimeType: 'image/png', size: 1200, receivedAt: clock - 500, expiresAt: clock + 10 * 86400000, checksum: 'a'.repeat(64)};
  const raw = {caseId: c.id, caseSignature: visaCaseSignature(c), generation: 1, status, resultFingerprint: 'b'.repeat(64), documents: [{mediaId: PASSPORT, page: 1, sha256: 'c'.repeat(64), sourceSha256: source.checksum, extraction: {kind: 'passport', fields: {passportNumber: {value: 'PRIVATE_PASSPORT', visible: true, confidence: 0.99}}}}], applicants: [{applicantIndex: 0, status, awaitingPayment: true, fields: {emiratesId: '784199012345671', latinFirstName: 'PRIVATE_NAME'}, issues: []}], issues: []};
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {[PASSPORT]: source}, visaDocumentIntake: {cases: {[CUSTOMER]: raw}, jobs: {'synthetic-job': {customer: CUSTOMER, mediaId: PASSPORT, caseId: c.id, caseSignature: raw.caseSignature, generation: 1, status: 'ready', sourceSha256: source.checksum}}}}, save() { saves++; }};
  const journal = new ConversationJournal({store, now: () => clock});
  const inbound = (customer = CUSTOMER) => journal.recordInbound(customer, {id: 'synthetic-notice-input-' + (++sequence), text: 'متابعة', timestamp: clock});
  if (open) inbound(); else journal.recordInbound(CUSTOMER, {id: 'synthetic-old-input', text: 'طلب قديم', timestamp: clock - 2 * 86400000});
  const inbox = {journal, isHumanOwned: () => ownership || blocking, isOperatorOwned: () => ownership, isBlocked: () => blocking};
  const intake = {policyFingerprint: 'd'.repeat(64), summary(customer) { const state = store.data.visaDocumentIntake.cases[customer]; return state ? {enabled: true, status: state.status, caseId: state.caseId, caseSignature: state.caseSignature, generation: state.generation, resultFingerprint: state.resultFingerprint, applicants: structuredClone(state.applicants), issues: structuredClone(state.issues)} : {enabled: true, status: 'not_started'}; }};
  const dispatched = [];
  const options = {store, documentIntake: intake, inbox, now: () => clock, quietMs, isInboundBusy, send: async (customer, payload, guard, metadata) => { sends++; dispatched.push({customer, payload, metadata}); if (send) return send(customer, payload, guard, metadata); guard(); return {messages: [{id: 'synthetic-notice-accepted-' + sends}]}; }};
  const service = new VisaDocumentNotifications(options);
  return {c, raw, source, store, journal, intake, inbox, service, options, dispatched, inbound, count: () => sends, saves: () => saves, advance(ms) { clock += ms; }, own(value) { ownership = value; }, block(value) { blocking = value; }};
}

test('successful document feedback works before payment without changing finance or sending extracted identifiers', async () => {
  const f = fixture(), before = structuredClone(f.c), item = f.service.update(CUSTOMER);
  assert.equal(item.state, 'pending'); assert.equal(item.kind, 'document_review');
  const [result] = await f.service.flush(CUSTOMER);
  assert.equal(result.state, 'accepted'); assert.equal(result.messageId, 'synthetic-notice-accepted-1'); assert.notEqual(result.state, 'delivered');
  assert.equal(f.dispatched[0].customer, CUSTOMER); assert.equal(f.dispatched[0].metadata.customer, CUSTOMER); assert.equal(f.dispatched[0].metadata.kind, 'document_review');
  assert.match(f.dispatched[0].payload.text, /ملفك جاهز/); assert.doesNotMatch(f.dispatched[0].payload.text, /المحاسب|رعد|قراءة|مطابقة/);
  const saved = JSON.stringify(f.store.data.visaDocumentNotifications);
  for (const forbidden of ['PRIVATE_PASSPORT', 'PRIVATE_NAME', '784199012345671', 'تم استلام دفعتك']) assert.equal(saved.includes(forbidden), false);
  assert.deepEqual(f.c, before);
});

test('needs confirmation with awaiting payment tells the next step without unbound questions or payment claims', async () => {
  const f = fixture({status: 'needs_confirmation'}); f.raw.awaitingPayment = true;
  const item = f.service.update(CUSTOMER); await f.service.flush();
  assert.match(item.payload.text, /وصلت أوراقك، شكرًا إلك/); assert.doesNotMatch(item.payload.text, /منكمل مراجعة|اكتملت قراءة|يتابع تنفيذ/); assert.doesNotMatch(item.payload.text, /حفظ الطلب|المحاسب|التحويل|الخانات/);
  assert.equal(item.payload.type, 'text'); assert.equal(Object.hasOwn(item.payload, 'token'), false);
  assert.equal(f.store.data.visaFulfilment, undefined); assert.equal(f.c.paymentStatus, 'unverified');
});

test('safe review copy uses at most three known issue actions and never provider prose', async () => {
  const f = fixture({status: 'needs_review'});
  f.raw.issues = [
    {code: 'DOCUMENT_UNREADABLE', message: 'PRIVATE_PROVIDER_TEXT'}, {code: 'PASSPORT_MRZ_REQUIRED', message: 'WIRE MONEY'},
    {code: 'DOCUMENT_IDENTITY_MISMATCH'}, {code: 'RESIDENCE_MISSING'}, {code: 'ARBITRARY_CODE', message: 'SECRET_784199012345671'}
  ];
  const item = f.service.update(CUSTOMER); await f.service.flush();
  assert.equal((item.payload.text.match(/•/g) || []).length, 1); assert.match(item.payload.text, /صورة أوضح للمستند/);
  for (const forbidden of ['PRIVATE_PROVIDER_TEXT', 'WIRE MONEY', 'SECRET_', '784199012345671', 'ARBITRARY_CODE']) assert.equal(item.payload.text.includes(forbidden), false);
});

test('invalid Emirates ID feedback identifies the field before generic gaps without echoing its value', async () => {
  const f = fixture({status: 'needs_review'});
  f.raw.issues = [{code:'DOCUMENT_UNASSIGNED'}, {code:'PASSPORT_MRZ_INVALID'}, {code:'DOCUMENT_FIELD_REQUIRED'}, {code:'DOCUMENT_FIELD_INVALID', field:'emiratesId', message:'PRIVATE_ID_READING'}];
  const item = f.service.update(CUSTOMER); await f.service.flush();
  const lines = item.payload.text.split('\n');
  assert.match(item.payload.text, /منخبرك إذا احتجنا أي معلومة إضافية/);assert.doesNotMatch(item.payload.text,/رقم الهوية|آلي|ربط بعض الصور|سيقارنه القسم/);
  assert.equal((item.payload.text.match(/•/g) || []).length, 0);
  assert.doesNotMatch(item.payload.text, /PRIVATE_ID_READING|784199012345671|إعادة تصوير صفحة بيانات الجواز/);
  assert.equal(f.c.paymentStatus, 'unverified');
});

test('receipt, other, audio and portrait-only input or processing states never announce identity review', async () => {
  for (const kind of ['other', 'portrait']) {
    const f = fixture(); f.raw.documents[0].extraction.kind = kind;
    assert.equal(f.service.update(CUSTOMER), null); assert.equal((await f.service.flush()).length, 0); assert.equal(f.count(), 0);
  }
  const f = fixture(); f.source.type = 'audio'; f.source.mimeType = 'audio/ogg'; assert.equal(f.service.update(CUSTOMER), null);
  for (const status of ['processing', 'waiting_case', 'not_started']) { const g = fixture({status}); assert.equal(g.service.update(CUSTOMER), null); }
});

test('stable completion is idempotent across repeated updates, flushes and restarts', async () => {
  const f = fixture(), first = f.service.update(CUSTOMER), saves = f.saves();
  for (let i = 0; i < 5; i++) assert.equal(f.service.update(CUSTOMER).key, first.key);
  assert.equal(f.saves(), saves); await f.service.flush(); await f.service.flush();
  const restarted = new VisaDocumentNotifications(f.options); restarted.update(CUSTOMER); await restarted.flush();
  assert.equal(f.count(), 1); assert.equal(Object.keys(f.store.data.visaDocumentNotifications.items).length, 1);
});

test('internal employee rereads stay silent until a newer real customer inbound', async () => {
  const f = fixture({status:'needs_review'});
  f.raw.manualRereads = {synthetic:{generation:1,requestedAt:NOW}};
  assert.equal(f.service.update(CUSTOMER), null); await f.service.flush(); assert.equal(f.count(),0);
  f.raw.generation = 2; f.raw.resultFingerprint = 'e'.repeat(64);
  f.store.data.visaDocumentIntake.jobs['synthetic-job'].generation = 2;
  const restarted = new VisaDocumentNotifications(f.options);
  assert.equal(restarted.update(CUSTOMER), null); await restarted.flush(); assert.equal(f.count(),0);
  f.advance(1000); f.inbound();
  assert.ok(restarted.update(CUSTOMER)); await restarted.flush(); assert.equal(f.count(),1);
  assert.equal(f.c.paymentStatus,'unverified');
});

test('metadata-only dossier application and job staging preserve the pending document notice binding', async () => {
  const f = fixture(), item = f.service.update(CUSTOMER), originalFingerprint = item.bindingFingerprint;
  f.raw.applicants[0].applied = true;
  f.raw.applicants[0].stagedJobs = {'synthetic-paid-job': '12345678-1234-4321-abcd-123456789abe'};
  assert.equal(f.service.snapshot(CUSTOMER).bindingFingerprint, originalFingerprint);
  assert.equal(f.service.update(CUSTOMER).key, item.key);
  await f.service.flush(); assert.equal(f.count(), 1); assert.equal(f.service.data().items[item.key].state, 'accepted');
  f.raw.applicants[0].applied = false; f.raw.applicants[0].stagedJobs['another-paid-job'] = '12345678-1234-4321-abcd-123456789abf';
  f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 1);
});

test('real identity, document manifests, evidence IDs and issue codes stay bound despite unchanged result fingerprint', async () => {
  for (const change of [
    applicant => { applicant.fields.latinFirstName = 'Changed document name'; },
    applicant => { applicant.documents = {passport: NEW_FILE}; },
    applicant => { applicant.preparedManifest = [{kind: 'passport', mediaId: NEW_FILE, sha256: 'e'.repeat(64)}]; },
    applicant => { applicant.evidence = {passportMrzChecked: false, fieldSources: {passportNumber: 'different-source'}}; },
    applicant => { applicant.id = NEW_FILE; },
    applicant => { applicant.issues.push({code: 'DOCUMENT_IDENTITY_MISMATCH', field: 'passportNumber'}); }
  ]) {
    const f = fixture(), item = f.service.update(CUSTOMER);
    change(f.raw.applicants[0]); await f.service.flush(); assert.equal(f.count(), 0); assert.equal(f.service.data().items[item.key].state, 'cancelled');
  }
});

test('exact case and private summary provenance must agree before creating a notification', () => {
  for (const mutate of [
    f => { f.raw.caseId = 'another-case'; }, f => { f.raw.caseSignature = 'e'.repeat(64); },
    f => { f.raw.generation = 0; }, f => { f.raw.resultFingerprint = 'not-a-hash'; },
    f => { f.intake.summary = () => ({enabled: true, ...f.raw, generation: 99}); },
    f => { f.intake.summary = () => ({enabled: false, ...f.raw}); },
    f => { f.raw.documents[0].mediaId = NEW_FILE; f.store.data.visaMedia[NEW_FILE] = {...f.source, id: NEW_FILE, customer: OTHER}; }
  ]) { const f = fixture(); mutate(f); assert.equal(f.service.update(CUSTOMER), null); }
  assert.equal(fixture().service.update('__proto__'), null);
});

test('source tampering, deleted files and a newly saved not-yet-enqueued attachment cancel stale feedback', async () => {
  for (const mutate of [
    f => { f.source.checksum = 'e'.repeat(64); }, f => { delete f.store.data.visaMedia[PASSPORT]; },
    f => { f.store.data.visaMedia[NEW_FILE] = {...f.source, id: NEW_FILE, receivedAt: NOW, checksum: 'e'.repeat(64)}; },
    f => { f.store.data.visaDocumentIntake.jobs['synthetic-job'].status = 'running'; }
  ]) { const f = fixture(); const item = f.service.update(CUSTOMER); mutate(f); await f.service.flush(); assert.equal(f.count(), 0); assert.equal(f.service.data().items[item.key].state, 'cancelled'); }
});

test('ownership and blocks pause feedback until release plus a newer real inbound', async () => {
  for (const mode of ['owned', 'blocked', 'complaint']) {
    const f = fixture(); if (mode === 'owned') f.own(true); if (mode === 'blocked') f.block(true); if (mode === 'complaint') f.store.data.complaints = [{customer: CUSTOMER, state: 'pending'}];
    const item = f.service.update(CUSTOMER); assert.equal(item.state, 'paused'); await f.service.flush(); assert.equal(f.count(), 0);
    f.own(false); f.block(false); f.store.data.complaints = [];
    assert.equal(f.service.reopen(CUSTOMER).requeued, 0, 'release alone is not an inbound');
    f.advance(1); f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 1); await f.service.flush(); assert.equal(f.count(), 1);
  }
});

test('closed service window and dry run remain paused until a new inbound, without automatic replay', async () => {
  for (const mode of ['window', 'dry-run']) {
    let actual = false;
    const f = fixture({open: mode !== 'window', send: async (_to, _payload, guard) => { guard(); return actual ? {messages: [{id: 'synthetic-live-after-inbound'}]} : mode === 'window' ? {paused: true} : {dryRun: true}; }});
    const item = f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.service.data().items[item.key].state, 'paused');
    actual = true; assert.equal(f.service.reopen(CUSTOMER).requeued, 0); await f.service.flush(); assert.equal(f.count(), 1);
    f.advance(10); f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 1); await f.service.flush(); assert.equal(f.count(), 2);
    assert.equal(f.service.data().items[item.key].state, 'accepted'); assert.equal(f.service.reopen(CUSTOMER).requeued, 0);
  }
});

test('concurrent flush calls serialize one message and share the same in-flight effect', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = fixture({send: async (_to, _payload, guard) => { entered(); await held; guard(); return {messages: [{id: 'synthetic-concurrent-accepted'}]}; }});
  f.service.update(CUSTOMER); const one = f.service.flush(), two = f.service.flush(); await started; assert.equal(f.count(), 1); release(); await Promise.all([one, two]); assert.equal(f.count(), 1);
});

test('a case change while waiting for the ordered queue prevents the actual send', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; }); let effects = 0;
  const f = fixture({send: async (_to, _payload, guard) => { entered(); await held; guard(); effects++; return {messages: [{id: 'must-not-send'}]}; }});
  const item = f.service.update(CUSTOMER), work = f.service.flush(); await started; f.c.applicants[0].latinFirstName = 'Changed'; release(); await work;
  assert.equal(effects, 0); assert.equal(f.service.data().items[item.key].state, 'cancelled');
});

test('customer erasure during a queue wait cannot resurrect or send its old notification', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; }); let effects = 0;
  const f = fixture({send: async (_to, _payload, guard) => { entered(); await held; guard(); effects++; return {messages: [{id: 'must-not-survive-erasure'}]}; }});
  f.service.update(CUSTOMER); const work = f.service.flush(); await started;
  delete f.store.data.visaCases[CUSTOMER]; delete f.store.data.visaDocumentIntake.cases[CUSTOMER]; f.store.data.visaDocumentNotifications.items = {}; delete f.store.data.visaMedia[PASSPORT];
  release(); await work; assert.equal(effects, 0); assert.deepEqual(f.store.data.visaDocumentNotifications.items, {});
});

test('an altered durable payload cannot substitute arbitrary text for the fixed document feedback', async () => {
  const f = fixture(), item = f.service.update(CUSTOMER);
  f.service.data().items[item.key].payload.text = 'PRIVATE_UNTRUSTED_PROVIDER_TEXT';
  await f.service.flush(); assert.equal(f.count(), 0); assert.equal(f.service.data().items[item.key].state, 'cancelled');
});

test('an ownership change during a queue wait pauses without sending and can reopen on a later inbound', async () => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; }); let effects = 0;
  const f = fixture({send: async (_to, _payload, guard) => { entered(); await held; guard(); effects++; return {messages: [{id: 'synthetic-after-owner-release'}]}; }});
  const item = f.service.update(CUSTOMER), work = f.service.flush(); await started; f.own(true); release(); await work;
  assert.equal(effects, 0); assert.equal(f.service.data().items[item.key].state, 'paused'); f.own(false); assert.equal(f.service.reopen(CUSTOMER).requeued, 0);
  f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 1); await f.service.flush(); assert.equal(effects, 1);
});

test('unknown errors and invalid acceptance never replay, while explicit not-dispatched errors require a real inbound', async () => {
  for (const result of ['error', 'invalid']) {
    const f = fixture({send: async () => { if (result === 'error') throw Error('PRIVATE_PROVIDER_FAILURE'); return {}; }}), item = f.service.update(CUSTOMER);
    await f.service.flush(); assert.equal(f.service.data().items[item.key].state, 'uncertain'); f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 0);
    f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 1); assert.equal(JSON.stringify(f.service.data()).includes('PRIVATE_PROVIDER_FAILURE'), false);
  }
  const f = fixture({send: async () => { throw Object.assign(Error('PRIVATE_NOT_DISPATCHED'), {notDispatched: true}); }}), item = f.service.update(CUSTOMER);
  await f.service.flush(); assert.equal(f.service.data().items[item.key].state, 'paused'); assert.equal(f.service.reopen(CUSTOMER).requeued, 0); f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 1);
});

test('provider acceptance followed by persistence failure is quarantined and never resent', async () => {
  const f = fixture(), item = f.service.update(CUSTOMER), originalSave = f.store.save; let failed = false;
  f.store.save = () => { if (!failed && f.service.data().items[item.key]?.state === 'accepted') { failed = true; throw Error('synthetic disk failure'); } originalSave(); };
  await f.service.flush(); assert.equal(f.service.data().items[item.key].state, 'uncertain'); f.inbound(); assert.equal(f.service.reopen(CUSTOMER).requeued, 0); await f.service.flush(); assert.equal(f.count(), 1);
});

test('accepted feedback remains accepted but marked superseded if state changes after actual dispatch', async () => {
  let f;
  f = fixture({send: async (_to, _payload, guard) => { guard(); f.c.applicants[0].latinFirstName = 'Changed after actual send'; return {messages: [{id: 'synthetic-known-acceptance'}]}; }});
  const item = f.service.update(CUSTOMER); await f.service.flush(); const result = f.service.data().items[item.key];
  assert.equal(result.state, 'accepted'); assert.equal(result.supersededAfterDispatch, true); assert.notEqual(result.state, 'delivered'); await f.service.flush(); assert.equal(f.count(), 1);
});

test('restart quarantines sending records and bounded retention removes expired records', async () => {
  const f = fixture(), item = f.service.update(CUSTOMER); f.service.data().items[item.key].state = 'sending';
  const restarted = new VisaDocumentNotifications(f.options); assert.equal(restarted.data().items[item.key].state, 'uncertain'); await restarted.flush(); assert.equal(f.count(), 0);
  f.advance(11 * 86400000); await restarted.flush(); assert.equal(Object.keys(restarted.data().items).length, 0);
});

test('new completed generation supersedes only known unsent feedback, without changing the customer case', async () => {
  const f = fixture(), before = structuredClone(f.c), first = f.service.update(CUSTOMER);
  f.raw.generation++; f.raw.resultFingerprint = 'e'.repeat(64); f.store.data.visaDocumentIntake.jobs['synthetic-job'].generation++;
  const second = f.service.update(CUSTOMER); assert.notEqual(first.key, second.key); assert.equal(f.service.data().items[first.key].state, 'cancelled');
  await f.service.flush(); assert.equal(f.count(), 1); assert.deepEqual(f.c, before);
});

function changeResult(f, round, {newSource = false} = {}) {
  f.raw.resultFingerprint = require('node:crypto').createHash('sha256').update('synthetic-result-' + round).digest('hex');
  if (!newSource) return;
  const id = '50000000-0000-4000-8000-' + String(round).padStart(12, '0');
  const source = {...f.source, id, receivedAt: NOW + round};
  f.store.data.visaMedia[id] = source;
  f.raw.documents.push({...structuredClone(f.raw.documents[0]), mediaId: id});
  f.store.data.visaDocumentIntake.jobs[id] = {...f.store.data.visaDocumentIntake.jobs['synthetic-job'], mediaId: id};
}

test('five new file/result snapshots cannot repeat the same review notice to the customer', async () => {
  const f = fixture({status: 'needs_review'});
  f.raw.issues = [{code: 'DOCUMENT_UNASSIGNED'}, {code: 'PASSPORT_MISSING'}, {code: 'RESIDENCE_MISSING'}];
  for (let round = 1; round <= 5; round++) {
    f.advance(1); changeResult(f, round, {newSource: true});
    f.service.update(CUSTOMER); await f.service.flush(CUSTOMER);
  }
  assert.equal(f.count(), 1);
  const records = Object.values(f.service.data().items);
  assert.equal(records.filter(item => item.state === 'accepted').length, 1);
  assert.equal(records.filter(item => item.failure === 'DUPLICATE_FEEDBACK').length, 4);
  const copy = f.dispatched[0].payload.text;
  assert.match(copy, /وصلت أوراقك، شكرًا إلك/);
  assert.match(copy, /منخبرك إذا احتجنا أي معلومة إضافية/);
  assert.doesNotMatch(copy,/مطابقة صور الهوية|آليًا|ربط بعض الصور/);
  assert.doesNotMatch(copy, /يرجى إرسال صفحة بيانات الجواز|يرجى إرسال صور الهوية/);
});

test('a different meaningful review result can notify, while accepted equal copy stays suppressed for the same case', async () => {
  const f = fixture({status: 'needs_review'}); f.raw.issues = [{code: 'PASSPORT_MISSING'}];
  f.service.update(CUSTOMER); await f.service.flush();
  f.raw.status = 'ready'; f.raw.applicants[0].status = 'ready'; changeResult(f, 1);
  f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 2);
  changeResult(f, 2); f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 2);
  f.advance(600001); f.inbound(); changeResult(f, 3); f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 2);
  assert.equal(f.c.paymentStatus, 'unverified'); assert.equal(f.store.data.visaFulfilment, undefined);
});

test('semantic duplicate suppression survives restart and never replays an uncertain outcome under a different result', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture({send: uncertain ? async () => { throw Error('UNKNOWN_PRIVATE_RESULT'); } : undefined});
    f.service.update(CUSTOMER); await f.service.flush(); assert.equal(f.count(), 1);
    const restarted = new VisaDocumentNotifications(f.options);
    if (uncertain) { f.advance(600001); f.inbound(); }
    changeResult(f, 1); restarted.update(CUSTOMER); await restarted.flush();
    assert.equal(f.count(), 1); assert.equal(Object.values(restarted.data().items).at(-1).failure, 'DUPLICATE_FEEDBACK');
  }
});

test('default twelve-second quiet window holds feedback until inbound and original upload settle', async () => {
  const f = fixture(), options = {...f.options}; delete options.quietMs;
  const service = new VisaDocumentNotifications(options), item = service.update(CUSTOMER);
  await service.flush(); assert.equal(f.count(), 0); assert.equal(service.data().items[item.key].state, 'pending'); assert.equal(service.data().items[item.key].attempts, 0);
  f.advance(11999); await service.flush(); assert.equal(f.count(), 0);
  f.advance(1); await service.flush(); assert.equal(f.count(), 1);
});

test('busy input batches and a new inbound defer old completed feedback before new media is saved', async () => {
  let busy = true;
  const f = fixture({quietMs: 12000, isInboundBusy: () => busy});
  f.service.update(CUSTOMER); f.advance(12000); await f.service.flush(); assert.equal(f.count(), 0);
  busy = false; f.inbound(); await f.service.flush(); assert.equal(f.count(), 0);
  f.advance(12000); await f.service.flush(); assert.equal(f.count(), 1);
  const g = fixture({quietMs: 0, isInboundBusy: () => { throw Error('batcher not initialized'); }});
  g.service.update(CUSTOMER); await g.service.flush(); assert.equal(g.count(), 0);
});

test('an incoming message during delivery queue wait returns a known unsent notice to pending', async () => {
  let entered, release, effects = 0;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = fixture({quietMs: 12000, send: async (_to, _payload, guard) => { entered(); await held; try { guard(); } catch { throw Object.assign(Error('VISA_WHATSAPP_MESSAGE_SUPERSEDED'), {code:'VISA_WHATSAPP_MESSAGE_SUPERSEDED',notDispatched:true}); } effects++; return {messages: [{id: 'synthetic-after-batch'}]}; }});
  const item = f.service.update(CUSTOMER); f.advance(12000); const work = f.service.flush(); await started;
  f.advance(1); f.inbound(); release(); await work;
  assert.equal(effects, 0); assert.equal(f.service.data().items[item.key].state, 'pending'); assert.equal(f.service.data().items[item.key].failure, 'BATCH_SETTLING');
  f.advance(12000); await f.service.flush(); assert.equal(effects, 1); assert.equal(f.service.data().items[item.key].state, 'accepted');
});

test('receipt arrival invalidates the queued receipt request and subsequent notice does not ask again',async()=>{
 const f=fixture(),old=f.service.update(CUSTOMER);assert.match(old.payload.text,/بعد التحويل ابعت إيصال التحويل/);
 f.store.data.visaFulfilment={cases:{[CUSTOMER]:{caseId:f.c.id,receipts:{saved:{caseId:f.c.id}}}}};
 assert.equal(f.service.current(old),false);const next=f.service.update(CUSTOMER);assert.notEqual(next.key,old.key);assert.doesNotMatch(next.payload.text,/بعد التحويل ابعت إيصال التحويل/);
 await f.service.flush(CUSTOMER);assert.equal(f.dispatched.length,1);assert.doesNotMatch(f.dispatched[0].payload.text,/بعد التحويل ابعت إيصال التحويل/);
});

 test('completed automatic review reaches actionable clarification and is not lost in notification copy',async()=>{
 const f=fixture({status:'needs_review'});f.raw.issues=[{code:'PASSPORT_MRZ_DATE_AMBIGUOUS'}];
 const summary=f.intake.summary.bind(f.intake);f.intake.summary=customer=>({...summary(customer),recovery:{attempts:['completed']}});
 const item=f.service.update(CUSTOMER);assert.match(item.payload.text,/صفحة بيانات الجواز/);assert.doesNotMatch(item.payload.text,/إذا احتجنا منك/);await f.service.flush();assert.equal(f.count(),1);
 });

test('a single missing passport fact is asked calmly before any payment instruction',async()=>{
 const f=fixture({status:'needs_confirmation'});f.raw.issues=[{code:'DOCUMENT_FIELD_REQUIRED',field:'passportType'},{code:'DOCUMENT_FIELD_REQUIRED',field:'birthPlace'}];f.raw.awaitingPayment=true;const item=f.service.update(CUSTOMER);assert.match(item.payload.text,/اختار نوع جواز السفر/);assert.equal((item.payload.text.match(/؟/g)||[]).length,0);assert.doesNotMatch(item.payload.text,/قراءة|مطابقة|الخانات|حفظ الطلب|المحاسب|التحويل|رعد|مكان الولادة/);
});

function choiceFixture(){const f=fixture({status:'needs_confirmation'});f.raw.awaitingPayment=true;f.raw.applicants[0].id='12345678-1234-4321-abcd-123456789a99';f.raw.applicants[0].clientFieldsRequired=['passportType'];f.raw.applicants[0].issues=[{code:'DOCUMENT_FIELD_REQUIRED',field:'passportType'}];return f;}
test('passport type is a four-row WhatsApp list and selection is bound to the actual sender and dossier',async()=>{
 const f=choiceFixture(),before=structuredClone(f.c),item=f.service.update(CUSTOMER);assert.equal(item.payload.type,'question');assert.equal(item.payload.field,'passportType');assert.deepEqual(item.payload.options.map(o=>o.id),['ordinary','diplomatic','service','special']);
 let rendered;const adapter=require('../src/visa-whatsapp').createVisaWhatsAppAdapter({env:{DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic',WHATSAPP_PHONE_NUMBER_ID:'100000000001'},journal:{summary:()=>({serviceWindowOpen:true})},fetchImpl:async(_url,request)=>{rendered=JSON.parse(request.body);return {ok:true,json:async()=>({messages:[{id:'wamid.fake'}]})};}});await adapter.send(CUSTOMER,item.payload,()=>true,{customer:CUSTOMER});assert.equal(rendered.interactive.type,'list');assert.equal(rendered.interactive.action.sections[0].rows.length,4);
 await f.service.flush();const message=require('../src/whatsapp').extractIncomingMessages({entry:[{changes:[{field:'messages',value:{messages:[{from:CUSTOMER,id:'wamid.choice',type:'interactive',interactive:{type:'list_reply',list_reply:{id:rendered.interactive.action.sections[0].rows[0].id}}}]}}]}]})[0];assert.equal(f.service.receive({...message,from:OTHER}).ok,false);assert.equal(f.service.receive(message).ok,true);assert.equal(f.service.receive(message).duplicate,true);
 const answers=require('../src/visa-document-client-answers').documentClientAnswers(f.store,CUSTOMER,f.raw.applicants[0],NOW);assert.deepEqual(answers,{passportType:'ordinary'});assert.deepEqual(f.c,before);assert.equal(f.c.paymentStatus,'unverified');assert.equal(f.raw.applicants[0].fields.passportType,undefined);
 f.raw.applicants[0].id='12345678-1234-4321-abcd-123456789a98';assert.deepEqual(require('../src/visa-document-client-answers').documentClientAnswers(f.store,CUSTOMER,f.raw.applicants[0],NOW),{});
});
test('old, unsent, foreign, invalid and staff-paused lists cannot record an answer; plain typing never selects',async()=>{for(const mode of ['case','source','unsent','invalid','staff','typed']){const f=choiceFixture(),item=f.service.update(CUSTOMER);if(mode!=='unsent')await f.service.flush();if(mode==='case')f.c.id='new-case';if(mode==='source')f.source.checksum='f'.repeat(64);if(mode==='staff')f.own(true);const message={from:CUSTOMER,id:'wamid.choice',visaAnswer:{token:item.payload.token,option:mode==='invalid'?'unknown':'ordinary'}};if(mode==='typed'){delete message.visaAnswer;message.text='عادي';}const r=f.service.receive(message);assert.notEqual(r.ok,true,mode);assert.equal(f.service.data().items[item.key].answer,undefined,mode);}});

test('restart upgrades the existing open dossier to a list once and the same list never repeats',async()=>{const f=choiceFixture(),restarted=new VisaDocumentNotifications(f.options);assert.equal(Object.values(restarted.data().items).length,1);await restarted.flush();assert.equal(f.count(),1);const again=new VisaDocumentNotifications(f.options);await again.flush();assert.equal(f.count(),1);assert.equal(Object.values(again.data().items).filter(i=>i.state==='accepted').length,1);});
