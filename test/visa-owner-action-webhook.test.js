'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHmac} = require('node:crypto');
const vm = require('node:vm');
const {extractIncomingMessages, verifySignature} = require('../src/whatsapp');
const {ConversationJournal} = require('../src/conversation-journal');
const OWNER = '15550009001', OTHER = '15550009002';
const CHALLENGE = '12345678-1234-4321-abcd-123456789abc';
const SECRET = 'synthetic-owner-action-webhook-secret';
const source = readFileSync(require.resolve('../src/server'), 'utf8');
const handler = source.slice(source.indexOf('async function handleWebhookPost('), source.indexOf('\nfunction customerSearchActive'));

function fixture({ok = true, operator = false} = {}) {
  const events = [], codes = [], sends = [], accepted = new Set();
  const store = {data: {}, save() {}};
  const journal = new ConversationJournal({store});
  const originalRecord = journal.recordInbound.bind(journal);
  journal.recordInbound = (sender, input) => { events.push('journal'); return originalRecord(sender, input); };
  const context = vm.createContext({
    process: {env: {NODE_ENV: 'production', WHATSAPP_APP_SECRET: SECRET}}, Buffer,
    readBody: async request => request.body, verifySignature, extractIncomingMessages,
    recordDeliveryStatuses() {}, journal, complaints: {handleReceipt() {}}, assistant: {store},
    quoteJobs: {acceptMessage(id) { if (accepted.has(id)) return false; accepted.add(id); return true; }, save() {}},
    noteIncoming() { events.push('incoming'); },
    visaOperatorNotices:{handles:message=>operator&&Boolean(message.visaOperatorAction),async receive(message){assert.equal(message.from,OWNER);assert.equal(message.contextId,'accepted-task-notice');assert.equal(message.visaOperatorAction.noticeId,CHALLENGE);assert.equal(journal.get(OWNER).messages.at(-1).text,'[متابعة إشعار التحقق المرئي]');events.push('operator-notice');return{ok:true};}},
    visaFulfilment: {
      recordDelivery() {}, otpOwner: () => OWNER,
      openOwnerAction(input) {
        assert.equal(journal.summary(input.sender).serviceWindowOpen, true, 'only an actual inbound opens the window before the prompt is queued');
        events.push('owner-action');
        assert.equal(input.sender, OWNER); assert.equal(input.challengeId, CHALLENGE); assert.equal(input.contextId, 'accepted-task-notice');
        return {handled: true, ok, requeued: ok ? 1 : 0};
      },
      isOtpMessage(input) { events.push('otp-check'); return /^\d{6}$/.test(input.text); },
      async consumeOtp(input) { assert.equal(journal.get(input.sender).messages.at(-1).text, '[رمز تحقق محجوب]'); codes.push(input); return {handled: true, ok: true}; },
      requeuePausedMessages() { assert.fail('owner action must not reach generic customer routing'); }
    },
    async rawSendTextMessage(to, text) { sends.push({to, text}); },
    wakeVisa() { events.push('wake'); }
  });
  vm.runInContext(handler + '\nthis.runWebhook=handleWebhookPost;', context);
  async function inbound(message, signature = true) {
    const body = Buffer.from(JSON.stringify({entry: [{changes: [{field: 'messages', value: {messages: [message]}}]}]}));
    let status;
    await context.runWebhook({body, headers: {'x-hub-signature-256': signature ? 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex') : 'sha256=' + '0'.repeat(64)}}, {writeHead(value) { status = value; return this; }, end() {}});
    return status;
  }
  const action = (id = 'synthetic-owner-action') => ({id, from: OWNER, timestamp: String(Math.floor(Date.now() / 1000)), context: {id: 'accepted-task-notice'}, type: 'button', button: {payload: 'visa_owner_action:' + CHALLENGE, text: 'متابعة المهمة'}});
  return {inbound, action, events, codes, sends, journal};
}

test('signed template quick reply opens window and reaches only the bound owner action, once', async () => {
  const f = fixture();
  assert.equal(await f.inbound(f.action()), 200);
  assert.deepEqual(f.events, ['incoming', 'journal', 'owner-action', 'wake']);
  assert.equal(f.journal.get(OWNER).messages[0].text, '[متابعة إجراء التأشيرة]');
  await f.inbound(f.action());
  assert.equal(f.events.filter(event => event === 'owner-action').length, 1);
  assert.equal(f.sends.length, 0); assert.equal(f.codes.length, 0);
});

test('invalid signatures and unknown template buttons cannot open the owner workflow', async () => {
  const f = fixture();
  assert.equal(await f.inbound(f.action(), false), 401); assert.equal(f.events.length, 0);
  const arbitrary = {...f.action('unrelated-template'), from: OTHER, button: {payload: 'unrelated-action', text: 'arbitrary'}};
  assert.equal(await f.inbound(arbitrary), 200); assert.equal(f.events.length, 0);
});

test('expired owner action gives bounded feedback without entering the OTP or customer model paths', async () => {
  const f = fixture({ok: false});
  assert.equal(await f.inbound(f.action()), 200);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].to, OWNER);
  assert.match(f.sends[0].text, /انتهت صلاحيته/); assert.equal(f.codes.length, 0);
  assert.equal(f.events.includes('otp-check'), false);
});

test('subsequent OTP reaches only the ephemeral consumer and is redacted before journaling', async () => {
  const f = fixture();
  await f.inbound(f.action());
  await f.inbound({id: 'synthetic-code', from: OWNER, type: 'text', text: {body: '418073'}, context: {id: 'actual-otp-prompt'}});
  assert.equal(f.codes.length, 1); assert.equal(f.codes[0].contextId, 'actual-otp-prompt'); assert.equal(f.codes[0].text, '418073');
  assert.equal(JSON.stringify(f.journal.data).includes('418073'), false);
});

test('visual-verification notice reply is signed, redacted and isolated from OTP and customer routing',async()=>{const f=fixture({operator:true}),message={...f.action('operator-action'),button:{payload:'visa_operator_action:'+CHALLENGE,text:'UNTRUSTED'}};assert.equal(await f.inbound(message),200);assert.deepEqual(f.events,['incoming','journal','operator-notice']);assert.equal(f.codes.length,0);assert.equal(f.sends.length,0);await f.inbound(message);assert.equal(f.events.filter(e=>e==='operator-notice').length,1);});
