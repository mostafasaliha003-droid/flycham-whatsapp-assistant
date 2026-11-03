'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {visaCaseSignature} = require('../src/visa-case-signature');
const {RaadVisaWorkflow} = require('../src/raad-visa-workflow');
const {reconcileDocumentEvidence} = require('../src/visa-document-matching');

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
  assert.match(f.service.pendingMessages()[0].payload.text, /تم تأكيد استلام دفعتك/); assert.doesNotMatch(f.service.pendingMessages()[0].payload.text, /رعد|بيانات شخصية ناقصة|لا يعني/);
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
  assert.equal(saved.message.payload.caption, `تم تسجيل طلب التأشيرة برقم ${saved.job.applicationReference} ✅\nرح نتابع طلبك، وأول ما تصدر التأشيرة بنبعتها إلك مباشرة.`);
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

async function ownerNoticeFixture({noticeMessageId = 'accepted-owner-task-notice', send, resumeOtp} = {}) {
  const metadata = [];
  const f = fixture({resumeOtp, send: send || (async (_recipient, _payload, guard, meta) => {
    guard(); metadata.push(structuredClone(meta));
    return meta.kind === 'owner_otp_request' ? {paused: true, reason: 'owner_action_required', noticeMessageId} : {messageId: 'accepted-payment-before-notice'};
  })});
  const result = await f.activate(), work = f.service.acquireJob(result.jobs[0].id, {workerId: 'owner-task-worker'});
  const request = f.service.requestOtp(work.job.id, {leaseToken: work.lease.token, portalChallengeId: 'owner-task-portal-challenge', contextId: 'owner-task-form-context'});
  const notice = await f.service.dispatchMessage(request.messageId);
  return {...f, work, request, notice, metadata, challenge: () => f.service.data().challenges[request.challengeId], original: () => f.service.data().outbox[request.messageId]};
}

test('accepted utility notice is separate from the paused OTP prompt and cannot resume a code', async () => {
  let resumed = 0;
  const f = await ownerNoticeFixture({resumeOtp: async () => { resumed++; return {ok: true}; }});
  assert.equal(f.notice.state, 'cancelled'); assert.equal(f.notice.failure, 'DELIVERY_PAUSED'); assert.equal(f.notice.noticeMessageId, 'accepted-owner-task-notice'); assert.equal(f.notice.noticeState, 'accepted');
  assert.match(f.notice.payload.text, /قبل انتهاء صلاحية الرمز/); assert.doesNotMatch(f.notice.payload.text, /خلال \d+ دقائق/);
  assert.equal(f.challenge().noticeMessageId, f.notice.noticeMessageId); assert.equal(f.challenge().messageId, undefined);
  assert.equal((await f.service.consumeOtp({sender: OWNER, contextId: f.notice.noticeMessageId, text: '831472'})).ok, false); assert.equal(resumed, 0);
  assert.equal(f.service.requeuePausedMessages(OWNER).requeued, 0); assert.equal(f.service.requeuePausedMessages(CUSTOMER).requeued, 0);
  const status = f.service.recordDelivery(f.notice.noticeMessageId, 'delivered');
  assert.equal(status.state, 'cancelled'); assert.equal(status.noticeState, 'delivered'); assert.equal(f.challenge().noticeState, 'delivered'); assert.equal(f.challenge().messageId, undefined);
});

test('exact owner notice action requeues only original OTP prompt without extending TTL or starting portal work', async () => {
  let resumed = 0;
  const f = await ownerNoticeFixture({resumeOtp: async () => { resumed++; return {ok: true}; }}), expiresAt = f.challenge().expiresAt, leaseExpiresAt = f.service.data().lease.expiresAt, attempts = f.original().attempts;
  const other = f.service.commit(() => f.service.enqueue({key: 'unrelated-paused-message', kind: 'payment_confirmation', customer: CUSTOMER, recipient: CUSTOMER, approvalId: f.work.job.approvalId, caseSignature: f.work.job.caseSignature, payload: {type: 'text', text: 'Example unrelated pending item'}}));
  f.service.data().outbox[other.id].state = 'cancelled'; f.service.data().outbox[other.id].failure = 'DELIVERY_PAUSED';
  const action = f.service.openOwnerAction({sender: '+' + OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  assert.deepEqual(action, {handled: true, ok: true, duplicate: false, jobId: f.work.job.id, challengeId: f.request.challengeId, requeued: 1, messageIds: [f.request.messageId]});
  assert.equal(f.original().state, 'pending'); assert.equal(f.original().attempts, attempts); assert.equal(f.service.data().outbox[other.id].state, 'cancelled');
  assert.equal(f.challenge().expiresAt, expiresAt); assert.equal(f.service.data().lease.expiresAt, leaseExpiresAt); assert.equal(f.challenge().messageId, undefined); assert.equal(resumed, 0);
  const duplicate = f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  assert.equal(duplicate.ok, true); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.requeued, 0); assert.equal(f.original().attempts, attempts);
  f.service.send = async (_recipient, _payload, guard, meta) => { guard(); assert.equal(meta.noticeMessageId, f.notice.noticeMessageId); return {messageId: 'accepted-real-otp-prompt'}; };
  const prompt = await f.service.dispatchMessage(f.request.messageId);
  assert.equal(prompt.state, 'accepted'); assert.equal(f.challenge().messageId, 'accepted-real-otp-prompt'); assert.notEqual(f.challenge().messageId, f.challenge().noticeMessageId);
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId}).requeued, 0);
});

