'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {visaCaseSignature} = require('../src/visa-case-signature');

const CUSTOMER = '15550001001', OWNER = '15550001999', OTHER = '15550001002';
const RECEIPT = '4bcb3aaa-67be-405b-854e-ebc4f962bc00', PDF = 'c444dc53-ab4e-4f46-9e6a-4f080ab1d742';
function fixture({send, resumeOtp, count = 2, canAutomate} = {}) {
  let at = 1000000, claimed = true, saves = 0, paymentCalls = 0, sends = 0;
  const c = {id: 'case-example', revision: 3, policyVersion: 'example', applicantCount: count, applicants: Array.from({length: count}, (_, index) => ({nationality: 'مصر', latinFirstName: index ? 'Bela' : 'Ari', latinFamilyName: 'Example'})), quote: {total: 240, currency: 'AED'}, documents: [], paymentStatus: 'awaiting_verification', submissionStatus: 'not_submitted'};
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {[RECEIPT]: {id: RECEIPT, customer: CUSTOMER, mimeType: 'image/png', size: 120, checksum: 'a'.repeat(64), expiresAt: at + 10000000}, [PDF]: {id: PDF, customer: CUSTOMER, mimeType: 'application/pdf', size: 450, checksum: 'b'.repeat(64), expiresAt: at + 10000000}}, conversationJournal: {customers: {[CUSTOMER]: {}}}, complaints: []}, save() { saves++; }};
  const mediaStore = {get(id, {customer}) { const record = store.data.visaMedia[id]; if (!record || customer !== record.customer) throw Error('NOT_FOUND'); return structuredClone(record); }};
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false, updateVisa(customer, input) {
    assert.equal(customer, CUSTOMER); assert.equal(input.action, 'confirm_payment'); paymentCalls++;
    c.staffVerification ||= {}; c.staffVerification.payment = {amount: input.amount, reference: input.reference, actor: 'staff', verifiedAt: at, caseSignature: visaCaseSignature(c)};
    c.paymentStatus = 'verified'; c.revision++; store.save();
  }};
  const drafts = new Map(), applied = [];
  const raad = {get(customer, {applicantIndex}) { assert.equal(customer, CUSTOMER); return structuredClone(drafts.get(applicantIndex) || {revision: 0, fields: {}}); }, prepare(customer, input) { assert.equal(customer, CUSTOMER); const old = drafts.get(input.applicantIndex) || {revision: 0, fields: {}}; assert.equal(input.expectedRevision, old.revision); const next = {revision: old.revision + 1, fields: {...old.fields, ...structuredClone(input.fields)}}; drafts.set(input.applicantIndex, next); applied.push(structuredClone(input)); return next; }};
  const options = {store, inbox, mediaStore, raad, now: () => at, env: {RAAD_OTP_OWNER_WHATSAPP: '+' + OWNER}, canAutomate, send: send || (async (recipient, payload, guard) => { guard(); sends++; return {messages: [{id: 'outbound-' + sends}]}; }), resumeOtp};
  const service = new VisaFulfilment(options);
  const input = (patch = {}) => ({receiptId: RECEIPT, amount: 240, reference: 'BANK-EXAMPLE-8', actor: {id: 'accountant-example', role: 'accountant'}, actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(c), idempotencyKey: 'accountant-key-1', ...patch});
  const receive = () => service.receiveReceipt(CUSTOMER, {receiptId: RECEIPT});
  const approve = () => { receive(); return service.confirmPayment(CUSTOMER, input()); };
  const activate = async () => { const approval = approve(); claimed = false; await service.dispatchMessage(approval.jobs[0].paymentNoticeId); return approval; };
  return {service, options, store, c, inbox, mediaStore, input, receive, approve, activate, drafts, applied, tick: ms => { at += ms; }, claim: value => { claimed = value; }, stats: () => ({saves, paymentCalls, sends})};
}
const throwsCode = (run, code) => assert.throws(run, error => error.code === code || error.message === code);

test('receipt only is not payment; accountant approval uses existing financial action and creates independent jobs', () => {
  const f = fixture(); f.receive(); assert.equal(f.c.paymentStatus, 'awaiting_verification'); assert.equal(f.stats().paymentCalls, 0);
  const result = f.service.confirmPayment(CUSTOMER, f.input());
  assert.equal(f.stats().paymentCalls, 1); assert.equal(result.jobs.length, 2); assert.notEqual(result.jobs[0].id, result.jobs[1].id);
  assert.deepEqual(result.jobs.map(job => job.applicantIndex), [0, 1]); assert.equal(result.approval.actualReceived, true); assert.equal(result.approval.receiptSha256, 'a'.repeat(64));
  assert.equal(f.service.pendingMessages().length, 1); assert.equal(f.service.pendingMessages()[0].recipient, CUSTOMER);
  assert.match(f.service.pendingMessages()[0].payload.text, /إسماعيل/); assert.match(f.service.pendingMessages()[0].payload.text, /لا يعني صدور/);
});

