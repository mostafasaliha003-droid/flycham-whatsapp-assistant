'use strict';
const {createHash} = require('node:crypto');
const {visaCaseSignature} = require('./visa-case-signature');
const {validateDocumentExtraction} = require('./visa-document-vision');
const {prepareDocumentImage, preparePortalImage} = require('./raad-attachments');
const sharedLock = require('./raad-preparation-lock');
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_ITEMS = 1000, TTL = 30 * 86400000;
const ROLE_KINDS = Object.freeze({passport: ['passport'], residence: ['uae_id_front', 'uae_id_back'], photo: ['portrait']});
const CAPTIONS = Object.freeze({passport: 'نسخة جواز السفر للمعاينة فقط؛ لم تُعتمد بياناتها للتقديم.', residence: 'نسخة الهوية الإماراتية للمعاينة فقط؛ لم تُعتمد بياناتها للتقديم.', photo: 'الصورة الشخصية للمعاينة فقط؛ لم تُعتمد للتقديم.'});
const copy = value => structuredClone(value);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value === undefined ? null : value; }
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(Error(code), {code, notDispatched: true});
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
function visible(extraction, field) { const item = extraction.fields[field]; return item?.visible === true && typeof item.value === 'string' && item.value.trim() ? item.value.trim() : null; }
function name(extraction) { return visible(extraction, 'latinFullName') || [visible(extraction, 'latinFirstName'), visible(extraction, 'latinFamilyName')].every(Boolean) && [visible(extraction, 'latinFirstName'), visible(extraction, 'latinFamilyName')].join(' ') || visible(extraction, 'arabicFullName') || null; }
function normal(value) { return value?.normalize('NFKC').toUpperCase().replace(/[\s\-<>.,]+/gu, ' ').trim() || null; }
function contradictory(documents) {
  for (let i = 0; i < documents.length; i++) for (let j = i + 1; j < documents.length; j++) {
    const a = documents[i].extraction, b = documents[j].extraction;
    for (const field of ['passportNumber', 'emiratesId']) { const left = visible(a, field), right = visible(b, field); if (left && right && normal(left) !== normal(right)) return true; }
    const an = name(a), bn = name(b), ad = visible(a, 'birthDate'), bd = visible(b, 'birthDate');
    if (an && bn && ad && bd && (normal(an) !== normal(bn) || ad !== bd)) return true;
  }
  return false;
}

