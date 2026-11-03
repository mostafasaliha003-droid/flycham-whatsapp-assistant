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
  return {nationalityCode: 'EGY', issuingCountryCode: 'EGY', passportNumber: 'EXAMPLE88', passportType: 'ordinary', issueDate: '2020-01-01', expiryDate: '2100-01-01', birthDate: '1990-04-03', birthPlace: 'Example City', sex: 'M', latinFirstName: 'Ari', latinFatherName:'Example', arabicFirstName:'مثال', arabicFatherName:'مثال', arabicFamilyName:'مثال', latinFamilyName: 'Example', emiratesId: '784199000000001', residenceExpiry: '2100-01-01', maritalStatus: 'single', previousNationality: false, travelledLastFiveYears: false, performUmrah: false, gccResident: true, priorGccDeportation: false, priorGccRuleViolation: false, health: {hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false}, saudiAddress: 'Example Hotel, Riyadh', transport: 'air', arrivalPort: 'Example Airport', entryDate: '2099-01-01'};
}
function fixture({count = 1, send, fetchImpl, configured = true, printSupported = false} = {}) {
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
  const mediaStore = {get(id, {customer}) { const record = records[id]; if (!record || record.customer !== customer) throw Error('MEDIA_NOT_FOUND'); const {bytes, ...metadata} = record; return structuredClone(metadata); }, read(id, {customer}) { const metadata = this.get(id, {customer}); reads.push({id, customer}); return {metadata, bytes: Buffer.from(records[id].bytes)}; }, storeApplicationPdf(customer, input) { storedCopies.push({customer, ...input, bytes: Buffer.from(input.bytes)}); records[IDS.pdf] = {...records[IDS.pdf], customer, bytes: input.bytes, size: input.bytes.length, checksum: digest(input.bytes), jobId: input.jobId, applicationReference: input.applicationReference,purpose:'raad_application_copy'}; return this.get(IDS.pdf, {customer}); }};
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false, updateVisa(customer, input) { assert.equal(customer, CUSTOMER); c.staffVerification ||= {}; c.staffVerification.payment = {amount: input.amount, reference: input.reference, actor: 'staff', caseSignature: visaCaseSignature(c), verifiedAt: 1000}; c.paymentStatus = 'verified'; c.revision++; }};
  const env = {RAAD_OTP_OWNER_WHATSAPP: OWNER, RAAD_VISA_AUTOMATION_ENABLED: 'true', RAAD_BROWSER_WORKER_URL: configured ? 'https://worker.example.test/' : '', RAAD_JOB_BRIDGE_KEY: 'example-bridge-key-'.repeat(3)};
  const fulfilment = new VisaFulfilment({store, inbox, mediaStore, raad, env, send: send || (async (to, payload, guard) => { guard(); sent.push({to, payload}); return {messageId: 'accepted-' + sent.length}; })});
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname, request = {url, path, ...options, body: options.body ? JSON.parse(options.body) : undefined}; calls.push(request);
    if (path === '/health') return jsonResponse({ready,production:{activeJob:false,printExistingSupported:printSupported}});
    if (fetchImpl) return await fetchImpl(request);
    if (path.endsWith('/artifact')) return pdfResponse();
    if (path.endsWith('/cancel')) return jsonResponse({ownedBrowserClosed: true, stage: 'cancelled'});
    if (path.endsWith('/otp')) return jsonResponse({accepted: true});
    if (options.method === 'POST') return jsonResponse({accepted: true, jobId: request.body.jobId});
    return jsonResponse(state);
  };
  const dispatcher = new VisaPortalDispatcher({fulfilment, raad, mediaStore, store, env, startupGraceMs:0, fetchImpl: fetcher});
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
  const restarted = new VisaPortalDispatcher({fulfilment: restartedCore, raad: f.raad, mediaStore: f.mediaStore, store: f.store, env: f.env, startupGraceMs:0, fetchImpl: async (url, options) => { const path = new URL(url).pathname; requests.push({path, method: options.method}); return jsonResponse(path === '/health' ? {ready: true} : {ownedBrowserClosed: true, stage: 'cancelled'}); }});
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

test('missing portal name facts ask targeted questions before launching without repeating confirmed health answers',async()=>{const f=fixture(),[job]=await f.activate();delete f.drafts[0].fields.arabicFirstName;await f.dispatcher.launch(job);assert.equal(job.state,'awaiting_answers');assert.deepEqual(Object.values(job.questions).map(q=>q.field),['arabicFirstName']);assert.ok(job.confirmedFields.health);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);});
test('legacy missing-field preflight resumes only into followup after confirmed cleanup',async()=>{const f=fixture(),[job]=await f.activate();delete f.drafts[0].fields.arabicFirstName;job.state='portal_review_required';job.blockedReason='MISSING_FIELD';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'preflight'};await f.dispatcher.recoverMissingPreflight();assert.equal(job.state,'awaiting_answers');assert.deepEqual(Object.values(job.questions).map(q=>q.field),['arabicFirstName']);assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);});
test('preflight followup never reopens saved, uncertain or post-login cases',async()=>{for(const override of [{portalSaved:true},{applicationReference:'E12345'},{phase:'uncertain'},{lastStage:'login'}]){const f=fixture(),[job]=await f.activate();delete f.drafts[0].fields.arabicFirstName;job.state='portal_review_required';job.blockedReason='MISSING_FIELD';Object.assign(job,override);f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'preflight',...override};await f.dispatcher.recoverMissingPreflight();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,0);}});
test('unconfirmed remote cleanup leaves preflight blocked and sends no followup',async()=>{const f=fixture({fetchImpl:async path=>path.endsWith('/cancel')?jsonResponse({stage:'cancelled',ownedBrowserClosed:false}):undefined}),[job]=await f.activate();delete f.drafts[0].fields.arabicFirstName;job.state='portal_review_required';job.blockedReason='MISSING_FIELD';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'preflight'};await f.dispatcher.recoverMissingPreflight();assert.equal(job.state,'portal_review_required');});

