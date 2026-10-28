'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const UI = require('../src/visa-journey-ui');
const source = fs.readFileSync(require.resolve('../src/visa-journey-ui'), 'utf8');

const sample = overrides => ({customer: '971500000001', caseId: 'visa-example', name: 'عميل تجريبي', caseSignature: 'current-signature', revision: 4, applicantCount: 1, quote: {total: 700}, receipts: [{mediaId: 'receipt-example-123', state: 'awaiting_accountant', caseSignature: 'current-signature'}], blockers: ['ACCOUNTANT_APPROVAL_REQUIRED'], jobs: [], messages: [], ...overrides});
test('receipt arrival queues accountant review and never records payment as verified', () => {
  const item = UI.normalize(sample());
  assert.equal(item.stage, 'awaiting_accountant');
  assert.equal(item.payment.verified, false);
  assert.equal(item.payment.receiptMediaId, 'receipt-example-123');
  assert.equal(item.governmentFees.status, 'unpaid');
});
test('a delivered payment acknowledgement does not imply that the application PDF arrived', () => {
  const item = UI.normalize(sample({approval: {id: 'approval', state: 'approved', amount: 700}, jobs: [{id: 'job', approvalId: 'approval', state: 'saved_application'}], messages: [{kind: 'payment_received_notice', state: 'delivered', jobId: 'job'}]}));
  assert.equal(item.stage, 'saved');
  assert.equal(item.payment.verified, true);
  assert.equal(item.applicants[0].stage, 'saved');
});
test('application message acceptance and delivery remain distinct and aggregate across all applicants', () => {
  const base = sample({approval: {id: 'approval', state: 'approved'}, jobs: [{id: 'one', approvalId: 'approval', state: 'saved_application'}, {id: 'two', approvalId: 'approval', state: 'saved_application'}], messages: [{kind: 'application_request_copy', state: 'delivered', jobId: 'one'}, {kind: 'application_request_copy', state: 'accepted', jobId: 'two'}]});
  assert.equal(UI.normalize(base).stage, 'accepted');
  base.messages[1].state = 'delivered';
  assert.equal(UI.normalize(base).stage, 'delivered');
  base.messages[1].state = 'uncertain';
  assert.equal(UI.normalize(base).stage, 'blocked');
});
test('the current approval excludes stale jobs and preserves explicit client and OTP waiting states', () => {
  const base = sample({approval: {id: 'new', state: 'approved'}, jobs: [{id: 'old-job', approvalId: 'old', state: 'stale'}, {id: 'new-job', approvalId: 'new', state: 'waiting_otp'}]});
  assert.equal(UI.normalize(base).stage, 'awaiting_otp');
  base.jobs[1].state = 'awaiting_answer_confirmation';
  assert.equal(UI.normalize(base).stage, 'awaiting_client');
  base.approval.state = 'stale';
  assert.equal(UI.normalize(base).payment.verified, false);
});

