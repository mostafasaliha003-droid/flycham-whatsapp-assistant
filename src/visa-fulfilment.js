'use strict';

const {createHash, randomUUID} = require('node:crypto');
const {visaCaseSignature, currentVisaEvidence} = require('./visa-case-signature');
const {QUESTION_CATALOG, questionFor, validateAnswer, requiredQuestions} = require('./visa-client-questions');

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const phone = value => typeof value === 'string' && /^\+?\d{8,16}$/.test(value) ? value.replace(/^\+/, '') : null;
const terminal = new Set(['saved_application', 'manually_completed', 'stale', 'cancelled', 'portal_review_required']);
const OTP_TTL = 5 * 60000;
const DOCUMENT_FACT_FIELDS = Object.freeze(['nationalityCode', 'passportNumber', 'passportType', 'issuingCountryCode', 'issueDate', 'expiryDate', 'birthDate', 'birthPlace', 'sex', 'latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName', 'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName', 'emiratesId', 'residenceExpiry']);
const DOCUMENT_FACT_SET = new Set(DOCUMENT_FACT_FIELDS);
const CLIENT_DOCUMENT_FIELDS = new Set(['passportType', 'issueDate', 'birthPlace']);
function fail(code, statusCode = 409) { throw Object.assign(Error(code), {code, statusCode}); }
function text(value, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('VISA_VALUE_INVALID', 400);
  return value.trim();
}

