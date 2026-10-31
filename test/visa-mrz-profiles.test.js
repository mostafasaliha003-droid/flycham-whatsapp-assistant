'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {createMrzProfiles, MRZ_PRODUCTION_POLICY_FINGERPRINT: POLICY, INPUT_POLICY} = require('../src/visa-mrz-profiles');
const {visaCaseSignature} = require('../src/visa-case-signature');
const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64), PRIVATE = 'synthetic_private_provider_text';
const KEY = 'synthetic_key_not_a_real_secret';
const NOW = 1793443200000;
const TD3 = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
const image = sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).png().toBuffer();
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
const response = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const hasCode = code => error => error?.code === code;
function fixture(options = {}) {
  const customer = 'synthetic_customer', c = {id: 'synthetic_case', applicantCount: 1, applicants: []};
  const source = {id: '00000000-0000-4000-8000-000000000001', customer, checksum: SHA,
    type: 'image', mimeType: 'image/png', expiresAt: NOW + 10000};
  const context = {customer, caseId: c.id, caseSignature: visaCaseSignature(c), source};
  const ref = {consentId: 'synthetic_consent', consentDigest: OTHER};
  const store = {file: '/var/data/assistant-state.enc', key: Buffer.alloc(32, 1), data: {
    visaCases: {[customer]: c}, visaMedia: {[source.id]: source}}, status: () => ({durableStorageConfirmed: true})};
  const env = {RAAD_MRZ_PROVIDER: 'openai', RAAD_MRZ_PRODUCTION_ENABLED: 'true',
    RAAD_MRZ_PRODUCTION_POLICY_SHA256: POLICY, RAAD_MRZ_PRODUCTION_BUDGET_USD: '0.84', OPENAI_API_KEY: KEY, ...options.env};
  const calls = {create: [], open: 0, close: 0, fetch: [], reserve: [], settle: [], verify: []};
  let durable = false, consentValid = true;
  const reservations = new Set();
  const budget = {get durable() { return durable; }, open: async () => { calls.open++; if (options.openError) throw Error(PRIVATE); durable = true; options.onOpen?.(); },
    close: () => { calls.close++; durable = false; },
    status: () => ({capUsd: options.ledgerCap ?? 0.84, policyFingerprint: options.ledgerPolicy ?? POLICY}),
    reserve: async value => { calls.reserve.push(value); const existing = reservations.has(value.attemptKey); reservations.add(value.attemptKey);
      return {committed: true, reservationId: OTHER, reservedUsd: 0.12, capUsd: 0.84, existing}; },
    settle: async value => { calls.settle.push(value); return options.settle ? options.settle(value) : {committed: true}; }};
  const consents = {healthy: true, verify: (grant, scope) => { calls.verify.push({grant, scope}); return consentValid && grant.consentId === ref.consentId
    && grant.consentDigest === ref.consentDigest && scope.customer === customer && scope.caseId === c.id && scope.caseSignature === context.caseSignature
    && scope.source.id === source.id && scope.provider === 'openai' && scope.readerFingerprint === POLICY && scope.inputPolicy === INPUT_POLICY && scope.policySha256 === POLICY; }};
  const localReader = {local: true, extract: async () => { throw Error('LOCAL_NOT_EXPECTED'); }};
  const profiles = createMrzProfiles({env, store: options.store || store, localReader, consents: options.consents || consents,
    now: () => NOW, persistentMountImpl: () => options.mount !== false,
    createBudget: opts => { calls.create.push(opts); return budget; },
    ...(options.setTimerImpl ? {setTimerImpl: options.setTimerImpl, clearTimerImpl: () => {}} : {}),
    fetchImpl: async (url, init) => { calls.fetch.push({url, init}); if (options.fetch) return options.fetch(url, init);
      return url.endsWith('/input_tokens') ? response({input_tokens: 100}) : response({model: 'gpt-6-astra', status: 'completed',
        usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}, output: [{type: 'message', role: 'assistant',
          content: [{type: 'output_text', text: JSON.stringify({version: 1, lines: TD3})}]}]}); }});
  return {profiles, context, ref, store, env, calls, budget, localReader, setConsent: value => { consentValid = value; },
    bind: () => profiles.bindNewJob({...context, mrzConsent: ref}),
    input: async binding => ({bytes: Buffer.from(await image), mimeType: 'image/png', format: 'TD3',
      attemptKey: SHA, billingAttemptKey: OTHER, guard: () => profiles.guard(binding, context)})};
}