function harness({approve, capabilities, list, item, media} = {}) {
  const nodes = [], requests = [], toasts = [], revoked = [], mediaCalls = [], opened = [];
  const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this._text = ''; this.disabled = false; this.checked = false; this.open = false; this.isConnected = true; this.classList = {add() {}}; nodes.push(this); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    append(...children) { for (const child of children) { this.children.push(child); child.parentNode = this; } }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; for (const handler of this.listeners.close || []) handler(); }
    click() { if (!this.disabled) this.onclick?.({target: this}); }
    querySelector(selector) { return descendants(this).slice(1).find(node => selector === 'button' ? node.tagName === 'button' : false); }
    querySelectorAll() { return descendants(this).slice(1).filter(node => ['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(node.tagName) && !node.disabled); }
    getClientRects() { return this.hidden ? [] : [{}]; }
    contains(node) { return descendants(this).includes(node); }
    get elements() { return descendants(this).filter(node => ['input', 'button', 'select', 'textarea'].includes(node.tagName)); }
    reportValidity() { return this.elements.every(node => node.disabled || !node.required || (node.type === 'checkbox' ? node.checked : node.type === 'number' ? Number(node.value) > 0 : node.value.trim().length >= (node.minLength || 1))); }
  }
  const body = new Element('body'), root = new Element('div');
  const document = {body, activeElement: null, getElementById: () => root, createElement: tag => new Element(tag), querySelectorAll: selector => descendants(body).filter(node => selector === '.vj-dialog' && node.tagName === 'dialog')};
  const context = {document, console, Intl, Date, Map, Set, Number, String, Array, Object, JSON, Math, Blob, crypto: require('node:crypto').webcrypto, URL: {createObjectURL: () => 'blob:protected-receipt', revokeObjectURL: value => revoked.push(value)}};
  vm.runInNewContext(source, context);
  let current = sample(item);
  const ui = context.RemalVisaJourney.create({toast: message => toasts.push(message), openConversation: customer => opened.push(customer), media: async (id, customer) => { mediaCalls.push(id); return media ? media(id, customer) : new Blob(['fake'], {type: 'image/png'}); }, request: async (path, method, payload, headers) => {
    requests.push({path, method, payload, headers});
    if (method === 'POST') { if (approve) return approve({path, payload, headers}); current = {...current, approval: {id: 'approved', state: 'approved', amount: payload.amount}}; return {ok: true}; }
    if (path.includes('?')) { if (list) return list({headers}); return {items: [current], capabilities: capabilities || {accountantConfigured: true, accountantReview: headers['X-Accountant-Key'] === 'test-accountant'}}; }
    return {...current};
  }});
  const find = (tag, text) => descendants(body).find(node => node.tagName === tag && (!text || node.textContent.includes(text)));
  const activeDialog = () => descendants(body).find(node => node.tagName === 'dialog' && node.open);
  const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const submit = async form => { await form.onsubmit({preventDefault() {}}); await tick(); };
  const authorize = async () => { await ui.reviewPayment('971500000001'); const dialog = activeDialog(), form = descendants(dialog).find(node => node.tagName === 'form'); descendants(form).find(node => node.type === 'password').value = 'test-accountant'; await submit(form); };
  const reviewForm = () => descendants(activeDialog()).find(node => node.tagName === 'form');
  return {ui, root, body, document, nodes, requests, toasts, revoked, mediaCalls, opened, find, descendants, activeDialog, submit, tick, authorize, reviewForm};
}

test('accountant authority is confirmed by the server before the approval form opens', async () => {
  const h = harness({capabilities: {accountantConfigured: true, accountantReview: false}});
  await h.authorize();
  assert.match(h.activeDialog().textContent, /لم تُمنح صلاحية/);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  assert.equal(h.nodes.some(node => node.type === 'number'), false);
  assert.equal(h.requests[0].headers['X-Accountant-Key'], 'test-accountant');
});
test('approval requires actual received amount, reference and explicit confirmation, bound to this case and receipt', async () => {
  const h = harness(); await h.authorize();
  const form = h.reviewForm(), controls = h.descendants(form), amount = controls.find(node => node.type === 'number'), reference = controls.find(node => node.tagName === 'input' && !node.type), check = controls.find(node => node.type === 'checkbox');
  assert.equal(amount.value, '');
  await h.submit(form); assert.equal(h.requests.some(request => request.method === 'POST'), false);
  amount.value = '700'; reference.value = 'BANK-123'; await h.submit(form); assert.equal(h.requests.some(request => request.method === 'POST'), false);
  check.checked = true; await h.submit(form);
  const request = h.requests.find(request => request.method === 'POST');
  assert.equal(request.path, 'visa-workflow/971500000001/confirm-payment');
  assert.equal(request.headers['X-Accountant-Key'], 'test-accountant');
  assert.equal(request.payload.amount, 700);
  assert.equal(request.payload.reference, 'BANK-123');
  assert.equal(request.payload.actualReceived, true);
  assert.equal(request.payload.confirm, true);
  assert.equal(request.payload.receiptMediaId, 'receipt-example-123');
  assert.equal(request.payload.expectedRevision, 4);
  assert.equal(request.payload.expectedCaseSignature, 'current-signature');
  assert.match(request.payload.idempotencyKey, /^[a-f0-9-]{36}$/);
  assert.equal(h.activeDialog(), undefined);
  assert.deepEqual(h.revoked, ['blob:protected-receipt']);
});
test('an uncertain approval retry keeps its idempotency key and rejects changed payment details', async () => {
  const h = harness({approve: () => { throw Error('network timeout'); }}); await h.authorize(); const form = h.reviewForm(), controls = h.descendants(form), amount = controls.find(node => node.type === 'number'), reference = controls.find(node => node.tagName === 'input' && !node.type), check = controls.find(node => node.type === 'checkbox');
  amount.value = '700'; reference.value = 'BANK-123'; check.checked = true; await h.submit(form); await h.submit(form);
  let posts = h.requests.filter(request => request.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].payload.idempotencyKey, posts[1].payload.idempotencyKey);
  reference.value = 'DIFFERENT'; await h.submit(form); posts = h.requests.filter(request => request.method === 'POST'); assert.equal(posts.length, 2); assert.match(form.textContent, /محاولة اعتماد غير مؤكدة/);
});
test('logout clears accountant access and a delayed authentication response cannot reopen the review', async () => {
  let complete; const h = harness({list: () => new Promise(resolve => { complete = resolve; })});
  await h.ui.reviewPayment('971500000001'); const dialog = h.activeDialog(), form = h.descendants(dialog).find(node => node.tagName === 'form'); h.descendants(form).find(node => node.type === 'password').value = 'test-accountant';
  const pending = form.onsubmit({preventDefault() {}}); await h.tick(); h.ui.reset(); complete({items: [sample()], capabilities: {accountantReview: true}}); await pending; await h.tick();
  assert.equal(h.activeDialog(), undefined); assert.equal(h.toasts.length, 0); assert.equal(h.root.textContent, '');
  await h.ui.reviewPayment('971500000001'); assert.match(h.activeDialog().textContent, /مفتاح صلاحية المحاسب/); assert.equal(h.requests.length, 1);
});

