'use strict';

// Experimental ingress guard only. Not wired to the webhook, Graph API or any
// message sender. Call before journal, batching, AI, or webhook acknowledgement.
// The caller owns durable encrypted session storage and an atomic answer+dedupe
// transaction. Never log the input message, text, choice labels or return data.
const {postPaymentQuestion} = require('./raad-post-payment-questionnaire');
const {createHash} = require('node:crypto');

const TOKEN = /^[a-f0-9]{32}$/;
const MESSAGE_ID = /^[^\x00-\x20\x7f]{1,500}$/;
const CUSTOMER = /^[1-9]\d{7,14}$/;
const safeId = value => typeof value === 'string' && MESSAGE_ID.test(value);

function classify(message, session, visaCase, draft, now = Date.now()) {
  if (!session) return {action:'pass'};
  // An active or invalid/expired session is privacy-sensitive. Every inbound
  // type from its owner is quarantined until an operator resolves the session.
  const hidden = {action:'quarantine'};
  if (!message || typeof message !== 'object' ||
      typeof message.from !== 'string' || !CUSTOMER.test(message.from) ||
      message.from !== session.customer || !safeId(message.id)) return hidden;
  if (!Number.isFinite(now) || session.state !== 'awaiting_reply' ||
      !Number.isFinite(session.expiresAt) || now >= session.expiresAt ||
      !TOKEN.test(session.token || '') || !safeId(session.questionMessageId) ||
      message.context?.id !== session.questionMessageId ||
      !Number.isSafeInteger(session.applicantIndex) || session.applicantIndex < 0 ||
      !Number.isSafeInteger(session.revision) || session.revision < 1 ||
      draft?.revision !== session.revision || draft?.jobId !== session.jobId ||
      draft?.caseId !== session.caseId || draft?.caseSignature !== session.caseSignature) return hidden;
  const proposed = postPaymentQuestion({visaCase, draft, applicantIndex:session.applicantIndex});
  if (proposed.status !== 'question' || proposed.question.key !== session.questionKey ||
      !Array.isArray(proposed.question.choices) || proposed.question.choices.length < 1 ||
      proposed.question.choices.length > 10) return hidden;
  const choicesDigest = createHash('sha256').update(JSON.stringify(proposed.question.choices)).digest('hex');
  if (session.choicesDigest !== choicesDigest) return hidden;
  if (message.type !== 'interactive' || !['button_reply','list_reply'].includes(message.interactive?.type)) return hidden;
  const id = message.interactive?.[message.interactive.type]?.id;
  if (typeof id !== 'string') return hidden;
  const match = /^rq1:([a-f0-9]{32}):([0-9])$/.exec(id);
  if (!match || match[1] !== session.token) return hidden;
  const value = proposed.question.choices[Number(match[2])]?.value;
  if (typeof value !== 'string') return hidden;
  // The answer remains in memory until passed to the injected atomic store.
  return {action:'accept',answer:{messageId:message.id,customer:message.from,
    caseId:session.caseId,caseSignature:session.caseSignature,applicantIndex:session.applicantIndex,jobId:session.jobId,
    revision:session.revision,questionKey:session.questionKey,questionMessageId:session.questionMessageId,choicesDigest,
    token:session.token,expiresAt:session.expiresAt,
    kind:['unsure','other'].includes(value)?'needs_private_review':'answer',value}};
}

async function guardMessage({message, session, visaCase, draft, now, encryptedDurable, commit} = {}) {
  const outcome = classify(message,session,visaCase,draft,now);
  if (outcome.action === 'pass') return {action:'pass'};
  // Both accepted replies and generic quarantines must be recorded before the
  // webhook is acknowledged. A failed write must trigger a retry; never fall
  // back to the ordinary journal/LLM path. The committer MUST atomically
  // re-read the paid case, session and draft, check every binding and expiry,
  // consume the token once, write the answer and deduplicate the message.
  // No committer is implemented or wired by this experimental module.
  if (encryptedDurable !== true || typeof commit !== 'function' || !safeId(message?.id) ||
      typeof message?.from !== 'string' || !CUSTOMER.test(message.from) ||
      session.customer !== message.from || typeof session.caseId !== 'string' || !session.caseId) {
    return {action:'retry'};
  }
  const record = outcome.action === 'accept' ? outcome.answer : {
    messageId:message.id,customer:session.customer,caseId:session.caseId,kind:'needs_private_review'
  };
  try {
    const saved = await commit(record);
    if (!['saved','duplicate','stale_recorded'].includes(saved)) return {action:'retry'};
    return {action:outcome.action === 'accept' && saved !== 'stale_recorded' ? 'accepted' : 'quarantined',duplicate:saved === 'duplicate'};
  } catch {return {action:'retry'};}
}

module.exports = {guardMessage};