test('wrong sender, missing or mismatched notice context and unknown owner actions are safely consumed', async () => {
  const f = await ownerNoticeFixture(), before = structuredClone(f.service.data());
  for (const action of [{sender: OTHER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId}, {sender: OWNER, challengeId: f.request.challengeId}, {sender: OWNER, challengeId: f.request.challengeId, contextId: 'unrelated-provider-message'}, {sender: OWNER, challengeId: 'unknown-challenge', contextId: f.notice.noticeMessageId}, {}]) {
    const outcome = f.service.openOwnerAction(action); assert.equal(outcome.handled, true); assert.equal(outcome.ok, false);
  }
  assert.deepEqual(f.service.data(), before);
});

test('owner action rejects stale TTL, lease, revision, material case or payment evidence', async () => {
  for (const mutation of ['expiry', 'lease', 'revision', 'case', 'payment', 'owner']) {
    const f = await ownerNoticeFixture();
    if (mutation === 'expiry') f.tick(5 * 60000 + 1);
    if (mutation === 'lease') f.service.data().lease.token = 'different-active-lease';
    if (mutation === 'revision') f.service.job(f.work.job.id).revision++;
    if (mutation === 'case') f.c.applicants[0].latinFirstName = 'Changed example identity';
    if (mutation === 'payment') f.c.staffVerification.payment.reference = 'REPLACED-REFERENCE';
    if (mutation === 'owner') f.options.env.RAAD_OTP_OWNER_WHATSAPP = OTHER;
    const action = f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
    assert.equal(action.handled, true); assert.equal(action.ok, false); assert.notEqual(f.original().state, 'pending');
  }
});

test('owner action never revives uncertain, failed, sending or already accepted OTP sends', async () => {
  for (const state of ['uncertain', 'failed', 'sending', 'accepted']) {
    const f = await ownerNoticeFixture(); f.original().state = state;
    const action = f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
    assert.equal(action.handled, true); assert.equal(action.ok, false); assert.equal(f.original().state, state);
    assert.equal(f.service.requeuePausedMessages(OWNER).requeued, 0);
    assert.equal(f.service.requeueApprovedNotifications({ownerTemplateApproved: true}).requeued, 0);
  }
});

test('duplicate owner clicks cannot replay an uncertain OTP send or resend its utility notice', async () => {
  const f = await ownerNoticeFixture(); f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  let sends = 0;
  f.service.send = async (_recipient, _payload, guard, meta) => { guard(); sends++; assert.equal(meta.noticeMessageId, f.notice.noticeMessageId); throw Error('EXAMPLE_OTP_DELIVERY_TIMEOUT'); };
  assert.equal((await f.service.dispatchMessage(f.request.messageId)).state, 'uncertain');
  const duplicate = f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.requeued, 0); assert.equal(f.original().state, 'uncertain');
  await f.service.dispatchMessage(f.request.messageId); assert.equal(sends, 1);
});

test('notice IDs are bounded and a notice provider ID can never count as actual OTP prompt acceptance', async () => {
  const invalid = await ownerNoticeFixture({noticeMessageId: 'x'.repeat(501)});
  assert.equal(invalid.original().state, 'uncertain'); assert.equal(invalid.original().noticeMessageId, undefined); assert.equal(invalid.challenge().noticeMessageId, undefined); assert.equal(invalid.challenge().messageId, undefined);
  const f = await ownerNoticeFixture(); f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  f.service.send = async () => ({messageId: f.notice.noticeMessageId});
  assert.equal((await f.service.dispatchMessage(f.request.messageId)).state, 'uncertain'); assert.equal(f.challenge().messageId, undefined);
});

test('notice failed-delivery events cannot confirm owner action or mark OTP prompt failed', async () => {
  const f = await ownerNoticeFixture(); f.service.recordDelivery(f.notice.noticeMessageId, 'failed');
  assert.equal(f.original().state, 'cancelled'); assert.equal(f.original().noticeState, 'failed'); assert.equal(f.challenge().messageId, undefined);
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId}).ok, false);
});

test('owner action persistence failure leaves original safely paused and permits exact retry', async () => {
  const f = await ownerNoticeFixture(), save = f.store.save;
  f.store.save = () => { throw Error('EXAMPLE_ACTION_SAVE_FAILURE'); };
  const failed = f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  assert.equal(failed.reason, 'OWNER_ACTION_SAVE_FAILED'); assert.equal(f.original().state, 'cancelled'); assert.equal(f.challenge().ownerAction, undefined);
  f.store.save = save;
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId}).requeued, 1);
});

test('notice acceptance racing a released challenge never reopens or binds that old OTP prompt', async () => {
  let finish;
  const f = fixture({send: async (_recipient, _payload, guard, meta) => { guard(); if (meta.kind !== 'owner_otp_request') return {messageId: 'accepted-payment'}; return new Promise(resolve => { finish = resolve; }); }});
  const approval = await f.activate(), work = f.service.acquireJob(approval.jobs[0].id, {workerId: 'racing-owner-task'}), request = f.service.requestOtp(work.job.id, {leaseToken: work.lease.token, portalChallengeId: 'racing-portal-challenge', contextId: 'racing-form-context'});
  const sending = f.service.dispatchMessage(request.messageId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: request.challengeId, contextId: 'racing-notice'}).ok, false);
  f.service.releaseJob(work.job.id, {leaseToken: work.lease.token});
  finish({paused: true, reason: 'owner_action_required', noticeMessageId: 'racing-notice'}); await sending;
  const challenge = f.service.data().challenges[request.challengeId];
  assert.equal(challenge.state, 'cancelled'); assert.equal(challenge.noticeMessageId, undefined); assert.equal(challenge.messageId, undefined);
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: request.challengeId, contextId: 'racing-notice'}).ok, false);
});