test('one login-only recovery requires current consent and confirmed closed remote browser',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};const consent=structuredClone(job.answerConfirmation),answers=structuredClone(job.confirmedFields);await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.loginRecoveryAttempts,1);assert.deepEqual(job.answerConfirmation,consent);assert.deepEqual(job.confirmedFields,answers);assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});
test('login recovery never reopens uncertain, saved or post-login cases',async()=>{for(const override of [{portalSaved:true},{applicationReference:'E12345'},{phase:'uncertain'},{lastStage:'personal_info'},{blockedReason:'SAVE_UNCERTAIN'}]){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';Object.assign(job,override);f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login',...override};await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,0);}});
test('login recovery stops on missing consent or unconfirmed remote cleanup',async()=>{for(const consentMissing of [true,false]){const f=fixture({fetchImpl:async path=>path.endsWith('/cancel')?jsonResponse({stage:'cancelled',ownedBrowserClosed:false}):undefined}),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};if(consentMissing)delete job.answerConfirmation;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(job.loginRecoveryAttempts,undefined);}});

test('startup grace processes messages without contacting or launching a browser',async()=>{const f=fixture(),[job]=await f.activate();f.dispatcher.portalReadyAt=Date.now()+30000;await f.dispatcher.tick();assert.equal(f.calls.length,0);assert.equal(job.state,'ready');});
test('preflight lease failure rechecks current authorization and cleanup once before a fresh lease',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LEASE_REVOKED';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'preflight'};const consent=structuredClone(job.answerConfirmation);await f.dispatcher.recoverPreflightLease();assert.equal(job.state,'ready');assert.equal(job.preflightRecoveryAttempts,1);assert.deepEqual(job.answerConfirmation,consent);assert.equal(f.calls.some(c=>c.path.endsWith('/cancel')),true);job.state='portal_review_required';job.blockedReason='LEASE_REVOKED';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverPreflightLease();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});
test('preflight lease recovery refuses saved, post-login, stale-consent and active-browser cases',async()=>{for(const mode of ['saved','post-login','consent','active']){const f=fixture({fetchImpl:async path=>path==='/health'&&mode==='active'?jsonResponse({ready:true,production:{activeJob:true}}):undefined}),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LEASE_REVOKED';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:mode==='post-login'?'login':'preflight'};if(mode==='saved')job.portalSaved=true;if(mode==='consent')delete job.answerConfirmation;await f.dispatcher.recoverPreflightLease();assert.equal(job.state,'portal_review_required');assert.equal(job.preflightRecoveryAttempts,undefined);}});

test('new observed login policy permits one authorized retry and preserves previous client answers',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_UNCONFIRMED';job.loginRecoveryAttempts=1;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};const fields=structuredClone(job.confirmedFields);await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.loginPolicyRecovery,'protected_applications_v7');assert.deepEqual(job.confirmedFields,fields);job.state='portal_review_required';job.blockedReason='LOGIN_UNCONFIRMED';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});
test('observed login policy never retries explicit rejection, CAPTCHA failure or post-login execution',async()=>{for(const code of ['LOGIN_REJECTED','LOGIN_CAPTCHA_UNREADABLE','LOGIN_EMAIL_OTP_REJECTED']){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason=code;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,0);}});

test('OTP-before-menu policy permits only one guarded migration from the observed-login failure',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';job.loginPolicyRecovery='single_observed_v2';job.loginRecoveryAttempts=2;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.loginPolicyRecovery,'protected_applications_v7');job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});

test('late account menu recovery migrates an unconfirmed post-OTP login only once with current consent',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';job.loginPolicyRecovery='otp_before_menu_v3';job.loginRecoveryAttempts=3;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};const consent=structuredClone(job.answerConfirmation);await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.loginPolicyRecovery,'protected_applications_v7');assert.deepEqual(job.answerConfirmation,consent);job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});

test('CAPTCHA timeout receives one fresh-session recovery under new bounded deadline with unchanged client consent',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_CAPTCHA_TIMEOUT';job.loginPolicyRecovery='account_menu_ready_v4';job.loginRecoveryAttempts=4;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};const answers=structuredClone(job.confirmedFields),consent=structuredClone(job.answerConfirmation);await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.captchaTimeoutRecovery,'bounded30s_v1');assert.deepEqual(job.confirmedFields,answers);assert.deepEqual(job.answerConfirmation,consent);assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);job.state='portal_review_required';job.blockedReason='LOGIN_CAPTCHA_TIMEOUT';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});
test('CAPTCHA deadline recovery refuses saved requests, stale consent and post-login phases',async()=>{for(const mode of ['saved','consent','post-login','unconfirmed']){const f=fixture({fetchImpl:async path=>path.endsWith('/cancel')&&mode==='unconfirmed'?jsonResponse({stage:'cancelled',ownedBrowserClosed:false}):undefined}),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_CAPTCHA_TIMEOUT';job.loginPolicyRecovery='account_menu_ready_v4';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:mode==='post-login'?'draft':'login'};if(mode==='saved')job.applicationReference='E12345';if(mode==='consent')delete job.answerConfirmation;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(job.captchaTimeoutRecovery,undefined);}});

test('account navigation compatibility gets one guarded retry after a hidden-menu OTP result',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';job.loginPolicyRecovery='account_menu_ready_v4';job.captchaTimeoutRecovery='bounded30s_v1';job.loginRecoveryAttempts=5;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};const consent=structuredClone(job.answerConfirmation);await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'ready');assert.equal(job.loginPolicyRecovery,'protected_applications_v7');assert.deepEqual(job.answerConfirmation,consent);job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(f.calls.length,count);});


test('protected applications proof gets one fresh guarded retry from the diagnostic policy',async()=>{
 const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';job.loginPolicyRecovery='account_menu_diagnostic_v6';job.loginRecoveryAttempts=6;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};
 const consent=structuredClone(job.answerConfirmation),fields=structuredClone(job.confirmedFields);
 await f.dispatcher.recoverStoppedLogin();
 assert.equal(job.state,'ready');assert.equal(job.loginPolicyRecovery,'protected_applications_v7');assert.equal(job.loginRecoveryAttempts,7);assert.deepEqual(job.answerConfirmation,consent);assert.deepEqual(job.confirmedFields,fields);assert.deepEqual(f.calls.map(call=>call.path),['/health','/internal/raad/jobs/'+job.id+'/cancel']);
 job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';f.store.data.visaPortalRuns[job.id].phase='blocked';const count=f.calls.length;
 await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(job.loginRecoveryAttempts,7);assert.equal(f.calls.length,count);
});
test('protected applications retry cannot bypass saved requests, withdrawn consent, reviewed documents or payment approval',async()=>{
 for(const mode of ['saved','reference','consent','documents','payment','payment-notice','lease','post-login']){
  const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';job.loginPolicyRecovery='account_menu_diagnostic_v6';job.loginRecoveryAttempts=6;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};
  if(mode==='saved')job.portalSaved=true;if(mode==='reference')job.applicationReference='E12345';if(mode==='consent')delete job.answerConfirmation;if(mode==='documents')f.drafts[0].review.invalidated=true;if(mode==='payment')f.fulfilment.data().cases[CUSTOMER].approvals[job.approvalId].state='stale';if(mode==='payment-notice')f.fulfilment.data().outbox[job.paymentNoticeId].state='cancelled';if(mode==='lease')f.fulfilment.data().lease={jobId:job.id};if(mode==='post-login')f.store.data.visaPortalRuns[job.id].lastStage='draft';
  await f.dispatcher.recoverStoppedLogin();assert.notEqual(job.state,'ready',mode);assert.equal(job.loginPolicyRecovery,'account_menu_diagnostic_v6',mode);assert.equal(job.loginRecoveryAttempts,6,mode);assert.equal(f.calls.length,0,mode);
 }
});
test('protected applications proof refuses an unready or active worker and unconfirmed owned cleanup',async()=>{
 for(const mode of ['unready','active','cleanup']){
  const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_EMAIL_OTP_UNCONFIRMED';job.loginPolicyRecovery='account_menu_diagnostic_v6';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};
  const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:mode!=='unready',production:{activeJob:mode==='active'}}:mode==='cleanup'&&path.endsWith('/cancel')?{stage:'cancelled',ownedBrowserClosed:false}:request(path,options);
  await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required',mode);assert.equal(job.loginPolicyRecovery,'account_menu_diagnostic_v6',mode);assert.equal(job.loginRecoveryAttempts,undefined,mode);
 }
});
test('protected applications migration never retries an explicit login or OTP rejection under the diagnostic policy',async()=>{
 for(const code of ['LOGIN_REJECTED','LOGIN_EMAIL_OTP_REJECTED','LOGIN_CAPTCHA_UNREADABLE','LOGIN_CAPTCHA_TIMEOUT']){
  const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason=code;job.loginPolicyRecovery='account_menu_diagnostic_v6';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};
  await f.dispatcher.recoverStoppedLogin();assert.equal(job.state,'portal_review_required');assert.equal(job.loginPolicyRecovery,'account_menu_diagnostic_v6');assert.equal(f.calls.length,0);
 }
});

async function expiredOtpFixture(overrides={}){
 const f=fixture(),[job]=await f.activate();
 const draft=f.dispatcher.dossier(job,f.fulfilment.getConfirmedFields(job.id));
 job.state='portal_review_required';job.blockedReason='OTP_CHALLENGE_EXPIRED';
 f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'application_sms',draftFingerprint:draft.fingerprint};
 f.env.RAAD_EXPIRED_OTP_RECOVERY_ENABLED='true';f.dispatcher.ownerNotificationReady=async()=>true;
 f.setState({jobId:job.id,caseSignature:job.caseSignature,applicantIndex:job.applicantIndex,stage:'cancelled',phase:'done',saved:false,reference:null,submissionUncertain:false,paymentAttempted:false,ownedBrowserClosed:true,...overrides});
 const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false}}:request(path,options);
 return {...f,job};
}
test('expired application OTP recovers once with current consent, exact dossier and remote unsaved cleanup proof',async()=>{
 const f=await expiredOtpFixture(),consent=structuredClone(f.job.answerConfirmation);
 await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,'ready');assert.equal(f.job.expiredOtpRecoveryAttempts,1);assert.deepEqual(f.job.answerConfirmation,consent);assert.equal(f.calls.filter(c=>c.path.endsWith('/cancel')).length,1);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);
 f.job.state='portal_review_required';f.job.blockedReason='OTP_CHALLENGE_EXPIRED';f.store.data.visaPortalRuns[f.job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.calls.length,count);assert.equal(f.job.state,'portal_review_required');
});
test('expired OTP recovery refuses unknown, saved, uncertain or other-customer remote records',async()=>{
 for(const override of [{saved:true},{reference:'E123456'},{submissionUncertain:true},{ownedBrowserClosed:false},{jobId:'other'},{caseSignature:'0'.repeat(64)},{applicantIndex:9},{stage:'running'},{paymentAttempted:true},{saved:undefined}]){
  const f=await expiredOtpFixture(override);await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,'portal_review_required',JSON.stringify(override));assert.equal(f.job.expiredOtpRecoveryAttempts,undefined);assert.equal(f.calls.some(c=>c.path.endsWith('/cancel')),false);
 }
});
test('expired OTP recovery is opt-in and requires current authorization, unchanged draft and available owner delivery',async()=>{
 for(const mode of ['disabled','claimed','draft','owner','saved','lease','stage']){
  const f=await expiredOtpFixture();if(mode==='disabled')f.env.RAAD_EXPIRED_OTP_RECOVERY_ENABLED='false';if(mode==='claimed')f.claim(true);if(mode==='draft')f.drafts[0].review.invalidated=true;if(mode==='owner')f.dispatcher.ownerNotificationReady=async()=>false;if(mode==='saved')f.job.portalSaved=true;if(mode==='lease')f.fulfilment.data().lease={jobId:'other'};if(mode==='stage')f.store.data.visaPortalRuns[f.job.id].lastStage='save';
  await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,'portal_review_required',mode);assert.equal(f.job.expiredOtpRecoveryAttempts,undefined,mode);assert.equal(f.calls.length,0,mode);
 }
});
test('expired OTP recovery cannot proceed with a busy worker, missing remote proof or failed checkpoint',async()=>{
 for(const mode of ['busy','absent','save','changed']){const f=await expiredOtpFixture(),request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>{if(path==='/health'&&mode==='busy')return{ready:true,production:{activeJob:true}};if(path.includes('/internal/raad/jobs/')&&!path.endsWith('/cancel')&&mode==='absent')throw Object.assign(Error('not found'),{status:404});const result=await request(path,options);if(path.endsWith('/cancel')&&mode==='changed')f.drafts[0].review.invalidated=true;return result;};if(mode==='save'){const save=f.store.save;f.store.save=()=>{if(f.job.expiredOtpRecoveryAttempts===1)throw Error('disk');save();};}await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,'portal_review_required',mode);assert.equal(f.job.expiredOtpRecoveryAttempts,undefined,mode);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false,mode);}
});
test('a recovered OTP job launches only once through the existing guarded dispatcher',async()=>{const f=await expiredOtpFixture();await f.dispatcher.tick();assert.equal(f.job.expiredOtpRecoveryAttempts,1);assert.equal(f.job.state,'running');assert.equal(f.calls.filter(c=>c.path==='/internal/raad/jobs'&&c.method==='POST').length,1);});
test('document readiness diagnostics disclose fixed statuses and gap labels without customer facts',()=>{
 const f=fixture();f.dispatcher.documentIntake={summary:()=>({caseId:f.c.id,status:'needs_confirmation',awaitingPayment:false,applicants:[{applicantIndex:0,status:'needs_confirmation',clientFieldsRequired:['issueDate','PRIVATE_FIELD'],fields:{passportNumber:'PRIVATE_PASSPORT',latinFirstName:'PRIVATE_NAME'},documents:{passport:'PRIVATE_MEDIA',residence:'PRIVATE_ID',photo:'PRIVATE_PHOTO'}}]})};
 const info=console.info,logs=[];try{console.info=x=>logs.push(x);f.dispatcher.diagnose();f.dispatcher.diagnose();}finally{console.info=info;}
 assert.equal(logs.length,1);assert.match(logs[0],/VISA_DOCUMENT_READINESS/);assert.match(logs[0],/issueDate/);assert.doesNotMatch(logs[0],/PRIVATE|15550002001|example-case/);
});
test('expired OTP with retired document evidence restages only after remote proof and requires fresh consent',async()=>{
 const f=await expiredOtpFixture(),original=f.fulfilment.getConfirmedFields.bind(f.fulfilment);let fresh=false,refreshes=0;
 f.fulfilment.getConfirmedFields=id=>{if(!fresh)throw Object.assign(Error('VISA_DOCUMENT_EVIDENCE_UNVERIFIED'),{code:'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});return original(id);};
 f.dispatcher.documentIntake={refresh:async(customer,options)=>{assert.equal(customer,f.job.customer);assert.equal(options.applicantIndex,f.job.applicantIndex);assert.equal(f.job.answerConfirmation,undefined);fresh=true;refreshes++;return{readyForQuestions:true};}};
 await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(refreshes,1);assert.equal(f.job.expiredOtpRecoveryAttempts,1);assert.equal(f.job.answerConfirmation,undefined);assert.equal(f.job.state,'awaiting_answer_confirmation');assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);assert.equal(f.job.summary.answers.maritalStatus,'single');
});
test('retired evidence cannot restore execution consent or refresh without verified remote cleanup',async()=>{
 for(const mode of ['saved','no_consent','failed_refresh']){const f=await expiredOtpFixture(mode==='saved'?{saved:true}:{});let refreshes=0;f.fulfilment.getConfirmedFields=()=>{throw Object.assign(Error('VISA_DOCUMENT_EVIDENCE_STALE'),{code:'VISA_DOCUMENT_EVIDENCE_STALE'});};f.dispatcher.documentIntake={refresh:async()=>{refreshes++;return{readyForQuestions:false};}};if(mode==='no_consent')delete f.job.answerConfirmation;await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,'portal_review_required',mode);assert.equal(refreshes,mode==='failed_refresh'?1:0,mode);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);if(mode==='failed_refresh'){assert.equal(f.job.answerConfirmation,undefined);assert.equal(f.job.blockedReason,'DOCUMENTS_REVIEW_REQUIRED');}}
});
test('an evicted remote record permits local evidence renewal only after explicit absence and idle proof',async()=>{
 for(const absent of [true,false]){const f=await expiredOtpFixture(),request=f.dispatcher.request.bind(f.dispatcher);let refreshes=0;f.fulfilment.getConfirmedFields=()=>{throw Object.assign(Error('VISA_DOCUMENT_EVIDENCE_UNVERIFIED'),{code:'VISA_DOCUMENT_EVIDENCE_UNVERIFIED'});};f.dispatcher.documentIntake={refresh:async()=>{refreshes++;f.fulfilment.getConfirmedFields=()=>({complete:false});return{readyForQuestions:true};}};f.dispatcher.request=async(path,options)=>{if(path==='/internal/raad/jobs/'+f.job.id)throw Object.assign(Error('not found'),{status:404});if(path.endsWith('/cancel'))return{jobId:f.job.id,stage:'cancelled',ownedBrowserClosed:true,absent};return request(path,options);};await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(refreshes,absent?1:0);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);if(absent){assert.equal(f.job.answerConfirmation,undefined);assert.equal(f.job.state,'awaiting_answer_confirmation');}else assert.equal(f.job.state,'portal_review_required');}
});
test('question delivery diagnostics use accepted outbox outcomes without logging recipient or content',async()=>{const f=fixture(),approval=f.approve(),job=f.fulfilment.job(approval.jobs[0].id);await f.fulfilment.dispatchMessage(job.paymentNoticeId);f.fulfilment.askQuestions(job.id);const info=console.info,logs=[];try{console.info=x=>logs.push(x);await f.dispatcher.flushMessages();}finally{console.info=info;}assert.ok(logs.some(x=>x.includes('VISA_WORKFLOW_DELIVERY')&&x.includes('"state":"accepted"')));assert.doesNotMatch(logs.join(''),new RegExp(CUSTOMER+'|'+job.id+'|'+OWNER));});
test('operator challenge is bound to the current job lease, dossier and image with no execution on GET',async()=>{const f=fixture(),[job]=await f.activate();await f.dispatcher.tick();const challengeId='20000000-0000-4000-8000-000000000001',expiresAt=Date.now()+200000;f.setState({jobId:job.id,caseSignature:job.caseSignature,applicantIndex:0,stage:'waiting_operator',phase:'login',requiresOperator:true,operatorChallenge:{id:challengeId,kind:'login',expiresAt}});await f.dispatcher.tick();assert.equal(f.store.data.visaPortalRuns[job.id].phase,'waiting_operator');assert.equal(job.state,'waiting_otp');const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('SYNTHETIC')]),imageId=digest(bytes),request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path.endsWith('/operator')?(options?.body?{accepted:true}:{challengeId,kind:'login',imageId,image:'data:image/png;base64,'+bytes.toString('base64')}):request(path,options);const image=await f.dispatcher.operatorChallenge(job.id);assert.equal(image.imageId,imageId);const input={challengeId,imageId,value:'HUMAN1'};assert.equal((await f.dispatcher.operatorChallenge(job.id,input)).accepted,true);assert.equal(input.value,'');assert.equal(job.state,'running');await assert.rejects(f.dispatcher.operatorChallenge(job.id),/STALE/);});
test('operator login restart requires a worker advertising manual verification and current consent',async()=>{for(const valid of [true,false]){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='LOGIN_CAPTCHA_TIMEOUT';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:valid}}:request(path,options);await f.dispatcher.recoverOperatorLogin();assert.equal(job.state,valid?'ready':'portal_review_required');assert.equal(job.operatorLoginRecoveryAttempts,valid?1:undefined);}});
test('manual operator restart refuses saved or changed jobs and is bounded across sessions',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='OPERATOR_CHALLENGE_EXPIRED';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true}}:request(path,options);job.portalSaved=true;await assert.rejects(f.dispatcher.restartOperatorLogin(job.id));delete job.portalSaved;for(let i=0;i<2;i++){assert.equal((await f.dispatcher.restartOperatorLogin(job.id)).restartQueued,true);job.state='portal_review_required';job.blockedReason='OPERATOR_CHALLENGE_EXPIRED';f.store.data.visaPortalRuns[job.id].phase='blocked';}await assert.rejects(f.dispatcher.restartOperatorLogin(job.id));assert.equal(job.operatorManualStarts,2);});

