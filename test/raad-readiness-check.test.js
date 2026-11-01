'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {inspectReadiness, probeWorkerAuth, main} = require('../scripts/raad-readiness-check');
const {createProductionWorker} = require('../src/raad-login-pilot/production-worker');
const {SUPERVISOR_WHATSAPP_NUMBER} = require('../src/visa-supervisor-route');
const NOW = Date.parse('2026-10-31T10:00:00Z');
const KEY = 'synthetic-bridge-key-0000000000000000000000000000';
const TEST_KEY = 'synthetic-test-bridge-key-000000000000000000000000';
const mainEnv = () => ({RAAD_BROWSER_WORKER_URL: 'https://raad-direct-login-pilot.onrender.com',
  RAAD_JOB_BRIDGE_KEY: KEY, RAAD_OTP_OWNER_WHATSAPP: SUPERVISOR_WHATSAPP_NUMBER,
  RAAD_ACCOUNTANT_KEY: 'synthetic-accountant-key-000000000000000000000000',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_APP_SECRET: 'synthetic-webhook-secret', WHATSAPP_VERIFY_TOKEN: 'synthetic-verify-token',
  DRY_RUN: 'true', SAUDI_VISA_ENABLED: 'false', RAAD_VISA_AUTOMATION_ENABLED: 'false'});
const raadEnv = () => ({RAAD_TEST_MAIN_URL: 'http://127.0.0.1:33449/', RAAD_TEST_JOB_BRIDGE_KEY: TEST_KEY,
  RAAD_JOB_BRIDGE_KEY: KEY, RAAD_PILOT_KEY: 'synthetic-pilot-key-00000000000000000000000000000000',
  RAAD_PILOT_ORIGIN: 'https://raad-direct-login-pilot.onrender.com',
  RAAD_EXECUTION_MODE: 'non_submitting_test', RAAD_SUPERVISOR_SMS_CONTACT_PROFILE: 'office-saudi-2026-10-30'});
const response = (status, value, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value),
  {status, headers: {'content-type': 'application/json', ...headers}});
