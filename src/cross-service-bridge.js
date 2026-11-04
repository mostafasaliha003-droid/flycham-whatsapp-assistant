'use strict';
const {normalize}=require('./arabic-dates');

function hasSavedFlightContext(flightState){
 const r=flightState?.base?.request;
 return Boolean(r&&(r.origin||r.destination||r.departureDate||r.departureRange)||flightState?.offers?.length);
}
function hasSavedVisaContext(visaCase){
 return Boolean(visaCase&&(visaCase.applicantCount||visaCase.applicants?.length||visaCase.departureDate||visaCase.stage&&visaCase.stage!=='inquiry'));
}
function detectCrossServiceSwitch(currentService,text,{flightState=null,visaCase=null}={}){
 const t=normalize(String(text||'')).replace(/ة/g,'ه');
 const asksVisa=/زياره\s*(?:عائليه|شخصيه|للسعوديه|سعوديه)|(?:فيزا|فيزه|تاشيره|تأشيره)\s*(?:السعوديه|سعوديه|عمره)?|عمره|نسك|اسماعيل|saudi\s+visa|umrah/i.test(t);
 const asksFlight=/(?:رحله|طيران|تذكره|تذاكر|حجز\s*طيران|فلاي\s*شام|العربيه\s*للطيران|دمشق|الشام|حلب|اللاذقيه|احمد|flight|ticket)/i.test(t);
 if(currentService==='flight'&&asksVisa&&!asksFlight){
  return {switched:true,from:'flight',to:'saudi_visa',preserveFlight:hasSavedFlightContext(flightState)};
 }
 if(currentService==='saudi_visa'&&asksFlight&&!asksVisa){
  return {switched:true,from:'saudi_visa',to:'flight',preserveVisa:hasSavedVisaContext(visaCase)};
 }
 return {switched:false,from:currentService,to:currentService};
}
function transitionBanner(fromService,toService,{preserveFlight=false,preserveVisa=false}={}){
 if(fromService==='flight'&&toService==='saudi_visa'&&preserveFlight){
  return '✈️ *تفاصيل رحلتك محفوظة عند أحمد*، وهلق معك *إسماعيل* لخدمة فيزا السعودية 🇸🇦 (وفينا نرجع لمتابعة الطيران بأي وقت بكلمة «طيران»).';
 }
 if(fromService==='saudi_visa'&&toService==='flight'&&preserveVisa){
  return '🇸🇦 *ملف فيزا السعودية محفوظ عند إسماعيل*، وهلق معك *أحمد* لخدمة الطيران ✈️ (وفينا نرجع لمتابعة الفيزا بأي وقت بكلمة «فيزا»).';
 }
 return null;
}
function withTransitionBanner(reply,banner){
 const text=String(reply||'').trim();
 if(!text||!banner||text.includes(banner))return text;
 return `${banner}\n\n${text}`;
}
module.exports={hasSavedFlightContext,hasSavedVisaContext,detectCrossServiceSwitch,transitionBanner,withTransitionBanner};
