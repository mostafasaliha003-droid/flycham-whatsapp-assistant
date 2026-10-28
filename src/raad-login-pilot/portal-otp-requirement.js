'use strict';
// Read-only, narrowly scoped contract evidence; no requests are issued and no
// request bodies, headers, OTPs, unknown response keys or raw payloads returned.
function createOtpRequirementObserver(page){
 const ORIGIN='https://visa.mofa.gov.sa',FORM='/SmartForm/TraditionalApp',ENDPOINT='/SmartForm/CheckOtpRequired';
 const KEYS=['required','isRequired','IsRequired','otpRequired','isOtpRequired','IsOtpRequired','requiresOtp','Required','needOtp','NeedOtp','success','Success'];
 const available=!!page&&typeof page.on==='function'&&typeof page.off==='function';let stopped=false,sequence=0;const records=[];
 function relevant(response){try{const current=new URL(page.url()),u=new URL(response.url()),request=response.request();return current.origin===ORIGIN&&current.pathname===FORM&&!current.username&&!current.password&&u.origin===ORIGIN&&u.pathname===ENDPOINT&&!u.username&&!u.password&&request.method()==='POST'&&['xhr','fetch'].includes(request.resourceType());}catch{return false;}}
 const append=(seq,record)=>{if(stopped)return;records.push({seq,record});records.sort((a,b)=>a.seq-b.seq);while(records.length>3)records.shift();};
 async function responseReceived(response){
  if(stopped||!available||!relevant(response))return;const seq=++sequence,status=response.status();if(!Number.isInteger(status)||status<100||status>599)return;
  const record={httpStatus:status,jsonType:'unavailable',booleans:{},numbers01:{}};let bytes,payload;
  try{
   bytes=await response.body();if(stopped)return;if(!Buffer.isBuffer(bytes))throw Error('BODY_UNAVAILABLE');
   if(bytes.length>4096){record.jsonType='oversized';append(seq,record);return;}
   try{payload=JSON.parse(bytes.toString('utf8'));}catch{record.jsonType='invalid';append(seq,record);return;}
   record.jsonType=payload===null?'null':Array.isArray(payload)?'array':typeof payload;
   if(typeof payload==='boolean')record.jsonBoolean=payload;
   else if(payload&&typeof payload==='object'&&!Array.isArray(payload))for(const key of KEYS){if(!Object.prototype.hasOwnProperty.call(payload,key))continue;const value=payload[key];if(typeof value==='boolean')record.booleans[key]=value;else if(typeof value==='number'&&(value===0||value===1))record.numbers01[key]=value;}
   append(seq,record);
  }catch{append(seq,record);}finally{payload=null;if(Buffer.isBuffer(bytes))bytes.fill(0);bytes=null;}
 }
 if(available)page.on('response',responseReceived);
 return {snapshot(){return {available,unavailable:!available,records:records.map(({record})=>({...record,booleans:{...record.booleans},numbers01:{...record.numbers01}}))};},stop(){if(!stopped){stopped=true;if(available)page.off('response',responseReceived);}}};
}
module.exports={createOtpRequirementObserver};
