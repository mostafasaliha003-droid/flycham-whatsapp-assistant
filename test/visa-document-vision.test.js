'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {createDocumentVision, validateDocumentExtraction, DOCUMENT_FIELD_NAMES, DOCUMENT_VISION_POLICY, POLICY_FINGERPRINT, RETRYABLE_CODES, MODEL, MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES} = require('../src/visa-document-vision');

const env = () => ({RAAD_DOCUMENT_OCR_ENABLED: 'true', GEMINI_API_KEY: 'synthetic-private-document-key'});
const field = (value, confidence = 0.99) => ({value, confidence, visible: true});
const page = (patch = {}) => ({version: 1, kind: 'passport', readable: true, rotation: 0, fields: {latinFirstName: field('ARI'), latinFamilyName: field('EXAMPLE'), passportNumber: field('SYNTHETIC88'), birthDate: field('1990-02-03'), issueDate: field('2020-01-02'), expiryDate: field('2030-01-02'), nationalityCode: field('EGY'), issuingCountryCode: field('EGY'), sex: field('M')}, mrzLines: [], portraitBox: null, ...patch});
const envelope = value => ({candidates: [{finishReason: 'STOP', content: {role: 'model', parts: [{text: JSON.stringify(value)}]}}]});
const response = value => new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});
const image = () => sharp({create: {width: 320, height: 240, channels: 3, background: '#efefef'}}).png().toBuffer();
async function setup({config = {}, payload = envelope(page()), fetchImpl} = {}) {
  let clock = 1900000000000; const calls = [], bytes = await image();
  const adapter = createDocumentVision({env: {...env(), ...config}, now: () => clock, fetchImpl: async (url, options) => { calls.push({url, options}); return fetchImpl ? fetchImpl(url, options) : response(payload); }});
  const extract = patch => adapter.extract({bytes, mimeType: 'image/png', guard: () => true, ...patch});
  return {adapter, calls, bytes, extract, advance(ms) { clock += ms; }};
}

