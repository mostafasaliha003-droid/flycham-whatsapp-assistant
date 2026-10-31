'use strict';

// Real encrypted state/media, upload consent, profile resolution, intake and
// durable ledger. All bytes, approvals and history here are synthetic fixtures;
// only persistence attestations and provider transport are injected for tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const {AssistantState} = require('../src/assistant-state');
const {VisaMediaStore} = require('../src/visa-media');
const {VisaDocumentIntake} = require('../src/visa-document-intake');
const {createVisaMrzConsent} = require('../src/visa-mrz-consent');
const {createMrzProfiles, MRZ_PRODUCTION_POLICY_FINGERPRINT: POLICY, INPUT_POLICY} = require('../src/visa-mrz-profiles');
const {createDurableMrzBudget, provisionDurableMrzBudgetOffline} = require('../src/visa-mrz-durable-budget');
const {visaCaseSignature} = require('../src/visa-case-signature');
const NOW = Date.parse('2026-10-31T12:00:00Z'), CUSTOMER = 'synthetic_composition_customer';
const STATE_KEY = 'synthetic-composition-state-key-not-a-real-secret';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const response = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const imagePromise = sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).png().toBuffer();
function digit(value) { return String([...value].reduce((sum, c, i) => sum + (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55) * [7, 3, 1][i % 3], 0) % 10); }
function mrz() {
  const first = 'P<EGYEXAMPLE<<SYNTHETIC'.padEnd(44, '<'), number = 'N12345678', birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const body = number + digit(number) + 'EGY' + birth + digit(birth) + 'F' + expiry + digit(expiry) + optional + digit(optional);
  return [first, body + digit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43))];
}
const generation = () => response({model: 'gpt-6-astra', status: 'completed',
  usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}, output: [{type: 'message', role: 'assistant',
    content: [{type: 'output_text', text: JSON.stringify({version: 1, lines: mrz()})}]}]});
