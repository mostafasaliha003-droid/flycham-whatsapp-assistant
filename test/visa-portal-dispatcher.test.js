'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {VisaPortalDispatcher} = require('../src/visa-portal-dispatcher');
const {visaCaseSignature} = require('../src/visa-case-signature');

const CUSTOMER = '15550002001', OWNER = '15550002999';
const IDS = {receipt: '10000000-0000-4000-8000-000000000001', passport: '10000000-0000-4000-8000-000000000002', residence: '10000000-0000-4000-8000-000000000003', photo: '10000000-0000-4000-8000-000000000004', pdf: '10000000-0000-4000-8000-000000000005'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const PDF = Buffer.from('%PDF-1.7\nexample application copy\n%%EOF');
const completedState = (job, overrides = {}) => ({jobId: job.id, caseSignature: job.caseSignature, applicantIndex: job.applicantIndex, stage: 'completed', phase: 'request_copy', saved: true, artifactReady: true, reference: 'E12345678', artifactSha256: digest(PDF), paymentAttempted: false, returnedFromPayment: true, ...overrides});
const jsonResponse = (value, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => structuredClone(value)});
function pdfResponse(bytes = PDF, mime = 'application/pdf') { return {ok: true, headers: {get: name => name === 'content-type' ? mime : null}, body: (async function* () { yield bytes; })()}; }
function applicant() {
  return {nationalityCode: 'EGY', issuingCountryCode: 'EGY', passportNumber: 'EXAMPLE88', passportType: 'ordinary', issueDate: '2020-01-01', expiryDate: '2100-01-01', birthDate: '1990-04-03', birthPlace: 'Example City', sex: 'M', latinFirstName: 'Ari', latinFamilyName: 'Example', emiratesId: '784199000000001', residenceExpiry: '2100-01-01', maritalStatus: 'single', previousNationality: false, travelledLastFiveYears: false, performUmrah: false, gccResident: true, priorGccDeportation: false, priorGccRuleViolation: false, health: {hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false}, saudiAddress: 'Example Hotel, Riyadh', transport: 'air', arrivalPort: 'Example Airport', entryDate: '2099-01-01'};
}
function fixture({count = 1, send, fetchImpl, configured = true} = {}) {
  const calls = [], storedCopies = [], sent = [], reads = [];
  let claimed = true, state = {stage: 'running', phase: 'personal_info'}, saves = 0, ready = true;
  const c = {id: 'example-case', revision: 2, policyVersion: 'example-policy', applicantCount: count, applicants: Array.from({length: count}, () => ({nationality: 'مصر', latinFirstName: 'Ari', latinFamilyName: 'Example'})), quote: {total: count * 240}, documents: [], paymentStatus: 'awaiting_verification', submissionStatus: 'not_submitted'};
  const records = {};
  for (const [kind, id] of Object.entries(IDS)) {
    const bytes = kind === 'pdf' ? PDF : Buffer.from('example-image-' + kind);
    records[id] = {id, customer: CUSTOMER, mimeType: kind === 'pdf' ? 'application/pdf' : 'image/png', size: bytes.length, checksum: digest(bytes), bytes, expiresAt: Date.now() + 86400000};
  }
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: records, complaints: [], conversationJournal: {customers: {[CUSTOMER]: {}}}, raadApplications: {[CUSTOMER]: {applicants: {}}}}, save() { saves++; }};
  const drafts = Array.from({length: count}, (_, applicantIndex) => ({applicantIndex, revision: 5, fields: applicant(), defaults: {mission: 'Abu Dhabi', applicationPhone: '+' + CUSTOMER, contactEmail: 'example@example.test', insurancePhone: '+' + CUSTOMER, postalCode: '00000'}, documents: {passport: {mediaId: IDS.passport}, residence: {mediaId: IDS.residence}, photo: {mediaId: IDS.photo}}, review: {complete: true, invalidated: false, fingerprint: 'reviewed-example-' + applicantIndex}}));
  for (const draft of drafts) store.data.raadApplications[CUSTOMER].applicants[draft.applicantIndex] = draft;
  const raad = {get(customer, {applicantIndex}) { assert.equal(customer, CUSTOMER); return structuredClone(drafts[applicantIndex]); }};
  const mediaStore = {get(id, {customer}) { const record = records[id]; if (!record || record.customer !== customer) throw Error('MEDIA_NOT_FOUND'); const {bytes, ...metadata} = record; return structuredClone(metadata); }, read(id, {customer}) { const metadata = this.get(id, {customer}); reads.push({id, customer}); return {metadata, bytes: Buffer.from(records[id].bytes)}; }, storeApplicationPdf(customer, input) { storedCopies.push({customer, ...input, bytes: Buffer.from(input.bytes)}); records[IDS.pdf] = {...records[IDS.pdf], customer, bytes: input.bytes, size: input.bytes.length, checksum: digest(input.bytes), jobId: input.jobId, applicationReference: input.applicationReference}; return this.get(IDS.pdf, {customer}); }};
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false, updateVisa(customer, input) { assert.equal(customer, CUSTOMER); c.staffVerification ||= {}; c.staffVerification.payment = {amount: input.amount, reference: input.reference, actor: 'staff', caseSignature: visaCaseSignature(c), verifiedAt: 1000}; c.paymentStatus = 'verified'; c.revision++; }};
  const env = {RAAD_OTP_OWNER_WHATSAPP: OWNER, RAAD_VISA_AUTOMATION_ENABLED: 'true', RAAD_BROWSER_WORKER_URL: configured ? 'https://worker.example.test/' : '', RAAD_JOB_BRIDGE_KEY: 'example-bridge-key-'.repeat(3)};
  const fulfilment = new VisaFulfilment({store, inbox, mediaStore, raad, env, send: send || (async (to, payload, guard) => { guard(); sent.push({to, payload}); return {messageId: 'accepted-' + sent.length}; })});
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname, request = {url, path, ...options, body: options.body ? JSON.parse(options.body) : undefined}; calls.push(request);
    if (path === '/health') return jsonResponse({ready});
    if (fetchImpl) return await fetchImpl(request);
    if (path.endsWith('/artifact')) return pdfResponse();
    if (path.endsWith('/cancel')) return jsonResponse({ownedBrowserClosed: true, stage: 'cancelled'});
    if (path.endsWith('/otp')) return jsonResponse({accepted: true});
    if (options.method === 'POST') return jsonResponse({accepted: true, jobId: request.body.jobId});
    return jsonResponse(state);
  };
  const dispatcher = new VisaPortalDispatcher({fulfilment, raad, mediaStore, store, env, fetchImpl: fetcher});
  fulfilment.resumeOtp = input => dispatcher.resumeOtp(input);
  const approve = () => { fulfilment.receiveReceipt(CUSTOMER, {receiptId: IDS.receipt}); const result = fulfilment.confirmPayment(CUSTOMER, {receiptId: IDS.receipt, amount: c.quote.total, reference: 'BANK-EXAMPLE-88', actor: {id: 'example-accountant', role: 'accountant'}, actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(c), idempotencyKey: 'approval-example-1'}); claimed = false; return result; };
  const confirm = jobId => {
    const questions = fulfilment.askQuestions(jobId).questions;
    for (const question of questions) {
      if (question.type === 'choice') fulfilment.answerQuestion({sender: CUSTOMER, token: question.token, option: question.field === 'maritalStatus' ? 'single' : question.field === 'sex' ? 'male' : question.field === 'gccResident' ? 'yes' : 'no'});
      else fulfilment.answerQuestion({sender: CUSTOMER, token: question.token, value: question.field === 'birthPlace' ? 'Example City' : question.field === 'latinFirstName' ? 'Ari' : question.field === 'latinFamilyName' ? 'Example' : 'Example Hotel, Riyadh'});
    }
    fulfilment.confirmAnswers({sender: CUSTOMER, token: fulfilment.job(jobId).summary.token, confirm: true, messageId: 'inbound-consent-' + jobId});
  };
  const activate = async () => { const result = approve(); await fulfilment.dispatchMessage(result.jobs[0].paymentNoticeId); for (const job of result.jobs) confirm(job.id); return result.jobs.map(job => fulfilment.job(job.id)); };
  return {store, records, c, drafts, raad, mediaStore, fulfilment, dispatcher, env, calls, storedCopies, sent, reads, approve, activate, confirm, setState: next => { state = next; }, setReady: value => { ready = value; }, claim: value => { claimed = value; }, saves: () => saves};
}

