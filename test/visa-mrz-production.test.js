'use strict';

// Functional contracts with real local image preparation and mocked HTTP only.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const KEY = 'synthetic_openai_mrz_key_not_a_real_secret';
const PRIVATE = 'provider_private_body_MUST_NOT_LEAK';
const ATTEMPT_KEY = 'a'.repeat(64);
const BILLING_KEY = 'd'.repeat(64);
const RESERVATION = 'b'.repeat(64);
const TD3 = [
  'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
  'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
];
const TD1 = ['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6',
  'ERIKSSON<<ANNA<MARIA<<<<<<<<<<'];
const imagePromise = sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).png().toBuffer();
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: {'content-type': 'application/json', ...headers},
});
const generation = (lines = TD3, overrides = {}) => response({
  id: PRIVATE, model: 'gpt-6-astra', status: 'completed',
  output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify({version: 1, lines})}]}],
  usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}, ...overrides,
});

function fixture(options = {}) {
  // Isolate unfinished-reservation outcomes between tests. Instances created
  // from this same loaded module still share the actual module-level lease.
  delete require.cache[require.resolve('../src/visa-mrz-production')];
  const module = require('../src/visa-mrz-production');
  const calls = {fetch: [], reserve: [], settle: []};
  const budget = options.budget || {durable: true,
    status: () => ({capUsd: 1, policyFingerprint: module.MRZ_PRODUCTION_POLICY_FINGERPRINT}),
    reserve: async value => {
      calls.reserve.push(value);
      return options.reserve ? options.reserve(value) : {committed: true,
        reservationId: RESERVATION, reservedUsd: 0.12, capUsd: 1, existing: false};
    },
    settle: async value => {
      calls.settle.push(value);
      return options.settle ? options.settle(value) : {committed: true};
    },
  };
  const fetchImpl = async (url, init) => {
    const record = {url, init, body: JSON.parse(init.body)};
    calls.fetch.push(record);
    if (options.fetch) return options.fetch(record, calls.fetch.length);
    return url.endsWith('/input_tokens') ? response({input_tokens: 100}) : generation(options.lines || TD3);
  };
  const env = {RAAD_MRZ_PROVIDER: 'openai', RAAD_MRZ_PRODUCTION_ENABLED: 'true',
    RAAD_MRZ_PRODUCTION_POLICY_SHA256: module.MRZ_PRODUCTION_POLICY_FINGERPRINT, OPENAI_API_KEY: KEY, ...options.env};
  const factoryOptions = {env, budget, capUsd: options.capUsd ?? 1, fetchImpl, ...(options.now ? {now: options.now} : {}),
    ...(options.setTimerImpl ? {setTimerImpl: options.setTimerImpl} : {}),
    ...(options.clearTimerImpl ? {clearTimerImpl: options.clearTimerImpl} : {})};
  const adapter = module.createProductionOpenAiMrz(factoryOptions);
  const input = async extra => ({bytes: Buffer.from(await imagePromise), mimeType: 'image/png',
    format: 'TD3', attemptKey: ATTEMPT_KEY, billingAttemptKey: BILLING_KEY, guard: async () => true, ...extra});
  return {module, adapter, calls, input, budget, factoryOptions};
}

const hasCode = code => error => error?.code === code;

test('OpenAI MRZ reader defaults off and never reserves or calls a provider', async () => {
  const f = fixture({env: {RAAD_MRZ_PRODUCTION_ENABLED: undefined}});
  assert.equal(f.adapter.ready(), false);
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_DISABLED'));
  assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.fetch.length, 0);
});

test('production profile is distinct and makes no production quality claim', () => {
  const f = fixture();
  assert.equal(f.adapter.status().productionCapable, true);
  assert.equal(f.adapter.status().qualityEvidence, 'synthetic-only');
  assert.notEqual(f.module.MRZ_PRODUCTION_POLICY_FINGERPRINT, require('../src/visa-mrz-openai').MRZ_OPENAI_POLICY_FINGERPRINT);
  assert.equal(JSON.stringify(f.module.buildCount({imageBase64:'synthetic'})).includes('synthetic image'), false);
});

