'use strict';
const {createHash}=require('node:crypto');
const {captureCaptcha}=require('./captcha-image');
const {readCaptcha}=require('./captcha-provider');
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
const CODES=new Set(['PORTAL_CAPTCHA_INPUT_INVALID','PORTAL_CAPTCHA_UNAVAILABLE','PORTAL_CAPTCHA_CANCELLED','PORTAL_CAPTCHA_IMAGE_CHANGED','PORTAL_CAPTCHA_ALREADY_ATTEMPTED','PORTAL_CAPTCHA_IMAGE_LIMIT','PORTAL_CAPTCHA_INPUT_UNAVAILABLE','PORTAL_CAPTCHA_UNREADABLE','PORTAL_CAPTCHA_DISABLED','PORTAL_CAPTCHA_PROVIDER_UNAVAILABLE','PORTAL_CAPTCHA_TIMEOUT','PORTAL_CAPTCHA_INVALID_PROVIDER_REPLY']);
const failure=code=>Object.assign(new Error(CODES.has(code)?code:'PORTAL_CAPTCHA_UNAVAILABLE'),{code:CODES.has(code)?code:'PORTAL_CAPTCHA_UNAVAILABLE'});
function assertPage(page){const u=new URL(page.url()),frame=page.mainFrame();if(u.origin!==ORIGIN||u.pathname!==PATH||u.username||u.password||!frame||frame.url()!==page.url())throw failure('PORTAL_CAPTCHA_UNAVAILABLE');}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function checkPortalCaptcha(page,imageId){
 if(typeof imageId!=='string'||!/^[a-f0-9]{64}$/.test(imageId))throw failure('PORTAL_CAPTCHA_INPUT_INVALID');
 try{assertPage(page);const actual=hash(await captureCaptcha(page));assertPage(page);if(actual!==imageId)throw failure('PORTAL_CAPTCHA_IMAGE_CHANGED');return true;}catch(error){throw failure(error?.code);}
}
async function solvePortalCaptcha({page,env=process.env,fetchImpl=fetch,signal,guard,seen}={}){
 if(typeof guard!=='function'||!(seen instanceof Set)||signal!==undefined&&typeof signal.addEventListener!=='function')throw failure('PORTAL_CAPTCHA_INPUT_INVALID');
 let input,bytes;
 const active=async()=>{if(signal?.aborted)throw failure('PORTAL_CAPTCHA_CANCELLED');assertPage(page);await guard();if(signal?.aborted)throw failure('PORTAL_CAPTCHA_CANCELLED');assertPage(page);};
 try{
  await active();const field=page.locator('#myform #Captcha');if(await field.count()!==1||!await field.isVisible()||!await field.isEnabled())throw failure('PORTAL_CAPTCHA_INPUT_UNAVAILABLE');
  input=await field.elementHandle();if(!input)throw failure('PORTAL_CAPTCHA_INPUT_UNAVAILABLE');
  const originalReady=async()=>{await active();const ready=await input.evaluate(el=>el.isConnected&&el.tagName==='INPUT'&&el.type==='text'&&el.id==='Captcha'&&!el.disabled&&!el.readOnly&&Boolean(el.closest('#myform'))&&location.origin==='https://visa.mofa.gov.sa'&&location.pathname==='/SmartForm/TraditionalApp'&&window.top===window.self);if(!ready)throw failure('PORTAL_CAPTCHA_INPUT_UNAVAILABLE');};
  await originalReady();bytes=await captureCaptcha(page);const imageId=hash(bytes);await active();
  if(seen.has(imageId))throw failure('PORTAL_CAPTCHA_ALREADY_ATTEMPTED');if(seen.size>=3)throw failure('PORTAL_CAPTCHA_IMAGE_LIMIT');seen.add(imageId);
  let code=await readCaptcha({env,image:bytes,imageId,signal,fetchImpl});
  try{await active();await checkPortalCaptcha(page,imageId);await originalReady();if(signal?.aborted)throw failure('PORTAL_CAPTCHA_CANCELLED');await input.fill(code,{timeout:5000});code='';await active();return {filled:true,imageId};}finally{code='';}
 }catch(error){if(signal?.aborted)throw failure('PORTAL_CAPTCHA_CANCELLED');if(error?.code&&CODES.has(error.code))throw error;const mapped={'CAPTCHA_UNREADABLE':'PORTAL_CAPTCHA_UNREADABLE','CAPTCHA_DISABLED':'PORTAL_CAPTCHA_DISABLED','CAPTCHA_IMAGE_CHANGED':'PORTAL_CAPTCHA_IMAGE_CHANGED','CAPTCHA_CANCELLED':'PORTAL_CAPTCHA_CANCELLED','CAPTCHA_TIMEOUT':'PORTAL_CAPTCHA_TIMEOUT','CAPTCHA_INVALID_PROVIDER_REPLY':'PORTAL_CAPTCHA_INVALID_PROVIDER_REPLY','CAPTCHA_BRIDGE_UNAVAILABLE':'PORTAL_CAPTCHA_PROVIDER_UNAVAILABLE','CAPTCHA_PROVIDER_UNAVAILABLE':'PORTAL_CAPTCHA_PROVIDER_UNAVAILABLE'};throw failure(mapped[error?.message]);}
 finally{if(bytes)bytes.fill(0);if(input)await input.dispose().catch(()=>{});}
}
module.exports={solvePortalCaptcha,checkPortalCaptcha};