const hasCode = code => error => error?.code === code;
function stateAt(file) {
  const store = new AssistantState({file, key: STATE_KEY, now: () => NOW});
  // A temp directory is not a production mount. Tests attest persistence only
  // through the explicit factory seams and never claim a real mount was found.
  store.status = () => ({durableStorageConfirmed: true});
  return store;
}
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrz-composition-'));
  const stateFile = path.join(directory, 'assistant-state.enc'), ledgerFile = path.join(directory, 'visa-mrz-budget.enc');
  const store = stateAt(stateFile), c = {id: crypto.randomUUID(), createdAt: NOW - 10000,
    policyVersion: 'synthetic-composition-policy', applicantCount: 1, applicants: [{nationality: 'synthetic'}],
    documents: [], submissionStatus: 'not_submitted'};
  store.data.visaCases = {[CUSTOMER]: c}; store.save();
  provisionDurableMrzBudgetOffline({file: ledgerFile, key: store.key, policyFingerprint: POLICY, capUsd: options.capUsd || 1.2,
    persistentStateConfirmed: true, ownerApproved: true, historyReconciled: true,
    historyEvidenceSha256: hash('synthetic-offline-history-reconciliation'), historicalSpentUsd: 0.96});
  const instances = [];
  t.after(async () => {
    for (const item of instances.reverse()) { try { await item.profiles.close(); } catch {} }
    // Explicit test fixture destruction also removes intentionally retained
    // poisoned locks; application close has no such recovery path.
    fs.rmSync(directory, {recursive: true, force: true});
  });
  async function runtime(runtimeStore = store, hooks = {}) {
    const consents = createVisaMrzConsent({store: runtimeStore, now: () => NOW});
    const media = new VisaMediaStore({store: runtimeStore, env: {NODE_ENV: 'test'}, now: () => NOW});
    const calls = [], localCalls = [];
    const localReader = {policyFingerprint: hash('synthetic-local-reader'), supports: () => true, ready: () => true,
      status: () => ({local: true, configured: true}), extract: async input => { localCalls.push(input); input.guard(); return {version: 1, mrzLines: [], checks: {}}; }};
    let budget;
    const env = {RAAD_MRZ_PROVIDER: 'openai', RAAD_MRZ_PRODUCTION_ENABLED: 'true', RAAD_MRZ_PRODUCTION_POLICY_SHA256: POLICY,
      RAAD_MRZ_PRODUCTION_BUDGET_USD: String(options.capUsd || 1.2), OPENAI_API_KEY: 'synthetic_composition_openai_key'};
    const profiles = createMrzProfiles({env, store: runtimeStore, consents, localReader, now: () => NOW,
      persistentMountImpl: () => true, createBudget: config => {
        budget = createDurableMrzBudget(config);
        if (!hooks.beforeSettle) return budget;
        return {get durable() { return budget.durable; }, open: () => budget.open(), close: () => budget.close(),
          status: () => budget.status(), reserve: value => budget.reserve(value),
          settle: async value => { await hooks.beforeSettle(value); return budget.settle(value); }};
      },
      fetchImpl: async (url, init) => {
        calls.push({url, init}); if (hooks.fetch) return hooks.fetch({url, init, consents, calls});
        return url.endsWith('/input_tokens') ? response({input_tokens: 100}) : generation();
      }});
    await profiles.start();
    const vision = {status: () => ({configured: true}), ready: () => true,
      extract: async () => { throw Error('UNEXPECTED_PRIMARY_PROVIDER_CALL'); }};
    const intake = new VisaDocumentIntake({store: runtimeStore, mediaStore: media, vision, mrzVision: localReader,
      mrzProfiles: profiles, env: {RAAD_DOCUMENT_OCR_ENABLED: 'true'}, now: () => NOW,
      lock: {tryAcquire: () => false, release() {}, onRelease: () => () => {}}});
    const result = {store: runtimeStore, consents, media, calls, localCalls, profiles, intake, env, get budget() { return budget; }};
    instances.push(result); return result;
  }
  const first = await runtime(store, options);
  async function upload(r = first, {grant = true, bytes, role = 'passport'} = {}) {
    const content = bytes || Buffer.from(await imagePromise), current = r.store.data.visaCases[CUSTOMER], signature = visaCaseSignature(current), sessionId = crypto.randomUUID();
    const staged = await r.media.storeUpload(CUSTOMER, {bytes: content, mimeType: 'image/png', role, sessionId, caseId: current.id});
    r.store.data.visaUpload ||= {version: 1, sessions: {}};
    r.store.data.visaUpload.sessions[sessionId] = {id: sessionId, customer: CUSTOMER, caseId: current.id, caseSignature: signature,
      state: 'completed', completedAt: NOW, expiresAt: NOW + 3600000, files: [{id: staged.id, role}]};
    r.media.activateUploads(CUSTOMER, {sessionId, mediaIds: [staged.id]});
    const source = r.media.records[staged.id], context = {customer: CUSTOMER, caseId: current.id, caseSignature: signature, source};
    const refs = grant ? r.consents.grantUpload({...context, ...r.profiles.uploadConsentOptions(), sources: [source], sessionId,
      expiresAt: NOW + 3600000}) : {};
    return {id: source.id, source, context, ref: refs[source.id]};
  }
  function enqueue(r, uploaded, optIn = true) {
    assert.equal(r.intake.enqueue(CUSTOMER, uploaded.id, optIn && uploaded.ref ? {mrzConsent: uploaded.ref} : {}), true);
    return Object.values(r.intake.data().jobs).find(job => job.mediaId === uploaded.id);
  }
  async function checkpoint(r, job) {
    const bytes = Buffer.from(await imagePromise); job.sourceSha256 = r.media.records[job.mediaId].checksum;
    job.status = 'ready'; job.pages[1] = {mediaId: job.mediaId, page: 1, sha256: hash(bytes), sourceSha256: job.sourceSha256,
      ...(job.mrzProfile ? {mrzProfileKey: r.intake.mrzProfileKey(job)} : {}), mrzFocusPending: true,
      extraction: {version: 1, kind: 'passport', readable: true, rotation: 0, fields: {}, mrzLines: [], portraitBox: null}};
    r.store.save(); return {bytes, mimeType: 'image/png'};
  }
  return {directory, stateFile, ledgerFile, first, runtime, upload, enqueue, checkpoint};
}

test('real upload metadata and persisted consent opt in only a newly enqueued job', async t => {
  const f = await fixture(t), r = f.first, oldUpload = await f.upload(r, {grant: false});
  const oldJob = f.enqueue(r, oldUpload, false);
  assert.equal(Object.hasOwn(oldJob, 'mrzProfile'), false);
  const historicalRef = r.consents.grantUpload({...oldUpload.context, ...r.profiles.uploadConsentOptions(), sources: [oldUpload.source],
    sessionId: oldUpload.source.uploadSessionId, expiresAt: NOW + 3600000})[oldUpload.id];
  assert.equal(r.intake.enqueue(CUSTOMER, oldUpload.id, {mrzConsent: historicalRef}), false);
  assert.equal(Object.hasOwn(oldJob, 'mrzProfile'), false);
  const next = await f.upload(), job = f.enqueue(r, next);
  assert.equal(job.mrzProfile.provider, 'openai'); assert.equal(r.profiles.guard(job.mrzProfile, next.context), true);
  assert.equal(r.media.get(next.id, {customer: CUSTOMER}).checksum, undefined);
  assert.equal(job.mrzProfile.sourceSha256, r.media.records[next.id].checksum);
  const ordinary = await f.upload(r, {grant: false}); r.intake.backfill();
  assert.equal(Object.hasOwn(Object.values(r.intake.data().jobs).find(item => item.mediaId === ordinary.id), 'mrzProfile'), false);
  const page = await f.checkpoint(r, job); await r.intake.focusMrzPage(r.intake.snapshot(job), 1, page); page.bytes.fill(0);
  assert.deepEqual(job.pages[1].extraction.mrzLines, mrz()); assert.equal(r.calls.length, 2);
  assert.equal(r.localCalls.length, 0); assert.equal(r.budget.status().historicalSpentUsd, 0.96);
  assert.equal(r.budget.status().reservedUsd, 1.08);
});

