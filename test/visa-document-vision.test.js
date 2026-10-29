'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {createDocumentVision, validateDocumentExtraction, parseDocumentOutput, DOCUMENT_FIELD_NAMES, DOCUMENT_VISION_POLICY, ABSTENTION_POLICY, WIRE_PROJECTION_POLICY, POLICY_FINGERPRINT, COMPATIBLE_PREVIOUS_POLICIES, COMPATIBLE_COMPLETED_FAILURE_POLICIES, RETRYABLE_CODES, MODEL, MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES} = require('../src/visa-document-vision');

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
  assert.match(body.systemInstruction.parts[0].text, /Completely omit every unknown/); assert.match(body.systemInstruction.parts[0].text, /Do not emit null slots/);
  for (const forbidden of ['UNTRUSTED_CAPTION', 'UNTRUSTED_HISTORY', 'UNTRUSTED_INSTRUCTION', 'unused-openai-key', 'unused-cline-key']) assert.equal(options.body.includes(forbidden), false);
});

test('configuration and status never reveal credentials or call another provider', async () => {
  for (const [config, code] of [[{RAAD_DOCUMENT_OCR_ENABLED: 'false'}, 'DOCUMENT_VISION_DISABLED'], [{GEMINI_API_KEY: ''}, 'DOCUMENT_VISION_NOT_CONFIGURED'], [{RAAD_DOCUMENT_OCR_MODEL: 'gemini-paid-untrusted'}, 'DOCUMENT_VISION_MODEL_NOT_ALLOWED']]) {
    const f = await setup({config}); await assert.rejects(f.extract(), {code});
    assert.equal(f.calls.length, 0); assert.equal(f.adapter.ready(), false);
    assert.equal(JSON.stringify(f.adapter.status()).includes('synthetic-private-document-key'), false);
  }
  const f = await setup(); assert.equal(f.adapter.ready(), true); assert.equal(f.adapter.status().configured, true);
  assert.match(POLICY_FINGERPRINT, /^[a-f0-9]{64}$/); assert.equal(DOCUMENT_VISION_POLICY, 'raad-document-vision-2026-10-29.v8');
  assert.equal(ABSTENTION_POLICY, 'known-empty-hidden-or-passport-p-marker-to-unknown-v2');
  assert.equal(WIRE_PROJECTION_POLICY, 'known-bare-field-abstention-unique-calendar-date-printed-expiry-evidence-outside-portrait-v3');
  assert.deepEqual(COMPATIBLE_PREVIOUS_POLICIES, ['af868ad0d344229ef9b3ba3a0f30b3d67fb85fd4f7259cb30571db9e21e99083', '8773ab57ea6f188b895a5a95c9a1911a5ab73b8a4b863cc68c550580afc33a92', 'f853c10130f15876042ebd6f873d075245959382fb3c97992f7d7bfd42dcea8c', 'c1b9618f397dbbc5b45d51115ad4a69d58d7c609fdb21840e921ade034305036', 'ddb14715b50ca6cfbf217b4b8e35128e1a032ace680ce5a526f16fcbcbb47207']);
  assert.equal(Object.isFrozen(COMPATIBLE_PREVIOUS_POLICIES), true); assert.equal(COMPATIBLE_PREVIOUS_POLICIES.includes(POLICY_FINGERPRINT), false);
  assert.deepEqual(COMPATIBLE_COMPLETED_FAILURE_POLICIES, ['ddb14715b50ca6cfbf217b4b8e35128e1a032ace680ce5a526f16fcbcbb47207']);
  assert.equal(Object.isFrozen(COMPATIBLE_COMPLETED_FAILURE_POLICIES), true);
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

test('explicit null, blank and hidden known fields canonicalize only to absence, including optional name short forms', () => {
  const unknown = {value: null, confidence: 0, visible: false};
  for (const absent of [null, '', ' \t\n ', {value: null}, {value: null, confidence: 1, visible: true}, {value: null, confidence: null, visible: null}, {value: '  ', confidence: 0.99, visible: true}, {value: 'PRIVATE_DISCARDED_TEXT', confidence: 99, visible: false}]) {
    const value = page(); value.fields.latinFatherName = absent; value.fields.latinGrandfatherName = absent;
    const result = validateDocumentExtraction(value);
    assert.deepEqual(result.fields.latinFatherName, unknown); assert.deepEqual(result.fields.latinGrandfatherName, unknown);
    assert.equal(result.fields.latinFirstName.value, 'ARI'); assert.equal(JSON.stringify(result).includes('PRIVATE_DISCARDED_TEXT'), false);
  }
  for (const absent of [null, '', {value: null, visible: true, confidence: 1}, {value: '1990-02-03', visible: false, confidence: 1}]) {
    const value = page(); value.fields.birthDate = absent;
    const extraction = validateDocumentExtraction(value); assert.deepEqual(extraction.fields.birthDate, unknown);
    const {reconcileDocumentEvidence} = require('../src/visa-document-matching');
    const result = reconcileDocumentEvidence({documents: [{mediaId: '12345678-1234-4321-abcd-123456789abc', page: 1, sha256: 'a'.repeat(64), extraction}], applicants: [{nationality: 'مصر'}], referenceDate: '2026-10-28'});
    assert.equal(result.complete, false); assert.equal(result.applicants[0].identityReady, false);
    assert.equal(result.applicants[0].fields.birthDate, undefined); assert.equal(result.applicants[0].issues.some(issue => issue.field === 'birthDate'), true);
  }
});

test('abstention never accepts unknown keys, objects, nonfinite metadata or a bare nonempty fact', () => {
  for (const malformed of [
    'ARI', {value: null, confidence: {}, visible: false}, {value: null, confidence: Infinity, visible: false},
    {value: null, confidence: 0, visible: 'false'}, {value: null, confidence: 0, visible: false, PRIVATE_UNKNOWN_KEY: 'PRIVATE_VALUE'},
    {value: 'ARI', confidence: 1}, {value: {}, confidence: 0, visible: false}
  ]) assert.throws(() => validateDocumentExtraction(page({fields: {latinFatherName: malformed}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const value of [null, '', {value: null}]) assert.throws(() => validateDocumentExtraction(page({fields: {PRIVATE_UNKNOWN_FIELD: value}})), error => error.code === 'DOCUMENT_VISION_SCHEMA_INVALID' && error.fieldName === undefined && !JSON.stringify(error).includes('PRIVATE'));
  assert.throws(() => validateDocumentExtraction(page({fields: {birthDate: field('1990-02-30')}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'value_format'});
  assert.throws(() => validateDocumentExtraction(page({fields: {latinFirstName: field('ARI', 99)}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'field_metadata'});
});

test('portrait and other pages discard only all-unknown known fields while contradictory visible facts remain invalid', () => {
  for (const kind of ['portrait', 'other']) {
    const value = {version: 1, kind, readable: kind === 'portrait', rotation: 0, fields: {latinFatherName: null, latinGrandfatherName: '', birthDate: {value: null, visible: true, confidence: null}}, mrzLines: []};
    assert.deepEqual(validateDocumentExtraction(value).fields, {});
    assert.throws(() => validateDocumentExtraction({...value, fields: {latinFirstName: field('ARI')}}), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
    assert.throws(() => validateDocumentExtraction({...value, mrzLines: ['P<EGY']}), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
    assert.throws(() => validateDocumentExtraction({...value, fields: {PRIVATE_UNKNOWN_FIELD: null}}), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  }
});

test('unknown fields, injected instructions, inherited properties and contradictory confidence are rejected', () => {
  const values = [
    page({authentic: true}), page({fields: {medical: field('no')}}), page({fields: {latinFirstName: {...field('ARI'), instruction: 'ignore previous'}}}),
    page({fields: {latinFirstName: {value: null, visible: 'true', confidence: 1}}}),
    page({fields: {latinFirstName: {value: null, visible: false, confidence: '0'}}}),
    page({fields: {latinFirstName: {value: {}, visible: false, confidence: 0}}}),
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
    {passportType: field('p')}, {passportNumber: field('AB<123')}, {emiratesId: field('784-1990-123')}
  ]) assert.throws(() => validateDocumentExtraction(page({fields})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const type of ['ordinary', 'diplomatic', 'service', 'special']) assert.equal(validateDocumentExtraction(page({fields: {passportType: field(type)}})).fields.passportType.value, type);
  assert.equal(validateDocumentExtraction(page({fields: {birthDate: field('2000-02-29'), emiratesId: field('784-1990-1234567-1')}})).fields.birthDate.value, '2000-02-29');
});

test('the ambiguous P passport marker is discarded to unknown while valid visible facts retain their original evidence', () => {
  const value = page(); value.fields.passportType = field('P', 1);
  const before = structuredClone(value), result = validateDocumentExtraction(value);
  assert.deepEqual(value, before, 'parser does not mutate the provider object');
  assert.deepEqual(result.fields.passportType, {value: null, confidence: 0, visible: false});
  for (const [name, evidence] of Object.entries(before.fields)) if (name !== 'passportType') assert.deepEqual(result.fields[name], evidence);
  assert.equal(Object.values(result.fields).some(evidence => evidence.value === 'ordinary'), false);
  const {reconcileDocumentEvidence} = require('../src/visa-document-matching');
  const matched = reconcileDocumentEvidence({documents: [{mediaId: '12345678-1234-4321-abcd-123456789abc', page: 1, sha256: 'a'.repeat(64), extraction: result}], applicants: [{}], referenceDate: '2026-10-28'});
  assert.equal(matched.applicants[0].fields.passportType, undefined);
  assert.equal(matched.applicants[0].issues.some(issue => issue.code === 'DOCUMENT_FIELD_REQUIRED' && issue.field === 'passportType'), true);
  for (const malformed of ['P', {value: 'P'}, {value: 'P', confidence: 1}, {value: 'P', confidence: 1, visible: 'true'}, field('P', 99)]) assert.throws(() => validateDocumentExtraction(page({fields: {passportType: malformed}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
});

test('instructions contain complete valid wrapped examples and distinct readable semantics for portraits and partial pages', async () => {
  const f = await setup(); await f.extract();
  const prompt = JSON.parse(f.calls[0].options.body).systemInstruction.parts[0].text;
  assert.match(prompt, /at least one allowed field/); assert.match(prompt, /partial supported page is not other/);
  assert.match(prompt, /For a standalone portrait, readable is true when the photo itself is visibly usable/);
  assert.match(prompt, /A bare string or number is invalid/); assert.match(prompt, /never map P to ordinary/);
  assert.match(prompt, /characters 1 through 9 are the document-number zone and character 10 is its separate check digit/);
  assert.match(prompt, /Never strip, append, replace, or repair a character/);
  assert.match(prompt, /MRZ secondary identifiers are not labels for father or grandfather names/);
  assert.match(prompt, /Father Name, Father's Name, or اسم الأب label is direct evidence/);
  assert.match(prompt, /matching checksum, or desire to complete the application must not raise transcription confidence/);
  assert.match(prompt, /passportNationalNumber is private linking evidence, never an application field/);
  const examples = prompt.split('Example for ').slice(1).map(part => JSON.parse(part.slice(part.indexOf(': ') + 2).trim()));
  assert.equal(examples.length, 3);
  for (const example of examples) assert.deepEqual(validateDocumentExtraction(example), example);
  const id = examples.find(example => example.kind === 'uae_id_back');
  assert.deepEqual(Object.keys(id.fields.emiratesId).sort(), ['confidence', 'value', 'visible']);
  const passport = examples.find(example => example.kind === 'passport');
  assert.equal(Object.hasOwn(passport.fields, 'passportType'), false); assert.deepEqual(passport.mrzLines, []); assert.equal(passport.readable, true);
  const portrait = examples.find(example => example.kind === 'portrait');
  assert.deepEqual(portrait.fields, {}); assert.equal(portrait.readable, true);
  assert.throws(() => validateDocumentExtraction({...id, fields: {emiratesId: id.fields.emiratesId.value}}), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', fieldName: 'emiratesId', schemaIssue: 'field_shape'});
});

function wireMatchingFixture() {
  const passport = page();
  Object.assign(passport.fields, {passportNumber: field('ZT1234567'), passportType: field('ordinary'), birthPlace: field('Example City')});
  const check = text => String([...text].reduce((sum, c, index) => sum + (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10);
  const first = 'P<EGYEXAMPLE<<ARI'.padEnd(44, '<'), number = 'ZT1234567', birth = '900203', expiry = '300102', optional = '<'.repeat(14);
  const second = number + check(number) + 'EGY' + birth + check(birth) + 'M' + expiry + check(expiry) + optional + check(optional);
  passport.mrzLines = [first, second + check(second.slice(0, 10) + second.slice(13, 20) + second.slice(21, 43))];
  const identity = {version: 1, kind: 'uae_id_front', readable: true, rotation: 0, fields: {latinFullName: field('ARI EXAMPLE'), birthDate: field('1990-02-03'), emiratesId: field('784199000000001'), residenceExpiry: field('2030-01-02')}, mrzLines: [], portraitBox: null};
  const match = (p = passport, i = identity) => require('../src/visa-document-matching').reconcileDocumentEvidence({documents: [p, i].map((extraction, index) => ({mediaId: '12345678-1234-4321-abcd-12345678900' + index, page: 1, sha256: String(index).repeat(64), extraction})), applicants: [{}], referenceDate: '2026-10-28'});
  return {passport, identity, match};
}

test('wire-only known bare field projections discard values without manufacturing evidence; critical omissions still block matching', () => {
  const f = wireMatchingFixture(); assert.equal(f.match().complete, true);
  for (const name of ['nationalityCode', 'emiratesId', 'birthDate']) {
    const passport = structuredClone(f.passport), identity = structuredClone(f.identity), source = name === 'emiratesId' ? identity : passport;
    source.fields[name] = source.fields[name].value;
    assert.throws(() => validateDocumentExtraction(source), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'field_shape'});
    const result = parseDocumentOutput(JSON.stringify(source));
    assert.deepEqual(result.fields[name], {value: null, confidence: 0, visible: false});
    assert.equal(result.kind, source.kind); assert.equal(result.readable, source.readable);
    for (const [other, evidence] of Object.entries(source.fields)) if (other !== name) assert.deepEqual(result.fields[other], evidence);
    assert.deepEqual(validateDocumentExtraction(result), result, 'projection produces only the existing strict internal schema');
    const matched = name === 'emiratesId' ? f.match(passport, result) : f.match(result, identity);
    assert.equal(matched.complete, false); assert.equal(matched.applicants[0].identityReady, false);
    assert.equal(matched.applicants[0].fields[name], undefined);
    assert.equal(matched.applicants[0].issues.some(issue => issue.code === 'DOCUMENT_FIELD_REQUIRED' && issue.field === name), true);
  }
  for (const name of DOCUMENT_FIELD_NAMES) {
    const wire = page({fields: {[name]: 'SYNTHETIC_BARE_VALUE'}});
    const result = parseDocumentOutput(JSON.stringify(wire));
    assert.deepEqual(result.fields[name], {value: null, confidence: 0, visible: false});
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_BARE_VALUE'), false, 'discarded transcription is never retained');
  }
});

test('discarding an unwrapped known fact preserves a separately classified usable portrait without asserting identity', () => {
  const wire = {version: 1, kind: 'portrait', readable: true, rotation: 0, fields: {birthDate: '1990-02-03'}, mrzLines: [], portraitBox: null};
  assert.throws(() => validateDocumentExtraction(wire), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'field_shape'});
  const portrait = parseDocumentOutput(JSON.stringify(wire));
  assert.deepEqual(portrait, {...wire, fields: {}});
  const f = wireMatchingFixture(), documents = [f.passport, f.identity, portrait].map((extraction, index) => ({mediaId: '12345678-1234-4321-abcd-12345678900' + index, page: 1, sha256: String(index).repeat(64), extraction}));
  const matched = require('../src/visa-document-matching').reconcileDocumentEvidence({documents, applicants: [{}], referenceDate: '2026-10-28'});
  assert.equal(matched.complete, true);
  assert.deepEqual(matched.applicants[0].documents.photo, {mediaId: documents[2].mediaId, page: 1, sha256: documents[2].sha256});
  assert.equal(matched.applicants[0].evidence.authenticityVerified, false);
});

test('ambiguous slash dates remain private evidence until checked passport dates resolve their order', () => {
  const f = wireMatchingFixture();
  for (const [name, source] of [['issueDate', f.passport], ['expiryDate', f.passport], ['residenceExpiry', f.identity]]) {
    const wire = structuredClone(source); wire.fields[name] = field('02/01/2030');
    assert.throws(() => validateDocumentExtraction(wire), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'value_format'});
    const result = parseDocumentOutput(JSON.stringify(wire));
    assert.deepEqual(result.fields[name], {value: null, confidence: 0, visible: false});
    if (name === 'expiryDate') assert.deepEqual(result.fields.printedPassportExpiry, wire.fields[name]);
    if (name === 'residenceExpiry') assert.deepEqual(result.fields.printedResidenceExpiry, wire.fields[name]);
    for (const [key, evidence] of Object.entries(source.fields)) if (key !== name) assert.deepEqual(result.fields[key], evidence);
    const matched = name === 'residenceExpiry' ? f.match(f.passport, result) : f.match(result, f.identity);
    if (name === 'expiryDate') {
      assert.equal(matched.applicants[0].fields.expiryDate, '2030-01-02');
      assert.equal(matched.applicants[0].evidence.fieldSources.expiryDate[0].evidenceField, 'printedPassportExpiry');
    } else assert.equal(matched.applicants[0].fields[name], undefined);
    if (name === 'issueDate') {
      assert.equal(matched.applicants[0].status, 'needs_confirmation');
      assert.deepEqual(matched.applicants[0].clientFieldsRequired, ['issueDate']);
    } else if (name === 'residenceExpiry') assert.equal(matched.applicants[0].identityReady, false);
  }
});

test('wrapped full-year slash dates retain exactly one real calendar interpretation and the original confidence', () => {
  const cases = [['13/07/2030', '2030-07-13'], ['07/13/2030', '2030-07-13'], ['7/7/2030', '2030-07-07'], ['29/2/2000', '2000-02-29'], ['2/29/2000', '2000-02-29'], ['13/07/0099', '0099-07-13'], ['13/07/0001', '0001-07-13']];
  for (const name of ['birthDate', 'issueDate', 'expiryDate', 'residenceExpiry']) for (const [raw, iso] of cases) {
    const wire = page({fields: {[name]: field(raw, 0.731), latinFirstName: field('ARI')}});
    assert.throws(() => validateDocumentExtraction(wire), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaIssue: 'value_format'});
    const result = parseDocumentOutput(JSON.stringify(wire));
    assert.deepEqual(result.fields[name], {value: iso, confidence: 0.731, visible: true});
    assert.deepEqual(result.fields.latinFirstName, wire.fields.latinFirstName);
    assert.deepEqual(validateDocumentExtraction(result), result);
  }
});

test('ambiguous, impossible and zero-year slash dates never choose an order, roll over or infer a century', () => {
  for (const raw of ['02/01/2030', '01/02/2030', '31/02/2030', '02/31/2030', '29/02/1900', '13/13/2030', '0/1/2030', '1/0/2030', '1/1/0000']) {
    const result = parseDocumentOutput(JSON.stringify(page({fields: {expiryDate: field(raw)}})));
    assert.deepEqual(result.fields.expiryDate, {value: null, confidence: 0, visible: false});
  }
  for (const raw of ['13/07/30', '13/07/030', '13/07/12030', '2030/07/13', '13/7/2030 ', '-13/07/2030']) assert.throws(() => parseDocumentOutput(JSON.stringify(page({fields: {expiryDate: field(raw)}}))), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const malformed of [{value: '13/07/2030'}, {value: '13/07/2030', confidence: 1}, {value: '13/07/2030', confidence: '0.99', visible: true}, {value: '13/07/2030', confidence: 2, visible: true}]) assert.throws(() => parseDocumentOutput(JSON.stringify(page({fields: {expiryDate: malformed}}))), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.deepEqual(parseDocumentOutput(JSON.stringify(page({fields: {expiryDate: '13/07/2030'}}))).fields.expiryDate, {value: null, confidence: 0, visible: false}, 'a uniquely parseable bare value still has no trusted visibility or confidence');
});

test('unique date conversion does not raise model certainty or repair a visual passport number to make MRZ agree', () => {
  const f = wireMatchingFixture(), low = structuredClone(f.passport);
  low.fields.issueDate = field('13/07/2020', 0.979);
  const read = parseDocumentOutput(JSON.stringify(low));
  assert.deepEqual(read.fields.issueDate, {value: '2020-07-13', confidence: 0.979, visible: true});
  const unresolved = f.match(read);
  assert.equal(unresolved.complete, false); assert.equal(unresolved.applicants[0].fields.issueDate, undefined);
  assert.deepEqual(unresolved.applicants[0].clientFieldsRequired, ['issueDate']);
  const wrongNumber = structuredClone(f.passport); wrongNumber.fields.passportNumber.value += '1';
  const exact = parseDocumentOutput(JSON.stringify(wrongNumber));
  assert.deepEqual(exact.fields.passportNumber, wrongNumber.fields.passportNumber); assert.deepEqual(exact.mrzLines, wrongNumber.mrzLines);
  const failed = f.match(exact); assert.equal(failed.applicants[0].identityReady, false);
  assert.equal(failed.applicants[0].issues.some(issue => issue.code === 'PASSPORT_VIZ_MRZ_MISMATCH'), true);
});

test('father-name evidence is retained exactly when supplied and never reconstructed from MRZ secondary names', () => {
  const f = wireMatchingFixture(), wire = structuredClone(f.passport);
  wire.mrzLines[0] = 'P<EGYEXAMPLE<<ARI<BELA'.padEnd(44, '<');
  const absent = parseDocumentOutput(JSON.stringify(wire));
  assert.equal(Object.hasOwn(absent.fields, 'latinFatherName'), false); assert.deepEqual(absent.mrzLines, wire.mrzLines);
  wire.fields.latinFatherName = field('BELA', 0.987);
  const present = parseDocumentOutput(JSON.stringify(wire));
  assert.deepEqual(present.fields.latinFatherName, wire.fields.latinFatherName);
  assert.equal(Object.hasOwn(present.fields, 'latinGrandfatherName'), false);
});

test('passport national number is bounded explicit evidence with preserved leading zeros and is never a government field', () => {
  for (const raw of ['001-23456789', '001 23456789', '00123456789']) {
    const wire = page({fields: {passportNationalNumber: field(raw, 0.987)}});
    const result = validateDocumentExtraction(wire);
    assert.deepEqual(result.fields.passportNationalNumber, {value: raw, confidence: 0.987, visible: true});
    assert.deepEqual(parseDocumentOutput(JSON.stringify(wire)), result);
  }
  for (const raw of ['001--23456789', '001/23456789', '+00123456789', '001A23456789', '-00123456789', '00123456789-', '1'.repeat(21)]) assert.throws(() => validateDocumentExtraction(page({fields: {passportNationalNumber: field(raw)}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', fieldName: 'passportNationalNumber'});
  assert.throws(() => validateDocumentExtraction(page({kind: 'uae_id_front', fields: {passportNationalNumber: field('001-23456789')}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', fieldName: 'passportNationalNumber'});
  assert.deepEqual(parseDocumentOutput(JSON.stringify(page({fields: {passportNationalNumber: '001-23456789'}}))).fields.passportNationalNumber, {value: null, confidence: 0, visible: false});
  assert.equal(require('../src/raad-visa-workflow').DOCUMENT_FACT_FIELDS.includes('passportNationalNumber'), false);
});

test('printed expiry evidence preserves exact wrapped full-year text without choosing order or adding government answers', () => {
  const unknown = {value: null, confidence: 0, visible: false};
  for (const [kind, sourceName, evidenceName] of [['passport', 'expiryDate', 'printedPassportExpiry'], ['uae_id_front', 'residenceExpiry', 'printedResidenceExpiry'], ['uae_id_back', 'residenceExpiry', 'printedResidenceExpiry']]) {
    const wire = page({kind, fields: {[sourceName]: field('2/1/2030', 0.983)}});
    const result = parseDocumentOutput(JSON.stringify(wire));
    assert.deepEqual(result.fields[sourceName], unknown);
    assert.deepEqual(result.fields[evidenceName], {value: '2/1/2030', confidence: 0.983, visible: true});
    assert.deepEqual(validateDocumentExtraction(result), result);
    assert.equal(require('../src/raad-visa-workflow').DOCUMENT_FACT_FIELDS.includes(evidenceName), false);
    const explicit = page({kind, fields: {[evidenceName]: field('2/1/2030', 0.983)}});
    assert.deepEqual(validateDocumentExtraction(explicit), explicit);
    assert.deepEqual(parseDocumentOutput(JSON.stringify(page({kind, fields: {[evidenceName]: '2/1/2030'}}))).fields[evidenceName], unknown);
    for (const invalid of ['2/1/30', '31/02/2030', '1/1/0000', '2030-01-02']) assert.throws(() => validateDocumentExtraction(page({kind, fields: {[evidenceName]: field(invalid)}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', fieldName: evidenceName});
  }
  assert.throws(() => validateDocumentExtraction(page({kind: 'uae_id_front', fields: {printedPassportExpiry: field('02/01/2030')}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.throws(() => validateDocumentExtraction(page({kind: 'passport', fields: {printedResidenceExpiry: field('02/01/2030')}})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  const conflict = page({fields: {expiryDate: field('02/01/2030'), printedPassportExpiry: field('03/01/2030')}});
  assert.throws(() => parseDocumentOutput(JSON.stringify(conflict)), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', fieldName: 'printedPassportExpiry'});
  const weaker = page({fields: {expiryDate: field('02/01/2030', 0.99), printedPassportExpiry: field('02/01/2030', 0.8)}});
  assert.equal(parseDocumentOutput(JSON.stringify(weaker)).fields.printedPassportExpiry.confidence, 0.8, 'combining duplicate evidence cannot raise the weaker confidence');
});

test('finite out-of-bounds wire crop is discarded; valid document facts survive and a full passport never becomes the portrait', async () => {
  const f = wireMatchingFixture(), wire = structuredClone(f.passport);
  wire.portraitBox = {x: 0.9, y: 0.1, width: 0.4, height: 0.5, confidence: 1};
  assert.throws(() => validateDocumentExtraction(wire), {code: 'DOCUMENT_VISION_SCHEMA_INVALID', schemaSection: 'portraitBox'});
  const result = parseDocumentOutput(JSON.stringify(wire));
  assert.equal(result.portraitBox, null); assert.deepEqual(result.fields, f.passport.fields);
  const matched = f.match(result); assert.equal(matched.complete, true); assert.equal(matched.applicants[0].documents.photo, null);
  const {VisaDocumentIntake} = require('../src/visa-document-intake');
  await assert.rejects(VisaDocumentIntake.prototype.portraitCrop.call({}, {bytes: await image(), extraction: result}), {code: 'DOCUMENT_PORTRAIT_REQUIRED'});
});

test('wire projection never suppresses unknown keys, wrong metadata, other date forms or malformed root and crop shapes', () => {
  for (const fields of [
    {PRIVATE_UNKNOWN_FIELD: 'PRIVATE_VALUE'}, {nationalityCode: {value: 'EGY', confidence: 1}},
    {emiratesId: {value: '784199000000001', confidence: '1', visible: true}},
    {issueDate: {value: '02/01/2030', confidence: '1', visible: true}},
    {expiryDate: {...field('02/01/2030'), PRIVATE_KEY: 'PRIVATE_VALUE'}},
    {issueDate: field('2030/01/02')}, {nationalityCode: ' EGY '}
  ]) assert.throws(() => parseDocumentOutput(JSON.stringify(page({fields}))), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  for (const portraitBox of [
    {x: 0.9, y: 0, width: 0.5, height: 0.5, confidence: 2},
    {x: '0.9', y: 0, width: 0.5, height: 0.5, confidence: 1},
    {x: 0.9, y: 0, width: 0.5, height: 0.5, confidence: 1, PRIVATE_KEY: 'PRIVATE_VALUE'},
    {x: 0.9, y: 0, width: 0.5, height: 0.5}
  ]) assert.throws(() => parseDocumentOutput(JSON.stringify(page({portraitBox}))), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.throws(() => parseDocumentOutput(JSON.stringify(page({PRIVATE_KEY: 'PRIVATE_VALUE'}))), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
  assert.throws(() => parseDocumentOutput(JSON.stringify({...page(), fields: ['EGY']})), {code: 'DOCUMENT_VISION_SCHEMA_INVALID'});
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