test('verified template approval requeues only known paused payment and eligible owner notifications', async () => {
  const f = fixture({send: async () => ({paused: true, reason: 'template_not_approved'})}), approval = f.approve(); f.claim(false);
  await f.service.dispatchMessage(approval.jobs[0].paymentNoticeId);
  assert.equal(f.service.requeueApprovedNotifications().requeued, 0);
  assert.equal(f.service.requeueApprovedNotifications({paymentTemplateApproved: 'true'}).requeued, 0);
  assert.deepEqual(f.service.requeueApprovedNotifications({paymentTemplateApproved: true}).messageIds, [approval.jobs[0].paymentNoticeId]);
  f.service.send = async () => ({messageId: 'accepted-approved-payment'}); await f.service.dispatchMessage(approval.jobs[0].paymentNoticeId);
  const work = f.service.acquireJob(approval.jobs[0].id, {workerId: 'approved-owner-template'}), request = f.service.requestOtp(work.job.id, {leaseToken: work.lease.token, portalChallengeId: 'approved-owner-challenge', contextId: 'approved-owner-context'});
  f.service.send = async () => ({paused: true, reason: 'template_not_approved'}); await f.service.dispatchMessage(request.messageId);
  assert.equal(f.service.requeueApprovedNotifications({paymentTemplateApproved: true}).requeued, 0);
  assert.deepEqual(f.service.requeueApprovedNotifications({ownerTemplateApproved: true}).messageIds, [request.messageId]);
  f.service.data().outbox[request.messageId].state = 'cancelled'; f.service.data().outbox[request.messageId].failure = 'DELIVERY_PAUSED'; f.tick(5 * 60000 + 1);
  assert.equal(f.service.requeueApprovedNotifications({ownerTemplateApproved: true}).requeued, 0);
});

test('template approvals never reopen owner notices, client questions, PDFs or uncertain external effects', async () => {
  const f = await ownerNoticeFixture();
  for (const [kind, state] of [['payment_confirmation', 'uncertain'], ['payment_confirmation', 'failed'], ['payment_confirmation', 'accepted'], ['applicant_question', 'cancelled'], ['application_request_copy', 'cancelled']]) {
    const item = f.service.enqueue({key: 'ineligible-template-' + kind + '-' + state, kind, customer: CUSTOMER, recipient: CUSTOMER, approvalId: f.work.job.approvalId, caseSignature: f.work.job.caseSignature, payload: {type: 'text', text: 'Example ineligible item'}});
    item.state = state; item.failure = 'DELIVERY_PAUSED';
  }
  const before = Object.fromEntries(Object.values(f.service.data().outbox).map(item => [item.id, item.state]));
  assert.equal(f.service.requeueApprovedNotifications({paymentTemplateApproved: true, ownerTemplateApproved: true}).requeued, 0);
  assert.deepEqual(Object.fromEntries(Object.values(f.service.data().outbox).map(item => [item.id, item.state])), before);
});

test('owner-action-required response without an accepted notice ID remains uncertain', async () => {
  const f = await ownerNoticeFixture({send: async (_recipient, _payload, guard, meta) => { guard(); return meta.kind === 'owner_otp_request' ? {paused: true, reason: 'owner_action_required'} : {messageId: 'accepted-payment'}; }});
  assert.equal(f.original().state, 'uncertain'); assert.equal(f.original().noticeMessageId, undefined); assert.equal(f.original().ownerActionRequired, undefined); assert.equal(f.challenge().messageId, undefined); assert.equal(f.challenge().noticeMessageId, undefined);
  assert.equal(f.service.requeueApprovedNotifications({ownerTemplateApproved: true}).requeued, 0);
});

test('cancelled lease prevents actual OTP prompt after an otherwise valid owner action', async () => {
  const f = await ownerNoticeFixture();
  assert.equal(f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId}).requeued, 1);
  let providerCalls = 0;
  f.service.send = async (_recipient, _payload, guard) => { guard(); providerCalls++; return {messageId: 'must-not-be-sent'}; };
  f.service.data().lease.cancelled = true;
  const result = await f.service.dispatchMessage(f.request.messageId);
  assert.equal(result.state, 'cancelled'); assert.equal(result.failure, 'MESSAGE_SUPERSEDED'); assert.equal(providerCalls, 0); assert.equal(f.challenge().messageId, undefined);
});

test('actual OTP prompt final queue guard checks captured lease before provider dispatch', async () => {
  const f = await ownerNoticeFixture(); f.service.openOwnerAction({sender: OWNER, challengeId: f.request.challengeId, contextId: f.notice.noticeMessageId});
  let providerCalls = 0;
  f.service.send = async (_recipient, _payload, guard) => { f.service.data().lease.cancelled = true; guard(); providerCalls++; return {messageId: 'must-not-be-sent'}; };
  const result = await f.service.dispatchMessage(f.request.messageId);
  assert.equal(result.state, 'cancelled'); assert.equal(providerCalls, 0); assert.equal(f.challenge().messageId, undefined);
});

