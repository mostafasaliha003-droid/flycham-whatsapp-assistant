'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhookChallenge, verifySignature, extractIncomingMessages } = require('../src/whatsapp');

test('accepts only matching WhatsApp webhook verification token', () => {
  assert.equal(verifyWebhookChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=secret&hub.challenge=abc'), 'secret'), 'abc');
  assert.equal(verifyWebhookChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc'), 'secret'), null);
});

test('validates Meta HMAC signature against exact raw bytes', () => {
  const body = Buffer.from('{"hello":"world"}');
  const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, 'app-secret'), true);
  assert.equal(verifySignature(Buffer.from('{"hello":"tampered"}'), signature, 'app-secret'), false);
  assert.equal(verifySignature(body, signature, ''), false);
});

test('extracts text messages and ignores status updates and non-text messages', () => {
  const payload = { entry: [{ changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: '971500000000', profile: { name: 'Test' } }],
    messages: [
      { id: 'm1', from: '971500000000', type: 'text', text: { body: 'من دبي إلى دمشق' } },
      { id: 'm2', from: '971500000000', type: 'image' }
    ]
  } }, { field: 'statuses', value: { messages: [{ from: 'x', type: 'text', text: { body: 'ignore' } }] } }] }] };
  assert.deepEqual(extractIncomingMessages(payload), [{ id: 'm1', from: '971500000000', name: 'Test', text: 'من دبي إلى دمشق', timestamp: null }]);
});
