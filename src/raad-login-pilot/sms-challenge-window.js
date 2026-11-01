'use strict';
const {SMS_CHALLENGE_TTL_MS,validateSmsChallenge,sameSmsChallenge}=require('../visa-sms-challenge');
const fail=()=>{throw Object.assign(Error('APPLICATION_SMS_CHALLENGE_STALE'),{code:'APPLICATION_SMS_CHALLENGE_STALE'});};
function assertSmsWindow(value,now=Date.now()){try{return validateSmsChallenge(value,now);}catch{fail();}}
function sameSmsWindow(actual,expected,now=Date.now()){const left=assertSmsWindow(actual,now),right=assertSmsWindow(expected,now);if(!sameSmsChallenge(left,right))fail();return left;}
module.exports={WINDOW_MS:SMS_CHALLENGE_TTL_MS,assertSmsWindow,sameSmsWindow};