test('bridge requires fixed HTTPS root and a configured long key', () => {
  const f = fixture(); assert.equal(f.dispatcher.configured(), true);
  for (const url of ['http://worker.example.test/', 'https://user:pass@worker.example.test/', 'https://worker.example.test/path', 'https://worker.example.test/?secret=1', 'https://worker.example.test/#part']) { f.env.RAAD_BROWSER_WORKER_URL = url; assert.equal(f.dispatcher.configured(), false); }
  f.env.RAAD_BROWSER_WORKER_URL = 'https://worker.example.test/'; f.env.RAAD_JOB_BRIDGE_KEY = 'short'; assert.equal(f.dispatcher.configured(), false);
});

test('launch sends exact applicant, consent message and current document hashes through authenticated bridge', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  const request = f.calls.find(call => call.path === '/internal/raad/jobs');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal); assert.equal(request.headers.Authorization, 'Bearer ' + f.env.RAAD_JOB_BRIDGE_KEY);
  assert.equal(request.body.jobId, job.id); assert.equal(request.body.caseId, job.caseId); assert.equal(request.body.caseSignature, job.caseSignature); assert.equal(request.body.applicantIndex, 0);
  assert.equal(request.body.clientConsent.messageId, 'inbound-consent-' + job.id); assert.equal(request.body.clientConsent.scope, 'saudi_visa_application'); assert.equal(request.body.clientConsent.granted, true);
  assert.deepEqual(request.body.documents.map(document => document.role), ['passport', 'residence', 'portrait']);
  for (const document of request.body.documents) assert.equal(document.sha256, digest(Buffer.from(document.data, 'base64')));
  assert.ok(f.reads.every(read => read.customer === CUSTOMER)); assert.equal(f.store.data.visaPortalRuns[job.id].phase, 'running'); assert.equal(f.store.data.visaPortalRuns[job.id].draftFingerprint, f.drafts[0].review.fingerprint);
});

