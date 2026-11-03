'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const CUSTOMER = '15550003101';
const SECRET = 'synthetic-document-webhook-secret';
const ADMIN = 'synthetic-document-admin-key-xxxxxxxxxxxxxxxx';
const STATE_KEY = 'synthetic-document-encrypted-state-key';
const TOKEN = 'synthetic-document-graph-token';
const GEMMA_KEY = 'synthetic-document-gemma-key';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const field = value => ({value, visible: true, confidence: 0.999});
const DOC_FIELDS = {nationalityCode: 'EGY', passportNumber: 'N12345678', passportType: 'ordinary', issuingCountryCode: 'EGY', issueDate: '2025-01-01', expiryDate: '2031-01-01', birthDate: '1990-01-15', birthPlace: 'Synthetic City', sex: 'F', latinFirstName: 'Synthetic', latinFamilyName: 'Example'};
function checkDigit(value) { return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10); }
function mrz() {
  const first = 'P<EGYEXAMPLE<<SYNTHETIC'.padEnd(44, '<'), number = DOC_FIELDS.passportNumber, birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const body = number + checkDigit(number) + 'EGY' + birth + checkDigit(birth) + 'F' + expiry + checkDigit(expiry) + optional + checkDigit(optional);
  return [first, body + checkDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43))];
}
function extraction(kind) {
  const fields = kind === 'passport' ? DOC_FIELDS : kind === 'uae_id_front' ? {latinFullName: 'Synthetic Example', passportNumber: DOC_FIELDS.passportNumber, birthDate: DOC_FIELDS.birthDate, nationalityCode: 'EGY', sex: 'F', emiratesId: '784199000000001', residenceExpiry: '2029-01-01'} : {};
  return {version: 1, kind, readable: true, rotation: 0, fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, field(value)])), mrzLines: kind === 'passport' ? mrz() : [], portraitBox: null};
}
async function images() {
  const document = (background, title, lines) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="${background}"/><text x="70" y="100" font-size="48" font-family="sans-serif">SYNTHETIC TEST DOCUMENT — ${title}</text>${lines.map((line, index) => `<text x="70" y="${190 + index * 74}" font-size="35" font-family="monospace">${line.replaceAll('<', '&lt;')}</text>`).join('')}</svg>`);
  const passport = await sharp(document('#c8d8f5', 'PASSPORT', ['Name: Synthetic Example', 'Passport: N12345678', 'Nationality / Issuer: EGY', 'Born: 1990-01-15   Place: Synthetic City', 'Issued: 2025-01-01   Expires: 2031-01-01', 'Type: ordinary   Sex: F', ...mrz()])).png().toBuffer();
  const residence = await sharp(document('#bce5c8', 'UAE ID', ['Name: Synthetic Example', 'Passport: N12345678', 'Born: 1990-01-15   Nationality: EGY', 'Emirates ID: 784199000000001', 'Residence expires: 2029-01-01'])).png().toBuffer();
  const portrait = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500"><rect width="1200" height="1500" fill="#f5c8c8"/><circle cx="600" cy="550" r="250" fill="#dddddd"/><path d="M180 1400 Q150 880 600 880 Q1050 880 1020 1400Z" fill="#bbbbbb"/><text x="90" y="120" font-size="45" font-family="sans-serif">SYNTHETIC PORTRAIT — NO REAL PERSON</text></svg>')).png().toBuffer();
  return new Map([['701001', passport], ['701002', residence], ['701003', portrait]]);
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});

test('signed document uploads traverse encrypted media, real Cline adapter, matcher, preparation and private dashboard while unpaid', {timeout: 45000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visa-document-webhook-')), file = path.join(directory, 'state.enc'), sourceImages = await images();
  Object.assign(process.env, {NODE_ENV: 'test', ASSISTANT_STATE_PATH: file, ASSISTANT_STATE_KEY: STATE_KEY, WHATSAPP_APP_SECRET: SECRET, ASSISTANT_ADMIN_KEY: ADMIN, WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_GRAPH_API_VERSION: 'v23.0', DRY_RUN: 'false', SAUDI_VISA_ENABLED: 'true', RAAD_DOCUMENT_OCR_ENABLED: 'true', GEMINI_API_KEY: GEMMA_KEY, ASSISTANT_AI_PROVIDER: 'disabled', CLINE_API_KEY: GEMMA_KEY, OPENAI_API_KEY: '', ASSISTANT_DEBOUNCE_MS: '0', CONSULTANT_ORCHESTRATOR_ENABLED: 'false', FARE_CATALOG_ENABLED: 'false', AIR_ARABIA_QUOTE_QUEUE_ENABLED: 'false', FLYCHAM_PORTAL_ENABLED: 'false', RAAD_VISA_AUTOMATION_ENABLED: 'false', RAAD_BROWSER_WORKER_URL: '', RAAD_JOB_BRIDGE_KEY: 'synthetic-document-bridge-key-xxxxxxxxxxxxxxxx', SAUDI_VISA_WABA_ID: '', RAAD_OTP_REQUEST_TEMPLATE: '', RAAD_VISA_PAYMENT_TEMPLATE: '', RAAD_APPLICATION_PHONE: '+' + CUSTOMER, RAAD_CONTACT_EMAIL: 'synthetic@example.test', RAAD_INSURANCE_PHONE: '+' + CUSTOMER, RAAD_POSTAL_CODE: '00000'});
  const {AssistantState} = require('../src/assistant-state');
  const {ConversationJournal}=require('../src/conversation-journal');
  const P = require('../src/saudi-visa-policy');
  const {visaCaseSignature} = require('../src/visa-case-signature');
  const seed = new AssistantState({file, key: STATE_KEY});
  const visaCase = {id: crypto.randomUUID(), service: 'saudi_visa', policyVersion: P.POLICY_VERSION, revision: 2, stage: 'quoted', createdAt: Date.now() - 10000, updatedAt: Date.now(), applicantCount: 1, applicants: [{nationality: 'مصر', documentType: 'passport'}], askedQuestions: [], history: [], paymentMethod: 'bank', paymentStatus: 'unverified', documents: [], submissionStatus: 'not_submitted', greeted: true};
  visaCase.quote = P.calculateQuote(visaCase);
  seed.data.visaCases = {[CUSTOMER]: visaCase}; seed.data.serviceSessions = {[CUSTOMER]: {service: 'saudi_visa', revision: 0, at: Date.now()}};seed.data.visaDocumentFeedbackActivatedAt=1;seed.data.visaDocumentFeedbackPolicy='9ca5ada8bfdbe9de99d72277beea3aed4bd1d614a4b87dd1d7b8fe31de45601d';seed.set(CUSTOMER, {history: [], status: 'idle', offers: []});const previousInboundAt=Date.now()-5000;new ConversationJournal({store:seed}).recordInbound(CUSTOMER,{id:'synthetic-pre-upgrade-inbound',text:'مستندات الطلب',timestamp:previousInboundAt});
  const initialSignature = visaCaseSignature(visaCase), initialQuote = structuredClone(visaCase.quote), initialDocuments = structuredClone(visaCase.documents);
  const requests = [], posts = [], roles = [], rejectedRequests = [];
  let visionCount = 0, firstEnteredResolve, firstReleaseResolve, sequence = 0;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; }), firstRelease = new Promise(resolve => { firstReleaseResolve = resolve; });
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = new URL(String(url)); requests.push({host: target.hostname, path: target.pathname, method: options.method || 'GET'});
    if (target.hostname === 'graph.facebook.com' && /^\/v23\.0\/70100[123]$/.test(target.pathname)) {
      assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN); assert.equal(options.redirect, 'error');
      const id = target.pathname.split('/').at(-1), bytes = sourceImages.get(id);
      return jsonResponse({id, mime_type: 'image/png', file_size: bytes.length, sha256: sha(bytes), url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments?media_id=' + id});
    }
    if (target.hostname === 'lookaside.fbsbx.com') {
      assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN); assert.equal(options.redirect, 'error');
      const bytes = sourceImages.get(target.searchParams.get('media_id')); assert.ok(bytes);
      return new Response(Buffer.from(bytes), {status: 200, headers: {'content-type': 'image/png', 'content-length': String(bytes.length)}});
    }
    if (target.hostname === 'api.cline.bot') {
      assert.equal(target.pathname, '/api/v1/chat/completions'); assert.equal(options.headers.Authorization, 'Bearer '+GEMMA_KEY); assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body), input = Buffer.from(request.messages[1].content[1].image_url.url.split(',')[1], 'base64'), metadata = await sharp(input).metadata(); assert.ok(metadata.width >= 1000); assert.ok(metadata.height >= 1000);
      const rgb = await sharp(input).extract({left: 0, top: 0, width: 1, height: 1}).removeAlpha().raw().toBuffer(), maximum = Math.max(rgb[0], rgb[1], rgb[2]);
      const kind = rgb[2] === maximum ? 'passport' : rgb[1] === maximum ? 'uae_id_front' : 'portrait'; roles.push(kind); visionCount++;
      if (visionCount === 1) { firstEnteredResolve(); await firstRelease; }
      return jsonResponse({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: JSON.stringify(extraction(kind))}}]});
    }
    if (target.hostname === 'graph.facebook.com' && target.pathname === '/v23.0/123456789/messages' && options.method === 'POST') {
      assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN); const body = JSON.parse(options.body); posts.push(body); return jsonResponse({messages: [{id: 'wamid.synthetic-document-output-' + posts.length}]});
    }
    rejectedRequests.push({host: target.hostname, path: target.pathname}); throw Error('UNEXPECTED_SYNTHETIC_TEST_NETWORK');
  };
  const {createServer} = require('../src/server'), server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const readState = () => new AssistantState({file, key: STATE_KEY}).data;
  const call = (route, {method = 'GET', data, signed = false, authenticated = true} = {}) => new Promise((resolve, reject) => {
    const body = data === undefined ? '' : JSON.stringify(data), headers = {'Content-Type': 'application/json', ...(signed ? {'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex')} : authenticated ? {Authorization: 'Bearer ' + ADMIN} : {})};
    const request = http.request({hostname: '127.0.0.1', port: server.address().port, path: route, method, headers}, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const bytes = Buffer.concat(chunks); let json; try { json = JSON.parse(bytes.toString()); } catch {} resolve({status: response.statusCode, headers: response.headers, bytes, json}); }); }); request.on('error', reject); request.end(body);
  });
  const providerTimestamp=String(Math.floor(readState().visaDocumentFeedbackActivatedAt/1000));
  const upload = id => call('/webhooks/whatsapp', {method: 'POST', signed: true, data: {entry: [{changes: [{field: 'messages', value: {contacts: [{wa_id: CUSTOMER, profile: {name: 'Synthetic Customer'}}], messages: [{id: 'synthetic-document-inbound-' + (++sequence), from: CUSTOMER, timestamp: providerTimestamp, type: 'image', image: {id, mime_type: 'image/png'}}]}}]}]}});
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    const data = readState(); assert.fail(label + ': ' + JSON.stringify({rejectedRequests, visionCount, cases: data.visaDocumentIntake?.cases, jobs: Object.values(data.visaDocumentIntake?.jobs || {}).map(job => ({status: job.status, issues: job.issues, pageCount: Object.keys(job.pages || {}).length}))}));
  };
  try {
    const boot=readState();assert.equal(boot.visaDocumentFeedbackPolicy,require('../src/visa-document-vision').POLICY_FINGERPRINT);assert(boot.visaDocumentFeedbackActivatedAt>previousInboundAt);assert.equal(boot.visaDocumentFeedbackAfterSequence,boot.conversationJournal.nextSequence-1);assert.equal(new ConversationJournal({store:{data:boot,save(){}}}).summary(CUSTOMER).lastInboundAt,previousInboundAt);assert.equal(posts.length,0,'policy activation alone must not send customer feedback');assert.equal((await call('/health',{authenticated:false})).json.assistant.version,'2026-10-29.ismail.14');
    assert.equal((await call('/internal/assistant/visa-workflow/' + CUSTOMER, {authenticated: false})).status, 401);
    assert.equal((await upload('701001')).status, 200);
    await Promise.race([firstEntered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Synthetic OCR did not start')), 10000); timer.unref(); })]);
    assert.equal((await upload('701002')).status, 200); assert.equal((await upload('701003')).status, 200);
    await waitFor(() => { const state = readState(); return state.visaCases[CUSTOMER].revision >= visaCase.revision + 3 && Object.values(state.visaMedia || {}).filter(item => !item.purpose).length === 3; }, 'Three ordinary media turns should persist while first OCR is pending');
    const inFlight = readState(); assert.equal(visaCaseSignature(inFlight.visaCases[CUSTOMER]), initialSignature); assert.deepEqual(inFlight.visaCases[CUSTOMER].documents, initialDocuments); assert.deepEqual(inFlight.visaCases[CUSTOMER].quote, initialQuote);
    firstReleaseResolve();
    const snapshot = await waitFor(() => { const state = readState(), review = state.visaDocumentIntake?.cases?.[CUSTOMER]; return review?.status === 'ready' && review.awaitingPayment === true ? state : null; }, 'Unpaid document intake should become ready without an interrupted/manual OCR dead end');
    await waitFor(() => posts.some(message => /عم نجهّز ملفك/.test(message.text?.body || '')), 'Current-client document feedback should be accepted');
    assert.equal(new ConversationJournal({store:{data:readState(),save(){}}}).summary(CUSTOMER).lastInboundAt,Number(providerTimestamp)*1000,'same-second provider timestamp stays unchanged while actual arrival sequence permits feedback');
    const response = await call('/internal/assistant/visa-workflow/' + CUSTOMER); assert.equal(response.status, 200); const item = response.json.item, review = item.documentReview;
    assert.equal(review.status, 'ready'); assert.equal(review.awaitingPayment, true); assert.equal(review.applicants.length, 1); assert.equal(review.applicants[0].evidence.passportMrzChecked, true); assert.equal(review.applicants[0].evidence.matchedResidence, true); assert.equal(review.applicants[0].fields.passportNumber, DOC_FIELDS.passportNumber);
    assert.equal(item.visaCase.paymentStatus, 'unverified'); assert.equal(item.visaCase.submissionStatus, 'not_submitted'); assert.equal(item.governmentFees.status, 'unpaid'); assert.equal(item.approval, null); assert.equal(item.jobs.length, 0); assert.notEqual(item.visaCase.staffVerification?.documentsReviewed, true); assert.equal(snapshot.raadApplications?.[CUSTOMER], undefined);
    const rawReview = snapshot.visaDocumentIntake.cases[CUSTOMER], applicant = rawReview.applicants[0], originals = Object.values(snapshot.visaMedia).filter(media => !media.purpose);
    assert.equal(rawReview.caseId, visaCase.id); assert.equal(rawReview.caseSignature, initialSignature); assert.deepEqual(new Set(roles), new Set(['passport', 'uae_id_front', 'portrait'])); assert.equal(visionCount, 3);
    assert.equal(visaCaseSignature(snapshot.visaCases[CUSTOMER]), initialSignature); assert.deepEqual(snapshot.visaCases[CUSTOMER].applicants, visaCase.applicants); assert.equal(snapshot.visaCases[CUSTOMER].applicants[0].passportNumber, undefined);
    assert.equal(applicant.preparedManifest.length, 3); assert.deepEqual(new Set(applicant.preparedManifest.map(media => media.kind)), new Set(['passport', 'residence', 'photo']));
    for (const source of originals) assert.equal(source.checksum, sha(sourceImages.get(source.sourceId)));
    for (const manifest of applicant.preparedManifest) {
      const media = snapshot.visaMedia[manifest.mediaId]; assert.equal(media.customer, CUSTOMER); assert.equal(media.purpose, 'raad_portal_upload'); assert.equal(media.kind, manifest.kind); assert.equal(media.checksum, manifest.sha256); assert.ok(media.sourceIds.every(id => originals.some(source => source.id === id)));
      const content = await call('/internal/assistant/visa-media/' + manifest.mediaId + '?customer=' + CUSTOMER); assert.equal(content.status, 200); assert.equal(sha(content.bytes), manifest.sha256); assert.ok(content.bytes.length <= 1000000);
      const metadata = await sharp(content.bytes).metadata(); assert.ok(metadata.width >= 300 && metadata.height >= 300); if (manifest.kind !== 'photo') assert.ok(Math.max(metadata.width, metadata.height) >= 1200);
      const ciphertext = fs.readFileSync(path.join(directory, 'visa-media', manifest.mediaId + '.enc')); assert.notDeepEqual(ciphertext.subarray(0, 8), content.bytes.subarray(0, 8));
    }
    assert.ok(posts.length > 0); assert.ok(posts.every(message => message.to === CUSTOMER)); assert.equal(posts.filter(message => /عم نجهّز ملفك/.test(message.text?.body || '')).length, 1);
    assert.doesNotMatch(JSON.stringify(posts), /N12345678|784199000000001|تم تأكيد استلام دفعتك|ليست تأشيرة صادرة/); assert.equal(posts.some(message => ['template', 'document'].includes(message.type)), false);
    assert.deepEqual(rejectedRequests, []); assert.ok(requests.every(request => ['graph.facebook.com', 'lookaside.fbsbx.com', 'api.cline.bot'].includes(request.host)));
    assert.equal(fs.readFileSync(file).includes(Buffer.from(DOC_FIELDS.passportNumber)), false);
  } finally {
    firstReleaseResolve(); process.env.RAAD_DOCUMENT_OCR_ENABLED = 'false'; process.env.RAAD_VISA_AUTOMATION_ENABLED = 'false'; process.env.SAUDI_VISA_ENABLED = 'false';
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 30));
    global.fetch = originalFetch; fs.rmSync(directory, {recursive: true, force: true});
  }
});
