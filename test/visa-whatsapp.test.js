'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createVisaWhatsAppAdapter, createVisaTemplateGate, visaTemplateConfig, visaTemplateRequest, OTP_TEMPLATE_BODY} = require('../src/visa-whatsapp');
const {extractIncomingMessages} = require('../src/whatsapp');
const {questionFor} = require('../src/visa-client-questions');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {visaCaseSignature} = require('../src/visa-case-signature');

const CUSTOMER = '971500000001', OWNER = '971500000005', OTHER = '971500000009';
const TOKEN = '12345678-1234-4321-abcd-123456789abc', JOB = '12345678-1234-4321-abcd-123456789abd', MEDIA = '12345678-1234-4321-abcd-123456789abe';
const env = {DRY_RUN: 'false', WHATSAPP_ACCESS_TOKEN: 'synthetic-private-token', WHATSAPP_PHONE_NUMBER_ID: '100000000001', WHATSAPP_GRAPH_API_VERSION: 'v23.0', RAAD_OTP_OWNER_WHATSAPP: '+' + OWNER};
const metadata = {customer: CUSTOMER};
const ok = () => {};
const accepted = id => ({ok: true, json: async () => ({messages: [{id}], private_echo: 'SHOULD_NOT_RETURN'})});
function fixture(options = {}) {
  const calls = [], reads = [], windows = new Set(options.windows ?? [CUSTOMER, OWNER]);
  const fetchImpl = options.fetchImpl || (async (url, request) => { calls.push({url, request}); return url.endsWith('/media') ? {ok: true, json: async () => ({id: '100001'})} : accepted('wamid.synthetic.' + calls.length); });
  const mediaStore = options.mediaStore || {read: async (id, binding) => { reads.push({id, binding}); return {metadata: {id, customer: binding.customer, mimeType: 'application/pdf', expiresAt: 9000000000000}, bytes: Buffer.from('%PDF-1.7\nSYNTHETIC')}; }};
  return {calls, reads, windows, adapter: createVisaWhatsAppAdapter({env: {...env, ...options.env}, journal: {summary: id => ({serviceWindowOpen: windows.has(id)})}, fetchImpl, mediaStore, templateGate: options.templateGate, now: options.now})};
}
function question(field = 'priorGccDeportation') { const definition = questionFor(field, {applicantIndex: 0}); return {type: 'question', text: definition.prompt, token: TOKEN, field, applicantIndex: 0, options: definition.options || []}; }
const document = {type: 'document', mediaId: MEDIA, mimeType: 'application/pdf', filename: 'saudi-application-1.pdf', caption: 'نسخة طلب محفوظة وليست تأشيرة صادرة.'};
const summary = entries => ({type: 'answer_summary', text: 'راجع جميع إجابات المسافر 1 ثم أكد صحتها.', token: TOKEN, applicantIndex: 0, entries, options: [{id: 'confirm', label: 'أؤكد صحة الإجابات'}, {id: 'correct', label: 'أريد تصحيح الإجابات'}]});

test('visa questions use bounded reply buttons and longer option sets use list rows; text questions stay normal text', async () => {
  const f = fixture();
  await f.adapter.send('+' + CUSTOMER, question(), ok, metadata);
  await f.adapter.send(CUSTOMER, question('maritalStatus'), ok, metadata);
  await f.adapter.send(CUSTOMER, question('birthPlace'), ok, metadata);
  const [buttons, list, text] = f.calls.map(call => JSON.parse(call.request.body));
  assert.equal(buttons.to, CUSTOMER); assert.equal(buttons.interactive.type, 'button');
  assert.deepEqual(buttons.interactive.action.buttons.map(button => button.reply.id), ['visa_answer:' + TOKEN + ':yes', 'visa_answer:' + TOKEN + ':no']);
  assert.equal(list.interactive.type, 'list'); assert.equal(list.interactive.action.sections[0].rows.length, 5);
  assert.equal(list.interactive.action.sections[0].rows[0].id, 'visa_answer:' + TOKEN + ':single');
  assert.equal(text.type, 'text'); assert.equal(text.text.body, question('birthPlace').text);
  assert.ok(f.calls.every(call => call.url === 'https://graph.facebook.com/v23.0/100000000001/messages' && call.request.signal instanceof AbortSignal));
});