test('paused payment acknowledgement prevents both questions and portal launch', async () => {
  const f = fixture({send: async () => ({paused: true, notDispatched: true})}), result = f.approve(); await f.dispatcher.tick();
  assert.equal(f.calls.length, 0); assert.equal(f.fulfilment.job(result.jobs[0].id).state, 'queued'); assert.equal(f.fulfilment.data().outbox[result.jobs[0].paymentNoticeId].state, 'cancelled');
});

test('actual template approval resumes only a known paused payment acknowledgement without another inbound', async () => {
  const f = fixture({send: async () => ({paused: true})}), approval = f.approve();
  const noticeId = approval.jobs[0].paymentNoticeId;
  await f.fulfilment.dispatchMessage(noticeId);
  let approved = false, reads = 0, sends = 0;
  f.dispatcher.notificationReadiness = async () => { reads++; return {paymentTemplateApproved: approved, ownerTemplateApproved: false}; };
  f.fulfilment.send = async () => { sends++; return {messages: [{id: 'accepted-after-real-template-approval'}]}; };
  await f.dispatcher.flushMessages(); assert.equal(sends, 0); assert.equal(f.fulfilment.data().outbox[noticeId].state, 'cancelled');
  approved = true;
  await f.dispatcher.flushMessages(); assert.equal(sends, 1); assert.equal(f.fulfilment.data().outbox[noticeId].state, 'accepted');
  const checked = reads; await f.dispatcher.flushMessages(); assert.equal(sends, 1); assert.equal(reads, checked);
  assert.equal(f.calls.length, 0, 'approval recovery does not perform native portal work');
});

test('uncertain sends never trigger template readiness checks or approval-based replay', async () => {
  const f = fixture({send: async () => { throw Error('synthetic unknown send outcome'); }}), approval = f.approve();
  await f.fulfilment.dispatchMessage(approval.jobs[0].paymentNoticeId);
  assert.equal(f.fulfilment.data().outbox[approval.jobs[0].paymentNoticeId].state, 'uncertain');
  f.dispatcher.notificationReadiness = async () => assert.fail('uncertain outcomes cannot authorize replay');
  await f.dispatcher.flushMessages();
  assert.equal(f.fulfilment.data().outbox[approval.jobs[0].paymentNoticeId].state, 'uncertain');
});

test('explicit client consent and complete answers are required before portal POST', async () => {
  const f = fixture(), result = f.approve(); await f.fulfilment.dispatchMessage(result.jobs[0].paymentNoticeId);
  await f.dispatcher.launch(f.fulfilment.job(result.jobs[0].id));
  assert.equal(f.calls.length, 0); assert.equal(f.fulfilment.job(result.jobs[0].id).blockedReason, 'CLIENT_ANSWERS_REQUIRED');
  f.confirm(result.jobs[0].id); f.fulfilment.job(result.jobs[0].id).answerConfirmation.messageId = null;
  await f.dispatcher.launch(f.fulfilment.job(result.jobs[0].id)); assert.equal(f.calls.length, 0);
});