test('missing key or durable reserve/settle contract is unconfigured without a request', async () => {
  for (const options of [{env: {OPENAI_API_KEY: ''}},
    {budget: {durable: false, reserve: async () => {}, settle: async () => {}}},
    {budget: {durable: true, reserve: async () => {}}},
    {budget: {durable: true, settle: async () => {}}}]) {
    const f = fixture(options);
    assert.equal(f.adapter.ready(), false);
    await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_NOT_CONFIGURED'));
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('stable TD3 contract uses a committed capped reservation before count and generation', async () => {
  const f = fixture();
  const result = await f.adapter.extract(await f.input());
  assert.equal(result.version, 1); assert.deepEqual(result.mrzLines, TD3);
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.equal(f.calls.reserve.length, 1); assert.equal(f.calls.fetch.length, 2);
  const reserve = f.calls.reserve[0];
  assert.equal(reserve.attemptKey, BILLING_KEY);
  assert.equal(reserve.attemptId, f.module.deriveAttemptId(BILLING_KEY));
  assert.equal(reserve.policyFingerprint, f.module.MRZ_PRODUCTION_POLICY_FINGERPRINT);
  assert.equal(reserve.maxUsd, 0.12); assert.equal(reserve.budgetCapUsd, 1);
  assert.equal(typeof reserve.attemptId, 'string');
  assert.equal(f.calls.settle.length, 1);
  assert.equal(f.calls.settle[0].reservationId, RESERVATION);
  assert.equal(f.calls.settle[0].attemptId, reserve.attemptId);
  assert.equal(f.adapter.status().busy, false); assert.equal(f.adapter.ready(), true);
  for (const record of f.calls.fetch) {
    assert.ok(['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses'].includes(record.url));
    assert.equal(record.init.redirect, 'error');
    assert.equal(record.init.method, 'POST');
    assert.ok(record.init.signal instanceof AbortSignal);
    assert.equal(record.body.model, 'gpt-6-astra');
    assert.ok(!JSON.stringify(record.body).includes(ATTEMPT_KEY));
  }
  const request = f.calls.fetch[1].body;
  assert.equal(request.store, false); assert.equal(request.max_output_tokens, 1024);
  assert.equal(request.reasoning.effort, 'low');
  assert.ok(!request.tools || request.tools.length === 0);
});

test('TD1 uses the same controlled reader and strict independently checked lines', async () => {
  const f = fixture({lines: TD1});
  const result = await f.adapter.extract(await f.input({format: 'TD1'}));
  assert.deepEqual(result.mrzLines, TD1);
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.equal(f.calls.fetch.length, 2);
});

test('exact literal parser never repairs wrong check digit, issuer zero, spaces or missing fillers', () => {
  const {parseLiteralOutput} = fixture().module;
  assert.deepEqual(parseLiteralOutput(JSON.stringify({version: 1, lines: TD3}), 'TD3').mrzLines, TD3);
  const badCheck = [...TD3]; badCheck[1] = badCheck[1].slice(0, -1) + '1';
  const issuerZero = [...TD3]; issuerZero[0] = issuerZero[0].replace('UTO', 'UT0');
  const spaced = [...TD3]; spaced[0] = spaced[0].slice(0, 9) + ' ' + spaced[0].slice(10);
  const incomplete = [...TD3]; incomplete[0] = incomplete[0].slice(0, -1);
  for (const lines of [badCheck, issuerZero, spaced, incomplete])
    assert.throws(() => parseLiteralOutput(JSON.stringify({version: 1, lines}), 'TD3'));
  for (const raw of [JSON.stringify({version: 1, lines: TD3, repaired: true}),
    '```json\n' + JSON.stringify({version: 1, lines: TD3}) + '\n```',
    JSON.stringify({version: 1, lines: [5]})])
    assert.throws(() => parseLiteralOutput(raw, 'TD3'));
  assert.deepEqual(parseLiteralOutput(JSON.stringify({version: 1, lines: []}), 'TD3'),
    {version: 1, mrzLines: [], checks: {}});
});

test('real internal Sharp crop sends only expected upright ROI pixels with identical count and generation input', async () => {
  for (const [format, lines, height] of [['TD3', TD3, 180], ['TD1', TD1, 400]]) {
    const f = fixture({lines}), input = await f.input({format});
    const original = Buffer.from(input.bytes);
    await f.adapter.extract(input);
    assert.deepEqual(input.bytes, original);
    const urls = f.calls.fetch.map(record => record.body.input[0].content.find(part => part.type === 'input_image').image_url);
    assert.equal(urls[0], urls[1]);
    assert.match(urls[0], /^data:image\/png;base64,/);
    const encoded = urls[0].slice('data:image/png;base64,'.length);
    const cropped = Buffer.from(encoded, 'base64');
    assert.ok(cropped.length <= 100 * 1024);
    const metadata = await sharp(cropped).metadata();
    assert.equal(metadata.width, 900); assert.equal(metadata.height, height);
    assert.ok(metadata.orientation === undefined || metadata.orientation === 1);
    assert.equal(f.adapter.inputPolicy, f.module.INPUT_POLICY);
  }
});

test('invalid image, format or attempt key cannot reserve budget or request transcription', async () => {
  const f = fixture();
  for (const extra of [{bytes: Buffer.from('not an image')}, {mimeType: 'image/gif'}, {format: 'AUTO'}])
    await assert.rejects(f.adapter.extract(await f.input(extra)), hasCode('MRZ_OPENAI_INVALID_IMAGE'));
  for (const attemptKey of ['', 'A'.repeat(64), undefined, 'a'.repeat(63)])
    await assert.rejects(f.adapter.extract(await f.input({attemptKey})), hasCode('MRZ_OPENAI_INVALID_ATTEMPT_KEY'));
  assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.fetch.length, 0);
});

test('object-shaped attempt keys are rejected without implicit string coercion or requests', async () => {
  let coercions = 0;
  const attemptKey = {toString() { coercions++; return ATTEMPT_KEY; }};
  const f = fixture();
  await assert.rejects(f.adapter.extract(await f.input({attemptKey})), hasCode('MRZ_OPENAI_INVALID_ATTEMPT_KEY'));
  assert.equal(coercions, 0);
  assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.fetch.length, 0);
});

test('attempt ID derivation rejects malformed key or policy and remains bound to its valid policy', () => {
  const {deriveAttemptId} = fixture().module;
  for (const key of [undefined, null, {}, 123, 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])
    assert.throws(() => deriveAttemptId(key), hasCode('MRZ_OPENAI_INVALID_ATTEMPT_KEY'));
  for (const policy of [null, {}, 123, 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)])
    assert.throws(() => deriveAttemptId(ATTEMPT_KEY, policy), hasCode('MRZ_OPENAI_INVALID_ATTEMPT_KEY'));
  const first = deriveAttemptId(ATTEMPT_KEY, 'c'.repeat(64));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, deriveAttemptId(ATTEMPT_KEY, 'd'.repeat(64)));
});