// An explicitly requested image utility, separate from machine facts. A partial
// supported page may be joined for visual preview even without an identity
// anchor. These derivatives never have the government-upload purpose.
function createVisaDocumentPreview({store, mediaStore, documentIntake, inbox, now = Date.now, lock = sharedLock, prepareDocument = prepareDocumentImage, preparePortrait = preparePortalImage} = {}) {
  if (!store?.data || typeof store.save !== 'function' || typeof mediaStore?.read !== 'function') throw Error('DOCUMENT_PREVIEW_CONFIG_INVALID');
  store.data.visaDocumentPreviews ||= {items: {}};
  const data = () => store.data.visaDocumentPreviews;
  if (!data().items || typeof data().items !== 'object' || Array.isArray(data().items)) throw Error('DOCUMENT_PREVIEW_STATE_INVALID');
  function commit(change) { const old = copy(data()); try { const value = change(); store.save(); return copy(value); } catch { store.data.visaDocumentPreviews = old; throw fail('DOCUMENT_PREVIEW_STATE_FAILED'); } }
  function prune() { const keys = Object.keys(data().items).filter(key => !Number.isFinite(data().items[key]?.expiresAt) || data().items[key].expiresAt <= now()); if (keys.length) commit(() => { for (const key of keys) delete data().items[key]; }); }
  prune();
  function sourceRead(customer, id, expected) { let file; try { file = mediaStore.read(id, {customer}); if (file?.metadata?.id !== id || file.metadata.customer !== customer || !Buffer.isBuffer(file.bytes) || hash(file.bytes) !== expected) throw fail('DOCUMENT_PREVIEW_STALE'); } finally { file?.bytes?.fill?.(0); } }
  function basis(customer, kind) {
    if (!Object.hasOwn(ROLE_KINDS, kind) || !documentIntake || typeof documentIntake.loadReference !== 'function' || typeof documentIntake.currentCaseGuard !== 'function' || typeof documentIntake.rotateImage !== 'function' || documentIntake.stopped || documentIntake.enabled?.() !== true || typeof inbox?.isHumanOwned !== 'function' || inbox.isHumanOwned(customer) || inbox.isBlocked?.(customer)) throw fail('DOCUMENT_PREVIEW_PAUSED');
    const c = store.data.visaCases?.[customer], raw = store.data.visaDocumentIntake?.cases?.[customer];
    if (!c || c.applicantCount !== 1 || !raw || raw.caseId !== c.id || raw.caseSignature !== visaCaseSignature(c) || raw.policy !== documentIntake.policyFingerprint || !Number.isSafeInteger(raw.generation) || raw.generation < 1 || !['ready', 'needs_confirmation', 'needs_review'].includes(raw.status) || !SHA.test(raw.inputFingerprint || '') || !SHA.test(raw.resultFingerprint || '') || raw.limitExceeded || !Array.isArray(raw.documents) || raw.documents.length > 100) throw fail('DOCUMENT_PREVIEW_NOT_READY');
    if (c.pendingAmendment && !['applied', 'cancelled', 'rejected', 'resolved'].includes(c.pendingAmendment.state)) throw fail('DOCUMENT_PREVIEW_PAUSED');
    documentIntake.currentCaseGuard(customer, c.id, raw.caseSignature, raw.generation, documentIntake.epoch);
    const jobs = Object.values(store.data.visaDocumentIntake.jobs || {}).filter(job => job.customer === customer && job.caseId === c.id && job.status !== 'stale');
    if (!jobs.length || jobs.some(job => job.policy !== raw.policy || job.caseSignature !== raw.caseSignature || job.generation !== raw.generation || !['ready', 'failed'].includes(job.status))) throw fail('DOCUMENT_PREVIEW_NOT_READY');
    const sources = [];
    for (const source of Object.values(mediaStore.records || store.data.visaMedia || {})) {
      if (source.customer !== customer || source.purpose || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(source.mimeType) || source.expiresAt <= now() || source.receivedAt < c.createdAt || documentIntake.knownReceipt?.(customer, source.id)) continue;
      if (!UUID.test(source.id || '') || !SHA.test(source.checksum || '') || !Number.isFinite(source.receivedAt) || !Number.isFinite(source.expiresAt) || !jobs.some(job => job.mediaId === source.id && job.sourceSha256 === source.checksum)) throw fail('DOCUMENT_PREVIEW_NOT_READY');
      sources.push({mediaId: source.id, sha256: source.checksum, expiresAt: source.expiresAt});
    }
    if (!sources.length || sources.length > 20) throw fail('DOCUMENT_PREVIEW_NOT_READY');
    let pages = [];
    for (const page of raw.documents) {
      if (!UUID.test(page?.mediaId || '') || !SHA.test(page.sha256 || '') || !SHA.test(page.sourceSha256 || '') || !Number.isInteger(page.page) || page.page < 1 || page.page > 10) throw fail('DOCUMENT_PREVIEW_STALE');
      let extraction; try { extraction = validateDocumentExtraction(page.extraction); } catch { throw fail('DOCUMENT_PREVIEW_STALE'); }
      const job = jobs.find(item => item.mediaId === page.mediaId && item.status === 'ready' && item.sourceSha256 === page.sourceSha256 && item.pages?.[page.page]?.sha256 === page.sha256 && digest(item.pages[page.page].extraction) === digest(page.extraction));
      if (!job || !sources.some(source => source.mediaId === page.mediaId && source.sha256 === page.sourceSha256)) throw fail('DOCUMENT_PREVIEW_STALE');
      if (extraction.readable && ROLE_KINDS[kind].includes(extraction.kind)) pages.push({mediaId: page.mediaId, page: page.page, sha256: page.sha256, sourceSha256: page.sourceSha256, extraction});
    }
    // No arrival-order choice among extra people/pages. Exact pixel duplicates
    // are interchangeable, and front/back ordering is deterministic.
    if (contradictory(pages)) throw fail('DOCUMENT_PREVIEW_CONFLICT');
    pages.sort((a, b) => ROLE_KINDS[kind].indexOf(a.extraction.kind) - ROLE_KINDS[kind].indexOf(b.extraction.kind) || a.mediaId.localeCompare(b.mediaId) || a.page - b.page);
    const seen = new Set(); pages = pages.filter(page => { if (seen.has(page.sha256)) return false; seen.add(page.sha256); return true; });
    if (!pages.length || pages.length > (kind === 'photo' ? 1 : 2)) throw fail('DOCUMENT_PREVIEW_AMBIGUOUS');
    for (const source of sources.filter(source => pages.some(page => page.mediaId === source.mediaId))) sourceRead(customer, source.mediaId, source.sha256);
    sources.sort((a, b) => a.mediaId.localeCompare(b.mediaId));
    const binding = {caseId: c.id, caseSignature: raw.caseSignature, generation: raw.generation, policy: raw.policy, inputFingerprint: raw.inputFingerprint, resultFingerprint: raw.resultFingerprint, documentsDigest: digest(raw.documents), kind, sources, pages: pages.map(page => ({mediaId: page.mediaId, page: page.page, sha256: page.sha256, sourceSha256: page.sourceSha256, extractionDigest: digest(page.extraction)}))};
    return {binding, fingerprint: digest(binding), pages, expiresAt: Math.min(now() + TTL, ...sources.map(source => source.expiresAt))};
  }
  function current(snapshot) {
    try {
      const record = data().items[snapshot?.binding?.previewKey];
      if (!record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now() || record.fingerprint !== snapshot.fingerprint || record.fingerprint !== digest(record.binding) || digest(snapshot.binding) !== record.fingerprint || digest(snapshot.payload) !== digest(record.payload) || record.customer !== snapshot.customer) return false;
      const latest = basis(record.customer, record.binding.kind);
      if (latest.fingerprint !== record.basisFingerprint) return false;
      const image = (mediaStore.records || store.data.visaMedia || {})[record.binding.mediaId];
      if (!image || image.id !== record.binding.mediaId || image.customer !== record.customer || image.purpose !== 'visa_client_preview' || image.kind !== record.binding.kind || image.checksum !== record.binding.sha256 || image.mimeType !== record.payload.mimeType || !['image/png', 'image/jpeg'].includes(image.mimeType) || !Number.isFinite(image.expiresAt) || image.expiresAt <= now() || !Array.isArray(image.sourceIds) || image.sourceIds.length < 1 || image.sourceIds.length > 2 || new Set(image.sourceIds).size !== image.sourceIds.length || digest([...image.sourceIds].sort()) !== digest([...new Set(latest.pages.map(page => page.mediaId))].sort())) return false;
      sourceRead(record.customer, image.id, image.checksum);
      return true;
    } catch { return false; }
  }
  async function prepare(customer, {kind, requestId, guard} = {}) {
    if (!messageId(requestId) || typeof guard !== 'function') throw fail('DOCUMENT_PREVIEW_PAUSED');
    prune(); guard(); const start = basis(customer, kind);
    const key = digest({customer, kind, requestHash: digest(requestId), basis: start.fingerprint});
    const old = data().items[key];
    if (old && current({...old, customer})) return copy({...old, customer});
    if (Object.keys(data().items).length >= MAX_ITEMS) throw fail('DOCUMENT_PREVIEW_CAPACITY');
    if (!lock?.tryAcquire?.()) throw fail('DOCUMENT_PREVIEW_BUSY');
    const images = []; let prepared;
    const check = () => { guard(); if (basis(customer, kind).fingerprint !== start.fingerprint) throw fail('DOCUMENT_PREVIEW_STALE'); return true; };
    try {
      check();
      for (const page of start.pages) { const image = await documentIntake.loadReference(customer, page, check); images.push({image, corrected: null}); check(); images.at(-1).corrected = await documentIntake.rotateImage(image); check(); }
      if (kind === 'photo') prepared = await preparePortrait(images[0].corrected.bytes, {mimeType: images[0].corrected.mimeType, kind: 'portrait'});
      else prepared = await prepareDocument(images.map(item => ({bytes: item.corrected.bytes, mimeType: item.corrected.mimeType})), {kind, enhance: true});
      check();
      if (!Buffer.isBuffer(prepared?.bytes) || !prepared.bytes.length || prepared.bytes.length > 1000000 || !['image/jpeg', 'image/png'].includes(prepared.mimeType)) throw fail('DOCUMENT_PREVIEW_INVALID');
      const sourceIds = [...new Set(start.pages.map(page => page.mediaId))];
      const saved = mediaStore.storeDerived(customer, {sourceIds, kind, purpose: 'visa_client_preview', bytes: prepared.bytes, mimeType: prepared.mimeType}); check();
      if (!UUID.test(saved?.id || '')) throw fail('DOCUMENT_PREVIEW_INVALID');
      const raw = (mediaStore.records || store.data.visaMedia || {})[saved.id], checksum = hash(prepared.bytes);
      if (!raw || raw.purpose !== 'visa_client_preview' || raw.customer !== customer || raw.kind !== kind || raw.checksum !== checksum) throw fail('DOCUMENT_PREVIEW_INVALID');
      sourceRead(customer, saved.id, checksum);
      const binding = {...start.binding, purpose: 'visa_client_preview', previewKey: key, mediaId: saved.id, sha256: checksum, requestHash: digest(requestId)};
      const snapshot = {customer, binding, basisFingerprint: start.fingerprint, fingerprint: digest(binding), expiresAt: Math.min(start.expiresAt, raw.expiresAt), combined: start.pages.length > 1, payload: {type: 'image', purpose: 'visa_client_preview', kind, mediaId: saved.id, mimeType: prepared.mimeType, caption: CAPTIONS[kind]}};
      commit(() => { check(); data().items[key] = snapshot; return snapshot; });
      if (!current(snapshot)) throw fail('DOCUMENT_PREVIEW_STALE');
      return copy(snapshot);
    } finally { prepared?.bytes?.fill?.(0); for (const part of images) { if (part.corrected?.bytes !== part.image.bytes) part.corrected?.bytes?.fill?.(0); part.image.bytes?.fill?.(0); } lock.release(); }
  }
  return {prepare, current, prune};
}
module.exports = {createVisaDocumentPreview};
