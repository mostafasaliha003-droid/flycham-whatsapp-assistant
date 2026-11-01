'use strict';

const {createHash, createHmac, randomBytes, randomUUID} = require('node:crypto');
const {SUPERVISOR_WHATSAPP_NUMBER, supervisorWhatsAppRecipient} = require('./visa-supervisor-route');
const {SMS_CHALLENGE_TTL_MS, validateSmsChallenge} = require('./visa-sms-challenge');
const {visaCaseSignature, currentVisaEvidence} = require('./visa-case-signature');
const {QUESTION_CATALOG, questionFor, validateAnswer, requiredQuestions} = require('./visa-client-questions');

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const phone = value => typeof value === 'string' && /^\+?\d{8,16}$/.test(value) ? value.replace(/^\+/, '') : null;
const terminal = new Set(['saved_application', 'stale', 'cancelled', 'portal_review_required']);
const OTP_TTL = SMS_CHALLENGE_TTL_MS;
const DOCUMENT_FACT_FIELDS = Object.freeze(['nationalityCode', 'passportNumber', 'passportType', 'issuingCountryCode', 'issueDate', 'expiryDate', 'birthDate', 'birthPlace', 'sex', 'latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName', 'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName', 'emiratesId', 'residenceExpiry']);
const DOCUMENT_FACT_SET = new Set(DOCUMENT_FACT_FIELDS);
const CLIENT_DOCUMENT_FIELDS = new Set(['passportType', 'issueDate', 'birthPlace']);
function fail(code, statusCode = 409) { throw Object.assign(Error(code), {code, statusCode}); }
function text(value, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('VISA_VALUE_INVALID', 400);
  return value.trim();
}
function amountMinor(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null; }
function providerMessageId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim() && !/[\u0000-\u0020\u007f-\u009f]/u.test(value); }
function setField(target, field, value) {
  const names = field.split('.');
  if (names.length === 1) target[field] = value;
  else { target[names[0]] ||= {}; target[names[0]][names[1]] = value; }
}
function fieldAt(target, field) { return field.split('.').reduce((value, key) => value?.[key], target); }
function documentFactValue(field, value) {
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return field === 'emiratesId' ? normalized.replace(/[ -]/gu, '') : normalized.toUpperCase();
}
const documentFactsHash = fields => hash(Object.fromEntries(Object.keys(fields).sort().map(field => [field, documentFactValue(field, fields[field])])));

// This coordinator contains no browser, model, bank, or government-payment
// implementation. Its injected adapters must perform their final guard directly
// before dispatch. The existing encrypted state store owns all durable data.
class VisaFulfilment {
  constructor({store, inbox, mediaStore, artifactStore, raad, mrzProfiles = null, send, resumeOtp, portal, canAutomate, now = Date.now, env = {}} = {}) {
    if (!store?.data || typeof store.save !== 'function') fail('VISA_STORE_REQUIRED', 500);
    Object.assign(this, {store, inbox, mediaStore, artifactStore: artifactStore || mediaStore, raad, mrzProfiles, send, resumeOtp, canAutomate, now, env});
    this.resumeOtp ||= typeof portal?.resumeOtp === 'function' ? portal.resumeOtp.bind(portal) : null;
    this.messageLocks = new Map();
    this.uncertainMessageIds = new Set(); // Never replay an uncertain dispatch after a store rollback.
    this.recipientLocks = new Map();
    this.otpLocks = new Set();
    this.usedOtpDigests = new Map(); // Process memory only; never serialize an OTP or its digest.
    this.otpDigestKey = randomBytes(32); // Ephemeral HMAC key, never configured or persisted.
    this.usedOtpChallenges = new Set(); // Survives a store rollback in this process.
    this.usedOtpMessageIds = new Map();
    store.data.visaFulfilment ||= {version: 1, cases: {}, jobs: {}, outbox: {}, challenges: {}, lease: null, audit: []};
    const state = this.data();
    if (state.version !== 1) fail('VISA_STATE_VERSION_UNSUPPORTED', 500);
    let changed = false;
    for (const item of Object.values(state.outbox)) if (item.state === 'sending') { item.state = 'uncertain'; item.failure = 'PROCESS_INTERRUPTED'; changed = true; }
    // A browser action interrupted by a process restart is never blindly replayed.
    if (state.lease) {
      const job = state.jobs[state.lease.jobId];
      if (job && !terminal.has(job.state)) { job.state = 'portal_review_required'; job.blockedReason = 'BROWSER_INTERRUPTED'; job.revision++; }
      state.lease = null; changed = true;
    }
    for (const challenge of Object.values(state.challenges)) if (['pending', 'consuming'].includes(challenge.state)) { challenge.state = 'interrupted'; changed = true; }
    if (changed) this.save();
  }

  data() { return this.store.data.visaFulfilment; }
  save() { this.store.save(); }
  commit(change) {
    const previous = clone(this.data());
    try { const result = change(); this.save(); return clone(result); }
    catch (error) { this.store.data.visaFulfilment = previous; throw error; }
  }
  case(customer) {
    if (!phone(customer)) fail('INVALID_CUSTOMER', 400);
    const current = this.store.data.visaCases?.[customer];
    if (!current) fail('VISA_CASE_NOT_FOUND', 404);
    return current;
  }
  record(customer) {
    const c = this.case(customer);
    return this.data().cases[customer] ||= {customer, caseId: c.id, receipts: {}, approvals: {}, idempotency: {}, activeApprovalId: null};
  }
  audit(action, data) {
    this.data().audit.push({id: randomUUID(), action, at: this.now(), ...data});
    this.data().audit = this.data().audit.slice(-1000);
  }
  blocked(customer) {
    const c = this.case(customer), j = this.store.data.conversationJournal?.customers?.[customer];
    if (j?.blocked || j?.whatsappBlocked || ['pending', 'uncertain'].includes(j?.whatsappBlockState) || this.inbox?.isBlocked?.(customer)) return 'CUSTOMER_BLOCKED';
    if (j?.complaintPending || c.stage === 'complaint_pending' || (this.store.data.complaints || []).some(x => x.customer === customer && ['pending', 'claimed'].includes(x.state))) return 'COMPLAINT_ACTIVE';
    if (j?.operatorOwned || this.store.data.conversations?.[customer]?.humanOwned || this.inbox?.isOperatorOwned?.(customer)) return 'HUMAN_OWNERSHIP';
    if (c.pendingAmendment && !['applied', 'rejected', 'cancelled', 'resolved'].includes(c.pendingAmendment.state)) return 'CASE_AMENDMENT_PENDING';
    if (c.submissionStatus === 'submitted' || c.staffVerification?.decision) return 'CASE_ALREADY_PROCESSED';
    if (this.canAutomate && this.canAutomate(customer) !== true) return 'AUTOMATION_PAUSED';
    return null;
  }
  approvalCurrent(customer, approval) {
    const c = this.case(customer), evidence = currentVisaEvidence(c);
    // The intake engine increments its revision for ordinary conversation too.
    // Material case facts and the exact payment evidence establish freshness;
    // caseRevision remains an audit snapshot and finance request CAS value.
    return approval?.state === 'approved' && approval.caseId === c.id && approval.caseSignature === evidence.signature && evidence.payment && approval.paymentFingerprint === hash(c.staffVerification.payment);
  }
  invalidate(customer, reason = 'CASE_CHANGED') {
    const record = this.data().cases[customer];
    if (!record) return;
    const approval = record.approvals[record.activeApprovalId];
    if (approval) { approval.state = 'stale'; approval.invalidatedAt = this.now(); approval.invalidatedReason = reason; }
    for (const job of Object.values(this.data().jobs)) if (job.customer === customer && !terminal.has(job.state)) { job.state = 'stale'; job.blockedReason = reason; job.revision++; job.updatedAt = this.now(); }
    for (const challenge of Object.values(this.data().challenges)) if (challenge.customer === customer && challenge.state === 'pending') challenge.state = 'cancelled';
    for (const message of Object.values(this.data().outbox)) if (message.customer === customer && message.state === 'pending') { message.state = 'cancelled'; message.failure = reason; }
    // Keep a running lease until its worker acknowledges it; freeing it here
    // would allow another applicant to navigate the same browser mid-action.
    if (this.data().lease?.customer === customer) this.data().lease.cancelled = true;
    this.audit('case_invalidated', {customer, reason});
  }
  reconcile(customer) {
    const record = this.data().cases[customer], approval = record?.approvals[record.activeApprovalId];
    if (approval?.state === 'approved' && !this.approvalCurrent(customer, approval)) this.commit(() => this.invalidate(customer));
    const reason = this.blocked(customer);
    if (reason === 'HUMAN_OWNERSHIP') {
      // Taking a staff claim pauses automation; it does not undo actual money
      // received. An already-running browser still needs a safe review boundary.
      const lease = this.data().lease;
      if (lease?.customer === customer && !lease.cancelled) this.commit(() => {
        lease.cancelled = true;
        const job = this.job(lease.jobId);
        if (!terminal.has(job.state)) { job.state = 'portal_review_required'; job.blockedReason = 'HUMAN_OWNERSHIP'; job.revision++; }
        for (const challenge of Object.values(this.data().challenges)) if (challenge.customer === customer && ['pending', 'consuming'].includes(challenge.state)) challenge.state = 'cancelled';
        this.audit('browser_paused_for_staff', {customer, jobId: lease.jobId});
      });
    } else if (reason && Object.values(this.data().jobs).some(job => job.customer === customer && !terminal.has(job.state))) this.commit(() => this.invalidate(customer, reason));
  }
  get(customer) {
    this.case(customer); this.reconcile(customer);
    const record = this.data().cases[customer], c = this.case(customer), caseSignature = visaCaseSignature(c), revision = Number(c.revision) || 0;
    const jobs = Object.values(this.data().jobs).filter(x => x.customer === customer);
    const blockers = [];
    const blockedReason = this.blocked(customer);
    if (blockedReason) blockers.push(blockedReason);
    const approval = record?.approvals[record.activeApprovalId] || null;
    if (!approval || !this.approvalCurrent(customer, approval)) blockers.push('ACCOUNTANT_APPROVAL_REQUIRED');
    for (const job of jobs) {
      if (job.blockedReason) blockers.push(job.blockedReason);
      if (['awaiting_answers', 'needs_followup', 'awaiting_answer_confirmation'].includes(job.state)) blockers.push('CLIENT_ANSWERS_REQUIRED');
    }
    const messages = Object.values(this.data().outbox).filter(x => x.customer === customer).map(item => {
      if (item.kind !== 'owner_otp_request') return item;
      return {id: item.id, kind: item.kind, customer, jobId: item.jobId, state: item.state, createdAt: item.createdAt, updatedAt: item.updatedAt};
    });
    return clone({customer, caseId: c.id, caseSignature, currentCaseSignature: caseSignature, caseRevision: revision, revision, blockedReason, blockers: [...new Set(blockers)], receipts: Object.values(record?.receipts || {}), receiptMediaIds: Object.keys(record?.receipts || {}), approval, jobs, messages, timeline: this.data().audit.filter(item => item.customer === customer).map(item => { const safe = {...item}; delete safe.challengeId; return safe; })});
  }
  list() {
    return {items: Object.keys(this.store.data.visaCases || {}).map(customer => this.get(customer)), capabilities: {accountantApproval: true, clientQuestions: true, requestCopyDelivery: true, governmentPayment: false, visaIssuance: false, otpOwnerConfigured: Boolean(this.otpOwner()), portalResumeConnected: typeof this.resumeOtp === 'function'}};
  }

