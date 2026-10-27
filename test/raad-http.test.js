'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {handleRaadRequest} = require('../src/raad-http');

const customer = '971500000031';
const other = '971500000032';
const prefix = '/internal/assistant/raad/';

function fixture({owned = true} = {}) {
  const calls = {readBody: 0, requireCustomer: [], get: [], prepare: [], review: [], read: [], storeDerived: []};
  const state = {draft: {revision: 4, fields: {latinFirstName: 'Synthetic'}}};
  const inbox = {
    owned,
    requireCustomer(id) { calls.requireCustomer.push(id); if (id !== customer) throw Error('CONVERSATION_NOT_FOUND'); },
    isOperatorOwned() { return this.owned; }
  };
  const workflow = {
    get(id, options) { calls.get.push({id, options}); return {state: 'draft', ...structuredClone(state.draft)}; },
    prepare(id, options) { calls.prepare.push({id, options}); state.draft = structuredClone(options); return {ok: true, action: 'prepare'}; },
    review(id, options) { calls.review.push({id, options}); state.draft = structuredClone(options); return {ok: true, action: 'review'}; }
  };
  const mediaStore = {
    read(id, options) { calls.read.push({id, options}); throw Error('MEDIA_NOT_FOUND'); },
    storeDerived(id, options) { calls.storeDerived.push({id, options}); return {id: 'derived-synthetic'}; }
  };
  const call = async ({method = 'POST', route = prefix + customer, body = {action: 'prepare'}, raw} = {}) => {
    const bytes = raw === undefined ? Buffer.from(JSON.stringify(body)) : Buffer.from(raw);
    let status, headers, data;
    const response = {
      writeHead(value, fields) { status = value; headers = fields; return this; },
      end(value) { data = value; }
    };
    const handled = await handleRaadRequest({method}, response, new URL(route, 'https://synthetic.invalid'), {
      inbox, workflow, mediaStore,
      readBody: async () => { calls.readBody++; return bytes; }
    });
    return {handled, status, headers, body: data === undefined ? undefined : JSON.parse(data)};
  };
  return {calls, state, inbox, workflow, mediaStore, call};
}

function digit(value) {
  return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10);
}

function syntheticMRZ() {
  const first = 'P<UTOEXAMPLE<<SYNTHETIC<PERSON'.padEnd(44, '<');
  const number = 'N12345678', birth = '900115', expiry = '310101', optional = '<'.repeat(14);
  const second = number + digit(number) + 'ZZZ' + birth + digit(birth) + 'F' + expiry + digit(expiry) + optional + digit(optional);
  return first + '\n' + second + digit(second.slice(0, 10) + second.slice(13, 20) + second.slice(21, 43));
}

test('only the RAAD route is handled; GET is read-only and replies are private JSON', async () => {
  const f = fixture({owned: false});
  assert.equal((await f.call({route: '/internal/assistant/conversations/' + customer})).handled, false);
  const result = await f.call({method: 'GET', route: prefix + customer + '?applicantIndex=29'});
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.get, [{id: customer, options: {applicantIndex: 29}}]);
  assert.equal(f.calls.readBody, 0);
  assert.equal(f.calls.prepare.length + f.calls.review.length + f.calls.storeDerived.length, 0);
  assert.match(result.headers['Content-Type'], /application\/json/);
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal((await f.call({method: 'DELETE'})).status, 405);
  assert.equal(f.calls.readBody, 0);
});

test('a staff claim is required before reading or parsing any mutation body or opening media', async () => {
  const f = fixture({owned: false}), before = structuredClone(f.state);
  for (const body of [
    {action: 'prepare', confirm: true},
    {action: 'review', confirm: true},
    {action: 'parse_mrz', mrz: syntheticMRZ()},
    {action: 'prepare_image', confirm: true, kind: 'passport', sourceIds: ['synthetic-source']}
  ]) {
    const result = await f.call({body});
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {ok: false, error: 'CLAIM_REQUIRED'});
  }
  assert.equal(f.calls.readBody, 0);
  assert.equal(f.calls.get.length + f.calls.prepare.length + f.calls.review.length + f.calls.read.length + f.calls.storeDerived.length, 0);
  assert.deepEqual(f.state, before);
});

