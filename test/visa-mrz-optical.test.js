'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const sharp = require('sharp');
const {createOpticalMrz, createIsolatedWorker, verifyPinnedModel, OPTICAL_POLICY_FINGERPRINT, MRZ_OPTICAL_ERROR_CODES, TIMEOUT_MS, MAX_INPUT_BYTES} = require('../src/visa-mrz-optical');
const {MODEL_BYTES} = require('../scripts/install-mrz-model');

const ICAO = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
// Independent fictional Utopia vector: ICAO Doc 9303 Part 5, Appendix A.
const ICAO_TD1 = ['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<'];
const text = lines => lines.join('\n');
const image = () => sharp({create: {width: 1000, height: 400, channels: 3, background: '#c0c0c0'}}).png().toBuffer();
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };

function fixture({reads = [text(ICAO), text(ICAO)], recognize, terminate, ...options} = {}) {
  const calls = {created: [], parameters: [], recognized: [], copies: [], terminated: 0, verified: 0};
  const worker = {
    async setParameters(parameters) { calls.parameters.push(parameters); },
    async recognize(bytes, opts, outputs) {
      const index = calls.recognized.length; calls.recognized.push({bytes, opts, outputs}); calls.copies.push(Buffer.from(bytes));
      return recognize ? recognize(bytes, index) : {data: {text: reads[index]}};
    },
    async terminate() { calls.terminated++; if (terminate) return terminate(); }
  };
  const adapter = createOpticalMrz({verifyModelImpl: () => { calls.verified++; return true; }, createWorkerImpl: async (...args) => { calls.created.push(args); return worker; }, ...options});
  return {adapter, calls, worker};
}

test('local optical reader uses one local worker, fixed generic crop, two bounded modes and clears owned pixel buffers', async () => {
  const f = fixture(), bytes = await image(), original = Buffer.from(bytes);
  const result = await f.adapter.extract({bytes, mimeType: 'image/png', guard: () => true});
  assert.deepEqual(result.mrzLines, ICAO); assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(f.calls.created.length, 1); assert.equal(f.calls.terminated, 1); assert.ok(f.calls.verified >= 2);
  const [lang, oem, options] = f.calls.created[0];
  assert.equal(lang, 'mrz'); assert.equal(oem, 1); assert.equal(options.gzip, false); assert.equal(options.cacheMethod, 'none');
  assert.equal(options.legacyCore, false); assert.equal(options.legacyLang, false); assert.equal(options.langPath.startsWith('http'), false);
  assert.equal(options.logger({PRIVATE: 'PRIVATE_VALUE'}), undefined); assert.equal(options.errorHandler(Error('PRIVATE_VALUE')), undefined);
  assert.deepEqual(f.calls.parameters.map(params => params.tessedit_pageseg_mode), [6, 11]);
  for (const params of f.calls.parameters) { assert.equal(params.user_defined_dpi, '300'); assert.equal(params.tessedit_char_whitelist, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'); }
  for (const read of f.calls.recognized) { assert.deepEqual(read.outputs, {text: true}); assert.equal(read.bytes.every(value => value === 0), true); }
  const metadata = await sharp(f.calls.copies[0]).metadata(); assert.deepEqual([metadata.width, metadata.height], [900, 120]);
  const pixels = await sharp(f.calls.copies[0]).removeAlpha().raw().toBuffer();
  assert.equal(pixels[0], pixels[1]); assert.equal(pixels[1], pixels[2]); assert.deepEqual(f.calls.copies[0], f.calls.copies[1]);
  assert.deepEqual(bytes, original); assert.equal(f.adapter.ready(), true); assert.equal(f.adapter.status().busy, false);
  assert.equal(f.adapter.policyFingerprint, OPTICAL_POLICY_FINGERPRINT); assert.match(OPTICAL_POLICY_FINGERPRINT, /^[a-f0-9]{64}$/);
});

test('one independently checked reading suffices; two valid conflicting readings fail closed', async () => {
  const bytes = await image();
  const one = fixture({reads: ['UNREADABLE', '\n \t' + ICAO[0] + ' \n\n' + ICAO[1] + '\t\n']});
  assert.deepEqual((await one.adapter.extract({bytes, mimeType: 'image/png', guard: () => true})).mrzLines, ICAO);
  const other = [...ICAO]; other[0] = other[0].slice(0, 7) + 'A' + other[0].slice(8);
  const conflict = fixture({reads: [text(ICAO), text(other)]});
  await assert.rejects(conflict.adapter.extract({bytes, mimeType: 'image/png', guard: () => true}), {code: 'MRZ_OPTICAL_DISAGREEMENT'});
  assert.equal(conflict.calls.terminated, 1); assert.equal(conflict.adapter.ready(), true);
});

test('explicit TD1 uses its own generic crop and preserves the independently checked three-line vector without facts or century inference', async () => {
  const width = 1000, height = 450, raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = y < 150 ? [255, 0, 0] : x < 50 || x >= 950 ? [0, 0, 255] : [0, 255, 0];
    const index = (y * width + x) * 3; raw[index] = color[0]; raw[index + 1] = color[1]; raw[index + 2] = color[2];
  }
  const bytes = await sharp(raw, {raw: {width, height, channels: 3}}).png().toBuffer();
  const f = fixture({reads: [text(ICAO_TD1), '\r\n\t' + ICAO_TD1.join(' \r\n\r\n') + '\t\n']});
  const result = await f.adapter.extract({bytes, mimeType: 'image/png', format: 'TD1', guard: () => true});
  assert.deepEqual(result, {version: 1, mrzLines: ICAO_TD1, checks: {documentNumber: true, birthDate: true, expiryDate: true, composite: true}});
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'mrzLines', 'version']);
  assert.equal(result.fields, undefined); assert.equal(result.confidence, undefined);
  assert.equal(f.calls.created.length, 1); assert.equal(f.calls.recognized.length, 2); assert.equal(f.calls.terminated, 1);
  const cropped = await sharp(f.calls.copies[0]).raw().toBuffer({resolveWithObject: true});
  assert.deepEqual([cropped.info.width, cropped.info.height], [900, 300]);
  const gray = await sharp({create: {width: 1, height: 1, channels: 3, background: '#00ff00'}}).greyscale().raw().toBuffer();
  assert.equal(cropped.data.every(value => value === gray[0]), true, 'only the fixed bottom two-thirds and inner 90% are retained');
  assert.equal(f.calls.recognized.every(read => read.bytes.every(value => value === 0)), true);
});

