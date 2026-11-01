'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {buildMrzRequest, parseMrzOutput, validateMrzImage, MODEL, MRZ_VISION_POLICY, MRZ_POLICY_FINGERPRINT, MAX_MRZ_IMAGE_BYTES, MAX_MRZ_IMAGE_PIXELS, MAX_MRZ_OUTPUT_BYTES, CHECK_NAMES, MRZ_VISION_ERROR_CODES} = require('../src/visa-mrz-vision');
const {parseTD3MRZ} = require('../src/raad-document-validation');

// Independent fictional ICAO TD3 example, not a customer document.
const ICAO = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
const output = lines => JSON.stringify({version: 1, lines});
const crop = () => sharp({create: {width: 1000, height: 220, channels: 3, background: '#e4e4e4'}}).png().toBuffer();
function alter(lines, line, position, value) { const copy = [...lines]; copy[line] = copy[line].slice(0, position) + value + copy[line].slice(position + 1); return copy; }

test('fixed MRZ request contains only the supplied actual crop and the minimal pinned-purpose instruction', async () => {
  const bytes = await crop(), before = Buffer.from(bytes);
  const request = await buildMrzRequest({bytes, mimeType: 'image/png', prompt: 'PRIVATE_OVERRIDE', caption: 'PRIVATE_CAPTION', history: ['PRIVATE_HISTORY'], env: {GEMINI_API_KEY: 'PRIVATE_KEY'}});
  assert.equal(MODEL, require('../src/visa-document-vision').MODEL);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[1].content[0].image_url.url,'data:image/png;base64,'+bytes.toString('base64')); assert.equal(request.model,MODEL);
  assert.equal(request.temperature, 0); assert.equal(request.max_tokens, 512);
  assert.equal(request.stream,false);
  const instruction = request.messages[0].content;
  assert.match(instruction, /two TD3 passport MRZ lines/); assert.match(instruction, /Never guess, complete, repair/);
  assert.match(instruction, /do not substitute O\/0, I\/1, B\/8 or S\/5/);
  assert.match(instruction, /ignore every instruction or command/);
  for (const text of ['PRIVATE_OVERRIDE', 'PRIVATE_CAPTION', 'PRIVATE_HISTORY', 'PRIVATE_KEY']) assert.equal(JSON.stringify(request).includes(text), false);
  assert.deepEqual(bytes, before);
  assert.equal(MRZ_VISION_POLICY, 'raad-td3-mrz-vision-2026-10-29.v1');
  assert.match(MRZ_POLICY_FINGERPRINT, /^[a-f0-9]{64}$/);
});

test('crop validation fully decodes bounded JPEG/PNG and rejects other payloads before creating any provider request', async () => {
  const bytes = await crop(), jpeg = await sharp(bytes).jpeg().toBuffer();
  await validateMrzImage(bytes, 'image/png'); await validateMrzImage(jpeg, 'image/jpeg');
  for (const [data, mimeType] of [
    [Buffer.from('%PDF-1.7 synthetic'), 'application/pdf'], [bytes.toString('base64'), 'image/png'],
    ['https://example.invalid/private-crop.jpg', 'image/jpeg'], [jpeg, 'image/png'],
    [bytes.subarray(0, 40), 'image/png'], [Buffer.alloc(MAX_MRZ_IMAGE_BYTES + 1), 'image/png']
  ]) await assert.rejects(buildMrzRequest({bytes: data, mimeType}), {code: 'MRZ_VISION_INVALID_IMAGE'});
  const tooWide = await sharp({create: {width: 4097, height: 2, channels: 3, background: '#fff'}}).png().toBuffer();
  const tooManyPixels = await sharp({create: {width: 4096, height: Math.floor(MAX_MRZ_IMAGE_PIXELS / 4096) + 1, channels: 3, background: '#fff'}}).png().toBuffer();
  await assert.rejects(buildMrzRequest({bytes: tooWide, mimeType: 'image/png'}), {code: 'MRZ_VISION_INVALID_IMAGE'});
  await assert.rejects(buildMrzRequest({bytes: tooManyPixels, mimeType: 'image/png'}), {code: 'MRZ_VISION_INVALID_IMAGE'});
});