test('default construction and start do not inspect storage or allocate a remote profile', async () => {
  let effects = 0;
  const store = new Proxy({}, {get() { effects++; throw Error('UNEXPECTED_STORE_ACCESS'); }});
  const localReader = {local: true};
  const profiles = createMrzProfiles({env: {}, store, localReader, createBudget: () => { effects++; }, fetchImpl: () => { effects++; }});
  assert.equal(effects, 0);
  await profiles.start();
  assert.equal(profiles.resolve(), localReader);
  assert.equal(profiles.bindNewJob(), null);
  assert.equal(profiles.uploadConsentOptions(), null);
  await profiles.close(); await profiles.drainAndClose();
  assert.equal(effects, 0);
});

test('legacy evaluator flag cannot activate the production factory', async () => {
  const f = fixture({env: {RAAD_MRZ_PRODUCTION_ENABLED: undefined, RAAD_MRZ_OPENAI_ENABLED: 'true'}});
  await f.profiles.start(); assert.equal(f.profiles.resolve(null), f.localReader);
  assert.equal(f.calls.open, 0); assert.equal(f.calls.fetch.length, 0);
});

test('explicit start opens only the supplied existing sibling ledger and uses its cap', async () => {
  const f = fixture(); assert.equal(f.calls.create.length, 0);
  await f.profiles.start(); await f.profiles.start();
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.open, 1);
  const config = f.calls.create[0]; assert.equal(config.file, '/var/data/visa-mrz-budget.enc');
  assert.equal(config.key, f.store.key); assert.equal(config.capUsd, 0.84); assert.equal(config.persistentStateConfirmed, true);
  assert.equal(config.policyFingerprint, POLICY);
  assert.equal(f.profiles.uploadConsentOptions().policySha256, POLICY);
  assert.equal(f.profiles.status().configured, true);
  await f.profiles.close(); assert.equal(f.calls.close, 1);
});