test('explicit restart after mail transport failure is limited to unsaved login jobs',async()=>{for(const mode of ['valid','saved','reference','later_stage','no_consent']){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PILOT_UNAVAILABLE';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:mode==='later_stage'?'application':'login'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true}}:request(path,options);if(mode==='saved')job.portalSaved=true;if(mode==='reference')job.applicationReference='SYNTHETIC';if(mode==='no_consent')f.fulfilment.getConfirmedFields=()=>({complete:false});if(mode==='valid')assert.equal((await f.dispatcher.restartOperatorLogin(job.id)).restartQueued,true);else await assert.rejects(f.dispatcher.restartOperatorLogin(job.id));}});

test('preflight restart requires confirmed cancellation and current unsaved dossier',async()=>{for(const phase of ['cancelled','uncertain','running']){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='PORTAL_START_UNCERTAIN';f.store.data.visaPortalRuns[job.id]={phase,lastStage:'preflight'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true}}:request(path,options);if(phase==='cancelled')assert.equal((await f.dispatcher.restartOperatorLogin(job.id)).restartQueued,true);else await assert.rejects(f.dispatcher.restartOperatorLogin(job.id));}});
test('operator-requested expired OTP retry is case bound, single use and retains remote save checks',async()=>{for(const mode of ['valid','wrong_case','saved','already_used','missing_proof']){const f=await expiredOtpFixture(mode==='saved'?{saved:true}:{});f.job.expiredOtpRecoveryAttempts=1;const request='ab'.repeat(16);f.env.RAAD_EXPIRED_OTP_RETRY_REQUEST=request;f.env.RAAD_EXPIRED_OTP_RETRY_CASE_HASH=mode==='wrong_case'?'000000000000':digest(String(f.job.caseId)).slice(0,12);if(mode==='already_used')f.job.expiredOtpRetryRequest=request;if(mode==='missing_proof')f.fulfilment.getConfirmedFields=()=>({complete:false});await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,mode==='valid'?'ready':'portal_review_required',mode);if(mode==='valid'){assert.equal(f.job.expiredOtpRetryRequest,request);assert.equal(f.job.expiredOtpRecoveryAttempts,2);f.job.state='portal_review_required';f.job.blockedReason='OTP_CHALLENGE_EXPIRED';f.store.data.visaPortalRuns[f.job.id].phase='blocked';const count=f.calls.length;await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.calls.length,count);}}});