test('releasing a staff claim while the JSON body streams prevents prepare, review and MRZ dispatch', async () => {
  for (const body of [
    {action: 'prepare', confirm: true, expectedRevision: 4},
    {action: 'review', confirm: true, expectedRevision: 4},
    {action: 'parse_mrz', mrz: syntheticMRZ(), confirmedBirthDate: '1990-01-15', confirmedExpiryDate: '2031-01-01'}
  ]) {
    const f = fixture(), before = structuredClone(f.state);
    let entered, finishBody, status, result;
    const reading = new Promise(resolve => { entered = resolve; });
    const stream = new Promise(resolve => { finishBody = resolve; });
    const response = {
      writeHead(value) { status = value; return this; },
      end(value) { result = JSON.parse(value); }
    };
    const pending = handleRaadRequest({method: 'POST'}, response, new URL(prefix + customer, 'https://synthetic.invalid'), {
      inbox: f.inbox, workflow: f.workflow, mediaStore: f.mediaStore,
      readBody: async () => { f.calls.readBody++; entered(); return stream; }
    });
    await reading;
    f.inbox.owned = false;
    finishBody(Buffer.from(JSON.stringify(body)));
    assert.equal(await pending, true);
    assert.equal(status, 409, body.action);
    assert.deepEqual(result, {ok: false, error: 'CLAIM_REQUIRED'}, body.action);
    assert.equal(f.calls.readBody, 1);
    assert.equal(f.calls.get.length + f.calls.prepare.length + f.calls.review.length + f.calls.read.length + f.calls.storeDerived.length, 0);
    assert.deepEqual(f.state, before, body.action + ' cannot persist a change after the claim is released');
  }
});

test('rejects malformed customer paths and absent conversations without dispatching work', async () => {
  const f = fixture();
  for (const value of ['', '%ZZ', '%2F', '__proto__', 'constructor', 'x'.repeat(101)]) {
    const result = await f.call({route: prefix + value});
    assert.equal(result.status, 400, value);
    assert.equal(result.body.error, 'INVALID_CUSTOMER', value);
  }
  const missing = await f.call({route: prefix + other});
  assert.equal(missing.status, 404);
  assert.equal(f.calls.readBody, 0);
  assert.equal(f.calls.prepare.length + f.calls.review.length, 0);
});

test('validates the applicant index from both the URL and JSON before dispatch', async () => {
  const f = fixture();
  for (const value of ['-1', '30', '1.5', 'NaN', '', '000']) {
    const result = await f.call({route: prefix + customer + '?applicantIndex=' + value});
    assert.equal(result.status, 400, value);
    assert.equal(result.body.error, 'INVALID_APPLICANT_INDEX');
  }
  assert.equal(f.calls.readBody, 0);
  for (const applicantIndex of [-1, 30, 0.5, '0', true]) {
    const result = await f.call({body: {action: 'prepare', applicantIndex}});
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_APPLICANT_INDEX');
  }
  assert.equal(f.calls.prepare.length, 0);
  assert.equal((await f.call({route: prefix + customer + '?applicantIndex=3', body: {action: 'prepare', applicantIndex: 2, expectedRevision: 4}})).status, 200);
  assert.equal(f.calls.prepare[0].options.applicantIndex, 2);
});

test('requires bounded object JSON and rejects all portal, OTP, payment and consent actions', async () => {
  const f = fixture();
  for (const raw of ['', '{', 'null', '[]', 'true', '"prepare"', Buffer.alloc(100001, 32)]) {
    const result = await f.call({raw});
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_RAAD_BODY');
  }
  for (const action of [undefined, 'otp', 'login', 'submit', 'pay', 'accept_consent', 'complete', 'PREPARE']) {
    const result = await f.call({body: {action, otp: 'SYNTHETIC_OTP_VALUE', password: 'SYNTHETIC_PASSWORD_VALUE'}});
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, {ok: false, error: 'INVALID_RAAD_ACTION'});
  }
  assert.equal(f.calls.prepare.length + f.calls.review.length + f.calls.read.length + f.calls.storeDerived.length, 0);
  const json = JSON.stringify({action: 'prepare', expectedRevision: 0});
  assert.equal((await f.call({raw: json + ' '.repeat(100000 - Buffer.byteLength(json))})).status, 200);
  assert.equal(f.calls.prepare.length, 1, 'the documented 100,000-byte boundary is inclusive');
});