test('production dossier resolution authorizes a verified machine dossier independently of staff flags', async () => {
 const f=fixture(),[job]=await f.activate();let fingerprint='verified-machine-execution-v1',resolutions=0;
 f.drafts[0].review.complete=false;
 f.raad.portalDossier=(customer,{applicantIndex,clientProof})=>{resolutions++;assert.equal(customer,CUSTOMER);assert.equal(applicantIndex,0);assert.equal(clientProof.complete,true);return {ready:true,source:'machine',fingerprint,fields:{...f.drafts[0].fields},defaults:f.drafts[0].defaults,documents:f.drafts[0].documents};};
 await f.dispatcher.launch(job);
 const run=f.store.data.visaPortalRuns[job.id];assert.equal(run.phase,'running');assert.equal(run.reviewSource,'machine');assert.equal(run.draftFingerprint,fingerprint);
 await f.dispatcher.poll(job,run);assert.ok(resolutions>=3);assert.equal(run.phase,'running');
 fingerprint='updated-machine-execution-v2';await f.dispatcher.poll(job,run);
 assert.equal(run.phase,'cancelled');assert.equal(job.state,'portal_review_required');assert.equal(f.fulfilment.data().lease,null);
 assert.equal(f.calls.filter(call=>call.path==='/internal/raad/jobs'&&call.method==='POST').length,1);
});

test('a production dossier blocker cannot be bypassed by an otherwise complete old staff review', async () => {
 const f=fixture(),[job]=await f.activate();f.raad.portalDossier=()=>({ready:false,blockedReason:'DOCUMENT_DATA_CONFLICT'});
 await f.dispatcher.launch(job);assert.equal(job.blockedReason,'DOCUMENT_DATA_CONFLICT');assert.equal(f.calls.length,0);assert.equal(f.fulfilment.data().lease,null);
});

test('queued questions wait for document intake and a current staff review remains a valid manual path', async () => {
 const f=fixture();f.drafts[0].review.complete=false;const approval=f.approve(),job=f.fulfilment.job(approval.jobs[0].id);
 const events=[];let ready=false;
 f.dispatcher.documentIntake={enabled:()=>true,prepareJob:async()=>{events.push('prepare');return {readyForQuestions:ready,status:ready?'ready':'processing'};}};
 const ask=f.fulfilment.askQuestions.bind(f.fulfilment);f.fulfilment.askQuestions=(...args)=>{events.push('questions');return ask(...args);};
 await f.dispatcher.tick();assert.equal(job.state,'queued');assert.equal(job.blockedReason,'DOCUMENTS_READING');assert.equal(events.includes('questions'),false);
 f.drafts[0].review.complete=true;
 await f.dispatcher.tick();assert.equal(job.state,'awaiting_answers');assert.equal(events.at(-2),'prepare');assert.equal(events.at(-1),'questions');assert.equal(f.calls.length,0);
});

test('reviewed applicant documents are required and source/client identity conflicts block launch', async () => {
  const f = fixture(), [job] = await f.activate(); f.drafts[0].review.complete = false;
  await f.dispatcher.launch(job); assert.equal(job.blockedReason, 'DOCUMENTS_REVIEW_REQUIRED'); assert.equal(f.calls.length, 0);
  f.drafts[0].review.complete = true; f.drafts[0].fields.latinFirstName = 'Different';
  await f.dispatcher.launch(job); assert.equal(job.blockedReason, 'DOCUMENT_DATA_CONFLICT'); assert.equal(f.calls.length, 0);
});

test('missing or oversized prepared documents do not start remote browser', async () => {
  const f = fixture(), [job] = await f.activate(); delete f.drafts[0].documents.photo;
  await f.dispatcher.launch(job); assert.equal(job.blockedReason, 'DOCUMENTS_REQUIRED'); assert.equal(f.calls.length, 0);
  f.drafts[0].documents.photo = {mediaId: IDS.photo}; f.records[IDS.photo].bytes = Buffer.alloc(1000001);
  await f.dispatcher.launch(job); assert.equal(job.blockedReason, 'DOCUMENT_PREPARATION_REQUIRED'); assert.equal(f.calls.length, 0);
});

test('question flush sends only first unanswered prompt and waits for earlier applicant', async () => {
  const f = fixture({count: 2}), result = f.approve(); await f.fulfilment.dispatchMessage(result.jobs[0].paymentNoticeId);
  for (const job of result.jobs) f.fulfilment.askQuestions(job.id, {fields: ['birthPlace', 'performUmrah']});
  await f.dispatcher.flushMessages();
  const questions = f.sent.filter(message => message.payload.type === 'question'); assert.equal(questions.length, 1); assert.equal(questions[0].payload.applicantIndex, 0); assert.equal(questions[0].payload.field, 'birthPlace');
});