test('evicted worker record needs explicit case retry and confirmed absence before restart',async()=>{for(const mode of ['explicit','ordinary','not_absent']){const f=await expiredOtpFixture();if(mode!=='ordinary'){f.job.expiredOtpRecoveryAttempts=1;f.env.RAAD_EXPIRED_OTP_RETRY_REQUEST='cd'.repeat(16);f.env.RAAD_EXPIRED_OTP_RETRY_CASE_HASH=digest(String(f.job.caseId)).slice(0,12);}const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>{if(path==='/internal/raad/jobs/'+f.job.id)throw Object.assign(Error('not found'),{status:404});if(path.endsWith('/cancel'))return{jobId:f.job.id,stage:'cancelled',ownedBrowserClosed:true,absent:mode!=='not_absent'};return request(path,options);};await f.dispatcher.recoverExpiredApplicationOtp();assert.equal(f.job.state,mode==='explicit'?'ready':'portal_review_required',mode);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);}});
test('Save diagnostic requires supported worker and current unsaved consent, then transmits immutable diagnostic mode',async()=>{for(const mode of ['valid','unsupported','saved','no_consent']){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='SAVE_UNCERTAIN';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'save'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true,savePreflightSupported:mode!=='unsupported'}}:request(path,options);if(mode==='saved')job.portalSaved=true;if(mode==='no_consent')f.fulfilment.getConfirmedFields=()=>({complete:false});if(mode!=='valid'){await assert.rejects(f.dispatcher.startSaveDiagnostic(job.id));assert.equal(job.diagnosticOnly,undefined);continue;}assert.deepEqual(await f.dispatcher.startSaveDiagnostic(job.id),{diagnosticQueued:true,submissionEnabled:false});await f.dispatcher.launch(job);assert.equal(f.calls.find(c=>c.path==='/internal/raad/jobs'&&c.method==='POST').body.diagnosticOnly,true);assert.equal(job.saveDiagnosticAttempts,1);}});