test('complete summary translates actual choices and binds confirm/correct to its exact token', async () => {
  const f = fixture(), payload = summary([{field: 'maritalStatus', label: 'الحالة', value: 'married'}, {field: 'health.accidentDisability', label: 'الصحة', value: false}, {field: 'birthPlace', label: 'الميلاد', value: 'Synthetic city'}]);
  const response = await f.adapter.send(CUSTOMER, payload, ok, metadata), message = JSON.parse(f.calls[0].request.body);
  assert.deepEqual(response, {messages: [{id: 'wamid.synthetic.1'}]});
  assert.match(message.interactive.body.text, /متزوج \/ متزوجة/); assert.match(message.interactive.body.text, /إصابة حادث أو إعاقة: لا/); assert.match(message.interactive.body.text, /Synthetic city/);
  assert.deepEqual(message.interactive.action.buttons.map(button => button.reply.id), ['visa_confirm:' + TOKEN + ':confirm', 'visa_confirm:' + TOKEN + ':correct']);
});

test('core-generated negative nationality/travel answers send a summary with catalog-bound inapplicable details', async () => {
  const f = fixture(); let claimed = true;
  const c = {id: 'synthetic-case', revision: 1, policyVersion: 'synthetic', applicantCount: 1, applicants: [{nationality: 'مصر', latinFirstName: 'Synthetic', latinFamilyName: 'Example'}], quote: {total: 240, currency: 'AED'}, documents: [], paymentStatus: 'awaiting_verification', submissionStatus: 'not_submitted'};
  const receipt = {id: MEDIA, customer: CUSTOMER, mimeType: 'image/png', size: 120, checksum: 'a'.repeat(64), expiresAt: 9000000000000};
  const store = {data: {visaCases: {[CUSTOMER]: c}, visaMedia: {[MEDIA]: receipt}, conversationJournal: {customers: {[CUSTOMER]: {}}}, complaints: []}, save() {}};
  const mediaStore = {get(id, {customer}) { assert.equal(id, MEDIA); assert.equal(customer, CUSTOMER); return structuredClone(receipt); }};
  const inbox = {isOperatorOwned: () => claimed, isBlocked: () => false, updateVisa(customer, input) { assert.equal(customer, CUSTOMER); c.staffVerification = {payment: {amount: input.amount, reference: input.reference, actor: 'synthetic-accountant', verifiedAt: 1000000, caseSignature: visaCaseSignature(c)}}; c.paymentStatus = 'verified'; c.revision++; }};
  const service = new VisaFulfilment({store, inbox, mediaStore, now: () => 1000000, send: f.adapter.send});
  service.receiveReceipt(CUSTOMER, {receiptId: MEDIA});
  const approved = service.confirmPayment(CUSTOMER, {receiptId: MEDIA, amount: 240, reference: 'SYNTHETIC-BANK-REFERENCE', actor: {id: 'synthetic-accountant', role: 'accountant'}, actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(c), idempotencyKey: 'synthetic-summary-key'});
  claimed = false;
  assert.equal((await service.dispatchMessage(approved.jobs[0].paymentNoticeId)).state, 'accepted');
  const requested = service.askQuestions(approved.jobs[0].id, {fields: ['previousNationality', 'travelledLastFiveYears', 'health.hospitalizedOrEmergency']});
  for (const item of service.pendingMessages()) await service.dispatchMessage(item.id);
  for (const item of requested.questions) service.answerQuestion({sender: CUSTOMER, token: item.token, option: 'no'});
  const outgoing = service.pendingMessages().find(item => item.kind === 'applicant_answer_summary');
  assert.ok(outgoing); assert.deepEqual(outgoing.payload.entries.filter(item => item.value === null).map(item => item.field).sort(), ['previousNationalityDetails', 'travelHistory']);
  assert.equal((await service.dispatchMessage(outgoing.id)).state, 'accepted');
  const message = JSON.parse(f.calls.at(-1).request.body);
  assert.match(message.interactive.body.text, /تفاصيل الجنسية السابقة: غير منطبق/); assert.match(message.interactive.body.text, /تفاصيل السفر: غير منطبق/);
  assert.match(message.interactive.body.text, /تنويم بالمستشفى أو علاج طارئ حالياً: لا/);
  assert.equal(message.interactive.action.buttons[0].reply.id, 'visa_confirm:' + outgoing.payload.token + ':confirm');
});

