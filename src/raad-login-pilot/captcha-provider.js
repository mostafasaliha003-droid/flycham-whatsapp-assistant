'use strict';
const {otpConfig}=require('./mofa-otp-provider');
const {createHash}=require('node:crypto');
const ROOT='/internal/mofa/captcha-read';
function captchaConfig(env){return {enabled:env.RAAD_MOFA_CAPTCHA_ENABLED==='true',configured:otpConfig(env).configured};}
async function captchaHealth({env=process.env,fetchImpl=fetch}={}){
 const config=captchaConfig(env),out={captchaEnabled:config.enabled,captchaBridgeConfigured:config.configured,captchaBridgeReachable:false,captchaBridgeAuthenticated:false,captchaBridgeEnabled:false,captchaProviderConfigured:false};
 if(!config.configured)return out;
 try{const response=await fetchImpl(new URL(ROOT+'/status',env.RAAD_MOFA_OTP_BRIDGE_URL),{headers:{Authorization:'Bearer '+env.RAAD_MOFA_OTP_BRIDGE_KEY},signal:AbortSignal.timeout(15000),redirect:'error'});out.captchaBridgeReachable=true;if(!response.ok)return out;const data=await response.json();if(typeof data.enabled!=='boolean'||typeof data.providerConfigured!=='boolean')return out;out.captchaBridgeAuthenticated=true;out.captchaBridgeEnabled=data.enabled;out.captchaProviderConfigured=data.providerConfigured;}catch{}return out;
}
async function readCaptcha({env=process.env,image,imageId,signal,fetchImpl=fetch}={}){
 const config=captchaConfig(env);if(!config.enabled||!config.configured)throw Error('CAPTCHA_DISABLED');
 if(!Buffer.isBuffer(image)||image.length<24||image.length>200000||!image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||!/^[a-f0-9]{64}$/.test(imageId||'')||createHash('sha256').update(image).digest('hex')!==imageId)throw Error('CAPTCHA_IMAGE_INVALID');
 if(signal?.aborted)throw Error('CAPTCHA_CANCELLED');
 let response;
 try{response=await fetchImpl(new URL(ROOT,env.RAAD_MOFA_OTP_BRIDGE_URL),{method:'POST',headers:{Authorization:'Bearer '+env.RAAD_MOFA_OTP_BRIDGE_KEY,'Content-Type':'application/json'},body:JSON.stringify({image:image.toString('base64'),imageId}),signal:AbortSignal.any([AbortSignal.timeout(40000),...(signal?[signal]:[])]),redirect:'error'});}catch{throw Error(signal?.aborted?'CAPTCHA_CANCELLED':'CAPTCHA_BRIDGE_UNAVAILABLE');}
 if(signal?.aborted)throw Error('CAPTCHA_CANCELLED');
 if(!response.ok)throw Error('CAPTCHA_BRIDGE_UNAVAILABLE');
 let data;try{data=await response.json();}catch{throw Error('CAPTCHA_BRIDGE_UNAVAILABLE');}
 if(signal?.aborted)throw Error('CAPTCHA_CANCELLED');
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('CAPTCHA_BRIDGE_UNAVAILABLE');
 if(data.imageId!==imageId)throw Error('CAPTCHA_IMAGE_CHANGED');
 if(data.code===null){const reasons=new Set(['UNREADABLE','INVALID_PROVIDER_REPLY','PROVIDER_UNAVAILABLE','TIMEOUT','CANCELLED','BUSY','RATE_LIMITED','DISABLED']);throw Error(reasons.has(data.reason)?'CAPTCHA_'+data.reason:'CAPTCHA_UNREADABLE');}
 if(data.reason!=='READ'||typeof data.code!=='string'||!/^[A-Za-z0-9]{4,8}$/.test(data.code))throw Error('CAPTCHA_UNREADABLE');
 return data.code;
}
module.exports={captchaConfig,captchaHealth,readCaptcha};
