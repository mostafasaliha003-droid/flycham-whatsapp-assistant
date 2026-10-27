'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {inspect} = require('node:util');
const {RaadTinyFishProfile} = require('../src/raad-tinyfish-profile');

const PROFILE = 'prof_synthetic_profile';
const KEY = 'synthetic-secret-key-never-return';
const env = () => ({RAAD_TINYFISH_API_KEY: KEY, RAAD_TINYFISH_PROFILE_ID: PROFILE});
const profile = (overrides = {}) => ({
  id: PROFILE, name: 'Synthetic account label', created_at: '2026-10-27T00:00:00Z',
  domains: [{domain: 'private.synthetic.test', cookie_count: 2, local_storage_origin_count: 1,
    last_accessed_at: '2026-10-27T00:00:00Z', last_written_at: '2026-10-27T00:00:00Z',
    last_written_by_run_id: 'synthetic-private-run'}], ...overrides
});
const json = (body, options = {}) => new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}, ...options});
function safe(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [KEY, PROFILE, 'Synthetic account label', 'private.synthetic.test', 'synthetic-private-run', 'COOKIE_SECRET', 'https://evil.test/?secret=LEAK', 'RAW_ERROR_SECRET']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(value.executionConnected, false);
  assert.equal(value.portalAuthenticationChecked, false);
}

test('missing or invalid configuration never makes a request and status reveals booleans only', async () => {
  for (const config of [{}, {RAAD_TINYFISH_API_KEY: KEY}, {RAAD_TINYFISH_PROFILE_ID: PROFILE},
    {...env(), RAAD_TINYFISH_PROFILE_ID: '../profiles?secret=LEAK'},
    {...env(), RAAD_TINYFISH_PROFILE_ID: 'https://evil.test/?secret=LEAK'},
    {...env(), RAAD_TINYFISH_API_KEY: 'key\r\nInjected: value'}]) {
    let calls = 0;
    const provider = new RaadTinyFishProfile({env: config, fetchImpl: () => { calls++; throw Error('must not call'); }});
    assert.deepEqual(Object.keys(provider.status()), ['configured', 'profileConfigured', 'executionConnected']);
    assert.equal(provider.status().configured, false);
    const result = await provider.check();
    assert.equal(result.reason, 'TINYFISH_NOT_CONFIGURED');
    assert.equal(result.checked, false);
    assert.equal(calls, 0);
    safe(result);
    assert.doesNotMatch(inspect(provider), /synthetic-secret|prof_synthetic/);
  }
});

test('GET is bound to the configured profile at the fixed provider origin with no body or redirects', async () => {
  const calls = [];
  const provider = new RaadTinyFishProfile({env: env(), fetchImpl: async (...args) => { calls.push(args); return json(profile({cookies: 'COOKIE_SECRET', signed_in_sites: []})); }});
  assert.deepEqual(provider.status(), {configured: true, profileConfigured: true, executionConnected: false});
  const result = await provider.check();
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://agent.tinyfish.ai/v1/profiles/' + PROFILE);
  assert.deepEqual(Object.keys(options).sort(), ['headers', 'method', 'redirect', 'signal']);
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, {'X-API-Key': KEY, Accept: 'application/json'});
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.equal(result.providerReachable, true);
  assert.equal(result.profileAvailable, true);
  assert.equal(result.reason, 'TINYFISH_PROFILE_AVAILABLE');
  safe(result);
});

test('private profile fallback is supported, environment profile wins, and an empty profile proves no portal login', async () => {
  for (const config of [
    {env: {RAAD_TINYFISH_API_KEY: KEY}, privateConfig: {tinyfishProfileId: PROFILE}},
    {env: env(), privateConfig: {tinyfishProfileId: 'prof_not_selected'}}
  ]) {
    const provider = new RaadTinyFishProfile({...config, fetchImpl: async url => {
      assert.equal(url, 'https://agent.tinyfish.ai/v1/profiles/' + PROFILE);
      return json(profile({domains: [], signed_in_sites: []}));
    }});
    const result = await provider.check();
    assert.equal(result.profileAvailable, true);
    assert.equal(result.portalAuthenticationChecked, false);
    safe(result);
  }
});

test('profile identity and documented bare-object required fields fail closed', async () => {
  const invalid = [profile({id: 'prof_other'}), {data: profile()}, [], null, profile({domains: null}),
    profile({created_at: null}), profile({name: 4}), profile({domains: [{domain: 'private.synthetic.test'}]}),
    profile({domains: [{...profile().domains[0], cookie_count: -1}]}),
    profile({domains: [{...profile().domains[0], last_written_by_run_id: null}]})];
  for (const body of invalid) {
    const result = await new RaadTinyFishProfile({env: env(), fetchImpl: async () => json(body)}).check();
    assert.equal(result.reason, 'TINYFISH_PROFILE_RESPONSE_INVALID');
    assert.equal(result.profileAvailable, false);
    assert.equal(result.providerReachable, true);
    safe(result);
  }
});