test('stale guard before reservation prevents both charging and a provider request', async () => {
  const f = fixture();
  for (const guard of [undefined, async () => false, async () => { throw Error(PRIVATE); }])
    await assert.rejects(f.adapter.extract(await f.input({guard})), hasCode('DOCUMENT_VISION_STALE'));
  assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.fetch.length, 0);
});

test('failed or unconfirmed budget reservation never starts HTTP', async () => {
  for (const reserve of [async () => { throw Error(PRIVATE); }, async () => ({committed: false}),
    async () => ({committed: true, reservationId: RESERVATION, reservedUsd: 0.01, capUsd: 1, existing: false}),
    async () => ({committed: true, reservationId: 'invalid', reservedUsd: 0.12, capUsd: 1, existing: false})]) {
    const f = fixture({reserve});
    await assert.rejects(f.adapter.extract(await f.input()), error => ['MRZ_OPENAI_BUDGET_REJECTED', 'MRZ_OPENAI_BUDGET_UNCONFIRMED'].includes(error.code) && !error.message.includes(PRIVATE));
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('reservation ID must be a string and never invokes object coercion', async () => {
  let coercions = 0;
  const f = fixture({reserve: async () => ({committed: true,
    reservationId: {toString() { coercions++; return RESERVATION; }},
    reservedUsd: 0.12, capUsd: 1, existing: false})});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_BUDGET_REJECTED'));
  assert.equal(coercions, 0); assert.equal(f.calls.fetch.length, 0);
});

test('an already reserved attempt is not replayed or settled as a new attempt', async () => {
  const f = fixture({reserve: async () => ({committed: true, reservationId: RESERVATION,
    reservedUsd: 0.12, capUsd: 1, existing: true})});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_ATTEMPT_ALREADY_RESERVED'));
  assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.settle.length, 0);
});

test('provider is never called while the durable reservation acknowledgement is pending', async () => {
  const entered = deferred(), acknowledgement = deferred();
  const f = fixture({reserve: async () => { entered.resolve(); return acknowledgement.promise; }});
  const first = f.adapter.extract(await f.input());
  await entered.promise;
  assert.equal(f.calls.fetch.length, 0);
  const second = f.module.createProductionOpenAiMrz(f.factoryOptions);
  await assert.rejects(second.extract(await f.input({attemptKey: 'c'.repeat(64)})), hasCode('DOCUMENT_VISION_BUSY'));
  acknowledgement.resolve({committed: true, reservationId: RESERVATION, reservedUsd: 0.12, capUsd: 1, existing: false});
  await first;
  assert.equal(f.calls.fetch.length, 2);
});

test('one global lease stays held while final durable settlement is unfinished', async () => {
  const entered = deferred(), acknowledgement = deferred();
  const f = fixture({settle: async () => { entered.resolve(); return acknowledgement.promise; }});
  const first = f.adapter.extract(await f.input());
  await entered.promise;
  const second = f.module.createProductionOpenAiMrz(f.factoryOptions);
  await assert.rejects(second.extract(await f.input({attemptKey: 'c'.repeat(64)})), hasCode('DOCUMENT_VISION_BUSY'));
  assert.equal(f.calls.fetch.length, 2);
  acknowledgement.resolve({committed: true});
  await first;
  assert.equal(f.adapter.status().busy, false);
});

test('unconfirmed final settlement withholds recognized fields', async () => {
  const f = fixture({settle: async () => ({committed: false})});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_BUDGET_UNCONFIRMED'));
  assert.equal(f.calls.fetch.length, 2);
});

test('expired guard after counting prevents generation and settles its bounded attempt', async () => {
  let current = true;
  const f = fixture({fetch: record => {
    assert.ok(record.url.endsWith('/input_tokens')); current = false;
    return response({input_tokens: 100});
  }});
  await assert.rejects(f.adapter.extract(await f.input({guard: async () => current})), hasCode('DOCUMENT_VISION_STALE'));
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.settle.length, 1);
});

test('token count ceiling stops before generation with no retry', async () => {
  const f = fixture({fetch: () => response({input_tokens: 3000})});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_TOKEN_BOUND'));
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.settle.length, 1);
});