test('expired diagnostic has bounded independent login restarts and stays diagnostic after normal budget is spent',async()=>{const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason='OPERATOR_CHALLENGE_EXPIRED';job.diagnosticOnly=true;job.operatorManualStarts=2;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'login'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true,savePreflightSupported:true}}:request(path,options);assert.equal((await f.dispatcher.restartOperatorLogin(job.id)).restartQueued,true);assert.equal(job.diagnosticOnly,true);assert.equal(job.operatorManualStarts,2);assert.equal(job.diagnosticLoginRestarts,1);const expire=()=>{job.state='portal_review_required';job.blockedReason='OPERATOR_CHALLENGE_EXPIRED';f.store.data.visaPortalRuns[job.id].phase='blocked';};expire();for(let i=1;i<5;i++){assert.equal((await f.dispatcher.restartOperatorLogin(job.id)).restartQueued,true);assert.equal(job.diagnosticOnly,true);expire();}assert.equal(job.diagnosticLoginRestarts,5);assert.equal(job.operatorManualStarts,2);await assert.rejects(f.dispatcher.restartOperatorLogin(job.id));});

test('successful no-save diagnostic resumes only by explicit current action, once, with fresh proof',async()=>{for(const mode of ['valid','failed','already_resumed','saved','no_proof']){const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason=mode==='failed'?'SAVE_UNCERTAIN':'SAVE_PREFLIGHT_PASSED';job.diagnosticOnly=true;f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'save_preflight'};if(mode==='already_resumed')job.saveAfterDiagnosticResumed=true;if(mode==='saved')job.portalSaved=true;if(mode==='no_proof')f.fulfilment.getConfirmedFields=()=>({complete:false});const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:false,operatorCaptcha:true,savePreflightSupported:true}}:request(path,options);if(mode==='valid'){assert.deepEqual(await f.dispatcher.resumeAfterSaveDiagnostic(job.id),{resumeQueued:true});assert.equal(job.diagnosticOnly,false);assert.equal(job.saveAfterDiagnosticResumed,true);}else await assert.rejects(f.dispatcher.resumeAfterSaveDiagnostic(job.id));}});