test('accountant role, claim, actual received, exact quote and current revision protect approval', () => {
  const f = fixture(); f.receive();
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({actor: {id: 'sales-example', role: 'sales'}})), 'ACCOUNTANT_REQUIRED');
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({actualReceived: false})), 'ACTUAL_PAYMENT_CONFIRMATION_REQUIRED');
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({amount: 239.99})), 'INVALID_PAYMENT');
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({expectedRevision: 2})), 'VISA_CASE_REVISION_CONFLICT');
  f.claim(false); throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input()), 'CLAIM_REQUIRED');
  assert.equal(f.stats().paymentCalls, 0);
});

test('receipt hash, customer ownership and changed quote invalidate approval', () => {
  const f = fixture(); f.receive();
  f.store.data.visaMedia[RECEIPT].customer = OTHER;
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input()), 'VISA_MEDIA_UNAVAILABLE');
  f.store.data.visaMedia[RECEIPT].customer = CUSTOMER; f.store.data.visaMedia[RECEIPT].checksum = 'c'.repeat(64);
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input()), 'VISA_RECEIPT_STALE');
  f.store.data.visaMedia[RECEIPT].checksum = 'a'.repeat(64); f.c.quote.total = 260;
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({amount: 260})), 'VISA_RECEIPT_STALE');
});

test('repeated approval is idempotent; a changed reference with same key conflicts', () => {
  const f = fixture(), first = f.approve();
  const again = f.service.confirmPayment(CUSTOMER, f.input());
  assert.equal(again.duplicate, true); assert.equal(again.approval.id, first.approval.id); assert.equal(f.stats().paymentCalls, 1); assert.equal(Object.keys(f.service.data().jobs).length, 2);
  throwsCode(() => f.service.confirmPayment(CUSTOMER, f.input({reference: 'DIFFERENT'})), 'VISA_IDEMPOTENCY_CONFLICT');
});

test('a save failure after staff verification can adopt the exact existing payment on retry', () => {
  const f = fixture(); f.receive(); const save = f.store.save; let failNext = false;
  const update = f.inbox.updateVisa; f.inbox.updateVisa = (...args) => { update(...args); failNext = true; };
  f.store.save = () => { if (failNext) { failNext = false; throw Error('DISK_EXAMPLE'); } save(); };
  assert.throws(() => f.service.confirmPayment(CUSTOMER, f.input()), /DISK_EXAMPLE/);
  assert.equal(f.c.paymentStatus, 'verified');
  const result = f.service.confirmPayment(CUSTOMER, f.input());
  assert.equal(result.ok, true); assert.equal(f.stats().paymentCalls, 1); assert.equal(Object.keys(f.service.data().jobs).length, 2);
});

test('job cannot start until Ismail confirmation has provider acceptance', async () => {
  const f = fixture(), result = f.approve(); f.claim(false);
  throwsCode(() => f.service.acquireJob(result.jobs[0].id, {workerId: 'worker-example'}), 'VISA_PAYMENT_NOTICE_UNCONFIRMED');
  const sent = await f.service.dispatchMessage(result.jobs[0].paymentNoticeId); assert.equal(sent.state, 'accepted');
  assert.equal(f.service.acquireJob(result.jobs[0].id, {workerId: 'worker-example'}).job.state, 'running');
});

test('serial browser lease prevents two applicants using one browser', async () => {
  const f = fixture(), result = await f.activate(), first = f.service.acquireJob(result.jobs[0].id, {workerId: 'worker-one'});
  throwsCode(() => f.service.acquireJob(result.jobs[1].id, {workerId: 'worker-two'}), 'VISA_BROWSER_BUSY');
  throwsCode(() => f.service.releaseJob(result.jobs[0].id, {leaseToken: 'wrong'}), 'VISA_BROWSER_LEASE_INVALID');
  f.service.releaseJob(result.jobs[0].id, {leaseToken: first.lease.token});
  assert.equal(f.service.acquireJob(result.jobs[1].id, {workerId: 'worker-two'}).job.applicantIndex, 1);
});

test('expired browser lease requires acknowledgement before another job can acquire it', async () => {
  const f = fixture(), result = await f.activate(), first = f.service.acquireJob(result.jobs[0].id, {workerId: 'worker-one', ttlMs: 1000}); f.tick(1001);
  throwsCode(() => f.service.acquireJob(result.jobs[1].id, {workerId: 'worker-two'}), 'VISA_BROWSER_REVIEW_REQUIRED');
  assert.ok(f.service.data().lease); assert.equal(f.service.job(first.job.id).state, 'portal_review_required');
  f.service.releaseJob(first.job.id, {leaseToken: first.lease.token});
  assert.equal(f.service.acquireJob(result.jobs[1].id, {workerId: 'worker-two'}).job.applicantIndex, 1);
});