test('notice acceptance followed by persistence failure cannot resend the utility notice', async () => {
  let failSave = false;
  const f = fixture({send: async (_recipient, _payload, guard, meta) => { guard(); if (meta.kind !== 'owner_otp_request') return {messageId: 'accepted-payment'}; failSave = true; return {paused: true, reason: 'owner_action_required', noticeMessageId: 'notice-accepted-before-disk-error'}; }});
  const save = f.store.save; f.store.save = () => { if (failSave) { failSave = false; throw Error('EXAMPLE_NOTICE_SAVE_FAILURE'); } save(); };
  const approval = await f.activate(), work = f.service.acquireJob(approval.jobs[0].id, {workerId: 'notice-save-worker'}), request = f.service.requestOtp(work.job.id, {leaseToken: work.lease.token, portalChallengeId: 'notice-save-challenge', contextId: 'notice-save-context'});
  const result = await f.service.dispatchMessage(request.messageId);
  assert.equal(result.state, 'uncertain'); assert.equal(result.noticeMessageId, undefined); assert.equal(f.service.data().challenges[request.challengeId].messageId, undefined);
  assert.equal(f.service.requeuePausedMessages(OWNER).requeued, 0); assert.equal(f.service.requeueApprovedNotifications({ownerTemplateApproved: true}).requeued, 0);
  assert.equal((await f.service.dispatchMessage(request.messageId)).state, 'uncertain');
});

test('template approval cannot revive notification after material case changes', async () => {
  const f = fixture({send: async () => ({paused: true, reason: 'template_pending'})}), approval = f.approve(); f.claim(false);
  await f.service.dispatchMessage(approval.jobs[0].paymentNoticeId); f.c.quote.total = 280;
  assert.equal(f.service.requeueApprovedNotifications({paymentTemplateApproved: true, ownerTemplateApproved: true}).requeued, 0);
  assert.equal(f.service.data().outbox[approval.jobs[0].paymentNoticeId].state, 'cancelled');
});

function canonicalMachineValue(value) {
  if (Array.isArray(value)) return value.map(canonicalMachineValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalMachineValue(value[key])]));
  return value;
}
const machineHash = value => createHash('sha256').update(JSON.stringify(canonicalMachineValue(value))).digest('hex');
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
function checkDigit(value) { return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10); }
async function machineFactsFixture({missing = []} = {}) {
  const f = fixture({count: 1}); f.tick(Date.parse('2026-10-28T00:00:00Z') - 1000000);
  f.service.canAutomate = () => true;
  for (const record of Object.values(f.store.data.visaMedia)) record.expiresAt = Date.parse('2032-01-01T00:00:00Z');
  const approval = await f.activate(), jobId = approval.jobs[0].id;
  const ids = {passportSource: '20000000-0000-4000-8000-000000000001', residenceSource: '20000000-0000-4000-8000-000000000002', photoSource: '20000000-0000-4000-8000-000000000003', passport: '20000000-0000-4000-8000-000000000004', residence: '20000000-0000-4000-8000-000000000005', photo: '20000000-0000-4000-8000-000000000006', evidence: '20000000-0000-4000-8000-000000000007'};
  const png = label => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]);
  const expiresAt = Date.parse('2032-01-01T00:00:00Z');
  for (const [key, id] of Object.entries(ids).filter(([key]) => key !== 'evidence')) {
    const bytes = png('synthetic-' + key), kind = ['passport', 'residence', 'photo'].includes(key) ? key : null;
    f.store.data.visaMedia[id] = {id, customer: CUSTOMER, mimeType: 'image/png', size: bytes.length, checksum: bytesHash(bytes), bytes, receivedAt: f.options.now(), expiresAt, ...(kind ? {purpose: 'raad_portal_upload', kind, sourceIds: [ids[kind + 'Source']]} : {})};
  }
  f.mediaStore.read = (id, {customer}) => { const record = f.store.data.visaMedia[id]; if (!record || record.customer !== customer) throw Error('MEDIA_NOT_FOUND'); const {bytes, ...metadata} = record; if (!Buffer.isBuffer(bytes)) throw Error('MEDIA_NOT_FOUND'); return {metadata: structuredClone(metadata), bytes: Buffer.from(bytes)}; };
  const passportFields = {latinFirstName: 'Ari', latinFamilyName: 'Example', passportNumber: 'N12345678', passportType: 'ordinary', nationalityCode: 'EGY', issuingCountryCode: 'EGY', birthDate: '1990-01-15', birthPlace: 'Example City', sex: 'M', issueDate: '2020-01-01', expiryDate: '2031-01-01'};
  const number = passportFields.passportNumber, birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const first = 'P<EGYEXAMPLE<<ARI'.padEnd(44, '<'), second = number + checkDigit(number) + 'EGY' + birth + checkDigit(birth) + 'M' + expiry + checkDigit(expiry) + optional + checkDigit(optional);
  const mrz = [first, second + checkDigit(second.slice(0, 10) + second.slice(13, 20) + second.slice(21, 43))];
  const extraction = (kind, fields, mrzLines = []) => ({version: 1, kind, readable: true, rotation: 0, fields: Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, {value, confidence: 1, visible: true}])), mrzLines});
  const visiblePassport = {...passportFields}; for (const field of missing) delete visiblePassport[field];
  const documents = [[ids.passportSource, extraction('passport', visiblePassport, mrz)], [ids.residenceSource, extraction('uae_id_front', {latinFullName: 'Ari Example', passportNumber: 'N12345678', nationalityCode: 'EGY', birthDate: '1990-01-15', sex: 'M', emiratesId: '784190012345673', residenceExpiry: '2031-04-30'})], [ids.photoSource, extraction('portrait', {})]].map(([mediaId, value]) => ({mediaId, page: 1, sha256: f.store.data.visaMedia[mediaId].checksum, sourceSha256: f.store.data.visaMedia[mediaId].checksum, extraction: value}));
  const matched = reconcileDocumentEvidence({documents, applicants: f.c.applicants, referenceDate: '2026-10-28'}).applicants[0];
  const applicant = {id: ids.evidence, applicantIndex: 0, status: matched.status, fields: structuredClone(matched.fields), clientFieldsRequired: [...matched.clientFieldsRequired], documents: {passport: ids.passport, residence: ids.residence, photo: ids.photo}, sourceManifest: [ids.passportSource, ids.residenceSource, ids.photoSource].map(mediaId => ({mediaId, sha256: f.store.data.visaMedia[mediaId].checksum})), preparedManifest: ['passport', 'residence', 'photo'].map(kind => ({kind, mediaId: ids[kind], sha256: f.store.data.visaMedia[ids[kind]].checksum})), evidence: structuredClone(matched.evidence), extractionDigest: machineHash({documents, applicantIndex: 0, fields: matched.fields, matchedDocuments: matched.documents, evidence: matched.evidence})};
  f.store.data.visaDocumentIntake = {version: 1, cases: {[CUSTOMER]: {caseId: f.c.id, caseSignature: visaCaseSignature(f.c), generation: 1, status: missing.length ? 'needs_review' : 'ready', documents, applicants: [applicant]}}};
  const raad = new RaadVisaWorkflow({store: f.store, mediaStore: f.mediaStore, now: f.options.now, env: {RAAD_APPLICATION_PHONE: '+' + CUSTOMER, RAAD_CONTACT_EMAIL: 'example@example.test', RAAD_INSURANCE_PHONE: '+' + CUSTOMER, RAAD_POSTAL_CODE: '00000'}, canAutomate: () => true});
  f.service.raad = raad;
  return {...f, jobId, ids, applicant, documents, raad};
}
function answerRemainingMachineQuestions(f) {
  const asked = f.service.askQuestions(f.jobId);
  for (const question of asked.questions) {
    if (question.type === 'choice') f.service.answerQuestion({sender: CUSTOMER, token: question.token, option: question.field === 'maritalStatus' ? 'single' : question.field === 'sex' ? 'male' : question.field === 'gccResident' ? 'yes' : question.field === 'passportType' ? 'ordinary' : 'no'});
    else f.service.answerQuestion({sender: CUSTOMER, token: question.token, value: question.field === 'issueDate' ? '2020-01-01' : question.field === 'birthPlace' ? 'Example City' : question.field === 'latinFirstName' ? 'Ari' : question.field === 'latinFamilyName' ? 'Example' : 'Example Hotel, Riyadh'});
  }
  return asked;
}

