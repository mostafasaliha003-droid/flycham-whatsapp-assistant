'use strict';
const {dubaiDay,iso,addDays}=require('./arabic-dates');
const PROVIDERS=Object.freeze(['airarabia','flycham']);
const LABELS={airarabia:'العربية للطيران',flycham:'فلاي شام'};
const NEGATIVE=new Set(['no_flights','sold_out']);
const STATUSES=new Set(['available','no_flights','sold_out','unverified','auth_required','partial']);
const city=v=>({SHJ:'الشارقة',Sharjah:'الشارقة',الشارقه:'الشارقة',DAM:'دمشق',Damascus:'دمشق',الشام:'دمشق',شام:'دمشق'}[v]||v);
function sameRequest(a,b){
 return ['origin','destination'].every(k=>city(a?.[k])===city(b?.[k]))&&['departureDate','returnDate','tripType'].every(k=>(a?.[k]||null)===(b?.[k]||null))&&
  (a?.baggageRequest?.checkedWeightKg??30)===(b?.baggageRequest?.checkedWeightKg??30)&&
  ['adults','children','infants'].every(k=>(a?.passengers?.[k]||0)===(b?.passengers?.[k]||0));
}
function offerKey(o){return JSON.stringify([o.provider,o.request.departureDate,o.request.returnDate,o.timing.out.flight,o.timing.out.departure,o.timing.back?.flight,o.timing.back?.departure]);}
// Only authenticated worker metadata or caller-vetted fresh catalog records may
// supply offers. Never parse prices, inventory or flights from generated prose.
function verifiedOffer(offer,request,provider){
 if(!PROVIDERS.includes(provider)||!sameRequest(offer?.request,request)||(offer.provider||offer.request?.provider||'airarabia')!==provider)return null;
 if(!/^\d{1,7}\.\d{2}$/.test(offer.price?.sellingTotal||'')||Number(offer.price.sellingTotal)<=0||offer.price.currency&&offer.price.currency!=='AED')return null;
 const timing=offer.timing;if(!timing?.out?.flight||!timing.out.departure||!timing.out.arrival||request.tripType==='round_trip'&&(!timing.back?.flight||!timing.back.departure||!timing.back.arrival))return null;
 if(provider==='flycham'&&!/^XH\s*\d/.test(timing.out.flight))return null;
 const target=request.baggageRequest?.checkedWeightKg??30;
 const weights=offer.price.weights;
 if(!weights?.length||!weights.every(w=>Number.isFinite(w.kg)&&w.kg>=target))return null;
 // Strip model text, recipient identifiers and unrelated supplier metadata.
 return {provider,request:structuredClone(request),timing:structuredClone(timing),price:{currency:'AED',sellingTotal:offer.price.sellingTotal,weights:structuredClone(weights),...(provider==='flycham'?{voucherValue:request.tripType==='round_trip'?'25.00':'10.00'}:{})},checkedAt:Number.isFinite(offer.checkedAt)?offer.checkedAt:Number.isFinite(Date.parse(offer.verifiedAt))?Date.parse(offer.verifiedAt):Date.now()};
}
function nearbyRequests(request,now=Date.now()){
 if(request.departureRange||!/^\d{4}-\d{2}-\d{2}$/.test(request.departureDate||''))return [];
 const base=new Date(request.departureDate+'T00:00:00Z');if(!Number.isFinite(+base)||iso(base)!==request.departureDate)return [];
 const today=iso(dubaiDay(now)),result=[];
 for(const delta of [-1,1,-2,2,-3,3]){
  const departureDate=iso(addDays(base,delta));if(departureDate<today)continue;
  const candidate={...structuredClone(request),departureDate,departureRange:null};
  if(request.tripType==='round_trip'){
   if(Number.isInteger(request.stayNights)&&request.stayNights>0)candidate.returnDate=iso(addDays(new Date(departureDate+'T00:00:00Z'),request.stayNights));
   // A stated return is fixed unless the customer specified a stay duration.
   if(!candidate.returnDate||candidate.returnDate<departureDate)continue;
  }else candidate.returnDate=null;
  result.push({request:candidate,delta});
 }
 return result;
}
function completionStatus(data={},offers=[],request={}){
 const supplied=data.availability||data.status;
 const days=request.departureRange?null:[request.departureDate];
 const coverage=Array.isArray(data.coverage)?data.coverage:[];
 const relevant=days?coverage.filter(c=>days.includes(c.date)):coverage;
 const complete=Boolean(relevant.length)&&(!days||days.every(d=>relevant.some(c=>c.date===d)))&&relevant.every(c=>['confirmed','no_flights','sold_out'].includes(c.status));
 if(offers.length)return data.outcome==='partial'||supplied==='partial'||!complete?'partial':'available';
 if(['auth_required','authentication_required'].includes(supplied))return 'auth_required';
 // No availability is inferred from a timeout, missing rows or error string.
 if(supplied==='sold_out'&&data.availabilityEvidence==='supplier-explicit')return 'sold_out';
 if(complete&&relevant.every(c=>c.status==='no_flights'))return 'no_flights';
 if(supplied==='no_flights'&&data.availabilityEvidence==='supplier-explicit')return 'no_flights';
 return 'unverified';
}
function statusText(status){return {available:'سعر متأكد',partial:'تأكدت عروض؛ بقية التواقيت لم يكتمل فحصها',no_flights:'لم تظهر رحلات في نتائج المصدر لهذا التاريخ',sold_out:'المصدر يؤكد عدم توفر مقاعد لهذا الطلب',auth_required:'تعذر فحص الشركة الآن لأن البوابة تحتاج تحقق دخول',unverified:'لم يتأكد عرض الشركة الآن'}[status]||'الفحص جارٍ';}
function formatOffer(o){
 const r=o.request,t=o.timing,checkedAt=new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',dateStyle:'short',timeStyle:'short'}).format(new Date(o.checkedAt||Date.now())),weights=o.price.weights.map(w=>w.kg===0?'بدون أمتعة مسجلة':w.kg+' كيلو مسجل').join(' / ');
 return `*الخيار ${o.reference} — ${LABELS[o.provider]}*\nالمسار: من مطار ${r.origin} إلى مطار ${r.destination}\n📅 الذهاب: ${r.departureDate}\nرقم الرحلة: ${t.out.flight}\nالإقلاع: ${t.out.departure}\nالوصول: ${t.out.arrival}${t.back?`\n📅 العودة: ${r.returnDate}\nرقم الرحلة: ${t.back.flight}\nالإقلاع: ${t.back.departure}\nالوصول: ${t.back.arrival}`:''}\n🧳 ${weights}${o.provider==='flycham'?' +10 كيلو يد':''}\n💰 *الإجمالي: ${o.price.sellingTotal} درهم*\nآخر تحقق: ${checkedAt} بتوقيت دبي${o.provider==='flycham'?`\n🎁 فاوجر ${o.price.voucherValue} درهم بعد إصدار التذكرة، صالح سنة للاستخدام القادم ضمن خدماتنا؛ لا يخصم من السعر الحالي.`:''}`;
}
function renderComparison(parent,{excludeOfferKeys=[]}={}){
 const sent=new Set(excludeOfferKeys);
 const exact=parent.children.filter(c=>c.phase==='exact'),alternatives=parent.children.filter(c=>c.phase==='alternatives');
 const parts=['*مقارنة رحلتك | مجموعة الرمال*',`من ${parent.request.origin} إلى ${parent.request.destination}`,parent.request.departureRange?`الفترة المطلوبة: ${parent.request.departureRange.start} إلى ${parent.request.departureRange.end}`:`التاريخ المطلوب: ${parent.request.departureDate}`,'لشخص بالغ واحد، '+(parent.request.tripType==='round_trip'?'ذهاب وعودة':'ذهاب فقط')];
 for(const provider of parent.providers){
  const children=exact.filter(c=>c.provider===provider),allOffers=children.flatMap(c=>c.offers||[]),offers=allOffers.filter(o=>!sent.has(offerKey(o))).sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal));
  parts.push(`\n*${LABELS[provider]} — التاريخ المطلوب*`);
  if(offers.length)parts.push(offers.map(formatOffer).join('\n\n'));else if(allOffers.length)parts.push('العروض المتأكدة لهذه الشركة سبق إرسالها أعلاه، وأرقام خياراتها محفوظة.');
  const statuses=[...new Set(children.map(c=>c.status))];if(!offers.length||statuses.some(s=>s!=='available'))parts.push(statuses.map(statusText).join('؛ '));
 }
 if(alternatives.length){
  parts.push('\n*بدائل قريبة من التاريخ المطلوب*');
  const allOffers=alternatives.flatMap(c=>(c.offers||[]).map(o=>({o,delta:c.delta}))),offers=allOffers.filter(({o})=>!sent.has(offerKey(o))).sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta)||Number(a.o.price.sellingTotal)-Number(b.o.price.sellingTotal));
  if(offers.length)parts.push(offers.map(({o,delta})=>`*${delta<0?'قبل':'بعد'} موعدك بـ${Math.abs(delta)} يوم*\n${formatOffer(o)}`).join('\n\n'));
  else parts.push(allOffers.length?'البدائل المتأكدة سبق إرسالها أعلاه، وأرقام خياراتها محفوظة.':alternatives.some(c=>c.status==='pending')?'عم نفحص الأيام القريبة؛ منرسل فقط الأسعار المتأكدة.':'لم يتأكد عرض في الأيام القريبة التي فحصناها؛ هالنتيجة ما تعني عدم وجود رحلات في الأيام التي تعذر فحصها.');
  const uncertain=alternatives.filter(c=>['partial','unverified','auth_required','pending'].includes(c.status));if(uncertain.length&&offers.length)parts.push('هذه البدائل تأكدت؛ بعض الأيام أو التواقيت القريبة لم يكتمل فحصها.');
 }
 parts.push('\nالأسعار تشمل الرسوم وعمولة الخدمة، حسب الوزن الموضح لكل عرض. المواعيد كما تظهر في البوابة. السعر والتوفر قابلان للتغير حتى إصدار التذكرة؛ لم يتم إنشاء حجز.');
 return parts.join('\n');
}
module.exports={PROVIDERS,NEGATIVE,STATUSES,sameRequest,offerKey,verifiedOffer,nearbyRequests,completionStatus,renderComparison,formatOffer};