test('core fact changes invalidate approvals, jobs, outstanding questions and messages', async () => {
  const f = fixture(), result = await f.activate();
  const asked = f.service.askQuestions(result.jobs[0].id, {fields: ['maritalStatus']});
  f.c.applicants[0].latinFirstName = 'Changed'; f.c.revision++;
  throwsCode(() => f.service.answerQuestion({sender: CUSTOMER, token: asked.questions[0].token, option: 'single'}), 'VISA_JOB_STALE');
  assert.equal(f.service.job(result.jobs[0].id).state, 'stale'); assert.equal(f.service.get(CUSTOMER).approval.state, 'stale');
  assert.equal(f.service.pendingMessages().length, 0);
});

for (const reason of ['complaint', 'block', 'human', 'custom']) test(`${reason} stops queued automation`, async () => {
  let permitted = true;
  const f = fixture({canAutomate: () => permitted}), result = await f.activate();
  if (reason === 'complaint') f.store.data.complaints.push({customer: CUSTOMER, state: 'pending'});
  if (reason === 'block') f.store.data.conversationJournal.customers[CUSTOMER].blocked = true;
  if (reason === 'human') f.claim(true);
  if (reason === 'custom') permitted = false;
  throwsCode(() => f.service.acquireJob(result.jobs[0].id, {workerId: 'worker-example'}), reason === 'human' ? 'HUMAN_OWNERSHIP' : 'VISA_JOB_STALE');
  if (reason === 'human') assert.equal(f.service.get(CUSTOMER).approval.state, 'approved');
});

test('delivery timeout is uncertain and never automatically resends', async () => {
  let sends = 0;
  const f = fixture({send: async () => { sends++; throw Error('timeout with private provider details'); }}), result = f.approve(); f.claim(false);
  const first = await f.service.dispatchMessage(result.jobs[0].paymentNoticeId), second = await f.service.dispatchMessage(first.id);
  assert.equal(first.state, 'uncertain'); assert.equal(second.state, 'uncertain'); assert.equal(sends, 1);
  assert.doesNotMatch(JSON.stringify(f.store.data), /private provider/);
});

test('accepted messages become delivered from provider events without a second send', async () => {
  const f = fixture(), result = await f.activate(), item = f.service.data().outbox[result.jobs[0].paymentNoticeId];
  assert.equal(f.service.recordDelivery(item.messageId, 'delivered').state, 'delivered');
  assert.equal(f.service.recordDelivery(item.messageId, 'sent').state, 'delivered');
  await f.service.dispatchMessage(item.id); assert.equal(f.stats().sends, 1);
});

test('final dispatch guard stops a message superseded while waiting in transport queue', async () => {
  const f = fixture({send: async (_recipient, _payload, guard) => { f.c.applicants[0].latinFirstName = 'Material change'; f.c.revision++; guard(); throw Error('unreachable'); }}), result = f.approve(); f.claim(false);
  const sent = await f.service.dispatchMessage(result.jobs[0].paymentNoticeId);
  assert.equal(sent.state, 'cancelled');
});

test('client answers bind token to applicant and sender, stage before confirmation, and never default medical No', async () => {
  const f = fixture(), result = await f.activate(), job = result.jobs[1];
  const asked = f.service.askQuestions(job.id, {fields: ['health.hospitalizedOrEmergency', 'maritalStatus']});
  assert.equal(asked.applicantIndex, 1); assert.equal(f.service.job(job.id).confirmedFields.health, undefined);
  const health = asked.questions[0], marital = asked.questions[1];
  throwsCode(() => f.service.answerQuestion({sender: OTHER, token: health.token, option: 'no'}), 'VISA_ANSWER_CONTEXT_INVALID');
  throwsCode(() => f.service.answerQuestion({sender: CUSTOMER, token: health.token, value: false}), 'VISA_ANSWER_OPTION_INVALID');
  f.service.answerQuestion({sender: CUSTOMER, token: health.token, option: 'yes'});
  throwsCode(() => f.service.answerQuestion({sender: CUSTOMER, token: health.token, option: 'no'}), 'VISA_ANSWER_TOKEN_STALE');
  f.service.answerQuestion({sender: CUSTOMER, token: marital.token, option: 'married'});
  assert.equal(f.applied.length, 0); const summary = f.service.job(job.id).summary;
  f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true});
  assert.equal(f.applied.length, 0); const confirmed = f.service.getConfirmedFields(job.id); assert.equal(confirmed.applicantIndex, 1); assert.equal(confirmed.fields.health.hospitalizedOrEmergency, true); assert.equal(confirmed.confirmation.sender, CUSTOMER);
  assert.equal(f.service.job(result.jobs[0].id).confirmedFields.health, undefined);
});

