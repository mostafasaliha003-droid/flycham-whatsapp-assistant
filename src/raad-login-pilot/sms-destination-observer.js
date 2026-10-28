'use strict';
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp',LIMIT=4096;
const PHONE_KEYS=new Set(['phone','phonenumber','phoneno','mobile','mobilenumber','mobileno','destination','destinationphone','destinationmobile','recipient','recipientphone','recipientmobile','msisdn','mobileinfomobile','mobileinfomobilenumber']);
const DIAL_KEYS=new Set(['dialcode','dialingcode','diallingcode','callingcode','internationaldialcode','countrydialcode','prefix','phoneprefix','mobileprefix','countrycode','phonecountrycode','mobilecountrycode','mobileinfomobileprefix']);
const empty=()=>({observed:false,phoneMatch:'unknown',dialCodeMatch:null});
const keyName=key=>String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
const excluded=key=>/otp|token|password|captcha|verification|authenticity|csrf|xsrf|secret|authorization|session|nationality|citizen|passport|birthcountry|residencecountry|comingcountry|sender|^smscode$|^code$|^pin$/.test(keyName(key));
function phoneValue(value){
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)return null;value=String(value);}
 if(typeof value!=='string'||value.length>64||!/^\s*\+?[0-9() .\t\r\n-]+\s*$/.test(value))return null;
 const international=/^\s*(?:\+|00)/.test(value);let digits=value.replace(/[^0-9]/g,'');if(/^\s*00/.test(value))digits=digits.slice(2);
 if(digits.length<5||digits.length>18)return null;return {digits,international};
}
function dialValue(value){
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)return null;value=String(value);}
 if(typeof value!=='string'||value.length>12||!/^\s*(?:\+|00)?[0-9]{1,4}\s*$/.test(value))return null;
 const digits=value.trim().replace(/^\+/,'').replace(/^00/,'');return /^[1-9][0-9]{0,3}$/.test(digits)?digits:null;
}
function destinationFrom(query,body,expected){
 const phones=[],dials=[];let visited=0,uncertain=false;
 function entry(key,value,depth){
  if(depth>5||++visited>128){uncertain=true;return;}if(excluded(key))return;
  const parts=String(key).split(/[.\[\]]+/).filter(Boolean);if(parts.some(excluded))return;
  const normalized=keyName(key),leaf=keyName(parts[parts.length-1]||key),phone=PHONE_KEYS.has(normalized)||PHONE_KEYS.has(leaf),dial=DIAL_KEYS.has(normalized)||DIAL_KEYS.has(leaf);
  if(value&&typeof value==='object'){walk(value,depth+1);return;}
  if((phone||dial)&&typeof value==='string'&&/^\s*[\[{]/.test(value)&&Buffer.byteLength(value,'utf8')<=LIMIT){try{walk(JSON.parse(value),depth+1);}catch{uncertain=true;}return;}
  if(phone){const normalizedPhone=phoneValue(value);if(normalizedPhone)phones.push(normalizedPhone);}
  else if(dial){const normalizedDial=dialValue(value);if(normalizedDial)dials.push(normalizedDial);}
 }
 function walk(value,depth){
  if(depth>5){uncertain=true;return;}if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){if(value.length>16)uncertain=true;for(const item of value.slice(0,16))if(item&&typeof item==='object')walk(item,depth+1);return;}
  for(const key of Object.keys(value)){if(visited>=128){uncertain=true;break;}if(excluded(key)){visited++;continue;}entry(key,value[key],depth);}
 }
 for(const [key,value]of new URLSearchParams(query))entry(key,value,0);
 if(body){
  if(/^\s*[\[{]/.test(body)){try{walk(JSON.parse(body),0);}catch{uncertain=true;}}
  else if(!/[\u0000-\u001f\u007f]/.test(body)&&body.split('&').every(pair=>/^[A-Za-z0-9_.\[\]%+-]+=[^&]*$/.test(pair)&&!/%(?![0-9a-f]{2})/i.test(pair)))for(const [key,value]of new URLSearchParams(body))entry(key,value,0);else uncertain=true;
 }
 if(uncertain)return {observed:true,phoneMatch:'unknown',dialCodeMatch:null};
 const uniquePhones=new Map();for(const phone of phones)uniquePhones.set((phone.international?'i:':'n:')+phone.digits,phone);
 let phoneMatch='unknown';
 if(uniquePhones.size===1){const phone=Array.from(uniquePhones.values())[0];if(phone.digits===expected.e164)phoneMatch='e164';else if(phone.digits===expected.trunkE164)phoneMatch='e164_with_trunk_zero';else if(!phone.international&&(phone.digits===expected.national||phone.digits===expected.domestic))phoneMatch='national';else phoneMatch='different';}
 const uniqueDials=new Set(dials),dialCodeMatch=uniqueDials.size===1?uniqueDials.has(expected.dial):null;
 return {observed:true,phoneMatch,dialCodeMatch};
}
function createSmsDestinationObserver(page){
 let armed=false,expected=null,result=empty(),attached=false;
 const remove=()=>{if(!attached)return;attached=false;try{if(typeof page.off==='function')page.off('request',observe);else page.removeListener('request',observe);}catch{}};
 const stop=()=>{armed=false;expected=null;remove();};
 function observe(request){
  if(!armed||!expected)return;
  try{
   const current=new URL(page.url()),main=page.mainFrame();
   if(current.origin!==ORIGIN||current.pathname!==PATH||current.username||current.password||!main||main.url()!==page.url()||request.frame()!==main)return;
   if(!['xhr','fetch'].includes(request.resourceType())||!['GET','POST'].includes(request.method()))return;
   const url=new URL(request.url()),match=url.pathname.match(/^\/(?:SmartForm|Base)\/([A-Za-z][A-Za-z0-9_-]*)$/i);
   if(url.origin!==ORIGIN||url.username||url.password||!match||!/^(?:send|request)[a-z0-9]*(?:otp|verificationcode)[a-z0-9]*$/i.test(match[1].replace(/[_-]/g,'')))return;
   const target=expected;armed=false;expected=null;remove();result={observed:true,phoneMatch:'unknown',dialCodeMatch:null};
   let body=request.method()==='POST'?request.postData()||'':'';
   if(typeof body!=='string'||Buffer.byteLength(url.search,'utf8')+Buffer.byteLength(body,'utf8')>LIMIT){body='';return;}
   result=destinationFrom(url.search,body,target);body='';
  }catch{}
 }
 function arm(input={}){
  stop();result=empty();let phone,dial;
  try{phone=input.expectedPhone;dial=dialValue(input.expectedDialCode);if(typeof phone!=='string'||!/^[0-9]{7,15}$/.test(phone)||phone.startsWith('00')||!dial)throw Error();}catch{const error=new Error('SMS_DESTINATION_INPUT_INVALID');error.code=error.message;throw error;}
  const national=phone.startsWith('0')?phone.slice(1):phone;
  const supported=page&&typeof page.on==='function'&&(typeof page.off==='function'||typeof page.removeListener==='function')&&typeof page.url==='function'&&typeof page.mainFrame==='function';
  if(!supported)return false;
  expected={national,domestic:'0'+national,dial,e164:dial+national,trunkE164:dial+'0'+national};armed=true;
  try{page.on('request',observe);attached=true;return true;}catch{stop();return false;}
 }
 return {arm,snapshot:()=>({...result}),stop};
}
module.exports={createSmsDestinationObserver};
