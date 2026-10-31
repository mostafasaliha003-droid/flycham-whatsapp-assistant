'use strict';

// Selecting a profile never provisions a budget, upgrades historical jobs, or
// sends a request. Only an explicit start may open the existing ledger.
const path = require('node:path');
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {persistentMount} = require('./state-storage');
const {visaCaseSignature} = require('./visa-case-signature');
const {validCustomer} = require('./conversation-journal');
const {createProductionOpenAiMrz, MRZ_PRODUCTION_POLICY_FINGERPRINT, INPUT_POLICY} = require('./visa-mrz-production');
const SHA = /^[a-f0-9]{64}$/;
const BINDING_KEYS = Object.freeze(['version', 'provider', 'readerFingerprint', 'inputPolicy',
  'consentId', 'consentDigest', 'customerDigest', 'caseIdDigest', 'caseSignature', 'sourceDigest', 'sourceSha256']);
const DESCRIPTION = 'أوافق على إرسال منطقة القراءة الآلية فقط من هذا المستند إلى OpenAI لنسخ أحرفها حرفيًا دون تخمين أو تصحيح، ولا تشمل الموافقة مرفقات سابقة أو لاحقة.';
const failure = code => Object.assign(Error(code), {code, retryable: false});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validHash = value => typeof value === 'string' && SHA.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const sourceDigest = source => digest({id: source.id, checksum: source.checksum,
  type: source.type, mimeType: source.mimeType});

function validBinding(binding) {
  return plain(binding) && Object.keys(binding).length === BINDING_KEYS.length
    && BINDING_KEYS.every(key => Object.hasOwn(binding, key)) && binding.version === 1
    && binding.provider === 'openai' && binding.readerFingerprint === MRZ_PRODUCTION_POLICY_FINGERPRINT
    && binding.inputPolicy === INPUT_POLICY && text(binding.consentId)
    && ['consentDigest', 'customerDigest', 'caseIdDigest', 'caseSignature', 'sourceDigest', 'sourceSha256'].every(key => validHash(binding[key]));
}
function decimalCap(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(micros) / 1000000;
}