function sourceHandlerFetch(worker, calls) {
  return async (url, options) => {
    calls.push({url, options});
    let status, body, headers;
    const res = {writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; }};
    const handled = await worker.handler({method: options.method, headers: {authorization: options.headers.Authorization}}, res,
      new URL(url), {readBody() { throw Error('BODY_READ_FORBIDDEN'); }});
    assert.equal(handled, true);
    return new Response(body, {status, headers});
  };
}
test('main default snapshot does not call a provider or disclose environment values', async () => {
  const env = mainEnv(), calls = [];
  const {report, exitCode} = await main(['--role', 'main'], env, {fetchImpl: (...args) => calls.push(args)});
  assert.equal(exitCode, 0); assert.equal(report.configurationReady, true); assert.equal(report.readyForDeployment, false);
  assert.equal(report.workerProbe.attempted, false); assert.equal(calls.length, 0);
  const raw = JSON.stringify(report);
  for (const key of ['RAAD_JOB_BRIDGE_KEY', 'RAAD_ACCOUNTANT_KEY', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) assert.equal(raw.includes(env[key]), false);
  assert.equal(raw.includes(SUPERVISOR_WHATSAPP_NUMBER), false);
});
test('missing and conflicting settings fail closed while preserving fixed output classifications', () => {
  const env = mainEnv(); env.RAAD_OTP_OWNER_RECIPIENT = 'invalid-secret-like-value'; env.RAAD_BROWSER_WORKER_URL = 'https://attacker.invalid';
  const report = inspectReadiness({env, role: 'main', now: NOW});
  assert.equal(report.configurationReady, false); assert.equal(report.checks.supervisorWhatsAppRecipientValid, false);
  assert.equal(report.checks.workerUrlIsExistingRaad, false); assert.equal(JSON.stringify(report).includes('attacker'), false);
  assert.equal(inspectReadiness({env: {}, role: 'main', now: NOW}).configurationReady, false);
});
test('worker snapshot verifies actual pinned contact profile freshness and separate roles without identifiers', () => {
  const report = inspectReadiness({env: raadEnv(), role: 'raad', now: NOW});
  assert.equal(report.configurationReady, true); assert.equal(report.checks.contactEvidenceFresh, true);
  assert.equal(report.checks.smsAndWhatsAppRolesSeparate, true); assert.equal(report.checks.missionPolicyAbuDhabi, true);
  assert.equal(report.informational.nonSubmittingModeConfigured, true);
  assert.equal(report.checks.isolatedTestTransportConfigured, true);
  assert.equal(report.informational.isolatedMainQueueAndSupervisorUnverified, true);
  assert.equal(JSON.stringify(report).includes(SUPERVISOR_WHATSAPP_NUMBER), false);
  assert.equal(inspectReadiness({env: raadEnv(), role: 'raad', now: Date.parse('2026-11-07T00:00:00Z')}).configurationReady, false);
});
test('test transport fails closed for missing settings, production callback, key fallback or equal carried keys', () => {
  const invalid = [
    {RAAD_TEST_MAIN_URL: undefined}, {RAAD_TEST_JOB_BRIDGE_KEY: undefined},
    {RAAD_TEST_MAIN_URL: 'https://flycham-whatsapp-assistant.onrender.com', RAAD_TEST_APPROVED_MAIN_ORIGIN: 'https://flycham-whatsapp-assistant.onrender.com'},
    {RAAD_MAIN_URL: 'https://flycham-whatsapp-assistant.onrender.com'},
    {RAAD_TEST_JOB_BRIDGE_KEY: KEY}, {RAAD_TEST_MAIN_URL: 'http://localhost:33449/'},
    {RAAD_TEST_MAIN_URL: 'https://stage.example.invalid/'},
    {RAAD_TEST_MAIN_URL: 'https://stage.example.invalid/', RAAD_TEST_APPROVED_MAIN_ORIGIN: 'https://different.example.invalid'},
  ];
  for (const patch of invalid) {
    const report = inspectReadiness({env: {...raadEnv(), ...patch}, role: 'raad', now: NOW});
    assert.equal(report.configurationReady, false); assert.equal(report.checks.isolatedTestTransportConfigured, false);
    assert.equal(report.informational.testAdmissionBlocker, 'RAAD_TEST_ISOLATED_MAIN_REQUIRED');
    assert.equal(JSON.stringify(report).includes(TEST_KEY), false);
  }
});
test('explicit approved HTTPS test transport is configuration only and never E2E or deployment proof', () => {
  const env = {...raadEnv(), RAAD_TEST_MAIN_URL: 'https://stage.example.invalid/', RAAD_TEST_APPROVED_MAIN_ORIGIN: 'https://stage.example.invalid'};
  const report = inspectReadiness({env, role: 'raad', now: NOW});
  assert.equal(report.configurationReady, true); assert.equal(report.informational.testAdmissionBlocker, null);
  assert.equal(report.readyForDeployment, false); assert.equal(report.informational.isolatedMainQueueAndSupervisorUnverified, true);
  assert.equal(JSON.stringify(report).includes('stage.example.invalid'), false);
});
test('invalid/unset execution mode never becomes an explicitly configured test mode', () => {
  for (const value of [undefined, '', 'test', 'NON_SUBMITTING_TEST']) {
    const env = raadEnv(); env.RAAD_EXECUTION_MODE = value;
    const report = inspectReadiness({env, role: 'raad', now: NOW});
    assert.equal(report.configurationReady, false); assert.equal(report.informational.nonSubmittingModeConfigured, false);
  }
  const env = raadEnv(); env.RAAD_EXECUTION_MODE = 'production';
  assert.equal(inspectReadiness({env, role: 'raad', now: NOW}).informational.nonSubmittingModeConfigured, false);
  env.RAAD_PILOT_ORIGIN += '/';
  assert.equal(inspectReadiness({env, role: 'raad', now: NOW}).checks.pilotOriginIsExistingRaad, false);
});
test('one optional fixed GET reaches actual auth gate but never touches a job or mutation', async () => {
  const calls = [], worker = createProductionWorker({env: raadEnv(), adapter: {
    reserve() { throw Error('MUTATION_FORBIDDEN'); }, call() { throw Error('MUTATION_FORBIDDEN'); }},
    leaseFetch() { throw Error('NETWORK_FORBIDDEN'); }});
  const out = await probeWorkerAuth({env: {...mainEnv(), RAAD_JOB_BRIDGE_KEY: TEST_KEY}, fetchImpl: sourceHandlerFetch(worker, calls)});
  assert.equal(out.authGateAccepted, true); assert.equal(out.result, 'source_specific_auth_gate_accepted');
  assert.equal(out.nonSubmittingModeReported, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://raad-direct-login-pilot.onrender.com/internal/raad/jobs');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined); assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(worker.health().activeJob, false);
});
test('production source auth response is accepted without claiming non-submitting mode', async () => {
  const env = raadEnv(); env.RAAD_EXECUTION_MODE = 'production';
  const worker = createProductionWorker({env, adapter: {reserve() { throw Error('MUTATION'); }, call() { throw Error('MUTATION'); }}});
  const out = await probeWorkerAuth({env: mainEnv(), fetchImpl: sourceHandlerFetch(worker, [])});
  assert.equal(out.authGateAccepted, true); assert.equal(out.nonSubmittingModeReported, false);
});
test('test-mode response must report exactly every false mutation flag and no extra fields', async () => {
  const base = {error: 'METHOD_NOT_ALLOWED', executionMode: 'non_submitting_test', nonSubmittingTest: true, submissionEnabled: false, paymentEnabled: false};
  for (const body of [{...base, paymentEnabled: true}, {...base, submissionEnabled: true}, {...base, executionMode: 'production'}, {...base, diagnostic: KEY}]) {
    const out = await probeWorkerAuth({env: mainEnv(), fetchImpl: async () => response(405, body)});
    assert.equal(out.authGateAccepted, false); assert.equal(out.nonSubmittingModeReported, false);
  }
});
test('different key is rejected by actual source handler without leaking it', async () => {
  const worker = createProductionWorker({env: raadEnv(), adapter: {reserve() {}, call() {}}});
  const env = mainEnv(); env.RAAD_JOB_BRIDGE_KEY = 'different-synthetic-key-00000000000000000000000';
  const calls = [], out = await probeWorkerAuth({env, fetchImpl: sourceHandlerFetch(worker, calls)});
  assert.equal(out.result, 'auth_rejected'); assert.equal(out.authGateAccepted, false); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(out).includes(env.RAAD_JOB_BRIDGE_KEY), false);
});
test('untrusted endpoint/key configurations perform zero requests', async () => {
  for (const patch of [{RAAD_BROWSER_WORKER_URL: 'https://attacker.invalid'}, {RAAD_BROWSER_WORKER_URL: 'https://raad-direct-login-pilot.onrender.com/?action=save'},
    {RAAD_BROWSER_WORKER_URL: 'https://x:y@raad-direct-login-pilot.onrender.com'}, {RAAD_BROWSER_WORKER_URL: 'http://raad-direct-login-pilot.onrender.com'},
    {RAAD_JOB_BRIDGE_KEY: KEY+'\nprivate'}, {RAAD_JOB_BRIDGE_KEY: 'short'}]) {
    let calls = 0;
    const out = await probeWorkerAuth({env: {...mainEnv(), ...patch}, fetchImpl() { calls++; throw Error(); }});
    assert.equal(calls, 0); assert.equal(out.attempted, false); assert.equal(out.authGateAccepted, false);
  }
});
test('unexpected success, redirect, malformed, extra fields, or large response never prove authorization', async () => {
  for (const fetchImpl of [
    async () => response(200, {ready: true}), async () => response(302, {error: 'METHOD_NOT_ALLOWED'}),
    async () => response(405, 'not-json'), async () => response(405, {error: 'METHOD_NOT_ALLOWED', secret: KEY}),
    async () => response(405, 'x'.repeat(513)), async () => response(405, {error: 'METHOD_NOT_ALLOWED'}, {'content-length': '513'}),
    async () => response(405, {error: 'METHOD_NOT_ALLOWED'}, {'content-type': 'text/plain'}),
  ]) {
    const out = await probeWorkerAuth({env: mainEnv(), fetchImpl});
    assert.equal(out.authGateAccepted, false); assert.equal(JSON.stringify(out).includes(KEY), false);
  }
});
test('transport rejection and abort expose only fixed classification and no credentials', async () => {
  for (const name of ['Error', 'AbortError', 'TimeoutError']) {
    const out = await probeWorkerAuth({env: mainEnv(), fetchImpl() { throw Object.assign(Error(KEY), {name}); }});
    assert.equal(out.result, 'probe_unconfirmed'); assert.equal(out.authGateAccepted, false);
    assert.equal(JSON.stringify(out).includes(KEY), false);
  }
});
test('CLI accepts only explicit roles and optional main probe without echoing unknown input', async () => {
  for (const args of [[], ['--role', 'raad', '--probe-worker'], ['--role', 'main', '--url', KEY], ['--role', 'main', '--role', 'raad']]) await assert.rejects(main(args, {}), /^Error: READINESS_ARGUMENTS_INVALID$/);
  assert.equal((await main(['--role', 'main'], {})).exitCode, 1);
});
