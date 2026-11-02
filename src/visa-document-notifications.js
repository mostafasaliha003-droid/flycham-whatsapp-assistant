'use strict';
const {QUESTION_CATALOG}=require('./visa-client-questions');
const {documentClientAnswers}=require('./visa-document-client-answers');
const {paymentReceiptFollowup}=require('./visa-payment-followup');
const {documentClarificationCopy,documentConfirmationCopy}=require('./visa-workflow-progress');

const {createHash} = require('node:crypto');
const {visaCaseSignature} = require('./visa-case-signature');
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMPLETED = new Set(['ready', 'needs_confirmation', 'needs_review']);
const IDENTITY = new Set(['passport', 'uae_id_front', 'uae_id_back']);
const RETENTION_MS = 30 * 86400000, MAX_ITEMS = 2000, MAX_SOURCES = 100;
const QUIET_MS = 12000;
const clone = value => structuredClone(value);
const phone = value => typeof value === 'string' && /^\+?[1-9]\d{7,14}$/.test(value) ? value.replace(/^\+/, '') : null;
const original = value => value && !value.purpose && (value.type === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType) || value.type === 'document' && value.mimeType === 'application/pdf');
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u0020\u007f-\u009f]/u.test(value);
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value === undefined ? null : value; }
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const error = (code, notDispatched = false) => Object.assign(Error(code), {code, ...(notDispatched ? {notDispatched: true} : {})});

// All customer text is fixed application copy. OCR/provider explanations and
// extracted names, identifiers, dates and arbitrary issue messages never enter it.
const ISSUE_TEXT = Object.freeze({
  DOCUMENT_UNREADABLE:'ممكن تبعت صورة أوضح للمستند كاملًا، بدون انعكاس؟',
  DOCUMENT_IMAGE_UNSUITABLE:'ممكن تبعت الصورة بحجمها الأصلي؟',
  DOCUMENT_PORTRAIT_REQUIRED:'ممكن تبعت صورة شخصية واضحة بخلفية بيضاء؟',
  DOCUMENT_SOURCE_UNAVAILABLE:'ممكن تعيد إرسال المرفق الأخير؟',
  MULTIPLE_PASSPORTS:'الجوازات المرسلة كلها للتقديم؟'
});
function copyFor(status, issues, summary) {
  const prefix = '';
  if (status === 'ready') return prefix + 'وصلت أوراقك، شكرًا إلك. ملفك جاهز لنكمل إجراءات الطلب.';
  if (status === 'needs_confirmation') return prefix + documentConfirmationCopy({...summary,issues});
  const clarification=documentClarificationCopy({...summary,issues});if(clarification)return clarification;
  const actionable=new Set(['DOCUMENT_UNREADABLE','DOCUMENT_IMAGE_UNSUITABLE','DOCUMENT_PORTRAIT_REQUIRED','DOCUMENT_SOURCE_UNAVAILABLE','MULTIPLE_PASSPORTS']);
  const lines=[...new Set(issues.filter(issue=>actionable.has(issue?.code)).map(issue=>ISSUE_TEXT[issue.code]).filter(Boolean))].slice(0,1);
  return 'وصلت أوراقك، شكرًا إلك. '+(lines.length?'حتى نكمل:\n'+lines.map(line=>'• '+line).join('\n'):'منخبرك إذا احتجنا أي معلومة إضافية.');
}