test('same source bytes in a new media UUID and consent retain one real billing reservation', async t => {
  const f = await fixture(t), r = f.first, first = await f.upload(), job = f.enqueue(r, first), page = await f.checkpoint(r, job);
  await r.intake.focusMrzPage(r.intake.snapshot(job), 1, page); page.bytes.fill(0);
  const second = await f.upload(), duplicate = f.enqueue(r, second), secondPage = await f.checkpoint(r, duplicate);
  assert.notEqual(first.id, second.id); assert.notEqual(first.ref.consentId, second.ref.consentId);
  assert.equal(first.source.checksum, second.source.checksum); assert.notEqual(r.intake.mrzProfileKey(job), r.intake.mrzProfileKey(duplicate));
  await r.intake.focusMrzPage(r.intake.snapshot(duplicate), 1, secondPage); secondPage.bytes.fill(0);
  assert.equal(r.calls.length, 2); assert.equal(r.budget.status().reservations, 1); assert.equal(r.budget.status().settlements, 1);
  assert.deepEqual(duplicate.pages[1].extraction.mrzLines, []); assert.equal(duplicate.pages[1].mrzFocusStatus, 'needs_review');
});

test('real consent revocation blocks generation and quarantines an earlier ready checkpoint', async t => {
  let target;
  const f = await fixture(t, {fetch: ({url, consents}) => {
    if (url.endsWith('/input_tokens')) { consents.revoke(target.ref, {customer: CUSTOMER}); return response({input_tokens: 100}); }
    throw Error('GENERATION_MUST_NOT_START');
  }}), r = f.first;
  target = await f.upload(); const job = f.enqueue(r, target), page = await f.checkpoint(r, job);
  await r.intake.focusMrzPage(r.intake.snapshot(job), 1, page); page.bytes.fill(0);
  assert.equal(r.calls.length, 1); assert.equal(r.budget.status().reservations, 1); assert.equal(r.budget.status().settlements, 1);
  assert.deepEqual(job.pages[1].extraction.mrzLines, []); assert.equal(r.intake.quarantineProfiledEvidence(CUSTOMER), true);
  assert.equal(r.intake.data().cases[CUSTOMER].status, 'needs_review');
  await assert.rejects(r.intake.focusMrzPage(r.intake.snapshot(job), 1, {bytes: Buffer.from(await imagePromise), mimeType: 'image/png'}), hasCode('MRZ_PROFILE_CONSENT_REQUIRED'));
  assert.equal(r.calls.length, 1);
});

test('revocation after a successful real read prevents cached result acceptance without another request', async t => {
  const f = await fixture(t), r = f.first, uploaded = await f.upload(), job = f.enqueue(r, uploaded), page = await f.checkpoint(r, job);
  await r.intake.focusMrzPage(r.intake.snapshot(job), 1, page); page.bytes.fill(0); assert.deepEqual(job.pages[1].extraction.mrzLines, mrz());
  r.consents.revoke(uploaded.ref, {customer: CUSTOMER});
  job.pages[1].extraction.mrzLines = []; job.pages[1].mrzFocusPending = true;
  const state = r.intake.data().cases[CUSTOMER]; state.inputFingerprint = hash('old-input'); state.resultFingerprint = hash('old-result');
  assert.equal(r.intake.quarantineProfiledEvidence(CUSTOMER), true); assert.equal(state.inputFingerprint, undefined); assert.equal(state.resultFingerprint, undefined);
  await assert.rejects(r.intake.focusMrzPage(r.intake.snapshot(job), 1, {bytes: Buffer.from(await imagePromise), mimeType: 'image/png'}), hasCode('MRZ_PROFILE_CONSENT_REQUIRED'));
  assert.deepEqual(job.pages[1].extraction.mrzLines, []); assert.equal(r.calls.length, 2);
});