test('TD1 cannot cross the explicit format boundary and unsupported format names never start a worker', async () => {
  const bytes = await image(), f = fixture();
  assert.equal(Object.isFrozen(f.adapter.supports), true);
  for (const format of ['TD1', 'TD3']) assert.equal(f.adapter.supports(format), true);
  for (const format of [undefined, null, 'td1', 'TD2', '', '__proto__', 'constructor', {}, ['TD1']]) assert.equal(f.adapter.supports(format), false);
  for (const format of [null, 'td1', 'TD2', '__proto__', 'constructor', {}]) await assert.rejects(f.adapter.extract({bytes, mimeType: 'image/png', format, guard: () => true}), {code: 'MRZ_OPTICAL_INVALID_IMAGE'});
  assert.equal(f.calls.created.length, 0);
  for (const [format, lines] of [['TD1', ICAO], ['TD3', ICAO_TD1], [undefined, ICAO_TD1]]) {
    const other = fixture({reads: [text(lines), text(lines)]});
    await assert.rejects(other.adapter.extract({bytes, mimeType: 'image/png', format, guard: () => true}), {code: 'MRZ_OPTICAL_READ_FAILED'});
    assert.equal(other.calls.terminated, 1);
  }
});

test('TD1 independently rejects all four bad check digits and leaves missing, unsupported and substituted glyphs unrepaired', async () => {
  const bytes = await image(), candidates = [];
  const altered = (row, position, replacement) => { const lines = [...ICAO_TD1]; lines[row] = lines[row].slice(0, position) + replacement + lines[row].slice(position + 1); return lines; };
  for (const [row, position] of [[0, 14], [1, 6], [1, 14], [1, 29]]) candidates.push(altered(row, position, String((Number(ICAO_TD1[row][position]) + 1) % 10)));
  candidates.push(
    ICAO_TD1.slice(0, 2), [ICAO_TD1[0], ICAO_TD1[1], ICAO_TD1[2] + '<'],
    altered(1, 0, 'O'), altered(2, 0, '3'), altered(2, 0, '\u0415'),
    [ICAO_TD1[0].slice(0, 8) + ' ' + ICAO_TD1[0].slice(8), ...ICAO_TD1.slice(1)],
    ICAO_TD1.map(line => line.toLowerCase()), ICAO_TD1.map(line => line.replaceAll('<', '\u2039'))
  );
  for (const lines of candidates) {
    const f = fixture({reads: [text(lines), text(lines)]});
    await assert.rejects(f.adapter.extract({bytes, mimeType: 'image/png', format: 'TD1', guard: () => true}), {code: 'MRZ_OPTICAL_READ_FAILED'});
    assert.equal(f.calls.recognized.length, 2); assert.equal(f.calls.terminated, 1); assert.equal(f.adapter.ready(), true);
  }
});

