'use strict';
// Standalone admission component. No listener, env loading, persistence or app import.
const {createHmac, randomInt, timingSafeEqual} = require('node:crypto');
const OWNER = '971507993145';
const SOURCE_TREE = 'b9747bfbf28809cf0c1e470148169b192bd040e3';
const MAX_TTL_MS = 300000;
const OPEN_TEXT = 'START REMAL TEST';
const TEXT = Object.freeze({
  prompt: 'اختبار رعد فقط: رد على هذه الرسالة برمز التجربة المعروض لك بشكل خاص. لا يُقدَّم أي طلب تأشيرة.',
  outcome: 'اكتمل اختبار الربط الصناعي عند حد الإيقاف. لم يُقدَّم طلب تأشيرة ولم تُدفع رسوم.',
});
function fail(code) { throw Object.assign(Error(code), {code}); }
function exactId(value) { return typeof value === 'string' && /^[A-Za-z0-9._=+/-]{8,256}$/.test(value); }
function same(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function testId(value) { return typeof value === 'string' && /^test_[A-Za-z0-9_-]{1,96}$/.test(value); }
function digits(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) - (c <= '٩' ? 0x660 : 0x6f0)));
  return /^[0-9]{6}$/.test(text) ? text : null;
}
function readMessage(raw, signature, config, now) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 16384) fail('WEBHOOK_BODY_INVALID');
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) fail('WEBHOOK_SIGNATURE_INVALID');
  const expected = 'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex');
  if (!same(signature, expected)) fail('WEBHOOK_SIGNATURE_INVALID');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { fail('WEBHOOK_BODY_INVALID'); }
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || body.entry.length !== 1) fail('WEBHOOK_SCOPE_INVALID');
  const entry = body.entry[0], changes = entry.changes;
  if (entry.id !== config.wabaId || !Array.isArray(changes) || changes.length !== 1 || changes[0]?.field !== 'messages') fail('WEBHOOK_SCOPE_INVALID');
  const value = changes[0].value;
  if (value?.messaging_product !== 'whatsapp' || value?.metadata?.phone_number_id !== config.phoneNumberId
      || !Array.isArray(value.messages) || value.messages.length !== 1 || value.statuses !== undefined) fail('WEBHOOK_SCOPE_INVALID');
  const message = value.messages[0];
  if (message?.from !== OWNER || message.type !== 'text' || !exactId(message.id)
      || typeof message.text?.body !== 'string' || message.text.body.length > 200
      || typeof message.timestamp !== 'string' || !/^[0-9]{10,12}$/.test(message.timestamp)) fail('WEBHOOK_MESSAGE_INVALID');
  const at = Number(message.timestamp) * 1000;
  if (!Number.isSafeInteger(at) || at > now + 30000 || at < now - MAX_TTL_MS) fail('WEBHOOK_TIMESTAMP_INVALID');
  return {id: message.id, at, body: message.text.body, context: message.context?.id ?? null};
}
function createOwnerTestBoundary({enabled = false, config: rawConfig = {}, transport, dispatch, now = Date.now,
  generateCode = () => String(randomInt(0, 1000000)).padStart(6, '0')} = {}) {
  const config = Object.freeze({...rawConfig});
  const sendOwnerText = typeof transport?.sendOwnerText === 'function' ? transport.sendOwnerText.bind(transport) : null;
  const execute = typeof dispatch?.execute === 'function' ? dispatch.execute.bind(dispatch) : null;
  // An offline component cannot be promoted to a real gateway by an env flag.
  const configured = enabled === true && config.mode === 'offline_injected'
    && config.sourceTree === SOURCE_TREE && config.owner === OWNER
    && /^[0-9]{5,30}$/.test(config.wabaId || '') && /^[0-9]{5,30}$/.test(config.phoneNumberId || '')
    && typeof config.appSecret === 'string' && config.appSecret.length >= 32 && config.appSecret.length <= 256
    && config.dedicatedTestIdentityVerified === true && config.zeroCostEligibilityVerified === true
    && transport?.kind === 'offline_injected' && typeof transport.sendOwnerText === 'function'
    && dispatch?.kind === 'synthetic_boundary_only' && typeof dispatch.execute === 'function';
  const operatorCapability = Object.freeze({});
  let session = null, queue = Promise.resolve(), ingressAttempts = 0, queued=0;
  const seen = new Set();
  function requireEnabled() { if (!configured) fail('ISOLATED_TEST_DISABLED'); }
  function eraseCode() { if (session?.code) session.code.fill(0); if (session) session.code = null; }
  function clock(s) {
    const at=now();
    if(!Number.isSafeInteger(at)||at<s.createdAt||at>=s.expiresAt){eraseCode();s.stage='expired';fail('TEST_SESSION_EXPIRED');}
    return at;
  }
  function current() {
    requireEnabled();
    if (!session) fail('TEST_SESSION_MISSING');
    clock(session);
    if (session.stage==='cancelled') fail('TEST_SESSION_CANCELLED');
    return session;
  }
  function active(s,generation) { current();if(s!==session||s.generation!==generation)fail('TEST_SESSION_CANCELLED'); }
  function halt(s) { if(!['cancelled','expired'].includes(s.stage))s.stage='halted'; }
  const binding = s => Object.freeze({sessionId:s.sessionId,jobId:s.jobId,applicantId:s.applicantId,challengeId:s.challengeId});
  function snapshot() {
    return Object.freeze({enabled:configured, mode:'offline_admission_component', realMetaImplemented:false,
      actualMainEntrypointIntegrated:false, applicationHandoffImplemented:false, productionReady:false,
      stage:session?.stage || 'not_started', consumed:session?.consumed || false,
      outboundAttempts:session?.outboundAttempts || 0, dispatches:session?.dispatches || 0,
      acceptedInbound:session?.acceptedInbound || 0, ingressAttempts, replayIdsRetained:seen.size,
      implementedCapabilities:Object.freeze({government:false,payment:false,models:false,browser:false}),
      injectedAdapterSideEffectsMeasured:false});
  }
  function start(input) {
    requireEnabled();
    if (session) fail('TEST_SESSION_ALREADY_EXISTS');
    if (!input || Object.keys(input).sort().join(',') !== 'applicantId,challengeId,jobId,sessionId'
        || !Object.values(input).every(testId)) fail('TEST_BINDING_INVALID');
    const code = generateCode();
    if (!digits(code) || digits(code) !== code) fail('TEST_CODE_GENERATOR_INVALID');
    const at = now(); if (!Number.isSafeInteger(at)) fail('TEST_CLOCK_INVALID');
    session = {...input, code:Buffer.from(code), createdAt:at, expiresAt:at+MAX_TTL_MS,
      stage:'awaiting_open', generation:1, consumed:false, outboundAttempts:0, dispatches:0, acceptedInbound:0, promptId:null};
    return Object.freeze({...binding(session), expiresAt:session.expiresAt});
  }
  function privateTestCode(capability) {
    const s = current();
    if (capability !== operatorCapability || !s.code || s.consumed) fail('PRIVATE_OPERATOR_REQUIRED');
    return s.code.toString();
  }
  async function send(s, purpose, generation) {
    active(s,generation);
    if (!Object.hasOwn(TEXT, purpose) || s.outboundAttempts >= 2) fail('TEST_OUTBOUND_LIMIT');
    s.outboundAttempts++; // Reserve before await; unknown outcome is never refunded/retried.
    const result = await sendOwnerText(Object.freeze({owner:OWNER,purpose,text:TEXT[purpose]}));
    if (result?.recipient !== OWNER || !exactId(result.messageId)) fail('PROVIDER_ACCEPTANCE_INVALID');
    return result.messageId;
  }
  async function consume(raw, signature) {
    const s = current(),generation=s.generation;
    const m = readMessage(raw, signature, config, clock(s));
    if (++ingressAttempts > 32) { eraseCode(); s.stage='halted'; fail('TEST_INGRESS_LIMIT'); }
    if (m.at < Math.floor(s.createdAt/1000)*1000) fail('TEST_MESSAGE_PREDATES_SESSION');
    if (seen.has(m.id)) fail('TEST_REPLAY_REJECTED');
    if (seen.size >= 32) fail('TEST_REPLAY_CAPACITY');
    seen.add(m.id);
    if (s.stage === 'awaiting_open') {
      if (m.context !== null || m.body !== OPEN_TEXT) fail('TEST_OPENING_REQUIRED');
      s.acceptedInbound++; s.stage='sending_prompt';
      try {
        const promptId = await send(s, 'prompt',generation);
        active(s,generation); // A slow/uncertain send cannot extend the original deadline.
        s.promptId=promptId; s.stage='awaiting_reply';
        return Object.freeze({accepted:true,phase:'prompt_accepted',...binding(s)});
      } catch { eraseCode(); halt(s); fail('TEST_PROMPT_UNCONFIRMED'); }
    }
    if (s.stage !== 'awaiting_reply' || s.consumed) fail('TEST_CHALLENGE_NOT_ACTIVE');
    if (m.context !== s.promptId) fail('TEST_REPLY_CONTEXT_MISMATCH');
    s.acceptedInbound++; s.consumed=true;
    const code=digits(m.body), valid=code !== null && same(code,s.code);
    eraseCode(); // Consume once before dispatch, including an invalid correlated attempt.
    if (!valid) { s.stage='halted'; fail('TEST_CODE_REJECTED'); }
    s.stage='dispatching'; s.dispatches++;
    try {
      const receipt = await execute(Object.freeze({...binding(s),action:'synthetic_stop',
        capabilities:Object.freeze({government:false,payment:false,models:false,browser:false})}));
      active(s,generation);
      if (receipt?.code !== 'RAAD_TEST_SUBMISSION_BLOCKED'
          || !Object.keys(binding(s)).every(k=>receipt[k]===s[k])) fail('TEST_STOP_UNCONFIRMED');
      await send(s,'outcome',generation); active(s,generation); s.stage='completed';
      return Object.freeze({accepted:true,phase:'synthetic_stop_confirmed',...binding(s),code:receipt.code});
    } catch { halt(s); fail('TEST_HANDOFF_UNCONFIRMED'); }
  }
  function ingest(raw, signature) {
    // Serialization closes concurrent webhook/single-consume races.
    if(!Buffer.isBuffer(raw)||!raw.length||raw.length>16384)return Promise.reject(Object.assign(Error('WEBHOOK_BODY_INVALID'),{code:'WEBHOOK_BODY_INVALID'}));
    if(queued>=32)return Promise.reject(Object.assign(Error('TEST_QUEUE_LIMIT'),{code:'TEST_QUEUE_LIMIT'}));
    queued++;
    const owned=Buffer.isBuffer(raw)?Buffer.from(raw):raw;
    const next=queue.then(()=>consume(owned,signature)).finally(()=>{if(Buffer.isBuffer(owned))owned.fill(0);queued--;});
    queue=next.catch(()=>{});return next;
  }
  function cancel(capability) {
    requireEnabled();if(capability!==operatorCapability)fail('PRIVATE_OPERATOR_REQUIRED');
    eraseCode();if(session){session.generation++;session.stage='cancelled';}return snapshot();
  }
  return Object.freeze({start,ingest,snapshot,cancel,privateTestCode,operatorCapability});
}
module.exports={createOwnerTestBoundary,OWNER,SOURCE_TREE,OPEN_TEXT,TEXT};
