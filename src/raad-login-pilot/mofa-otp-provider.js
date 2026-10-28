'use strict';
const ORIGIN='https://flycham-whatsapp-assistant.onrender.com';
function validAccount(account){return typeof account==='string'&&account.length<=254&&/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(account);}
function otpConfig(env){let valid=false;try{const u=new URL(env.RAAD_MOFA_OTP_BRIDGE_URL);valid=u.origin===ORIGIN&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password;}catch{}return {enabled:env.RAAD_MOFA_OTP_ENABLED==='true',configured:valid&&typeof env.RAAD_MOFA_OTP_BRIDGE_KEY==='string'&&env.RAAD_MOFA_OTP_BRIDGE_KEY.length>=32};}
function bridgeRequest(env,path,{method='POST',data,signal,fetchImpl=fetch}={}){return fetchImpl(new URL('/internal/gmail/mofa-otp'+path,env.RAAD_MOFA_OTP_BRIDGE_URL),{method,headers:{Authorization:'Bearer '+env.RAAD_MOFA_OTP_BRIDGE_KEY,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal,redirect:'error'});}
async function mofaOtpHealth({env=process.env,fetchImpl=fetch}={}){
 const config=otpConfig(env),result={providerEnabled:config.enabled,providerConfigured:config.configured,accountConfigured:validAccount(env.RAAD_MOFA_USERNAME),bridgeReachable:false,bridgeAuthenticated:false,bridgeEnabled:false,recipientConfigured:false,accountMatchesRecipient:false,gmailConfigured:false,gmailConnected:false};
 if(!config.configured)return result;
 try{const response=await bridgeRequest(env,'/status',{data:{account:env.RAAD_MOFA_USERNAME||''},signal:AbortSignal.timeout(15000),fetchImpl});result.bridgeReachable=true;if(!response.ok)return result;const data=await response.json();if(!['enabled','recipientConfigured','gmailConfigured','gmailConnected','accountMatchesRecipient'].every(k=>typeof data[k]==='boolean'))return result;result.bridgeAuthenticated=true;result.bridgeEnabled=data.enabled;for(const k of ['recipientConfigured','gmailConfigured','gmailConnected','accountMatchesRecipient'])result[k]=data[k];}catch{}return result;
}
async function waitForMofaCode({env=process.env,requestedAt,challengeId,account,signal,fetchImpl=fetch,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=40000}={}){
 const config=otpConfig(env);if(!config.enabled||!config.configured)throw Error('MOFA_OTP_DISABLED');
 if(!validAccount(account)||!Number.isFinite(requestedAt)||requestedAt>now()+5000||now()-requestedAt>120000||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(challengeId||''))throw Error('MOFA_OTP_INVALID_CHALLENGE');
 const data={requestedAt,challengeId,account},deadline=now()+Math.max(1,Math.min(40000,timeoutMs));let started=false,received=false;
 try{do{
  if(signal?.aborted)throw Error('MOFA_OTP_CANCELLED');
  const remaining=deadline-now();if(remaining<=0)break;started=true;
  const response=await bridgeRequest(env,'',{data,fetchImpl,signal:AbortSignal.any([AbortSignal.timeout(Math.max(1,Math.min(35000,remaining))),...(signal?[signal]:[])])});
  if(signal?.aborted)throw Error('MOFA_OTP_CANCELLED');
  if(!response.ok)throw Error('MOFA_OTP_BRIDGE_UNAVAILABLE');
  const value=await response.json();if(signal?.aborted)throw Error('MOFA_OTP_CANCELLED');
  if(now()>deadline)throw Error('MOFA_OTP_NOT_RECEIVED');
  if(/^[0-9]{6}$/.test(value.code||'')){received=true;return value.code;}
  if(now()>=deadline)break;
  await pause(Math.min(2500,deadline-now()));
 }while(now()<deadline);throw Error('MOFA_OTP_NOT_RECEIVED');
 }catch(error){throw Error(signal?.aborted?'MOFA_OTP_CANCELLED':/^MOFA_OTP_/.test(error?.message||'')?error.message:'MOFA_OTP_BRIDGE_UNAVAILABLE');}
 finally{if(started&&!received){try{await bridgeRequest(env,'/cancel',{data,fetchImpl,signal:AbortSignal.timeout(3000)});}catch{}}}
}
module.exports={otpConfig,validAccount,waitForMofaCode,mofaOtpHealth};