test('two complete, checked TD1 readings with different unprotected names fail closed', async () => {
  const other = [...ICAO_TD1]; other[2] = 'A' + other[2].slice(1);
  const f = fixture({reads: [text(ICAO_TD1), text(other)]});
  await assert.rejects(f.adapter.extract({bytes: await image(), mimeType: 'image/png', format: 'TD1', guard: () => true}), {code: 'MRZ_OPTICAL_DISAGREEMENT'});
  assert.equal(f.calls.terminated, 1); assert.equal(f.adapter.ready(), true);
});

test('interior spaces, wrong checksums and substituted glyphs cannot be fixed by the optical adapter', async () => {
  const bytes = await image(), badCheck = [...ICAO]; badCheck[1] = badCheck[1].slice(0, 43) + '1';
  const badGlyph = [...ICAO]; badGlyph[1] = badGlyph[1].slice(0, 23) + 'O' + badGlyph[1].slice(24);
  const spaced = [ICAO[0].slice(0, 10) + ' ' + ICAO[0].slice(10), ICAO[1]];
  for (const invalid of ['', 'PRIVATE_VALUE', text(badCheck), text(badGlyph), text(spaced), text(ICAO).toLowerCase()]) {
    const f = fixture({reads: [invalid, invalid]});
    await assert.rejects(f.adapter.extract({bytes, mimeType: 'image/png', guard: () => true}), error => error.code === 'MRZ_OPTICAL_READ_FAILED' && !error.message.includes('PRIVATE') && !JSON.stringify(error).includes('PRIVATE'));
    assert.equal(f.calls.recognized.length, 2); assert.equal(f.calls.terminated, 1);
  }
});