function asciiDigits(value = '') {
  return String(value ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}
// Exact normalized country names only; do not guess from a partial sentence.
const COUNTRY_CODE_ALIASES = Object.freeze({
  'سوريا':'SYR','سوري':'SYR','سوريه':'SYR','syria':'SYR','syrian':'SYR',
  'مصر':'EGY','مصري':'EGY','مصريه':'EGY','egypt':'EGY','egyptian':'EGY',
  'الاردن':'JOR','اردن':'JOR','اردني':'JOR','اردنيه':'JOR','jordan':'JOR','jordanian':'JOR',
  'لبنان':'LBN','لبناني':'LBN','لبنانيه':'LBN','lebanon':'LBN','lebanese':'LBN',
  'فلسطين':'PSE','فلسطيني':'PSE','فلسطينيه':'PSE','palestine':'PSE','palestinian':'PSE',
  'العراق':'IRQ','عراق':'IRQ','عراقي':'IRQ','عراقيه':'IRQ','iraq':'IRQ','iraqi':'IRQ',
  'اليمن':'YEM','يمن':'YEM','يمني':'YEM','يمنيه':'YEM','yemen':'YEM','yemeni':'YEM',
  'السودان':'SDN','سودان':'SDN','سوداني':'SDN','سودانيه':'SDN','sudan':'SDN','sudanese':'SDN',
  'ليبيا':'LBY','ليبي':'LBY','ليبيه':'LBY','libya':'LBY','libyan':'LBY',
  'المغرب':'MAR','مغرب':'MAR','مغربي':'MAR','مغربيه':'MAR','morocco':'MAR','moroccan':'MAR',
  'تونس':'TUN','تونسي':'TUN','تونسيه':'TUN','tunisia':'TUN','tunisian':'TUN',
  'الجزائر':'DZA','جزائر':'DZA','جزائري':'DZA','جزائريه':'DZA','algeria':'DZA','algerian':'DZA',
  'موريتانيا':'MRT','موريتاني':'MRT','موريتانيه':'MRT','mauritania':'MRT','mauritanian':'MRT',
  'الامارات':'ARE','امارات':'ARE','اماراتي':'ARE','uae':'ARE','united arab emirates':'ARE',
  'السعوديه':'SAU','سعوديه':'SAU','سعودي':'SAU','saudi':'SAU','saudi arabia':'SAU',
  'تركيا':'TUR','تركي':'TUR','تركيه':'TUR','turkey':'TUR','turkish':'TUR',
  'باكستان':'PAK','باكستاني':'PAK','باكستانيه':'PAK','pakistan':'PAK','pakistani':'PAK',
  'الهند':'IND','هند':'IND','هندي':'IND','هنديه':'IND','india':'IND','indian':'IND',
  'بنغلاديش':'BGD','بنغلادش':'BGD','بنغالي':'BGD','bangladesh':'BGD','bangladeshi':'BGD'
});
function normalizeInboundQuestionValue(question = {}, value = '') {
  if (typeof value !== 'string') return value;
  // Do not normalize away invalid control characters or bypass catalog validation.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return value;
  const raw = value.trim(), ascii = asciiDigits(raw), format = question.format || question.inputType;
  if (format === 'date') {
    const ymd = ascii.match(/^(\d{4})(?:[/.\-]|\s+)(\d{1,2})(?:[/.\-]|\s+)(\d{1,2})$/);
    const dmy = ascii.match(/^(\d{1,2})(?:[/.\-]|\s+)(\d{1,2})(?:[/.\-]|\s+)(\d{4})$/);
    if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  // countryCode in the real catalog is ISO alpha-3, never a telephone prefix.
  if (format === 'countryCode') {
    const country=choiceText(raw);
    return Object.hasOwn(COUNTRY_CODE_ALIASES,country)?COUNTRY_CODE_ALIASES[country]:raw.toUpperCase();
  }
  if (format === 'country_code' && /^(?:\+|00)?\d{1,4}$/.test(ascii)) return ascii.replace(/^\+|^00/, '');
  if (format === 'passportNumber' || format === 'passport_number') return ascii.replace(/^(?:رقم\s*(?:الجواز|جواز\s*السفر)|جواز\s*رقم|جواز(?:\s*سفر)?|passport(?:\s*(?:number|no\.?))?)(?=\s|[:：#-])\s*[:：#-]?\s*/iu, '').replace(/\s+/g, '').toUpperCase();
  if (format === 'emiratesId') return ascii.replace(/^(?:رقم\s*(?:الهوي[ةه]|ال[اإ]قام[ةه]|[اإ]قام[ةه])|هويتي|الهوي[ةه](?:\s*ال[اإ]ماراتي[ةه])?|emirates\s*id|eid)(?=\s|[:：#-])\s*[:：#-]?\s*/iu, '').trim();
  if (format === 'phone_number') return ascii;
  if (format === 'latinName' || format === 'arabicName') return raw.replace(/\s+/g, ' ');
  return raw;
}
function choiceText(value) { return asciiDigits(value).normalize('NFKC').trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' '); }
const CHOICE_ALIASES = Object.freeze({
  yes: ['نعم','اي','ايوه','اجل','صح','موجود','لدي','عندي','yes','y','true'],
  no: ['لا','كلا','ما عندي','ماعندي','لا يوجد','مافي','ما في','ليس لدي','no','n','false'],
  single: ['اعزب','عازب','عزباء','غير متزوج','غير متزوجه','single','unmarried'],
  married: ['متزوج','متزوجه','married'], divorced: ['مطلق','مطلقه','divorced'],
  widowed: ['ارمل','ارمله','widowed','widow'], separated: ['منفصل','منفصله','separated'],
  male: ['ذكر','رجل','شاب','ولد','male','m'], female: ['انثى','امراه','بنت','سيده','female','f'],
  ordinary: ['عادي','عاديه','جواز عادي','ordinary','normal','regular'],
  diplomatic: ['دبلوماسي','دبلوماسيه','diplomatic'], service: ['خدمه','جواز خدمه','service'],
  special: ['خاص','جواز خاص','special'], travel_document: ['وثيقه','وثيقه سفر','travel document']
});
function matchChoiceOption(questionKey = '', options = [], value = '') {
  if (typeof value !== 'string' || value.length > 150 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  // These aliases are for factual questions only; authorization uses its bound button.
  if (options.some(o => ['confirm','correct'].includes(o.id))) return null;
  const clean = choiceText(value), index = clean.match(/^\d{1,2}$/);
  if (index && options[Number(clean) - 1]) return options[Number(clean) - 1];
  return options.find(o => clean === choiceText(o.label) || clean === choiceText(o.id)) ||
    options.find(o => (CHOICE_ALIASES[o.id === 'normal' ? 'ordinary' : o.id] || []).includes(clean)) || null;
}
function parseOperatorQuestionAnswer(question, rawValue) {
  if (question.type === 'choice') {
    const option = matchChoiceOption(question.field, question.options, rawValue);
    if (!option) fail('VISA_ANSWER_OPTION_INVALID', 400);
    return {option: option.id};
  }
  return {value: normalizeInboundQuestionValue(question, rawValue)};
}
function questionProgress(job, extra = 0) {
  const questions = Object.values(job.questions || {}), answered = questions.filter(q => q.state === 'answered').length;
  return {answered, total: questions.length + extra, remaining: questions.length + extra - answered};
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
  constructor({store, inbox, mediaStore, artifactStore, raad, send, resumeOtp, portal, canAutomate, now = Date.now, env = {}} = {}) {
    if (!store?.data || typeof store.save !== 'function') fail('VISA_STORE_REQUIRED', 500);
    Object.assign(this, {store, inbox, mediaStore, artifactStore: artifactStore || mediaStore, raad, send, resumeOtp, canAutomate, now, env});
    this.resumeOtp ||= typeof portal?.resumeOtp === 'function' ? portal.resumeOtp.bind(portal) : null;
    this.messageLocks = new Map();
    this.recipientLocks = new Map();
    this.otpLocks = new Set();
    this.usedOtpDigests = new Map(); // Process memory only; never serialize an OTP or its digest.
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
    this.migrateCoordination();
  }

  coordinationOwner() { return this.env.RAAD_COORDINATION_MODE === 'operator' ? phone(this.env.RAAD_COORDINATION_WHATSAPP || '971507993145') : null; }
  answerRecipient(job) { return job.coordination?.recipient || job.customer; }
  migrateCoordination() {
    const owner=this.coordinationOwner(); if(!owner)return;
    for(const item of Object.values(this.data().outbox))if(item.kind==='payment_confirmation'&&['pending','cancelled'].includes(item.state)&&item.payload?.type==='text')this.commit(()=>{item.payload.text='تم تأكيد استلام دفعتك، شكرًا إلك 🌷 عم نجهّز طلبك، ومنرسل لك رقم الطلب بعد إتمام التقديم.';});
    for(const job of Object.values(this.data().jobs)) {
      if(job.state==='portal_review_required'&&!job.coordination){this.commit(()=>{job.coordination={actor:'operator',recipient:owner,at:this.now()};});continue;}
      if(!['queued','ready','awaiting_answers','awaiting_answer_confirmation','needs_followup'].includes(job.state)||job.coordination?.recipient===owner)continue;
      try { this.guardJob(job.id); } catch { continue; }
      this.commit(()=>{
        job.coordination={actor:'operator',recipient:owner,at:this.now()};
        for(const item of Object.values(this.data().outbox))if(item.jobId===job.id&&['applicant_question','applicant_answer_summary'].includes(item.kind)&&['pending','cancelled'].includes(item.state)){item.state='cancelled';item.failure='COORDINATION_MOVED';}
        // Retain real answers, but require an explicit operator review. Never
        // manufacture a client message or medical declaration during migration.
        const staged={...job.confirmedFields,...job.stagedFields};
        for(const q of Object.values(job.questions||{}))if(q.state==='answered')setField(staged,q.field,q.answer);
        job.stagedFields=staged;job.questions={};delete job.summary;delete job.answerConfirmation;job.state='queued';job.revision++;
      });
    }
  }
  enqueueQuestion(job,question) {
    this.enqueue({key:'question:'+question.token,kind:'applicant_question',customer:job.customer,recipient:this.answerRecipient(job),approvalId:job.approvalId,caseSignature:job.caseSignature,caseRevision:job.caseRevision,jobId:job.id,questionRevision:job.questionRevision,coordination:job.coordination||null,payload:{type:'question',text:(job.coordination?'متابعة ملف العميل +'+job.customer+' — المسافر '+(job.applicantIndex+1)+'\nأجب بالمعلومة المتحقق منها فقط.\n':'')+question.prompt,token:question.token,field:question.field,applicantIndex:job.applicantIndex,options:question.options||[]}});
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
      const notification = this.enqueue({key: 'payment:' + customer + ':' + paymentFingerprint, kind: 'payment_confirmation', customer, recipient: customer, approvalId: approval.id, caseSignature: signature, caseRevision: approval.caseRevision, payload: {type: 'text', text: 'تم تأكيد استلام دفعتك، شكرًا إلك 🌷 عم نجهّز طلبك، ومنرسل لك رقم الطلب بعد إتمام التقديم.'}});
      const count = approvedCase.applicantCount;
      if (!Number.isSafeInteger(count) || count < 1 || count > 30 || approvedCase.applicants?.length !== count) fail('VISA_APPLICANTS_INCOMPLETE');
      const jobs = Array.from({length: count}, (_, applicantIndex) => {
        const job = {id: randomUUID(), customer, caseId: approvedCase.id, caseSignature: signature, caseRevision: approval.caseRevision, approvalId: approval.id, applicantIndex, revision: 1, state: 'queued', paymentNoticeId: notification.id, confirmedFields: {}, questions: {}, createdAt: this.now(), updatedAt: this.now()};
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
    if (this.coordinationOwner() && ['applicant_question','applicant_answer_summary'].includes(item.kind) && phone(item.recipient)!==this.coordinationOwner())return false;
    if (this.blocked(item.customer) || !this.approvalCurrent(item.customer, approval) || item.caseSignature !== visaCaseSignature(c)) return false;
    if (item.jobId) {
      const job = this.data().jobs[item.jobId];
      const manualDelivery=job?.manualCompletion&&['manual_application_reference','application_request_copy'].includes(item.kind)&&item.manualCompletionReference===job.manualCompletion.applicationReference&&item.manualCompletionReference===job.applicationReference;
      if (!job || ['stale', 'cancelled'].includes(job.state) || ['portal_review_required','manually_completed'].includes(job.state)&&!manualDelivery || item.questionRevision !== undefined && item.questionRevision !== job.questionRevision) return false;
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
    const prior = this.recipientLocks.get(item.recipient) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.performDispatch(id));
    this.messageLocks.set(id, work); this.recipientLocks.set(item.recipient, work);
    const done = () => { if (this.messageLocks.get(id) === work) this.messageLocks.delete(id); if (this.recipientLocks.get(item.recipient) === work) this.recipientLocks.delete(item.recipient); };
    work.then(done, done); return work;
  }
  async performDispatch(id) {
    let item = this.data().outbox[id];
    if (item.state !== 'pending') return clone(item);
    if (!this.messageCurrent(item)) return this.commit(() => { item.state = 'cancelled'; item.failure = 'MESSAGE_SUPERSEDED'; return item; });
    if (typeof this.send !== 'function') fail('VISA_SENDER_REQUIRED', 503);
    this.commit(() => { item.state = 'sending'; item.attempts++; item.updatedAt = this.now(); });
    const guard = () => { if (!this.messageCurrent(this.data().outbox[id])) throw Object.assign(Error('MESSAGE_SUPERSEDED'), {notDispatched: true}); };
    try {
      guard();
      const result = await this.send(item.recipient, clone(item.payload), guard, clone({id: item.id, kind: item.kind, customer: item.customer, ...(item.coordination?{coordination:item.coordination}:{}), caseId: this.case(item.customer).id, ...(item.jobId ? {jobId: item.jobId} : {}), ...(item.challengeId ? {challengeId: item.challengeId} : {}), ...(item.noticeMessageId ? {noticeMessageId: item.noticeMessageId} : {})}));
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
      if (typeof messageId !== 'string' || !messageId || messageId.length > 500 || item.kind === 'owner_otp_request' && messageId === item.noticeMessageId) throw Error('DELIVERY_RESPONSE_INVALID');
      return this.commit(() => {
        item = this.data().outbox[id]; item.state = 'accepted'; item.messageId = messageId; item.updatedAt = this.now();
        if (item.challengeId && this.data().challenges[item.challengeId]?.state === 'pending') this.data().challenges[item.challengeId].messageId = messageId;
        return item;
      });
    } catch (error) {
      return this.commit(() => {
        item = this.data().outbox[id];
        const status = Number(error?.status || error?.statusCode || String(error?.message || '').match(/^WHATSAPP_GRAPH_HTTP_(\d+)_/)?.[1]);
        item.state = error?.notDispatched === true ? 'cancelled' : status >= 400 && status < 500 && status !== 408 ? 'failed' : 'uncertain';
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
    const dossier = verify({store: this.store, mediaStore: this.mediaStore, customer: job.customer, applicantIndex: job.applicantIndex, expectedCaseSignature: job.caseSignature, evidenceId, now: this.now});
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
  missingClientFields(job, fields) {
    const portalFields=job.coordination?.actor==='operator'||this.coordinationOwner()?['latinFatherName','arabicFirstName','arabicFatherName','arabicFamilyName']:[];
    return [...new Set([...requiredQuestions(fields), ...requiredQuestions(fields, {requestedFields: [...(job.documentRequiredFields || []),...portalFields]})])];
  }
  stageDocumentFacts(jobId, {fields, evidenceId} = {}) {
    const job = this.guardJob(jobId);
    if (!['queued', 'ready', 'awaiting_answers', 'needs_followup', 'awaiting_answer_confirmation'].includes(job.state) || this.data().lease?.jobId === jobId) fail('VISA_DOCUMENT_STAGE_IN_PROGRESS');
    if (typeof evidenceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(evidenceId)) fail('VISA_DOCUMENT_EVIDENCE_INVALID', 400);
    const dossier = this.verifiedDocumentFacts(job, evidenceId), verifiedFields = dossier.fields;
    if (fields !== undefined && (!object(fields) || Object.keys(fields).some(field => !DOCUMENT_FACT_SET.has(field)) || documentFactsHash(fields) !== documentFactsHash(verifiedFields))) fail('VISA_DOCUMENT_FIELDS_INVALID', 400);
    const rawApplicant=this.store.data.visaDocumentIntake?.cases?.[job.customer]?.applicants?.find(app=>app.id===evidenceId&&app.applicantIndex===job.applicantIndex);
    const clientAnswers=require('./visa-document-client-answers').documentClientAnswers(this.store,job.customer,rawApplicant,this.now());
    for(const [field,value]of Object.entries(clientAnswers)){for(const known of [job.confirmedFields,job.stagedFields])if(Object.hasOwn(known||{},field)&&documentFactValue(field,known[field])!==documentFactValue(field,value))fail('VISA_DOCUMENT_FACT_CONFLICT');}
    const fieldsFingerprint = documentFactsHash(verifiedFields);
    if (job.documentFacts?.evidenceId === evidenceId && job.documentFacts.evidenceFingerprint === dossier.evidenceFingerprint && job.documentFacts.fieldsFingerprint === fieldsFingerprint && hash(job.documentRequiredFields || []) === hash(dossier.clientFieldsRequired)) return clone({ok: true, duplicate: true, jobId, applicantIndex: job.applicantIndex, state: job.state, stagedFields: job.stagedFields || {}, clientFieldsRequired: dossier.clientFieldsRequired, documentEvidence: {id: evidenceId, evidenceFingerprint: dossier.evidenceFingerprint}});
    for (const [field, value] of Object.entries(verifiedFields)) {
      if (Object.hasOwn(job.confirmedFields, field) && documentFactValue(field, job.confirmedFields[field]) !== documentFactValue(field, value)) fail('VISA_DOCUMENT_FACT_CONFLICT');
      const staged = job.stagedFields?.[field];
      if (staged !== undefined && documentFactValue(field, staged) !== documentFactValue(field, value) && documentFactValue(field, staged) !== documentFactValue(field, job.documentFacts?.fields?.[field])) fail('VISA_DOCUMENT_FACT_CONFLICT');
    }
    return this.commit(() => {
      const staged = {...clone(clientAnswers),...clone(job.confirmedFields), ...clone(job.stagedFields || {}), ...clone(verifiedFields)};
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
    this.enqueue({key: 'summary:' + summary.token, kind: 'applicant_answer_summary', customer: job.customer, recipient: this.answerRecipient(job), coordination:job.coordination||null, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId: job.id, questionRevision: job.questionRevision, payload: {type: 'answer_summary', text: job.coordination ? `مراجعة مسؤول المكتب لملف العميل +${job.customer} — المسافر ${job.applicantIndex+1}. أكّد المعلومات بعد التحقق منها ومن تفويض العميل. هذا اعتماد منك بصفتك مسؤول المكتب، وليس إقرارًا صادرًا من العميل.` : `يرجى مراجعة إجابات المسافر ${job.applicantIndex + 1}. باختيار «أؤكد وأفوّض» تقر بما يلي: أؤكد صحة الإجابات وأفوّض شركة الرمال بتقديم طلب التأشيرة بهذه البيانات.`, token: summary.token, applicantIndex: job.applicantIndex, entries, options: [{id: 'confirm', label: 'أؤكد وأفوّض'}, {id: 'correct', label: 'أريد تصحيح الإجابات'}]}});
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
      if(this.coordinationOwner())job.coordination={actor:'operator',recipient:this.coordinationOwner(),at:this.now()};
      job.questionRevision = (job.questionRevision || 0) + 1; job.questions = {}; delete job.summary;
      job.revision++; job.state = prepared.length ? 'awaiting_answers' : 'ready';
      for (const definition of prepared) {
        const token = randomUUID(), question = {...definition, token, caseRevision: job.caseRevision, questionRevision: job.questionRevision, state: 'pending'};
        job.questions[token] = question;
        if(!job.coordination || Object.keys(job.questions).length===1)this.enqueueQuestion(job,question);
      }
      if (!prepared.length && job.stagedFields && !job.answerConfirmation) this.queueAnswerSummary(job, job.stagedFields);
      this.audit('questions_requested', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, fields: requested});
      return {jobId, applicantIndex: job.applicantIndex, questionRevision: job.questionRevision, questions: Object.values(job.questions)};
    });
  }
  answerQuestion({sender, token, option, value} = {}) {
    const match = Object.values(this.data().jobs).find(job => Object.hasOwn(job.questions || {}, token));
    if (!match || phone(sender) !== this.answerRecipient(match)) fail('VISA_ANSWER_CONTEXT_INVALID', 400);
    const job = this.guardJob(match.id), question = job.questions[token];
    this.assertDocumentFactsCurrent(job);
    if (job.state !== 'awaiting_answers' || question.questionRevision !== job.questionRevision || question.caseRevision !== job.caseRevision || question.state !== 'pending') fail('VISA_ANSWER_TOKEN_STALE');
    let answer;
    if (question.type === 'choice') {
      const selected = question.options.find(item => item.id === option);
      if (!selected || value !== undefined) fail('VISA_ANSWER_OPTION_INVALID', 400);
      answer = validateAnswer(question.field, selected.value);
    } else { if (option !== undefined) fail('VISA_ANSWER_OPTION_INVALID', 400); answer = validateAnswer(question.field, normalizeInboundQuestionValue(question, value)); }
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
          return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, followupFields: required, progress: questionProgress(job, required.length)};
        }
        this.queueAnswerSummary(job, answers);
      }
      if(job.coordination&&job.state==='awaiting_answers'){const next=Object.values(job.questions).find(q=>q.state==='pending');if(next)this.enqueueQuestion(job,next);}
      return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, state: job.state, progress: questionProgress(job)};
    });
  }
  confirmAnswers({sender, token, confirm, messageId} = {}) {
    const found = Object.values(this.data().jobs).find(job => job.summary?.token === token);
    if (!found || this.answerRecipient(found) !== phone(sender)) fail('VISA_ANSWER_CONTEXT_INVALID', 400);
    const job = this.guardJob(found.id);
    this.assertDocumentFactsCurrent(job);
    if (job.state !== 'awaiting_answer_confirmation' || job.summary.questionRevision !== job.questionRevision || job.summary.caseRevision !== job.caseRevision) fail('VISA_ANSWER_TOKEN_STALE');
    if (confirm !== true) return this.commit(() => { job.state = 'needs_followup'; job.followupFields = Object.keys(job.summary.answers).flatMap(field => object(job.summary.answers[field]) ? Object.keys(job.summary.answers[field]).map(name => field + '.' + name) : [field]); delete job.summary; delete job.stagedFields; return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, state: job.state, followupFields: job.followupFields}; });
    const incomingMessageId = messageId === undefined ? null : text(messageId, 500);
    const answers = clone(job.summary.answers);
    return this.commit(() => { job.confirmedFields = answers; job.answerConfirmation = {at: this.now(), grantedAt: this.now(), granted: true, scope: 'saudi_visa_application', ...(job.coordination?{actor:'operator',representedCustomer:job.customer,verifiedAnswers:true}:{}), caseSignature: job.caseSignature, messageId: incomingMessageId, sender, questionRevision: job.questionRevision, documentEvidence: clone(job.summary.documentEvidence || null)}; job.state = 'ready'; job.revision++; delete job.summary; delete job.stagedFields; this.audit('applicant_answers_confirmed', {customer: job.customer, jobId: job.id, applicantIndex: job.applicantIndex, messageId: incomingMessageId, scope: 'saudi_visa_application', fields: Object.values(job.questions).map(item => item.field)}); return {ok: true, jobId: job.id, applicantIndex: job.applicantIndex, state: job.state}; });
  }
  getConfirmedFields(jobId) {
    const job = this.guardJob(jobId), fields = clone(job.confirmedFields), missing = this.missingClientFields(job, fields);
    this.assertDocumentFactsCurrent(job);
    const context = {jobId, jobRevision: job.revision, customer: job.customer, applicantIndex: job.applicantIndex, caseId: job.caseId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, fields, confirmation: job.answerConfirmation || null, documentEvidence: job.documentFacts ? {id: job.documentFacts.evidenceId, evidenceFingerprint: job.documentFacts.evidenceFingerprint} : null};
    return {...context, proof: hash(context), complete: Boolean(job.answerConfirmation) && missing.length === 0, missing};
  }

  recoverRecordedOperatorConfirmation() {
    const owner=this.coordinationOwner(),chat=owner&&this.store.data.conversationJournal?.customers?.[owner];
    if(!owner||!chat||!(chat.operatorOwned===true||this.inbox?.isOperatorOwned?.(owner)===true))return {recovered:false};
    const pending=Object.values(this.data().jobs).filter(j=>j.coordination?.recipient===owner&&j.state==='awaiting_answer_confirmation'&&j.summary&&!j.answerConfirmation);
    if(pending.length!==1)return {recovered:false};
    const job=pending[0],summary=job.summary;
    const sent=Object.values(this.data().outbox).find(i=>i.jobId===job.id&&i.kind==='applicant_answer_summary'&&i.payload?.token===summary.token&&phone(i.recipient)===owner&&['accepted','delivered'].includes(i.state)&&providerMessageId(i.messageId));
    if(!sent)return {recovered:false};
    const outbound=chat.messages?.find(m=>m.direction==='out'&&m.id===sent.messageId&&Number.isSafeInteger(m.seq));
    if(!outbound)return {recovered:false};
    const inbound=chat.messages.find(m=>m.direction==='in'&&m.text==='أؤكد صحة إجابات التأشيرة'&&m.status==='received'&&providerMessageId(m.id)&&m.seq>outbound.seq&&m.at>=outbound.at&&m.at>=summary.createdAt&&m.at<=this.now()&&this.now()-m.at<=2*3600000);
    if(!inbound)return {recovered:false};
    // Reconstruct only an unambiguous, actually received explicit office
    // confirmation. Never use a generic Yes, a chat claim, legacy imports,
    // another case's summary, or a fabricated provider message ID.
    const priorSummaries=Object.values(this.data().outbox).filter(i=>i.kind==='applicant_answer_summary'&&phone(i.recipient)===owner&&i.messageId).flatMap(i=>{const m=chat.messages.find(m=>m.direction==='out'&&m.id===i.messageId);return m&&m.seq<inbound.seq?[{item:i,seq:m.seq}]:[];}).sort((a,b)=>b.seq-a.seq);
    if(priorSummaries[0]?.item.id!==sent.id)return {recovered:false};
    try{
      this.guardJob(job.id);this.assertDocumentFactsCurrent(job);
      if(job.summary?.token!==summary.token||job.summary.questionRevision!==job.questionRevision)return {recovered:false};
      this.confirmAnswers({sender:owner,token:summary.token,confirm:true,messageId:inbound.id});
      this.commit(()=>{job.answerConfirmation.recoveredFrom={source:'explicit_operator_journal',summaryMessageId:sent.messageId,inboundSequence:inbound.seq};this.audit('operator_confirmation_recovered',{jobId:job.id,customer:job.customer,messageId:inbound.id});});
      console.info('[VISA_OPERATOR_CONFIRMATION_RECOVERED] '+JSON.stringify({caseHash:createHash('sha256').update(String(job.caseId)).digest('hex').slice(0,12),state:job.state}));
      return {recovered:true,jobId:job.id};
    }catch{return {recovered:false};}
  }
  handleOperatorMessage(message = {}) {
    const sender=phone(message.from);
    if(!sender||sender!==this.coordinationOwner())return {handled:false};
    const bound=Object.values(this.data().outbox).find(item=>item.coordination?.actor==='operator'&&phone(item.recipient)===sender&&(
      message.visaAnswer?.token===item.payload?.token||message.visaConfirmation?.token===item.payload?.token||message.contextId&&message.contextId===item.messageId));
    const pendingText=!message.contextId&&typeof message.text==='string'&&Object.values(this.data().jobs).some(job=>job.coordination?.recipient===sender&&job.state==='awaiting_answers'&&Object.values(job.questions||{}).some(q=>q.state==='pending'));
    if(!bound&&!message.visaAnswer&&!message.visaConfirmation&&!pendingText)return {handled:false};
    // The owner's sales-chat takeover is not the subject customer's pause.
    // guardJob still independently checks the actual customer and payment.
    const result=this.handleCustomerMessage(sender,message),job=bound&&this.data().jobs[bound.jobId];
    if(result.handled)console.info('[VISA_COORDINATION_INPUT] '+JSON.stringify({...(job?{caseHash:createHash('sha256').update(String(job.caseId)).digest('hex').slice(0,12),state:job.state}:{}),kind:message.visaConfirmation?'confirmation':message.visaAnswer?'choice':'text',outcome:result.ok===true?'accepted':result.error||'context_required'}));
    return result;
  }
  handleCustomerMessage(sender, message = {}) {
    if (!phone(sender)) return {handled: false};
    if(this.coordinationOwner()&&phone(sender)!==this.coordinationOwner()&&(message.visaAnswer||message.visaConfirmation))return {handled:true,ok:true,reply:'طلبك معنا، وعم نتابعه. منخبرك بأول تحديث.'};
    const existing = message.id && this.data().cases[sender]?.handledMessages?.[message.id];
    if (existing) return clone(existing);
    let operation = null, activeQuestion = null;
    if (object(message.visaAnswer)) {
      const job = Object.values(this.data().jobs).find(job => this.answerRecipient(job) === phone(sender) && Object.hasOwn(job.questions || {}, message.visaAnswer.token));
      activeQuestion = job?.questions[message.visaAnswer.token];
      operation = () => this.answerQuestion({...message.visaAnswer, sender});
    }
    else if (object(message.visaConfirmation)) operation = () => this.confirmAnswers({...message.visaConfirmation, sender, messageId: message.id});
    else if (typeof message.text === 'string' && message.text.trim()) {
      const matchingMessage = message.contextId && Object.values(this.data().outbox).find(item => phone(item.recipient) === phone(sender) && item.messageId === message.contextId && ['applicant_question', 'applicant_answer_summary'].includes(item.kind));
      if (matchingMessage) {
        if (matchingMessage.kind === 'applicant_question' && ['accepted','delivered'].includes(matchingMessage.state) && this.data().jobs[matchingMessage.jobId]?.questions[matchingMessage.payload.token]) { activeQuestion = this.data().jobs[matchingMessage.jobId].questions[matchingMessage.payload.token]; operation = () => this.answerQuestion({sender, token: matchingMessage.payload.token, ...parseOperatorQuestionAnswer(activeQuestion, message.text)}); }
        else return {handled: true, reply: 'يرجى اختيار الإجابة من خيارات السؤال المرسل أو طلب تصحيح البيانات.'};
      } else if (!message.contextId) {
        const acceptedTokens = new Set(Object.values(this.data().outbox).filter(item => phone(item.recipient) === phone(sender) && item.kind === 'applicant_question' && ['accepted', 'delivered'].includes(item.state)).map(item => item.payload.token));
        const pending = Object.values(this.data().jobs).filter(job => this.answerRecipient(job) === phone(sender) && job.state === 'awaiting_answers').flatMap(job => Object.values(job.questions).filter(question => question.state === 'pending' && acceptedTokens.has(question.token)).map(question => ({job, question})));
        if (pending.length === 1) { activeQuestion = pending[0].question; operation = () => this.answerQuestion({sender, token: activeQuestion.token, ...parseOperatorQuestionAnswer(activeQuestion, message.text)}); }
      }
    }
    if (!operation) return this.coordinationOwner()===phone(sender)&&Object.values(this.data().jobs).some(job=>job.coordination?.recipient===phone(sender)&&['awaiting_answers','awaiting_answer_confirmation'].includes(job.state))&&typeof message.text==='string'&&message.text.trim()?{handled:true,ok:false,reply:'حتى أربط إجابتك بالملف الصحيح، اضغط «رد» على سؤال رعد المطلوب وأرسل إجابتك، أو اختار من أزرار السؤال.'}:{handled: false};
    let result;
    try {
      const outcome = operation();
      if (outcome.followupFields?.length) this.askQuestions(outcome.jobId, {fields: outcome.followupFields});
      result = {handled: true, ok: true, progress: outcome.progress, applicantIndex: outcome.applicantIndex, reply: outcome.followupFields?.length ? 'شكراً إلك 🌷 نحتاج بعض التفاصيل الإضافية لهذا المسافر قبل عرض ملخص التأكيد.' : outcome.state === 'ready' ? 'تم تأكيد إجابات هذا المسافر واعتمادها لتجهيز الطلب 🌷' : 'تم تسجيل إجابتك لهذا المسافر 🌷 يرجى إكمال الأسئلة ومراجعة ملخص الإجابات قبل اعتمادها.'};
      if (outcome.progress) {
        const rem=outcome.progress.remaining;
        const remCopy=rem===0?'اكتملت الإجابات ✅':rem===1?'بقي سؤال واحد':rem===2?'بقي سؤالان':rem<=10?`بقي ${rem} أسئلة`:`بقي ${rem} سؤالاً`;
        result.reply += `\nالأسئلة الحالية: تم إنجاز ${outcome.progress.answered} من ${outcome.progress.total} — ${remCopy}.`;
      }
    } catch (error) {
      const invalid = ['VISA_ANSWER_INVALID', 'VISA_ANSWER_OPTION_INVALID'].includes(error?.code);
      result = {handled: true, ok: false, error: invalid ? 'VISA_ANSWER_INVALID' : 'VISA_ANSWER_CONTEXT_STALE', reply: invalid ? 'لم نعتمد هذه الإجابة بعد 🌷 يرجى الإجابة بالصيغة المطلوبة أو استخدام خيارات السؤال.' : 'هذه الإجابة مرتبطة بسؤال قديم أو بمعاملة متوقفة. لم نغيّر بيانات الطلب؛ يرجى انتظار السؤال الحالي.'};
      if (invalid && activeQuestion?.format === 'date') result.reply = 'التاريخ المدخل غير صالح 🌷 اكتبه يوم/شهر/سنة (مثال: 15/05/1990) أو 1990-05-15، ومنسجّله بعد التحقق من صحته.';
      else if (invalid && activeQuestion?.format === 'latinName') result.reply = 'كرمال نسجّل الاسم بشكل صحيح، اكتبه بالأحرف الإنجليزية (اللاتينية) كما هو مكتوب في جواز السفر 🌷';
      else if (invalid && activeQuestion?.format === 'arabicName') result.reply = 'كرمال نسجّل الاسم بشكل صحيح، اكتبه بالأحرف العربية كما هو مثبت في المستندات 🌷';
      else if (invalid && activeQuestion?.format === 'emiratesId') result.reply = 'رقم الهوية الإماراتية غير صالح 🌷 اكتب الرقم المكوّن من 15 خانة والذي يبدأ بـ 784 كما هو على الهوية.';
      else if (invalid && ['passportNumber','passport_number'].includes(activeQuestion?.format)) result.reply = 'يرجى إرسال رقم الجواز بالأحرف الإنجليزية والأرقام فقط بدون رموز إضافية كما هو في الجواز 🌷';
      else if (invalid && activeQuestion?.format === 'countryCode') result.reply = 'يرجى كتابة اسم الدولة (مثل: سوريا، مصر، الأردن) أو رمزها المكون من 3 أحرف (مثل: SYR).';
      else if (invalid && activeQuestion?.type === 'choice') result.reply = 'اختار من قائمة السؤال، أو اكتب رقم الإجابة أو اسمها:\n' + activeQuestion.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n');
    }
    if (message.id && typeof message.id === 'string' && message.id.length <= 500 && this.data().cases[sender]) this.commit(() => { const record = this.data().cases[sender]; record.handledMessages ||= {}; record.handledMessages[message.id] = result; const ids = Object.keys(record.handledMessages); for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete record.handledMessages[id]; });
    return result;
  }

  otpOwner() { return phone(this.env.RAAD_OTP_OWNER_WHATSAPP || this.env.RAAD_OTP_OWNER_RECIPIENT); }
  requestOtp(jobId, {leaseToken, portalChallengeId, contextId, ttlMs = OTP_TTL} = {}) {
    const {job, lease} = this.guardLease(jobId, leaseToken), owner = this.otpOwner();
    if (!owner) fail('VISA_OTP_OWNER_NOT_CONFIGURED', 503);
    const portalContext = text(portalChallengeId, 200), context = text(contextId, 200);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > OTP_TTL) fail('VISA_OTP_TTL_INVALID', 400);
    if (Object.values(this.data().challenges).some(item => item.jobId === jobId && item.state === 'pending' && item.expiresAt > this.now())) fail('VISA_OTP_ALREADY_PENDING');
    return this.commit(() => {
      const challenge = {id: randomUUID(), jobId, customer: job.customer, applicantIndex: job.applicantIndex, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobRevision: job.revision, leaseToken: lease.token, portalChallengeId: portalContext, contextId: context, owner, state: 'pending', attempts: 0, maxAttempts: 3, createdAt: this.now(), expiresAt: this.now() + ttlMs};
      this.data().challenges[challenge.id] = challenge; job.state = 'waiting_otp';
      lease.expiresAt = Math.max(lease.expiresAt, challenge.expiresAt + 30000);
      const message = this.enqueue({key: 'otp:' + challenge.id, kind: 'owner_otp_request', customer: job.customer, recipient: owner, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId, challengeId: challenge.id, payload: {type: 'text', text: `رعد يحتاج رمز التحقق لمتابعة طلب المسافر ${job.applicantIndex + 1}. مرجع المتابعة: ${challenge.id.slice(0, 8)}. رد على هذه الرسالة برمز التحقق فقط قبل انتهاء صلاحية الرمز. لن يتم حفظ الرمز في سجل المحادثة.`}});
      challenge.outboxMessageId = message.id;
      return {challengeId: challenge.id, jobId, expiresAt: challenge.expiresAt, messageId: message.id};
    });
  }
  ownerChallengeContext(challengeId) {
    const challenge = this.data().challenges[challengeId];
    if (!challenge || challenge.state !== 'pending' || challenge.expiresAt <= this.now() || challenge.owner !== this.otpOwner()) fail('OWNER_ACTION_CHALLENGE_STALE');
    const {job, lease} = this.guardLease(challenge.jobId, challenge.leaseToken);
    if (job.state !== 'waiting_otp' || job.revision !== challenge.jobRevision || job.approvalId !== challenge.approvalId || job.caseSignature !== challenge.caseSignature || lease.jobId !== challenge.jobId) fail('OWNER_ACTION_CHALLENGE_STALE');
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
  // Call directly from the webhook BEFORE journaling/batching/model processing.
  // All owner messages containing only OTP digits are consumed, even if rejected.
  isOtpMessage({sender, contextId, text: raw} = {}) {
    if (!this.otpOwner() || phone(sender) !== this.otpOwner() || typeof raw !== 'string') return false;
    return /[\d\u0660-\u0669\u06f0-\u06f9]{4,16}/u.test(raw) || Boolean(contextId && Object.values(this.data().challenges).some(item => item.owner === this.otpOwner() && item.messageId === contextId));
  }
  async consumeOtp({sender, contextId, text: raw} = {}) {
    if (!this.isOtpMessage({sender, contextId, text: raw})) return {handled: false};
    const reject = reason => ({handled: true, ok: false, reason});
    const owner = this.otpOwner();
    let candidates = Object.values(this.data().challenges).filter(item => item.owner === owner && item.state === 'pending' && item.messageId && item.expiresAt > this.now());
    if (contextId) candidates = candidates.filter(item => item.messageId === contextId);
    if (candidates.length !== 1) return reject(candidates.length ? 'OTP_CONTEXT_AMBIGUOUS' : 'OTP_NOT_PENDING');
    const challenge = candidates[0], id = challenge.id;
    if (this.otpLocks.has(id)) return reject('OTP_IN_PROGRESS');
    const normalized = raw.replace(/[\u0660-\u0669]/gu, value => String(value.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/gu, value => String(value.charCodeAt(0) - 0x6f0));
    const matches = normalized.match(/(?<!\d)\d{4,8}(?!\d)/gu) || [];
    const digits = matches.length === 1 ? matches[0] : '';
    if (!/^\d{4,8}$/.test(digits)) return reject('OTP_FORMAT_INVALID');
    const replay = hash(owner + ':' + digits);
    for (const [digest, expiresAt] of this.usedOtpDigests) if (expiresAt <= this.now()) this.usedOtpDigests.delete(digest);
    if (this.usedOtpDigests.has(replay)) return reject('OTP_REPLAY_REJECTED');
    const guardChallenge = () => {
      const {job, lease} = this.guardLease(challenge.jobId, challenge.leaseToken);
      if (challenge.jobRevision !== job.revision || lease.token !== challenge.leaseToken || !['pending', 'consuming'].includes(challenge.state) || job.state !== 'waiting_otp') fail('VISA_OTP_CONTEXT_STALE');
    };
    try { guardChallenge(); }
    catch { return reject('OTP_CASE_STALE'); }
    if (challenge.attempts >= challenge.maxAttempts || typeof this.resumeOtp !== 'function') return reject(challenge.attempts >= challenge.maxAttempts ? 'OTP_ATTEMPTS_EXHAUSTED' : 'OTP_RESUME_UNAVAILABLE');
    this.otpLocks.add(id); this.usedOtpDigests.set(replay, this.now() + OTP_TTL);
    try {
      this.commit(() => { challenge.attempts++; challenge.state = 'consuming'; });
      // The only path receiving the code is the exact browser challenge adapter.
      // Neither callback return data nor callback exception text is persisted.
      const result = await this.resumeOtp({jobId: challenge.jobId, customer: challenge.customer, applicantIndex: challenge.applicantIndex, challengeId: id, portalChallengeId: challenge.portalChallengeId, contextId: challenge.contextId, code: digits, guard: guardChallenge});
      guardChallenge();
      const success = result?.ok === true || result?.accepted === true;
      return this.commit(() => {
        const current = this.data().challenges[id], job = this.job(current.jobId);
        current.state = success ? 'consumed' : current.attempts >= current.maxAttempts ? 'exhausted' : 'pending';
        if (success) { current.consumedAt = this.now(); job.state = 'running'; }
        else if (current.state === 'exhausted') { job.state = 'portal_review_required'; job.blockedReason = 'OTP_ATTEMPTS_EXHAUSTED'; }
        this.audit(success ? 'otp_resumed' : 'otp_rejected', {customer: current.customer, jobId: current.jobId, challengeId: id, attempt: current.attempts});
        return {handled: true, ok: success, jobId: current.jobId, reason: success ? null : 'OTP_REJECTED'};
      });
    } catch {
      return this.commit(() => { const current = this.data().challenges[id]; current.state = 'uncertain'; const job = this.job(current.jobId); if (!terminal.has(job.state)) { job.state = 'portal_review_required'; job.blockedReason = 'OTP_RESUME_UNCERTAIN'; } return reject('OTP_RESUME_UNCERTAIN'); });
    } finally { this.otpLocks.delete(id); }
  }

  manualCompletionCurrent(job) {
    const c=this.case(job.customer);
    return job.caseId===c.id && job.caseSignature===visaCaseSignature(c) &&
      job.manualCompletion?.actor==='employee' && job.manualCompletion.applicationReference===job.applicationReference &&
      /^[A-Z]{0,3}[0-9]{3,20}$/.test(job.applicationReference||'');
  }
  queueManualDelivery(job) {
    if(!this.manualCompletionCurrent(job)||['stale','cancelled'].includes(job.state))return;
    this.enqueue({key:'manual-reference:'+job.id+':'+job.applicationReference,kind:'manual_application_reference',customer:job.customer,recipient:job.customer,approvalId:job.approvalId,caseSignature:job.caseSignature,caseRevision:job.caseRevision,jobId:job.id,manualCompletionReference:job.applicationReference,payload:{type:'text',text:`تم تقديم طلبك برقم ${job.applicationReference} ✅
رح نتابع طلبك، وأول ما تصدر التأشيرة بنبعتها إلك مباشرة.`}});
    if(!job.requestCopy&&!job.manualCopy)job.manualCopy={state:'pending',attempts:0};job.manualDeliveryQueued=true;
  }
  syncManualDelivery() {
    for(const job of Object.values(this.data().jobs))if(this.manualCompletionCurrent(job)&&!job.manualDeliveryQueued)this.commit(()=>this.queueManualDelivery(job));
  }
  retryManualCopy(jobId,input) {
    const job=this.job(jobId);
    if(!object(input)||Object.keys(input).sort().join(',')!=='applicationReference,caseId'||!this.manualCompletionCurrent(job)||input.caseId!==job.caseId||input.applicationReference!==job.applicationReference||job.requestCopy||job.state!=='portal_review_required'||this.data().lease?.jobId===jobId||job.manualCopy?.state!=='failed'||job.manualCopy.attempts>=3)fail('MANUAL_COPY_RETRY_UNAVAILABLE');
    return this.commit(()=>{job.state='manually_completed';job.manualCopy.state='pending';delete job.blockedReason;return{manualCopyQueued:true};});
  }
  acquireManualCopy(jobId) {
    const job=this.job(jobId);
    if(!this.manualCompletionCurrent(job)||job.state!=='manually_completed'||job.requestCopy||job.manualCopy?.state!=='pending'||(job.manualCopy.attempts||0)>=3)fail('MANUAL_COPY_UNAVAILABLE');
    return this.commit(()=>{
      job.state='ready';const acquired=this.acquireJob(jobId,{workerId:'raad-print-only',ttlMs:30*60000});
      job.manualCopy={state:'running',attempts:(job.manualCopy.attempts||0)+1,startedAt:this.now()};return acquired;
    });
  }
  recordManualCopy(jobId,{leaseToken,applicationReference,mediaId}={}) {
    const {job}=this.guardLease(jobId,leaseToken);
    if(!this.manualCompletionCurrent(job)||applicationReference!==job.applicationReference||job.manualCopy?.state!=='running')fail('MANUAL_COPY_CONTEXT_STALE');
    const raw=this.store.data.visaMedia?.[mediaId],artifact=this.observeMedia(job.customer,mediaId,this.artifactStore);
    if(artifact.mimeType!=='application/pdf'||raw?.purpose!=='raad_application_copy'||raw.jobId!==jobId||raw.applicationReference!==applicationReference)fail('MANUAL_COPY_BINDING_INVALID');
    return this.commit(()=>{
      job.requestCopy=artifact;job.state='manually_completed';job.manualCopy.state='completed';job.manualCopy.completedAt=this.now();job.revision++;delete job.blockedReason;this.data().lease=null;
      const message=this.enqueue({key:'manual-copy:'+job.id+':'+artifact.sha256,kind:'application_request_copy',customer:job.customer,recipient:job.customer,approvalId:job.approvalId,caseSignature:job.caseSignature,caseRevision:job.caseRevision,jobId,manualCompletionReference:applicationReference,payload:{type:'document',mediaId:artifact.mediaId,filename:'saudi-application-'+applicationReference+'.pdf',mimeType:'application/pdf',caption:'نسخة طلبك رقم '+applicationReference}});
      this.audit('manual_request_copy_ready',{customer:job.customer,jobId,applicationReference,artifactSha256:artifact.sha256});return{ok:true,message};
    });
  }

  reportManualCompletion(jobId, input) {
    const job = this.job(jobId), c = this.case(job.customer);
    if (!object(input) || Object.keys(input).sort().join(',') !== 'applicationReference,caseId' ||
        input.caseId !== c.id || job.caseId !== c.id || job.caseSignature !== visaCaseSignature(c) ||
        typeof input.applicationReference !== 'string' || !/^[A-Z]{0,3}[0-9]{3,20}$/.test(input.applicationReference) ||
        job.applicationReference !== input.applicationReference) fail('MANUAL_COMPLETION_CONTEXT_STALE');
    if (job.state === 'manually_completed' && job.manualCompletion?.applicationReference === input.applicationReference)
      return {ok: true, manualCompletionRecorded: true, duplicate: true};
    if (job.state !== 'portal_review_required' || job.portalSaved !== true || this.data().lease?.jobId === jobId)
      fail('MANUAL_COMPLETION_UNAVAILABLE');
    return this.commit(() => {
      job.manualCompletion = {actor: 'employee', at: this.now(), applicationReference: input.applicationReference};
      job.state = 'manually_completed'; job.revision++; job.updatedAt = this.now(); delete job.blockedReason;
      for (const item of Object.values(this.data().outbox)) if (item.jobId === jobId && ['pending', 'paused', 'waiting_owner'].includes(item.state)) { item.state = 'cancelled'; item.failure = 'MANUALLY_COMPLETED'; }
      for (const challenge of Object.values(this.data().challenges)) if (challenge.jobId === jobId && ['pending', 'consuming'].includes(challenge.state)) challenge.state = 'cancelled';
      this.queueManualDelivery(job);
      this.audit('manual_completion_reported', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, applicationReference: input.applicationReference, actor: 'employee'});
      return {ok: true, manualCompletionRecorded: true, duplicate: false};
    });
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
      const message = this.enqueue({key: 'request-copy:' + job.id + ':' + artifact.sha256, kind: 'application_request_copy', customer: job.customer, recipient: job.customer, approvalId: job.approvalId, caseSignature: job.caseSignature, caseRevision: job.caseRevision, jobId, payload: {type: 'document', mediaId: artifact.mediaId, filename: 'saudi-application-' + (job.applicantIndex + 1) + '.pdf', mimeType: 'application/pdf', caption: `تم تسجيل طلب التأشيرة برقم ${reference} ✅
رح نتابع طلبك، وأول ما تصدر التأشيرة بنبعتها إلك مباشرة.`}});
      this.audit('application_saved_without_payment', {customer: job.customer, jobId, applicantIndex: job.applicantIndex, applicationReference: reference, artifactSha256: artifact.sha256});
      return {ok: true, status: 'saved_application', visaIssued: false, governmentPaymentMade: false, job, message};
    });
  }
}

module.exports = {asciiDigits, normalizeInboundQuestionValue, matchChoiceOption, VisaFulfilment, OTP_TTL, DOCUMENT_FACT_FIELDS};