test('affirmative answers request details and preserve both answers through summary confirmation', async () => {
  const f = fixture(), result = await f.activate(), job = result.jobs[0];
  const first = f.service.askQuestions(job.id, {fields: ['previousNationality']});
  const response = f.service.answerQuestion({sender: CUSTOMER, token: first.questions[0].token, option: 'yes'});
  assert.deepEqual(response.followupFields, ['previousNationalityDetails']);
  const second = f.service.askQuestions(job.id, {fields: response.followupFields});
  f.service.answerQuestion({sender: CUSTOMER, token: second.questions[0].token, value: 'Example prior nationality'});
  const summary = f.service.job(job.id).summary;
  assert.equal(summary.answers.previousNationality, true); assert.equal(summary.answers.previousNationalityDetails, 'Example prior nationality');
  f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true});
  assert.equal(f.service.getConfirmedFields(job.id).fields.previousNationality, true);
});

test('reissued question invalidates old option token and old unsent message', async () => {
  const f = fixture(), result = await f.activate(), job = result.jobs[0];
  const first = f.service.askQuestions(job.id, {fields: ['performUmrah']});
  f.service.askQuestions(job.id, {fields: ['performUmrah']});
  throwsCode(() => f.service.answerQuestion({sender: CUSTOMER, token: first.questions[0].token, option: 'no'}), 'VISA_ANSWER_CONTEXT_INVALID');
  const oldMessage = Object.values(f.service.data().outbox).find(x => x.payload.token === first.questions[0].token);
  assert.equal((await f.service.dispatchMessage(oldMessage.id)).state, 'cancelled');
});

async function otpFixture(options = {}) {
  const f = fixture(options), result = await f.activate(), work = f.service.acquireJob(result.jobs[0].id, {workerId: 'otp-worker'});
  const request = f.service.requestOtp(work.job.id, {leaseToken: work.lease.token, portalChallengeId: 'portal-challenge-example', contextId: 'form-login-example'});
  const notification = await f.service.dispatchMessage(request.messageId);
  return {...f, work, request, notification};
}

test('OTP only resumes exact owner, accepted message context and exact pending applicant', async () => {
  const calls = [], f = await otpFixture({resumeOtp: async input => { calls.push(input); input.guard(); return {ok: true}; }});
  assert.deepEqual(await f.service.consumeOtp({sender: OTHER, text: '381642'}), {handled: false});
  assert.equal((await f.service.consumeOtp({sender: OWNER, contextId: 'unrelated-message', text: '381642'})).reason, 'OTP_NOT_PENDING');
  const result = await f.service.consumeOtp({sender: '+' + OWNER, contextId: f.notification.messageId, text: '381642'});
  assert.equal(result.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].jobId, f.work.job.id); assert.equal(calls[0].code, '381642');
  assert.equal(calls[0].portalChallengeId, 'portal-challenge-example'); assert.equal(calls[0].contextId, 'form-login-example');
  assert.doesNotMatch(JSON.stringify(f.store.data), /381642/);
  assert.equal((await f.service.consumeOtp({sender: OWNER, text: '381642'})).reason, 'OTP_NOT_PENDING');
});

test('OTP expiry and unsupported context are consumed without leaking code into durable data', async () => {
  const f = await otpFixture({resumeOtp: async () => { throw Error('must not run'); }}); f.tick(5 * 60000 + 1);
  const result = await f.service.consumeOtp({sender: OWNER, text: '761904'});
  assert.equal(result.handled, true); assert.equal(result.ok, false); assert.equal(result.reason, 'OTP_NOT_PENDING');
  assert.doesNotMatch(JSON.stringify(f.store.data), /761904/);
});

test('OTP rejects replay and caps rejected browser attempts without storing code or error text', async () => {
  let calls = 0;
  const f = await otpFixture({resumeOtp: async () => { calls++; return {ok: false, privateCode: 'never persist me'}; }});
  assert.equal((await f.service.consumeOtp({sender: OWNER, text: '817203'})).reason, 'OTP_REJECTED');
  assert.equal((await f.service.consumeOtp({sender: OWNER, text: '817203'})).reason, 'OTP_REPLAY_REJECTED');
  await f.service.consumeOtp({sender: OWNER, text: '817204'}); await f.service.consumeOtp({sender: OWNER, text: '817205'});
  assert.equal(calls, 3); assert.equal(f.service.job(f.work.job.id).state, 'portal_review_required');
  assert.doesNotMatch(JSON.stringify(f.store.data), /817203|817204|817205|never persist me/);
});

