'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runUploadProbe} = require('../scripts/raad-tinyfish-upload-probe');

const ENV = {RAAD_TINYFISH_API_KEY: 'SYNTHETIC_SECRET_KEY', RAAD_TINYFISH_PROFILE_ID: 'prof_synthetic_only'};
const SESSION = 'br-synthetic-session';
const CDP = 'wss://browser.example.tinyfish.io/session/cdp?token=SYNTHETIC_CDP_SECRET';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', ...headers}});
function harness(overrides = {}) {
  const events = [], requests = [];
  let file;
  const input = {
    async setInputFiles(payload) { events.push('upload'); file = payload; },
    async evaluate(read) {
      events.push('metadata');
      return read({files: [{name: file.name, type: file.mimeType, size: file.buffer.length, hidden: 'must-not-read'}]});
    }
  };
  const page = {
    url: () => 'about:blank',
    async route(pattern, handler) { events.push('route'); assert.equal(pattern, '**/*'); assert.equal(typeof handler, 'function'); },
    async setContent(html) {
      events.push('content');
      assert.match(html, /<input id="synthetic-upload" type="file"/);
      assert.match(html, /default-src 'none'/);
      assert.match(html, /form-action 'none'/);
      assert.doesNotMatch(html, /<script|<form|https?:|src=/);
    },
    locator(selector) { assert.equal(selector, '#synthetic-upload'); return input; }
  };
  const context = {async newPage() { events.push('newPage'); return page; }, pages() { throw Error('existing pages must not be read'); }, cookies() { throw Error('cookies must not be read'); }, storageState() { throw Error('storage must not be read'); }};
  const browser = {contexts: () => [context], async close() { events.push('disconnect'); }};
  const request = async (url, options) => {
    const cancellation = url.endsWith('/cancel');
    events.push(cancellation ? 'cancel' : 'setup');
    requests.push({url, options});
    return cancellation ? json({cancelled: true}) : json({session_id: SESSION, cdp_url: CDP}, 201);
  };
  const connect = async (url, options) => { events.push('connect'); assert.equal(url, CDP); assert.ok(options.timeout <= 15000); return browser; };
  return {events, requests, input, page, context, browser, file: () => file, options: {env: ENV, request, connect, ...overrides}};
}
function safeOutput(value) { assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_|prof_|br-synthetic|https?:|wss:/); }

test('missing or invalid configuration performs no network or browser connection', async () => {
  const forbidden = () => { throw Error('must not be called'); };
  for (const env of [{}, {RAAD_TINYFISH_PROFILE_ID: ENV.RAAD_TINYFISH_PROFILE_ID}, {RAAD_TINYFISH_API_KEY: ENV.RAAD_TINYFISH_API_KEY}]) {
    assert.deepEqual(await runUploadProbe({env, request: forbidden, connect: forbidden}), {testedThisRun: false, uploadVerified: false, cleanupConfirmed: false, executionConnected: false, reason: 'CONFIG_MISSING'});
  }
  for (const id of ['../escape', 'prof_x/../../save', 'https://other.example', 'prof_x\n', 'prof_' + 'a'.repeat(121)]) {
    const result = await runUploadProbe({env: {...ENV, RAAD_TINYFISH_PROFILE_ID: id}, request: forbidden, connect: forbidden});
    assert.equal(result.reason, 'PROFILE_ID_INVALID');
    assert.equal(result.testedThisRun, false);
  }
});