test('uncertain saved case resumes only the explicit existing reference once, without claiming it saved',async()=>{
 for(const mode of ['valid','wrong_state','saved','no_proof','busy','save_failed']){
  const f=fixture(),[job]=await f.activate();job.state='portal_review_required';job.blockedReason=mode==='wrong_state'?'LOGIN_REJECTED':'SAVE_UNCERTAIN';f.store.data.visaPortalRuns[job.id]={phase:'blocked',lastStage:'lookup'};f.env.RAAD_OPERATOR_CAPTCHA_ENABLED='true';if(mode==='saved')job.portalSaved=true;if(mode==='no_proof')f.fulfilment.getConfirmedFields=()=>({complete:false});const request=f.dispatcher.request.bind(f.dispatcher);f.dispatcher.request=async(path,options)=>path==='/health'?{ready:true,production:{activeJob:mode==='busy',operatorCaptcha:true}}:request(path,options);
  if(mode==='save_failed'){const save=f.store.save;f.store.save=()=>{if(job.existingRecoveryRequested)throw Error('disk');save();};}
  if(mode==='valid'){assert.deepEqual(await f.dispatcher.recoverExistingApplication(job.id,'12345678'),{recoveryQueued:true,createNewApplication:false});assert.equal(job.portalSaved,undefined);assert.equal(job.applicationReference,undefined);await assert.rejects(f.dispatcher.recoverExistingApplication(job.id,'12345678'));await f.dispatcher.launch(job);const sent=f.calls.find(c=>c.path==='/internal/raad/jobs'&&c.method==='POST');assert.equal(sent.body.existingApplicationReference,'12345678');assert.equal(f.store.data.visaPortalRuns[job.id].preparedDocuments.length,3);}
  else{await assert.rejects(f.dispatcher.recoverExistingApplication(job.id,'12345678'));assert.equal(job.existingRecoveryRequested,undefined);assert.equal(job.state,'portal_review_required');}
 }
});

