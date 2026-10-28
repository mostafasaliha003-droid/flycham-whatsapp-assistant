'use strict';
const {createHash} = require('node:crypto');
const {visaCaseSignature} = require('./visa-case-signature');
const {createVisaDocumentPreview} = require('./visa-document-preview');

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KINDS = new Set(['passport', 'residence', 'photo']);
const CAPTIONS = Object.freeze({passport: 'نسخة جواز السفر المجهزة من مرفقاتك.', residence: 'نسخة الهوية الإماراتية المجهزة من مرفقاتك.', photo: 'الصورة الشخصية المجهزة من مرفقاتك.'});
const TTL = 30 * 86400000, MAX_ITEMS = 2000;
const copy = value => structuredClone(value);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value === undefined ? null : value; }
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
const stale = () => Object.assign(Error('PREPARED_IMAGE_SUPERSEDED'), {notDispatched: true});
const sourceImage = value => value && !value.purpose && (value.type === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType) || value.type === 'document' && value.mimeType === 'application/pdf');

// Delivery only: these images confer no financial approval, application consent,
// document authenticity or government eligibility. Every request comes from a
// real, current customer message; a durable uncertain attempt is never replayed.
function createVisaPreparedDelivery({store, mediaStore, documentIntake, inbox, journal = inbox?.journal, send, now = Date.now} = {}) {
  if (!store?.data || typeof store.save !== 'function' || typeof mediaStore?.read !== 'function' || typeof documentIntake?.summary !== 'function' || typeof send !== 'function') throw Error('PREPARED_DELIVERY_CONFIG_INVALID');
  store.data.visaPreparedDeliveries ||= {items: {}};
  if (!store.data.visaPreparedDeliveries.items || typeof store.data.visaPreparedDeliveries.items !== 'object' || Array.isArray(store.data.visaPreparedDeliveries.items)) throw Error('PREPARED_DELIVERY_STATE_INVALID');
  const data = () => store.data.visaPreparedDeliveries;
  const preview = createVisaDocumentPreview({store, mediaStore, documentIntake, inbox, now});
  const locks = new Map();
  function commit(change) { const previous = copy(data()); try { const result = change(); store.save(); return copy(result); } catch { store.data.visaPreparedDeliveries = previous; throw Error('PREPARED_DELIVERY_STATE_FAILED'); } }
  function prune() { const expired = Object.entries(data().items).filter(([, item]) => !item || !Number.isFinite(item.expiresAt) || item.expiresAt <= now()).map(([key]) => key); if (expired.length) commit(() => { for (const key of expired) delete data().items[key]; }); }
  prune();
  if (Object.values(data().items).some(item => item.state === 'sending')) commit(() => { for (const item of Object.values(data().items)) if (item.state === 'sending') { item.state = 'uncertain'; item.updatedAt = now(); } });
  function blocked(customer) {
    try {
      if (typeof inbox?.isHumanOwned !== 'function' || inbox.isHumanOwned(customer) || inbox.isBlocked?.(customer)) return true;
      const current = store.data.conversationJournal?.customers?.[customer], c = store.data.visaCases?.[customer];
      return Boolean(!c || current?.operatorOwned || current?.blocked || current?.whatsappBlocked || ['pending', 'uncertain'].includes(current?.whatsappBlockState) || c.pendingAmendment && !['applied', 'cancelled', 'rejected', 'resolved'].includes(c.pendingAmendment.state));
    } catch { return true; }
  }
  function inbound(customer, requestId) {
    let c, summary; try { c = journal?.get?.(customer); summary = journal?.summary?.(customer); } catch { return false; }
    c ||= store.data.conversationJournal?.customers?.[customer];
    const last = Array.isArray(c?.messages) ? c.messages.filter(item => item?.direction === 'in').at(-1) : null;
    const at = c?.lastInboundAt;
    return messageId(requestId) && last?.id === requestId && last.actor === 'customer' && last.source !== 'legacy' && Number.isFinite(last.at) && last.at >= now() - 86400000 && last.at <= now() && Number.isFinite(at) && at <= now() && now() - at < 86400000 && summary?.serviceWindowOpen === true;
  }
  function readChecked(customer, id, expected) {
    let file;
    try {
      file = mediaStore.read(id, {customer});
      if (!file || file.metadata?.id !== id || file.metadata.customer !== customer || !Buffer.isBuffer(file.bytes) || hash(file.bytes) !== expected) throw stale();
      return {mimeType: file.metadata.mimeType, size: file.bytes.length};
    } finally { file?.bytes?.fill?.(0); }
  }
  function snapshot(customer, kind) {
    const c = store.data.visaCases?.[customer], raw = store.data.visaDocumentIntake?.cases?.[customer];
    let summary; try { summary = documentIntake.summary(customer); } catch { return null; }
    const signature = visaCaseSignature(c);
    if (!c || !raw || summary?.enabled !== true || !['ready', 'needs_confirmation', 'needs_review'].includes(raw.status) || summary.status !== raw.status || raw.caseId !== c.id || summary.caseId !== c.id || raw.caseSignature !== signature || summary.caseSignature !== signature || !Number.isSafeInteger(raw.generation) || raw.generation < 1 || summary.generation !== raw.generation || !SHA.test(raw.resultFingerprint || '') || summary.resultFingerprint !== raw.resultFingerprint || documentIntake.policyFingerprint && raw.policy !== documentIntake.policyFingerprint) return null;
    const applicants = raw.applicants;
    if (!Array.isArray(applicants) || applicants.length !== 1 || c.applicantCount !== 1) return null;
    const app = applicants[0];
    if (!app || app.identityReady !== true || !['ready', 'needs_confirmation'].includes(app.status) || !UUID.test(app.id || '') || !app.documents || !UUID.test(app.documents[kind] || '') || !Array.isArray(app.preparedManifest) || !Array.isArray(app.sourceManifest)) return null;
    const candidates = app.preparedManifest.filter(item => item?.kind === kind && item.mediaId === app.documents[kind]);
    if (candidates.length !== 1 || !SHA.test(candidates[0].sha256 || '')) return null;
    const manifest = candidates[0], rawMedia = mediaStore.records || store.data.visaMedia || {}, prepared = rawMedia[manifest.mediaId];
    if (!prepared || prepared.customer !== customer || prepared.purpose !== 'raad_portal_upload' || prepared.kind !== kind || !['image/png', 'image/jpeg'].includes(prepared.mimeType) || prepared.checksum !== manifest.sha256 || !Number.isFinite(prepared.expiresAt) || prepared.expiresAt <= now() || !Array.isArray(prepared.sourceIds) || prepared.sourceIds.length < 1 || prepared.sourceIds.length > 2 || new Set(prepared.sourceIds).size !== prepared.sourceIds.length) return null;
    const jobs = Object.values(store.data.visaDocumentIntake?.jobs || {}).filter(job => job.customer === customer && job.caseId === c.id && job.caseSignature === signature && job.generation === raw.generation && job.status !== 'stale');
    if (jobs.some(job => !['ready', 'failed'].includes(job.status))) return null;
    const manifestSources = new Map();
    for (const source of app.sourceManifest) {
      if (!source || !UUID.test(source.mediaId || '') || !SHA.test(source.sha256 || '') || manifestSources.has(source.mediaId)) return null;
      manifestSources.set(source.mediaId, source.sha256);
    }
    const sources = [];
    for (const id of prepared.sourceIds) {
      const source = rawMedia[id], expected = manifestSources.get(id);
      if (!sourceImage(source) || source.id !== id || source.customer !== customer || !expected || expected !== source.checksum || !Number.isFinite(source.expiresAt) || source.expiresAt <= now() || !Number.isFinite(source.receivedAt) || source.receivedAt < c.createdAt || !jobs.some(job => job.mediaId === id && job.status === 'ready' && job.sourceSha256 === expected)) return null;
      const observed = readChecked(customer, id, expected);
      sources.push({id, sha256: expected, mimeType: observed.mimeType, size: observed.size, expiresAt: source.expiresAt});
    }
    // New originals not yet reconciled invalidate a stale prepared selection.
    for (const source of Object.values(rawMedia)) {
      if (source.customer !== customer || !sourceImage(source) || source.receivedAt < c.createdAt || source.expiresAt <= now() || documentIntake.knownReceipt?.(customer, source.id)) continue;
      if (!jobs.some(job => job.mediaId === source.id && ['ready', 'failed'].includes(job.status) && (!job.sourceSha256 || job.sourceSha256 === source.checksum))) return null;
    }
    const observed = readChecked(customer, manifest.mediaId, manifest.sha256);
    if (!['image/jpeg', 'image/png'].includes(observed.mimeType) || observed.size < 1 || observed.size > 1000000) return null;
    const binding = {caseId: c.id, caseSignature: signature, generation: raw.generation, resultFingerprint: raw.resultFingerprint, policy: raw.policy || null, evidenceId: app.id, kind, mediaId: manifest.mediaId, sha256: manifest.sha256, sources};
    return {binding, fingerprint: digest(binding), expiresAt: Math.min(now() + TTL, prepared.expiresAt, ...sources.map(source => source.expiresAt)), payload: {type: 'image', purpose: 'raad_portal_upload', kind, mediaId: manifest.mediaId, mimeType: observed.mimeType, caption: CAPTIONS[kind]}};
  }
  function priorResult(item) {
    if (item.state === 'accepted') return {accepted: true, messageId: item.messageId, duplicate: true, ...(item.preview ? {preview: true, combined: item.combined} : {})};
    return {accepted: false, reason: item.state === 'uncertain' || item.state === 'sending' ? 'delivery_uncertain' : 'paused'};
  }
  async function perform(customer, {kind, requestId, intent}, key) {
    prune();
    const prior = data().items[key];
    if (prior) {
      if (prior.state === 'accepted' && (blocked(customer) || !inbound(customer, requestId) || store.data.visaCases?.[customer]?.id !== prior.binding.caseId || visaCaseSignature(store.data.visaCases?.[customer]) !== prior.binding.caseSignature)) return {accepted: false, reason: 'paused'};
      return priorResult(prior);
    }
    if (blocked(customer) || !inbound(customer, requestId)) return {accepted: false, reason: 'paused'};
    const c = store.data.visaCases?.[customer], raw = store.data.visaDocumentIntake?.cases?.[customer];
    if (c?.applicantCount > 1 || raw?.applicants?.length > 1) return {accepted: false, reason: 'multiple_applicants'};
    let snap; try { snap = snapshot(customer, kind); } catch {}
    if (!snap && ['merge', 'enhance', 'send_prepared'].includes(intent)) {
      try {
        const expectedCase = c?.id;
        snap = await preview.prepare(customer, {kind, requestId, guard: () => { if (blocked(customer) || !inbound(customer, requestId) || store.data.visaCases?.[customer]?.id !== expectedCase) throw stale(); }});
      } catch (error) { return {accepted: false, reason: error?.code === 'DOCUMENT_PREVIEW_BUSY' ? 'still_processing' : raw?.status === 'processing' ? 'still_processing' : 'not_ready'}; }
    }
    if (!snap) return {accepted: false, reason: raw?.status === 'processing' ? 'still_processing' : 'not_ready'};
    if (Object.keys(data().items).length >= MAX_ITEMS) return {accepted: false, reason: 'paused'};
    const isPreview = snap.payload.purpose === 'visa_client_preview';
    commit(() => { data().items[key] = {key, customer, kind, binding: snap.binding, fingerprint: snap.fingerprint, requestHash: digest(requestId), state: 'sending', ...(isPreview ? {preview: true, combined: snap.combined === true} : {}), createdAt: now(), updatedAt: now(), expiresAt: snap.expiresAt}; });
    const guard = () => {
      const current = data().items[key];
      if (!current || current.state !== 'sending' || current.expiresAt <= now() || blocked(customer) || !inbound(customer, requestId)) throw stale();
      if (isPreview) { if (!preview.current(snap)) throw stale(); }
      else { const latest = snapshot(customer, kind); if (!latest || latest.fingerprint !== snap.fingerprint) throw stale(); }
      return true;
    };
    try {
      guard();
      const result = await send(customer, copy(snap.payload), guard, {kind: 'prepared_image', customer, caseId: snap.binding.caseId, requestId});
      const id = result?.messages?.[0]?.id || result?.messageId;
      if (result?.paused === true || result?.dryRun === true || result?.notDispatched === true) { commit(() => { const item = data().items[key]; if (item) { item.state = 'paused'; item.updatedAt = now(); } }); return {accepted: false, reason: 'paused'}; }
      if (!messageId(id)) throw Error('PREPARED_IMAGE_ACCEPTANCE_UNKNOWN');
      // Accepted is not a delivery claim. Preserve it even if a new inbound or
      // operator takes over while the provider response is in flight.
      let current = true; try { guard(); } catch { current = false; }
      commit(() => { const item = data().items[key]; if (!item) throw stale(); item.state = 'accepted'; item.messageId = id; item.updatedAt = now(); if (!current) item.supersededAfterDispatch = true; });
      return {accepted: true, messageId: id, ...(isPreview ? {preview: true, combined: snap.combined === true} : {})};
    } catch (failure) {
      const item = data().items[key];
      if (item) { item.state = failure?.notDispatched === true ? 'cancelled' : 'uncertain'; item.updatedAt = now(); try { store.save(); } catch {} }
      return {accepted: false, reason: failure?.notDispatched === true ? 'paused' : 'delivery_uncertain'};
    }
  }
  function sendPrepared(customer, {kind, requestId, intent} = {}) {
    if (!KINDS.has(kind)) return Promise.resolve({accepted: false, reason: 'kind_required'});
    if (typeof customer !== 'string' || !/^[1-9]\d{7,14}$/.test(customer) || !messageId(requestId)) return Promise.resolve({accepted: false, reason: 'paused'});
    const key = digest({customer, requestId, kind});
    if (locks.has(key)) return locks.get(key);
    const work = perform(customer, {kind, requestId, intent}, key);
    locks.set(key, work); work.finally(() => { if (locks.get(key) === work) locks.delete(key); }).catch(() => {}); return work;
  }
  return {sendPrepared, prune() { prune(); preview.prune(); }};
}
module.exports = {createVisaPreparedDelivery};