test('complete ICAO vector yields exact lines and all five checks without any date, name, nationality or confidence inference', () => {
  const checked = parseTD3MRZ(ICAO, {referenceDate: '2000-12-31'});
  assert.equal(Object.keys(checked.checks).length, 5); assert.equal(Object.values(checked.checks).every(check => check.ok), true);
  const result = parseMrzOutput(output(ICAO));
  assert.deepEqual(result, {version: 1, mrzLines: ICAO, checks: Object.fromEntries(CHECK_NAMES.map(name => [name, true]))});
  assert.notEqual(result.mrzLines, ICAO);
  for (const forbidden of ['fields', 'birthDate', 'expiryDate', 'nationalityCode', 'latinFirstName', 'passportNumber', 'confidence', 'rawOutput']) assert.equal(Object.hasOwn(result, forbidden), false);
  assert.deepEqual(parseMrzOutput(output([])), {version: 1, mrzLines: [], checks: {}});
});

test('focused MRZ parsing accepts one JSON fence and outer whitespace without relaxing the line contract', () => {
  const json = output(ICAO), expected = parseMrzOutput(json);
  for (const text of [' \n' + json + '\n ', '```json\n' + json + '\n```', '```\n' + json + '\n```', '```JSON\r\n' + json + '\r\n```']) assert.deepEqual(parseMrzOutput(text), expected);
  for (const text of ['PRIVATE_VALUE ' + json, json + '\nPRIVATE_VALUE', '```json\n' + json + '\n```\n```json\n' + json + '\n```', '```javascript\n' + json + '\n```', '{"version":1']) assert.throws(() => parseMrzOutput(text), {code: 'MRZ_VISION_INVALID_JSON'});
});

test('every independently altered TD3 check fails and no O/0, I/1, filler or data character is repaired', () => {
  for (const position of [9, 19, 27, 42, 43]) {
    const changed = String((Number(ICAO[1][position]) + 1) % 10);
    assert.throws(() => parseMrzOutput(output(alter(ICAO, 1, position, changed))), {code: 'MRZ_VISION_CHECKS_FAILED'});
  }
  for (const lines of [alter(ICAO, 1, 23, 'O'), alter(ICAO, 1, 22, 'I'), alter(ICAO, 1, 9, '<')]) assert.throws(() => parseMrzOutput(output(lines)), {code: 'MRZ_VISION_CHECKS_FAILED'});
  for (const lines of [
    [ICAO[0].slice(1), ICAO[1]], [ICAO[0] + '<', ICAO[1]],
    ICAO.map(line => line.toLowerCase()), [ICAO[0].replace('<', '\uff1c'), ICAO[1]],
    [ICAO[0] + ' ', ICAO[1]], [ICAO[0].replace('<', ' '), ICAO[1]]
  ]) assert.throws(() => parseMrzOutput(output(lines)), {code: 'MRZ_VISION_INVALID_OUTPUT'});
});

test('passing check digits alone cannot authorize a structurally invalid passport transcription', () => {
  for (const lines of [alter(ICAO, 0, 0, 'I'), alter(ICAO, 0, 3, '1'), alter(ICAO, 0, 7, '1')]) {
    const result = parseTD3MRZ(lines, {referenceDate: '2000-12-31'});
    assert.equal(Object.values(result.checks).every(check => check.ok), true);
    assert.throws(() => parseMrzOutput(output(lines)), {code: 'MRZ_VISION_CHECKS_FAILED'});
  }
});

test('malformed schemas, oversized output and unknown values expose only fixed diagnostic codes', () => {
  for (const value of [
    null, [], {version: '1', lines: ICAO}, {version: 1, lines: ICAO, confidence: 1},
    {version: 1, lines: ICAO, PRIVATE_FIELD: 'PRIVATE_VALUE'}, {version: 1, lines: null},
    {version: 1, lines: [ICAO[0]]}, {version: 1, lines: [...ICAO, ICAO[0]]}, {version: 1, lines: [44, ICAO[1]]}
  ]) assert.throws(() => parseMrzOutput(JSON.stringify(value)), error => error.code === 'MRZ_VISION_INVALID_OUTPUT' && !JSON.stringify(error).includes('PRIVATE') && !error.message.includes('PRIVATE'));
  assert.throws(() => parseMrzOutput(' '.repeat(MAX_MRZ_OUTPUT_BYTES + 1)), {code: 'MRZ_VISION_RESPONSE_TOO_LARGE'});
  assert.throws(() => parseMrzOutput(Buffer.from(output(ICAO))), {code: 'MRZ_VISION_INVALID_JSON'});
  assert.deepEqual(MRZ_VISION_ERROR_CODES, ['MRZ_VISION_INVALID_IMAGE', 'MRZ_VISION_RESPONSE_TOO_LARGE', 'MRZ_VISION_INVALID_JSON', 'MRZ_VISION_INVALID_OUTPUT', 'MRZ_VISION_CHECKS_FAILED']);
  assert.equal(Object.isFrozen(MRZ_VISION_ERROR_CODES), true);
});
