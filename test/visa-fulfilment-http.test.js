'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createVisaFulfilmentHttp, accountantAccess} = require('../src/visa-fulfilment-http');
const {VisaFulfilment} = require('../src/visa-fulfilment');
const {InboxService} = require('../src/inbox-http');
const {visaCaseSignature, currentVisaEvidence} = require('../src/visa-case-signature');

const CUSTOMER = '15550001101';
const OTHER = '15550001102';
const RECEIPT = '67847793-007b-4fea-9ff8-3cad1ea8fbfa';
const OTHER_RECEIPT = 'a32a853f-9b39-4c63-a81b-558519952978';
const ACCOUNTANT_KEY = 'fictitious-accountant-test-key-000000000000';
const BASE = '/internal/assistant/visa-workflow';
const NOW = Date.parse('2026-10-27T12:00:00Z');

function fixture({env = {}, onClaim} = {}) {
  const c = {
    id: 'fictitious-visa-http-case', policyVersion: 'fictitious-policy', revision: 3,
    applicantCount: 2,
    applicants: [{nationality: 'مصر', latinFirstName: 'Ari', latinFamilyName: 'Example'}, {nationality: 'مصر', latinFirstName: 'Bela', latinFamilyName: 'Example'}],
    quote: {total: 240, currency: 'AED'}, documents: [],
    paymentStatus: 'awaiting_verification', submissionStatus: 'not_submitted'
  };
  const media = (id, customer, checksum) => ({id, customer, mimeType: 'image/png', size: 150, checksum: checksum.repeat(64), expiresAt: NOW + 86400000});
  const calls = {claim: 0, release: 0, finance: 0, wake: 0, read: 0};
  const store = {
    data: {customers: {}, visaCases: {[CUSTOMER]: c}, visaMedia: {[RECEIPT]: media(RECEIPT, CUSTOMER, 'a'), [OTHER_RECEIPT]: media(OTHER_RECEIPT, OTHER, 'b')}},
    save() {},
    set(id, value) { this.data.customers[id] = structuredClone(value); }
  };
  const assistant = {state(id) { return structuredClone(store.data.customers[id] || {status: 'collecting', humanOwned: false, offers: []}); }};
  const inbox = new InboxService({store, assistant, now: () => NOW, send: async () => assert.fail('HTTP review must not send WhatsApp messages'), onClaim: async customer => { if (onClaim) await onClaim(customer, {store, inbox, c}); }});
  inbox.journal.recordInbound(CUSTOMER, {id: 'fictitious-inbound-http', text: 'طلب تأشيرة', timestamp: NOW, name: 'Example Customer'});
  const originalClaim = inbox.claim.bind(inbox), originalRelease = inbox.release.bind(inbox), originalUpdate = inbox.updateVisa.bind(inbox);
  inbox.claim = async id => { calls.claim++; return originalClaim(id); };
  inbox.release = id => { calls.release++; return originalRelease(id); };
  inbox.updateVisa = (...args) => { calls.finance++; return originalUpdate(...args); };
  const mediaStore = {
    get(id, {customer}) { const item = store.data.visaMedia[id]; if (!item || item.customer !== customer) throw Error('MEDIA_NOT_FOUND'); return structuredClone(item); },
    list(customer) { return Object.values(store.data.visaMedia).filter(item => item.customer === customer).map(item => structuredClone(item)); }
  };
  const actualEnv = {RAAD_ACCOUNTANT_KEY: ACCOUNTANT_KEY, RAAD_ACCOUNTANT_ID: 'fictitious-finance-operator', ...env};
  const fulfilment = new VisaFulfilment({store, inbox, mediaStore, now: () => NOW, env: actualEnv});
  const handle = createVisaFulfilmentHttp({fulfilment, inbox, journal: inbox.journal, mediaStore, store, env: actualEnv, wake() { calls.wake++; }});
  const body = patch => ({receiptMediaId: RECEIPT, amount: 240, reference: 'BANK-HTTP-EXAMPLE', actualReceived: true, confirm: true, expectedCaseSignature: visaCaseSignature(c), expectedRevision: c.revision, idempotencyKey: 'http-finance-key-1', ...patch});
  async function invoke({path = BASE + '/' + CUSTOMER + '/confirm-payment', method = 'POST', data = body(), key = ACCOUNTANT_KEY, headers = {}, raw, readBody} = {}) {
    let status, payload, responseHeaders;
    const response = {writeHead(code, values) { assert.equal(payload, undefined, 'response must only be written once'); status = code; responseHeaders = values; return this; }, end(value) { payload = JSON.parse(value); return this; }};
    const request = {method, headers: {...(key === undefined ? {} : {'x-accountant-key': key}), ...headers}};
    const handled = await handle(request, response, new URL('https://example.test' + path), readBody || (async () => { calls.read++; return Buffer.from(raw === undefined ? JSON.stringify(data) : raw); }));
    return {handled, status, data: payload, headers: responseHeaders};
  }
  return {store, inbox, mediaStore, fulfilment, c, calls, body, invoke, env: actualEnv};
}