test('uncertain start POST is not replayed or followed by another applicant before cancellation', async () => {
  const f = fixture({count: 2, fetchImpl: async request => { if (request.path === '/internal/raad/jobs') throw Error('transport example timeout'); return jsonResponse({ownedBrowserClosed: true, stage: 'cancelled'}); }}), jobs = await f.activate();
  f.dispatcher.recovered = true; await f.dispatcher.launch(jobs[0]);
  assert.equal(f.store.data.visaPortalRuns[jobs[0].id].phase, 'uncertain'); assert.ok(f.fulfilment.data().lease); assert.equal(f.fulfilment.data().lease.cancelled, true);
  await f.dispatcher.tick();
  assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs').length, 1);
  assert.equal(f.calls.some(call => call.path === '/internal/raad/jobs/' + jobs[0].id + '/cancel'), true);
});

test('restart cancels old remote browser work before any new applicant starts', async () => {
  const f = fixture({count: 2}), jobs = await f.activate(); await f.dispatcher.launch(jobs[0]);
  const restartedCore = new VisaFulfilment({store: f.store, inbox: {isOperatorOwned: () => false}, mediaStore: f.mediaStore, raad: f.raad, env: f.env, send: async () => ({messageId: 'after-restart'})});
  const requests = [];
  const restarted = new VisaPortalDispatcher({fulfilment: restartedCore, raad: f.raad, mediaStore: f.mediaStore, store: f.store, env: f.env, fetchImpl: async (url, options) => { const path = new URL(url).pathname; requests.push({path, method: options.method}); return jsonResponse(path === '/health' ? {ready: true} : {ownedBrowserClosed: true, stage: 'cancelled'}); }});
  await restarted.tick();
  assert.equal(requests[0].path, '/internal/raad/jobs/' + jobs[0].id + '/cancel');
  const startIndex = requests.findIndex(request => request.path === '/internal/raad/jobs'); assert.ok(startIndex > 0);
});

test('failed remote cancellation prevents launch after restart', async () => {
  const f = fixture(), [job] = await f.activate(); f.store.data.visaPortalRuns.old = {phase: 'running'};
  const requests = [];
  f.dispatcher.fetchImpl = async (url, options) => { requests.push(new URL(url).pathname); return jsonResponse({}, 503); };
  await f.dispatcher.tick();
  assert.deepEqual(requests, ['/internal/raad/jobs/old/cancel']); assert.equal(f.fulfilment.data().lease, null); assert.equal(job.state, 'ready');
});

test('OTP callback forwards code only to exact job challenge and never persists its bytes', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  f.setState({stage: 'running', phase: 'login_sms', requiresOtp: true, challengeId: 'challenge-example-1', challengeExpiresAt: Date.now() + 60000});
  await f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]); await f.dispatcher.flushMessages();
  const challenge = Object.values(f.fulfilment.data().challenges)[0];
  const result = await f.fulfilment.consumeOtp({sender: OWNER, contextId: challenge.messageId, text: '418073'});
  assert.equal(result.ok, true);
  const request = f.calls.find(call => call.path.endsWith('/otp')); assert.equal(request.path, '/internal/raad/jobs/' + job.id + '/otp'); assert.deepEqual(request.body, {challengeId: 'challenge-example-1', code: '418073'});
  assert.equal(JSON.stringify(f.store.data).includes('418073'), false);
  let guarded = false; await assert.rejects(f.dispatcher.resumeOtp({jobId: 'unrelated-job', portalChallengeId: 'challenge-example-1', code: '418074', guard: () => { guarded = true; }}), /RAAD_OTP_CONTEXT_STALE/); assert.equal(guarded, true);
});

test('completion requires positive Return proof before reading or storing application PDF', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  f.setState(completedState(job, {returnedFromPayment: undefined}));
  await f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]); assert.equal(f.storedCopies.length, 0); assert.equal(job.state, 'running');
  f.setState(completedState(job));
  await f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]);
  assert.equal(f.storedCopies.length, 1); assert.equal(f.storedCopies[0].customer, CUSTOMER); assert.equal(f.storedCopies[0].jobId, job.id); assert.equal(f.storedCopies[0].applicationReference, 'E12345678'); assert.equal(digest(f.storedCopies[0].bytes), digest(PDF));
  assert.equal(job.state, 'saved_application'); assert.equal(f.c.submissionStatus, 'not_submitted');
  const copy = f.fulfilment.pendingMessages().find(message => message.kind === 'application_request_copy'); assert.equal(copy.recipient, CUSTOMER);
});

