'use strict';
// Local-only rollback compatibility proof against the current frozen candidate.
// Synthetic encrypted state/media and explicit fake provider responses only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const {verifyApprovedSource} = require('../lab-boundary.cjs');
// Verify the approved freeze and every source file before any app/dependency import.
const APP = verifyApprovedSource({source: process.env.INTEGRATION_LAB_SOURCE, freeze: process.env.INTEGRATION_LAB_FREEZE}).source;
const appRequire = createRequire(path.join(APP, 'package.json'));
const sharp = appRequire('sharp');
const {AssistantState} = appRequire('./src/assistant-state');
const {VisaMediaStore} = appRequire('./src/visa-media');
const {VisaDocumentIntake} = appRequire('./src/visa-document-intake');
const {createVisaMrzConsent} = appRequire('./src/visa-mrz-consent');
const {createMrzProfiles, MRZ_PRODUCTION_POLICY_FINGERPRINT: POLICY} = appRequire('./src/visa-mrz-profiles');
const {createDurableMrzBudget, provisionDurableMrzBudgetOffline} = appRequire('./src/visa-mrz-durable-budget');
const {visaCaseSignature} = appRequire('./src/visa-case-signature');
const NOW = Date.parse('2026-10-31T12:00:00Z');
const CUSTOMER = 'synthetic_rollback_lab_customer';
const STATE_KEY = 'synthetic-rollback-lab-state-key-not-a-real-secret';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const response = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const imagePromise = sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).png().toBuffer();
const hasCode = code => error => error?.code === code;
function digit(value) { return String([...value].reduce((sum, c, i) => sum + (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55) * [7, 3, 1][i % 3], 0) % 10); }
function mrz() {
  const first = 'P<EGYEXAMPLE<<SYNTHETIC'.padEnd(44, '<'), number = 'N12345678', birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const body = number + digit(number) + 'EGY' + birth + digit(birth) + 'F' + expiry + digit(expiry) + optional + digit(optional);
  return [first, body + digit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43))];
}
function generation() { return response({model: 'gpt-6-astra', status: 'completed', usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}, output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({version: 1, lines: mrz()})}]}]}); }
function stateAt(file) {
  const store = new AssistantState({file, key: STATE_KEY, now: () => NOW});
  // Explicit fixture seam, not a claim that a temporary test path is a real mount.
  store.status = () => ({durableStorageConfirmed: true});
  return store;
}
function bytesAt(file) { return fs.existsSync(file) ? fs.readFileSync(file) : null; }
function durablePair(file) { return {ledger: bytesAt(file), anchor: bytesAt(file + '.anchor')}; }
function assertPairEqual(actual, expected) { assert.deepEqual(actual.ledger, expected.ledger); assert.deepEqual(actual.anchor, expected.anchor); }
async function fixture(t, {provision = true} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-lab-'));
  const stateFile = path.join(directory, 'assistant-state.enc'), ledgerFile = path.join(directory, 'visa-mrz-budget.enc');
  const store = stateAt(stateFile), c = {id: crypto.randomUUID(), createdAt: NOW - 10000, policyVersion: 'synthetic-rollback-lab-policy', applicantCount: 1, applicants: [{nationality: 'synthetic'}], documents: [], submissionStatus: 'not_submitted'};
  store.data.visaCases = {[CUSTOMER]: c}; store.save();
  // One-time creation of isolated fixture history. Runtime paths never call this.
  if (provision) provisionDurableMrzBudgetOffline({file: ledgerFile, key: store.key, policyFingerprint: POLICY, capUsd: 1.2,
    persistentStateConfirmed: true, ownerApproved: true, historyReconciled: true,
    historyEvidenceSha256: hash('synthetic-fixture-history-reconciliation'), historicalSpentUsd: 0.96});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes.reverse()) { try { await r.profiles.close(); } catch {} }
    // Destruction is limited to this fresh synthetic test directory, never recovery.
    fs.rmSync(directory, {recursive: true, force: true});
  });
  function makeRuntime(runtimeStore = store, {enabled = true} = {}) {
    const consents = createVisaMrzConsent({store: runtimeStore, now: () => NOW});
    const media = new VisaMediaStore({store: runtimeStore, env: {NODE_ENV: 'test'}, now: () => NOW});
    const calls = [], localCalls = [];
    const env = {RAAD_MRZ_PROVIDER: 'openai', RAAD_MRZ_PRODUCTION_ENABLED: enabled ? 'true' : 'false', RAAD_MRZ_PRODUCTION_POLICY_SHA256: POLICY,
      RAAD_MRZ_PRODUCTION_BUDGET_USD: '1.2', OPENAI_API_KEY: 'synthetic-lab-key-never-sent'};
    let budget, budgetCreations = 0;
    const localReader = {policyFingerprint: hash('synthetic-local-reader'), supports: () => true, ready: () => true,
      status: () => ({local: true, configured: true}), extract: async input => { localCalls.push(true); input.guard(); return {version: 1, mrzLines: [], checks: {}}; }};
    const profiles = createMrzProfiles({env, store: runtimeStore, consents, localReader, now: () => NOW,
      persistentMountImpl: () => true, createBudget: config => { budgetCreations++; budget = createDurableMrzBudget(config); return budget; },
      fetchImpl: async (url, init) => {
        // No network primitive is called. Refuse an unexpected transport contract.
        assert.equal(init.method, 'POST'); assert(['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses'].includes(String(url)));
        calls.push(String(url)); return String(url).endsWith('/input_tokens') ? response({input_tokens: 100}) : generation();
      }});
    const vision = {status: () => ({configured: true}), ready: () => true, extract: async () => { throw Error('LAB_PRIMARY_PROVIDER_FORBIDDEN'); }};
    const intake = new VisaDocumentIntake({store: runtimeStore, mediaStore: media, vision, mrzVision: localReader, mrzProfiles: profiles,
      env: {RAAD_DOCUMENT_OCR_ENABLED: 'true'}, now: () => NOW, lock: {tryAcquire: () => false, release() {}, onRelease: () => () => {}}});
    const runtime = {store: runtimeStore, consents, media, env, profiles, intake, calls, localCalls,
      get budget() { return budget; }, get budgetCreations() { return budgetCreations; }};
    runtimes.push(runtime); return runtime;
  }
  async function upload(r) {
    const current = r.store.data.visaCases[CUSTOMER], signature = visaCaseSignature(current), sessionId = crypto.randomUUID();
    const staged = await r.media.storeUpload(CUSTOMER, {bytes: Buffer.from(await imagePromise), mimeType: 'image/png', role: 'passport', sessionId, caseId: current.id});
    r.store.data.visaUpload ||= {version: 1, sessions: {}};
    r.store.data.visaUpload.sessions[sessionId] = {id: sessionId, customer: CUSTOMER, caseId: current.id, caseSignature: signature,
      state: 'completed', completedAt: NOW, expiresAt: NOW + 3600000, files: [{id: staged.id, role: 'passport'}]};
    r.media.activateUploads(CUSTOMER, {sessionId, mediaIds: [staged.id]});
    const source = r.media.records[staged.id], context = {customer: CUSTOMER, caseId: current.id, caseSignature: signature, source};
    const ref = r.consents.grantUpload({...context, ...r.profiles.uploadConsentOptions(), sources: [source], sessionId, expiresAt: NOW + 3600000})[source.id];
    assert.equal(r.intake.enqueue(CUSTOMER, source.id, {mrzConsent: ref}), true);
    const job = Object.values(r.intake.data().jobs).find(item => item.mediaId === source.id);
    job.sourceSha256 = source.checksum; job.status = 'ready';
    job.pages[1] = {mediaId: job.mediaId, page: 1, sha256: hash(await imagePromise), sourceSha256: job.sourceSha256,
      mrzProfileKey: r.intake.mrzProfileKey(job), mrzFocusPending: true,
      extraction: {version: 1, kind: 'passport', readable: true, rotation: 0, fields: {}, mrzLines: [], portraitBox: null}};
    r.store.save(); return {job, source, context, ref};
  }
  async function read(r, job) {
    const bytes = Buffer.from(await imagePromise);
    try { return await r.intake.focusMrzPage(r.intake.snapshot(job), 1, {bytes, mimeType: 'image/png'}); }
    finally { bytes.fill(0); }
  }
  function reader() { return createDurableMrzBudget({file: ledgerFile, key: store.key, policyFingerprint: POLICY, capUsd: 1.2, persistentStateConfirmed: true}); }
  return {directory, stateFile, ledgerFile, store, makeRuntime, upload, read, reader};
}