test('null detail requires an explicit valid inapplicable controller; null medical answers and forged display labels fail closed', async () => {
  const f = fixture();
  const details = {field: 'previousNationalityDetails', label: 'التفاصيل', value: null, displayValue: 'غير منطبق'};
  const prior = value => ({field: 'previousNationality', label: 'الجنسية السابقة', value});
  for (const entries of [
    [details], [prior(true), details], [prior('false'), details], [prior(null), details],
    [{field: 'health.hospitalizedOrEmergency', label: 'الصحة', value: null, displayValue: 'غير منطبق'}],
    [{field: 'birthPlace', label: 'مكان الميلاد', value: null, displayValue: 'غير منطبق'}],
    [prior(false), {...details, field: 'travelHistory'}]
  ]) await assert.rejects(f.adapter.send(CUSTOMER, summary(entries), ok, metadata), /VISA_WHATSAPP_PAYLOAD_INVALID/);
  assert.equal(f.calls.length, 0);
  await f.adapter.send(CUSTOMER, summary([{...details, displayValue: 'UNTRUSTED DISPLAY'}, prior(false)]), ok, metadata);
  const message = JSON.parse(f.calls[0].request.body); assert.match(message.interactive.body.text, /غير منطبق/); assert.doesNotMatch(message.interactive.body.text, /UNTRUSTED/);
});

test('long summaries preserve every answer in bounded text followed by guarded confirmation', async () => {
  const f = fixture(), address = 'A'.repeat(1500), history = 'B'.repeat(1500);
  await f.adapter.send(CUSTOMER, summary([{field: 'saudiAddress', label: 'عنوان', value: address}, {field: 'travelHistory', label: 'سفر', value: history}]), ok, metadata);
  const messages = f.calls.map(call => JSON.parse(call.request.body));
  assert.equal(messages.length, 2); assert.equal(messages[0].type, 'text'); assert.ok(messages[0].text.body.length <= 4096);
  assert.ok(messages[0].text.body.includes(address)); assert.ok(messages[0].text.body.includes(history)); assert.equal(messages.at(-1).interactive.type, 'button');
  let guards = 0;
  await assert.rejects(f.adapter.send(CUSTOMER, summary([{field: 'saudiAddress', label: 'عنوان', value: address}]), () => { if (++guards === 3) throw Error('PRIVATE_CODE'); }, metadata), error => error.message === 'VISA_WHATSAPP_OUTCOME_UNCERTAIN' && !error.notDispatched);
});

test('customer-bound encrypted PDF is uploaded as media then sent by ID with a guard before both effects', async () => {
  const f = fixture(); let guards = 0;
  await f.adapter.send(CUSTOMER, document, () => { guards++; }, metadata);
  assert.deepEqual(f.reads, [{id: MEDIA, binding: {customer: CUSTOMER}}]); assert.equal(f.calls.length, 2); assert.equal(guards, 3);
  const upload = f.calls[0], message = JSON.parse(f.calls[1].request.body);
  assert.equal(upload.url, 'https://graph.facebook.com/v23.0/100000000001/media'); assert.equal(upload.request.body.get('type'), 'application/pdf'); assert.equal(upload.request.body.get('file').type, 'application/pdf');
  assert.deepEqual(message.document, {id: '100001', filename: document.filename, caption: document.caption}); assert.equal(message.to, CUSTOMER); assert.equal(message.type, 'document'); assert.equal(message.document.link, undefined);
});