test('artifact download rejects wrong MIME, bad PDF signature and oversize stream', async () => {
  const f = fixture();
  for (const [bytes, mime, code] of [[PDF, 'text/html', 'RAAD_ARTIFACT_TYPE_INVALID'], [Buffer.from('not a pdf'), 'application/pdf', 'RAAD_ARTIFACT_INVALID'], [Buffer.alloc(10 * 1024 * 1024 + 1), 'application/pdf', 'RAAD_ARTIFACT_TOO_LARGE']]) {
    f.dispatcher.fetchImpl = async () => pdfResponse(bytes, mime);
    await assert.rejects(f.dispatcher.request('/internal/raad/jobs/example/artifact', {artifact: true}), new RegExp(code));
  }
});

test('changed reviewed draft fingerprint cancels remote work before any artifact is stored', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  f.drafts[0].review.fingerprint = 'changed-reviewed-facts';
  f.setState(completedState(job));
  await f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]);
  assert.equal(f.storedCopies.length, 0); assert.equal(f.calls.some(call => call.path.endsWith('/cancel')), true);
});

test('HTTP success without confirmed remote cancellation cannot free shared browser on recovery', async () => {
  const f = fixture(), [job] = await f.activate(); f.store.data.visaPortalRuns.old = {phase: 'uncertain'};
  f.dispatcher.fetchImpl = async () => jsonResponse({accepted: false, cancelled: false, leaseReleased: false});
  await f.dispatcher.tick();
  assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs').length, 0);
  assert.equal(f.fulfilment.data().lease, null); assert.equal(job.state, 'ready'); assert.equal(f.dispatcher.recovered, false);
});

test('artifact metadata identity and actual PDF digest must match exact pending applicant', async () => {
  for (const patch of [{jobId: 'foreign-job'}, {caseSignature: 'c'.repeat(64)}, {applicantIndex: 1}, {artifactSha256: 'd'.repeat(64)}]) {
    const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job); f.setState(completedState(job, patch));
    await assert.rejects(f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]), /RAAD_ARTIFACT_(?:BINDING|DIGEST)_INVALID/);
    assert.equal(f.storedCopies.length, 0); assert.equal(job.state, 'running');
  }
});

test('OTP guard rejection happens before any bridge request', async () => {
  const f = fixture();
  await assert.rejects(f.dispatcher.resumeOtp({jobId: 'example-job', portalChallengeId: 'example-challenge', code: '519204', guard: () => { throw Error('EXACT_LEASE_INVALID'); }}), /EXACT_LEASE_INVALID/);
  assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.store.data).includes('519204'), false);
});

test('review changes during PDF download prevent its storage or customer delivery', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job); f.setState(completedState(job));
  const fetcher = f.dispatcher.fetchImpl;
  f.dispatcher.fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith('/artifact')) { f.drafts[0].review.fingerprint = 'changed-during-download'; return pdfResponse(); }
    return fetcher(url, options);
  };
  await assert.rejects(f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]), /RAAD_DRAFT_CHANGED/);
  assert.equal(f.storedCopies.length, 0); assert.equal(f.fulfilment.pendingMessages().filter(item => item.kind === 'application_request_copy').length, 0);
});

test('terminal worker failure closes its owned browser before releasing the shared lease', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  f.setState({stage: 'blocked', phase: 'validation', blocker: {code: 'EXAMPLE_PORTAL_BLOCKER'}, ownedBrowserClosed: false});
  await f.dispatcher.poll(job, f.store.data.visaPortalRuns[job.id]);
  assert.equal(f.calls.some(call => call.path === '/internal/raad/jobs/' + job.id + '/cancel'), true);
  assert.equal(f.fulfilment.data().lease, null); assert.equal(job.state, 'portal_review_required');
});

test('cold browser readiness uses safe GET retries before acquiring lease or starting native work', async () => {
  const f = fixture(), [job] = await f.activate(); f.setReady(false);
  await f.dispatcher.launch(job); await f.dispatcher.launch(job);
  assert.equal(job.blockedReason, 'BROWSER_STARTING'); assert.equal(job.state, 'ready'); assert.equal(f.fulfilment.data().lease, null);
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/health'], ['GET', '/health']]);
  assert.equal(f.store.data.visaPortalRuns[job.id], undefined);
  f.setReady(true); await f.dispatcher.launch(job);
  assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs' && call.method === 'POST').length, 1);
  assert.equal(f.store.data.visaPortalRuns[job.id].phase, 'running'); assert.ok(f.fulfilment.data().lease); assert.equal(job.blockedReason, undefined);
});

