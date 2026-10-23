'use strict';
const digits=t=>String(t).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const normalize=t=>digits(t).replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/[ًٌٍَُِّْ]/g,'').replace(/\s+/g,' ').trim();
const iso=d=>d.toISOString().slice(0,10);
function dubaiDay(now=Date.now()){return new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))+'T00:00:00Z');}
function addDays(date,n){const d=new Date(date);d.setUTCDate(d.getUTCDate()+n);return d;}
function naturalDate(text,now=Date.now()){
 const t=normalize(text),today=dubaiDay(now),day=iso(today);
 const explicit=[...t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)].map(m=>{
   const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));return d.getUTCDate()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCFullYear()===+m[3]?iso(d):null;});
 if(explicit.length)return {dates:explicit,invalid:explicit.some(d=>!d||d<day)};
 if(/بعد\s*(?:بكرا|بكره|بكري|غد)/.test(t))return {dates:[iso(addDays(today,2))]};
 if(/(?:بكرا|بكره|بكري|غدا|غد)(?:\s|$|[،,.])/.test(t))return {dates:[iso(addDays(today,1))]};
 if(/(?:^|\s)اليوم(?:\s|$|[،,.])/.test(t))return {dates:[day]};
 const names=[['الاحد',0],['الاثنين',1],['الاتنين',1],['الثلاثاء',2],['التلاتا',2],['الثلاثا',2],['الاربعاء',3],['الاربعا',3],['الخميس',4],['الجمعة',5],['الجمعه',5],['السبت',6]];
 const weekday=names.find(([name])=>t.includes(name));
 if(weekday){let delta=(weekday[1]-today.getUTCDay()+7)%7;if(delta===0)delta=7;return {dates:[iso(addDays(today,delta))]};}
 // Explicit consecutive months describe a period, never a single departure day.
 const monthNumbers=t.match(/(?:خلال|ضمن|بـ?|في)?\s*(?:شهر|الشهر|اشهر|شهور|شهرين)\s*(1[0-2]|[1-9])(?:\s*(?:و|او|،|,)\s*(?:شهر\s*)?(1[0-2]|[1-9]))?(?!\d|\s*[-/.]\s*\d)/);
 if(monthNumbers){
   const firstMonth=Number(monthNumbers[1]),lastMonth=Number(monthNumbers[2]||monthNumbers[1]);
   let year=today.getUTCFullYear();if(firstMonth<today.getUTCMonth()+1)year++;
   const lastYear=year+(lastMonth<firstMonth?1:0);
   const start=new Date(Date.UTC(year,firstMonth-1,1)),end=new Date(Date.UTC(lastYear,lastMonth,0));
   return {dates:[],range:{start:iso(start)<day?day:iso(start),end:iso(end),kind:'explicit_months'}};
 }
 const next=/(?:الجاي|القادم|المقبل|اللي بعده)/.test(t);
 if(/(?:هالاسبوع|هل اسبوع|هال اسبوع|بهل اسبوع|هذا الاسبوع|هال اسبوع|الاسبوع)/.test(t)){
   // Monday-start calendar week, Dubai dates. Never include past days.
   const monday=addDays(today,-((today.getUTCDay()+6)%7));
   const start=next?addDays(monday,7):today,end=addDays(monday,next?13:6);
   return {dates:[],range:{start:iso(start),end:iso(end),kind:next?'next_week':'this_week'}};
 }
 if(/(?:هالشهر|هل شهر|هال شهر|بهل شهر|هذا الشهر|الشهر)/.test(t)){
   const first=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+(next?1:0),1));
   const end=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));
   return {dates:[],range:{start:next?iso(first):day,end:iso(end),kind:next?'next_month':'this_month'}};
 }
 return {dates:[]};
}
module.exports={naturalDate,normalize,dubaiDay,addDays,iso};