test('uncategorized original images and PDFs are offered without automatically choosing a passport', async () => {
  const files = [{id: 'passport-original', filename: 'passport.jpg', mimeType: 'image/jpeg'}, {id: 'bank-original', filename: 'bank.pdf', mimeType: 'application/pdf'}, {id: 'derived-preview', filename: 'preview.png', mimeType: 'image/png', purpose: 'raad_pdf_preview'}, {id: 'derived-upload', filename: 'upload.jpg', mimeType: 'image/jpeg', purpose: 'raad_portal_upload'}, {id: 'application-artifact', filename: 'application.pdf', mimeType: 'application/pdf', status: 'application_copy'}, {id: 'audio-original', mimeType: 'audio/ogg'}, {id: 'foreign-original', customer: '971500000099', mimeType: 'image/jpeg'}];
  const h = harness({item: {receipts: [], media: files}}); await h.authorize();
  const form = h.reviewForm(), controls = h.descendants(form), selector = controls.find(node => node.tagName === 'select'), submitButton = controls.find(node => node.type === 'submit');
  assert.equal(selector.value, ''); assert.equal(submitButton.disabled, true); assert.deepEqual(h.mediaCalls, []);
  assert.match(selector.textContent, /اختر إيصال التحويل من الملفات/); assert.match(selector.textContent, /passport.jpg/); assert.match(selector.textContent, /bank.pdf/); assert.doesNotMatch(selector.textContent, /preview.png|upload.jpg/);
  assert.deepEqual(UI.receiptChoices(UI.normalize(sample({receipts: [], media: files}))).map(file => file.id), ['passport-original', 'bank-original']);
  selector.value = 'bank-original'; await selector.onchange(); await h.tick(); assert.equal(submitButton.disabled, false); assert.deepEqual(h.mediaCalls, ['bank-original']);
  controls.find(node => node.type === 'number').value = '700'; controls.find(node => node.tagName === 'input' && !node.type).value = 'BANK-1'; controls.find(node => node.type === 'checkbox').checked = true; await h.submit(form);
  assert.equal(h.requests.find(request => request.method === 'POST').payload.receiptMediaId, 'bank-original');
});
test('changing the receipt resets actual-receipt confirmation and binds a fresh attempt to the selected file', async () => {
  const h = harness({item: {media: [{id: 'second-receipt', filename: 'second.pdf', mimeType: 'application/pdf'}]}, approve: () => { throw Object.assign(Error('rejected for review'), {status: 400}); }}); await h.authorize();
  const form = h.reviewForm(), controls = h.descendants(form), selector = controls.find(node => node.tagName === 'select'), checkbox = controls.find(node => node.type === 'checkbox');
  controls.find(node => node.type === 'number').value = '700'; controls.find(node => node.tagName === 'input' && !node.type).value = 'BANK-123'; checkbox.checked = true; await h.submit(form);
  selector.value = 'second-receipt'; await selector.onchange(); await h.tick(); assert.equal(checkbox.checked, false); await h.submit(form); assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  checkbox.checked = true; await h.submit(form); const posts = h.requests.filter(request => request.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].payload.receiptMediaId, 'receipt-example-123'); assert.equal(posts[1].payload.receiptMediaId, 'second-receipt'); assert.notEqual(posts[0].payload.idempotencyKey, posts[1].payload.idempotencyKey);
});
test('approval remains disabled while the selected preview loads and stale preview responses cannot replace it', async () => {
  const pending = new Map(), h = harness({item: {media: [{id: 'second-receipt', filename: 'second.pdf', mimeType: 'application/pdf'}]}, media: id => new Promise(resolve => pending.set(id, resolve))}); await h.authorize();
  const form = h.reviewForm(), controls = h.descendants(form), selector = controls.find(node => node.tagName === 'select'), submit = controls.find(node => node.type === 'submit'); assert.equal(submit.disabled, true);
  selector.value = 'second-receipt'; const loading = selector.onchange(); assert.equal(submit.disabled, true); pending.get('second-receipt')(new Blob(['fake'], {type: 'application/pdf'})); await loading; await h.tick(); assert.equal(submit.disabled, false);
  pending.get('receipt-example-123')(new Blob(['fake'], {type: 'image/jpeg'})); await h.tick(); assert.match(h.activeDialog().textContent, /second.pdf/); assert.equal(h.descendants(h.activeDialog()).some(node => node.tagName === 'img'), false);
});