test('unreachable owner notification channel pauses before any browser request and resumes once ready', async () => {
  const f = fixture(), [job] = await f.activate();
  let ready = false;
  f.dispatcher.ownerNotificationReady = async () => ready;
  await f.dispatcher.launch(job);
  assert.equal(job.blockedReason, 'OWNER_NOTIFICATION_NOT_READY'); assert.equal(job.state, 'ready');
  assert.equal(f.calls.length, 0); assert.equal(f.fulfilment.data().lease, null); assert.equal(f.store.data.visaPortalRuns[job.id], undefined);
  ready = true; await f.dispatcher.launch(job);
  assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs' && call.method === 'POST').length, 1);
  assert.equal(f.store.data.visaPortalRuns[job.id].phase, 'running'); assert.equal(job.blockedReason, undefined);
});

test('unverified or truthy nonboolean owner readiness cannot start native work', async () => {
  for (const readiness of ['unknown', 'true', 'throw']) {
    const f = fixture(), [job] = await f.activate();
    f.dispatcher.ownerNotificationReady = async () => { if (readiness === 'throw') throw Error('synthetic readiness failure'); return readiness; };
    await f.dispatcher.launch(job);
    assert.equal(job.blockedReason, 'OWNER_NOTIFICATION_NOT_READY'); assert.equal(f.calls.length, 0); assert.equal(f.fulfilment.data().lease, null);
  }
});

test('a document review changed during asynchronous readiness cannot submit the earlier dossier', async () => {
  for (const stage of ['owner', 'browser']) {
    const f = fixture(), [job] = await f.activate();
    const changeReviewedDraft = () => { f.drafts[0].fields.latinFirstName = 'Updated'; f.drafts[0].review.fingerprint = 'new-reviewed-fingerprint'; };
    if (stage === 'owner') f.dispatcher.ownerNotificationReady = async () => { changeReviewedDraft(); return true; };
    else { const fetcher = f.dispatcher.fetchImpl; f.dispatcher.fetchImpl = async (url, options) => { if (new URL(url).pathname === '/health') changeReviewedDraft(); return fetcher(url, options); }; }
    await f.dispatcher.launch(job);
    assert.equal(job.blockedReason, 'DOCUMENTS_REVIEW_REQUIRED'); assert.equal(f.fulfilment.data().lease, null);
    assert.equal(f.calls.some(call => call.path === '/internal/raad/jobs'), false); assert.equal(f.store.data.visaPortalRuns[job.id], undefined);
  }
});

test('unavailable readiness GET remains retryable without quarantining an uncertain POST', async () => {
  const f = fixture(), [job] = await f.activate(), fetcher = f.dispatcher.fetchImpl;
  let cold = true;
  f.dispatcher.fetchImpl = async (url, options) => { if (cold && new URL(url).pathname === '/health') throw Error('example cold-start timeout'); return fetcher(url, options); };
  await f.dispatcher.launch(job);
  assert.equal(job.blockedReason, 'BROWSER_STARTING'); assert.equal(f.fulfilment.data().lease, null); assert.equal(f.store.data.visaPortalRuns[job.id], undefined);
  cold = false; await f.dispatcher.launch(job);
  assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs').length, 1); assert.equal(f.store.data.visaPortalRuns[job.id].phase, 'running');
});

test('lost remote job 404 requires confirmed cleanup then stops locally without automatic recreation', async () => {
  const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
  const run = f.store.data.visaPortalRuns[job.id], requests = [];
  f.dispatcher.recovered = true;
  f.dispatcher.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname; requests.push({path, method: options.method});
    if (path === '/internal/raad/jobs/' + job.id && options.method === 'GET') return jsonResponse({}, 404);
    if (path.endsWith('/cancel')) {
      assert.equal(f.fulfilment.data().lease.token, run.leaseToken);
      assert.equal(run.phase, 'running'); assert.equal(job.state, 'running');
      return jsonResponse({stage: 'cancelled', ownedBrowserClosed: true});
    }
    throw Error('UNEXPECTED_NATIVE_RECREATION');
  };
  await f.dispatcher.poll(job, run);
  assert.deepEqual(requests.map(request => [request.method, request.path]), [['GET', '/internal/raad/jobs/' + job.id], ['POST', '/internal/raad/jobs/' + job.id + '/cancel']]);
  assert.equal(run.phase, 'interrupted'); assert.equal(job.state, 'portal_review_required'); assert.equal(job.blockedReason, 'BROWSER_JOB_LOST'); assert.equal(f.fulfilment.data().lease, null);
  const persisted = structuredClone(f.store.data);
  assert.equal(persisted.visaPortalRuns[job.id].phase, 'interrupted'); assert.equal(persisted.visaFulfilment.jobs[job.id].blockedReason, 'BROWSER_JOB_LOST');
  await f.dispatcher.tick(); await f.dispatcher.tick();
  assert.equal(requests.length, 2); assert.equal(f.calls.filter(call => call.path === '/internal/raad/jobs' && call.method === 'POST').length, 1);
});