test('fresh real state/profile restart preserves prior spending and rejects a duplicate stable key', async t => {
  const f = await fixture(t), r = f.first, uploaded = await f.upload();
  const binding = r.profiles.bindNewJob({...uploaded.context, mrzConsent: uploaded.ref}), stableKey = hash('synthetic-stable-source-page-billing');
  const input = {bytes: Buffer.from(await imagePromise), mimeType: 'image/png', format: 'TD3', attemptKey: hash('first-operational-attempt'),
    billingAttemptKey: stableKey, guard: () => r.profiles.guard(binding, uploaded.context)};
  await r.profiles.resolve(binding).extract(input); input.bytes.fill(0); assert.equal(r.budget.status().reservedUsd, 1.08);
  await r.profiles.close();
  const nextStore = stateAt(f.stateFile), next = await f.runtime(nextStore), source = next.media.records[uploaded.id];
  const nextContext = {...uploaded.context, source}; assert.equal(next.profiles.guard(binding, nextContext), true);
  assert.equal(next.budget.status().historicalSpentUsd, 0.96); assert.equal(next.budget.status().reservedUsd, 1.08);
  assert.equal(next.budget.status().reservations, 1); assert.equal(next.budget.status().settlements, 1);
  await assert.rejects(next.profiles.resolve(binding).extract({bytes: Buffer.from(await imagePromise), mimeType: 'image/png', format: 'TD3',
    attemptKey: hash('new-operational-attempt-after-restart'), billingAttemptKey: stableKey,
    guard: () => next.profiles.guard(binding, nextContext)}), hasCode('MRZ_OPENAI_ATTEMPT_ALREADY_RESERVED'));
  assert.equal(next.calls.length, 0); assert.equal(next.budget.status().reservedUsd, 1.08);
});

test('ambiguous real consent save poisons configuration and retains the real ledger lock across restart', async t => {
  const f = await fixture(t), r = f.first, uploaded = await f.upload();
  const binding = r.profiles.bindNewJob({...uploaded.context, mrzConsent: uploaded.ref});
  const lockBytes = fs.readFileSync(f.ledgerFile + '.lock');
  r.store.save = () => { throw Error('synthetic ambiguous consent fsync'); };
  assert.throws(() => r.consents.revoke(uploaded.ref, {customer: CUSTOMER}), hasCode('MRZ_CONSENT_UNAVAILABLE'));
  assert.equal(r.consents.healthy, false); assert.equal(r.profiles.uploadConsentOptions(), null);
  assert.throws(() => r.profiles.guard(binding, uploaded.context), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  await assert.rejects(r.profiles.close(), hasCode('MRZ_PROFILE_CONSENT_UNCONFIRMED'));
  assert.deepEqual(fs.readFileSync(f.ledgerFile + '.lock'), lockBytes);
  await assert.rejects(f.runtime(stateAt(f.stateFile)), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.deepEqual(fs.readFileSync(f.ledgerFile + '.lock'), lockBytes); assert.equal(r.calls.length, 0);
});


test('graceful drain retains the real ledger lock through held generation and durable settlement', async t => {
  const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
  const generating = deferred(), generationGate = deferred(), settling = deferred(), settlementGate = deferred();
  const f = await fixture(t, {fetch: ({url}) => {
    if (url.endsWith('/input_tokens')) return response({input_tokens: 100});
    generating.resolve(); return generationGate.promise;
  }, beforeSettle: async () => { settling.resolve(); await settlementGate.promise; }}), r = f.first;
  const uploaded = await f.upload(), binding = r.profiles.bindNewJob({...uploaded.context, mrzConsent: uploaded.ref}), reader = r.profiles.resolve(binding);
  const read = reader.extract({bytes: Buffer.from(await imagePromise), mimeType: 'image/png', format: 'TD3',
    attemptKey: hash('synthetic-drain-operational'), billingAttemptKey: hash('synthetic-drain-billing'),
    guard: () => r.profiles.guard(binding, uploaded.context)});
  await generating.promise; let closed = false;
  const drain = r.profiles.drainAndClose({timeoutMs: 1000, pollMs: 1}).then(() => { closed = true; });
  assert.equal(reader.ready(), false); assert.equal(fs.existsSync(f.ledgerFile + '.lock'), true);
  assert.equal(r.budget.status().reservations, 1); assert.equal(r.budget.status().settlements, 0);
  assert.throws(() => r.profiles.resolve(binding), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  generationGate.resolve(generation()); await settling.promise;
  assert.equal(closed, false); assert.equal(fs.existsSync(f.ledgerFile + '.lock'), true); assert.equal(r.budget.status().settlements, 0);
  settlementGate.resolve(); assert.deepEqual((await read).mrzLines, mrz()); await drain;
  assert.equal(closed, true); assert.equal(fs.existsSync(f.ledgerFile + '.lock'), false);
  const reopened = createDurableMrzBudget({file: f.ledgerFile, key: r.store.key, policyFingerprint: POLICY, capUsd: 1.2, persistentStateConfirmed: true});
  await reopened.open(); assert.equal(reopened.status().reservedUsd, 1.08); assert.equal(reopened.status().settlements, 1); reopened.close();
});