test('OTP adapter exception is uncertain and never stores callback error or code', async () => {
  const f = await otpFixture({resumeOtp: async ({code}) => { throw Error('provider leaked ' + code); }});
  assert.equal((await f.service.consumeOtp({sender: OWNER, text: '290471'})).reason, 'OTP_RESUME_UNCERTAIN');
  assert.equal(f.service.job(f.work.job.id).state, 'portal_review_required'); assert.doesNotMatch(JSON.stringify(f.store.data), /290471|provider leaked/);
});

test('concurrent OTP replies cannot resume a challenge twice', async () => {
  let finish, calls = 0;
  const f = await otpFixture({resumeOtp: async () => { calls++; return await new Promise(resolve => { finish = resolve; }); }});
  const first = f.service.consumeOtp({sender: OWNER, text: '610392'});
  const second = await f.service.consumeOtp({sender: OWNER, text: '610393'});
  assert.equal(second.handled, true); assert.equal(second.ok, false); finish({ok: true}); assert.equal((await first).ok, true); assert.equal(calls, 1);
});

test('restart interrupts browser lease/OTP and preserves uncertain message state', async () => {
  const f = await otpFixture({resumeOtp: async () => ({ok: true})});
  const pending = f.service.pendingMessages(); assert.equal(pending.length, 0);
  const paymentMessage = f.service.data().outbox[f.work.job.paymentNoticeId]; paymentMessage.state = 'sending';
  const restarted = new VisaFulfilment(f.options);
  assert.equal(restarted.job(f.work.job.id).state, 'portal_review_required'); assert.equal(restarted.data().lease, null);
  assert.equal(restarted.data().challenges[f.request.challengeId].state, 'interrupted'); assert.equal(restarted.data().outbox[paymentMessage.id].state, 'uncertain');
  assert.equal((await restarted.consumeOtp({sender: OWNER, text: '743102'})).reason, 'OTP_NOT_PENDING');
});

test('saved application requires Return, no payment, exact customer PDF, and sends honest request-copy caption', async () => {
  const f = fixture(), result = await f.activate(), asked = f.service.askQuestions(result.jobs[0].id);
  for (const question of asked.questions) {
    if (question.type === 'choice') f.service.answerQuestion({sender: CUSTOMER, token: question.token, option: question.field === 'maritalStatus' ? 'single' : question.field === 'sex' ? 'male' : question.field === 'gccResident' ? 'yes' : 'no'});
    else f.service.answerQuestion({sender: CUSTOMER, token: question.token, value: question.field === 'latinFirstName' ? 'Ari' : question.field === 'latinFamilyName' ? 'Example' : question.field === 'birthPlace' ? 'Example City' : 'Example Hotel, Riyadh'});
  }
  f.service.confirmAnswers({sender: CUSTOMER, token: f.service.job(result.jobs[0].id).summary.token, confirm: true});
  const work = f.service.acquireJob(result.jobs[0].id, {workerId: 'final-worker'});
  const input = {leaseToken: work.lease.token, status: 'saved_application', applicationReference: 'APP-EXAMPLE-4', paymentAttempted: false, returnedFromPayment: true, requestCopy: {mediaId: PDF}};
  throwsCode(() => f.service.recordPortalResult(work.job.id, {...input, paymentAttempted: true}), 'VISA_PORTAL_RESULT_UNSAFE');
  throwsCode(() => f.service.recordPortalResult(work.job.id, {...input, returnedFromPayment: false}), 'VISA_PORTAL_RESULT_UNSAFE');
  throwsCode(() => f.service.recordPortalResult(work.job.id, {...input, status: 'visa_issued'}), 'VISA_PORTAL_RESULT_UNSAFE');
  f.store.data.visaMedia[PDF].customer = OTHER;
  throwsCode(() => f.service.recordPortalResult(work.job.id, input), 'VISA_MEDIA_UNAVAILABLE'); f.store.data.visaMedia[PDF].customer = CUSTOMER;
  const saved = f.service.recordPortalResult(work.job.id, input);
  assert.equal(saved.status, 'saved_application'); assert.equal(saved.visaIssued, false); assert.equal(saved.governmentPaymentMade, false);
  assert.equal(f.c.submissionStatus, 'not_submitted'); assert.equal(f.service.data().lease, null); assert.equal(saved.message.recipient, CUSTOMER); assert.equal(saved.message.payload.mediaId, PDF);
  assert.match(saved.message.payload.caption, /ليست تأشيرة صادرة/); assert.match(saved.message.payload.caption, /لم تُسدد الرسوم الحكومية/);
  assert.equal((await f.service.dispatchMessage(saved.message.id)).state, 'accepted');
  assert.equal(f.service.recordPortalResult(work.job.id, input).duplicate, true);
});