test('missing document names trigger one case/applicant/source-bound Cline reread before a human question; wrong sources and exhausted budgets cannot trigger it',async()=>{
 for(const mode of ['valid','wrong_person','no_budget','too_many_pages','already_tried']){
  const f=fixture(),[job]=await f.activate();job.coordination={actor:'operator',recipient:'971507993145'};job.stagedFields={};delete job.confirmedFields.arabicFirstName;const get=f.raad.get.bind(f.raad);f.raad.get=(...args)=>{const d=get(...args);delete d.fields.arabicFirstName;return d;};f.env.RAAD_DOCUMENT_REVIEW_ENABLED='true';
  const source={allowed:true,kind:'passport',caseId:job.caseId,mediaId:IDS.passport,sourceSha256:'a'.repeat(64),generation:1};let reads=0;
  const state={caseId:job.caseId,caseSignature:job.caseSignature,generation:1,applicants:[{applicantIndex:0,evidence:{fieldSources:{passportNumber:[{mediaId:IDS.passport}]}},sourceManifest:[{mediaId:mode==='wrong_person'?IDS.photo:IDS.passport,sha256:source.sourceSha256}]}]};
  f.dispatcher.documentIntake={data:()=>({cases:{[CUSTOMER]:state},jobs:{source:{customer:CUSTOMER,caseId:job.caseId,generation:1,mediaId:source.mediaId,pages:mode==='too_many_pages'?{1:{},2:{},3:{}}:{1:{}}}}}),rereadSources:()=>[source],queueNameReview:(customer,binding)=>{assert.equal(customer,CUSTOMER);assert.equal(binding,source);reads++;},vision:{status:()=>({ready:mode!=='no_budget',dailyRemaining:mode==='no_budget'?0:5})}};
  if(mode==='already_tried')job.documentNameRecovery={state:'queued'};
  const fields=structuredClone(job.confirmedFields);assert.equal(f.dispatcher.recoverDocumentNames(job),mode==='valid',mode);assert.equal(reads,mode==='valid'?1:0);assert.deepEqual(job.confirmedFields,fields);assert.equal(f.dispatcher.recoverDocumentNames(job),false);assert.equal(reads,mode==='valid'?1:0);
 }
});