test('missing or same-size incorrect pinned model never starts an OCR worker or fetch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mrz-optical-test-'));
  try {
    const bytes = await image(); let created = 0;
    assert.equal(verifyPinnedModel(directory), false);
    const missing = createOpticalMrz({modelDirectory: directory, createWorkerImpl: () => { created++; throw Error('must not run'); }});
    assert.equal(missing.ready(), false); assert.equal(missing.status().configured, false);
    await assert.rejects(missing.extract({bytes, mimeType: 'image/png', guard: () => true}), {code: 'MRZ_OPTICAL_MODEL_UNAVAILABLE'});
    await fs.writeFile(path.join(directory, 'mrz.traineddata'), Buffer.alloc(MODEL_BYTES));
    assert.equal(verifyPinnedModel(directory), false);
    const invalid = createOpticalMrz({modelDirectory: directory, createWorkerImpl: () => { created++; throw Error('must not run'); }});
    await assert.rejects(invalid.extract({bytes, mimeType: 'image/png', guard: () => true}), {code: 'MRZ_OPTICAL_MODEL_UNAVAILABLE'});
    assert.equal(created, 0); assert.equal(JSON.stringify(invalid.status()).includes(directory), false);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('input guards reject non-images, oversized and undecodable images without a worker', async () => {
  const f = fixture(), bytes = await image();
  for (const [input, mimeType] of [[bytes.toString('base64'), 'image/png'], [Buffer.from('%PDF-synthetic'), 'application/pdf'], [Buffer.alloc(MAX_INPUT_BYTES + 1), 'image/png'], [bytes.subarray(0, 35), 'image/png'], [bytes, 'image/jpeg']]) await assert.rejects(f.adapter.extract({bytes: input, mimeType, guard: () => true}), {code: 'MRZ_OPTICAL_INVALID_IMAGE'});
  const huge = await sharp({create: {width: 2100, height: 2000, channels: 3, background: '#fff'}}).png().toBuffer();
  await assert.rejects(f.adapter.extract({bytes: huge, mimeType: 'image/png', guard: () => true}), {code: 'MRZ_OPTICAL_INVALID_IMAGE'});
  assert.equal(f.calls.created.length, 0);
});

test('stale case guard before or after OCR prevents acceptance and still erases pixels and terminates', async () => {
  const bytes = await image(), f = fixture();
  for (const guard of [undefined, () => false, () => { throw Error('PRIVATE_GUARD'); }]) await assert.rejects(f.adapter.extract({bytes, mimeType: 'image/png', guard}), {code: 'DOCUMENT_VISION_STALE'});
  assert.equal(f.calls.created.length, 0);
  let alive = true;
  const changed = fixture({recognize: async () => { alive = false; return {data: {text: text(ICAO)}}; }});
  await assert.rejects(changed.adapter.extract({bytes, mimeType: 'image/png', guard: () => alive}), {code: 'DOCUMENT_VISION_STALE'});
  assert.equal(changed.calls.recognized.length, 1); assert.equal(changed.calls.terminated, 1);
  assert.equal(changed.calls.recognized[0].bytes.every(value => value === 0), true);
});

test('one process lease prevents concurrent worker creation and remains held through termination', async () => {
  const ending = deferred(), entered = deferred(), f = fixture({terminate: () => { entered.resolve(); return ending.promise; }}), bytes = await image();
  const first = f.adapter.extract({bytes, mimeType: 'image/png', guard: () => true});
  await entered.promise;
  assert.equal(f.adapter.status().busy, true); assert.equal(f.adapter.ready(), false);
  const other = fixture();
  await assert.rejects(other.adapter.extract({bytes, mimeType: 'image/png', guard: () => true}), {code: 'DOCUMENT_VISION_BUSY'});
  assert.equal(other.calls.created.length, 0);
  ending.resolve(); assert.deepEqual((await first).mrzLines, ICAO); assert.equal(f.adapter.ready(), true);
});

test('default isolation owns initialization immediately, strips inherited options and holds the lease until child close', async () => {
  const child = new EventEmitter(), ending = deferred(); let forkOptions, script, kills = 0;
  child.send = (message, callback) => {
    callback?.(null);
    if (message.type === 'init') queueMicrotask(() => child.emit('message', {type: 'ready'}));
    else queueMicrotask(() => child.emit('message', {type: 'result', id: message.id, ok: true, ...(message.type === 'recognize' ? {text: text(ICAO)} : {})}));
  };
  child.kill = signal => { assert.equal(signal, 'SIGKILL'); kills++; ending.resolve(); return true; };
  const f = fixture({createWorkerImpl: (...args) => createIsolatedWorker(...args, {forkImpl: (filename, argv, options) => { script = filename; forkOptions = options; assert.deepEqual(argv, []); return child; }})});
  const bytes = await image(), pending = f.adapter.extract({bytes, mimeType: 'image/png', guard: () => true});
  await ending.promise; await turn();
  assert.equal(kills, 1); assert.equal(f.adapter.status().busy, true);
  assert.equal(path.basename(script), 'visa-mrz-optical-worker.js');
  assert.deepEqual(forkOptions.execArgv, []); assert.deepEqual(forkOptions.env, {NODE_ENV: 'production', LANG: 'C', TZ: 'UTC'});
  assert.deepEqual(forkOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']); assert.equal(forkOptions.serialization, 'advanced');
  const next = fixture(); await assert.rejects(next.adapter.extract({bytes, mimeType: 'image/png', guard: () => true}), {code: 'DOCUMENT_VISION_BUSY'});
  child.emit('close', null, 'SIGKILL'); assert.deepEqual((await pending).mrzLines, ICAO); assert.equal(f.adapter.ready(), true);
});

test('child failure before initialization is contained, settles pending calls and still waits for owned child close', async () => {
  const child = new EventEmitter(); let sent = 0, kills = 0, finished = false;
  child.send = (message, callback) => { sent++; callback?.(null); };
  child.kill = signal => { assert.equal(signal, 'SIGKILL'); kills++; return true; };
  const worker = createIsolatedWorker('mrz', 1, {langPath: '/synthetic/private-model'}, {forkImpl: () => child});
  const waiting = worker.setParameters({tessedit_pageseg_mode: 6});
  child.emit('error', Error('PRIVATE_NATIVE_INITIALIZATION_ERROR'));
  await assert.rejects(waiting, error => error.code === 'MRZ_OPTICAL_ENGINE_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  const closing = worker.terminate().then(() => { finished = true; }); await turn();
  assert.equal(finished, false); assert.equal(kills, 1); assert.equal(sent, 1, 'only the fixed initialization message was sent');
  child.emit('close', 1, null); await closing; assert.equal(finished, true);
});

test('child replies are bounded to text and neither worker errors nor extra reply data become public errors', async () => {
  const child = new EventEmitter(); let initialization;
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
  child.send = (message, callback) => { callback?.(null); if (message.type === 'init') initialization = message; else queueMicrotask(() => child.emit('message', {type: 'result', id: message.id, ok: true, text: 'PRIVATE_VALUE'.repeat(1000)})); };
  const worker = createIsolatedWorker('mrz', 1, {langPath: '/synthetic/private-model', logger: () => {}, errorHandler: () => {}}, {forkImpl: () => child});
  assert.deepEqual(Object.keys(initialization).sort(), ['directory', 'lang', 'oem', 'type']);
  child.emit('message', {type: 'ready'});
  await assert.rejects(worker.recognize(Buffer.alloc(100)), error => error.code === 'MRZ_OPTICAL_READ_FAILED' && !JSON.stringify(error).includes('PRIVATE'));
  await worker.terminate();
});

test('the 30-second deadline returns while initialization is pending and cleans up a late fulfilled worker before releasing its lease', async () => {
  const creation = deferred(), entered = deferred(); let deadlineCallback, terminated = 0;
  const adapter = createOpticalMrz({verifyModelImpl: () => true, createWorkerImpl: () => { entered.resolve(); return creation.promise; }, setTimerImpl: (callback, milliseconds) => { assert.equal(milliseconds, TIMEOUT_MS); deadlineCallback = callback; return {}; }, clearTimerImpl: () => {}});
  const bytes = await image(), pending = adapter.extract({bytes, mimeType: 'image/png', guard: () => true});
  await entered.promise; deadlineCallback();
  await assert.rejects(pending, {code: 'MRZ_OPTICAL_TIMEOUT'});
  assert.equal(adapter.status().busy, true, 'an unresolved worker initialization must not permit a second worker');
  creation.resolve({terminate: async () => { terminated++; }});
  await turn(); await turn();
  assert.equal(terminated, 1); assert.equal(adapter.ready(), true);
});

test('hung recognition times out, terminates and clears its crop; provider and model messages stay private', async () => {
  const entered = deferred(); let deadlineCallback;
  const f = fixture({recognize: () => { entered.resolve(); return new Promise(() => {}); }, setTimerImpl: callback => { deadlineCallback = callback; return {}; }, clearTimerImpl: () => {}});
  const bytes = await image(), pending = f.adapter.extract({bytes, mimeType: 'image/png', guard: () => true});
  await entered.promise; deadlineCallback();
  await assert.rejects(pending, {code: 'MRZ_OPTICAL_TIMEOUT'}); await turn();
  assert.equal(f.calls.terminated, 1); assert.equal(f.calls.recognized[0].bytes.every(value => value === 0), true); assert.equal(f.adapter.ready(), true);
  const bad = fixture({recognize: () => { throw Error('PRIVATE_OCR_TEXT_OR_PATH'); }});
  await assert.rejects(bad.adapter.extract({bytes, mimeType: 'image/png', guard: () => true}), error => error.code === 'MRZ_OPTICAL_READ_FAILED' && !error.message.includes('PRIVATE') && !JSON.stringify(error).includes('PRIVATE'));
  assert.equal(bad.calls.terminated, 1); assert.equal(Object.isFrozen(MRZ_OPTICAL_ERROR_CODES), true);
});
