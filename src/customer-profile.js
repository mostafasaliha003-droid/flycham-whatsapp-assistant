'use strict';
const {city}=require('./travel-language');
const {canonicalNationality,nationalities}=require('./saudi-visa-policy');
const RETENTION_MS=180*86400000,MAX_PROFILES=2000;
const validId=id=>typeof id==='string'&&id.length>0&&id.length<=100&&!['__proto__','prototype','constructor'].includes(id);
const fresh=(at,now)=>Number.isFinite(at)&&at<=now&&now-at<=RETENTION_MS;
const count=(n,max)=>Number.isInteger(n)&&n>=1&&n<=max?n:null;
const nationality=value=>{const n=canonicalNationality(value);return n&&nationalities(n).includes(n)?n:null;};
function flightFields(r,at){
 const weight=r.baggageRequest?.checkedWeightKg??r.weightKg;
 return {origin:city(r.origin),destination:city(r.destination),tripType:['one_way','round_trip'].includes(r.tripType)?r.tripType:null,
  provider:r.providerExclusive&&['flycham','airarabia'].includes(r.provider)?r.provider:null,
  weightKg:Number.isInteger(weight)&&weight>=0&&weight<=50?weight:null,adults:count(r.passengers?.adults??r.adults,9),lastAt:at};
}
function visaFields(c,at){
 const p=c.applicants?.[0]||c,documentType=['passport','travel_document'].includes(p.documentType)?p.documentType:null;
 return {nationality:nationality(p.nationality),documentType,
  documentIssuer:documentType==='travel_document'&&['سوريا','لبنان','مصر','الأردن','العراق'].includes(p.documentIssuer)?p.documentIssuer:null,
  applicantCount:count(c.applicantCount,30),transport:['air','car'].includes(c.transport)?c.transport:null,lastAt:at};
}
// Whitelist persisted fields and expire each service independently. A newer visa
// inquiry must not extend the lifetime of old flight preferences (or vice versa).
function pruneProfiles(profiles,now){
 if(!profiles||typeof profiles!=='object')return;
 for(const [id,p]of Object.entries(profiles)){
  if(!validId(id)||!p||typeof p!=='object'){delete profiles[id];continue;}
  const clean={};
  if(fresh(p.flight?.lastAt,now))clean.flight=flightFields({...p.flight,providerExclusive:!!p.flight.provider},p.flight.lastAt);
  if(fresh(p.visa?.lastAt,now))clean.visa=visaFields(p.visa,p.visa.lastAt);
  if(!clean.flight&&!clean.visa){delete profiles[id];continue;}
  clean.updatedAt=Math.max(clean.flight?.lastAt??0,clean.visa?.lastAt??0);profiles[id]=clean;
 }
 const remaining=Object.entries(profiles).sort((a,b)=>a[1].updatedAt-b[1].updatedAt);
 for(const [id]of remaining.slice(0,Math.max(0,remaining.length-MAX_PROFILES)))delete profiles[id];
}
function remember(store,id,service,value,now){
 if(!store?.data||!validId(id)||!Number.isFinite(now))return null;
 store.data.customerProfiles||={};const profiles=store.data.customerProfiles;
 pruneProfiles(profiles,now);
 profiles[id]={...(Object.hasOwn(profiles,id)?profiles[id]:{}),[service]:value,updatedAt:now};
 pruneProfiles(profiles,now);store.save?.();return profiles[id]?.[service]||null;
}
function rememberFlightJourney(store,id,request,{now=Date.now()}={}){
 if(!request)return null;const f=flightFields(request,now);
 if(!f.origin&&!f.destination)return null;
 return remember(store,id,'flight',f,now);
}
function rememberVisaJourney(store,id,visaCase,{now=Date.now()}={}){
 if(!visaCase)return null;const v=visaFields(visaCase,now);
 if(!v.nationality&&!v.documentType)return null;
 return remember(store,id,'visa',v,now);
}
function returningGreeting(store,id,service,{now=Date.now()}={}){
 if(!validId(id))return null;
 const profiles=store?.data?.customerProfiles;pruneProfiles(profiles,now);const p=profiles?.[id];
 if(service==='flight'&&p?.flight?.origin&&p.flight.destination){
  const f=p.flight,trip=f.tripType==='round_trip'?' (ذهاب وعودة)':f.tripType==='one_way'?' (ذهاب فقط)':'';
  return `أهلاً بعودتك 🌷 يسعدنا خدمتك من جديد! بآخر طلب كنت عم تبحث عن رحلة من ${f.origin} إلى ${f.destination}${trip} — تحب نفحص عروض جديدة لنفس المسار، أو عندك وجهة وتفاصيل ثانية اليوم؟`;
 }
 if(service==='saudi_visa'&&p?.visa?.nationality){
  const v=p.visa,doc=v.documentType==='travel_document'?'وثيقة سفر'+(v.documentIssuer?` (${v.documentIssuer})`:''):v.documentType==='passport'?'جواز سفر عادي':null;
  return `أهلاً بعودتك بمجموعة الرمال 🌷 بآخر استفسار كنا عم نرتب فيزا السعودية (${v.nationality}${doc?' — '+doc:''}). تحب نبدأ طلب جديد على نفس البيانات، أو لمتقدمين تانيين؟`;
 }
 return null;
}
function clearCustomerProfile(store,id){
 if(!validId(id)||!Object.hasOwn(store?.data?.customerProfiles||{},id))return false;
 delete store.data.customerProfiles[id];store.save?.();return true;
}
module.exports={rememberFlightJourney,rememberVisaJourney,returningGreeting,clearCustomerProfile,pruneProfiles};