test('stale guard, mismatched PDF owner, wrong recipient and oversized or non-PDF bytes fail before the relevant dispatch', async () => {
  const f = fixture(); await assert.rejects(f.adapter.send(CUSTOMER, document, () => { throw Error('PRIVATE_CODE'); }, metadata), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
  await assert.rejects(f.adapter.send(OTHER, document, ok, metadata), /VISA_WHATSAPP_RECIPIENT_MISMATCH/);
  for (const file of [
    {metadata: {id: MEDIA, customer: OTHER, mimeType: 'application/pdf'}, bytes: Buffer.from('%PDF-')},
    {metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'image/png'}, bytes: Buffer.from('%PDF-')},
    {metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'application/pdf'}, bytes: Buffer.from('NOT PDF')},
    {metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'application/pdf'}, bytes: Buffer.alloc(10 * 1024 * 1024 + 1)},
    {metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'application/pdf', expiresAt: 0}, bytes: Buffer.from('%PDF-')}
  ]) {
    const invalid = fixture({mediaStore: {read: async () => file}});
    await assert.rejects(invalid.adapter.send(CUSTOMER, document, ok, metadata), /VISA_WHATSAPP_DOCUMENT_INVALID/); assert.equal(invalid.calls.length, 0);
  }
  let guards = 0; await assert.rejects(f.adapter.send(CUSTOMER, document, () => { if (++guards === 3) throw Error('stale'); }, metadata), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(f.calls.length, 1);
});

test('closed or newly expired customer window pauses without uploading or sending', async () => {
  const f = fixture({windows: []});
  for (const payload of [{type: 'text', text: 'تم تأكيد الدفعة.'}, question(), document]) assert.deepEqual(await f.adapter.send(CUSTOMER, payload, ok, metadata), {paused: true, reason: 'service_window_closed'});
  assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
  const expiry = fixture(); let guards = 0;
  const result = await expiry.adapter.send(CUSTOMER, document, () => { if (++guards === 2) expiry.windows.delete(CUSTOMER); }, metadata);
  assert.deepEqual(result, {paused: true, reason: 'service_window_closed'}); assert.equal(expiry.calls.length, 0);
});

test('dry run suppresses read, upload, template lookup and all sends without inventing a message ID', async () => {
  const f = fixture({env: {DRY_RUN: 'true'}, windows: [], templateGate: async () => assert.fail('no template lookup')});
  assert.deepEqual(await f.adapter.send(CUSTOMER, document, ok, metadata), {dryRun: true});
  assert.deepEqual(await f.adapter.send(OWNER, {type: 'text', text: 'رمز التحقق مطلوب.'}, ok, {customer: CUSTOMER, kind: 'owner_otp_request', jobId: JOB, challengeId: TOKEN}), {dryRun: true});
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
});

test('OTP notification can only target the explicit normalized owner and uses job/challenge metadata', async () => {
  const f = fixture();
  await f.adapter.send(OWNER, {type: 'text', text: 'يرجى الرد برمز التحقق على هذه الرسالة.'}, ok, {customer: CUSTOMER, kind: 'owner_otp_request', jobId: JOB, challengeId: TOKEN});
  assert.equal(JSON.parse(f.calls[0].request.body).to, OWNER);
  await assert.rejects(f.adapter.send(CUSTOMER, {type: 'text', text: 'رمز التحقق مطلوب.'}, ok, {kind: 'owner_otp_request', jobId: JOB, challengeId: TOKEN}), /VISA_WHATSAPP_RECIPIENT_MISMATCH/);
  await assert.rejects(f.adapter.sendOperatorOtp({text: 'رمز التحقق مطلوب.', challengeId: TOKEN}, ok), /VISA_WHATSAPP_PAYLOAD_INVALID/);
});

