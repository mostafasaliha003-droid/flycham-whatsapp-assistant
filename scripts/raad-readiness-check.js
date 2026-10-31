#!/usr/bin/env node
'use strict';
// Private, read-only configuration snapshot. Never prints environment values.
// Run only in the intended service's approved shell; no credentials in chat.
const {supervisorWhatsAppRecipient, supervisorSmsRoute, SUPERVISOR_WHATSAPP_NUMBER} = require('../src/visa-supervisor-route');
const {loadSupervisorSmsContract} = require('../src/raad-login-pilot/supervisor-contact-runtime');
const {abuDhabiMission} = require('../src/raad-login-pilot/visa-route-readiness');
const {credentialConfig} = require('../src/raad-login-pilot/env-credentials');
const {otpConfig} = require('../src/raad-login-pilot/mofa-otp-provider');
const {testAdmissionStatus} = require('../src/raad-login-pilot/execution-policy');
const MAIN = 'https://flycham-whatsapp-assistant.onrender.com';
const RAAD = 'https://raad-direct-login-pilot.onrender.com';
const AUTH_PROBE = RAAD + '/internal/raad/jobs';
const MAX_BODY = 512;
const secretPresent = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f]/u.test(value);
const bridgeKey = value => secretPresent(value) && value.length >= 32;
function exactRoot(value, origin) {
  if (typeof value !== 'string') return false;
  try { const u = new URL(value); return u.origin === origin && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}
const configuredBoolean = value => value === 'true' || value === 'false';
function inspectReadiness({env = process.env, role, now = Date.now()} = {}) {
  if (!['main', 'raad'].includes(role) || !Number.isSafeInteger(now)) throw Error('READINESS_ARGUMENTS_INVALID');
  const checks = {
    missionPolicyAbuDhabi: abuDhabiMission() === 'Abu Dhabi',
  };
  const informational = {};
  let required;
  if (role === 'main') {
    Object.assign(checks, {
      bridgeKeyConfigured: bridgeKey(env.RAAD_JOB_BRIDGE_KEY),
      workerUrlIsExistingRaad: exactRoot(env.RAAD_BROWSER_WORKER_URL, RAAD),
      supervisorWhatsAppRecipientValid: Boolean(supervisorWhatsAppRecipient(env)),
      accountantKeyConfigured: bridgeKey(env.RAAD_ACCOUNTANT_KEY),
      whatsappTokenConfigured: secretPresent(env.WHATSAPP_ACCESS_TOKEN),
      whatsappPhoneIdValid: typeof env.WHATSAPP_PHONE_NUMBER_ID === 'string' && /^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID),
      webhookSecretConfigured: secretPresent(env.WHATSAPP_APP_SECRET),
      webhookVerifyTokenConfigured: secretPresent(env.WHATSAPP_VERIFY_TOKEN),
      dryRunExplicit: configuredBoolean(env.DRY_RUN),
      visaEnabledExplicit: configuredBoolean(env.SAUDI_VISA_ENABLED),
      dispatcherEnabledExplicit: configuredBoolean(env.RAAD_VISA_AUTOMATION_ENABLED),
    });
    Object.assign(informational, {
      dryRun: env.DRY_RUN === 'true',
      visaEnabled: env.SAUDI_VISA_ENABLED === 'true',
      dispatcherEnabled: env.RAAD_VISA_AUTOMATION_ENABLED === 'true',
      automationDisabledForTest: env.SAUDI_VISA_ENABLED === 'false' && env.RAAD_VISA_AUTOMATION_ENABLED === 'false',
      workerModeRequiresSeparateRuntimeProof: true,
      contactEvidenceRequiresWorkerContext: true,
    });
    required = Object.keys(checks);
  } else {
    let contract = null, route = null;
    try { contract = loadSupervisorSmsContract(env, now); if (contract) route = supervisorSmsRoute(contract, now); } catch {}
    const credentials = credentialConfig(env), otp = otpConfig(env), isTest = env.RAAD_EXECUTION_MODE === 'non_submitting_test';
    // Share the worker's pure validator; never duplicate or expose its private
    // callback/key selection, and never treat a production fallback as a test.
    const admission = isTest ? testAdmissionStatus(env) : null;
    Object.assign(checks, {
      ...(isTest ? {isolatedTestTransportConfigured: admission.configured} : {
        bridgeKeyConfigured: bridgeKey(env.RAAD_JOB_BRIDGE_KEY),
        mainUrlIsExistingMain: exactRoot(env.RAAD_MAIN_URL || MAIN, MAIN),
      }),
      pilotKeyConfigured: secretPresent(env.RAAD_PILOT_KEY) && env.RAAD_PILOT_KEY.length >= 43,
      // createPilot requires a bare origin, without even a trailing slash.
      pilotOriginIsExistingRaad: env.RAAD_PILOT_ORIGIN === RAAD,
      executionModeExplicitAndValid: ['production', 'non_submitting_test'].includes(env.RAAD_EXECUTION_MODE),
      contactEvidenceFresh: Boolean(contract && route),
      smsAndWhatsAppRolesSeparate: Boolean(route && route.number !== SUPERVISOR_WHATSAPP_NUMBER),
    });
    Object.assign(informational, {
      mainUrlExplicit: typeof env.RAAD_MAIN_URL === 'string' && env.RAAD_MAIN_URL.length > 0,
      nonSubmittingModeConfigured: env.RAAD_EXECUTION_MODE === 'non_submitting_test',
      ...(isTest ? {testAdmissionBlocker: admission.blocker, isolatedMainQueueAndSupervisorUnverified: true} : {}),
      contactEvidenceExpiresWithinOneDay: Boolean(contract && contract.expiresAt - now <= 86400000),
      portalCredentialsConfigured: credentials.configured,
      portalCredentialsIncomplete: credentials.incomplete,
      loginOtpBridgeConfigured: otp.configured,
      loginOtpEnabled: otp.enabled,
      captchaEnabled: env.RAAD_MOFA_CAPTCHA_ENABLED === 'true',
    });
    required = Object.keys(checks);
  }
  return {
    schemaVersion: 1, role, scope: 'configuration_snapshot_only',
    configurationReady: required.every(key => checks[key] === true),
    readyForDeployment: false, checks, informational,
    workerProbe: {attempted: false, authGateAccepted: false, nonSubmittingModeReported: false, result: 'not_requested'},
    limitations: ['NO_END_TO_END_PROOF', 'NO_ISOLATED_QUEUE_PROOF',
      'NO_TEMPLATE_APPROVAL_PROOF', 'NO_PORTAL_FORM_OR_MISSION_OBSERVATION',
      'NO_CREDENTIAL_OR_ACCOUNT_VALIDITY_PROOF', 'NO_COMPREHENSIVE_SECURITY_REVIEW'],
  };
}
async function readBounded(response) {
  const header = response.headers.get('content-length');
  if (header && (!/^\d+$/.test(header) || Number(header) > MAX_BODY)) throw Error('BODY_LIMIT');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error('BODY_TYPE');
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw Error('BODY_UNAVAILABLE');
  const parts = []; let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > MAX_BODY) throw Error('BODY_LIMIT');
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function probeWorkerAuth({env = process.env, fetchImpl = fetch} = {}) {
  // The fixed collection GET is not a list operation: the reviewed handler
  // authenticates, then returns405 before reading a body or touching a job.
  const out = {attempted: false, authGateAccepted: false, nonSubmittingModeReported: false, result: 'configuration_rejected'};
  if (!bridgeKey(env.RAAD_JOB_BRIDGE_KEY) || !exactRoot(env.RAAD_BROWSER_WORKER_URL, RAAD)) return out;
  out.attempted = true;
  try {
    const response = await fetchImpl(AUTH_PROBE, {
      method: 'GET', headers: {Authorization: 'Bearer ' + env.RAAD_JOB_BRIDGE_KEY, Accept: 'application/json'},
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return {...out, result: 'auth_rejected'};
    if (response.status !== 405 || response.redirected === true) return {...out, result: 'unexpected_response'};
    const body = await readBounded(response);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.error !== 'METHOD_NOT_ALLOWED') return {...out, result: 'unexpected_response'};
    const productionShape = Object.keys(body).length === 1;
    const testShape = Object.keys(body).length === 5 && body.executionMode === 'non_submitting_test' && body.nonSubmittingTest === true && body.submissionEnabled === false && body.paymentEnabled === false;
    if (!productionShape && !testShape) return {...out, result: 'unexpected_response'};
    return {...out, authGateAccepted: true, nonSubmittingModeReported: testShape, result: 'source_specific_auth_gate_accepted'};
  } catch { return {...out, result: 'probe_unconfirmed'}; }
}
async function main(args = process.argv.slice(2), env = process.env, {fetchImpl = fetch} = {}) {
  let role = null, probe = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--role' && role === null) role = args[++index];
    else if (args[index] === '--probe-worker' && !probe) probe = true;
    else throw Error('READINESS_ARGUMENTS_INVALID');
  }
  if (!['main', 'raad'].includes(role) || probe && role !== 'main') throw Error('READINESS_ARGUMENTS_INVALID');
  const report = inspectReadiness({env, role});
  if (probe) report.workerProbe = await probeWorkerAuth({env, fetchImpl});
  return {report, exitCode: report.configurationReady && (!probe || report.workerProbe.authGateAccepted) ? 0 : 1};
}
if (require.main === module) {
  main().then(({report, exitCode}) => { console.log(JSON.stringify(report, null, 2)); process.exitCode = exitCode; })
    .catch(() => { console.log(JSON.stringify({scope: 'configuration_snapshot_only', configurationReady: false, readyForDeployment: false, error: 'READINESS_ARGUMENTS_INVALID'})); process.exitCode = 2; });
}
module.exports = {inspectReadiness, probeWorkerAuth, main};
