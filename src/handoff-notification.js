'use strict';
const {toFils,formatAED}=require('./money');
const clean=value=>typeof value==='string'||typeof value==='number'?String(value).replace(/[\r\n\u0000-\u001f*`_]/g,' ').trim().slice(0,140):'';
const present=value=>clean(value)||'غير محدد';
function formatHandoffCard(customer,summary={}){
 const r=summary.request||{},offer=summary.offer,p=r.passengers||{};
 const phone=String(customer||'').replace(/^\+/,''),validPhone=/^[1-9]\d{6,14}$/.test(phone);
 const count=value=>Number.isInteger(value)&&value>=0?String(value):'غير محدد';
 const date=r.departureRange?`${present(r.departureRange.start)} إلى ${present(r.departureRange.end)}`:present(r.departureDate);
 const lines=['*طلب متابعة مع موظف الحجوزات ✈️*',`👤 رقم العميل: ${validPhone?'+'+phone:present(customer)}`];
 if(validPhone)lines.push(`💬 https://wa.me/${phone}`);
 lines.push(`📍 المسار: ${present(r.origin)} ← ${present(r.destination)}`,`📅 الذهاب: ${date}`);
 if(r.tripType==='round_trip')lines.push(`📅 العودة: ${r.returnDate?present(r.returnDate):r.stayNights?`بعد ${present(r.stayNights)} ليلة`:'غير محددة'}`);
 lines.push(`👥 المسافرون: ${count(p.adults)} بالغ، ${count(p.children??0)} طفل، ${count(p.infants??0)} رضيع`);
 if(offer){
  const route=offer.request||r,provider=({flycham:'فلاي شام',airarabia:'العربية للطيران'})[offer.provider||route.provider];
  lines.push('',`*العرض المختار${Number.isInteger(offer.reference)?' — الخيار '+offer.reference:''}*`);
  if(provider)lines.push(`شركة الطيران: ${provider}`);
  lines.push(`المسار: ${present(route.origin)} ← ${present(route.destination)}`,`تاريخ العرض: ${present(route.departureDate)}`);
  for(const [key,label]of [['out','الذهاب'],['back','العودة']]){
   const leg=offer.timing?.[key];
   if(leg)lines.push(`${label}: ${present(leg.flight)} — المغادرة ${present(leg.departure)}، الوصول ${present(leg.arrival)}${key==='back'&&route.returnDate?' — '+present(route.returnDate):''}`);
  }
  if(offer.price?.currency==='AED'||!offer.price?.currency){
   try{const amount=toFils(offer.price?.sellingTotal,'Price');if(amount>0n)lines.push(`السعر المعروض: ${formatAED(amount)} درهم`);}catch{}
  }
  const weights=offer.price?.weights?.filter(w=>Number.isFinite(w?.kg)&&w.kg>=0).map(w=>w.kg+' كغ');
  if(weights?.length)lines.push(`الأمتعة: ${weights.join('، ')}`);
 }else lines.push('لم يُحدد عرض بعد؛ المطلوب مراجعة الخيارات المناسبة للطلب.');
 lines.push('','⚠️ أعد التحقق من السعر والتوفر لجميع المسافرين قبل تأكيد الحجز. هذه إحالة للمتابعة؛ لم يتم حجز أو إصدار تذكرة.');
 return lines.join('\n');
}
module.exports={formatHandoffCard};