test('fresh synthetic upload verifies only file metadata, cancels, then disconnects', async () => {
  const h = harness();
  const result = await runUploadProbe(h.options);
  assert.deepEqual(result, {testedThisRun: true, uploadVerified: true, cleanupConfirmed: true, executionConnected: false, reason: 'UPLOAD_VERIFIED'});
  assert.deepEqual(h.events, ['setup', 'connect', 'newPage', 'route', 'content', 'upload', 'metadata', 'cancel', 'disconnect']);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, 'https://agent.tinyfish.ai/v1/profiles/prof_synthetic_only/setup-session');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), {timeout_seconds: 120});
  assert.equal(h.requests[1].url, h.requests[0].url + '/cancel');
  assert.deepEqual(JSON.parse(h.requests[1].options.body), {session_id: SESSION});
  for (const {options} of h.requests) { assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-API-Key'], ENV.RAAD_TINYFISH_API_KEY); assert.ok(options.signal instanceof AbortSignal); }
  assert.equal(h.file().name, 'synthetic-upload-probe.png');
  assert.equal(h.file().mimeType, 'image/png');
  assert.ok(Buffer.isBuffer(h.file().buffer));
  assert.ok(h.file().buffer.length <= 1024);
  assert.deepEqual([...h.file().buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  safeOutput(result);
});

test('encrypted private profile fallback is supported without storing API keys in configuration', async () => {
  const h = harness({env: {RAAD_TINYFISH_API_KEY: ENV.RAAD_TINYFISH_API_KEY}, privateConfig: {raad: {tinyfishProfileId: ENV.RAAD_TINYFISH_PROFILE_ID}}});
  assert.equal((await runUploadProbe(h.options)).uploadVerified, true);
});

test('API errors and malformed or oversized JSON stay sanitized and never connect', async () => {
  for (const response of [() => { throw Error('SYNTHETIC_SECRET_KEY https://private.example'); }, () => json({error: 'SYNTHETIC_PROVIDER_PAYLOAD'}, 403), () => new Response('not-json', {headers: {'content-type': 'application/json'}}), () => json({padding: 'x'.repeat(200 * 1024)}), () => json({}, 200, {'content-length': String(200 * 1024 + 1)}), () => json({}, 302)]) {
    let connections = 0;
    const h = harness({request: async () => response(), connect: async () => { connections++; }});
    const result = await runUploadProbe(h.options);
    assert.equal(result.reason, 'SETUP_API_FAILED');
    assert.equal(result.uploadVerified, false);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(connections, 0);
    safeOutput(result);
  }
});

test('known session is cancelled even when response schema or CDP endpoint is rejected', async () => {
  for (const cdp_url of [undefined, 'http://browser.tinyfish.io/cdp', 'ws://browser.tinyfish.io/cdp', 'wss://user:pass@browser.tinyfish.io/cdp', 'wss://127.0.0.1/cdp', 'wss://[::1]/cdp', 'wss://browser.tinyfish.io:8443/cdp', 'wss://tinyfish.io.attacker.example/cdp', 'wss://browser.tinyfish.io/cdp#fragment', 'wss://browser.internal/cdp']) {
    const h = harness();
    h.options.request = async (url, options) => {
      h.requests.push({url, options});
      return url.endsWith('/cancel') ? json({cancelled: true}) : json({session_id: SESSION, cdp_url}, 201);
    };
    const result = await runUploadProbe(h.options);
    assert.equal(result.reason, cdp_url === undefined ? 'SETUP_RESPONSE_INVALID' : 'CDP_URL_REJECTED');
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(h.requests.length, 2);
    assert.equal(h.events.includes('connect'), false);
    safeOutput(result);
  }
});

test('session IDs must fully match and cannot carry trailing newlines into cancellation', async () => {
  const h = harness();
  h.options.request = async (url, options) => { h.requests.push({url, options}); return json({session_id: SESSION + '\n', cdp_url: CDP}, 201); };
  const result = await runUploadProbe(h.options);
  assert.equal(result.reason, 'SETUP_RESPONSE_INVALID');
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.includes('connect'), false);
});

test('browser connection failure still attempts fixed cancellation and hides raw errors', async () => {
  const h = harness({connect: async () => { throw Error('SYNTHETIC_CDP_SECRET ' + CDP); }});
  const result = await runUploadProbe(h.options);
  assert.equal(result.reason, 'BROWSER_CONNECT_FAILED');
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(h.events, ['setup', 'cancel']);
  safeOutput(result);
});

test('a new page that is not blank cannot receive content or files', async () => {
  const h = harness(); h.page.url = () => 'https://example.invalid/existing-account';
  const result = await runUploadProbe(h.options);
  assert.equal(result.reason, 'PROBE_PAGE_NOT_BLANK');
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(h.events.includes('content'), false);
  assert.equal(h.events.includes('upload'), false);
});

test('upload mismatches or failures are not reported as verification and still cancel', async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.input.evaluate = async () => { if (fail) throw Error('SYNTHETIC_UPLOAD_ERROR'); return [{name: 'wrong.png', type: 'image/png', size: 1}]; };
    const result = await runUploadProbe(h.options);
    assert.equal(result.reason, fail ? 'UPLOAD_FAILED' : 'UPLOAD_MISMATCH');
    assert.equal(result.uploadVerified, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(h.events.indexOf('cancel') < h.events.indexOf('disconnect'));
  }
});

test('timeout after setup is bounded and cancellation is attempted before disconnecting late browser connections', async () => {
  let resolveConnection;
  const h = harness({connect: () => new Promise(resolve => { resolveConnection = resolve; }), limits: {workMs: 15, cleanupMs: 15, disconnectMs: 10}});
  const result = await runUploadProbe(h.options);
  assert.equal(result.reason, 'PROBE_TIMEOUT');
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(h.events.includes('newPage'), false);
  resolveConnection(h.browser);
  await new Promise(setImmediate);
  assert.deepEqual(h.events, ['setup', 'cancel', 'disconnect']);
});

test('setup deadline reports unconfirmed cleanup and cancels any late successful response', async () => {
  let resolveSetup; const requests = [];
  const result = await runUploadProbe({env: ENV, limits: {apiMs: 5, workMs: 30, cleanupMs: 15}, request: (url, options) => {
    requests.push({url, options});
    return url.endsWith('/cancel') ? Promise.resolve(json({cancelled: true})) : new Promise(resolve => { resolveSetup = resolve; });
  }, connect: () => { throw Error('must never connect after timeout'); }});
  assert.equal(result.reason, 'PROBE_TIMEOUT');
  assert.equal(result.cleanupConfirmed, false);
  resolveSetup(json({session_id: SESSION, cdp_url: CDP}, 201));
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('/setup-session/cancel'));
});

test('a verified upload is never overall success without explicit successful cancellation', async () => {
  for (const cancelPayload of [{cancelled: false}, {cancelled: true, cleanup_failed: true}, {}]) {
    const h = harness(); const ordinary = h.options.request;
    h.options.request = (url, options) => url.endsWith('/cancel') ? Promise.resolve(json(cancelPayload)) : ordinary(url, options);
    const result = await runUploadProbe(h.options);
    assert.equal(result.uploadVerified, true);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.reason, 'CLEANUP_UNCONFIRMED');
    assert.equal(result.executionConnected, false);
    assert.ok(h.events.includes('disconnect'));
    safeOutput(result);
  }
});
