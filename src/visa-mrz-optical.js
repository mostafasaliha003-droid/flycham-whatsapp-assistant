'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {fork} = require('node:child_process');
const sharp = require('sharp');
const {parseMrzOutput} = require('./visa-mrz-vision');
const {MODEL_SHA256, MODEL_BYTES, MODEL_DIRECTORY} = require('../scripts/install-mrz-model');

const MRZ_OPTICAL_POLICY = 'raad-local-td3-optical-2026-10-29.v1';
const TESSERACT_VERSION = '7.0.0';
const TIMEOUT_MS = 30000;
const MAX_INPUT_BYTES = 6 * 1024 * 1024;
const MAX_INPUT_PIXELS = 4000000;
const MRZ_OPTICAL_ERROR_CODES = Object.freeze(['MRZ_OPTICAL_MODEL_UNAVAILABLE', 'MRZ_OPTICAL_INVALID_IMAGE', 'MRZ_OPTICAL_ENGINE_UNAVAILABLE', 'MRZ_OPTICAL_TIMEOUT', 'MRZ_OPTICAL_READ_FAILED', 'MRZ_OPTICAL_DISAGREEMENT']);
const OPTICAL_POLICY_FINGERPRINT = createHash('sha256').update(JSON.stringify({policy: MRZ_OPTICAL_POLICY, modelSha256: MODEL_SHA256, modelBytes: MODEL_BYTES, tesseract: TESSERACT_VERSION, runtimeIsolation: 'owned-child-process-v1', oem: 1, psm: [6, 11], crop: {bottom: 0.30, sideMargin: 0.05, grayscale: true, resize: false}, validation: 'two-complete-lines-all-five-checks-no-repair-v1', inputBytes: MAX_INPUT_BYTES, inputPixels: MAX_INPUT_PIXELS, timeout: TIMEOUT_MS})).digest('hex');
// The lease includes initialization and termination, across all instances.
let activeLease = null;
const failure = code => Object.assign(Error(code), {code, retryable: false});

function verifyPinnedModel(directory) {
  let bytes;
  try {
    const filename = path.join(directory, 'mrz.traineddata'), info = fs.lstatSync(filename);
    if (!info.isFile() || info.size !== MODEL_BYTES) return false;
    bytes = fs.readFileSync(filename);
    return bytes.length === MODEL_BYTES && createHash('sha256').update(bytes).digest('hex') === MODEL_SHA256;
  } catch { return false; }
  finally { bytes?.fill(0); }
}

