'use strict';
// Observed official UI contract, 2026-10-30. This classifies request acceptance,
// not SMS delivery or code validity. No server response has been live-verified.
const SEND_URL='https://visa.mofa.gov.sa/SmartForm/SendOtpSms';
const MAX_RESPONSE_BYTES=16384;
async function verifyOfficialSmsResponse(response){
 let raw='',body=null;
 try{
  const request=response.request();
  if(request.method()!=='POST'||request.url()!==SEND_URL||response.url()!==SEND_URL)return 'unknown';
  if(typeof request.redirectedFrom!=='function'||request.redirectedFrom()!==null)return 'unknown';
  const status=response.status();
  if(!Number.isInteger(status)||status<200||status>=300)return 'unknown';
  raw=await response.text();
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>MAX_RESPONSE_BYTES)return 'unknown';
  // Refuse duplicate/encoded contract keys instead of letting JSON's last key win.
  const tokenKeys=(raw.match(/"otpToken"\s*:/g)||[]).length;
  if((raw.match(/"success"\s*:/g)||[]).length!==1||tokenKeys>1)return 'unknown';
  body=JSON.parse(raw);raw='';
  if(!body||typeof body!=='object'||Array.isArray(body))return 'unknown';
  // Be stricter than JavaScript truthiness: strings/numbers are ambiguous.
  if(body.success===true&&tokenKeys===1&&typeof body.otpToken==='string'&&body.otpToken.trim().length>0)return 'accepted';
  if(body.success===false&&!body.otpToken)return 'rejected';
  return 'unknown';
 }catch{return 'unknown';}
 finally{raw='';if(body&&typeof body==='object'){body.otpToken='';body.message='';}body=null;}
}
module.exports={verifyOfficialSmsResponse};