  observeMedia(customer, id, store = this.mediaStore) {
    if (typeof store?.get !== 'function') fail('VISA_MEDIA_STORE_REQUIRED', 503);
    let metadata;
    try { metadata = store.get(id, {customer}); } catch { fail('VISA_MEDIA_UNAVAILABLE', 404); }
    const raw = this.store.data.visaMedia?.[id];
    const digest = metadata?.sha256 || metadata?.checksum || raw?.checksum || raw?.sha256;
    if (metadata?.customer !== customer || metadata?.id !== id || !/^[a-f0-9]{64}$/i.test(digest || '') || !Number.isSafeInteger(metadata?.size) || metadata.size <= 0 || metadata.expiresAt !== undefined && metadata.expiresAt <= this.now()) fail('VISA_MEDIA_UNAVAILABLE', 404);
    return {mediaId: id, customer, mimeType: metadata.mimeType, size: metadata.size, sha256: digest, expiresAt: metadata.expiresAt ?? null};
  }
  receiveReceipt(customer, {receiptId, reference = null} = {}) {
    const c = this.case(customer), media = this.observeMedia(customer, receiptId);
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(media.mimeType)) fail('VISA_RECEIPT_FORMAT_INVALID', 400);
    if (amountMinor(c.quote?.total) === null) fail('VISA_CURRENT_QUOTE_REQUIRED');
    const quoteFingerprint = hash(c.quote), signature = visaCaseSignature(c);
    const existing = this.data().cases[customer]?.receipts[receiptId];
    if (existing && existing.caseSignature === signature && existing.sha256 === media.sha256 && existing.quoteFingerprint === quoteFingerprint) return clone(existing);
    return this.commit(() => {
      const receipt = {...media, caseId: c.id, caseSignature: signature, caseRevision: Number(c.revision) || 0, quoteFingerprint, amountMinor: amountMinor(c.quote.total), reference: reference === null ? null : text(reference), state: 'awaiting_accountant', receivedAt: this.now()};
      this.record(customer).receipts[receiptId] = receipt;
      this.audit('receipt_received', {customer, receiptId, caseSignature: signature});
      return receipt;
    });
  }

  confirmPayment(customer, input = {}) {
    const {receiptId, amount, actor, actualReceived, confirm, expectedCaseSignature, expectedRevision} = input;
    const reference = text(input.reference), key = text(input.idempotencyKey, 100);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) fail('VISA_IDEMPOTENCY_KEY_INVALID', 400);
    if (!object(actor) || actor.role !== 'accountant') fail('ACCOUNTANT_REQUIRED', 403);
    const actorId = text(actor.id, 100);
    if (actualReceived !== true || confirm !== true) fail('ACTUAL_PAYMENT_CONFIRMATION_REQUIRED', 400);
    const c = this.case(customer), signature = visaCaseSignature(c), record = this.record(customer), receipt = record.receipts[receiptId];
    if (expectedCaseSignature !== signature) fail('VISA_CASE_SIGNATURE_CONFLICT');
    const currentReceipt = this.observeMedia(customer, receiptId);
    if (!receipt || receipt.caseId !== c.id || receipt.caseSignature !== signature || receipt.quoteFingerprint !== hash(c.quote) || receipt.sha256 !== currentReceipt.sha256) fail('VISA_RECEIPT_STALE');
    if (amountMinor(amount) === null || amountMinor(amount) !== amountMinor(c.quote?.total) || amountMinor(amount) !== receipt.amountMinor) fail('INVALID_PAYMENT', 400);
    const fingerprint = hash({receiptId, amountMinor: amountMinor(amount), reference, actorId, signature});
    const prior = record.idempotency[key];
    if (prior && prior.fingerprint !== fingerprint) fail('VISA_IDEMPOTENCY_CONFLICT');
    if (prior?.approvalId) {
      const approval = record.approvals[prior.approvalId];
      if (!this.approvalCurrent(customer, approval)) fail('VISA_APPROVAL_STALE');
      return clone({ok: true, duplicate: true, approval, jobs: Object.values(this.data().jobs).filter(job => job.approvalId === approval.id)});
    }
    if (!this.inbox?.isOperatorOwned?.(customer)) fail('CLAIM_REQUIRED');
    if (expectedRevision !== undefined && expectedRevision !== (Number(c.revision) || 0) && prior?.state !== 'prepared') fail('VISA_CASE_REVISION_CONFLICT');
    const payment = c.staffVerification?.payment;
    const existingEvidence = currentVisaEvidence(c).payment;
    if (existingEvidence && (payment.reference !== reference || amountMinor(payment.amount) !== amountMinor(amount))) fail('VISA_PAYMENT_ALREADY_VERIFIED');
    // Record intent before invoking the existing staff action. If saving the
    // coordinator later fails, an exact recorded financial result is adopted on
    // retry instead of repeating the staff action.
    if (!prior) this.commit(() => { record.idempotency[key] = {fingerprint, state: 'prepared', createdAt: this.now()}; });
    if (!existingEvidence) {
      if (typeof this.inbox.updateVisa !== 'function') fail('VISA_INBOX_REQUIRED', 503);
      this.inbox.updateVisa(customer, {action: 'confirm_payment', amount, reference, confirm: true});
    }
    const approvedCase = this.case(customer);
    if (!currentVisaEvidence(approvedCase).payment || visaCaseSignature(approvedCase) !== signature || approvedCase.staffVerification.payment.reference !== reference) fail('VISA_PAYMENT_EVIDENCE_MISMATCH');
    return this.commit(() => {
      const live = this.record(customer), current = live.approvals[live.activeApprovalId];
      if (current && this.approvalCurrent(customer, current) && current.receiptId === receiptId && current.reference === reference) {
        live.idempotency[key] = {fingerprint, state: 'approved', approvalId: current.id, createdAt: this.now()};
        return {ok: true, duplicate: true, approval: current, jobs: Object.values(this.data().jobs).filter(job => job.approvalId === current.id)};
      }
      if (current) this.invalidate(customer, 'APPROVAL_REPLACED');
      const paymentFingerprint = hash(approvedCase.staffVerification.payment);
      const approval = {id: randomUUID(), state: 'approved', customer, caseId: approvedCase.id, caseSignature: signature, caseRevision: Number(approvedCase.revision) || 0, receiptId, receiptSha256: receipt.sha256, quoteFingerprint: hash(approvedCase.quote), amount, reference, actor: {id: actorId, role: 'accountant'}, actualReceived: true, paymentFingerprint, approvedAt: this.now()};
      live.approvals[approval.id] = approval; live.activeApprovalId = approval.id;
      live.idempotency[key] = {fingerprint, state: 'approved', approvalId: approval.id, createdAt: this.now()};
      live.receipts[receiptId].state = 'accountant_verified';
      const notification = this.enqueue({key: 'payment:' + customer + ':' + paymentFingerprint, kind: 'payment_confirmation', customer, recipient: customer, approvalId: approval.id, caseSignature: signature, caseRevision: approval.caseRevision, payload: {type: 'text', text: 'أهلاً، معك إسماعيل من رمال 🌷 أكد المحاسب وصول دفعتك. بدأنا تجهيز طلب التأشيرة السعودية ومتابعة خطوات التقديم مع رعد. سنطلب منك تأكيد أي بيانات شخصية ناقصة، ونرسل لك نسخة الطلب عند حفظها. هذا التأكيد لا يعني صدور التأشيرة أو اكتمال التقديم الرسمي.'}});
      const count = approvedCase.applicantCount;
      if (!Number.isSafeInteger(count) || count < 1 || count > 30 || approvedCase.applicants?.length !== count) fail('VISA_APPLICANTS_INCOMPLETE');
      const jobs = Array.from({length: count}, (_, applicantIndex) => {
        const job = {id: randomUUID(), customer, caseId: approvedCase.id, caseSignature: signature, caseRevision: approval.caseRevision, approvalId: approval.id, applicantIndex, revision: 1, state: 'queued', paymentNoticeId: notification.id, routingRequiredFields: ['transport','arrivalPort'], confirmedFields: {}, questions: {}, createdAt: this.now(), updatedAt: this.now()};
        this.data().jobs[job.id] = job; return job;
      });
      this.audit('payment_confirmed', {customer, approvalId: approval.id, receiptId, actor: approval.actor, amount, reference});
      return {ok: true, approval, jobs};
    });
  }

  job(jobId) { const job = this.data().jobs[jobId]; if (!job) fail('VISA_JOB_NOT_FOUND', 404); return job; }
  guardJob(jobId, {allowHuman = false, requireNotice = true} = {}) {
    const job = this.job(jobId); this.reconcile(job.customer);
    const current = this.job(jobId), c = this.case(current.customer), approval = this.data().cases[current.customer]?.approvals[current.approvalId];
    if (terminal.has(current.state) || current.caseId !== c.id || current.caseSignature !== visaCaseSignature(c) || !this.approvalCurrent(current.customer, approval)) fail('VISA_JOB_STALE');
    const reason = this.blocked(current.customer);
    if (reason && !(allowHuman && reason === 'HUMAN_OWNERSHIP')) fail(reason);
    if (requireNotice && !['accepted', 'delivered'].includes(this.data().outbox[current.paymentNoticeId]?.state)) fail('VISA_PAYMENT_NOTICE_UNCONFIRMED');
    return current;
  }
  acquireJob(jobId, {workerId, ttlMs = 120000} = {}) {
    const worker = text(workerId, 100), job = this.guardJob(jobId);
    const old = this.data().lease;
    if (old) {
      if (old.expiresAt <= this.now()) { this.commit(() => { const interrupted = this.job(old.jobId); if (!terminal.has(interrupted.state)) { interrupted.state = 'portal_review_required'; interrupted.blockedReason = 'BROWSER_LEASE_EXPIRED'; interrupted.revision++; } old.cancelled = true; }); fail('VISA_BROWSER_REVIEW_REQUIRED'); }
      fail('VISA_BROWSER_BUSY');
    }
    if (!['queued', 'ready'].includes(job.state)) fail('VISA_JOB_NOT_READY');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 35 * 60000) fail('VISA_LEASE_TTL_INVALID', 400);
    return this.commit(() => {
      const lease = {token: randomUUID(), workerId: worker, jobId, customer: job.customer, caseSignature: job.caseSignature, jobRevision: job.revision, acquiredAt: this.now(), expiresAt: this.now() + ttlMs};
      this.data().lease = lease; job.state = 'running'; job.updatedAt = this.now();
      return {job, lease};
    });
  }
  guardLease(jobId, token) {
    const job = this.guardJob(jobId), lease = this.data().lease;
    if (!lease || lease.jobId !== jobId || lease.token !== token || lease.jobRevision !== job.revision || lease.cancelled || lease.expiresAt <= this.now() || !['running', 'waiting_otp'].includes(job.state)) fail('VISA_BROWSER_LEASE_INVALID');
    return {job, lease};
  }
  renewLease(jobId, {leaseToken, ttlMs = 30 * 60000} = {}) {
    const {lease} = this.guardLease(jobId, leaseToken);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 35 * 60000) fail('VISA_LEASE_TTL_INVALID', 400);
    return this.commit(() => { lease.expiresAt = this.now() + ttlMs; lease.renewedAt = this.now(); return lease; });
  }
  releaseJob(jobId, {leaseToken, state = 'queued'} = {}) {
    const lease = this.data().lease;
    if (!lease || lease.jobId !== jobId || lease.token !== leaseToken) fail('VISA_BROWSER_LEASE_INVALID');
    if (!['queued', 'ready', 'portal_review_required', 'cancelled'].includes(state)) fail('VISA_JOB_STATE_INVALID', 400);
    return this.commit(() => { const job = this.job(jobId); if (!terminal.has(job.state)) { job.state = state; job.revision++; } for (const challenge of Object.values(this.data().challenges)) if (challenge.jobId === jobId && ['pending', 'consuming'].includes(challenge.state)) challenge.state = 'cancelled'; this.data().lease = null; return job; });
  }

  enqueue(input) {
    const existing = Object.values(this.data().outbox).find(item => item.key === input.key);
    if (existing) return existing;
    const item = {id: randomUUID(), ...clone(input), state: 'pending', attempts: 0, createdAt: this.now(), updatedAt: this.now()};
    this.data().outbox[item.id] = item;
    return item;
  }
  pendingMessages() { return clone(Object.values(this.data().outbox).filter(item => item.state === 'pending')); }
  requeuePausedMessages(customerOrOwner) {
    const target = phone(customerOrOwner);
    if (!target) return {ok: true, requeued: 0, messageIds: []};
    const ids = Object.values(this.data().outbox).filter(item => item.state === 'cancelled' && item.failure === 'DELIVERY_PAUSED' && !(item.kind === 'owner_otp_request' && item.ownerActionRequired && !item.ownerAction?.confirmed) && (phone(item.customer) === target || phone(item.recipient) === target) && this.messageCurrent(item)).map(item => item.id);
    if (!ids.length) return {ok: true, requeued: 0, messageIds: []};
    return this.commit(() => { for (const id of ids) { const item = this.data().outbox[id]; item.state = 'pending'; delete item.failure; item.updatedAt = this.now(); } return {ok: true, requeued: ids.length, messageIds: ids}; });
  }
  requeueApprovedNotifications({paymentTemplateApproved = false, ownerTemplateApproved = false} = {}) {
    const ids = [];
    for (const item of Object.values(this.data().outbox)) {
      if (item.state !== 'cancelled' || item.failure !== 'DELIVERY_PAUSED') continue;
      if (item.kind === 'payment_confirmation' ? paymentTemplateApproved !== true : item.kind === 'owner_otp_request' ? ownerTemplateApproved !== true || item.noticeMessageId || item.ownerActionRequired : true) continue;
      try { if (!this.messageCurrent(item)) continue; if (item.kind === 'owner_otp_request') this.ownerChallengeContext(item.challengeId); }
      catch { continue; }
      ids.push(item.id);
    }
    if (!ids.length) return {ok: true, requeued: 0, messageIds: []};
    return this.commit(() => { for (const id of ids) { const item = this.data().outbox[id]; item.state = 'pending'; delete item.failure; item.updatedAt = this.now(); } return {ok: true, requeued: ids.length, messageIds: ids}; });
  }
  messageCurrent(item) {
    const c = this.case(item.customer), record = this.data().cases[item.customer], approval = record?.approvals[record.activeApprovalId];
    if (this.blocked(item.customer) || !this.approvalCurrent(item.customer, approval) || item.caseSignature !== visaCaseSignature(c)) return false;
    if (item.jobId) {
      const job = this.data().jobs[item.jobId];
      if (!job || ['stale', 'cancelled', 'portal_review_required'].includes(job.state) || item.questionRevision !== undefined && item.questionRevision !== job.questionRevision) return false;
      if (item.kind === 'applicant_question' && (job.state !== 'awaiting_answers' || job.questions[item.payload.token]?.state !== 'pending')) return false;
      if (item.kind === 'applicant_answer_summary' && (job.state !== 'awaiting_answer_confirmation' || job.summary?.token !== item.payload.token)) return false;
      if (job.documentFacts && ['applicant_question', 'applicant_answer_summary'].includes(item.kind)) { try { this.assertDocumentFactsCurrent(job); } catch { return false; } }
    }
    if (item.challengeId) { const challenge = this.data().challenges[item.challengeId]; if (challenge?.state !== 'pending' || challenge.expiresAt <= this.now()) return false; }
    if (item.kind === 'owner_otp_request') {
      try { if (this.ownerChallengeContext(item.challengeId).item.id !== item.id || item.ownerActionRequired && !item.ownerAction?.confirmed) return false; }
      catch { return false; }
    }
    return true;
  }
  dispatchMessage(id) {
    if (this.messageLocks.has(id)) return this.messageLocks.get(id);
    const item = this.data().outbox[id]; if (!item) return Promise.reject(Object.assign(Error('VISA_MESSAGE_NOT_FOUND'), {code: 'VISA_MESSAGE_NOT_FOUND'}));
    const recipient = item.recipient, prior = this.recipientLocks.get(recipient) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.performDispatch(id));
    this.messageLocks.set(id, work); this.recipientLocks.set(recipient, work);
    const done = () => { if (this.messageLocks.get(id) === work) this.messageLocks.delete(id); if (this.recipientLocks.get(recipient) === work) this.recipientLocks.delete(recipient); };
    work.then(done, done); return work;
  }
  async performDispatch(id) {
    let item = this.data().outbox[id];
    if (this.uncertainMessageIds.has(id)) return this.commit(() => { item.state = 'uncertain'; item.failure = 'DELIVERY_OUTCOME_UNCERTAIN'; return item; });
    if (item.state !== 'pending') return clone(item);
    if (!this.messageCurrent(item)) return this.commit(() => { item.state = 'cancelled'; item.failure = 'MESSAGE_SUPERSEDED'; return item; });
    if (typeof this.send !== 'function') fail('VISA_SENDER_REQUIRED', 503);
    const originalItem = clone(item), ownerPrompt = item.kind === 'owner_otp_request';
    const select = (value, keys) => value ? Object.fromEntries(keys.map(key => [key, value[key]])) : null;
    const deliveryBinding = () => {
      if (!ownerPrompt) return null;
      const current = this.data().outbox[id], challenge = current && this.data().challenges[current.challengeId], job = current && this.data().jobs[current.jobId];
      return {
        message: select(current, ['id','key','kind','customer','recipient','approvalId','caseSignature','caseRevision','jobId','challengeId','noticeMessageId']),
        payloadHash: current ? hash(current.payload) : null,
        job: select(job, ['id','caseId','customer','applicantIndex','approvalId','caseSignature','caseRevision','revision']),
        challenge: select(challenge, ['id','jobId','customer','applicantIndex','approvalId','caseSignature','caseRevision','jobRevision','leaseToken','portalChallengeId','contextId','owner','outboxMessageId','messageId','noticeMessageId','challengeRequestedAt','challengeExpiresAt','accountBinding','expiresAt']),
        lease: select(this.data().lease, ['jobId','customer','jobRevision','token']),
        configuredOwner: this.otpOwner()
      };
    };
    const originalBinding = hash(deliveryBinding());
    const bindingCurrent = () => { try { return hash(deliveryBinding()) === originalBinding; } catch { return false; } };
    let sendStarted = false;
    this.commit(() => { item.state = 'sending'; item.attempts++; item.updatedAt = this.now(); });
    const guard = () => { if (!bindingCurrent() || !this.messageCurrent(this.data().outbox[id])) throw Object.assign(Error('MESSAGE_SUPERSEDED'), {notDispatched: true}); };
    try {
      guard();
      sendStarted = true;
      const result = await this.send(item.recipient, clone(item.payload), guard, clone({id: item.id, kind: item.kind, customer: item.customer, caseId: this.case(item.customer).id, ...(item.jobId ? {jobId: item.jobId} : {}), ...(item.challengeId ? {challengeId: item.challengeId} : {}), ...(item.noticeMessageId ? {noticeMessageId: item.noticeMessageId} : {})}));
      // Expiry alone does not erase a real provider acceptance. Identity changes
      // do prohibit correlating that response with any replacement challenge.
      if (!bindingCurrent() || ownerPrompt && this.data().outbox[id]?.state !== 'sending') throw Error('OWNER_DELIVERY_BINDING_CHANGED');
      if (item.kind === 'owner_otp_request' && result?.paused === true && result.reason === 'owner_action_required') {
        const noticeMessageId = result.noticeMessageId || item.noticeMessageId;
        if (!providerMessageId(noticeMessageId) || item.noticeMessageId && noticeMessageId !== item.noticeMessageId) throw Error('OWNER_NOTICE_RESPONSE_INVALID');
        return this.commit(() => {
          item = this.data().outbox[id]; item.state = 'cancelled'; item.failure = 'DELIVERY_PAUSED'; item.pauseReason = 'owner_action_required'; item.ownerActionRequired = true; item.updatedAt = this.now();
          if (noticeMessageId) {
            item.noticeMessageId = noticeMessageId; item.noticeState ||= 'accepted'; item.noticeAcceptedAt ||= this.now();
            const challenge = this.data().challenges[item.challengeId];
            if (challenge?.state === 'pending' && challenge.jobId === item.jobId && challenge.customer === item.customer && challenge.owner === phone(item.recipient)) { challenge.noticeMessageId = noticeMessageId; challenge.noticeState ||= item.noticeState; }
          }
          return item;
        });
      }
      if (result?.dryRun === true || result?.paused === true || result?.notDispatched === true) throw Object.assign(Error('MESSAGE_NOT_DISPATCHED'), {notDispatched: true, reason: result?.paused === true ? 'DELIVERY_PAUSED' : 'DELIVERY_NOT_DISPATCHED'});
      const messageId = result?.messages?.[0]?.id || result?.messageId;
      if (!providerMessageId(messageId) || item.kind === 'owner_otp_request' && messageId === item.noticeMessageId) throw Error('DELIVERY_RESPONSE_INVALID');
      return this.commit(() => {
        item = this.data().outbox[id]; item.state = 'accepted'; item.messageId = messageId; item.updatedAt = this.now();
        if (item.challengeId && this.data().challenges[item.challengeId]?.state === 'pending') this.data().challenges[item.challengeId].messageId = messageId;
        return item;
      });
    } catch (error) {
      const changedAfterSend = sendStarted && (!bindingCurrent() || ownerPrompt && this.data().outbox[id]?.state !== 'sending');
      const status = Number(error?.status || error?.statusCode || String(error?.message || '').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);
      const outcome = changedAfterSend ? 'uncertain' : error?.notDispatched === true ? 'cancelled' : status >= 400 && status < 500 && status !== 408 ? 'failed' : 'uncertain';
      if (outcome === 'uncertain') this.uncertainMessageIds.add(id);
      return this.commit(() => {
        item = this.data().outbox[id] || (this.data().outbox[id] = clone(originalItem));
        item.state = outcome;
        if (changedAfterSend && originalItem.challengeId) { const original = this.data().challenges[originalItem.challengeId]; if (original && ['pending','consuming'].includes(original.state)) original.state = 'uncertain'; }
        const paused = error?.paused === true || ['DELIVERY_PAUSED', 'WINDOW_CLOSED', 'WHATSAPP_WINDOW_CLOSED'].includes(error?.code || error?.message);
        item.failure = item.state === 'cancelled' ? error?.reason || (paused ? 'DELIVERY_PAUSED' : 'MESSAGE_SUPERSEDED') : item.state === 'failed' ? 'PROVIDER_REJECTED' : 'DELIVERY_OUTCOME_UNCERTAIN';
        item.updatedAt = this.now(); return item;
      });
    }
  }
  recordDelivery(messageId, status) {
    if (!['sent', 'delivered', 'read', 'failed'].includes(status)) fail('VISA_DELIVERY_STATUS_INVALID', 400);
    const item = Object.values(this.data().outbox).find(record => record.messageId === messageId) || Object.values(this.data().outbox).find(record => record.noticeMessageId === messageId);
    if (!item) return null;
    if (item.noticeMessageId === messageId && item.messageId !== messageId) return this.commit(() => {
      if (item.noticeState !== 'delivered') { if (['delivered', 'read'].includes(status)) item.noticeState = 'delivered'; else if (status === 'failed') item.noticeState = 'failed'; }
      const challenge = this.data().challenges[item.challengeId];
      if (challenge?.noticeMessageId === messageId) challenge.noticeState = item.noticeState;
      item.updatedAt = this.now(); return item;
    });
    if (item.state === 'delivered' || status === 'sent' && item.state === 'accepted') return clone(item);
    return this.commit(() => { if (['delivered', 'read'].includes(status)) item.state = 'delivered'; else if (status === 'failed') { item.state = 'failed'; item.failure = 'PROVIDER_DELIVERY_FAILED'; } item.updatedAt = this.now(); return item; });
  }

  verifiedDocumentFacts(job, evidenceId) {
    let allowed = false;
    try { allowed = typeof this.canAutomate === 'function' && this.canAutomate(job.customer) === true; } catch {}
    if (!allowed) fail('VISA_DOCUMENT_AUTOMATION_PAUSED');
    const verify = require('./raad-visa-workflow').verifyMachineDossier;
    if (typeof verify !== 'function') fail('VISA_DOCUMENT_VERIFIER_REQUIRED', 503);
    const dossier = verify({store: this.store, mediaStore: this.mediaStore, mrzProfiles: this.mrzProfiles, customer: job.customer, applicantIndex: job.applicantIndex, expectedCaseSignature: job.caseSignature, evidenceId, now: this.now});
    if (!dossier?.ready || !/^[a-f0-9]{64}$/.test(dossier.evidenceFingerprint || '') || !object(dossier.fields) || !Object.keys(dossier.fields).length) fail('VISA_DOCUMENT_EVIDENCE_UNVERIFIED');
    const fields = {};
    for (const [field, value] of Object.entries(dossier.fields)) {
      if (!DOCUMENT_FACT_SET.has(field)) fail('VISA_DOCUMENT_FIELDS_INVALID', 400);
      fields[field] = validateAnswer(field, value);
    }
    const clientFieldsRequired = dossier.clientFieldsRequired || [];
    if (!Array.isArray(clientFieldsRequired) || clientFieldsRequired.length > 3 || new Set(clientFieldsRequired).size !== clientFieldsRequired.length || clientFieldsRequired.some(field => !CLIENT_DOCUMENT_FIELDS.has(field) || Object.hasOwn(fields, field))) fail('VISA_DOCUMENT_EVIDENCE_UNVERIFIED');
    return {...dossier, fields, clientFieldsRequired};
  }
  assertDocumentFactsCurrent(job) {
    if (!job.documentFacts) return null;
    const dossier = this.verifiedDocumentFacts(job, job.documentFacts.evidenceId);
    if (dossier.evidenceFingerprint !== job.documentFacts.evidenceFingerprint || documentFactsHash(dossier.fields) !== job.documentFacts.fieldsFingerprint || hash(dossier.clientFieldsRequired) !== hash(job.documentRequiredFields || [])) fail('VISA_DOCUMENT_EVIDENCE_STALE');
    if(job.staffDocumentSupplement){const supplement=job.staffDocumentSupplement,draft=this.store.data.raadApplications?.[job.customer]?.applicants?.[job.applicantIndex];if(!draft||draft.jobId!==supplement.draftJobId||draft.caseSignature!==job.caseSignature||hash({fields:Object.fromEntries(Object.entries(draft.fields||{}).filter(([field])=>DOCUMENT_FACT_SET.has(field))),documents:draft.documents})!==supplement.draftFingerprint||hash(Object.fromEntries(Object.keys(supplement.fields).map(field=>[field,draft.fields?.[field]])))!==supplement.fingerprint)fail('VISA_DOCUMENT_EVIDENCE_STALE');}
    return dossier;
  }
  stageDraftDocumentSupplement(jobId){
    const job=this.guardJob(jobId);if(!['queued','ready','awaiting_answers','needs_followup','awaiting_answer_confirmation'].includes(job.state)||this.data().lease?.jobId===jobId)fail('VISA_DOCUMENT_STAGE_IN_PROGRESS');
    const dossier=this.assertDocumentFactsCurrent(job),draft=this.store.data.raadApplications?.[job.customer]?.applicants?.[job.applicantIndex];
    if(!dossier||!draft||draft.caseId!==job.caseId||draft.caseSignature!==job.caseSignature||draft.documentAssistance?.evidenceId!==job.documentFacts.evidenceId||draft.documentAssistance?.evidenceFingerprint!==job.documentFacts.evidenceFingerprint)fail('VISA_DOCUMENT_EVIDENCE_UNVERIFIED');
    const fields={};for(const field of CLIENT_DOCUMENT_FIELDS)if(!Object.hasOwn(dossier.fields,field)&&Object.hasOwn(draft.fields||{},field)){const value=validateAnswer(field,draft.fields[field]);if(Object.hasOwn(job.confirmedFields,field)&&documentFactValue(field,job.confirmedFields[field])!==documentFactValue(field,value))fail('VISA_DOCUMENT_FACT_CONFLICT');if(Object.hasOwn(job.stagedFields||{},field)&&documentFactValue(field,job.stagedFields[field])!==documentFactValue(field,value))fail('VISA_DOCUMENT_FACT_CONFLICT');fields[field]=value;}
    const fingerprint=hash(fields),draftFingerprint=hash({fields:Object.fromEntries(Object.entries(draft.fields||{}).filter(([field])=>DOCUMENT_FACT_SET.has(field))),documents:draft.documents}),prior=job.staffDocumentSupplement;if(prior?.fingerprint===fingerprint&&prior.draftFingerprint===draftFingerprint)return {ok:true,duplicate:true};
    return this.commit(()=>{job.stagedFields={...clone(job.confirmedFields),...clone(job.stagedFields||{}),...clone(fields)};job.staffDocumentSupplement={draftJobId:draft.jobId,draftRevision:draft.revision,draftFingerprint,fields:clone(fields),fingerprint};this.audit('staff_document_supplement_staged',{customer:job.customer,jobId,evidenceId:job.documentFacts.evidenceId,fields:Object.keys(fields)});return {ok:true,duplicate:false};});
  }
  stageStaffAnswers(jobId) {
    const job=this.guardJob(jobId);
    if(!['queued','ready'].includes(job.state)||this.data().lease) return false;
    const collected=Object.values(this.store.data.visaStaffQuestions?.sessions||{}).filter(s=>s.jobId===job.id&&s.customer===job.customer&&s.caseSignature===job.caseSignature&&s.jobRevision===job.revision&&s.state==='answered'&&typeof s.answerMessageId==='string'&&s.answerMessageId.length>0&&s.answerMessageId.length<=500);
    const known=clone(job.confirmedFields),accepted=[];
    for(const s of collected){
      try{validateAnswer(s.field,fieldAt(job.confirmedFields,s.field));continue;}catch{}
      try{const value=validateAnswer(s.field,s.answer);if(accepted.includes(s.field)&&JSON.stringify(fieldAt(known,s.field))!==JSON.stringify(value))fail('VISA_STAFF_ANSWER_CONFLICT');setField(known,s.field,value);accepted.push(s.field);}catch(error){if(error.code==='VISA_STAFF_ANSWER_CONFLICT')throw error;}
    }
    if(!accepted.length)return false;
    const missing=[...new Set([...this.missingClientFields(job,known),...requiredQuestions(known,{requestedFields:['transport','arrivalPort']})])];
    this.commit(()=>{job.stagedFields=known;delete job.answerConfirmation;job.revision++;job.questions={};job.questionRevision=(job.questionRevision||0)+1;
      if(missing.length){job.state='needs_followup';job.followupFields=missing;}else this.queueAnswerSummary(job,known);
      this.audit('staff_client_answers_staged',{customer:job.customer,jobId:job.id,fields:[...new Set(accepted)]});return {ok:true};});
    if(missing.length)this.askQuestions(jobId,{fields:missing});
    return true;
  }
  missingClientFields(job, fields) {
    return [...new Set([...requiredQuestions(fields), ...requiredQuestions(fields, {requestedFields: [...(job.documentRequiredFields || []), ...(job.routingRequiredFields || [])]})])];
  }
  stageDocumentFacts(jobId, {fields, evidenceId} = {}) {
    const job = this.guardJob(jobId);
    if (!['queued', 'ready', 'awaiting_answers', 'needs_followup', 'awaiting_answer_confirmation'].includes(job.state) || this.data().lease?.jobId === jobId) fail('VISA_DOCUMENT_STAGE_IN_PROGRESS');
    if (typeof evidenceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(evidenceId)) fail('VISA_DOCUMENT_EVIDENCE_INVALID', 400);
    const dossier = this.verifiedDocumentFacts(job, evidenceId), verifiedFields = dossier.fields;
    if (fields !== undefined && (!object(fields) || Object.keys(fields).some(field => !DOCUMENT_FACT_SET.has(field)) || documentFactsHash(fields) !== documentFactsHash(verifiedFields))) fail('VISA_DOCUMENT_FIELDS_INVALID', 400);
    const fieldsFingerprint = documentFactsHash(verifiedFields);
    if (job.documentFacts?.evidenceId === evidenceId && job.documentFacts.evidenceFingerprint === dossier.evidenceFingerprint && job.documentFacts.fieldsFingerprint === fieldsFingerprint && hash(job.documentRequiredFields || []) === hash(dossier.clientFieldsRequired)) return clone({ok: true, duplicate: true, jobId, applicantIndex: job.applicantIndex, state: job.state, stagedFields: job.stagedFields || {}, clientFieldsRequired: dossier.clientFieldsRequired, documentEvidence: {id: evidenceId, evidenceFingerprint: dossier.evidenceFingerprint}});
    for (const [field, value] of Object.entries(verifiedFields)) {
      if (Object.hasOwn(job.confirmedFields, field) && documentFactValue(field, job.confirmedFields[field]) !== documentFactValue(field, value)) fail('VISA_DOCUMENT_FACT_CONFLICT');
      const staged = job.stagedFields?.[field];
      if (staged !== undefined && documentFactValue(field, staged) !== documentFactValue(field, value) && documentFactValue(field, staged) !== documentFactValue(field, job.documentFacts?.fields?.[field])) fail('VISA_DOCUMENT_FACT_CONFLICT');
    }
    return this.commit(() => {
      const staged = {...clone(job.confirmedFields), ...clone(job.stagedFields || {}), ...clone(verifiedFields)};
      for (const nested of ['health', 'guardian']) if (job.confirmedFields[nested] || job.stagedFields?.[nested]) staged[nested] = {...job.confirmedFields[nested], ...job.stagedFields?.[nested]};
      job.stagedFields = staged; job.documentFacts = {evidenceId, evidenceFingerprint: dossier.evidenceFingerprint, fieldsFingerprint, fields: clone(verifiedFields), stagedAt: this.now()};
      job.documentRequiredFields = [...dossier.clientFieldsRequired]; delete job.staffDocumentSupplement;
      job.questions = {}; job.questionRevision = (job.questionRevision || 0) + 1; job.revision++; job.state = 'queued'; delete job.summary; delete job.answerConfirmation;
      for (const item of Object.values(this.data().outbox)) if (item.jobId === jobId && item.state === 'pending' && ['applicant_question', 'applicant_answer_summary'].includes(item.kind)) { item.state = 'cancelled'; item.failure = 'DOCUMENT_FACTS_CHANGED'; item.updatedAt = this.now(); }
      this.audit('document_facts_staged', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, evidenceId, evidenceFingerprint: dossier.evidenceFingerprint, fields: Object.keys(verifiedFields)});
      return {ok: true, duplicate: false, jobId, applicantIndex: job.applicantIndex, state: job.state, stagedFields: job.stagedFields, clientFieldsRequired: dossier.clientFieldsRequired, documentEvidence: {id: evidenceId, evidenceFingerprint: dossier.evidenceFingerprint}};
    });
  }
  queueAnswerSummary(job, answers) {
    const documentEvidence = job.documentFacts ? {id: job.documentFacts.evidenceId, evidenceFingerprint: job.documentFacts.evidenceFingerprint} : null;
    const summary = {token: randomUUID(), questionRevision: job.questionRevision, caseRevision: job.caseRevision, answers: clone(answers), documentEvidence, createdAt: this.now()};
    job.summary = summary; job.state = 'awaiting_answer_confirmation';
    const answeredPaths = Object.keys(answers).flatMap(field => object(answers[field]) ? Object.keys(answers[field]).map(name => field + '.' + name) : [field]);
    const entries = answeredPaths.map(field => ({field, label: questionFor(field, {applicantIndex: job.applicantIndex}).prompt, value: fieldAt(answers, field), ...(fieldAt(answers, field) === null ? {displayValue: 'غير منطبق'} : {})}));
    this.enqueue({key: 'summary:' + summary.token, kind: 'applicant_answer_summary', customer: job.customer, recipient: job.customer, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId: job.id, questionRevision: job.questionRevision, payload: {type: 'answer_summary', text: `يرجى مراجعة إجابات المسافر ${job.applicantIndex + 1}. باختيار «أؤكد وأفوّض» تقر بما يلي: أؤكد صحة الإجابات وأفوّض شركة الرمال بتقديم طلب التأشيرة بهذه البيانات.`, token: summary.token, applicantIndex: job.applicantIndex, entries, options: [{id: 'confirm', label: 'أؤكد وأفوّض'}, {id: 'correct', label: 'أريد تصحيح الإجابات'}]}});
    return summary;
  }
  askQuestions(jobId, {fields, leaseToken} = {}) {
    const job = this.guardJob(jobId);
    this.assertDocumentFactsCurrent(job);
    const activeLease = this.data().lease;
    if (activeLease?.jobId === jobId && (activeLease.token !== leaseToken || activeLease.cancelled)) fail('VISA_BROWSER_LEASE_REQUIRED');
    // Staff-entered or document-extracted personal facts still require the
    // applicant's own answer. A draft's medical No is never client provenance.
    const known = {...job.confirmedFields, ...job.stagedFields};
    for (const nested of ['health', 'guardian']) if (job.confirmedFields[nested] || job.stagedFields?.[nested]) known[nested] = {...job.confirmedFields[nested], ...job.stagedFields?.[nested]};
    const candidates = fields || this.missingClientFields(job, known);
    if (!Array.isArray(candidates) || candidates.length > 40 || new Set(candidates).size !== candidates.length) fail('VISA_QUESTION_FIELDS_INVALID', 400);
    const requested = [];
    for (const field of candidates) {
      const definition = QUESTION_CATALOG[field];
      // Preserve an already confirmed answer across rounds. An explicit
      // applicant correction clears staged facts and remains a separate path.
      if (job.state!=='needs_followup') {try{validateAnswer(field,fieldAt(job.confirmedFields,field));continue;}catch{}}
      if (!definition) fail('VISA_QUESTION_UNKNOWN', 400);
      const dependency = definition.dependsOn;
      // Ask a controlling choice before its conditional free-text details.
      // Reasking that choice may make an old detail inapplicable.
      if (dependency && candidates.includes(dependency.field)) continue;
      if (dependency && fieldAt(known, dependency.field) !== dependency.value) {
        if (fieldAt(known, dependency.field) === undefined && !requested.includes(dependency.field)) requested.push(dependency.field);
        continue;
      }
      if (!requested.includes(field)) requested.push(field);
    }
    const person = this.case(job.customer).applicants[job.applicantIndex];
    const prepared = requested.map(field => questionFor(field, {applicantIndex: job.applicantIndex, applicantName: person.latinFirstName || person.name}));
    return this.commit(() => {
      if (activeLease?.jobId === jobId) this.data().lease = null;
      for (const challenge of Object.values(this.data().challenges)) if (challenge.jobId === jobId && ['pending', 'consuming'].includes(challenge.state)) challenge.state = 'cancelled';
      job.questionRevision = (job.questionRevision || 0) + 1; job.questions = {}; delete job.summary;
      job.revision++; job.state = prepared.length ? 'awaiting_answers' : 'ready';
      for (const definition of prepared) {
        const token = randomUUID(), question = {...definition, token, caseRevision: job.caseRevision, questionRevision: job.questionRevision, state: 'pending'};
        job.questions[token] = question;
        this.enqueue({key: 'question:' + token, kind: 'applicant_question', customer: job.customer, recipient: job.customer, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId, questionRevision: job.questionRevision, payload: {type: 'question', text: definition.prompt, token, field: definition.field, applicantIndex: job.applicantIndex, options: definition.options || []}});
      }
      if (!prepared.length && job.stagedFields && !job.answerConfirmation) this.queueAnswerSummary(job, job.stagedFields);
      this.audit('questions_requested', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, fields: requested});
      return {jobId, applicantIndex: job.applicantIndex, questionRevision: job.questionRevision, questions: Object.values(job.questions)};
    });
  }
  answerQuestion({sender, token, option, value} = {}) {
    const match = Object.values(this.data().jobs).find(job => Object.hasOwn(job.questions || {}, token));
    if (!match || sender !== match.customer) fail('VISA_ANSWER_CONTEXT_INVALID', 400);
    const job = this.guardJob(match.id), question = job.questions[token];
    this.assertDocumentFactsCurrent(job);
    if (job.state !== 'awaiting_answers' || question.questionRevision !== job.questionRevision || question.caseRevision !== job.caseRevision || question.state !== 'pending') fail('VISA_ANSWER_TOKEN_STALE');
    let answer;
    if (question.type === 'choice') {
      const selected = question.options.find(item => item.id === option);
      if (!selected || value !== undefined) fail('VISA_ANSWER_OPTION_INVALID', 400);
      answer = validateAnswer(question.field, selected.value);
    } else { if (option !== undefined) fail('VISA_ANSWER_OPTION_INVALID', 400); answer = validateAnswer(question.field, value); }
    return this.commit(() => {
      question.state = 'answered'; question.answer = answer; question.answeredAt = this.now();
      job.stagedFields ||= clone(job.confirmedFields);
      setField(job.stagedFields, question.field, answer);
      if (question.field === 'previousNationality' && answer === false) job.stagedFields.previousNationalityDetails = null;
      if (question.field === 'travelledLastFiveYears' && answer === false) job.stagedFields.travelHistory = null;
      if (Object.values(job.questions).every(item => item.state === 'answered')) {
        const answers = clone(job.stagedFields);
        for (const item of Object.values(job.questions)) setField(answers, item.field, item.answer);
        const required = requiredQuestions(answers, {requestedFields: Object.values(job.questions).map(item => item.field)});
        if (required.length) {
          job.state = 'needs_followup'; job.followupFields = required;
          return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, followupFields: required};
        }
        this.queueAnswerSummary(job, answers);
      }
      return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, state: job.state};
    });
  }
  confirmAnswers({sender, token, confirm, messageId} = {}) {
    const found = Object.values(this.data().jobs).find(job => job.summary?.token === token);
    if (!found || found.customer !== sender) fail('VISA_ANSWER_CONTEXT_INVALID', 400);
    const job = this.guardJob(found.id);
    this.assertDocumentFactsCurrent(job);
    if (job.state !== 'awaiting_answer_confirmation' || job.summary.questionRevision !== job.questionRevision || job.summary.caseRevision !== job.caseRevision) fail('VISA_ANSWER_TOKEN_STALE');
    if (confirm !== true) return this.commit(() => { job.state = 'needs_followup'; job.followupFields = Object.keys(job.summary.answers).flatMap(field => object(job.summary.answers[field]) ? Object.keys(job.summary.answers[field]).map(name => field + '.' + name) : [field]); delete job.summary; delete job.stagedFields; return {ok: true, state: job.state, followupFields: job.followupFields}; });
    const incomingMessageId = messageId === undefined ? null : text(messageId, 500);
    const answers = clone(job.summary.answers);
    return this.commit(() => { job.confirmedFields = answers; job.answerConfirmation = {at: this.now(), grantedAt: this.now(), granted: true, scope: 'saudi_visa_application', caseSignature: job.caseSignature, messageId: incomingMessageId, sender, questionRevision: job.questionRevision, documentEvidence: clone(job.summary.documentEvidence || null)}; job.state = 'ready'; job.revision++; delete job.summary; delete job.stagedFields; this.audit('applicant_answers_confirmed', {customer: job.customer, jobId: job.id, applicantIndex: job.applicantIndex, messageId: incomingMessageId, scope: 'saudi_visa_application', fields: Object.values(job.questions).map(item => item.field)}); return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, state: job.state}; });
  }
  getConfirmedFields(jobId) {
    const job = this.guardJob(jobId), fields = clone(job.confirmedFields), missing = this.missingClientFields(job, fields);
    this.assertDocumentFactsCurrent(job);
    const context = {jobId, jobRevision: job.revision, customer: job.customer, applicantIndex: job.applicantIndex, caseId: job.caseId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, fields, confirmation: job.answerConfirmation || null, documentEvidence: job.documentFacts ? {id: job.documentFacts.evidenceId, evidenceFingerprint: job.documentFacts.evidenceFingerprint} : null};
    return {...context, proof: hash(context), complete: Boolean(job.answerConfirmation) && missing.length === 0, missing};
  }

  handleCustomerMessage(sender, message = {}) {
    if (!phone(sender)) return {handled: false};
    const existing = message.id && this.data().cases[sender]?.handledMessages?.[message.id];
    if (existing) return clone(existing);
    let operation = null;
    if (object(message.visaAnswer)) operation = () => this.answerQuestion({...message.visaAnswer, sender});
    else if (object(message.visaConfirmation)) operation = () => this.confirmAnswers({...message.visaConfirmation, sender, messageId: message.id});
    else if (typeof message.text === 'string' && message.text.trim()) {
      const matchingMessage = message.contextId && Object.values(this.data().outbox).find(item => item.customer === sender && item.messageId === message.contextId && ['applicant_question', 'applicant_answer_summary'].includes(item.kind));
      if (matchingMessage) {
        if (matchingMessage.kind === 'applicant_question' && this.data().jobs[matchingMessage.jobId]?.questions[matchingMessage.payload.token]?.type === 'text') operation = () => this.answerQuestion({sender, token: matchingMessage.payload.token, value: message.text});
        else return {handled: true, reply: 'يرجى اختيار الإجابة من خيارات السؤال المرسل أو طلب تصحيح البيانات.'};
      } else if (!message.contextId) {
        const acceptedTokens = new Set(Object.values(this.data().outbox).filter(item => item.customer === sender && item.kind === 'applicant_question' && ['accepted', 'delivered'].includes(item.state)).map(item => item.payload.token));
        const pending = Object.values(this.data().jobs).filter(job => job.customer === sender && job.state === 'awaiting_answers').flatMap(job => Object.values(job.questions).filter(question => question.state === 'pending' && acceptedTokens.has(question.token)).map(question => ({job, question})));
        if (pending.length === 1 && pending[0].question.type === 'text') operation = () => this.answerQuestion({sender, token: pending[0].question.token, value: message.text});
      }
    }
    if (!operation) return {handled: false};
    let result;
    try {
      const outcome = operation();
      if (outcome.followupFields?.length) this.askQuestions(outcome.jobId, {fields: outcome.followupFields});
      result = {handled: true, ok: true, applicantIndex: outcome.applicantIndex, reply: outcome.followupFields?.length ? 'شكراً، نحتاج بعض التفاصيل الإضافية لهذا المسافر قبل عرض ملخص التأكيد.' : outcome.state === 'ready' ? 'تم تأكيد إجابات هذا المسافر واعتمادها لتجهيز الطلب.' : 'تم تسجيل إجابتك لهذا المسافر. يرجى إكمال الأسئلة ومراجعة ملخص الإجابات قبل اعتمادها.'};
    } catch (error) {
      const invalid = ['VISA_ANSWER_INVALID', 'VISA_ANSWER_OPTION_INVALID'].includes(error?.code);
      result = {handled: true, ok: false, error: invalid ? 'VISA_ANSWER_INVALID' : 'VISA_ANSWER_CONTEXT_STALE', reply: invalid ? 'لم نعتمد هذه الإجابة. يرجى الإجابة بالصيغة المطلوبة أو استخدام خيارات السؤال.' : 'هذه الإجابة مرتبطة بسؤال قديم أو بمعاملة متوقفة. لم نغيّر بيانات الطلب؛ يرجى انتظار السؤال الحالي.'};
    }
    if (message.id && typeof message.id === 'string' && message.id.length <= 500 && this.data().cases[sender]) this.commit(() => { const record = this.data().cases[sender]; record.handledMessages ||= {}; record.handledMessages[message.id] = result; const ids = Object.keys(record.handledMessages); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete record.handledMessages[id]; });
    return result;
  }

  otpOwner() { return supervisorWhatsAppRecipient(this.env); }
  requestOtp(jobId, {leaseToken, portalChallengeId, contextId, challengeRequestedAt, challengeExpiresAt, accountBinding} = {}) {
    const {job, lease} = this.guardLease(jobId, leaseToken), owner = this.otpOwner();
    if (!owner) fail('VISA_OTP_OWNER_NOT_CONFIGURED', 503);
    const portalContext = text(portalChallengeId, 200), context = text(contextId, 200);
    const binding = validateSmsChallenge({challengeId: portalContext, challengeRequestedAt, challengeExpiresAt, accountBinding}, this.now());
    if (Object.values(this.data().challenges).some(item => item.jobId === jobId && item.portalChallengeId === portalContext)) fail('VISA_OTP_ALREADY_REQUESTED');
    if (Object.values(this.data().challenges).some(item => item.jobId === jobId && item.state === 'pending' && item.expiresAt > this.now())) fail('VISA_OTP_ALREADY_PENDING');
    return this.commit(() => {
      const challenge = {id: randomUUID(), jobId, customer: job.customer, applicantIndex: job.applicantIndex, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobRevision: job.revision, leaseToken: lease.token, portalChallengeId: portalContext, contextId: context, owner, state: 'pending', attempts: 0, maxAttempts: 1, createdAt: this.now(), challengeRequestedAt: binding.challengeRequestedAt, challengeExpiresAt: binding.challengeExpiresAt, accountBinding: binding.accountBinding, expiresAt: binding.challengeExpiresAt};
      this.data().challenges[challenge.id] = challenge; job.state = 'waiting_otp';
      lease.expiresAt = Math.max(lease.expiresAt, challenge.expiresAt + 30000);
      const message = this.enqueue({key: 'otp:' + challenge.id, kind: 'owner_otp_request', customer: job.customer, recipient: owner, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId, challengeId: challenge.id, payload: {type: 'text', text: `رعد يحتاج رمز التحقق لمتابعة طلب المسافر ${job.applicantIndex + 1}. مرجع المتابعة: ${challenge.id.slice(0, 8)}. رد على هذه الرسالة برمز التحقق فقط قبل انتهاء صلاحية الرمز في الموعد الأصلي: ${new Date(binding.challengeExpiresAt).toISOString()} (UTC). التأخير لا يمدد صلاحية الرمز. لن يتم حفظ الرمز في سجل المحادثة.`}});
      challenge.outboxMessageId = message.id;
      return {challengeId: challenge.id, jobId, expiresAt: challenge.expiresAt, messageId: message.id};
    });
  }
  ownerChallengeContext(challengeId) {
    const challenge = this.data().challenges[challengeId];
    if (!challenge || challenge.state !== 'pending' || challenge.expiresAt <= this.now() || challenge.expiresAt !== challenge.challengeExpiresAt || challenge.owner !== this.otpOwner()) fail('OWNER_ACTION_CHALLENGE_STALE');
    validateSmsChallenge({...challenge, challengeId: challenge.portalChallengeId}, this.now());
    const {job, lease} = this.guardLease(challenge.jobId, challenge.leaseToken);
    if (job.state !== 'waiting_otp' || job.revision !== challenge.jobRevision || job.approvalId !== challenge.approvalId || job.caseSignature !== challenge.caseSignature || job.customer !== challenge.customer || job.applicantIndex !== challenge.applicantIndex || lease.jobId !== challenge.jobId) fail('OWNER_ACTION_CHALLENGE_STALE');
    const item = this.data().outbox[challenge.outboxMessageId];
    if (!item || item.kind !== 'owner_otp_request' || item.challengeId !== challengeId || item.jobId !== job.id || item.customer !== challenge.customer || phone(item.recipient) !== challenge.owner || item.approvalId !== job.approvalId || item.caseSignature !== job.caseSignature) fail('OWNER_ACTION_CHALLENGE_STALE');
    return {challenge, job, item};
  }
  openOwnerAction({sender, challengeId, contextId} = {}) {
    const reject = reason => ({handled: true, ok: false, reason});
    const owner = this.otpOwner();
    if (!owner || phone(sender) !== owner) return reject('OWNER_ACTION_SENDER_INVALID');
    if (typeof challengeId !== 'string' || !Object.hasOwn(this.data().challenges, challengeId) || !providerMessageId(contextId)) return reject('OWNER_ACTION_CONTEXT_INVALID');
    let context;
    try { context = this.ownerChallengeContext(challengeId); }
    catch { return reject('OWNER_ACTION_CHALLENGE_STALE'); }
    const {challenge, job, item} = context;
    if (!providerMessageId(challenge.noticeMessageId) || contextId !== challenge.noticeMessageId || item.noticeMessageId !== contextId) return reject('OWNER_ACTION_CONTEXT_INVALID');
    if (item.ownerAction?.confirmed && challenge.ownerAction?.confirmed && item.ownerAction.noticeMessageId === contextId && challenge.ownerAction.noticeMessageId === contextId) return {handled: true, ok: true, duplicate: true, jobId: job.id, challengeId, requeued: 0, messageIds: []};
    if (!['accepted', 'delivered'].includes(item.noticeState) || !['accepted', 'delivered'].includes(challenge.noticeState)) return reject('OWNER_ACTION_NOTICE_UNCONFIRMED');
    if (item.state !== 'cancelled' || item.failure !== 'DELIVERY_PAUSED' || item.pauseReason !== 'owner_action_required' || item.ownerActionRequired !== true) return reject('OWNER_ACTION_NOT_PAUSED');
    try { return this.commit(() => {
      const action = {confirmed: true, at: this.now(), owner, noticeMessageId: contextId};
      item.ownerAction = clone(action); challenge.ownerAction = clone(action); item.state = 'pending'; delete item.failure; item.updatedAt = this.now();
      this.audit('owner_action_confirmed', {customer: job.customer, jobId: job.id, challengeId});
      return {handled: true, ok: true, duplicate: false, jobId: job.id, challengeId, requeued: 1, messageIds: [item.id]};
    }); } catch { return reject('OWNER_ACTION_SAVE_FAILED'); }
  }
  // Call directly from the signed webhook BEFORE journaling/batching/models.
  // Interception does not authorize a sender, context, code or browser action.
  isOtpMessage({sender, contextId, text: raw} = {}) {
    const knownReply = providerMessageId(contextId) && Object.values(this.data().challenges).some(item => item.messageId === contextId || item.noticeMessageId === contextId);
    return Boolean(knownReply || phone(sender) === SUPERVISOR_WHATSAPP_NUMBER && typeof raw === 'string' && /[\d\u0660-\u0669\u06f0-\u06f9]{4,16}/u.test(raw));
  }
  async consumeOtp(input = {}) {
    let {sender, contextId, messageId, text: raw} = input, digits = '', normalized = '', handoff;
    if (!this.isOtpMessage({sender, contextId, text: raw})) return {handled: false};
    const reject = reason => ({handled: true, ok: false, reason});
    let lockedId;
    try {
      const owner = this.otpOwner();
      if (!owner || phone(sender) !== owner) return reject('OTP_SENDER_INVALID');
      if (!providerMessageId(contextId)) return reject('OTP_REPLY_CONTEXT_REQUIRED');
      if (!providerMessageId(messageId)) return reject('OTP_MESSAGE_ID_INVALID');
      const candidates = Object.values(this.data().challenges).filter(item => item.owner === owner && item.messageId === contextId && item.state === 'pending' && item.expiresAt > this.now());
      if (candidates.length !== 1) return reject(candidates.length ? 'OTP_CONTEXT_AMBIGUOUS' : 'OTP_NOT_PENDING');
      const challenge = candidates[0], id = challenge.id;
      if (this.otpLocks.has(id)) return reject('OTP_IN_PROGRESS');
      if (this.usedOtpChallenges.has(id)) return reject('OTP_ALREADY_USED');
      for (const map of [this.usedOtpDigests, this.usedOtpMessageIds]) for (const [key, expiry] of map) if (expiry <= this.now()) map.delete(key);
      if (this.usedOtpMessageIds.has(messageId)) return reject('OTP_MESSAGE_REPLAY_REJECTED');
      normalized = typeof raw === 'string' ? raw.replace(/[\u0660-\u0669]/gu, value => String(value.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/gu, value => String(value.charCodeAt(0) - 0x6f0)).trim() : '';
      // A code must be the complete reply, not extracted from unrelated prose.
      if (!/^\d{4,8}$/.test(normalized)) return reject('OTP_FORMAT_INVALID');
      digits = normalized;
      const replay = createHmac('sha256', this.otpDigestKey).update(owner + ':' + digits).digest('hex');
      if (this.usedOtpDigests.has(replay)) return reject('OTP_REPLAY_REJECTED');
      const snapshot = Object.freeze(Object.fromEntries(['id','jobId','customer','applicantIndex','approvalId','caseSignature','caseRevision','jobRevision','leaseToken','portalChallengeId','contextId','owner','messageId','outboxMessageId','challengeRequestedAt','challengeExpiresAt','accountBinding','expiresAt'].map(key => [key, challenge[key]])));
      const guardChallenge = () => {
        const current = this.data().challenges[id];
        if (!current || Object.entries(snapshot).some(([key, value]) => current[key] !== value) || current.owner !== this.otpOwner() || !['pending','consuming'].includes(current.state) || current.expiresAt !== current.challengeExpiresAt) fail('VISA_OTP_CONTEXT_STALE');
        validateSmsChallenge({...current, challengeId: current.portalChallengeId}, this.now());
        const {job, lease} = this.guardLease(current.jobId, current.leaseToken);
        const item = this.data().outbox[current.outboxMessageId];
        if (job.revision !== current.jobRevision || job.customer !== current.customer || job.applicantIndex !== current.applicantIndex || job.approvalId !== current.approvalId || job.caseSignature !== current.caseSignature || lease.token !== current.leaseToken || lease.jobId !== current.jobId || job.state !== 'waiting_otp' || !item || !['accepted','delivered'].includes(item.state) || item.messageId !== contextId || item.challengeId !== id || item.jobId !== job.id || phone(item.recipient) !== owner) fail('VISA_OTP_CONTEXT_STALE');
      };
      try { guardChallenge(); } catch { return reject('OTP_CASE_STALE'); }
      if (challenge.attempts >= 1 || typeof this.resumeOtp !== 'function') return reject(challenge.attempts >= 1 ? 'OTP_ALREADY_USED' : 'OTP_RESUME_UNAVAILABLE');
      // Reserve synchronously before the first await, including storage failures.
      lockedId = id; this.otpLocks.add(id); this.usedOtpChallenges.add(id);
      this.usedOtpMessageIds.set(messageId, challenge.expiresAt);
      this.usedOtpDigests.set(replay, this.now() + OTP_TTL);
      try {
        this.commit(() => { const current = this.data().challenges[id]; current.attempts = 1; current.state = 'consuming'; });
        guardChallenge();
        handoff = {jobId: snapshot.jobId, customer: snapshot.customer, applicantIndex: snapshot.applicantIndex, challengeId: id, portalChallengeId: snapshot.portalChallengeId, contextId: snapshot.contextId, challengeRequestedAt: snapshot.challengeRequestedAt, challengeExpiresAt: snapshot.challengeExpiresAt, accountBinding: snapshot.accountBinding, code: digits, guard: guardChallenge};
        const result = await this.resumeOtp(handoff);
        guardChallenge();
        const success = result?.ok === true || result?.accepted === true;
        return this.commit(() => {
          const current = this.data().challenges[id], job = this.job(current.jobId);
          current.state = success ? 'consumed' : 'exhausted';
          if (success) { current.consumedAt = this.now(); job.state = 'running'; }
          else { job.state = 'portal_review_required'; job.blockedReason = 'OTP_ATTEMPTS_EXHAUSTED'; }
          this.audit(success ? 'otp_resumed' : 'otp_rejected', {customer: current.customer, jobId: current.jobId, challengeId: id, attempt: 1});
          return {handled: true, ok: success, jobId: current.jobId, reason: success ? null : 'OTP_REJECTED'};
        });
      } catch {
        // Do not retry a possibly dispatched code, and never persist raw errors.
        try { this.commit(() => { const current = this.data().challenges[id]; if (current && ['pending','consuming'].includes(current.state)) current.state = 'uncertain'; const job = this.data().jobs[snapshot.jobId]; if (job && !terminal.has(job.state)) { job.state = 'portal_review_required'; job.blockedReason = 'OTP_RESUME_UNCERTAIN'; } }); } catch {}
        return reject('OTP_RESUME_UNCERTAIN');
      }
    } finally {
      if (handoff) handoff.code = '';
      if (input && typeof input === 'object') input.text = '';
      raw = ''; digits = ''; normalized = '';
      if (lockedId) this.otpLocks.delete(lockedId);
    }
  }

  recordPortalResult(jobId, {leaseToken, status, applicationReference, paymentAttempted, returnedFromPayment, requestCopy} = {}) {
    const previous = this.job(jobId);
    if (previous.state === 'saved_application') {
      if (status !== 'saved_application' || previous.applicationReference !== applicationReference || previous.requestCopy?.mediaId !== requestCopy?.mediaId || paymentAttempted !== false || returnedFromPayment !== true) fail('VISA_PORTAL_RESULT_CONFLICT');
      const message = Object.values(this.data().outbox).find(item => item.jobId === jobId && item.kind === 'application_request_copy');
      return clone({ok: true, duplicate: true, status: 'saved_application', visaIssued: false, governmentPaymentMade: false, job: previous, message});
    }
    const {job} = this.guardLease(jobId, leaseToken);
    this.assertDocumentFactsCurrent(job);
    if (status !== 'saved_application' || paymentAttempted !== false || returnedFromPayment !== true) fail('VISA_PORTAL_RESULT_UNSAFE', 400);
    if (job.state !== 'running' || !job.answerConfirmation || this.missingClientFields(job, job.confirmedFields).length) fail('VISA_CLIENT_FACTS_UNCONFIRMED');
    const reference = text(applicationReference, 150);
    const artifact = this.observeMedia(job.customer, requestCopy?.mediaId, this.artifactStore);
    if (artifact.mimeType !== 'application/pdf') fail('VISA_REQUEST_COPY_PDF_REQUIRED', 400);
    return this.commit(() => {
      job.state = 'saved_application'; job.revision++; job.applicationReference = reference; job.requestCopy = artifact; job.paymentAttempted = false; job.returnedFromPayment = true; job.savedAt = this.now(); this.data().lease = null;
      const message = this.enqueue({key: 'request-copy:' + job.id + ':' + artifact.sha256, kind: 'application_request_copy', customer: job.customer, recipient: job.customer, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId, payload: {type: 'document', mediaId: artifact.mediaId, filename: 'saudi-application-' + (job.applicantIndex + 1) + '.pdf', mimeType: 'application/pdf', caption: `تم حفظ نسخة طلب المسافر ${job.applicantIndex + 1}، رقم ${reference}. هذه نسخة طلب وليست تأشيرة صادرة. لم تُسدد الرسوم الحكومية من خلال هذه الخطوة، ولا نؤكد اكتمال التقديم الرسمي أو صدور التأشيرة.`}});
      this.audit('application_saved_without_payment', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, applicationReference: reference, artifactSha256: artifact.sha256});
      return {ok: true, status: 'saved_application', visaIssued: false, governmentPaymentMade: false, job, message};
    });
  }
}

module.exports = {VisaFulfilment, OTP_TTL, DOCUMENT_FACT_FIELDS};