test('out-of-window owner requires verified utility template and never falls back to ordinary text', async () => {
  const blocked = fixture({windows: [], templateGate: async () => false});
  assert.deepEqual(await blocked.adapter.sendOperatorOtp({jobId: JOB, challengeId: TOKEN, text: 'رمز التحقق مطلوب.'}, ok), {paused: true, reason: 'approved_utility_template_required'}); assert.equal(blocked.calls.length, 0);
  const f = fixture({windows: [], env: {RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_otp_request'}, templateGate: async () => true});
  await f.adapter.sendOperatorOtp({jobId: JOB, challengeId: TOKEN, text: 'لا يرسل هذا النص خارج النافذة.'}, ok);
  const message = JSON.parse(f.calls[0].request.body); assert.equal(message.to, OWNER); assert.equal(message.type, 'template');
  assert.deepEqual(message.template, {name: 'synthetic_otp_request', language: {code: 'ar'}, components: [{type: 'body', parameters: [{type: 'text', text: JOB}, {type: 'text', text: TOKEN}]}]});
});

test('template helper proposes utility approval request; gate requires exact approved category, language and schema', async () => {
  const configEnv = {...env, SAUDI_VISA_WABA_ID: '100000000002', RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_otp_request'}, requested = visaTemplateRequest(visaTemplateConfig(configEnv));
  assert.equal(requested.category, 'UTILITY'); assert.equal(requested.components[0].text, OTP_TEMPLATE_BODY);
  const approved = {...requested, status: 'APPROVED'};
  for (const template of [{...approved, status: 'PENDING'}, {...approved, category: 'AUTHENTICATION'}, {...approved, language: 'en'}, {...approved, components: [{type: 'BODY', text: 'Something {{1}} else {{2}}'}]}, {...approved, components: [...approved.components, {type: 'BUTTONS', buttons: []}]}]) {
    const gate = createVisaTemplateGate({env: configEnv, fetchImpl: async () => ({ok: true, json: async () => ({data: [template]})})}); assert.equal(await gate(), false); assert.equal(gate.status().approved, false);
  }
  let at = 1000, calls = 0, status = 'PENDING';
  const gate = createVisaTemplateGate({env: configEnv, now: () => at, fetchImpl: async (url, options) => { calls++; assert.equal(options.method, undefined); assert.match(url, /message_templates\?name=synthetic_otp_request/); return {ok: true, json: async () => ({data: [{...approved, status}]})}; }});
  assert.equal(await gate(), false); status = 'APPROVED'; assert.equal(await gate(), false); at += 60001; assert.equal(await gate(), true); assert.equal(calls, 2); assert.equal(gate.status().state, 'approved');
  assert.equal(await createVisaTemplateGate({env: {}})(), false);
});

test('invalid payload bounds and recipient binding never reach Meta', async () => {
  const f = fixture();
  for (const payload of [question('maritalStatus'), question(), document, summary([{field: 'birthPlace', label: 'مكان الميلاد', value: 'Test city'}])].map(payload => ({...payload, text: payload.type === 'document' ? undefined : 'X'.repeat(1025), caption: payload.type === 'document' ? 'X'.repeat(1025) : payload.caption}))) await assert.rejects(f.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_PAYLOAD_INVALID/);
  for (const payload of [{...question(), token: 'not-a-token'}, {...question(), applicantIndex: -1}, {...question(), options: Array.from({length: 11}, (_, i) => ({id: 'o' + i, label: 'Option', value: true}))}, {...question(), options: [{id: 'yes', label: 'X'.repeat(21), value: true}]}, {...question(), options: [{id: 'yes', label: 'Yes', value: Infinity}]}, {...document, filename: '../other.pdf'}, {...document, mediaId: 'https://example.test/file.pdf'}]) await assert.rejects(f.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_PAYLOAD_INVALID/);
  await assert.rejects(f.adapter.send(CUSTOMER, {type: 'text', text: 'Message'}, undefined, metadata), /VISA_WHATSAPP_GUARD_REQUIRED/); assert.equal(f.calls.length, 0);
});

test('provider and network failures are sanitized, bounded numeric and never retried or logged', async () => {
  for (const status of [403, Infinity, 'PRIVATE_STATUS']) {
    let calls = 0; const f = fixture({fetchImpl: async () => { calls++; return {ok: false, status, json: async () => ({error: {code: 190, error_subcode: Infinity, message: 'PRIVATE_CODE', access_token: env.WHATSAPP_ACCESS_TOKEN}})}; }});
    await assert.rejects(f.adapter.send(CUSTOMER, {type: 'text', text: 'Message'}, ok, metadata), new RegExp('^Error: WHATSAPP_GRAPH_HTTP_' + (status === 403 ? 403 : 0) + '_CODE_190_SUBCODE_0$')); assert.equal(calls, 1);
  }
  for (const fetchImpl of [async () => { throw Error('PRIVATE_SENDER_CODE'); }, async () => ({ok: true, json: async () => ({success: true})})]) await assert.rejects(fixture({fetchImpl}).adapter.send(CUSTOMER, {type: 'text', text: 'Message'}, ok, metadata), /^Error: VISA_WHATSAPP_OUTCOME_UNCERTAIN$/);
});

const webhook = messages => ({entry: [{changes: [{field: 'messages', value: {contacts: [{wa_id: CUSTOMER, profile: {name: 'Synthetic Customer'}}], messages}}]}]});
const incoming = (kind, id, extra = {}) => ({id: 'inbound-message', from: CUSTOMER, timestamp: '1792886400', context: {id: 'bound-message'}, type: 'interactive', interactive: {type: kind, [kind]: {id, title: 'UNTRUSTED INSTRUCTIONS', description: 'UNTRUSTED DESCRIPTION'}}, ...extra});
test('parser extracts typed visa buttons/list answers and confirmations while preserving provenance', () => {
  const [answer, list, confirmation, correction] = extractIncomingMessages(webhook([
    incoming('button_reply', 'visa_answer:' + TOKEN + ':yes'), incoming('list_reply', 'visa_answer:' + TOKEN + ':married'), incoming('button_reply', 'visa_confirm:' + TOKEN + ':confirm'), incoming('button_reply', 'visa_confirm:' + TOKEN + ':correct')
  ]));
  assert.deepEqual(answer, {id: 'inbound-message', contextId: 'bound-message', from: CUSTOMER, name: 'Synthetic Customer', text: '[إجابة بيانات التأشيرة]', visaAnswer: {token: TOKEN, option: 'yes'}, timestamp: '1792886400'});
  assert.deepEqual(list.visaAnswer, {token: TOKEN, option: 'married'}); assert.deepEqual(confirmation.visaConfirmation, {token: TOKEN, confirm: true}); assert.deepEqual(correction.visaConfirmation, {token: TOKEN, confirm: false});
  assert.doesNotMatch(JSON.stringify([answer, list, confirmation, correction]), /UNTRUSTED/);
});

test('malformed/arbitrary interactive replies are not forwarded and normal text remains untrusted normal text', () => {
  const invalid = ['visa_answer:' + TOKEN + ':yes:extra', 'visa_answer:' + TOKEN.toUpperCase() + ':yes', 'visa_answer:' + 'a'.repeat(36) + ':yes', 'visa_answer:' + TOKEN + ':__proto__', 'visa_confirm:' + TOKEN + ':approve', 'other:' + TOKEN + ':yes', null, 42];
  const messages = invalid.map(id => incoming('button_reply', id)); messages.push(incoming('list_reply', 'visa_confirm:' + TOKEN + ':confirm'), incoming('list_reply', 'request_new:' + TOKEN));
  assert.deepEqual(extractIncomingMessages(webhook(messages)), []);
  const [text] = extractIncomingMessages(webhook([{id: 'text-message', from: CUSTOMER, type: 'text', text: {body: '  نعم  '}, visaAnswer: {token: TOKEN, option: 'yes'}}]));
  assert.equal(text.text, 'نعم'); assert.equal(text.visaAnswer, undefined);
});