test('finance access comes only from the configured header, never request-body role or key', async () => {
  const f = fixture();
  for (const key of ['', 'wrong-but-long-accountant-key-00000000000']) {
    const result = await f.invoke({key, data: f.body({actor: {role: 'accountant', id: 'forged'}, accountantKey: ACCOUNTANT_KEY, role: 'accountant'})});
    assert.equal(result.status, 403); assert.equal(result.data.error, 'ACCOUNTANT_REQUIRED');
  }
  const noHeader = await f.invoke({headers: {'x-accountant-key': undefined}, data: f.body({RAAD_ACCOUNTANT_KEY: ACCOUNTANT_KEY})});
  assert.equal(noHeader.status, 403);
  assert.equal(f.calls.read, 0, 'unauthorized request body is not parsed');
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.finance, 0); assert.equal(f.c.paymentStatus, 'awaiting_verification');
});

test('unconfigured, short, mismatched and nonstring finance keys cannot authorize', () => {
  const request = value => ({headers: {'x-accountant-key': value}});
  assert.equal(accountantAccess(request(ACCOUNTANT_KEY), {}), false);
  assert.equal(accountantAccess(request('short'), {RAAD_ACCOUNTANT_KEY: 'short'}), false);
  assert.equal(accountantAccess(request([ACCOUNTANT_KEY]), {RAAD_ACCOUNTANT_KEY: ACCOUNTANT_KEY}), false);
  assert.equal(accountantAccess(request(ACCOUNTANT_KEY + 'x'), {RAAD_ACCOUNTANT_KEY: ACCOUNTANT_KEY}), false);
  assert.equal(accountantAccess(request(ACCOUNTANT_KEY), {RAAD_ACCOUNTANT_KEY: ACCOUNTANT_KEY}), true);
});

test('accountant approval auto claims, records actual Inbox finance evidence, releases, then wakes processing', async () => {
  const f = fixture(), result = await f.invoke({data: f.body({actor: {id: 'forged-body-user', role: 'owner'}})});
  assert.equal(result.status, 200); assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.approval.actor, {id: 'fictitious-finance-operator', role: 'accountant'});
  assert.equal(result.data.approval.receiptId, RECEIPT); assert.equal(result.data.approval.receiptSha256, 'a'.repeat(64));
  assert.equal(result.data.approval.reference, 'BANK-HTTP-EXAMPLE'); assert.equal(result.data.approval.amount, 240);
  assert.equal(currentVisaEvidence(f.c).payment, true); assert.equal(f.c.staffVerification.payment.reference, 'BANK-HTTP-EXAMPLE');
  assert.equal(f.c.staffVerification.audit.filter(item => item.action === 'confirm_payment').length, 1);
  assert.equal(result.data.jobs.length, 2); assert.equal(new Set(result.data.jobs.map(job => job.id)).size, 2);
  assert.equal(result.data.item.staffClaimed, false); assert.equal(f.inbox.isOperatorOwned(CUSTOMER), false);
  assert.deepEqual(f.calls, {claim: 1, release: 1, finance: 1, wake: 1, read: 1});
  assert.equal(result.headers['Cache-Control'], 'no-store, private');
});