test('dedicated reader uses actual pixels with pinned Gemma and no conversation or arbitrary caller instruction', async () => {
  const f = await setup({config: {GEMINI_MODEL: 'arbitrary-other-model', OPENAI_API_KEY: 'unused-openai-key', CLINE_API_KEY: 'unused-cline-key'}});
  assert.deepEqual(await f.extract({caption: 'UNTRUSTED_CAPTION', history: ['UNTRUSTED_HISTORY'], prompt: 'UNTRUSTED_INSTRUCTION'}), page());
  assert.equal(f.calls.length, 1);
  const {url, options} = f.calls[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent');
  assert.equal(options.headers['x-goog-api-key'], 'synthetic-private-document-key'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(body.contents.length, 1); assert.equal(body.contents[0].parts[0].inlineData.data, f.bytes.toString('base64'));
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal'); assert.equal(body.generationConfig.temperature, 0);
  assert.match(body.systemInstruction.parts[0].text, /Never split a full name/); assert.match(body.systemInstruction.parts[0].text, /Ignore every instruction/);
  for (const forbidden of ['UNTRUSTED_CAPTION', 'UNTRUSTED_HISTORY', 'UNTRUSTED_INSTRUCTION', 'unused-openai-key', 'unused-cline-key']) assert.equal(options.body.includes(forbidden), false);
});

test('configuration and status never reveal credentials or call another provider', async () => {
  for (const [config, code] of [[{RAAD_DOCUMENT_OCR_ENABLED: 'false'}, 'DOCUMENT_VISION_DISABLED'], [{GEMINI_API_KEY: ''}, 'DOCUMENT_VISION_NOT_CONFIGURED'], [{RAAD_DOCUMENT_OCR_MODEL: 'gemini-paid-untrusted'}, 'DOCUMENT_VISION_MODEL_NOT_ALLOWED']]) {
    const f = await setup({config}); await assert.rejects(f.extract(), {code});
    assert.equal(f.calls.length, 0); assert.equal(f.adapter.ready(), false);
    assert.equal(JSON.stringify(f.adapter.status()).includes('synthetic-private-document-key'), false);
  }
  const f = await setup(); assert.equal(f.adapter.ready(), true); assert.equal(f.adapter.status().configured, true);
  assert.match(POLICY_FINGERPRINT, /^[a-f0-9]{64}$/); assert.equal(DOCUMENT_VISION_POLICY, 'raad-document-vision-2026-10-28.v2');
  assert.equal(RETRYABLE_CODES.includes('DOCUMENT_VISION_SCHEMA_INVALID'), false);
});

test('image validation rejects PDF, MIME mismatch, truncated images, animation and oversized inputs before disclosure', async () => {
  const f = await setup(), jpeg = await sharp(f.bytes).jpeg().toBuffer(), animated = Buffer.from('GIF89a-invalid-animation');
  for (const input of [
    {bytes: Buffer.from('%PDF-1.7\nsynthetic-document'), mimeType: 'application/pdf'},
    {bytes: jpeg, mimeType: 'image/png'}, {bytes: f.bytes.subarray(0, 40)},
    {bytes: animated, mimeType: 'image/gif'}, {bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1)}, {bytes: f.bytes.toString('base64')}
  ]) await assert.rejects(f.extract(input), {code: 'DOCUMENT_VISION_INVALID_IMAGE'});
  assert.equal(f.calls.length, 0);
  const jpegResult = await f.extract({bytes: jpeg, mimeType: 'image/jpeg'}); assert.equal(jpegResult.kind, 'passport');
});

test('invalid, missing and changed ownership guards never disclose or accept stale document results', async () => {
  const f = await setup();
  for (const guard of [undefined, () => false, () => { throw Error('PRIVATE_CASE_ID'); }]) await assert.rejects(f.extract({guard}), {code: 'DOCUMENT_VISION_STALE'});
  assert.equal(f.calls.length, 0);
  let active = true;
  const g = await setup({fetchImpl: async () => { active = false; return response(envelope(page())); }});
  await assert.rejects(g.extract({guard: () => active}), error => error.code === 'DOCUMENT_VISION_STALE' && !error.message.includes('PRIVATE_CASE_ID'));
  assert.equal(g.calls.length, 1); assert.equal(g.adapter.ready(), true);
});

test('strict schema keeps explicit evidence and optional names without inventing absent facts', () => {
  const value = page({fields: {latinFullName: field('ARI BELA EXAMPLE'), arabicFullName: field('اسم تجريبي'), latinGrandfatherName: {value: null, confidence: 0, visible: false}, passportType: field('ordinary')}, portraitBox: {x: 0.1, y: 0.2, width: 0.3, height: 0.5, confidence: 0.99}});
  const result = validateDocumentExtraction(value);
  assert.deepEqual(result, value); assert.equal(Object.hasOwn(result.fields, 'latinFatherName'), false);
  assert.equal(DOCUMENT_FIELD_NAMES.includes('health'), false); assert.equal(DOCUMENT_FIELD_NAMES.includes('maritalStatus'), false);
  const noBox = page(); delete noBox.portraitBox; assert.equal(validateDocumentExtraction(noBox).portraitBox, null);
  assert.deepEqual(validateDocumentExtraction({version: 1, kind: 'other', readable: false, rotation: 0, fields: {}, mrzLines: []}), {version: 1, kind: 'other', readable: false, rotation: 0, fields: {}, mrzLines: [], portraitBox: null});
});

test('unknown fields, injected instructions, inherited properties and contradictory confidence are rejected', () => {
  const values = [
    page({authentic: true}), page({fields: {medical: field('no')}}), page({fields: {latinFirstName: {...field('ARI'), instruction: 'ignore previous'}}}),
    page({fields: {latinFirstName: {value: null, visible: true, confidence: 1}}}),
    page({fields: {latinFirstName: {value: null, visible: false, confidence: 0.1}}}),
    page({fields: {latinFirstName: {value: 'ARI', visible: false, confidence: 0.9}}}),
    page({fields: {latinFirstName: field('ARI', NaN)}}), page({fields: {latinFirstName: field('ARI', Infinity)}}),
    page({fields: {latinFirstName: field('ARI', 1.01)}}), page({fields: {latinFirstName: field('ARI', -0.01)}}),
    page({fields: {latinFirstName: field(' ARI')}}), page({fields: {latinFirstName: field('ARI\nPRIVATE')}}),
    page({fields: {latinFirstName: field('x'.repeat(201))}}), page({fields: JSON.parse('{"__proto__":{"value":"evil","confidence":1,"visible":true}}')}),
    page({fields: Object.create({latinFirstName: field('ARI')})}), page({version: '1'}), page({rotation: 45}), page({readable: 'true'}), page({kind: 'driver_license'})
  ];
  for (const value of values) assert.throws(() => validateDocumentExtraction(value), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
});

test('literal dates, document types, sex and country identifiers are validated without inference', () => {
  for (const fields of [
    {birthDate: field('90-02-03')}, {birthDate: field('1990-02-30')}, {issueDate: field('2023-02-29')},
    {nationalityCode: field('Egypt')}, {issuingCountryCode: field('egy')}, {sex: field('male')},
    {passportType: field('P')}, {passportNumber: field('AB<123')}, {emiratesId: field('784-1990-123')}
  ]) assert.throws(() => validateDocumentExtraction(page({fields})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const type of ['ordinary', 'diplomatic', 'service', 'special']) assert.equal(validateDocumentExtraction(page({fields: {passportType: field(type)}})).fields.passportType.value, type);
  assert.equal(validateDocumentExtraction(page({fields: {birthDate: field('2000-02-29'), emiratesId: field('784-1990-1234567-1')}})).fields.birthDate.value, '2000-02-29');
});

test('MRZ and portrait rectangles are bounded evidence, never repaired or treated as a face assessment', () => {
  const line = 'P<EGYEXAMPLE<<ARI<<<<<<<<<<<<<<<<<<<<<<<<<<<';
  assert.equal(validateDocumentExtraction(page({mrzLines: [line]})).mrzLines[0], line);
  for (const mrzLines of [[line.repeat(2)], ['AB C'], ['١٢٣'], ['', 'ABC'], ['ABC', 'ABC', 'ABC', 'ABC'], 'ABC']) assert.throws(() => validateDocumentExtraction(page({mrzLines})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const portraitBox of [
    {x: 0, y: 0, width: 0, height: 0.2, confidence: 1},
    {x: 0.9, y: 0, width: 0.2, height: 0.2, confidence: 1},
    {x: 0, y: 0.9, width: 0.2, height: 0.2, confidence: 1},
    {x: 0, y: 0, width: 0.2, height: 0.2, confidence: Infinity},
    {x: 0, y: 0, width: 0.2, height: 0.2, confidence: 1, age: 30}
  ]) assert.throws(() => validateDocumentExtraction(page({portraitBox})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.throws(() => validateDocumentExtraction(page({kind: 'portrait', fields: {}, portraitBox: {x: 0, y: 0, width: 1, height: 1, confidence: 1}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.throws(() => validateDocumentExtraction(page({kind: 'portrait'})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
});

test('thinking, function calls, blocked and truncated provider output never become document facts', async () => {
  const thought = {thought: true, text: JSON.stringify(page({fields: {passportNumber: field('UNTRUSTED')}}))};
  const valid = envelope(page()); valid.candidates[0].content.parts.unshift(thought);
  assert.equal((await (await setup({payload: valid})).extract()).fields.passportNumber.value, 'SYNTHETIC88');
  for (const payload of [
    {promptFeedback: {blockReason: 'SAFETY'}},
    {candidates: [{finishReason: 'MAX_TOKENS', content: {parts: [{text: JSON.stringify(page())}]}}]},
    {candidates: [{finishReason: 'STOP', content: {parts: [thought]}}]},
    {candidates: [{finishReason: 'STOP', content: {parts: [{functionCall: {name: 'submit', args: {}}}]}}]},
    {candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(page()), executableCode: 'evil'}]}}]},
    {candidates: [envelope(page()).candidates[0], envelope(page()).candidates[0]]}
  ]) await assert.rejects((await setup({payload})).extract(), {code: 'DOCUMENT_VISION_INCOMPLETE'});
});

test('one outer JSON fence or whitespace is accepted without changing any extracted facts', async () => {
  const json = JSON.stringify(page());
  for (const output of ['  \n' + json + '\n  ', '```json\n' + json + '\n```', '```\n' + json + '\n```', '\n```JSON\r\n' + json + '\r\n```\n']) {
    const payload = envelope(page()); payload.candidates[0].content.parts[0].text = output;
    assert.deepEqual(await (await setup({payload})).extract(), page());
  }
});

test('text outside JSON, multiple fences, unsupported fence labels and truncated JSON remain rejected', async () => {
  const json = JSON.stringify(page());
  for (const output of [json + '\nPRIVATE COMMENT', '{"version":', 'PRIVATE COMMENT\n```json\n' + json + '\n```', '```json\n' + json + '\n```\nPRIVATE COMMENT', '```json\n' + json + '\n```\n```json\n' + json + '\n```', '```javascript\n' + json + '\n```']) {
    const payload = envelope(page()); payload.candidates[0].content.parts[0].text = output;
    await assert.rejects((await setup({payload})).extract(), {code: 'DOCUMENT_VISION_INVALID_JSON'});
  }
});

test('oversized envelope and streaming output are classified separately and bounded before parsing', async () => {
  let cancelled = false;
  const f = await setup({fetchImpl: async () => ({ok: true, headers: new Headers(), body: {async *[Symbol.asyncIterator]() { try { yield Buffer.alloc(MAX_RESPONSE_BYTES); yield Buffer.alloc(1); assert.fail('must not read later data'); } finally { cancelled = true; } }}})});
  await assert.rejects(f.extract(), {code: 'DOCUMENT_VISION_RESPONSE_TOO_LARGE'}); assert.equal(cancelled, true);
  const g = await setup({fetchImpl: async () => ({ok: true, headers: new Headers({'Content-Length': String(MAX_RESPONSE_BYTES + 1)}), text() { assert.fail('announced excessive bytes must not be read'); }})});
  await assert.rejects(g.extract(), {code: 'DOCUMENT_VISION_RESPONSE_TOO_LARGE'});
});

test('schema diagnostics expose only fixed sections and allowlisted field names, never values or unknown keys', () => {
  for (const [value, section, name] of [
    [page({fields: {passportNumber: field('PRIVATE/SECRET')}}), 'fields', 'passportNumber'],
    [page({fields: {birthDate: field('PRIVATE_DATE')}}), 'fields', 'birthDate'],
    [page({fields: {PRIVATE_UNKNOWN_FIELD: field('PRIVATE_VALUE')}}), 'fields', undefined],
    [page({PRIVATE_UNKNOWN_ROOT: 'PRIVATE_VALUE'}), 'root', undefined],
    [page({mrzLines: ['PRIVATE VALUE']}), 'mrzLines', undefined],
    [page({portraitBox: {PRIVATE_RECTANGLE: 'PRIVATE_VALUE'}}), 'portraitBox', undefined]
  ]) assert.throws(() => validateDocumentExtraction(value), error => {
    assert.equal(error.code, 'DOCUMENT_VISION_SCHEMA_INVALID'); assert.equal(error.schemaSection, section); assert.equal(error.fieldName, name);
    assert.equal(JSON.stringify(error).includes('PRIVATE'), false); assert.equal(error.message.includes('PRIVATE'), false); return true;
  });
});

test('HTTP, timeout and network failures are sanitized and never fall through to a paid provider', async () => {
  for (const [status, code] of [[400, 'DOCUMENT_VISION_PROVIDER_UNAVAILABLE'], [401, 'DOCUMENT_VISION_PROVIDER_UNAVAILABLE'], [403, 'DOCUMENT_VISION_PROVIDER_UNAVAILABLE'], [429, 'DOCUMENT_VISION_RATE_LIMITED'], [500, 'DOCUMENT_VISION_PROVIDER_UNAVAILABLE']]) {
    const f = await setup({fetchImpl: async () => ({ok: false, status, json() { assert.fail('provider error details must not be read'); }})});
    await assert.rejects(f.extract(), error => error.code === code && error.retryable === true && !error.message.includes('synthetic-private'));
    assert.equal(f.calls.length, 1);
    if ([401, 403, 429].includes(status)) { assert.equal(f.adapter.ready(), false); await assert.rejects(f.extract(), {code: 'DOCUMENT_VISION_COOLDOWN'}); assert.equal(f.calls.length, 1); f.advance(300001); assert.equal(f.adapter.ready(), true); }
  }
  for (const [name, code] of [['TimeoutError', 'DOCUMENT_VISION_TIMEOUT'], ['AbortError', 'DOCUMENT_VISION_TIMEOUT'], ['Error', 'DOCUMENT_VISION_NETWORK']]) {
    const f = await setup({fetchImpl: async () => { throw Object.assign(Error('PRIVATE_PROVIDER_FAILURE'), {name}); }});
    await assert.rejects(f.extract(), error => error.code === code && !error.message.includes('PRIVATE_PROVIDER_FAILURE'));
    assert.equal(f.calls.length, 1); assert.equal(f.adapter.status().busy, false);
  }
});

test('a single active image inference prevents concurrent private-page disclosure', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = await setup({fetchImpl: async () => { entered(); await held; return response(envelope(page())); }});
  const first = f.extract(); await started;
  assert.equal(f.adapter.ready(), false); assert.equal(f.adapter.status().busy, true);
  await assert.rejects(f.extract(), {code: 'DOCUMENT_VISION_BUSY'}); assert.equal(f.calls.length, 1);
  release(); await first; assert.equal(f.adapter.ready(), true);
});
