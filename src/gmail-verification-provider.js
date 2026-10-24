'use strict';
const {randomUUID}=require('node:crypto');
const {waitForVerificationCode,takeVerificationCode,VERIFICATION_FILE}=require('./operator-verification');
async function waitForAirArabiaCode({requestedAt=Date.now(),timeoutMs=9*60000,env=process.env,fetchImpl=fetch,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(env.GMAIL_OTP_ENABLED!=='true')return waitForVerificationCode({requestedAt,timeoutMs});
 const base=env.AIR_ARABIA_QUOTE_QUEUE_URL,key=env.AIR_ARABIA_QUOTE_QUEUE_KEY;
 if(!base||new URL(base).origin!=='https://flycham-whatsapp-assistant.onrender.com'||!key||key.length<32)throw Error('GMAIL_QUEUE_CONFIG_INVALID');
 const challengeId=randomUUID(),deadline=now()+Math.min(timeoutMs,9*60000);
 do{
  const manual=await takeVerificationCode(VERIFICATION_FILE,requestedAt);if(manual)return manual;
  try{const r=await fetchImpl(new URL('/internal/gmail/otp',base),{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({requestedAt,challengeId}),signal:AbortSignal.timeout(20000),redirect:'error'});if(r.ok){const data=await r.json();if(/^\d{6}$/.test(data.code||''))return data.code;}}catch{}
  if(now()>=deadline)break;await pause(5000);
 }while(now()<=deadline);
 throw Object.assign(Error('Verification timed out'),{code:'VERIFICATION_TIMEOUT'});
}
module.exports={waitForAirArabiaCode};