test('same exact HTTP approval body remains idempotent after finance increments case revision', async () => {
  const f = fixture(), body = f.body(), first = await f.invoke({data: body}), second = await f.invoke({data: body});
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(second.data.duplicate, true);
  assert.equal(first.data.approval.id, second.data.approval.id); assert.equal(f.calls.finance, 1);
  assert.equal(Object.keys(f.fulfilment.data().jobs).length, 2); assert.equal(Object.keys(f.fulfilment.data().outbox).length, 1);
  const conflict = await f.invoke({data: {...body, reference: 'DIFFERENT-HTTP-REFERENCE'}});
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'VISA_IDEMPOTENCY_CONFLICT'); assert.equal(f.calls.finance, 1);
});

test('amount, actual-receipt confirmation, reference and case freshness are validated before financial write', async t => {
  const cases = [
    [{amount: 239.99}, 'INVALID_PAYMENT'],
    [{amount: '240'}, 'INVALID_PAYMENT'],
    [{actualReceived: 'true'}, 'ACTUAL_PAYMENT_CONFIRMATION_REQUIRED'],
    [{confirm: false}, 'ACTUAL_PAYMENT_CONFIRMATION_REQUIRED'],
    [{reference: ''}, 'VISA_VALUE_INVALID'],
    [{reference: 'line\nreference'}, 'VISA_VALUE_INVALID'],
    [{expectedCaseSignature: 'f'.repeat(64)}, 'VISA_CASE_SIGNATURE_CONFLICT'],
    [{expectedRevision: 2}, 'VISA_CASE_REVISION_CONFLICT']
  ];
  for (const [patch, error] of cases) await t.test(error + ':' + Object.keys(patch)[0], async () => {
    const f = fixture(), result = await f.invoke({data: f.body(patch)});
    assert.equal(result.data.error, error); assert.notEqual(result.status, 200);
    assert.equal(f.calls.finance, 0); assert.equal(f.calls.wake, 0); assert.equal(f.inbox.isOperatorOwned(CUSTOMER), false);
    assert.equal(f.c.paymentStatus, 'awaiting_verification');
  });
});

test('a receipt from another customer cannot be approved or trigger an automatic claim', async () => {
  const f = fixture(), result = await f.invoke({data: f.body({receiptMediaId: OTHER_RECEIPT})});
  assert.equal(result.status, 404); assert.equal(result.data.error, 'VISA_MEDIA_UNAVAILABLE');
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.finance, 0); assert.equal(f.calls.wake, 0);
  assert.equal(f.c.paymentStatus, 'awaiting_verification');
});

test('stale review body cannot approve after material applicant or quote changes', async t => {
  for (const change of ['applicant', 'quote']) await t.test(change, async () => {
    const f = fixture(), body = f.body();
    if (change === 'applicant') f.c.applicants[1].latinFirstName = 'Changed';
    else f.c.quote.total = 300;
    const result = await f.invoke({data: body});
    assert.equal(result.status, 409); assert.equal(result.data.error, 'VISA_CASE_SIGNATURE_CONFLICT');
    assert.equal(f.calls.finance, 0); assert.equal(f.inbox.isOperatorOwned(CUSTOMER), false);
  });
});

test('existing complaint or block prevents auto claim, finance action, release and wake', async t => {
  for (const reason of ['complaint', 'block']) await t.test(reason, async () => {
    const f = fixture();
    if (reason === 'complaint') f.inbox.complaints.create(CUSTOMER);
    else f.inbox.journal.get(CUSTOMER).blocked = true;
    const result = await f.invoke();
    assert.equal(result.status, 409); assert.equal(result.data.error, 'AUTOMATION_PAUSED');
    assert.equal(f.calls.claim, 0); assert.equal(f.calls.finance, 0); assert.equal(f.calls.release, 0); assert.equal(f.calls.wake, 0);
    if (reason === 'complaint') assert.equal(f.inbox.complaints.active(CUSTOMER).state, 'pending');
  });
});

