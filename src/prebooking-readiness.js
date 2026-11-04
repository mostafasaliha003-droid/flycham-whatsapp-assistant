'use strict';
const {normalize}=require('./arabic-dates');
const {city}=require('./travel-language');

function parseIsoDate(v){
 if(typeof v!=='string')return null;
 const s=normalize(v).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
 if(/^20\d{2}-\d{2}-\d{2}$/.test(s)){
  const ms=Date.parse(s+'T00:00:00Z');
  if(Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===s)return s;
 }
 const m=s.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](20\d{2})$/);
 if(m){
  const iso=`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  const ms=Date.parse(iso+'T00:00:00Z');
  if(Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===iso)return iso;
 }
 return null;
}

function daysBetweenDates(startIso,endIso){
 const a=parseIsoDate(startIso),b=parseIsoDate(endIso);
 if(!a||!b)return null;
 return Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
}

function checkPassportValidityDate(expiryDateStr,referenceDateStr){
 const expiry=parseIsoDate(expiryDateStr),ref=parseIsoDate(referenceDateStr);
 if(!expiry||!ref)return null;
 const days=daysBetweenDates(ref,expiry);
 if(days<0){
  return {
   status:'expired',
   daysRemaining:days,
   warningCopy:`⚠️ *تنبيه صلاحية الجواز:* تاريخ انتهاء الجواز المذكور (${expiry}) منتهٍ بالنسبة لتاريخ المرجع (${ref}). يلزم تجديد الجواز أو مراجعة المستندات الرسمية مع الموظف قبل أي تثبيت.`
  };
 }
 if(days<180){
  return {
   status:days<90?'under_3_months':'under_6_months',
   daysRemaining:days,
   warningCopy:`⚠️ *تنبيه صلاحية الجواز:* متبقٍ على انتهاء الجواز (${expiry}) حوالي ${days} يوماً من تاريخ (${ref})، وهو دون حد الفحص الأولي البالغ 180 يوماً. نراجع شروط القبول الفعلية مع القسم قبل التثبيت أو الدفع.`
  };
 }
 return {
  status:'valid',
  daysRemaining:days,
  warningCopy:`✅ صلاحية الجواز المذكورة (${expiry}) تغطي ${days} يوماً، وتحقق حد الفحص الأولي (180 يوماً) من تاريخ (${ref}). يبقى التحقق من شروط الوجهة والمستندات ضرورياً قبل التثبيت.`
 };
}

function checkResidencyValidityDate(expiryDateStr,referenceDateStr){
 const expiry=parseIsoDate(expiryDateStr),ref=parseIsoDate(referenceDateStr);
 if(!expiry||!ref)return null;
 const days=daysBetweenDates(ref,expiry);
 if(days<0){
  return {
   status:'expired',
   daysRemaining:days,
   warningCopy:`⚠️ *تنبيه صلاحية الإقامة:* تاريخ انتهاء الإقامة المذكور (${expiry}) منتهٍ بالنسبة لتاريخ (${ref}). مسار السياحية للمقيمين يتطلب إقامة سارية لا تقل عن 3 أشهر؛ نراجع معك الخيارات المتاحة قبل أي دفع.`
  };
 }
 if(days<90){
  return {
   status:'under_3_months',
   daysRemaining:days,
   warningCopy:`⚠️ *تنبيه صلاحية الإقامة:* متبقٍ على انتهاء الإقامة (${expiry}) حوالي ${days} يوماً من تاريخ (${ref})، وهو دون حد الفحص الأولي البالغ 90 يوماً. نراجع الحالة مع المسؤول قبل استكمال الطلب.`
  };
 }
 return {
  status:'valid',
  daysRemaining:days,
  warningCopy:`✅ صلاحية الإقامة المذكورة (${expiry}) تغطي ${days} يوماً، وتحقق حد الفحص الأولي (90 يوماً) من تاريخ (${ref}). يبقى التحقق من شروط الوجهة والمستندات ضرورياً قبل التثبيت.`
 };
}

function extractMentionedExpiryDates(text){
 const raw=normalize(require('./bilingual-intake').affirmativeEnglishText(text)).replace(/ة/g,'ه').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
 const expiry=/انتهاء|ينتهي|تنتهي|بيخلص|بتخلص|صلاحي[هت]|expir|valid\s+until/i;
 if(!expiry.test(raw))return {};
 const dates=[...raw.matchAll(/(?<![\p{L}\p{N}])(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/. -]\d{1,2}[/. -]20\d{2})(?![\p{L}\p{N}])/gu)];
 const values={passportExpiry:new Set(),residencyExpiry:new Set()};let prevEnd=0;
 const label=/جواز(?:ي)?|باسبور(?:ت)?(?:ي)?|passport|اقام[هت](?:ي)?|هوي[هت](?:ي)?|residency|residence|\beid\b/ig;
 for(let i=0;i<dates.length;i++){
  const m=dates[i],date=parseIsoDate(m[0]);
  const before=raw.slice(prevEnd,m.index).split(/[،,;؟?!]/).at(-1);
  const after=raw.slice(m.index+m[0].length,dates[i+1]?.index??raw.length).split(/[،,;؟?!]|\s+و(?=جواز|اقام|هوي)/)[0];
  prevEnd=m.index+m[0].length;if(!date)continue;
  const labels=[...before.matchAll(label)];let chosen=labels.at(-1),clause=chosen?before.slice(chosen.index):'';
  // Date-first wording is accepted only when the same clause explicitly names
  // an expiry; a travel/departure date can never serve as document expiry.
  if(!chosen&&!before.trim()){chosen=[...after.matchAll(label)][0];clause=after;}
  if(!chosen||!expiry.test(clause)||/سفر|ذهاب|عوده|مغادر|depart|travel|return|issued|اصدار/i.test(clause.replace(/جواز(?:ي)?\s+(?:ال)?سفر/g,'جواز')))continue;
  const key=/جواز|باسبور|passport/i.test(chosen[0])?'passportExpiry':'residencyExpiry';values[key].add(date);
 }
 const out={};for(const [key,dates]of Object.entries(values))if(dates.size===1)out[key]=[...dates][0];
 return out;
}
function readinessReferenceDate(request,now=Date.now()){
 return parseIsoDate(request?.departureDate)||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
}

function offerAirportMismatchNotice(offer){
 if(!offer?.request)return null;
 const outOrigin=city(offer.timing?.out?.origin||offer.request.origin);
 const backDestination=city(offer.timing?.back?.destination||offer.request.returnDestination);
 if(outOrigin&&backDestination&&outOrigin!==backDestination){
  return `📌 *ملاحظة مهمة للمسار:* الإقلاع بالذهاب من مطار *${outOrigin}* والعودة إلى مطار *${backDestination}* — يرجى الانتباه لاختلاف المطار عند التخطيط للمواصلات.`;
 }
 return null;
}

module.exports={
 readinessReferenceDate,
 parseIsoDate,
 daysBetweenDates,
 checkPassportValidityDate,
 checkResidencyValidityDate,
 extractMentionedExpiryDates,
 offerAirportMismatchNotice
};