test('HTTP 200 with a present falsy API error is rejected before generation', async () => {
  const f = fixture({fetch: () => response({input_tokens: 100, error: ''})});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_INCOMPLETE'));
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.settle.length, 1);
});

for (const [httpStatus, code] of [[401, 'MRZ_OPENAI_AUTH_ERROR'], [403, 'MRZ_OPENAI_AUTH_ERROR'],
  [429, 'MRZ_OPENAI_RATE_LIMITED'], [500, 'MRZ_OPENAI_HTTP_ERROR']]) {
  test('HTTP ' + httpStatus + ' is sanitized, settled and never retried', async () => {
    const f = fixture({fetch: () => response({error: {message: PRIVATE}}, httpStatus)});
    await assert.rejects(f.adapter.extract(await f.input()), error => error.code === code
      && !error.message.includes(PRIVATE) && !JSON.stringify(error).includes(KEY));
    assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.settle.length, 1);
    assert.ok(!JSON.stringify(f.calls.settle).includes(PRIVATE));
  });
}

test('uncertain transport outcome retains its reservation and does not retry', async () => {
  const f = fixture({fetch: () => { throw new TypeError(PRIVATE + KEY); }});
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_NETWORK'));
  assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.settle.length, 1);
  assert.equal(f.calls.settle[0].uncertain, true);
  assert.equal(f.calls.settle[0].retainUsd, 0.12);
  assert.ok(!JSON.stringify(f.calls.settle).includes(PRIVATE));
});