test('MRZ parsing returns unreviewed proposals without touching any workflow or media state', async () => {
  const f = fixture(), before = structuredClone(f.state);
  const result = await f.call({body: {action: 'parse_mrz', mrz: syntheticMRZ(), confirmedBirthDate: '1990-01-15', confirmedExpiryDate: '2031-01-01', confirm: true}});
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.fields.passportNumber, 'N12345678');
  assert.equal(result.body.fields.nationalityCode, 'ZZZ');
  assert.equal(result.body.fields.documentReviewed, false);
  assert.equal(f.calls.get.length + f.calls.prepare.length + f.calls.review.length + f.calls.read.length + f.calls.storeDerived.length, 0);
  assert.deepEqual(f.state, before);
  for (const mrz of [undefined, [], 'x'.repeat(301)]) {
    const invalid = await f.call({body: {action: 'parse_mrz', mrz}});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'INVALID_RAAD_BODY');
  }
  const invalidDocument = await f.call({body: {action: 'parse_mrz', mrz: 'not a TD3 document'}});
  assert.equal(invalidDocument.status, 200);
  assert.equal(invalidDocument.body.ok, false);
  assert.deepEqual(f.state, before);
});

test('image preparation requires explicit confirmation and reads only this customer’s media', async () => {
  const f = fixture();
  const base = {action: 'prepare_image', confirm: true, kind: 'passport', sourceIds: ['foreign-media']};
  for (const body of [{...base, confirm: false}, {...base, confirm: 'true'}, {...base, kind: 'audio'}, {...base, sourceIds: []}, {...base, sourceIds: ['a', 'b']}, {...base, kind: 'residence', sourceIds: ['a', 'a']}, {...base, kind: 'residence', sourceIds: ['a', 'b', 'c']}]) {
    const result = await f.call({body});
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'INVALID_RAAD_BODY');
  }
  assert.equal(f.calls.read.length, 0);
  const denied = await f.call({body: base});
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error, 'MEDIA_NOT_FOUND');
  assert.deepEqual(f.calls.read, [{id: 'foreign-media', options: {customer}}]);
  assert.equal(f.calls.storeDerived.length + f.calls.prepare.length + f.calls.review.length, 0);
});

test('image preparation rechecks staff ownership after conversion before saving', async () => {
  const sharp = require('sharp');
  const bytes = await sharp({create: {width: 1000, height: 650, channels: 3, background: '#557799'}}).png().toBuffer();
  const f = fixture();
  f.mediaStore.read = (id, options) => {
    f.calls.read.push({id, options});
    f.inbox.owned = false;
    return {bytes, metadata: {mimeType: 'image/png'}};
  };
  const result = await f.call({body: {action: 'prepare_image', confirm: true, kind: 'passport', sourceIds: ['owned-source']}});
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'CLAIM_REQUIRED');
  assert.equal(f.calls.storeDerived.length, 0);
  assert.deepEqual(f.calls.read, [{id: 'owned-source', options: {customer}}]);
  // A failed preparation request must release the in-process conversion lock.
  f.inbox.owned = true;
  f.mediaStore.read = () => { throw Error('MEDIA_NOT_FOUND'); };
  assert.equal((await f.call({body: {action: 'prepare_image', confirm: true, kind: 'photo', sourceIds: ['missing']}})).body.error, 'MEDIA_NOT_FOUND');
});