test('staff/default medical fields cannot suppress asking client personal questions', async () => {
  const f = fixture(), result = await f.activate();
  f.drafts.set(0, {revision: 12, fields: {maritalStatus: 'single', health: {hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false}}});
  const asked = f.service.askQuestions(result.jobs[0].id);
  assert.ok(asked.questions.some(question => question.field === 'health.hospitalizedOrEmergency'));
  assert.ok(asked.questions.some(question => question.field === 'maritalStatus'));
  assert.ok(!asked.questions.some(question => question.field === 'latinGrandfatherName'));
});

test('same approved idempotency request survives auto-release and original expected revision', () => {
  const f = fixture(); f.receive(); const input = f.input({expectedRevision: f.c.revision});
  const approved = f.service.confirmPayment(CUSTOMER, input); f.claim(false);
  assert.equal(f.service.confirmPayment(CUSTOMER, input).approval.id, approved.approval.id);
  assert.equal(f.stats().paymentCalls, 1);
});

test('handled customer buttons and bound text are idempotent and bypass generic model handling', async () => {
  const f = fixture(), result = await f.activate(), asked = f.service.askQuestions(result.jobs[0].id, {fields: ['birthPlace']});
  const question = asked.questions[0], outbox = Object.values(f.service.data().outbox).find(item => item.payload.token === question.token);
  const accepted = await f.service.dispatchMessage(outbox.id);
  assert.equal(f.service.handleCustomerMessage(CUSTOMER, {id: 'client-message-example', contextId: accepted.messageId, text: 'Example City'}).handled, true);
  assert.equal(f.service.handleCustomerMessage(CUSTOMER, {id: 'client-message-example', contextId: accepted.messageId, text: 'Example City'}).ok, true);
  assert.equal(f.service.handleCustomerMessage(CUSTOMER, {id: 'stale-button-example', visaAnswer: {token: question.token, option: 'no'}}).handled, true);
  assert.deepEqual(f.service.handleCustomerMessage(OTHER, {text: 'hello'}), {handled: false});
});

test('old OTP reply cannot resume a new lease for the same applicant', async () => {
  let calls = 0;
  const f = await otpFixture({resumeOtp: async () => { calls++; return {accepted: true}; }});
  f.service.releaseJob(f.work.job.id, {leaseToken: f.work.lease.token});
  f.service.acquireJob(f.work.job.id, {workerId: 'new-worker'});
  assert.equal((await f.service.consumeOtp({sender: OWNER, contextId: f.notification.messageId, text: '927401'})).ok, false);
  assert.equal(calls, 0);
});

test('browser heartbeat extends only the exact current guarded lease', async () => {
  const f = fixture(), result = await f.activate(), work = f.service.acquireJob(result.jobs[0].id, {workerId: 'long-worker', ttlMs: 30 * 60000});
  f.tick(3 * 60000); const lease = f.service.renewLease(work.job.id, {leaseToken: work.lease.token});
  assert.ok(lease.expiresAt > work.lease.expiresAt);
  throwsCode(() => f.service.renewLease(work.job.id, {leaseToken: 'other'}), 'VISA_BROWSER_LEASE_INVALID');
});

test('not-dispatched dry run is never classified as uncertain', async () => {
  const f = fixture({send: async () => ({dryRun: true})}), result = f.approve(); f.claim(false);
  const message = await f.service.dispatchMessage(result.jobs[0].paymentNoticeId);
  assert.equal(message.state, 'cancelled'); assert.equal(message.failure, 'DELIVERY_NOT_DISPATCHED');
});

test('answered questions and confirmed summaries cannot dispatch stale pending prompts', async () => {
  const f = fixture(), result = await f.activate(), asked = f.service.askQuestions(result.jobs[0].id, {fields: ['performUmrah']});
  const questionMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === asked.questions[0].token);
  f.service.answerQuestion({sender: CUSTOMER, token: asked.questions[0].token, option: 'no'});
  const summary = f.service.job(result.jobs[0].id).summary;
  const summaryMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === summary.token);
  assert.equal((await f.service.dispatchMessage(questionMessage.id)).state, 'cancelled');
  f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true});
  assert.equal((await f.service.dispatchMessage(summaryMessage.id)).state, 'cancelled');
});

test('public workflow schema hides owner portal challenge metadata', async () => {
  const f = await otpFixture({resumeOtp: async () => ({accepted: true})});
  const view = f.service.get(CUSTOMER), json = JSON.stringify(view);
  assert.equal(view.currentCaseSignature, view.caseSignature); assert.equal(view.revision, view.caseRevision); assert.ok(Array.isArray(view.timeline));
  assert.doesNotMatch(json, /portal-challenge-example|form-login-example|leaseToken|portalChallengeId/);
  assert.ok(f.service.list().capabilities.clientQuestions);
});