test('malformed and non-JSON provider responses do not leak raw payloads', async () => {
  for (const response of [new Response('RAW_ERROR_SECRET', {headers: {'Content-Type': 'application/json'}}),
    new Response('RAW_ERROR_SECRET', {headers: {'Content-Type': 'text/html'}})]) {
    const result = await new RaadTinyFishProfile({env: env(), fetchImpl: async () => response}).check();
    assert.equal(result.reason, 'TINYFISH_RESPONSE_INVALID');
    assert.equal(result.ok, false);
    safe(result);
  }
});

test('HTTP failures are sanitized without reading provider error bodies', async () => {
  const statuses = {401: 'TINYFISH_CREDENTIAL_REJECTED', 403: 'TINYFISH_ACCESS_DENIED',
    404: 'TINYFISH_PROFILE_UNAVAILABLE', 429: 'TINYFISH_RATE_LIMITED',
    500: 'TINYFISH_PROVIDER_UNAVAILABLE', 503: 'TINYFISH_PROVIDER_UNAVAILABLE',
    302: 'TINYFISH_REDIRECT_REJECTED', 400: 'TINYFISH_PROVIDER_REJECTED'};
  for (const [status, reason] of Object.entries(statuses)) {
    const result = await new RaadTinyFishProfile({env: env(), fetchImpl: async () => ({status: Number(status),
      get body() { throw Error('RAW_ERROR_SECRET'); }, get headers() { throw Error('RAW_ERROR_SECRET'); }})}).check();
    assert.equal(result.reason, reason);
    assert.equal(result.providerReachable, true);
    assert.equal(result.profileAvailable, false);
    safe(result);
  }
});

test('network failures and redirect rejections never expose exception messages or request URLs', async () => {
  const provider = new RaadTinyFishProfile({env: env(), fetchImpl: async () => { throw Error(KEY + PROFILE + ' https://evil.test/?secret=LEAK RAW_ERROR_SECRET'); }});
  const result = await provider.check();
  assert.equal(result.reason, 'TINYFISH_NETWORK_ERROR');
  assert.equal(result.providerReachable, false);
  safe(result);
});

test('declared body cap rejects before reading and actual streamed bytes are independently capped', async () => {
  let read = false;
  const declared = await new RaadTinyFishProfile({env: env(), fetchImpl: async () => ({status: 200,
    headers: new Headers({'Content-Length': String(200 * 1024 + 1), 'Content-Type': 'application/json'}),
    get body() { read = true; throw Error('RAW_ERROR_SECRET'); }})}).check();
  assert.equal(declared.reason, 'TINYFISH_RESPONSE_TOO_LARGE');
  assert.equal(read, false);
  safe(declared);
  let cancelled = false;
  const streamed = await new RaadTinyFishProfile({env: env(), fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(102401)); },
    cancel() { cancelled = true; }
  }), {headers: {'Content-Type': 'application/json', 'Content-Length': '1'}})}).check();
  assert.equal(streamed.reason, 'TINYFISH_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true);
  safe(streamed);
});

test('15-second deadline aborts an unresponsive fetch and returns a safe timeout', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let signal;
  const provider = new RaadTinyFishProfile({env: env(), fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }});
  const pending = provider.check();
  context.mock.timers.tick(15000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.reason, 'TINYFISH_TIMEOUT');
  safe(result);
});

test('the same deadline bounds a stalled response body after the provider responds', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let reading = false, cancelled = false;
  const provider = new RaadTinyFishProfile({env: env(), fetchImpl: async () => new Response(new ReadableStream({
    pull() { reading = true; return new Promise(() => {}); },
    cancel() { cancelled = true; }
  }), {headers: {'Content-Type': 'application/json'}})});
  const pending = provider.check();
  for (let turn = 0; turn < 8 && !reading; turn++) await Promise.resolve();
  assert.equal(reading, true);
  context.mock.timers.tick(15000);
  const result = await pending;
  assert.equal(result.reason, 'TINYFISH_TIMEOUT');
  assert.equal(result.providerReachable, true);
  assert.equal(result.profileAvailable, false);
  assert.equal(cancelled, true);
  safe(result);
});

test('provider check does not log credentials or response metadata', async context => {
  const entries = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) context.mock.method(console, method, (...args) => entries.push(args));
  const provider = new RaadTinyFishProfile({env: env(), fetchImpl: async () => json(profile({cookies: 'COOKIE_SECRET'}))});
  safe(await provider.check());
  assert.deepEqual(entries, []);
});