test('45-second total deadline includes earlier phases and prevents generation after counting', async () => {
  let clock = 0;
  const timers = [], cleared = [];
  const f = fixture({now: () => clock,
    setTimerImpl: (callback, milliseconds) => { timers.push({callback, milliseconds}); return 1; },
    clearTimerImpl: value => cleared.push(value),
    fetch: () => { clock = 45001; return response({input_tokens: 100}); },
  });
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_TIMEOUT'));
  assert.equal(timers.length, 1); assert.equal(timers[0].milliseconds, 45000);
  assert.equal(f.calls.fetch.length, 1); assert.ok(cleared.includes(1));
});

test('timer aborts one pending fetch and never permits a retry or a second reader', async () => {
  let timeout;
  const entered = deferred();
  const f = fixture({setTimerImpl: callback => { timeout = callback; return 1; }, clearTimerImpl: () => {},
    fetch: record => { entered.resolve(); return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException(PRIVATE, 'AbortError'));
      if (record.init.signal.aborted) abort(); else record.init.signal.addEventListener('abort', abort, {once: true});
    }); },
  });
  const first = f.adapter.extract(await f.input());
  await entered.promise; timeout();
  await assert.rejects(first, hasCode('MRZ_OPENAI_TIMEOUT'));
  assert.equal(f.calls.fetch.length, 1);
});

test('caller timeout retains the global lease and full reservation until an uncooperative fetch actually finishes', async () => {
  let timeout;
  const entered = deferred(), pending = deferred();
  const f = fixture({setTimerImpl: callback => { timeout = callback; return 1; }, clearTimerImpl: () => {},
    fetch: () => { entered.resolve(); return pending.promise; },
  });
  const first = f.adapter.extract(await f.input());
  await entered.promise;
  timeout();
  await assert.rejects(first, hasCode('MRZ_OPENAI_TIMEOUT'));
  assert.equal(f.calls.fetch[0].init.signal.aborted, true);
  assert.equal(f.adapter.status().busy, true);
  const second = f.module.createProductionOpenAiMrz(f.factoryOptions);
  await assert.rejects(second.extract(await f.input({attemptKey: 'c'.repeat(64)})), hasCode('DOCUMENT_VISION_BUSY'));
  assert.equal(f.calls.reserve.length, 1); assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.settle.length, 0);
  pending.resolve(response({input_tokens: 100}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.settle.length, 1);
  assert.equal(f.calls.settle[0].uncertain, true);
  assert.equal(f.calls.settle[0].retainUsd, 0.12);
  assert.equal(f.calls.settle[0].outcome, 'timeout');
  assert.equal(f.adapter.status().busy, false);
  assert.equal(f.calls.fetch.length, 1);
});

test('multiple completed output fragments disagree instead of choosing a fragment', async () => {
  const f = fixture({fetch: record => record.url.endsWith('/input_tokens') ? response({input_tokens: 100})
    : generation(TD3, {output: [{type: 'message', role: 'assistant', content: [
      {type: 'output_text', text: JSON.stringify({version: 1, lines: TD3})},
      {type: 'output_text', text: JSON.stringify({version: 1, lines: TD1})},
    ]}]}),
  });
  await assert.rejects(f.adapter.extract(await f.input()), hasCode('MRZ_OPENAI_DISAGREEMENT'));
  assert.equal(f.calls.fetch.length, 2); assert.equal(f.calls.settle.length, 1);
});