test('accountant dialogs keep keyboard traversal inside the first and last visible controls', async () => {
  const h = harness(); await h.authorize(); const dialog = h.activeDialog(), controls = dialog.querySelectorAll(), first = controls[0], last = controls.at(-1), handle = dialog.listeners.keydown[0];
  let prevented = false; first.focus(); handle({key: 'Tab', shiftKey: true, preventDefault() { prevented = true; }}); assert.equal(prevented, true); assert.equal(h.document.activeElement, last);
  prevented = false; handle({key: 'Tab', shiftKey: false, preventDefault() { prevented = true; }}); assert.equal(prevented, true); assert.equal(h.document.activeElement, first);
});

test('document fields display only supplied canonical values and leave an unknown optional grandfather name absent', () => {
  const fields = UI.visibleDocumentFields({passportNumber:'DEMO123',latinFirstName:'DEMO',latinGrandfatherName:'',arabicGrandfatherName:'   ',contactEmail:'not-a-document-field@example.test',password:'never-show',birthDate:null});
  assert.deepEqual(fields.map(field => field.key), ['latinFirstName','passportNumber']);
  assert.deepEqual(fields.map(field => field.value), ['DEMO','DEMO123']);
});
test('ready document results show source matching without claiming authenticity and still require customer confirmation', async () => {
  const h = harness({item:{documentReview:{enabled:true,configured:true,status:'ready',updatedAt:'2026-10-28T12:00:00Z',applicants:[{applicantIndex:0,status:'ready',fields:{passportNumber:'DEMO123',latinFirstName:'DEMO',latinGrandfatherName:''},documents:{passport:'passport-source',residence:'residence-source',photo:'photo-source'},issues:[],evidence:{passportMrzChecked:true,matchedResidence:true,fieldSources:{passportNumber:[{mediaId:'passport-source',page:1,method:'visible_and_mrz_checked',confidence:0.99}]}}}],issues:[]}}});
  await h.ui.openCase('971500000001'); const section = h.descendants(h.activeDialog()).find(node => node.className === 'vj-document-review');
  assert.match(section.textContent,/اكتملت القراءة والمطابقة الآلية/); assert.match(section.textContent,/DEMO123/); assert.match(section.textContent,/مقارنة النص الظاهر مع منطقة الجواز الآلية/); assert.match(section.textContent,/مطابقة الهوية \/ الإقامة مع بيانات الجواز/); assert.match(section.textContent,/يبقى تأكيد العميل/); assert.match(section.textContent,/لا تثبت أصالة الوثائق/); assert.doesNotMatch(section.textContent,/اسم الجد|99%|0\.99/);
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].path,'visa-workflow/971500000001');
});
test('document mismatch reasons stay actionable and open the existing client and Raad editor', async () => {
  const h = harness({item:{documentReview:{enabled:true,configured:true,status:'needs_review',applicants:[{applicantIndex:1,status:'needs_review',fields:{passportNumber:'DEMO124'},documents:{passport:'source'},issues:[{code:'PASSPORT_VIZ_MRZ_MISMATCH',field:'passportNumber'}],evidence:{passportMrzChecked:false,matchedResidence:false}}],issues:[]}}});
  await h.ui.openCase('971500000001'); const section = h.descendants(h.activeDialog()).find(node => node.className === 'vj-document-review');
  assert.match(section.textContent,/المتقدم 2/); assert.match(section.textContent,/اختلف النص الظاهر عن القراءة الآلية/); assert.match(section.textContent,/تحتاج مراجعة/); assert.equal(h.descendants(section).find(node => node.className === 'vj-document-fields').open,true);
  h.descendants(section).find(node => node.tagName === 'button').click(); assert.deepEqual(h.opened,['971500000001']); assert.equal(h.activeDialog(),undefined);
});
test('absent, pending and unavailable document results show their actual state without invented extracted values', async () => {
  for (const [documentReview, expected] of [[undefined,'لم تصل نتيجة قراءة بعد'],[{enabled:true,configured:true,status:'processing',applicants:[]},'جارٍ قراءة المستندات ومطابقتها'],[{enabled:true,configured:false,status:'not_started',applicants:[]},'خدمة القراءة غير متاحة']]) {
    const h = harness({item:{documentReview}}); await h.ui.openCase('971500000001'); const section = h.descendants(h.activeDialog()).find(node => node.className === 'vj-document-review'); assert.match(section.textContent,new RegExp(expected)); assert.equal(h.descendants(section).some(node => node.tagName === 'dd'),false);
  }
});
test('unshown required facts wait for the client without becoming a staff exception or invented field value', async () => {
  const h = harness({item:{documentReview:{enabled:true,configured:true,status:'needs_confirmation',applicants:[{applicantIndex:0,status:'needs_confirmation',fields:{passportNumber:'DEMO123'},clientFieldsRequired:['passportType','issueDate','birthPlace'],documents:{passport:'passport-source',residence:'residence-source'},issues:[],evidence:{passportMrzChecked:true,matchedResidence:true}}],issues:[]}}});
  await h.ui.openCase('971500000001'); const section = h.descendants(h.activeDialog()).find(node => node.className === 'vj-document-review');
  assert.match(section.textContent,/بانتظار تأكيد العميل/); assert.match(section.textContent,/يُستكمل من العميل/); assert.match(section.textContent,/نوع الجواز/); assert.match(section.textContent,/إصدار الجواز/); assert.match(section.textContent,/مكان الميلاد/);
  assert.equal(h.descendants(section).filter(node => node.tagName === 'dd').length,1); assert.equal(h.descendants(section).some(node => node.tagName === 'button'),false);
});
test('reading completed before accountant approval shows a payment wait chip without creating a document exception', async () => {
  const h = harness({item:{documentReview:{enabled:true,configured:true,status:'ready',applicants:[{applicantIndex:0,status:'ready',awaitingPayment:true,applied:false,fields:{passportNumber:'DEMO123'},documents:{passport:'source'},issues:[]},{applicantIndex:1,status:'ready',awaitingPayment:false,applied:true,fields:{passportNumber:'DEMO456'},documents:{passport:'source-two'},issues:[]}],issues:[]}}});
  await h.ui.openCase('971500000001'); const section = h.descendants(h.activeDialog()).find(node => node.className === 'vj-document-review'), applicants = h.descendants(section).filter(node => node.className === 'vj-document-applicant');
  assert.match(applicants[0].textContent,/القراءة والمطابقة مكتملة/); assert.match(applicants[0].textContent,/بانتظار اعتماد الدفعة/); assert.doesNotMatch(applicants[1].textContent,/بانتظار اعتماد الدفعة/); assert.equal(h.descendants(section).some(node => node.tagName === 'button'),false); assert.doesNotMatch(section.textContent,/جاهز للبوابة|الدفعة معتمدة/);
});