class VisaDocumentNotifications {
  constructor({store, documentIntake, inbox, send, now = Date.now, isInboundBusy = () => false, quietMs = QUIET_MS} = {}) {
    if (!store?.data || typeof store.save !== 'function' || typeof documentIntake?.summary !== 'function' || typeof send !== 'function' || typeof isInboundBusy !== 'function' || !Number.isSafeInteger(quietMs) || quietMs < 0 || quietMs > 60000) throw error('DOCUMENT_NOTICE_CONFIGURATION_REQUIRED');
    Object.assign(this, {store, documentIntake, inbox, send, now, isInboundBusy, quietMs});
    store.data.visaDocumentNotifications ||= {items: {}};
    if (!store.data.visaDocumentNotifications.items || Array.isArray(store.data.visaDocumentNotifications.items)) throw error('DOCUMENT_NOTICE_STATE_INVALID');
    this.locks = new Map(); this.recipientLocks = new Map();
    let changed = false;
    for (const [key, item] of Object.entries(this.data().items)) {
      if (!item || !Number.isFinite(item.expiresAt) || item.expiresAt <= now()) { delete this.data().items[key]; changed = true; }
      else if (item.state === 'sending') { item.state = 'uncertain'; item.failure = 'PROCESS_INTERRUPTED'; item.updatedAt = now(); changed = true; }
    }
    if (changed) store.save();
  }
  data() { return this.store.data.visaDocumentNotifications; }
  commit(change) { const previous = clone(this.data()); try { const value = change(); this.store.save(); return clone(value); } catch { this.store.data.visaDocumentNotifications = previous; throw error('DOCUMENT_NOTICE_STATE_FAILED'); } }
  prune() {
    const expired = Object.values(this.data().items).filter(item => item.expiresAt <= this.now()).map(item => item.key);
    if (expired.length) this.commit(() => { for (const key of expired) delete this.data().items[key]; });
  }
  inbound(customer) {
    let summary, journal;
    try { summary = this.inbox?.journal?.summary?.(customer); journal = this.inbox?.journal?.get?.(customer); } catch {}
    journal ||= this.store.data.conversationJournal?.customers?.[customer];
    const last = Array.isArray(journal?.messages) ? journal.messages.filter(item => item?.direction === 'in').at(-1) : null;
    const at = summary?.lastInboundAt ?? journal?.lastInboundAt;
    return {open: (summary?.serviceWindowOpen === true || summary?.serviceWindowOpen === undefined) && Number.isFinite(at) && at >= 0 && at <= this.now() && this.now() - at < 86400000, sequence: Number.isSafeInteger(last?.seq) ? last.seq : null, idHash: messageId(last?.id) ? digest(last.id) : null, at: Number.isFinite(at) ? at : null};
  }
  pause(item, failure) { item.state = 'paused'; item.failure = failure; const inbound = this.inbound(item.customer); item.pauseMarker = {sequence: inbound.sequence, idHash: inbound.idHash, at: inbound.at}; item.updatedAt = this.now(); }
  blocked(customer) {
    try {
      if (this.inbox?.isHumanOwned?.(customer) || this.inbox?.isOperatorOwned?.(customer) || this.inbox?.isBlocked?.(customer)) return true;
      const c = this.store.data.visaCases?.[customer], journal = this.store.data.conversationJournal?.customers?.[customer];
      return Boolean(!c || journal?.operatorOwned || journal?.blocked || journal?.whatsappBlocked || ['pending', 'uncertain'].includes(journal?.whatsappBlockState) || journal?.complaintPending || c.stage === 'complaint_pending' || c.submissionStatus === 'submitted' || c.staffVerification?.decision || c.pendingAmendment && !['applied', 'rejected', 'cancelled', 'resolved'].includes(c.pendingAmendment.state) || (this.store.data.complaints || []).some(item => item.customer === customer && ['pending', 'claimed'].includes(item.state)));
    } catch { return true; }
  }
  snapshot(customer) {
    if (!phone(customer) || phone(customer) !== customer) return null;
    const c = this.store.data.visaCases?.[customer], raw = this.store.data.visaDocumentIntake?.cases?.[customer];
    let summary; try { summary = this.documentIntake.summary(customer); } catch { return null; }
    if (!c || !raw || !summary || summary.enabled !== true || !COMPLETED.has(raw.status) || summary.status !== raw.status || typeof c.id !== 'string' || !Number.isFinite(c.createdAt) || raw.caseId !== c.id || summary.caseId !== c.id || !Number.isInteger(raw.generation) || raw.generation < 1 || summary.generation !== raw.generation || !SHA.test(raw.resultFingerprint || '') || summary.resultFingerprint !== raw.resultFingerprint) return null;
    // An employee's internal reread is not a fresh customer request. Hold its
    // intermediate results until the customer actually contacts us again.
    const manualAt = Math.max(0, ...Object.values(raw.manualRereads || {}).filter(item => Number.isFinite(item?.requestedAt) && Number.isSafeInteger(item?.generation) && item.generation <= raw.generation).map(item => item.requestedAt));
    if (manualAt && (!Number.isFinite(this.inbound(customer).at) || this.inbound(customer).at <= manualAt)) return null;
    const signature = visaCaseSignature(c);
    if (raw.caseSignature !== signature || summary.caseSignature !== signature || !Array.isArray(raw.documents) || raw.documents.length > 100 || !raw.documents.some(document => IDENTITY.has(document?.extraction?.kind))) return null;
    const referenced = new Set(raw.documents.map(document => document?.mediaId));
    const allSources = Object.values(this.store.data.visaMedia || {}).filter(source => source?.customer === customer && original(source) && (referenced.has(source.id) || Number.isFinite(source.receivedAt) && source.receivedAt >= c.createdAt));
    if (!allSources.length || allSources.length > MAX_SOURCES) return null;
    const sourceMap = new Map(), sources = [];
    for (const source of allSources) {
      if (!UUID.test(source.id || '') || !SHA.test(source.checksum || '') || !Number.isFinite(source.expiresAt) || source.expiresAt <= this.now() || !Number.isFinite(source.receivedAt) || !Number.isSafeInteger(source.size) || source.size < 1) return null;
      sourceMap.set(source.id, source);
      sources.push({mediaId: source.id, sha256: source.checksum, type: source.type, mimeType: source.mimeType, size: source.size, receivedAt: source.receivedAt, expiresAt: source.expiresAt});
    }
    for (const document of raw.documents) if (!sourceMap.has(document?.mediaId) || document.sourceSha256 !== sourceMap.get(document.mediaId).checksum || !SHA.test(document.sha256 || '') || !Number.isInteger(document.page) || document.page < 1 || document.page > 10) return null;
    // A just-saved, not-yet-enqueued attachment must invalidate an earlier
    // completion message while intake catches up with that new version.
    const jobs = Object.values(this.store.data.visaDocumentIntake?.jobs || {}).filter(job => job?.customer === customer && job.caseId === c.id && job.caseSignature === signature && job.generation === raw.generation && job.status !== 'stale');
    for (const source of sources) {
      const matching = jobs.filter(job => job.mediaId === source.mediaId);
      if (!matching.length || matching.some(job => !['ready', 'failed'].includes(job.status) || job.sourceSha256 && job.sourceSha256 !== source.sha256)) return null;
    }
    sources.sort((a, b) => a.mediaId.localeCompare(b.mediaId));
    const issues = [...(Array.isArray(raw.issues) ? raw.issues : []), ...(Array.isArray(raw.applicants) ? raw.applicants.flatMap(applicant => Array.isArray(applicant?.issues) ? applicant.issues : []) : [])];
    if(raw.status==='needs_confirmation'&&raw.awaitingPayment===false)return null;
    if (!Array.isArray(raw.applicants) || raw.applicants.some(applicant => !applicant || typeof applicant !== 'object' || Array.isArray(applicant))) return null;
    // Applying an already-read dossier and staging it for a paid job are
    // delivery bookkeeping, not a new document-reading result. Match intake's
    // fingerprint while retaining every identity/evidence/manifest field.
    const applicants = raw.applicants.map(({applied, stagedJobs, ...applicant}) => applicant);
    const receiptFollowup=paymentReceiptFollowup(this.store,customer,{...summary,status:raw.status});
    const noticeText=[copyFor(raw.status, issues,summary),receiptFollowup].filter(Boolean).join('\n\n');
    const choiceApplicant=raw.status==='needs_confirmation'&&raw.awaitingPayment===true?raw.applicants.find(app=>UUID.test(app.id||'')&&app.clientFieldsRequired?.includes('passportType')&&!documentClientAnswers(this.store,customer,app,this.now()).passportType):null;
    const binding = {customer, caseId: c.id, caseSignature: signature, generation: raw.generation, status: raw.status, resultFingerprint: raw.resultFingerprint, resultDigest: digest({documents: raw.documents, applicants, issues: issues.map(issue => ({code: issue?.code, field: issue?.field}))}), sources, policy: this.documentIntake.policyFingerprint || null};
    const key=digest({customer,caseId:c.id,caseSignature:signature,generation:raw.generation,status:raw.status,resultFingerprint:raw.resultFingerprint,receiptFollowup,noticeText,choiceEvidence:choiceApplicant?.id||null});
    const h=digest({customer,caseId:c.id,signature,generation:raw.generation,evidenceId:choiceApplicant?.id,purpose:'passport-type-list'}).slice(0,32),token=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
    const payload=choiceApplicant?{type:'question',text:'وصلت أوراقك، شكرًا إلك. اختار نوع جواز السفر من القائمة 👇',field:'passportType',token,applicantIndex:choiceApplicant.applicantIndex,options:clone(QUESTION_CATALOG.passportType.options)}:{type:'text',text:noticeText};
    return {payload,key,binding, bindingFingerprint: digest(binding), text:noticeText, expiresAt: Math.min(this.now() + RETENTION_MS, ...sources.map(source => source.expiresAt))};
  }
  // A source/result fingerprint binds evidence, but does not describe a new
  // customer-facing update: five new file IDs can produce the exact same copy.
  semanticKey(item) {
    if (!item?.binding || typeof item.payload?.text !== 'string') return null;
    return digest({customer: item.customer, caseId: item.binding.caseId, text:item.payload.text,...(item.payload.type==='question'?{token:item.payload.token}:{})});
  }
  duplicate(item) {
    const semanticKey = this.semanticKey(item); if (!semanticKey) return false;
    return Object.values(this.data().items).some(previous => {
      if (previous.key === item.key || previous.kind !== 'document_review' || !['sending', 'accepted', 'uncertain'].includes(previous.state) || previous.expiresAt <= this.now() || this.semanticKey(previous) !== semanticKey) return false;
      // An unknown provider outcome never becomes permission to repeat the
      // same notice under a new evidence fingerprint or after a restart.
      if (previous.state !== 'accepted') return true;
      const at = previous.acceptedAt ?? previous.dispatchStartedAt ?? previous.updatedAt ?? previous.createdAt;
      return Number.isFinite(at) && at <= this.now() && previous.expiresAt > this.now();
    });
  }
  settled(item) {
    try {
      if (this.isInboundBusy(item.customer) !== false) return false;
      const at = Math.max(this.inbound(item.customer).at || 0, ...(item.binding?.sources || []).map(source => source.receivedAt));
      return Number.isFinite(at) && at >= 0 && this.now() >= at + this.quietMs;
    } catch { return false; }
  }
  current(item) { if (!item || item.kind !== 'document_review' || item.expiresAt <= this.now()) return false; const snapshot = this.snapshot(item.customer); return snapshot !== null && snapshot.key === item.key && snapshot.bindingFingerprint === item.bindingFingerprint && digest(item.payload)===digest(snapshot.payload); }
  update(customer) {
    this.prune();
    const snapshot = this.snapshot(customer); if (!snapshot) return null;
    const existing = this.data().items[snapshot.key];
    if (existing) return clone(existing);
    if (Object.keys(this.data().items).length >= MAX_ITEMS) return null;
    return this.commit(() => {
      for (const item of Object.values(this.data().items)) if (item.customer === customer && ['pending', 'paused'].includes(item.state)) { item.state = 'cancelled'; item.failure = 'SUPERSEDED'; item.updatedAt = this.now(); }
      const item = {key: snapshot.key, customer, kind: 'document_review', binding: snapshot.binding, bindingFingerprint: snapshot.bindingFingerprint, payload:clone(snapshot.payload), state: this.blocked(customer) ? 'paused' : 'pending', attempts: 0, createdAt: this.now(), updatedAt: this.now(), expiresAt: snapshot.expiresAt};
      if (item.state === 'paused') this.pause(item, 'AUTOMATION_PAUSED'); this.data().items[item.key] = item; return item;
    });
  }
  receive(message){
    const choice=message?.visaAnswer;if(!choice)return {handled:false};
    const item=Object.values(this.data().items).find(item=>item.payload?.type==='question'&&item.payload.token===choice.token);if(!item)return {handled:false};
    const stale=()=>({handled:true,ok:false,reply:'اختار من أحدث قائمة أرسلتها إلك لو سمحت.'});
    if(this.blocked(item.customer))return {handled:true,ok:false,paused:true};
    if(phone(message.from)!==item.customer||!messageId(message.id)||!this.inbound(item.customer).open)return stale();
    if(item.answer)return {handled:true,ok:true,duplicate:true};
    const current=this.snapshot(item.customer);if(item.state!=='accepted'||current?.payload?.type!=='question'||current.payload.token!==item.payload.token)return stale();
    const option=QUESTION_CATALOG.passportType.options.find(option=>option.id===choice.option),raw=this.store.data.visaDocumentIntake?.cases?.[item.customer],app=raw?.applicants?.find(app=>app.applicantIndex===item.payload.applicantIndex);
    if(!option||!app?.id||!app.clientFieldsRequired?.includes('passportType'))return stale();
    try{this.commit(()=>{item.answer={field:'passportType',value:option.value,applicantIndex:app.applicantIndex,evidenceId:app.id,messageId:message.id,at:this.now()};});return {handled:true,ok:true,reply:'تمام، سجّلت اختيارك. شكرًا إلك.'};}catch{return {handled:true,ok:false,reply:'ما انحفظ الاختيار، جرّب تضغط عليه مرة تانية لو سمحت.'};}
  }
  reopen(customer) {
    if (!phone(customer) || this.blocked(customer)) return {requeued: 0, messageIds: []};
    const inbound = this.inbound(customer); if (!inbound.open || !inbound.idHash && inbound.sequence === null) return {requeued: 0, messageIds: []};
    const keys = Object.values(this.data().items).filter(item => item.customer === customer && item.state === 'paused' && this.current(item) && (Number.isSafeInteger(inbound.sequence) && Number.isSafeInteger(item.pauseMarker?.sequence) ? inbound.sequence > item.pauseMarker.sequence : inbound.idHash && inbound.idHash !== item.pauseMarker?.idHash)).map(item => item.key);
    if (!keys.length) return {requeued: 0, messageIds: []};
    return this.commit(() => { for (const key of keys) { const item = this.data().items[key]; item.state = 'pending'; delete item.failure; item.updatedAt = this.now(); } return {requeued: keys.length, messageIds: keys}; });
  }
  async flush(customer) {
    this.prune();
    const selected = Object.values(this.data().items).filter(item => item.state === 'pending' && (customer === undefined || item.customer === customer)).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    const results = []; for (const item of selected) results.push(await this.dispatch(item.key)); return results;
  }
  dispatch(key) {
    if (this.locks.has(key)) return this.locks.get(key);
    const item = this.data().items[key]; if (!item) return Promise.resolve(null);
    const prior = this.recipientLocks.get(item.customer) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.perform(key));
    this.locks.set(key, work); this.recipientLocks.set(item.customer, work);
    const done = () => { if (this.locks.get(key) === work) this.locks.delete(key); if (this.recipientLocks.get(item.customer) === work) this.recipientLocks.delete(item.customer); };
    work.then(done, done); return work;
  }
  quarantine(key) {
    const item = this.data().items[key]; if (!item) return null;
    item.state = 'uncertain'; item.failure = 'DELIVERY_UNCERTAIN'; item.updatedAt = this.now(); try { this.store.save(); } catch {} return clone(item);
  }
  async perform(key) {
    let item = this.data().items[key]; if (!item || item.state !== 'pending') return item ? clone(item) : null;
    if (!this.current(item)) return this.commit(() => { item.state = 'cancelled'; item.failure = 'SUPERSEDED'; item.updatedAt = this.now(); return item; });
    if (this.blocked(item.customer)) return this.commit(() => { this.pause(item, 'AUTOMATION_PAUSED'); return item; });
    if (this.duplicate(item)) return this.commit(() => { item.state = 'cancelled'; item.failure = 'DUPLICATE_FEEDBACK'; item.updatedAt = this.now(); return item; });
    // Keep a known unsent notice pending while the customer's file batch and
    // receipt reply finish. A periodic flush can resume it without a new inbound.
    if (!this.settled(item)) return clone(item);
    this.commit(() => { item.state = 'sending'; item.attempts++; item.dispatchStartedAt = this.now(); item.updatedAt = this.now(); });
    const guard = () => { const current = this.data().items[key]; if (!current || current.state !== 'sending' || !this.current(current)) throw error('DOCUMENT_NOTICE_STALE', true); if (this.blocked(current.customer)) throw error('DOCUMENT_NOTICE_PAUSED', true); if (this.duplicate(current)) throw error('DOCUMENT_NOTICE_DUPLICATE', true); if (!this.settled(current)) throw error('DOCUMENT_NOTICE_SETTLING', true); return true; };
    let result;
    try {
      guard(); result = await this.send(item.customer, clone(item.payload), guard, {kind: 'document_review', customer: item.customer, id: item.key, caseId: item.binding.caseId});
      const acceptedId = result?.messages?.[0]?.id || result?.messageId;
      if (result?.paused === true || result?.dryRun === true || result?.notDispatched === true) {
        return this.commit(() => { item = this.data().items[key]; if (!this.current(item)) { item.state = 'cancelled'; item.failure = 'SUPERSEDED'; item.updatedAt = this.now(); } else this.pause(item, result.dryRun === true ? 'DRY_RUN' : 'DELIVERY_PAUSED'); return item; });
      }
      if (!messageId(acceptedId)) throw Error('DOCUMENT_NOTICE_INVALID_ACCEPTANCE');
      let superseded = false; try { guard(); } catch { superseded = true; }
      return this.commit(() => { item = this.data().items[key]; item.state = 'accepted'; item.messageId = acceptedId; item.acceptedAt = this.now(); item.updatedAt = this.now(); if (superseded) item.supersededAfterDispatch = true; return item; });
    } catch (failure) {
      if (this.data().items[key]?.state !== 'sending') return this.quarantine(key);
      if (failure?.notDispatched === true) {
        try { return this.commit(() => { item = this.data().items[key]; if (!this.current(item)) { item.state = 'cancelled'; item.failure = 'SUPERSEDED'; item.updatedAt = this.now(); } else if (this.duplicate(item)) { item.state = 'cancelled'; item.failure = 'DUPLICATE_FEEDBACK'; item.updatedAt = this.now(); } else if (!this.blocked(item.customer) && !this.settled(item)) { item.state = 'pending'; item.failure = 'BATCH_SETTLING'; item.updatedAt = this.now(); } else this.pause(item, this.blocked(item.customer) ? 'AUTOMATION_PAUSED' : 'DELIVERY_PAUSED'); return item; }); } catch { return this.quarantine(key); }
      }
      return this.quarantine(key);
    }
  }
}

module.exports = {VisaDocumentNotifications};