test('verified document facts stage privately and receive one final actual client summary', async () => {
  const f = await machineFactsFixture(), before = structuredClone(f.c);
  f.raad.applyMachineDossier(CUSTOMER, {applicantIndex: 0, expectedRevision: 0, expectedCaseSignature: visaCaseSignature(f.c), evidenceId: f.ids.evidence});
  const staged = f.service.stageDocumentFacts(f.jobId, {fields: f.applicant.fields, evidenceId: f.ids.evidence});
  assert.equal(staged.ok, true); assert.equal(staged.stagedFields.passportNumber, 'N12345678'); assert.equal(staged.stagedFields.health, undefined); assert.equal(staged.stagedFields.maritalStatus, undefined);
  assert.deepEqual(f.service.job(f.jobId).confirmedFields, {}); assert.equal(f.service.job(f.jobId).answerConfirmation, undefined); assert.deepEqual(f.c, before); assert.equal(f.service.get(CUSTOMER).approval.state, 'approved');
  const asked = answerRemainingMachineQuestions(f);
  assert.ok(!asked.questions.some(question => ['latinFirstName', 'birthPlace', 'sex'].includes(question.field))); assert.ok(asked.questions.some(question => question.field === 'health.hospitalizedOrEmergency'));
  const summary = f.service.job(f.jobId).summary, summaryMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === summary.token);
  assert.equal(summary.answers.passportNumber, 'N12345678'); assert.equal(summary.answers.health.hospitalizedOrEmergency, false); assert.ok(summaryMessage.payload.entries.some(entry => entry.field === 'expiryDate')); assert.equal(f.service.getConfirmedFields(f.jobId).complete, false);
  f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true, messageId: 'real-machine-consent-message'});
  const proof = f.service.getConfirmedFields(f.jobId); assert.equal(proof.complete, true); assert.equal(proof.documentEvidence.id, f.ids.evidence); assert.deepEqual(proof.confirmation.documentEvidence, proof.documentEvidence);
  const dossier = f.raad.portalDossier(CUSTOMER, {applicantIndex: 0, clientProof: proof}); assert.equal(dossier.ready, true); assert.equal(dossier.source, 'machine'); assert.deepEqual(f.c, before);
});