test('correcting a multi-round summary reasks controlling choice before conditional details', async () => {
  const f = fixture(), result = await f.activate(), job = result.jobs[0];
  const first = f.service.askQuestions(job.id, {fields: ['previousNationality']});
  const needs = f.service.answerQuestion({sender: CUSTOMER, token: first.questions[0].token, option: 'yes'});
  const details = f.service.askQuestions(job.id, {fields: needs.followupFields});
  f.service.answerQuestion({sender: CUSTOMER, token: details.questions[0].token, value: 'Previous example nationality'});
  const correction = f.service.confirmAnswers({sender: CUSTOMER, token: f.service.job(job.id).summary.token, confirm: false});
  assert.deepEqual(correction.followupFields, ['previousNationality', 'previousNationalityDetails']);
  const reasked = f.service.askQuestions(job.id, {fields: correction.followupFields});
  assert.deepEqual(reasked.questions.map(question => question.field), ['previousNationality']);
  f.service.answerQuestion({sender: CUSTOMER, token: reasked.questions[0].token, option: 'no'});
  const summary = f.service.job(job.id).summary;
  assert.equal(summary.answers.previousNationality, false); assert.equal(summary.answers.previousNationalityDetails, null);
});

test('unconfirmed client facts cannot produce a completed saved application', async () => {
  const f = fixture(), result = await f.activate(), work = f.service.acquireJob(result.jobs[0].id, {workerId: 'example-worker'});
  assert.equal(f.service.getConfirmedFields(work.job.id).complete, false);
  throwsCode(() => f.service.recordPortalResult(work.job.id, {leaseToken: work.lease.token, status: 'saved_application', applicationReference: 'APP-EXAMPLE', paymentAttempted: false, returnedFromPayment: true, requestCopy: {mediaId: PDF}}), 'VISA_CLIENT_FACTS_UNCONFIRMED');
});

test('customer-message metadata cannot override authenticated WhatsApp sender', async () => {
  const f = fixture(), result = await f.activate(), asked = f.service.askQuestions(result.jobs[0].id, {fields: ['performUmrah']});
  const outcome = f.service.handleCustomerMessage(OTHER, {visaAnswer: {sender: CUSTOMER, token: asked.questions[0].token, option: 'no'}});
  assert.equal(outcome.handled, true); assert.equal(outcome.ok, false);
  assert.equal(f.service.job(result.jobs[0].id).questions[asked.questions[0].token].state, 'pending');
});

test('only proven paused messages can be requeued after inbound opens delivery window', async () => {
  let paused = true;
  const f = fixture({send: async (_to, _payload, guard) => { guard(); return paused ? {paused: true, notDispatched: true} : {messageId: 'accepted-after-inbound'}; }}), result = f.approve(); f.claim(false);
  const message = await f.service.dispatchMessage(result.jobs[0].paymentNoticeId);
  assert.equal(message.state, 'cancelled'); assert.equal(message.failure, 'DELIVERY_PAUSED');
  paused = false;
  assert.equal(f.service.requeuePausedMessages(CUSTOMER).requeued, 1);
  assert.equal((await f.service.dispatchMessage(message.id)).state, 'accepted');
  assert.equal(f.service.requeuePausedMessages(CUSTOMER).requeued, 0);
  f.service.data().outbox[message.id].state = 'uncertain'; f.service.data().outbox[message.id].failure = 'DELIVERY_PAUSED';
  assert.equal(f.service.requeuePausedMessages(CUSTOMER).requeued, 0);
});

test('temporary staff claim pauses queued job without invalidating received payment', async () => {
  const f = fixture(), result = await f.activate(); f.claim(true);
  const paused = f.service.get(CUSTOMER);
  assert.equal(paused.approval.state, 'approved'); assert.equal(f.service.job(result.jobs[0].id).state, 'queued');
  f.claim(false);
  assert.equal(f.service.acquireJob(result.jobs[0].id, {workerId: 'resumed-worker'}).job.state, 'running');
});