function createIsolatedWorker(lang, oem, options, {forkImpl = fork} = {}) {
  if (lang !== 'mrz' || oem !== 1 || typeof options?.langPath !== 'string' || !path.isAbsolute(options.langPath)) throw failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE');
  let child;
  try {
    child = forkImpl(path.join(__dirname, 'visa-mrz-optical-worker.js'), [], {execArgv: [], env: {NODE_ENV: 'production', LANG: 'C', TZ: 'UTC'}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced'});
  } catch { throw failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE'); }
  let initialized = false, closed = false, ending = false, failed = false, nextId = 0, resolveInit, rejectInit, resolveClose;
  const pending = new Map();
  const initialization = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
  initialization.catch(() => {});
  const closure = new Promise(resolve => { resolveClose = resolve; });
  const rejectAll = () => {
    failed = true;
    rejectInit(failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE'));
    for (const item of pending.values()) item.reject(failure('MRZ_OPTICAL_READ_FAILED'));
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', rejectAll);
  child.on('close', () => { closed = true; rejectAll(); resolveClose(); });
  child.on('message', message => {
    if (!message || typeof message !== 'object') return rejectAll();
    if (message.type === 'ready' && !ending && !failed) { initialized = true; resolveInit(); return; }
    if (message.type === 'init_failed') { rejectAll(); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.type !== 'result' || message.ok !== true) { item.reject(failure('MRZ_OPTICAL_READ_FAILED')); return; }
    if (item.operation === 'recognize') {
      if (typeof message.text !== 'string' || Buffer.byteLength(message.text, 'utf8') > 8192) { item.reject(failure('MRZ_OPTICAL_READ_FAILED')); return; }
      item.resolve({data: {text: message.text}});
    } else item.resolve();
  });
  const send = message => {
    try { child.send(message, error => { if (error) rejectAll(); }); }
    catch { rejectAll(); }
  };
  // The parent owns this child before any Tesseract/native-worker initialization.
  send({type: 'init', lang, oem, directory: options.langPath});
  const request = async (operation, payload) => {
    await initialization;
    if (closed || ending || failed || !initialized) throw failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE');
    const id = ++nextId;
    return new Promise((resolve, reject) => { pending.set(id, {resolve, reject, operation}); send({type: operation, id, ...payload}); });
  };
  return {
    setParameters: parameters => request('parameters', {parameters}),
    recognize: bytes => request('recognize', {bytes}),
    terminate: async () => {
      if (!ending) { ending = true; rejectAll(); if (!closed) { try { child.kill('SIGKILL'); } catch {} } }
      await closure;
    }
  };
}

function defaultCreateWorker(...args) {
  try { if (require('tesseract.js/package.json').version !== TESSERACT_VERSION) throw Error(); }
  catch { throw failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE'); }
  return createIsolatedWorker(...args);
}

function parseOpticalText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 8192) return null;
  // Blank line separators and boundary ASCII spacing are formatting only.
  // Interior spaces, missing fillers and every non-MRZ glyph remain invalid.
  const lines = text.split(/\r\n|\n|\r/).map(line => line.replace(/^[\x09\x20]+|[\x09\x20]+$/g, '')).filter(line => line !== '');
  if (lines.length !== 2 || lines.some(line => !/^[A-Z0-9<]{44}$/.test(line))) return null;
  try { return parseMrzOutput(JSON.stringify({version: 1, lines})); } catch { return null; }
}

function createOpticalMrz({createWorkerImpl = defaultCreateWorker, modelDirectory = MODEL_DIRECTORY, now = Date.now, verifyModelImpl = verifyPinnedModel, setTimerImpl = setTimeout, clearTimerImpl = clearTimeout} = {}) {
  const directory = path.resolve(modelDirectory);
  const configuredNow = () => { try { return verifyModelImpl(directory) === true; } catch { return false; } };
  let configured = configuredNow();
  const ready = () => configured && activeLease === null;
  const status = () => ({enabled: true, configured, ready: ready(), busy: activeLease !== null, local: true, policyFingerprint: OPTICAL_POLICY_FINGERPRINT});

  async function extract({bytes, mimeType, guard} = {}) {
    if (activeLease !== null) throw failure('DOCUMENT_VISION_BUSY');
    const lease = {}; activeLease = lease;
    let owned, tight, worker, creationSettled = true, terminationDone = true, terminationPromise, finished = false, timedOut = false, timer, result, error;
    const deadline = now() + TIMEOUT_MS;
    const timeout = new Promise((resolve, reject) => { timer = setTimerImpl(() => { timedOut = true; reject(failure('MRZ_OPTICAL_TIMEOUT')); }, TIMEOUT_MS); timer?.unref?.(); });
    timeout.catch(() => {});
    const release = () => { if (finished && creationSettled && terminationDone && activeLease === lease) activeLease = null; };
    const terminate = candidate => {
      if (terminationPromise) return terminationPromise;
      terminationDone = false;
      terminationPromise = Promise.resolve().then(() => candidate?.terminate?.()).then(() => { terminationDone = true; }, () => { throw failure('MRZ_OPTICAL_READ_FAILED'); }).finally(release);
      return terminationPromise;
    };
    const bounded = async promise => {
      if (timedOut || now() >= deadline) throw failure('MRZ_OPTICAL_TIMEOUT');
      const value = await Promise.race([Promise.resolve(promise), timeout]);
      if (timedOut || now() >= deadline) throw failure('MRZ_OPTICAL_TIMEOUT');
      return value;
    };
    const checkGuard = async () => {
      try { if (typeof guard !== 'function' || await guard() === false) throw Error(); }
      catch { throw failure('DOCUMENT_VISION_STALE'); }
    };
    try {
      await bounded(checkGuard());
      configured = configuredNow();
      if (!configured) throw failure('MRZ_OPTICAL_MODEL_UNAVAILABLE');
      if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_INPUT_BYTES || !['image/jpeg', 'image/png'].includes(mimeType)) throw failure('MRZ_OPTICAL_INVALID_IMAGE');
      owned = Buffer.from(bytes);
      let metadata;
      try {
        metadata = await bounded(sharp(owned, {limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning', sequentialRead: true}).metadata());
        if (metadata.format !== (mimeType === 'image/png' ? 'png' : 'jpeg') || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 20 || metadata.height < 20 || metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages || 1) !== 1) throw Error();
      } catch (cause) { if (cause?.code === 'MRZ_OPTICAL_TIMEOUT') throw cause; throw failure('MRZ_OPTICAL_INVALID_IMAGE'); }
      const left = Math.floor(metadata.width * 0.05), top = Math.floor(metadata.height * 0.70);
      const width = metadata.width - left * 2, height = metadata.height - top;
      const cropPromise = sharp(owned, {limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning', sequentialRead: true}).extract({left, top, width, height}).greyscale().png().toBuffer();
      cropPromise.then(buffer => { if (finished || timedOut) buffer.fill(0); }, () => {});
      try { tight = await bounded(cropPromise); } catch (cause) { if (cause?.code === 'MRZ_OPTICAL_TIMEOUT') throw cause; throw failure('MRZ_OPTICAL_INVALID_IMAGE'); }
      await bounded(checkGuard());
      creationSettled = false;
      const creation = Promise.resolve().then(() => createWorkerImpl('mrz', 1, {langPath: directory, cachePath: directory, cacheMethod: 'none', gzip: false, legacyCore: false, legacyLang: false, logger: () => {}, errorHandler: () => {}}));
      creation.then(candidate => { worker = candidate; creationSettled = true; if (finished || timedOut) terminate(candidate).catch(() => {}); release(); }, cause => {
        // A rejected library initialization may own an unexposed native thread.
        // Only our known pre-spawn dependency failure proves it is safe to retry.
        creationSettled = cause?.code === 'MRZ_OPTICAL_ENGINE_UNAVAILABLE'; release();
      });
      worker = await bounded(creation);
      if (!worker || typeof worker.setParameters !== 'function' || typeof worker.recognize !== 'function' || typeof worker.terminate !== 'function') throw failure('MRZ_OPTICAL_ENGINE_UNAVAILABLE');
      await bounded(checkGuard());
      const accepted = [];
      for (const mode of [6, 11]) {
        await bounded(worker.setParameters({tessedit_pageseg_mode: mode, tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', preserve_interword_spaces: '0', user_defined_dpi: '300'}));
        await bounded(checkGuard());
        const read = await bounded(worker.recognize(tight, {}, {text: true}));
        await bounded(checkGuard());
        const candidate = parseOpticalText(read?.data?.text);
        if (candidate) accepted.push(candidate);
      }
      if (!accepted.length) throw failure('MRZ_OPTICAL_READ_FAILED');
      if (accepted.length === 2 && JSON.stringify(accepted[0].mrzLines) !== JSON.stringify(accepted[1].mrzLines)) throw failure('MRZ_OPTICAL_DISAGREEMENT');
      result = accepted[0];
    } catch (cause) {
      error = ['DOCUMENT_VISION_BUSY', 'DOCUMENT_VISION_STALE', ...MRZ_OPTICAL_ERROR_CODES].includes(cause?.code) ? failure(cause.code) : failure('MRZ_OPTICAL_READ_FAILED');
    } finally {
      finished = true;
      owned?.fill(0); tight?.fill(0);
      if (worker) { try { await bounded(terminate(worker)); } catch (cause) { if (!error) error = failure(cause?.code === 'MRZ_OPTICAL_TIMEOUT' ? cause.code : 'MRZ_OPTICAL_READ_FAILED'); } }
      if (!error) { try { await bounded(checkGuard()); } catch (cause) { error = failure(cause?.code === 'MRZ_OPTICAL_TIMEOUT' ? cause.code : 'DOCUMENT_VISION_STALE'); } }
      clearTimerImpl(timer); release();
    }
    if (error) throw error;
    return result;
  }
  return {extract, ready, status, policyFingerprint: OPTICAL_POLICY_FINGERPRINT};
}

module.exports = {createOpticalMrz, createIsolatedWorker, verifyPinnedModel, OPTICAL_POLICY_FINGERPRINT, MRZ_OPTICAL_POLICY, MRZ_OPTICAL_ERROR_CODES, TESSERACT_VERSION, TIMEOUT_MS, MAX_INPUT_BYTES, MAX_INPUT_PIXELS};