test('document staging rejects forged medical defaults, supplied mismatches and unverified private evidence', async () => {
  const f = await machineFactsFixture();
  throwsCode(() => f.service.stageDocumentFacts(f.jobId, {fields: {...f.applicant.fields, health: {hospitalizedOrEmergency: false}}, evidenceId: f.ids.evidence}), 'VISA_DOCUMENT_FIELDS_INVALID');
  throwsCode(() => f.service.stageDocumentFacts(f.jobId, {fields: {...f.applicant.fields, passportNumber: 'FORGED123'}, evidenceId: f.ids.evidence}), 'VISA_DOCUMENT_FIELDS_INVALID');
  f.applicant.evidence.passportMrzChecked = false;
  throwsCode(() => f.service.stageDocumentFacts(f.jobId, {fields: f.applicant.fields, evidenceId: f.ids.evidence}), 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED');
  assert.deepEqual(f.service.job(f.jobId).confirmedFields, {}); assert.equal(f.service.job(f.jobId).documentFacts, undefined);
});

test('same evidence staging is idempotent and preserves current question token and real consent', async () => {
  const f = await machineFactsFixture(); f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence});
  const asked = f.service.askQuestions(f.jobId), revision = f.service.job(f.jobId).revision;
  assert.equal(f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence}).duplicate, true); assert.equal(f.service.job(f.jobId).revision, revision); assert.ok(f.service.job(f.jobId).questions[asked.questions[0].token]);
  answerRemainingMachineQuestions(f); f.service.confirmAnswers({sender: CUSTOMER, token: f.service.job(f.jobId).summary.token, confirm: true, messageId: 'idempotent-machine-consent'});
  assert.equal(f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence}).duplicate, true); assert.equal(f.service.job(f.jobId).answerConfirmation.messageId, 'idempotent-machine-consent');
});

test('changed document bytes stop old questions and summaries while actual payment stays current', async () => {
  const f = await machineFactsFixture(); f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence});
  const asked = f.service.askQuestions(f.jobId), questionMessage = Object.values(f.service.data().outbox).find(item => item.payload.token === asked.questions[0].token);
  f.store.data.visaMedia[f.ids.passport].bytes = Buffer.concat([f.store.data.visaMedia[f.ids.passport].bytes, Buffer.from('changed')]);
  const result = await f.service.dispatchMessage(questionMessage.id); assert.equal(result.state, 'cancelled');
  throwsCode(() => f.service.answerQuestion({sender: CUSTOMER, token: asked.questions[0].token, option: 'single'}), 'VISA_DOCUMENT_EVIDENCE_UNVERIFIED');
  assert.equal(f.service.get(CUSTOMER).approval.state, 'approved'); assert.equal(f.c.paymentStatus, 'verified');
});

test('only missing safe document facts become explicit client questions rather than fabricated defaults', async () => {
  const f = await machineFactsFixture({missing: ['passportType', 'issueDate', 'birthPlace']});
  const staged = f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence}), fingerprint = staged.documentEvidence.evidenceFingerprint;
  assert.deepEqual(new Set(staged.clientFieldsRequired), new Set(['passportType', 'issueDate', 'birthPlace'])); assert.equal(staged.stagedFields.passportType, undefined);
  const asked = answerRemainingMachineQuestions(f); for (const field of staged.clientFieldsRequired) assert.ok(asked.questions.some(question => question.field === field));
  const summary = f.service.job(f.jobId).summary; assert.equal(summary.answers.passportType, 'ordinary'); assert.equal(summary.answers.issueDate, '2020-01-01');
  f.service.confirmAnswers({sender: CUSTOMER, token: summary.token, confirm: true, messageId: 'missing-document-client-consent'});
  const proof = f.service.getConfirmedFields(f.jobId); assert.equal(proof.complete, true); assert.equal(proof.documentEvidence.evidenceFingerprint, fingerprint);
});

test('staging after prior personal answers preserves those actual facts and requires a new combined summary', async () => {
  const f = await machineFactsFixture(); answerRemainingMachineQuestions(f);
  f.service.confirmAnswers({sender: CUSTOMER, token: f.service.job(f.jobId).summary.token, confirm: true, messageId: 'prior-personal-consent'});
  f.service.stageDocumentFacts(f.jobId, {evidenceId: f.ids.evidence});
  assert.equal(f.service.job(f.jobId).stagedFields.health.hospitalizedOrEmergency, false); assert.equal(f.service.job(f.jobId).answerConfirmation, undefined);
  const asked = f.service.askQuestions(f.jobId); assert.equal(asked.questions.length, 0); assert.equal(f.service.job(f.jobId).state, 'awaiting_answer_confirmation'); assert.equal(f.service.getConfirmedFields(f.jobId).complete, false);
});

