'use strict';

const crypto = require('node:crypto');

function verifyWebhookChallenge(query, verifyToken) {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');
  if (mode === 'subscribe' && token && verifyToken && token === verifyToken && challenge) {
    return challenge;
  }
  return null;
}

function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const supplied = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function extractIncomingMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value ?? {};
      const contacts = value.contacts ?? [];
      for (const message of value.messages ?? []) {
        if(!message?.from)continue;
        let text,requestChoice;
        if(message.type==='text'&&typeof message.text?.body==='string')text=message.text.body.trim();
        else if(message.type==='interactive'&&message.interactive?.type==='button_reply'){
          const buttonId=message.interactive.button_reply?.id;
          const choice=typeof buttonId==='string'?buttonId.match(/^request_(continue|new):([a-f0-9-]{36})$/):null;
          if(!choice)continue;
          requestChoice={id:choice[2],action:choice[1]};
          text=choice[1]==='continue'?'متابعة طلبي الحالي':'طلب جديد مختلف';
        }else continue;
        const contact = contacts.find((item) => item?.wa_id === message.from);
        messages.push({
          id: message.id ?? null,
          ...(message.context?.id?{contextId:message.context.id}:{}),
          from: message.from,
          name: contact?.profile?.name ?? null,
          text,
          ...(requestChoice?{requestChoice}:{}),
          timestamp: message.timestamp ?? null
        });
      }
    }
  }
  return messages;
}

module.exports = { verifyWebhookChallenge, verifySignature, extractIncomingMessages };
