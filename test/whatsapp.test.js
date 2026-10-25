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

const choiceId='12345678-1234-4321-abcd-123456789abc';
const webhook=messages=>({entry:[{changes:[{field:'messages',value:{contacts:[{wa_id:'971500000001',profile:{name:'Synthetic Customer'}}],messages}}]}]});
const choiceMessage=(id,action,extra={})=>({id,from:'971500000001',type:'interactive',timestamp:'1792886400',context:{id:'original-menu-message'},interactive:{type:'button_reply',button_reply:{id:'request_'+action+':'+choiceId,title:'UNTRUSTED_INBOUND_TITLE'}},...extra});
test('request buttons extract canonical safe text and nonce/action while keeping sender, context, name and time',()=>{
 assert.deepEqual(extractIncomingMessages(webhook([choiceMessage('continue-message','continue'),choiceMessage('new-message','new')])),[
  {id:'continue-message',contextId:'original-menu-message',from:'971500000001',name:'Synthetic Customer',text:'متابعة طلبي الحالي',requestChoice:{id:choiceId,action:'continue'},timestamp:'1792886400'},
  {id:'new-message',contextId:'original-menu-message',from:'971500000001',name:'Synthetic Customer',text:'طلب جديد مختلف',requestChoice:{id:choiceId,action:'new'},timestamp:'1792886400'}
 ]);
});
test('unknown or malformed interactive replies are ignored rather than converted into customer instructions',()=>{
 const invalid=['other_button:'+choiceId,'request_continue:'+choiceId+'suffix','prefixrequest_new:'+choiceId,'request_reset:'+choiceId,'request_new:','request_new:'+choiceId.toUpperCase(),'request_new:'+'a'.repeat(35),42,null];
 const messages=invalid.map((id,i)=>choiceMessage('invalid-'+i,'new',{interactive:{type:'button_reply',button_reply:{id,title:'بدي ثبت'}}}));
 messages.push(choiceMessage('unsupported-list','new',{interactive:{type:'list_reply',list_reply:{id:'request_new:'+choiceId}}}),choiceMessage('missing-button','new',{interactive:{type:'button_reply'}}),choiceMessage('missing-sender','new',{from:''}));
 assert.deepEqual(extractIncomingMessages(webhook(messages)),[]);
});
test('ordinary text is not treated as a trusted request-button event',()=>{
 const messages=extractIncomingMessages(webhook([{id:'text-choice',from:'971500000001',type:'text',text:{body:'  طلب جديد مختلف  '},requestChoice:{id:choiceId,action:'new'}}]));
 assert.equal(messages.length,1);assert.equal(messages[0].text,'طلب جديد مختلف');assert.equal(messages[0].requestChoice,undefined);assert.equal(messages[0].contextId,undefined);
});
