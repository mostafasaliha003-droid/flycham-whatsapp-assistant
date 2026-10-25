'use strict';
const {airportCode}=require('./airports');
const STAGES={idle:'بانتظار طلب',search_form:'تحديد المطارات والتواريخ',flights:'فحص الرحلات والتواقيت',passengers:'تحضير فحص الإضافات',seats:'التحقق من المقاعد',meals:'التحقق من الوجبات',baggage:'التحقق من الوزن',pricing:'التحقق من السعر النهائي',completed:'اكتمل فحص الطلب',authentication:'التحقق من الاتصال',unavailable:'الاتصال يحتاج متابعة'};
const PROVIDERS=['airarabia','flycham'];
function stageFromCode(code){
 if(typeof code!=='string'||!/^[A-Z][A-Z0-9_]{0,120}$/.test(code))return null;
 if(/BLOCKED|SESSION_UNAVAILABLE|AUTHENTICATION_REQUIRED/.test(code))return 'unavailable';
 if(/AUTHENTICATED|PROTECTED_HEALTH_CONFIRMED|HEARTBEAT.*COMPLETED/.test(code))return 'idle';
 if(/VERIFICATION|LOGIN|OPEN_LOGIN/.test(code))return 'authentication';
 if(/TEST_PASSENGER|PASSENGER_FIELDS|ANCILLARY_ENTRY/.test(code))return 'passengers';
 if(/SEAT/.test(code))return 'seats';if(/MEAL/.test(code))return 'meals';if(/BAGGAGE|WEIGHT/.test(code))return 'baggage';
 if(/QUOTE_PRICED|QUOTE_REPLY_SUBMITTED|CATALOG_SEARCH_COMPLETED|TIMING_COMPARISON_COMPLETE/.test(code))return 'completed';
 if(/FARE_CONFIRMED|FINAL_TOTAL|PROVISIONAL_TOTAL/.test(code))return 'pricing';
 if(/FLIGHT_RESULTS|WAITING_FOR_FLIGHT|TIMING_FARE/.test(code))return 'flights';
 if(/SEARCH|AIRPORT|PROBE_STAGE|RESERVATION/.test(code))return 'search_form';return null;
}
function safeJob(job){
 const r=job?.request||job;if(!r||typeof r!=='object')return null;
 const safe={};for(const k of ['origin','destination'])if(airportCode(r[k]))safe[k]=r[k];
 for(const k of ['departureDate','returnDate'])if(/^\d{4}-\d{2}-\d{2}$/.test(r[k]||'')&&Number.isFinite(Date.parse(r[k]+'T00:00:00Z'))&&new Date(r[k]+'T00:00:00Z').toISOString().slice(0,10)===r[k])safe[k]=r[k];
 if(['one_way','round_trip'].includes(r.tripType))safe.tripType=r.tripType;
 return Object.keys(safe).length?safe:null;
}
function jpegBytes(value){
 if(typeof value!=='string'||value.length>700000||!value.length||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return null;
 const b=Buffer.from(value,'base64');if(b.length<100||b.length>500000||b.toString('base64')!==value||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)return null;
 let at=2,frame=false,scan=false;
 while(at+4<b.length){if(b[at++]!==255)return null;while(b[at]===255)at++;const marker=b[at++];if(marker===217)break;const size=b.readUInt16BE(at);if(size<2||at+size>b.length)return null;
  if([192,193,194].includes(marker)){if(size<8)return null;const h=b.readUInt16BE(at+3),w=b.readUInt16BE(at+5);if(!h||!w||w*h>16000000)return null;frame=true;}
  if(marker===218){scan=true;break;}at+=size;
 }
 return frame&&scan?b:null;
}
class PortalMonitor{
 constructor({now=Date.now,ttl=30000}={}){this.now=now;this.ttl=ttl;this.providers=new Map();}
 accept(data){
  if(!PROVIDERS.includes(data?.provider)||!Object.hasOwn(STAGES,data.stage))return false;
  const old=this.providers.get(data.provider)||{},state=typeof data.state==='string'&&['ready','recovering','verification','blocked','closed','unavailable','stale','starting'].includes(data.state)?data.state:'unavailable';
  const record={provider:data.provider,stage:data.stage,ready:data.ready===true&&state==='ready'&&!['authentication','unavailable'].includes(data.stage),state,updatedAt:this.now(),activeJob:safeJob(data.activeJob),preview:null};
  if(data.preview){
   if(data.preview.redacted!==true||!['search_form','flights','seats','meals','baggage','pricing'].includes(data.stage)||!record.ready||!record.activeJob||typeof data.preview.jpeg!=='string'||data.preview.jpeg.length>700000)return false;
   const bytes=jpegBytes(data.preview.jpeg);if(!bytes)return false;
   record.preview={bytes,updatedAt:this.now()};
  }else if(data.previewWithheld!==true&&record.ready&&['search_form','flights','seats','meals','baggage','pricing'].includes(record.stage)&&record.activeJob&&JSON.stringify(record.activeJob)===JSON.stringify(old.activeJob)&&old.stage===record.stage&&old.preview&&this.now()-old.preview.updatedAt<=this.ttl)record.preview=old.preview;
  this.providers.set(data.provider,record);return true;
 }
 list(readiness={}){return {providers:PROVIDERS.map(provider=>{
  const r=this.providers.get(provider),fresh=r&&this.now()-r.updatedAt<=this.ttl,ready=Boolean(fresh&&r.ready&&readiness[provider]!==false),preview=ready&&r.preview&&this.now()-r.preview.updatedAt<=this.ttl;
  return {provider,name:provider==='airarabia'?'العربية للطيران':'فلاي شام',state:fresh?r.state:'stale',ready,stage:fresh?r.stage:'unavailable',stageLabel:fresh?STAGES[r.stage]:'بانتظار تحديث مباشر من البوابة',lastSeenAt:r?.updatedAt||null,updatedAt:r?.updatedAt||null,activeJob:fresh?r.activeJob:null,previewAvailable:Boolean(preview),screenshot:preview?{url:'/internal/assistant/portal-monitor/'+provider+'/preview',updatedAt:r.preview.updatedAt,redacted:true}:null};
 })};}
 preview(provider){const r=this.providers.get(provider);return r?.ready&&r.preview&&this.now()-r.updatedAt<=this.ttl&&this.now()-r.preview.updatedAt<=this.ttl?r.preview.bytes:null;}
}
module.exports={PortalMonitor,stageFromCode,safeJob,STAGES};