test('bad flags, policy, budget decimal, storage or path cannot open the ledger or call HTTP', async () => {
  for (const options of [{env: {RAAD_MRZ_PRODUCTION_POLICY_SHA256: OTHER}}, {env: {OPENAI_API_KEY: ''}},
    {env: {RAAD_MRZ_PRODUCTION_BUDGET_USD: undefined}}, {env: {RAAD_MRZ_PRODUCTION_BUDGET_USD: '1e0'}},
    {env: {RAAD_MRZ_PRODUCTION_BUDGET_USD: '0'}}, {env: {RAAD_MRZ_PRODUCTION_BUDGET_USD: '1.0000001'}},
    {env: {RAAD_MRZ_PRODUCTION_BUDGET_PATH: '/tmp/other.enc'}},
    {env: {RAAD_MRZ_PRODUCTION_BUDGET_PATH: '/var/data/assistant-state.enc'}}, {mount: false},
    {store: {file: '/var/data/assistant-state.enc', key: Buffer.alloc(32), status: () => ({durableStorageConfirmed: false})}}]) {
    const f = fixture(options); await assert.rejects(f.profiles.start(), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
    assert.equal(f.calls.open, 0); assert.equal(f.calls.fetch.length, 0);
  }
});

test('missing ledger or a cap/policy mismatch is fail closed without allocating an allowance', async () => {
  for (const options of [{openError: true}, {ledgerCap: 1}, {ledgerPolicy: OTHER}]) {
    const f = fixture(options); await assert.rejects(f.profiles.start(), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
    assert.equal(f.profiles.uploadConsentOptions(), null); assert.equal(f.calls.fetch.length, 0);
    assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.close, 1);
  }
});

test('binding requires an explicit exact persisted grant and never upgrades a local job', async () => {
  const f = fixture(); await f.profiles.start();
  assert.equal(f.profiles.bindNewJob(f.context), null); assert.equal(f.profiles.resolve(), f.localReader);
  for (const mrzConsent of [{...f.ref, granted: true}, {...f.ref, consentDigest: SHA}, {consentId: f.ref.consentId}])
    assert.throws(() => f.profiles.bindNewJob({...f.context, mrzConsent}), hasCode('MRZ_PROFILE_CONSENT_REQUIRED'));
  const binding = f.bind(); assert.equal(Object.isFrozen(binding), true); assert.equal(binding.version, 1);
  assert.equal(binding.provider, 'openai'); assert.equal(binding.readerFingerprint, POLICY); assert.equal(binding.inputPolicy, INPUT_POLICY);
  assert.equal(JSON.stringify(binding).includes(f.context.customer), false);
  assert.equal(JSON.stringify(binding).includes(f.context.caseId), false);
  assert.equal(JSON.stringify(binding).includes(f.context.source.id), false);
  assert.equal(f.profiles.guard(binding, f.context), true);
  assert.equal(f.profiles.resolve(binding).inputPolicy, INPUT_POLICY);
  assert.throws(() => f.profiles.resolve({...binding, unexpected: true}), hasCode('MRZ_PROFILE_INVALID_BINDING'));
  assert.equal(f.calls.fetch.length, 0); await f.profiles.close();
});

test('changed case/source, revoked grant and async or undefined consent admission fail synchronously', async () => {
  const f = fixture(); await f.profiles.start(); const binding = f.bind();
  f.store.data.visaCases[f.context.customer] = {...f.store.data.visaCases[f.context.customer], applicantCount: 2};
  assert.throws(() => f.profiles.guard(binding, f.context), hasCode('MRZ_PROFILE_STALE'));
  f.store.data.visaCases[f.context.customer] = {id: f.context.caseId, applicantCount: 1, applicants: []};
  f.store.data.visaMedia[f.context.source.id] = {...f.context.source, checksum: OTHER};
  assert.throws(() => f.profiles.guard(binding, f.context), hasCode('MRZ_PROFILE_STALE'));
  f.store.data.visaMedia[f.context.source.id] = f.context.source;
  f.setConsent(false); assert.throws(() => f.profiles.guard(binding, f.context), hasCode('MRZ_PROFILE_CONSENT_REQUIRED'));
  assert.equal(f.calls.fetch.length, 0); await f.profiles.close();
  for (const verify of [() => undefined, () => Promise.resolve(true)]) {
    const other = fixture({consents: {healthy: true, verify}}); await other.profiles.start();
    assert.throws(other.bind, hasCode('MRZ_PROFILE_CONSENT_REQUIRED')); assert.equal(other.calls.fetch.length, 0); await other.profiles.close();
  }
});

test('remote binding stays remote and fails closed when owner configuration changes', async () => {
  const f = fixture(); await f.profiles.start(); const binding = f.bind();
  f.env.RAAD_MRZ_PRODUCTION_ENABLED = 'false';
  assert.throws(() => f.profiles.resolve(binding), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.throws(() => f.profiles.guard(binding, f.context), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.equal(f.profiles.resolve(null), f.localReader); assert.equal(f.calls.fetch.length, 0);
  await f.profiles.close();
});

test('revoked grant blocks count, generation and acceptance independently', async () => {
  for (const phase of ['before_count', 'before_generation', 'before_accept']) {
    let f;
    f = fixture({fetch: url => {
      if (phase === 'before_generation' || phase === 'before_accept' && !url.endsWith('/input_tokens')) f.setConsent(false);
      return url.endsWith('/input_tokens') ? response({input_tokens: 100}) : response({model: 'gpt-6-astra', status: 'completed',
        usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}, output: [{type: 'message', role: 'assistant', content: [
          {type: 'output_text', text: JSON.stringify({version: 1, lines: TD3})}]}]});
    }});
    await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
    if (phase === 'before_count') f.setConsent(false);
    await assert.rejects(reader.extract(await f.input(binding)), hasCode('DOCUMENT_VISION_STALE'));
    assert.equal(f.calls.fetch.length, phase === 'before_count' ? 0 : phase === 'before_generation' ? 1 : 2);
    await f.profiles.close();
  }
});

test('stable billing identity blocks a new operational attempt without replay or a refund', async () => {
  const f = fixture(); await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  assert.deepEqual((await reader.extract(await f.input(binding))).mrzLines, TD3);
  await assert.rejects(reader.extract({...await f.input(binding), attemptKey: 'c'.repeat(64)}), hasCode('MRZ_OPENAI_ATTEMPT_ALREADY_RESERVED'));
  assert.equal(f.calls.fetch.length, 2); assert.equal(f.calls.reserve.length, 2); assert.equal(f.calls.settle.length, 1);
  assert.equal(f.calls.reserve[0].attemptKey, OTHER); assert.equal(f.calls.reserve[1].attemptId, f.calls.reserve[0].attemptId);
  assert.equal(f.calls.settle[0].retainUsd, 0.12); await f.profiles.close();
});

test('close cannot release the budget after timeout while fetch or settlement remains active', async () => {
  const entered = deferred(), pending = deferred(), settling = deferred(), settleDone = deferred(); let timeout;
  const f = fixture({setTimerImpl: callback => { timeout = callback; return 1; },
    fetch: () => { entered.resolve(); return pending.promise; },
    settle: () => { settling.resolve(); return settleDone.promise; }});
  await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  const first = reader.extract(await f.input(binding)); await entered.promise; timeout();
  await assert.rejects(first, hasCode('MRZ_OPENAI_TIMEOUT'));
  await assert.rejects(f.profiles.close(), hasCode('DOCUMENT_VISION_BUSY')); assert.equal(f.calls.close, 0);
  pending.resolve(response({input_tokens: 100})); await settling.promise;
  await assert.rejects(f.profiles.close(), hasCode('DOCUMENT_VISION_BUSY')); assert.equal(f.calls.close, 0);
  settleDone.resolve({committed: true}); await new Promise(resolve => setImmediate(resolve));
  await f.profiles.close(); assert.equal(f.calls.close, 1);
});

test('unconfirmed budget settlement never exposes MRZ lines or provider/key details', async () => {
  const f = fixture({settle: () => { throw Error(PRIVATE + KEY); }});
  await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  await assert.rejects(reader.extract(await f.input(binding)), error => error.code === 'MRZ_OPENAI_BUDGET_UNCONFIRMED'
    && !JSON.stringify(error).includes(KEY) && !error.message.includes(PRIVATE));
  assert.equal(JSON.stringify(f.profiles.status()).includes(KEY), false);
  assert.equal(JSON.stringify(f.calls.settle).includes(PRIVATE), false); await f.profiles.close();
});


test('consent poisoning during startup retains the acquired budget lock for explicit recovery', async () => {
  const consents = {healthy: true, verify: () => true};
  const f = fixture({consents, onOpen: () => { consents.healthy = false; }});
  await assert.rejects(f.profiles.start(), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.equal(f.calls.open, 1); assert.equal(f.calls.close, 0);
  await assert.rejects(f.profiles.close(), hasCode('MRZ_PROFILE_CONSENT_UNCONFIRMED'));
  await assert.rejects(f.profiles.start(), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.equal(f.calls.open, 1); assert.equal(f.calls.close, 0); assert.equal(f.calls.fetch.length, 0);
});


test('drain stops admission and waits for the actual held request and settlement before close', async () => {
  const entered = deferred(), pending = deferred(), settling = deferred(), settlement = deferred();
  const f = fixture({fetch: url => {
    if (url.endsWith('/input_tokens')) { entered.resolve(); return pending.promise; }
    return response({model: 'gpt-6-astra', status: 'completed', usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130},
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({version: 1, lines: TD3})}]}]});
  }, settle: () => { settling.resolve(); return settlement.promise; }});
  await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  const read = reader.extract(await f.input(binding)); await entered.promise;
  let closed = false; const drain = f.profiles.drainAndClose({timeoutMs: 1000, pollMs: 1}).then(() => { closed = true; });
  assert.equal(f.profiles.status().ready, false); assert.equal(reader.ready(), false);
  assert.equal(f.profiles.uploadConsentOptions(), null);
  assert.throws(() => f.profiles.resolve(binding), hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  assert.throws(f.bind, hasCode('MRZ_PROFILE_NOT_CONFIGURED'));
  await assert.rejects(reader.extract(await f.input(binding)), hasCode('MRZ_OPENAI_NOT_CONFIGURED'));
  assert.equal(f.calls.close, 0); assert.equal(closed, false);
  pending.resolve(response({input_tokens: 100})); await settling.promise;
  assert.equal(f.calls.fetch.length, 2); assert.equal(f.calls.close, 0); assert.equal(closed, false);
  settlement.resolve({committed: true}); assert.deepEqual((await read).mrzLines, TD3); await drain;
  assert.equal(f.calls.close, 1); assert.equal(closed, true);
});