test('document staging cannot overwrite conflicting client facts or run during a browser lease/staff claim', async () => {
  const conflict = await machineFactsFixture(); conflict.service.job(conflict.jobId).confirmedFields.latinFirstName = 'Another';
  throwsCode(() => conflict.service.stageDocumentFacts(conflict.jobId, {evidenceId: conflict.ids.evidence}), 'VISA_DOCUMENT_FACT_CONFLICT');
  const owned = await machineFactsFixture(); owned.claim(true);
  throwsCode(() => owned.service.stageDocumentFacts(owned.jobId, {evidenceId: owned.ids.evidence}), 'HUMAN_OWNERSHIP');
  const running = await machineFactsFixture(); running.service.acquireJob(running.jobId, {workerId: 'already-running-document-job'});
  throwsCode(() => running.service.stageDocumentFacts(running.jobId, {evidenceId: running.ids.evidence}), 'VISA_DOCUMENT_STAGE_IN_PROGRESS');
  const unconfigured = await machineFactsFixture(); unconfigured.service.canAutomate = undefined;
  throwsCode(() => unconfigured.service.stageDocumentFacts(unconfigured.jobId, {evidenceId: unconfigured.ids.evidence}), 'VISA_DOCUMENT_AUTOMATION_PAUSED');
});

test('assisted staff document gaps skip duplicate document questions while health still requires the client and tampering pauses delivery',async()=>{
 const f=await machineFactsFixture({missing:['passportType','issueDate']}),before=structuredClone(f.c);
 f.raad.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary',issueDate:'2020-01-01',maritalStatus:'single',health:{hospitalizedOrEmergency:false,accidentDisability:false,congenitalCondition:false}},confirm:true});const applied=f.raad.applyMachineDossier(CUSTOMER,{applicantIndex:0,expectedRevision:1,expectedCaseSignature:visaCaseSignature(f.c),evidenceId:f.ids.evidence});assert.equal(applied.staffReviewRequired,true);
 f.service.stageDocumentFacts(f.jobId,{fields:f.applicant.fields,evidenceId:f.ids.evidence});assert.equal(f.service.stageDraftDocumentSupplement(f.jobId).ok,true);assert.equal(f.service.stageDraftDocumentSupplement(f.jobId).duplicate,true);
 const asked=f.service.askQuestions(f.jobId);assert.ok(!asked.questions.some(q=>['passportType','issueDate','latinFirstName','birthPlace','sex'].includes(q.field)));assert.ok(asked.questions.some(q=>q.field==='health.hospitalizedOrEmergency'));assert.ok(asked.questions.some(q=>q.field==='maritalStatus'));assert.equal(f.service.job(f.jobId).stagedFields.health,undefined);assert.equal(f.service.job(f.jobId).stagedFields.maritalStatus,undefined);assert.equal(f.service.job(f.jobId).answerConfirmation,undefined);assert.equal(f.raad.get(CUSTOMER).review.complete,false);assert.deepEqual(f.c,before);
 const raw=f.store.data.raadApplications[CUSTOMER].applicants[0];raw.revision++;raw.review.reviewedAt=f.options.now();assert.doesNotThrow(()=>f.service.assertDocumentFactsCurrent(f.service.job(f.jobId)));assert.equal(f.service.getConfirmedFields(f.jobId).complete,false);raw.fields.issueDate='2020-02-01';assert.throws(()=>f.service.assertDocumentFactsCurrent(f.service.job(f.jobId)),{code:'VISA_DOCUMENT_EVIDENCE_STALE'});
});

async function confirmedAssistedFixture(){
 const f=await machineFactsFixture({missing:['passportType','issueDate']});
 f.raad.prepare(CUSTOMER,{expectedRevision:0,fields:{passportType:'ordinary',issueDate:'2020-01-01'},confirm:true});f.raad.applyMachineDossier(CUSTOMER,{applicantIndex:0,expectedRevision:1,expectedCaseSignature:visaCaseSignature(f.c),evidenceId:f.ids.evidence});
 f.service.stageDocumentFacts(f.jobId,{fields:f.applicant.fields,evidenceId:f.ids.evidence});f.service.stageDraftDocumentSupplement(f.jobId);answerRemainingMachineQuestions(f);const summary=f.service.job(f.jobId).summary;f.service.confirmAnswers({sender:CUSTOMER,token:summary.token,confirm:true,messageId:'synthetic-assisted-consent'});return f;
}
test('assisted portal uses exact verified media and genuine current client consent without inventing staff review',async()=>{
 const f=await confirmedAssistedFixture(),before=structuredClone(f.c),proof=f.service.getConfirmedFields(f.jobId),result=f.raad.portalDossier(CUSTOMER,{clientProof:proof});
 assert.equal(result.ready,true,JSON.stringify(result.issues));assert.equal(result.source,'assisted');assert.equal(result.fields.passportType,'ordinary');assert.equal(result.fields.issueDate,'2020-01-01');assert.equal(result.fields.health.hospitalizedOrEmergency,false);assert.equal(f.raad.get(CUSTOMER).review.complete,false);assert.equal(f.store.data.raadApplications[CUSTOMER].applicants[0].machineReview,undefined);assert.deepEqual(f.c,before);assert.equal(f.c.submissionStatus,'not_submitted');
});
test('assisted portal rejects absent consent, changed draft facts, extra facts, swapped documents and stale payment approval',async()=>{
 for(const mutate of [
 (f,p)=>{p.confirmation.granted=false;},
 (f,p)=>{f.store.data.raadApplications[CUSTOMER].applicants[0].fields.issueDate='2020-02-01';},
 (f,p)=>{f.store.data.raadApplications[CUSTOMER].applicants[0].fields.passportNumber='OTHER123';},
 (f,p)=>{f.store.data.raadApplications[CUSTOMER].applicants[0].fields.latinGrandfatherName='Unverified';},
 (f,p)=>{f.store.data.raadApplications[CUSTOMER].applicants[0].documents.passport.mediaId=f.ids.photo;},
 (f,p)=>{delete f.service.job(f.jobId).staffDocumentSupplement;},
 (f,p)=>{f.c.paymentStatus='unverified';}
 ]){const f=await confirmedAssistedFixture(),proof=f.service.getConfirmedFields(f.jobId);mutate(f,proof);assert.equal(f.raad.portalDossier(CUSTOMER,{clientProof:proof}).ready,false);}
});