test('explicit summary authorisation binds real inbound WhatsApp message ID to consent proof', async () => {
  const f = fixture(), result = await f.activate(), asked = f.service.askQuestions(result.jobs[0].id, {fields: ['performUmrah']});
  f.service.answerQuestion({sender: CUSTOMER, token: asked.questions[0].token, option: 'no'});
  const summary = f.service.job(result.jobs[0].id).summary;
  const summaryMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === summary.token);
  assert.match(summaryMessage.payload.text, /أؤكد صحة الإجابات وأفوّض شركة الرمال بتقديم طلب التأشيرة بهذه البيانات/);
  f.service.handleCustomerMessage(CUSTOMER, {id: 'inbound-consent-example', visaConfirmation: {token: summary.token, confirm: true, messageId: 'untrusted-override'}});
  const consent = f.service.getConfirmedFields(result.jobs[0].id).confirmation;
  assert.equal(consent.messageId, 'inbound-consent-example'); assert.equal(consent.scope, 'saudi_visa_application'); assert.equal(consent.granted, true); assert.equal(consent.caseSignature, visaCaseSignature(f.c));
});

test('ordinary conversation revisions preserve accountant approval, messages and applicant answers', async () => {
  const f = fixture(), result = await f.activate(), jobId = result.jobs[0].id;
  const asked = f.service.askQuestions(jobId, {fields: ['performUmrah']});
  const questionMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === asked.questions[0].token);
  f.c.revision++; f.c.updatedAt = 2000000;
  assert.equal(f.service.get(CUSTOMER).approval.state, 'approved');
  assert.equal((await f.service.dispatchMessage(questionMessage.id)).state, 'accepted');
  f.c.revision++;
  assert.equal(f.service.answerQuestion({sender: CUSTOMER, token: asked.questions[0].token, option: 'no'}).ok, true);
  const summary = f.service.job(jobId).summary;
  f.c.revision++;
  assert.equal(f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true, messageId: 'ordinary-revision-consent'}).state, 'ready');
  const lease = f.service.acquireJob(jobId, {workerId: 'ordinary-revision-worker'});
  f.c.revision++;
  assert.equal(f.service.renewLease(jobId, {leaseToken: lease.lease.token}).jobId, jobId);
});

test('staff document review alone preserves actual payment approval', async () => {
  const f = fixture(), result = await f.activate();
  f.c.staffVerification.documentsReviewed = true; f.c.staffVerification.documentsSignature = visaCaseSignature(f.c); f.c.revision++;
  assert.equal(f.service.get(CUSTOMER).approval.state, 'approved');
  assert.equal(f.service.acquireJob(result.jobs[0].id, {workerId: 'document-reviewed-worker'}).job.state, 'running');
});

test('changed document identity still invalidates the approved material case', async () => {
  const f = fixture(), result = await f.activate();
  f.c.documents.push({id: 'new-document-example', kind: 'passport', sha256: 'c'.repeat(64)}); f.c.revision++;
  throwsCode(() => f.service.acquireJob(result.jobs[0].id, {workerId: 'changed-document-worker'}), 'VISA_JOB_STALE');
  assert.equal(f.service.get(CUSTOMER).approval.state, 'stale');
});

test('changed payment evidence invalidates approval even with unchanged case facts', async () => {
  const f = fixture(), result = await f.activate(), signature = visaCaseSignature(f.c);
  f.c.staffVerification.payment.reference = 'REPLACED-BANK-REFERENCE'; f.c.revision++;
  assert.equal(visaCaseSignature(f.c), signature);
  throwsCode(() => f.service.acquireJob(result.jobs[0].id, {workerId: 'changed-payment-worker'}), 'VISA_JOB_STALE');
});

test('bare text binds the one accepted text prompt while other registered questions remain unsent', async () => {
  const f = fixture(), result = await f.activate(), jobId = result.jobs[0].id;
  const asked = f.service.askQuestions(jobId, {fields: ['birthPlace', 'maritalStatus', 'performUmrah']});
  const textQuestion = asked.questions.find(question => question.field === 'birthPlace');
  const outgoing = Object.values(f.service.data().outbox).find(item => item.payload.token === textQuestion.token);
  assert.equal(f.service.handleCustomerMessage(CUSTOMER, {text: 'Unsolicited example city'}).handled, false);
  await f.service.dispatchMessage(outgoing.id);
  const resultMessage = f.service.handleCustomerMessage(CUSTOMER, {id: 'unquoted-city-answer', text: 'Example City'});
  assert.equal(resultMessage.handled, true); assert.equal(resultMessage.ok, true);
  assert.equal(f.service.job(jobId).questions[textQuestion.token].answer, 'Example City');
  assert.equal(f.service.job(jobId).questions[asked.questions.find(question => question.field === 'maritalStatus').token].state, 'pending');
});

test('paused-message inbound event helper ignores nonphone legacy routing identities', () => {
  const f = fixture(), saves = f.stats().saves;
  for (const sender of ['synthetic-nearby-customer', 'private-recipient', undefined, null, {}, '']) assert.deepEqual(f.service.requeuePausedMessages(sender), {ok: true, requeued: 0, messageIds: []});
  assert.equal(f.stats().saves, saves);
});
