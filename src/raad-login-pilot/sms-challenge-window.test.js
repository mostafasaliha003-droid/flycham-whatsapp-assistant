'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assertSmsWindow,sameSmsWindow,WINDOW_MS}=require('./sms-challenge-window');
const base={challengeId:'native-synthetic',challengeRequestedAt:100000,challengeExpiresAt:400000,accountBinding:'a'.repeat(64)};
test('native window is exactly bounded and original timestamp is not reset by late polling',()=>{assert.equal(WINDOW_MS,300000);assert.deepEqual(assertSmsWindow(base,399999),base);assert.throws(()=>assertSmsWindow(base,400000),/APPLICATION_SMS_CHALLENGE_STALE/);assert.throws(()=>assertSmsWindow({...base,challengeExpiresAt:400001},100000));});
test('native account/challenge/start/end identity must all match exactly',()=>{assert.deepEqual(sameSmsWindow(base,base,200000),base);for(const patch of [{challengeId:'other'},{accountBinding:'b'.repeat(64)},{challengeRequestedAt:100001},{challengeExpiresAt:399999}])assert.throws(()=>sameSmsWindow({...base,...patch},base,200000));});