test('a bound document-list answer stages as a customer answer and is included in final consent without repeating the question',async()=>{
 const f=await machineFactsFixture({missing:['passportType']}),raw=f.store.data.visaDocumentIntake.cases[CUSTOMER],now=f.options.now();
 f.store.data.visaDocumentNotifications={items:{list:{customer:CUSTOMER,state:'accepted',expiresAt:now+60000,payload:{type:'question',field:'passportType',applicantIndex:0},binding:{caseId:f.c.id,caseSignature:visaCaseSignature(f.c),generation:raw.generation},answer:{field:'passportType',value:'ordinary',applicantIndex:0,evidenceId:f.ids.evidence,messageId:'wamid.list-choice',at:now}}}};
 const before=structuredClone(f.c),staged=f.service.stageDocumentFacts(f.jobId,{evidenceId:f.ids.evidence});assert.equal(staged.stagedFields.passportType,'ordinary');assert.equal(f.applicant.fields.passportType,undefined);assert.deepEqual(f.c,before);
 const asked=answerRemainingMachineQuestions(f);assert(!asked.questions.some(q=>q.field==='passportType'));const summary=f.service.job(f.jobId).summary;assert.equal(summary.answers.passportType,'ordinary');assert.equal(f.service.job(f.jobId).state,'awaiting_answer_confirmation');f.service.confirmAnswers({sender:CUSTOMER,token:summary.token,confirm:true,messageId:'list-answer-final-consent'});const proof=f.service.getConfirmedFields(f.jobId);assert.equal(proof.complete,true);assert.equal(proof.fields.passportType,'ordinary');
});

test('operator coordination isolates the customer, asks one bound question at a time and records actual operator authority', async()=>{
 const f=fixture({count:1});f.options.env.RAAD_COORDINATION_MODE='operator';f.options.env.RAAD_COORDINATION_WHATSAPP='971507993145';
 const a=await f.activate(),id=a.jobs[0].id;
 const q=f.service.askQuestions(id,{fields:['arabicFirstName','arabicFamilyName']});
 const messages=f.service.pendingMessages().filter(i=>i.kind==='applicant_question');assert.equal(messages.length,1);assert.equal(messages[0].recipient,'971507993145');assert.equal(messages[0].customer,CUSTOMER);
 throwsCode(()=>f.service.answerQuestion({sender:CUSTOMER,token:q.questions[0].token,value:'اسم'}),'VISA_ANSWER_CONTEXT_INVALID');
 assert.equal(f.service.handleCustomerMessage(CUSTOMER,{visaAnswer:{token:q.questions[0].token},id:'old-client'}).handled,true);
 await f.service.dispatchMessage(messages[0].id);
 const answered=f.service.handleCustomerMessage('971507993145',{id:'owner-name',contextId:'outbound-2',text:'تجريبي'});assert.equal(answered.ok,true);
 const next=f.service.pendingMessages().filter(i=>i.kind==='applicant_question');assert.equal(next.length,1);assert.equal(next[0].payload.field,'arabicFamilyName');
 f.service.answerQuestion({sender:'971507993145',token:q.questions[1].token,value:'اختبار'});
 const job=f.service.data().jobs[id];assert.equal(job.state,'awaiting_answer_confirmation');const summary=f.service.pendingMessages().find(i=>i.kind==='applicant_answer_summary');assert.equal(summary.recipient,'971507993145');assert.match(summary.payload.text,/مسؤول المكتب/);
 f.service.confirmAnswers({sender:'971507993145',token:job.summary.token,confirm:true,messageId:'actual-owner-confirmation'});
 const proof=f.service.getConfirmedFields(id);assert.equal(proof.confirmation.actor,'operator');assert.equal(proof.confirmation.sender,'971507993145');assert.equal(proof.confirmation.representedCustomer,CUSTOMER);assert.equal(proof.confirmation.messageId,'actual-owner-confirmation');assert.equal(proof.fields.arabicFirstName,'تجريبي');
});
test('deployment migration retains prior real answers and cancels old unsent client questions',async()=>{
 const f=fixture({count:1});const a=await f.activate(),id=a.jobs[0].id;const q=f.service.askQuestions(id,{fields:['arabicFirstName']});const old=f.service.pendingMessages().find(m=>m.kind==='applicant_question');
 f.options.env.RAAD_COORDINATION_MODE='operator';f.options.env.RAAD_COORDINATION_WHATSAPP='971507993145';const upgraded=new VisaFulfilment(f.options);const job=upgraded.data().jobs[id];assert.equal(job.state,'queued');assert.equal(job.coordination.recipient,'971507993145');assert.equal(upgraded.data().outbox[old.id].state,'cancelled');assert.equal(upgraded.data().outbox[old.id].failure,'COORDINATION_MOVED');assert.equal(job.summary,undefined);
 assert.equal(upgraded.handleCustomerMessage(CUSTOMER,{visaAnswer:{token:q.questions[0].token},id:'stale-click'}).ok,true);
});