test('owned image conversion saves only a review-required derivative with this customer and source', async () => {
  const sharp = require('sharp');
  const bytes = await sharp({create: {width: 1000, height: 650, channels: 3, background: '#557799'}}).png().toBuffer();
  const original = Buffer.from(bytes), f = fixture(), before = structuredClone(f.state);
  f.mediaStore.read = (id, options) => {
    f.calls.read.push({id, options});
    return {bytes, metadata: {mimeType: 'image/png'}};
  };
  const result = await f.call({body: {action: 'prepare_image', confirm: true, kind: 'passport', sourceIds: ['owned-source']}});
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.needsVisualReview, true);
  assert.ok(result.body.transformations.includes('strip_metadata'));
  assert.deepEqual(f.calls.read, [{id: 'owned-source', options: {customer}}]);
  assert.equal(f.calls.storeDerived.length, 1);
  const saved = f.calls.storeDerived[0];
  assert.equal(saved.id, customer);
  assert.deepEqual(saved.options.sourceIds, ['owned-source']);
  assert.equal(saved.options.kind, 'passport');
  assert.ok(['image/jpeg', 'image/png'].includes(saved.options.mimeType));
  assert.ok(Buffer.isBuffer(saved.options.bytes) && saved.options.bytes.length <= 1000000);
  assert.deepEqual(bytes, original);
  assert.deepEqual(f.state, before);
  assert.equal(f.calls.prepare.length + f.calls.review.length, 0);
});

test('unexpected failures never expose storage paths, passwords, stack traces or arbitrary errors', async () => {
  const f = fixture();
  f.workflow.prepare = () => { throw Object.assign(Error('/private/state.enc password=SYNTHETIC_SECRET'), {statusCode: 400}); };
  const unexpected = await f.call();
  assert.equal(unexpected.status, 503);
  assert.deepEqual(unexpected.body, {ok: false, error: 'RAAD_UNAVAILABLE'});
  f.workflow.prepare = () => { throw Object.assign(Error('private debug detail'), {code: 'RAAD_REVISION_CONFLICT', statusCode: 409}); };
  const conflict = await f.call();
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, {ok: false, error: 'RAAD_REVISION_CONFLICT'});
});

test('the real HTTP server authenticates RAAD endpoints before routing and requires a staff claim for parsing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raad-server-'));
  const file = path.join(directory, 'state.enc'), key = 'synthetic-raad-test-state-key', admin = 'synthetic-raad-admin-key-xxxxxxxxxxxxxxxx';
  const values = {NODE_ENV: 'test', ASSISTANT_STATE_PATH: file, ASSISTANT_STATE_KEY: key, ASSISTANT_ADMIN_KEY: admin, SAUDI_VISA_ENABLED: 'false', FARE_CATALOG_ENABLED: 'false', CONSULTANT_ORCHESTRATOR_ENABLED: 'false', DRY_RUN: 'true'};
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  const {AssistantState} = require('../src/assistant-state');
  const {ConversationJournal} = require('../src/conversation-journal');
  const store = new AssistantState({file, key});
  const journal = new ConversationJournal({store});
  journal.recordInbound(customer, {id: 'raad-synthetic-inbound', text: 'Synthetic local conversation'});
  const {createServer} = require('../src/server');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const request = (route, {method = 'GET', body, token = admin} = {}) => new Promise((resolve, reject) => {
    const headers = {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})};
    const req = http.request({hostname: '127.0.0.1', port: server.address().port, path: route, method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({status: response.statusCode, headers: response.headers, text, json: text ? JSON.parse(text) : null});
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  for (const token of [null, 'synthetic-wrong-admin-key-xxxxxxxxxxxxxxxx']) {
    for (const method of ['GET', 'POST']) {
      const result = await request(prefix + customer, {method, token, body: method === 'POST' ? {action: 'parse_mrz', mrz: syntheticMRZ()} : undefined});
      assert.equal(result.status, 401);
      assert.equal(result.text, '');
    }
  }
  const unclaimed = await request(prefix + customer, {method: 'POST', body: {action: 'parse_mrz', mrz: syntheticMRZ()}});
  assert.equal(unclaimed.status, 409);
  assert.equal(unclaimed.json.error, 'CLAIM_REQUIRED');
  assert.equal((await request('/internal/assistant/conversations/' + customer + '/claim', {method: 'POST', body: {}})).status, 200);
  const before = fs.readFileSync(file);
  const parsed = await request(prefix + customer, {method: 'POST', body: {action: 'parse_mrz', mrz: syntheticMRZ(), confirmedBirthDate: '1990-01-15', confirmedExpiryDate: '2031-01-01'}});
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.ok, true);
  assert.equal(parsed.json.fields.documentReviewed, false);
  assert.match(parsed.headers['cache-control'], /no-store/);
  assert.deepEqual(fs.readFileSync(file), before, 'parsing does not write the encrypted case or draft snapshot');
});