test('disabling the current profile blocks new reads and quarantines cached profiled evidence without downgrade or refund', async t => {
  const f = await fixture(t), r = f.makeRuntime(); await r.profiles.start();
  const uploaded = await f.upload(r); await f.read(r, uploaded.job);
  assert.deepEqual(uploaded.job.pages[1].extraction.mrzLines, mrz()); assert.equal(r.calls.length, 2);
  const before = durablePair(f.ledgerFile), status = r.budget.status(), binding = structuredClone(uploaded.job.mrzProfile), pages = structuredClone(uploaded.job.pages);
  const state = r.intake.data().cases[CUSTOMER]; state.status = 'ready'; state.inputFingerprint = hash('cached-input'); state.resultFingerprint = hash('cached-result');
  state.applicants = [{id: crypto.randomUUID(), applicantIndex: 0, status: 'ready', identityReady: true, applied: true, fields: {}, documents: {}, issues: []}];r.store.save();
  r.env.RAAD_MRZ_PRODUCTION_ENABLED = 'false';
  assert.equal(r.profiles.status().enabled, false); assert.equal(r.profiles.uploadConsentOptions(), null);
  assert.throws(() => r.profiles.resolve(uploaded.job.mrzProfile), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.throws(() => r.profiles.guard(uploaded.job.mrzProfile, uploaded.context), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  await assert.rejects(f.read(r, uploaded.job), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  const result = await r.intake.refresh(CUSTOMER); assert.equal(result.readyForQuestions, false);
  assert.equal(state.status, 'needs_review'); assert.equal(state.applicants[0].status, 'needs_review'); assert.equal(state.applicants[0].applied, false);
  assert.equal(state.inputFingerprint, undefined); assert.equal(state.resultFingerprint, undefined);
  assert.deepEqual(uploaded.job.mrzProfile, binding); assert.deepEqual(uploaded.job.pages, pages); assert.equal(r.localCalls.length, 0); assert.equal(r.calls.length, 2);
  assert.deepEqual(r.budget.status(), status); assertPairEqual(durablePair(f.ledgerFile), before);
  await r.profiles.drainAndClose({timeoutMs: 1000, pollMs: 1}); assert.equal(fs.existsSync(f.ledgerFile + '.lock'), false);
  assertPairEqual(durablePair(f.ledgerFile), before);
});

test('disabled restart preserves current bindings, cached review status and the separate ledger without opening or creating an allowance', async t => {
  const f = await fixture(t), r = f.makeRuntime(); await r.profiles.start(); const uploaded = await f.upload(r); await f.read(r, uploaded.job);
  r.env.RAAD_MRZ_PRODUCTION_ENABLED = 'false';r.intake.quarantineProfiledEvidence(CUSTOMER);r.store.save();
  const before = durablePair(f.ledgerFile), binding = structuredClone(uploaded.job.mrzProfile), status = r.budget.status(); await r.profiles.close();
  const restoredStore = stateAt(f.stateFile), next = f.makeRuntime(restoredStore, {enabled: false});await next.profiles.start();
  const restoredJob = Object.values(next.intake.data().jobs).find(item => item.id === uploaded.job.id);
  assert.deepEqual(restoredJob.mrzProfile, binding); assert.equal(next.intake.data().cases[CUSTOMER].status, 'needs_review');
  assert.equal((await next.intake.refresh(CUSTOMER)).readyForQuestions, false);assert.equal(next.budgetCreations, 0);assert.equal(next.calls.length, 0);assert.equal(next.localCalls.length, 0);
  assert.equal(fs.existsSync(f.ledgerFile + '.lock'), false);assertPairEqual(durablePair(f.ledgerFile), before);
  const ledger = f.reader();await ledger.open();assert.deepEqual(ledger.status(),status);ledger.close();assertPairEqual(durablePair(f.ledgerFile),before);
});

test('restoring only an older synthetic assistant-state backup cannot restore a spent independent allowance or replay a stable attempt', async t => {
  const f = await fixture(t), r = f.makeRuntime();await r.profiles.start();const uploaded = await f.upload(r);
  const ordinaryStateBackup = fs.readFileSync(f.stateFile);assert.equal(uploaded.job.pages[1].mrzFocusPending,true);
  await f.read(r,uploaded.job);assert.equal(r.calls.length,2);const status=r.budget.status(),before=durablePair(f.ledgerFile);assert.equal(status.reservations,1);assert.equal(status.settlements,1);assert.equal(status.reservedUsd,1.08);await r.profiles.close();
  // Deliberately restore this test fixture's ordinary encrypted state only.
  // The ledger and anchor are never copied, removed, reset, or reprovisioned.
  fs.writeFileSync(f.stateFile,ordinaryStateBackup,{mode:0o600,flush:true});
  const next=f.makeRuntime(stateAt(f.stateFile));await next.profiles.start();
  const job=Object.values(next.intake.data().jobs).find(item=>item.id===uploaded.job.id);assert.equal(job.pages[1].mrzFocusPending,true);assert.deepEqual(job.pages[1].extraction.mrzLines,[]);
  await f.read(next,job);assert.equal(next.calls.length,0);assert.equal(next.localCalls.length,0);assert.deepEqual(job.pages[1].extraction.mrzLines,[]);assert.equal(job.pages[1].mrzFocusStatus,'needs_review');
  assert.deepEqual(next.budget.status(),status);assertPairEqual(durablePair(f.ledgerFile),before);
});

test('a disabled runtime never creates missing ledger history and later enablement still fails closed without provisioning', async t => {
  const f=await fixture(t,{provision:false}),r=f.makeRuntime(f.store,{enabled:false});
  await r.profiles.start();assert.equal(r.budgetCreations,0);assert.equal(r.calls.length,0);assert.equal(fs.existsSync(f.ledgerFile),false);assert.equal(fs.existsSync(f.ledgerFile+'.anchor'),false);assert.equal(fs.existsSync(f.ledgerFile+'.lock'),false);
  r.env.RAAD_MRZ_PRODUCTION_ENABLED='true';await assert.rejects(r.profiles.start(),hasCode('MRZ_PROFILE_NOT_CONFIGURED'));assert.equal(r.calls.length,0);
  assert.equal(fs.existsSync(f.ledgerFile),false);assert.equal(fs.existsSync(f.ledgerFile+'.anchor'),false);assert.equal(fs.existsSync(f.ledgerFile+'.lock'),false);
});
