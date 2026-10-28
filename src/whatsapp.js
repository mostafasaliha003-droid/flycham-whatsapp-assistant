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
        let text,requestChoice,serviceChoice,visaAnswer,visaConfirmation,media;
        if(message.type==='text'&&typeof message.text?.body==='string')text=message.text.body.trim();
        else if(message.type==='interactive'&&['button_reply','list_reply'].includes(message.interactive?.type)){
          const isButton=message.interactive.type==='button_reply';
          const buttonId=message.interactive[message.interactive.type]?.id;
          const choice=isButton&&typeof buttonId==='string'?buttonId.match(/^request_(continue|new):([a-f0-9-]{36})$/):null;
          const service=isButton&&typeof buttonId==='string'?buttonId.match(/^service_(flight|saudi_visa):([a-f0-9-]{36})$/):null;
          const answer=typeof buttonId==='string'?buttonId.match(/^visa_answer:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([a-z][a-z0-9_]{0,39})$/):null;
          const confirmation=isButton&&typeof buttonId==='string'?buttonId.match(/^visa_confirm:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):(confirm|correct)$/):null;
          if(service){serviceChoice={id:service[2],service:service[1]};text=service[1]==='flight'?'طيران إلى سوريا':'فيزا السعودية';}
          else if(choice){requestChoice={id:choice[2],action:choice[1]};text=choice[1]==='continue'?'متابعة طلبي الحالي':'طلب جديد مختلف';}
          else if(answer){visaAnswer={token:answer[1],option:answer[2]};text='[إجابة بيانات التأشيرة]';}
          else if(confirmation){visaConfirmation={token:confirmation[1],confirm:confirmation[2]==='confirm'};text=confirmation[2]==='confirm'?'أؤكد صحة إجابات التأشيرة':'أريد تصحيح إجابات التأشيرة';}
          else continue;
        }else if(['image','document','audio'].includes(message.type)){
          const item=message[message.type];
          if(!item||typeof item.id!=='string'||!/^\d{1,100}$/.test(item.id))continue;
          media={id:item.id,type:message.type,mimeType:typeof item.mime_type==='string'?item.mime_type.slice(0,120):null};
          if(message.type==='document'&&typeof item.filename==='string')media.filename=item.filename.replace(/[\x00-\x1f\x7f]/g,'').slice(0,180);
          text=typeof item.caption==='string'&&item.caption.trim()?item.caption.trim().slice(0,4096):message.type==='audio'?'[مرفق صوتي يحتاج تفريغاً]':message.type==='document'?'[مستند مرفق يحتاج مراجعة]':'[صورة مرفقة تحتاج مراجعة]';
        }else continue;
        const contact = contacts.find((item) => item?.wa_id === message.from);
        messages.push({
          id: message.id ?? null,
          ...(message.context?.id?{contextId:message.context.id}:{}),
          from: message.from,
          name: contact?.profile?.name ?? null,
          text,
          ...(requestChoice?{requestChoice}:{}),
          ...(serviceChoice?{serviceChoice}:{}),
          ...(visaAnswer?{visaAnswer}:{}),
          ...(visaConfirmation?{visaConfirmation}:{}),
          ...(media?{media}:{}),
          timestamp: message.timestamp ?? null
        });
      }
    }
  }
  return messages;
}

module.exports = { verifyWebhookChallenge, verifySignature, extractIncomingMessages };