test('failed review preserves a preexisting staff claim instead of releasing another staff operation', async () => {
  const f = fixture(); await f.inbox.claim(CUSTOMER); const before = f.calls.release;
  const result = await f.invoke({data: f.body({amount: 1})});
  assert.equal(result.data.error, 'INVALID_PAYMENT'); assert.equal(f.calls.finance, 0);
  assert.equal(f.inbox.isOperatorOwned(CUSTOMER), true); assert.equal(f.calls.release, before);
});

test('complaint arriving during auto claim remains active and is not resolved on failed finance review', async () => {
  const f = fixture({onClaim(_customer, {inbox}) { inbox.complaints.create(CUSTOMER); }});
  const result = await f.invoke({data: f.body({amount: 1})});
  assert.equal(result.data.error, 'INVALID_PAYMENT'); assert.equal(f.calls.finance, 0);
  assert.equal(f.inbox.complaints.active(CUSTOMER).state, 'pending');
  assert.equal(f.inbox.journal.get(CUSTOMER).complaintPending, f.inbox.complaints.active(CUSTOMER).id);
  assert.equal(f.inbox.isOperatorOwned(CUSTOMER), true); assert.equal(f.calls.release, 0);
});

test('concurrent accountant reviews for one customer have one financial writer and lock clears afterward', async () => {
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { resume = resolve; });
  const f = fixture({onClaim: async () => { enter(); await blocked; }}), body = f.body();
  const first = f.invoke({data: body}); await entered;
  const second = await f.invoke({data: body}); assert.equal(second.status, 409); assert.equal(second.data.error, 'VISA_PAYMENT_REVIEW_BUSY');
  resume(); assert.equal((await first).status, 200); assert.equal(f.calls.finance, 1);
  const replay = await f.invoke({data: body}); assert.equal(replay.status, 200); assert.equal(replay.data.duplicate, true); assert.equal(f.calls.finance, 1);
});

test('malformed and oversized JSON bodies have no finance, ownership or wake side effects', async t => {
  for (const raw of ['not-json', 'null', '[]', '"text"', '{"padding":"' + 'x'.repeat(20000) + '"}']) await t.test(raw.slice(0, 14), async () => {
    const f = fixture(), result = await f.invoke({raw});
    assert.equal(result.status, 400); assert.equal(result.data.error, 'INVALID_BODY');
    assert.equal(f.calls.claim, 0); assert.equal(f.calls.finance, 0); assert.equal(f.calls.wake, 0);
  });
});

test('workflow route exposes capability separately from financial authority and safely scopes methods', async () => {
  const f = fixture(), list = await f.invoke({path: BASE, method: 'GET', key: ''});
  assert.equal(list.status, 200); assert.equal(list.data.items.length, 1);
  assert.deepEqual(list.data.capabilities, {accountantConfigured: true, accountantReview: false, governmentPayment: false});
  const detail = await f.invoke({path: BASE + '/' + CUSTOMER, method: 'GET'});
  assert.equal(detail.data.capabilities.accountantReview, true); assert.equal(detail.data.item.customer, CUSTOMER);
  assert.equal((await f.invoke({path: '/internal/assistant/status', method: 'GET'})).handled, false);
  assert.equal((await f.invoke({path: BASE + '/' + CUSTOMER + '/confirm-payment', method: 'GET'})).status, 405);
  assert.equal((await f.invoke({path: BASE + '/' + CUSTOMER + '/unknown', method: 'POST'})).status, 404);
  assert.equal((await f.invoke({path: BASE + '/constructor', method: 'GET'})).status, 400);
  assert.equal(f.calls.finance, 0);
});

test('unexpected internal error details are redacted and temporary auto claim is cleaned up', async () => {
  const f = fixture();
  f.fulfilment.confirmPayment = () => { throw Object.assign(Error('private finance network payload'), {statusCode: 500}); };
  const result = await f.invoke();
  assert.equal(result.status, 503); assert.equal(result.data.error, 'VISA_WORKFLOW_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.data), /private finance/);
  assert.equal(f.inbox.isOperatorOwned(CUSTOMER), false); assert.equal(f.calls.release, 1); assert.equal(f.calls.wake, 0);
});