test('wrong provider model or incomplete generation cannot return recognized lines', async () => {
  for (const [overrides, code] of [[{model: 'another-valid-model'}, 'MRZ_OPENAI_MODEL_MISMATCH'],
    [{status: 'incomplete'}, 'MRZ_OPENAI_INCOMPLETE'], [{usage: null}, 'MRZ_OPENAI_USAGE_INVALID']]) {
    const f = fixture({fetch: record => record.url.endsWith('/input_tokens') ? response({input_tokens: 100}) : generation(TD3, overrides)});
    await assert.rejects(f.adapter.extract(await f.input()), hasCode(code));
    assert.equal(f.calls.fetch.length, 2); assert.equal(f.calls.settle.length, 1);
  }
});

test('exact production approval, matching ledger cap and policy are required before reservation', async () => {
  for (const options of [{env: {RAAD_MRZ_PROVIDER: 'local'}},
    {env: {RAAD_MRZ_PRODUCTION_POLICY_SHA256: 'f'.repeat(64)}}, {capUsd: 0.84},
    {budget: {durable: true, reserve() {}, settle() {}, status: () => ({capUsd: 1, policyFingerprint: 'f'.repeat(64)})}}]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.extract(await f.input()), error => ['MRZ_OPENAI_DISABLED', 'MRZ_OPENAI_NOT_CONFIGURED'].includes(error.code));
    assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.reserve.length, 0);
  }
});

test('malformed stable billing identity cannot reserve or start HTTP', async () => {
  for (const billingAttemptKey of [undefined, '', 'A'.repeat(64), {}, 'a'.repeat(63)]) {
    const f = fixture();
    await assert.rejects(f.adapter.extract(await f.input({billingAttemptKey})), hasCode('MRZ_OPENAI_INVALID_ATTEMPT_KEY'));
    assert.equal(f.calls.fetch.length, 0); assert.equal(f.calls.reserve.length, 0);
  }
});

test('configuration revoked inside an asynchronous guard cannot dispatch either endpoint', async () => {
  for (const target of ['count', 'generation']) {
    const f = fixture(); let guards = 0;
    const guard = async () => {
      guards++;
      // 1 initial, 2 crop done, 3 reservation done, 4 pre-count, 5 post-count,
      // 6 pre-generation. Revoke during the awaited guard itself.
      if (guards === (target === 'count' ? 4 : 6)) f.factoryOptions.env.RAAD_MRZ_PRODUCTION_ENABLED = 'false';
      return true;
    };
    await assert.rejects(f.adapter.extract(await f.input({guard})), hasCode('DOCUMENT_VISION_STALE'));
    assert.equal(f.calls.fetch.length, target === 'count' ? 0 : 1);
  }
});


test('exported request builders cannot mutate the approved shared schema', () => {
  const f = fixture(), request = f.module.buildRequest({imageBase64: 'synthetic'});
  assert.throws(() => request.text.format.schema.properties.version.enum.push(2), TypeError);
  assert.throws(() => { request.text.format.schema.additionalProperties = true; }, TypeError);
  assert.equal(f.module.buildRequest({imageBase64: 'synthetic'}).text.format.schema.additionalProperties, false);
});

test('count mirrors approved schema/reasoning/tools and generation pins the default tier', () => {
  const f = fixture(), count = f.module.buildCount({imageBase64: 'synthetic'}), request = f.module.buildRequest({imageBase64: 'synthetic'});
  assert.deepEqual(count.text, request.text); assert.deepEqual(count.reasoning, request.reasoning);
  assert.deepEqual(count.tools, []); assert.deepEqual(request.tools, []);
  assert.equal(Object.hasOwn(count, 'store'), false); assert.equal(request.store, false);
  assert.equal(request.service_tier, 'default');
  const limits = f.module.LIMITS;
  assert.equal(limits.inputTokens, 2700); assert.equal(limits.inputUsdPerMillion, 12.5);
  assert.equal(limits.outputUsdPerMillion, 50);
  assert.ok((2 * limits.inputTokens * limits.inputUsdPerMillion + limits.outputTokens * limits.outputUsdPerMillion) / 1e6 <= 0.12);
});

test('undefined guard result never admits a production reservation or endpoint', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.extract(await f.input({guard: async () => undefined})), hasCode('DOCUMENT_VISION_STALE'));
  assert.equal(f.calls.reserve.length, 0); assert.equal(f.calls.fetch.length, 0);
});
