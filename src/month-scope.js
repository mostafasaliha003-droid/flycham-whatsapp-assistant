'use strict';
const {normalize,naturalDate,dubaiDay,iso}=require('./arabic-dates');
const parts=Object.freeze({first:[1,7],second:[8,14],third:[15,21],last:[22,null],middle:[11,20],whole:[1,null]});
function monthKey(year,month){return `${year}-${String(month).padStart(2,'0')}`;}
function explicitDates(t){return /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/.test(t);}
function namedPart(t){
 if(/(?:كامل|كله|كلو|كلهن|كلهم|بكامله|باكمله|كل ايام|اي يوم|اي وقت|ما بتفرق الايام|طول الشهر|الشهر كله)/.test(t))return 'whole';
 if(/(?:اول|الاول|1)\s*(?:اسبوع|أسبوع)|الاسبوع\s*(?:الاول|اول|1)|بداي[هة]|اوله|اول الشهر|اول اسبوع/.test(t))return 'first';
 if(/(?:ثاني|تاني|الثاني|التاني|2)\s*اسبوع|الاسبوع\s*(?:الثاني|التاني|ثاني|تاني|2)|^(?:الثاني|التاني|ثاني|تاني|2)$/.test(t))return 'second';
 if(/(?:ثالث|تالت|الثالث|التالت|3)\s*اسبوع|الاسبوع\s*(?:الثالث|التالت|ثالث|تالت|3)|^(?:الثالث|التالت|ثالث|تالت|3)$/.test(t))return 'third';
 if(/(?:رابع|الرابع|4)\s*اسبوع|الاسبوع\s*(?:الرابع|رابع|4)|اخر|نهاي[هة]|اخره|نهايته|^(?:الرابع|رابع|4)$/.test(t))return 'last';
 if(/منتصف|نص الشهر|بنص|نصه|وسط/.test(t))return 'middle';
 if(/^(?:الاول|اول|1)$/.test(t))return 'first';
 if(/^(?:كامل|كله|5)$/.test(t))return 'whole';
 return null;
}
function rangeFor(target,part,now){
 const today=iso(dubaiDay(now)),endDay=new Date(Date.UTC(target.year,target.month,0)).getUTCDate(),bounds=parts[part];
 if(!bounds)return null;
 const prefix=monthKey(target.year,target.month),start=`${prefix}-${String(bounds[0]).padStart(2,'0')}`,end=`${prefix}-${String(bounds[1]||endDay).padStart(2,'0')}`;
 if(end<today)return null;
 return {start:start<today?today:start,end,kind:part==='whole'?'confirmed_whole_month':'month_part'};
}
function monthPrompt(target,now){
 const available=Object.entries(parts).filter(([part])=>part!=='middle'&&rangeFor(target,part,now));
 const labels={first:'بداية الشهر',second:'الأسبوع الثاني',third:'الأسبوع الثالث',last:'آخر الشهر',whole:'الشهر كاملًا'};
 const lines=available.map(([part])=>{const r=rangeFor(target,part,now);return `• ${labels[part]}: ${r.start} إلى ${r.end}${part==='whole'?' — مقارنة أوسع وقد تحتاج وقتًا أطول':''}`;});
 return `أكيد 🌷 بأي جزء من شهر ${target.month}/${target.year} بتفضّل السفر، حتى أرتّبلك مقارنة مناسبة؟\n${lines.join('\n')}\nاختار الفترة اللي بتناسبك، ومنحافظ على باقي تفاصيل رحلتك.`;
}
function resolveMonthScope(raw,{now=Date.now(),pending=null,selection=null,request={}}={}){
 let t=normalize(String(raw)).replace(/ة/g,'ه').replace(/[؟?!،,.]+$/g,'').trim();
 // Exact customer dates/ranges and deliberately stated consecutive months are
 // already bounded choices; model-generated range slots alone are not consent.
 if(explicitDates(t)||naturalDate(t,now).dates?.length||/(?:شهر|اشهر|شهور|شهرين)\s*\d{1,2}\s*(?:و|او|،|,)\s*(?:شهر\s*)?\d{1,2}/.test(t))return {kind:'bypass',clear:true};
 // A negated month/part is not a choice. This also preserves clear corrections
 // such as "مو الشهر الجاي، هالشهر" or "مو أوله، آخره".
 t=t.replace(/(?:مو|مش|ليس|ما بدي|لا)\s+(?:بـ?|في)?\s*(?:الشهر\s*(?:الجاي|القادم|المقبل|الحالي|كامل|كله)|هالشهر|هذا الشهر|(?:بدايه|نهايه|منتصف|نص|اول|اخر|كامل)\s*(?:الشهر)?|اوله|اخره|نصه)/g,' ').replace(/\s+/g,' ').trim();
 const today=dubaiDay(now),next=/(?:الشهر|شهر)\s*(?:الجاي|القادم|المقبل|اللي بعده)|next month/.test(t),current=/(?:هالشهر|هلشهر|هل شهر|هال شهر|بهل شهر|هذا الشهر|الشهر الحالي|الشهر هاد|current month)/.test(t);
 const numeric=t.match(/(?:شهر|الشهر)\s*(1[0-2]|[1-9])(?!\d)/),mentionsMonth=next||current||numeric||/الشهر/.test(t);
 let target=null;
 if(next||current){const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+(next?1:0),1));target={year:d.getUTCFullYear(),month:d.getUTCMonth()+1};}
 else if(numeric){const month=Number(numeric[1]);target={year:today.getUTCFullYear()+(month<today.getUTCMonth()+1?1:0),month};}
 else if(pending?.year&&pending?.month)target={year:pending.year,month:pending.month};
 else if(mentionsMonth){const known=request.departureRange?.start?.match(/^(\d{4})-(\d{2})-/);target=known?{year:Number(known[1]),month:Number(known[2])}:{year:today.getUTCFullYear(),month:today.getUTCMonth()+1};}
 if(!target)return {kind:'none'};
 let part=namedPart(t);
 if(!part&&selection?.part&&selection.year===target.year&&selection.month===target.month&&mentionsMonth)part=selection.part;
 if(part){
  const range=rangeFor(target,part,now);
  if(range)return {kind:'chosen',target,part,range,selection:{...target,part}};
  return {kind:'ask',pending:target,question:'هالفترة من الشهر صارت ضمن تواريخ مضت 🌷 بتفضّل بقية هالشهر، أو الشهر الجاي؟'};
 }
 if(mentionsMonth||pending)return {kind:'ask',pending:target,question:monthPrompt(target,now)};
 return {kind:'none'};
}
module.exports={resolveMonthScope,rangeFor,monthPrompt};
