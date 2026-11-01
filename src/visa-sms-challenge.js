'use strict';
// One authoritative native challenge window; never manufacture a polling TTL.
const SMS_CHALLENGE_TTL_MS = 5 * 60 * 1000;
function fail() { throw Object.assign(new Error('SUPERVISOR_SMS_CHALLENGE_STALE'), {code: 'SUPERVISOR_SMS_CHALLENGE_STALE', notDispatched: true}); }
function validateSmsChallenge(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.challengeId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.challengeId) ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(value.challengeRequestedAt) ||
      !Number.isSafeInteger(value.challengeExpiresAt) || value.challengeRequestedAt <= 0 ||
      value.challengeRequestedAt > now || value.challengeExpiresAt <= now ||
      value.challengeExpiresAt <= value.challengeRequestedAt ||
      value.challengeExpiresAt - value.challengeRequestedAt > SMS_CHALLENGE_TTL_MS ||
      typeof value.accountBinding !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountBinding)) fail();
  return Object.freeze({challengeId: value.challengeId, challengeRequestedAt: value.challengeRequestedAt,
    challengeExpiresAt: value.challengeExpiresAt, accountBinding: value.accountBinding});
}
function sameSmsChallenge(a,b) {
  return Boolean(a && b && ['challengeId','challengeRequestedAt','challengeExpiresAt','accountBinding'].every(key=>a[key]===b[key]));
}
module.exports = {SMS_CHALLENGE_TTL_MS, validateSmsChallenge, sameSmsChallenge};
