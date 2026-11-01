'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createVisaWhatsAppAdapter, createVisaTemplateGate, visaTemplateConfig, visaTemplateRequest, OTP_TEMPLATE_BODY, createVisaPaymentTemplateGate, visaPaymentTemplateConfig, visaPaymentTemplateRequest, PAYMENT_TEMPLATE_BODY} = require('../src/visa-whatsapp');
const {extractIncomingMessages} = require('../src/whatsapp');
const {questionFor} = require('../src/visa-client-questions');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {visaCaseSignature} = require('../src/visa-case-signature');
const {ConversationJournal} = require('../src/conversation-journal');

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
  return {calls, reads, windows, adapter: createVisaWhatsAppAdapter({env: {...env, ...options.env}, journal: {summary: id => ({serviceWindowOpen: windows.has(id)})}, fetchImpl, mediaStore, templateGate: options.templateGate, paymentTemplateGate: options.paymentTemplateGate, now: options.now})};
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

test('core accepts out-of-window payment template, pauses questions until reply, then sends valid inapplicable-detail summary', async () => {
  const f = fixture({windows: [], env: {RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'}, paymentTemplateGate: async () => true}); let claimed = true;
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
  const paymentNotice = JSON.parse(f.calls[0].request.body); assert.equal(paymentNotice.type, 'template'); assert.equal(paymentNotice.template.components[0].parameters[0].text, c.id);
  const requested = service.askQuestions(approved.jobs[0].id, {fields: ['previousNationality', 'travelledLastFiveYears', 'health.hospitalizedOrEmergency']});
  for (const item of service.pendingMessages()) { const result = await service.dispatchMessage(item.id); assert.equal(result.state, 'cancelled'); assert.equal(result.failure, 'DELIVERY_PAUSED'); }
  assert.equal(f.calls.length, 1);
  f.windows.add(CUSTOMER); // A real customer reply reopens the journal window.
  assert.equal(service.requeuePausedMessages(CUSTOMER).requeued, 3);
  for (const item of service.pendingMessages()) assert.equal((await service.dispatchMessage(item.id)).state, 'accepted');
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

test('out-of-window owner receives only the approved operational action notice while the actual prompt stays paused', async () => {
  const blocked = fixture({windows: [], templateGate: async () => false});
  assert.deepEqual(await blocked.adapter.sendOperatorOtp({jobId: JOB, challengeId: TOKEN, text: 'رمز التحقق مطلوب.'}, ok), {paused: true, reason: 'approved_utility_template_required'}); assert.equal(blocked.calls.length, 0);
  const f = fixture({windows: [], env: {RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_otp_request'}, templateGate: async () => true});
  const result = await f.adapter.sendOperatorOtp({jobId: JOB, challengeId: TOKEN, text: 'لا يرسل هذا النص خارج النافذة.'}, ok);
  assert.deepEqual(result, {paused: true, reason: 'owner_action_required', noticeMessageId: 'wamid.synthetic.1'}); assert.equal(result.messages, undefined);
  const message = JSON.parse(f.calls[0].request.body); assert.equal(message.to, OWNER); assert.equal(message.type, 'template');
  assert.deepEqual(message.template, {name: 'synthetic_otp_request', language: {code: 'ar'}, components: [{type: 'body', parameters: [{type: 'text', text: JOB}, {type: 'text', text: TOKEN}]}, {type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{type: 'payload', payload: 'visa_owner_action:' + TOKEN}]}]});
  assert.equal(message.text, undefined);
});

test('persisted owner notice acceptance prevents repeats and a reopened window permits only the original guarded prompt', async () => {
  let checks = 0;
  const f = fixture({windows: [], env: {RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_action_required'}, templateGate: async () => { checks++; return true; }});
  const payload = {type: 'text', text: 'يرجى الرد على هذه الرسالة برمز التحقق الحالي.'}, context = {customer: CUSTOMER, kind: 'owner_otp_request', jobId: JOB, challengeId: TOKEN};
  const notice = await f.adapter.send(OWNER, payload, ok, context);
  assert.equal(notice.noticeMessageId, 'wamid.synthetic.1');
  assert.deepEqual(await f.adapter.send(OWNER, payload, ok, {...context, noticeMessageId: notice.noticeMessageId}), notice);
  assert.equal(f.calls.length, 1); assert.equal(checks, 1);
  f.windows.add(OWNER);
  assert.deepEqual(await f.adapter.send(OWNER, payload, ok, {...context, noticeMessageId: notice.noticeMessageId}), {messages: [{id: 'wamid.synthetic.2'}]});
  const message = JSON.parse(f.calls[1].request.body); assert.equal(message.to, OWNER); assert.equal(message.type, 'text'); assert.equal(message.text.body, payload.text); assert.equal(checks, 1);
  const stale = fixture({windows: [], env: {RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_action_required'}, templateGate: async () => true}); let guards = 0;
  await assert.rejects(stale.adapter.send(OWNER, payload, () => { if (++guards === 2) throw Error('EXPIRED_CHALLENGE'); }, context), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(stale.calls.length, 0);
  f.windows.delete(OWNER);
  await assert.rejects(f.adapter.send(OWNER, payload, () => { throw Error('EXPIRED_CHALLENGE'); }, {...context, noticeMessageId: notice.noticeMessageId}), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(f.calls.length, 2);
});

test('approved payment utility template acknowledges only its exact customer and actual case reference outside the window', async () => {
  const f = fixture({windows: [], env: {RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'}, paymentTemplateGate: async () => true});
  const result = await f.adapter.send(CUSTOMER, {type: 'text', text: 'النص العادي لا يُرسل خارج النافذة.'}, ok, {customer: CUSTOMER, kind: 'payment_confirmation', caseId: 'case-synthetic-example'});
  assert.deepEqual(result, {messages: [{id: 'wamid.synthetic.1'}]});
  const message = JSON.parse(f.calls[0].request.body);
  assert.equal(message.to, CUSTOMER); assert.equal(message.type, 'template');
  assert.deepEqual(message.template, {name: 'synthetic_payment_notice', language: {code: 'ar'}, components: [{type: 'body', parameters: [{type: 'text', text: 'case-synthetic-example'}]}]});
  assert.equal(message.text, undefined);
  for (const payload of [question(), document, {type: 'text', text: 'تحديث آخر'}]) assert.deepEqual(await f.adapter.send(CUSTOMER, payload, ok, {customer: CUSTOMER, kind: 'application_request_copy', caseId: 'case-synthetic-example'}), {paused: true, reason: 'service_window_closed'});
  assert.deepEqual(await f.adapter.send(CUSTOMER, document, ok, {customer: CUSTOMER, kind: 'payment_confirmation', caseId: 'case-synthetic-example'}), {paused: true, reason: 'service_window_closed'});
  assert.equal(f.calls.length, 1); assert.equal(f.reads.length, 0);
});

test('payment keeps original text inside the window and pauses without approved template or usable case reference outside it', async () => {
  const payment = {type: 'text', text: 'أكد المحاسب وصول دفعتك.'}, context = {customer: CUSTOMER, kind: 'payment_confirmation', caseId: 'case-synthetic-example'};
  const inside = fixture({paymentTemplateGate: async () => assert.fail('no template lookup within window')});
  await inside.adapter.send(CUSTOMER, payment, ok, context); assert.equal(JSON.parse(inside.calls[0].request.body).text.body, payment.text);
  const missing = fixture({windows: [], paymentTemplateGate: async () => false});
  assert.deepEqual(await missing.adapter.send(CUSTOMER, payment, ok, context), {paused: true, reason: 'approved_utility_template_required'});
  for (const caseId of [undefined, CUSTOMER, '../foreign', 'A'.repeat(101)]) assert.deepEqual(await missing.adapter.send(CUSTOMER, payment, ok, {...context, caseId}), {paused: true, reason: 'payment_case_reference_required'});
  await assert.rejects(missing.adapter.send(OTHER, payment, ok, context), /VISA_WHATSAPP_RECIPIENT_MISMATCH/);
  assert.equal(missing.calls.length, 0);
  const dry = fixture({windows: [], env: {DRY_RUN: 'true'}, paymentTemplateGate: async () => assert.fail('dry run cannot query templates')});
  assert.deepEqual(await dry.adapter.send(CUSTOMER, payment, ok, context), {dryRun: true}); assert.equal(dry.calls.length, 0);
  const stale = fixture({windows: [], env: {RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'}, paymentTemplateGate: async () => true}); let guards = 0;
  await assert.rejects(stale.adapter.send(CUSTOMER, payment, () => { if (++guards === 2) throw Error('STALE'); }, context), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(stale.calls.length, 0);
});

test('payment template gate requires external approval, exact fixed utility body and bounded cached configuration', async () => {
  const paymentEnv = {...env, SAUDI_VISA_WABA_ID: '100000000002', RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'};
  const requested = visaPaymentTemplateRequest(visaPaymentTemplateConfig(paymentEnv)), approved = {...requested, status: 'APPROVED'};
  assert.equal(requested.category, 'UTILITY'); assert.equal(requested.components[0].text, PAYMENT_TEMPLATE_BODY); assert.match(PAYMENT_TEMPLATE_BODY, /إسماعيل/); assert.match(PAYMENT_TEMPLATE_BODY, /الرد على هذه الرسالة/);
  assert.deepEqual(requested.components[0].text.match(/\{\{\d+\}\}/g), ['{{1}}']); assert.equal(requested.components[0].example.body_text[0].length, 1);
  for (const template of [{...approved, status: 'PENDING'}, {...approved, category: 'MARKETING'}, {...approved, language: 'en'}, {...approved, components: [{type: 'BODY', text: OTP_TEMPLATE_BODY}]}, {...approved, components: [...approved.components, {type: 'HEADER', format: 'DOCUMENT'}]}]) {
    const gate = createVisaPaymentTemplateGate({env: paymentEnv, fetchImpl: async () => ({ok: true, json: async () => ({data: [template]})})}); assert.equal(await gate(), false);
  }
  let at = 1000, calls = 0;
  const gate = createVisaPaymentTemplateGate({env: paymentEnv, now: () => at, fetchImpl: async (url, request) => { calls++; assert.equal(request.method, undefined); assert.match(url, /name=synthetic_payment_notice/); return {ok: true, json: async () => ({data: [approved]})}; }});
  assert.equal(await gate(), true); assert.equal(await gate(), true); assert.equal(calls, 1); at += 60001; assert.equal(await gate(), true); assert.equal(calls, 2);
  paymentEnv.RAAD_VISA_PAYMENT_TEMPLATE = 'unapproved_changed_name'; assert.equal(await gate(), false); assert.equal(calls, 3);
});

test('template rejection diagnostics request the provider reason but expose only bounded recognized codes without approving sends', async () => {
  for (const {factory, request, settings} of [
    {factory: createVisaTemplateGate, request: visaTemplateRequest, settings: {RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_otp_request'}},
    {factory: createVisaPaymentTemplateGate, request: visaPaymentTemplateRequest, settings: {RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'}}
  ]) {
    const name = Object.values(settings)[0], configEnv = {...env, SAUDI_VISA_WABA_ID: '100000000002', ...settings};
    const body = request({name}), template = {...body, status: 'REJECTED', rejected_reason: 'INCORRECT_CATEGORY'};
    let at = 1000;
    const gate = factory({env: configEnv, now: () => at, fetchImpl: async (url, options) => {
      assert.equal(options.method, undefined); assert.ok(new URL(url).searchParams.get('fields').split(',').includes('rejected_reason'));
      return {ok: true, json: async () => ({data: [template]})};
    }});
    assert.equal(await gate(), false); assert.deepEqual(gate.status(), {state: 'rejected', approved: false, checked: true, rejectedReason: 'INCORRECT_CATEGORY'});
    template.rejected_reason = 'INVALID_FORMAT'; at += 60001; assert.equal(await gate(), false); assert.equal(gate.status().rejectedReason, 'INVALID_FORMAT');
    for (const value of ['PRIVATE_PROVIDER_TEXT_' + env.WHATSAPP_ACCESS_TOKEN, 'X'.repeat(500), {private: 'SYNTHETIC_SECRET'}, 123]) {
      template.rejected_reason = value; at += 60001; assert.equal(await gate(), false); assert.equal(gate.status().rejectedReason, 'UNRECOGNIZED_REJECTION_REASON');
      assert.doesNotMatch(JSON.stringify(gate.status()), /PRIVATE|SYNTHETIC_SECRET|synthetic-private-token/);
    }
    delete template.rejected_reason; at += 60001; assert.equal(await gate(), false); assert.equal(gate.status().rejectedReason, 'UNAVAILABLE');
    template.status = 'PENDING'; template.rejected_reason = 'SCAM'; at += 60001; assert.equal(await gate(), false); assert.equal(gate.status().rejectedReason, undefined);
    template.status = 'APPROVED'; template.components = []; at += 60001; assert.equal(await gate(), false); assert.equal(gate.status().state, 'schema_mismatch'); assert.equal(gate.status().rejectedReason, undefined);
    template.components = body.components; at += 60001; assert.equal(await gate(), true); assert.equal(gate.status().state, 'approved'); assert.equal(gate.status().rejectedReason, undefined);
  }
});

test('template helper proposes utility approval request; gate requires exact approved category, language and schema', async () => {
  const configEnv = {...env, SAUDI_VISA_WABA_ID: '100000000002', RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_otp_request'}, requested = visaTemplateRequest(visaTemplateConfig(configEnv));
  assert.equal(requested.category, 'UTILITY'); assert.equal(requested.components[0].text, OTP_TEMPLATE_BODY);
  assert.doesNotMatch(OTP_TEMPLATE_BODY, /رمز|تحقق|مصادق|\botp\b|\bcode\b|authentication/i);
  assert.deepEqual(requested.components[0].text.match(/\{\{\d+\}\}/g), ['{{1}}', '{{2}}']);
  assert.deepEqual(requested.components[1], {type: 'BUTTONS', buttons: [{type: 'QUICK_REPLY', text: 'متابعة المهمة'}]});
  const approved = {...requested, status: 'APPROVED'};
  for (const template of [{...approved, status: 'PENDING'}, {...approved, category: 'AUTHENTICATION'}, {...approved, language: 'en'}, {...approved, components: [{type: 'BODY', text: 'Something {{1}} else {{2}}'}]}, {...approved, components: [approved.components[0]]}, {...approved, components: [...approved.components, {type: 'BUTTONS', buttons: []}]}, ...[
    [], [{type: 'QUICK_REPLY', text: 'طلب مختلف'}], [{type: 'URL', text: 'متابعة المهمة', url: 'https://example.test'}], [{type: 'QUICK_REPLY', text: 'متابعة المهمة'}, {type: 'QUICK_REPLY', text: 'إجراء آخر'}]
  ].map(buttons => ({...approved, components: [approved.components[0], {type: 'BUTTONS', buttons}]}))]) {
    const gate = createVisaTemplateGate({env: configEnv, fetchImpl: async () => ({ok: true, json: async () => ({data: [template]})})}); assert.equal(await gate(), false); assert.equal(gate.status().approved, false);
  }
  let at = 1000, calls = 0, status = 'PENDING';
  const gate = createVisaTemplateGate({env: configEnv, now: () => at, fetchImpl: async (url, options) => { calls++; assert.equal(options.method, undefined); assert.match(url, /message_templates\?name=synthetic_otp_request/); return {ok: true, json: async () => ({data: [{...approved, status}]})}; }});
  assert.equal(await gate(), false); status = 'APPROVED'; assert.equal(await gate(), false); at += 60001; assert.equal(await gate(), true); assert.equal(calls, 2); assert.equal(gate.status().state, 'approved');
  assert.equal(await createVisaTemplateGate({env: {}})(), false);
});

test('notification readiness only reads cached approval gates and is false without live valid configuration', async () => {
  const configEnv = {...env, SAUDI_VISA_WABA_ID: '100000000002', RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_action_required', RAAD_VISA_PAYMENT_TEMPLATE: 'synthetic_payment_notice'};
  const templates = [visaTemplateRequest(visaTemplateConfig(configEnv)), visaPaymentTemplateRequest(visaPaymentTemplateConfig(configEnv))].map(template => ({...template, status: 'APPROVED'}));
  const calls = [];
  const adapter = createVisaWhatsAppAdapter({env: configEnv, fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.method, undefined); assert.equal(options.body, undefined); assert.ok(new URL(url).pathname.endsWith('/message_templates')); return {ok: true, json: async () => ({data: templates})}; }});
  assert.deepEqual(await adapter.notificationReadiness(), {paymentTemplateApproved: true, ownerTemplateApproved: true}); assert.equal(calls.length, 2);
  assert.deepEqual(await adapter.notificationReadiness(), {paymentTemplateApproved: true, ownerTemplateApproved: true}); assert.equal(calls.length, 2);
  configEnv.RAAD_VISA_PAYMENT_TEMPLATE = 'INVALID NAME';
  assert.deepEqual(await adapter.notificationReadiness(), {paymentTemplateApproved: false, ownerTemplateApproved: true}); assert.equal(calls.length, 2);
  const noCheck = async () => assert.fail('invalid/dry-run configuration cannot read approval gates');
  for (const invalid of [{...configEnv, DRY_RUN: 'true'}, {...configEnv, WHATSAPP_PHONE_NUMBER_ID: 'invalid'}, {DRY_RUN: 'false'}]) {
    const inactive = createVisaWhatsAppAdapter({env: invalid, templateGate: noCheck, paymentTemplateGate: noCheck, fetchImpl: noCheck});
    assert.deepEqual(await inactive.notificationReadiness(), {paymentTemplateApproved: false, ownerTemplateApproved: false});
  }
});

test('owner readiness uses the real inbound timestamp and requires at least 35 minutes remaining without writes or sends', async () => {
  let at = 2000000000000, writes = 0;
  const store = {data: {}, save() { writes++; }}, journal = new ConversationJournal({store, now: () => at});
  journal.recordInbound(OWNER, {id: 'synthetic-owner-inbound', text: 'متابعة المهمة', timestamp: at});
  const noRequest = async () => assert.fail('real sufficiently long service window needs no template fetch or send');
  const adapter = createVisaWhatsAppAdapter({env, journal, now: () => at, fetchImpl: noRequest});
  const before = writes;
  assert.equal(await adapter.ownerNotificationReady(), true);
  at += 86400000 - 35 * 60000; assert.equal(await adapter.ownerNotificationReady(), true);
  at++; assert.equal(journal.summary(OWNER).serviceWindowOpen, true); assert.equal(await adapter.ownerNotificationReady(), false);
  at += 35 * 60000; assert.equal(await adapter.ownerNotificationReady(), false);
  assert.equal(writes, before); assert.equal(journal.get(OWNER).lastInboundAt, 2000000000000);
});

test('owner readiness fails closed for unknown expiry, invalid owner/config and dry run, but allows a verified task template', async () => {
  const settings = {...env, SAUDI_VISA_WABA_ID: '100000000002', RAAD_OTP_REQUEST_TEMPLATE: 'synthetic_action_required'}, at = 2000000000000;
  for (const lastInboundAt of [undefined, null, at + 1, Infinity, String(at), at - 86400000 + 35 * 60000 - 1]) {
    const journal = {summary: recipient => { assert.equal(recipient, OWNER); return {serviceWindowOpen: true, lastInboundAt}; }};
    const blocked = createVisaWhatsAppAdapter({env: settings, journal, now: () => at, templateGate: async () => false, fetchImpl: async () => assert.fail('no sends')});
    assert.equal(await blocked.ownerNotificationReady(), false);
    const approved = createVisaWhatsAppAdapter({env: settings, journal, now: () => at, templateGate: async () => true, fetchImpl: async () => assert.fail('no sends')});
    assert.equal(await approved.ownerNotificationReady(), true);
  }
  const noRead = () => assert.fail('invalid configuration cannot inspect window or query gate');
  for (const invalid of [{...settings, DRY_RUN: 'true'}, {...settings, RAAD_OTP_OWNER_WHATSAPP: 'invalid'}, {...settings, RAAD_OTP_OWNER_WHATSAPP: ''}, {...settings, WHATSAPP_PHONE_NUMBER_ID: 'invalid'}]) {
    const adapter = createVisaWhatsAppAdapter({env: invalid, journal: {summary: noRead, get: noRead}, templateGate: noRead, fetchImpl: noRead});
    assert.equal(await adapter.ownerNotificationReady(), false);
  }
  const fallback = createVisaWhatsAppAdapter({env, now: () => at, journal: {summary: () => ({serviceWindowOpen: true}), get: () => ({id: OWNER, lastInboundAt: at})}, fetchImpl: async () => assert.fail('no requests')});
  assert.equal(await fallback.ownerNotificationReady(), true);
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
test('owner task quick replies parse only the exact bound payload in template-button and interactive-button events', () => {
  const template = {id: 'owner-reply', from: OWNER, timestamp: '1792886400', context: {id: 'bound-notice'}, type: 'button', button: {payload: 'visa_owner_action:' + TOKEN, text: 'UNTRUSTED BUTTON TEXT'}};
  const [button, interactive] = extractIncomingMessages(webhook([template, incoming('button_reply', 'visa_owner_action:' + TOKEN, {from: OWNER})]));
  assert.deepEqual(button, {id: 'owner-reply', contextId: 'bound-notice', from: OWNER, name: null, text: '[متابعة إجراء التأشيرة]', visaOwnerAction: {challengeId: TOKEN}, timestamp: '1792886400'});
  assert.deepEqual(interactive.visaOwnerAction, {challengeId: TOKEN}); assert.equal(interactive.text, '[متابعة إجراء التأشيرة]'); assert.equal(interactive.contextId, 'bound-message'); assert.equal(interactive.from, OWNER);
  assert.doesNotMatch(JSON.stringify([button, interactive]), /UNTRUSTED/);
  for (const payload of ['visa_owner_action:' + TOKEN + ':extra', 'visa_owner_action:' + TOKEN.toUpperCase(), 'visa_owner_action:' + 'a'.repeat(36), 'visa_answer:' + TOKEN + ':yes', 'arbitrary_button', 123, null]) assert.deepEqual(extractIncomingMessages(webhook([{...template, button: {payload, text: 'UNTRUSTED'}}])), []);
  assert.deepEqual(extractIncomingMessages(webhook([incoming('list_reply', 'visa_owner_action:' + TOKEN)])), []);
  const [ordinary] = extractIncomingMessages(webhook([{id: 'ordinary-text', from: OWNER, type: 'text', text: {body: 'متابعة المهمة'}, visaOwnerAction: {challengeId: TOKEN}}]));
  assert.equal(ordinary.visaOwnerAction, undefined); assert.equal(ordinary.text, 'متابعة المهمة');
});
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

test('prepared customer-owned image is decoded, uploaded privately and sent by media ID', async () => {
  const sharp = require('sharp'), crypto = require('node:crypto');
  const originalId = '12345678-1234-4321-abcd-123456789abf';
  const bytes = await sharp({create: {width: 1100, height: 700, channels: 3, background: '#e0e0e0'}}).png().toBuffer();
  const original = {id: originalId, customer: CUSTOMER, expiresAt: 9000000000000};
  const raw = {id: MEDIA, customer: CUSTOMER, purpose: 'raad_portal_upload', kind: 'residence', mimeType: 'image/png', sourceIds: [originalId], checksum: crypto.createHash('sha256').update(bytes).digest('hex'), expiresAt: 9000000000000};
  const mediaStore = {records: {[MEDIA]: raw}, get(id, binding) { assert.equal(binding.customer, CUSTOMER); assert.equal(id, originalId); return original; }, read(id, binding) { assert.equal(id, MEDIA); assert.equal(binding.customer, CUSTOMER); return {metadata: {...raw}, bytes: Buffer.from(bytes)}; }};
  const f = fixture({mediaStore}), payload = {type: 'image', mediaId: MEDIA, mimeType: 'image/png', kind: 'residence', caption: 'الهوية المجهزة من مرفقاتك.'};
  await f.adapter.send(CUSTOMER, payload, ok, metadata);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].request.body.get('file').type, 'image/png');
  assert.equal(f.calls[0].request.body.get('file').name, 'raad-residence.png');
  assert.deepEqual(JSON.parse(f.calls[1].request.body).image, {id: '100001', caption: payload.caption});
  assert.equal(JSON.parse(f.calls[1].request.body).to, CUSTOMER);
  for (const change of [() => { raw.customer = OTHER; }, () => { raw.purpose = undefined; }, () => { raw.kind = 'passport'; }, () => { raw.checksum = '0'.repeat(64); }, () => { original.expiresAt = 0; }]) {
    Object.assign(raw, {customer: CUSTOMER, purpose: 'raad_portal_upload', kind: 'residence', checksum: crypto.createHash('sha256').update(bytes).digest('hex')}); original.expiresAt = 9000000000000;
    change(); const bad = fixture({mediaStore});
    await assert.rejects(bad.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_IMAGE_INVALID/); assert.equal(bad.calls.length, 0);
  }
});

test('prepared image guard and source expiry are rechecked after upload, and dry run or closed window never reads', async () => {
  const sharp = require('sharp'), crypto = require('node:crypto');
  const sourceId = '12345678-1234-4321-abcd-123456789abf', bytes = await sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).jpeg().toBuffer();
  const payload = {type: 'image', mediaId: MEDIA, mimeType: 'image/jpeg', kind: 'passport', caption: 'نسختك المجهزة.'};
  let reads = 0, expiresAt = 9000000000000;
  const mediaStore = {records: {[MEDIA]: {customer: CUSTOMER, purpose: 'raad_portal_upload', kind: 'passport', mimeType: 'image/jpeg', sourceIds: [sourceId], checksum: crypto.createHash('sha256').update(bytes).digest('hex'), expiresAt: 9000000000000}}, get: id => ({id, customer: CUSTOMER, expiresAt}), read: () => { reads++; return {metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'image/jpeg'}, bytes: Buffer.from(bytes)}; }};
  for (const options of [{env: {DRY_RUN: 'true'}}, {windows: []}]) { const f = fixture({...options, mediaStore}); await f.adapter.send(CUSTOMER, payload, ok, metadata); assert.equal(f.calls.length, 0); }
  assert.equal(reads, 0);
  const calls = [], f = fixture({mediaStore, fetchImpl: async (url, request) => { calls.push({url, request}); expiresAt = 0; return {ok: true, json: async () => ({id: '100001'})}; }});
  await assert.rejects(f.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_MESSAGE_SUPERSEDED/); assert.equal(calls.length, 1);
  expiresAt = 9000000000000;
  const invalid = fixture({mediaStore: {...mediaStore, read: () => ({metadata: {id: MEDIA, customer: CUSTOMER, mimeType: 'image/jpeg'}, bytes: Buffer.from('not an image')})}});
  await assert.rejects(invalid.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_IMAGE_INVALID/); assert.equal(invalid.calls.length, 0);
});

test('client preview purpose must be explicit and never masquerades as a government-upload image', async () => {
  const sharp = require('sharp'), crypto = require('node:crypto');
  const sourceId = '12345678-1234-4321-abcd-123456789abf', bytes = await sharp({create: {width: 1000, height: 600, channels: 3, background: '#cccccc'}}).png().toBuffer();
  const raw = {id: MEDIA, customer: CUSTOMER, purpose: 'visa_client_preview', kind: 'passport', mimeType: 'image/png', sourceIds: [sourceId], checksum: crypto.createHash('sha256').update(bytes).digest('hex'), expiresAt: 9000000000000};
  const mediaStore = {records: {[MEDIA]: raw}, get: id => ({id, customer: CUSTOMER, expiresAt: raw.expiresAt}), read: () => ({metadata: {...raw}, bytes: Buffer.from(bytes)})};
  const payload = {type: 'image', kind: 'passport', mediaId: MEDIA, mimeType: 'image/png', caption: 'معاينة فقط'};
  const f = fixture({mediaStore});
  await assert.rejects(f.adapter.send(CUSTOMER, payload, ok, metadata), /VISA_WHATSAPP_IMAGE_INVALID/); assert.equal(f.calls.length, 0);
  await f.adapter.send(CUSTOMER, {...payload, purpose: 'visa_client_preview'}, ok, metadata); assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[1].request.body).image.caption, 'معاينة فقط');
  await assert.rejects(f.adapter.send(CUSTOMER, {...payload, purpose: 'arbitrary'}, ok, metadata), /VISA_WHATSAPP_PAYLOAD_INVALID/);
});
test('visual verification notice uses its dedicated recipient and does not change OTP ownership',async()=>{const notice={recipient:OWNER,jobId:JOB,noticeId:TOKEN,text:'مطلوب إكمال التحقق المرئي.'},f=fixture({env:{RAAD_OPERATOR_NOTICE_WHATSAPP:OWNER}});f.windows.add(OWNER);await f.adapter.sendOperatorNotice(notice,ok);const message=JSON.parse(f.calls[0].request.body);assert.equal(message.to,OWNER);assert.equal(message.text.body,notice.text);await assert.rejects(f.adapter.sendOperatorNotice({...notice,recipient:CUSTOMER},ok),/RECIPIENT_MISMATCH/);});
test('visual notice uses approved utility action outside the window and withholds free text',async()=>{const f=fixture({env:{RAAD_OPERATOR_NOTICE_WHATSAPP:OWNER,RAAD_OTP_REQUEST_TEMPLATE:'synthetic_otp_request'},templateGate:async()=>true});f.windows.delete(OWNER);const result=await f.adapter.sendOperatorNotice({recipient:OWNER,jobId:JOB,noticeId:TOKEN,text:'PRIVATE-FREE-TEXT'},ok);assert.equal(result.paused,true);assert.equal(result.noticeMessageId,'wamid.synthetic.1');const payload=JSON.parse(f.calls[0].request.body);assert.equal(payload.to,OWNER);assert.equal(payload.type,'template');assert.equal(payload.template.components[1].parameters[0].payload,'visa_operator_action:'+TOKEN);assert.doesNotMatch(f.calls[0].request.body,/PRIVATE-FREE-TEXT/);await f.adapter.sendOperatorNotice({recipient:OWNER,jobId:JOB,noticeId:TOKEN,text:'text',noticeMessageId:result.noticeMessageId},ok);assert.equal(f.calls.length,1);});

test('visual action quick replies preserve exact notice identity and never become an OTP answer',()=>{const event={id:'operator-reply',from:OWNER,timestamp:'1792886400',context:{id:'notice-context'},type:'button',button:{payload:'visa_operator_action:'+TOKEN,text:'UNTRUSTED'}};const [message]=extractIncomingMessages(webhook([event]));assert.deepEqual(message.visaOperatorAction,{noticeId:TOKEN});assert.equal(message.visaOwnerAction,undefined);assert.equal(message.contextId,'notice-context');assert.doesNotMatch(message.text,/UNTRUSTED/);assert.deepEqual(extractIncomingMessages(webhook([{...event,button:{payload:'visa_operator_action:'+TOKEN+':extra'}}])),[]);});