function createMrzProfiles({env = process.env, store, localReader, consents, fetchImpl = globalThis.fetch,
  now = Date.now, createBudget, persistentMountImpl = persistentMount, getCase, getSource,
  setTimerImpl, clearTimerImpl} = {}) {
  // Do not inspect storage, keys, consent history, files or provider state here.
  let budget = null, reader = null, started = false, starting = null, closing = false,
    openedFile = null, openedCap = null, openedKeyDigest = null, draining = false, drainPromise = null;
  const enabled = () => env.RAAD_MRZ_PROVIDER === 'openai' && env.RAAD_MRZ_PRODUCTION_ENABLED === 'true';
  const currentCase = customer => getCase ? getCase(customer) : store?.data?.visaCases?.[customer];
  const currentSource = (id, customer) => getSource ? getSource(id, {customer}) : store?.data?.visaMedia?.[id];
  function configuration() {
    if (!enabled() || consents?.healthy !== true || typeof consents.verify !== 'function'
        || env.RAAD_MRZ_PRODUCTION_POLICY_SHA256 !== MRZ_PRODUCTION_POLICY_FINGERPRINT
        || typeof env.OPENAI_API_KEY !== 'string' || !env.OPENAI_API_KEY.length || env.OPENAI_API_KEY.length > 1024
        || /[\r\n]/.test(env.OPENAI_API_KEY) || !Buffer.isBuffer(store?.key) || store.key.length !== 32
        || typeof store?.file !== 'string' || !path.isAbsolute(store.file)
        || typeof store?.status !== 'function' || store.status()?.durableStorageConfirmed !== true) return null;
    const capUsd = decimalCap(env.RAAD_MRZ_PRODUCTION_BUDGET_USD);
    if (capUsd === null) return null;
    const stateFile = path.resolve(store.file), directory = path.dirname(stateFile);
    const configuredFile = env.RAAD_MRZ_PRODUCTION_BUDGET_PATH;
    if (configuredFile !== undefined && (typeof configuredFile !== 'string' || !path.isAbsolute(configuredFile))) return null;
    const file = path.resolve(configuredFile || path.join(directory, 'visa-mrz-budget.enc'));
    if (file === stateFile || path.dirname(file) !== directory) return null;
    return {file, capUsd, keyDigest: hash(store.key)};
  }
  function configured() {
    try {
      const config = configuration();
      return started && !closing && config !== null && config.file === openedFile
        && config.capUsd === openedCap && config.keyDigest === openedKeyDigest
        && budget?.durable === true && budget.status().capUsd === openedCap
        && budget.status().policyFingerprint === MRZ_PRODUCTION_POLICY_FINGERPRINT;
    } catch { return false; }
  }
  function status() {
    const ready = configured();
    return Object.freeze({enabled: enabled(), configured: ready, started, provider: ready ? 'openai' : 'local',
      ready: ready && !draining && reader.ready(), busy: reader?.status().busy === true,
      readerFingerprint: MRZ_PRODUCTION_POLICY_FINGERPRINT, inputPolicy: INPUT_POLICY});
  }
  async function start() {
    if (!enabled()) return status();
    if (starting) return starting;
    if (started) { if (!configured()) throw failure('MRZ_PROFILE_NOT_CONFIGURED'); return status(); }
    if (closing || draining || budget !== null) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
    starting = (async () => {
      let candidate;
      try {
        const config = configuration();
        if (!config || persistentMountImpl(store.file) !== true || persistentMountImpl(config.file) !== true) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
        const factory = createBudget || require('./visa-mrz-durable-budget').createDurableMrzBudget;
        candidate = factory({file: config.file, key: store.key, policyFingerprint: MRZ_PRODUCTION_POLICY_FINGERPRINT,
          capUsd: config.capUsd, persistentStateConfirmed: true, now});
        await candidate.open();
        const liveConfig = configuration(), ledger = candidate.status();
        if (!liveConfig || liveConfig.file !== config.file || liveConfig.capUsd !== config.capUsd
            || liveConfig.keyDigest !== config.keyDigest || candidate.durable !== true
            || ledger.capUsd !== config.capUsd || ledger.policyFingerprint !== MRZ_PRODUCTION_POLICY_FINGERPRINT) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
        budget = candidate; openedFile = config.file; openedCap = config.capUsd; openedKeyDigest = config.keyDigest;
        reader = createProductionOpenAiMrz({env, budget, capUsd: openedCap, fetchImpl, now,
          admit: () => started && !closing && !draining,
          ...(setTimerImpl ? {setTimerImpl} : {}), ...(clearTimerImpl ? {clearTimerImpl} : {})});
        started = true;
        return status();
      } catch {
        // A stale consent snapshot must not regain access through an orderly
        // restart if its save became ambiguous while the ledger was opening.
        if (candidate && consents?.healthy !== true) budget = candidate;
        else { try { await candidate?.close(); } catch {} }
        throw failure('MRZ_PROFILE_NOT_CONFIGURED');
      }
    })();
    try { return await starting; } finally { starting = null; }
  }
  function assertContext({customer, caseId, caseSignature, source} = {}) {
    if (!validCustomer(customer) || !text(caseId) || !validHash(caseSignature)
        || !plain(source) || !text(source.id) || !validHash(source.checksum)
        || source.customer !== customer || source.purpose
        || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(source.mimeType)
        || !['image', 'document'].includes(source.type) || !Number.isFinite(source.expiresAt) || source.expiresAt <= now()) throw failure('MRZ_PROFILE_STALE');
    const liveCase = currentCase(customer), liveSource = currentSource(source.id, customer);
    if (!plain(liveCase) || liveCase.id !== caseId || visaCaseSignature(liveCase) !== caseSignature
        || !plain(liveSource) || liveSource.customer !== customer || liveSource.purpose
        || liveSource.id !== source.id || liveSource.checksum !== source.checksum
        || sourceDigest(liveSource) !== sourceDigest(source)
        || !Number.isFinite(liveSource.expiresAt) || liveSource.expiresAt <= now()) throw failure('MRZ_PROFILE_STALE');
    return {customerDigest: hash(customer), caseIdDigest: hash(caseId), caseSignature,
      sourceDigest: sourceDigest(source), sourceSha256: source.checksum};
  }
  function verifyConsent(ref, context) {
    try {
      if (!plain(ref) || Object.keys(ref).length !== 2 || !text(ref.consentId) || !validHash(ref.consentDigest)
          || typeof consents?.verify !== 'function' || consents.verify(ref, {...context,
            provider: 'openai', readerFingerprint: MRZ_PRODUCTION_POLICY_FINGERPRINT, inputPolicy: INPUT_POLICY,
            policySha256: MRZ_PRODUCTION_POLICY_FINGERPRINT}) !== true) throw Error();
    } catch { throw failure('MRZ_PROFILE_CONSENT_REQUIRED'); }
  }
  function bindNewJob({customer, caseId, caseSignature, source, mrzConsent} = {}) {
    if (mrzConsent === undefined || mrzConsent === null) return null;
    if (draining || !configured()) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
    const context = {customer, caseId, caseSignature, source};
    const identity = assertContext(context);
    verifyConsent(mrzConsent, context);
    return Object.freeze({version: 1, provider: 'openai', readerFingerprint: MRZ_PRODUCTION_POLICY_FINGERPRINT,
      inputPolicy: INPUT_POLICY, consentId: mrzConsent.consentId, consentDigest: mrzConsent.consentDigest, ...identity});
  }
  function resolve(binding) {
    if (binding === undefined || binding === null) return localReader;
    if (!validBinding(binding)) throw failure('MRZ_PROFILE_INVALID_BINDING');
    if (draining || !configured()) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
    return reader;
  }
  function guard(binding, context) {
    if (!validBinding(binding)) throw failure('MRZ_PROFILE_INVALID_BINDING');
    if (!configured()) throw failure('MRZ_PROFILE_NOT_CONFIGURED');
    const identity = assertContext(context);
    if (Object.keys(identity).some(key => binding[key] !== identity[key])) throw failure('MRZ_PROFILE_STALE');
    verifyConsent({consentId: binding.consentId, consentDigest: binding.consentDigest}, context);
    return true;
  }
  function uploadConsentOptions() {
    if (draining || !configured()) return null;
    return Object.freeze({available: true, provider: 'openai', readerFingerprint: MRZ_PRODUCTION_POLICY_FINGERPRINT,
      inputPolicy: INPUT_POLICY, policySha256: MRZ_PRODUCTION_POLICY_FINGERPRINT, description: DESCRIPTION});
  }
  async function close() {
    if (starting) await starting;
    if (reader?.status().busy === true) throw failure('DOCUMENT_VISION_BUSY');
    if (!budget) return;
    if (consents?.healthy !== true) throw failure('MRZ_PROFILE_CONSENT_UNCONFIRMED');
    closing = true;
    try { await budget.close(); started = false; budget = null; reader = null; }
    catch { throw failure('MRZ_PROFILE_CLOSE_UNCONFIRMED'); }
    finally { closing = false; }
  }
  function drainAndClose({timeoutMs = 25000, pollMs = 25} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
        || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) return Promise.reject(failure('MRZ_PROFILE_DRAIN_INVALID'));
    if (drainPromise) return drainPromise;
    if (!budget && !starting && !started) return Promise.resolve();
    // Admission stops before the first await. An existing owned request keeps
    // its guard/lease and must finish its underlying I/O and durable settlement.
    draining = true;
    const began = performance.now();
    drainPromise = (async () => {
      while (true) {
        if ((budget || starting) && consents?.healthy !== true) throw failure('MRZ_PROFILE_CONSENT_UNCONFIRMED');
        if (!starting && reader?.status().busy !== true) { await close(); return; }
        const remaining = timeoutMs - (performance.now() - began);
        if (remaining <= 0) throw failure('MRZ_PROFILE_DRAIN_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
      }
    })();
    drainPromise.then(() => { drainPromise = null; }, () => { drainPromise = null; });
    return drainPromise;
  }
  return Object.freeze({start, bindNewJob, resolve, guard, status, close, drainAndClose, uploadConsentOptions,
    consentOptions: () => uploadConsentOptions() || Object.freeze({available: false})});
}

module.exports = {createMrzProfiles, MRZ_PRODUCTION_POLICY_FINGERPRINT, INPUT_POLICY};