test('live screen is bound to the active lease and rejects other cases, stale or unredacted frames',async()=>{
 for(const mode of ['valid','wrong_job','wrong_case','unredacted','expired','wrong_digest','subject_pause']){
  const f=fixture(),[job]=await f.activate(),{lease}=f.fulfilment.acquireJob(job.id,{workerId:'live-test'});f.store.data.visaPortalRuns[job.id]={phase:'running',lastStage:'personal_info',leaseToken:lease.token};
  const bytes=Buffer.from([255,216,255,224,1,255,217]),image='data:image/jpeg;base64,'+bytes.toString('base64');let reads=0;
  f.dispatcher.request=async path=>{assert.equal(path,'/internal/raad/jobs/'+job.id+'/live');reads++;if(mode==='subject_pause')f.claim(true);return{jobId:mode==='wrong_job'?'other':job.id,caseSignature:mode==='wrong_case'?'f'.repeat(64):job.caseSignature,applicantIndex:0,readOnly:true,redacted:mode!=='unredacted',active:true,phase:'personal_info',mimeType:'image/jpeg',capturedAt:Date.now()-(mode==='expired'?20000:0),width:1200,height:800,image,sha256:mode==='wrong_digest'?'f'.repeat(64):digest(bytes)};};
  if(mode==='valid'){const r=await f.dispatcher.liveView(job.id);assert.equal(r.active,true);assert.equal(r.image,image);assert.equal(r.readOnly,true);assert.equal(r.caseSignature,undefined);}else await assert.rejects(f.dispatcher.liveView(job.id));assert.equal(reads,1);
 }
 const f=fixture(),[job]=await f.activate();f.dispatcher.request=()=>assert.fail('inactive view cannot open browser');assert.equal((await f.dispatcher.liveView(job.id)).active,false);
});

test('manual completion delivers one reference then captures and delivers only the exact existing request PDF',async()=>{
 const f=fixture({printSupported:true}),[job]=await f.activate();job.state='portal_review_required';job.portalSaved=true;job.applicationReference='E12345678';job.confirmedFields.passportNumber='EXAMPLE88';
 f.fulfilment.reportManualCompletion(job.id,{caseId:job.caseId,applicationReference:job.applicationReference});await f.dispatcher.tick();
 const post=f.calls.find(c=>c.path==='/internal/raad/jobs');assert.equal(post.body.printExistingOnly,true);assert.equal(post.body.existingApplicationReference,'E12345678');assert.deepEqual(post.body.documents,[]);assert.deepEqual(Object.keys(post.body.fields),['passportNumber']);
 assert.equal(f.sent.filter(s=>s.payload.type==='text'&&s.payload.text.includes('E12345678')).length,1);
 f.setState(completedState(job,{printExistingOnly:true,returnedFromPayment:false,ownedBrowserClosed:true}));await f.dispatcher.tick();
 assert.equal(job.state,'manually_completed');assert.equal(job.manualCopy.state,'completed');assert.equal(job.returnedFromPayment,undefined);assert.equal(f.storedCopies.length,1);
 const copies=f.sent.filter(s=>s.payload.type==='document');assert.equal(copies.length,1);assert.equal(copies[0].to,CUSTOMER);assert.match(copies[0].payload.caption,/E12345678/);
 await f.dispatcher.tick();assert.equal(f.sent.filter(s=>s.payload.type==='document').length,1);assert.equal(f.calls.filter(c=>c.path==='/internal/raad/jobs').length,1);
});
test('manual export never falls back to application creation or downloads another reference',async()=>{
 const f=fixture({printSupported:true}),[job]=await f.activate();job.state='portal_review_required';job.portalSaved=true;job.applicationReference='E12345678';job.confirmedFields.passportNumber='EXAMPLE88';
 f.fulfilment.reportManualCompletion(job.id,{caseId:job.caseId,applicationReference:job.applicationReference});await f.dispatcher.launch(job);assert.equal(f.calls.some(c=>c.path==='/internal/raad/jobs'),false);
 await f.dispatcher.launchManualCopy(job);f.setState(completedState(job,{printExistingOnly:true,reference:'E99999999',returnedFromPayment:false,ownedBrowserClosed:true}));
 await assert.rejects(f.dispatcher.poll(job,f.store.data.visaPortalRuns[job.id]),/MANUAL_COPY_PROOF_INVALID/);assert.equal(f.storedCopies.length,0);assert.equal(f.calls.some(c=>c.path.endsWith('/artifact')),false);
});