test('lost remote job keeps its lease when cleanup response does not prove owned browser closed', async () => {
  for (const response of [{stage: 'cancelled', ownedBrowserClosed: false}, {stage: 'cancelling', ownedBrowserClosed: true}, {stage: 'cancelled'}]) {
    const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
    const run = f.store.data.visaPortalRuns[job.id], leaseToken = run.leaseToken;
    f.dispatcher.fetchImpl = async (url, options) => new URL(url).pathname.endsWith('/cancel') ? jsonResponse(response) : jsonResponse({}, 404);
    await assert.rejects(f.dispatcher.poll(job, run), /RAAD_CANCEL_UNCONFIRMED/);
    assert.equal(f.fulfilment.data().lease.token, leaseToken); assert.equal(run.phase, 'running'); assert.equal(job.state, 'running'); assert.notEqual(job.blockedReason, 'BROWSER_JOB_LOST');
  }
});

test('lost remote job keeps its lease if cancellation transport or server request fails', async () => {
  for (const cancelFailure of ['transport', 'server']) {
    const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
    const run = f.store.data.visaPortalRuns[job.id], leaseToken = run.leaseToken;
    f.dispatcher.fetchImpl = async url => {
      if (!new URL(url).pathname.endsWith('/cancel')) return jsonResponse({}, 404);
      if (cancelFailure === 'transport') throw Error('EXAMPLE_CANCEL_TIMEOUT');
      return jsonResponse({}, 503);
    };
    await assert.rejects(f.dispatcher.poll(job, run), /EXAMPLE_CANCEL_TIMEOUT|RAAD_BRIDGE_HTTP_503/);
    assert.equal(f.fulfilment.data().lease.token, leaseToken); assert.equal(run.phase, 'running'); assert.equal(job.state, 'running');
  }
});

test('non404 job GET errors retain current run and lease for safe later polling', async () => {
  for (const failure of [500, 503, 'transport', '404-message-only']) {
    const f = fixture(), [job] = await f.activate(); await f.dispatcher.launch(job);
    const run = f.store.data.visaPortalRuns[job.id], leaseToken = run.leaseToken, requests = [];
    f.dispatcher.fetchImpl = async (url, options) => {
      requests.push({path: new URL(url).pathname, method: options.method});
      if (failure === 'transport') throw Error('EXAMPLE_STATUS_TIMEOUT');
      if (failure === '404-message-only') throw Error('RAAD_BRIDGE_HTTP_404');
      return jsonResponse({}, failure);
    };
    await assert.rejects(f.dispatcher.poll(job, run), /RAAD_BRIDGE_HTTP_500|RAAD_BRIDGE_HTTP_503|EXAMPLE_STATUS_TIMEOUT|RAAD_BRIDGE_HTTP_404/);
    assert.deepEqual(requests, [{path: '/internal/raad/jobs/' + job.id, method: 'GET'}]);
    assert.equal(f.fulfilment.data().lease.token, leaseToken); assert.equal(run.phase, 'running'); assert.equal(job.state, 'running'); assert.notEqual(job.blockedReason, 'BROWSER_JOB_LOST');
    f.dispatcher.fetchImpl = async () => jsonResponse({stage: 'running', phase: 'after_transient_error'});
    await f.dispatcher.poll(job, run);
    assert.equal(run.lastStage, 'after_transient_error'); assert.equal(f.fulfilment.data().lease.token, leaseToken);
  }
});

test('blocked diagnostics contain only finite metadata and deduplicate unchanged state',async()=>{const f=fixture(),[job]=await f.activate();job.blockedReason='PORTAL_START_UNCERTAIN';job.state='portal_review_required';job.applicationReference='PRIVATE_REFERENCE';f.store.data.visaPortalRuns[job.id]={phase:'uncertain',lastStage:'preflight',leaseToken:'PRIVATE_TOKEN'};const lines=[],original=console.info;try{console.info=line=>lines.push(line);f.dispatcher.diagnose();f.dispatcher.diagnose();assert.equal(lines.length,1);const row=JSON.parse(lines[0].split('] ')[1]);assert.equal(row.code,'PORTAL_START_UNCERTAIN');assert.equal(row.hasReference,true);assert.match(row.caseHash,/^[a-f0-9]{12}$/);for(const secret of [CUSTOMER,job.id,job.caseId,'PRIVATE_REFERENCE','PRIVATE_TOKEN'])assert.equal(lines[0].includes(secret),false);job.blockedReason='PRIVATE!VALUE';f.dispatcher.diagnose();assert.equal(JSON.parse(lines[1].split('] ')[1]).code,'unconfirmed');}finally{console.info=original;}});