test('bounded drain times out with an immutable fake clock and retains the active reservation and lock', async () => {
  const entered = deferred(), pending = deferred();
  const f = fixture({fetch: () => { entered.resolve(); return pending.promise; }});
  await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  const read = reader.extract(await f.input(binding)); await entered.promise;
  await assert.rejects(f.profiles.drainAndClose({timeoutMs: 10, pollMs: 1}), hasCode('MRZ_PROFILE_DRAIN_TIMEOUT'));
  assert.equal(f.calls.close, 0); assert.equal(f.calls.reserve.length, 1); assert.equal(f.calls.settle.length, 0);
  assert.equal(reader.ready(), false); assert.equal(f.profiles.status().busy, true);
  pending.resolve(response({input_tokens: 3000})); await assert.rejects(read, hasCode('MRZ_OPENAI_TOKEN_BOUND'));
  assert.equal(f.calls.settle[0].retainUsd, 0.12); await f.profiles.drainAndClose({timeoutMs: 100, pollMs: 1});
  assert.equal(f.calls.close, 1);
});

test('consent poisoning during drain retains the owned lock even after work finishes', async () => {
  const entered = deferred(), pending = deferred(), consents = {healthy: true, verify: () => true};
  const f = fixture({consents, fetch: () => { entered.resolve(); return pending.promise; }});
  await f.profiles.start(); const binding = f.bind(), reader = f.profiles.resolve(binding);
  const read = reader.extract(await f.input(binding)); await entered.promise;
  const drain = f.profiles.drainAndClose({timeoutMs: 100, pollMs: 1}); consents.healthy = false;
  await assert.rejects(drain, hasCode('MRZ_PROFILE_CONSENT_UNCONFIRMED')); assert.equal(f.calls.close, 0);
  pending.resolve(response({input_tokens: 100})); await assert.rejects(read, hasCode('DOCUMENT_VISION_STALE'));
  await assert.rejects(f.profiles.drainAndClose({timeoutMs: 100, pollMs: 1}), hasCode('MRZ_PROFILE_CONSENT_UNCONFIRMED'));
  assert.equal(f.calls.close, 0); assert.equal(f.calls.settle.length, 1);
});
