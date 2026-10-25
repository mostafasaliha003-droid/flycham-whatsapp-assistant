'use strict';
const {airportCode}=require('./airports');
const {renderComparison}=require('./quote-comparison');
const PROVIDERS={airarabia:'العربية للطيران',flycham:'فلاي شام'};
const NAMES={SHJ:'الشارقة',DXB:'دبي',AUH:'أبوظبي',DWC:'آل مكتوم',DAM:'دمشق',ALP:'حلب',LTK:'اللاذقية',RAK:'رأس الخيمة',FJR:'الفجيرة'};
const amount=v=>typeof v==='string'&&/^\d{1,7}\.\d{2}$/.test(v)&&BigInt(v.replace('.',''))>0n;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
function airport(value){const code=airportCode(value);return NAMES[code]||code||String(value||'').replace(/[\r\n*_`]/g,' ').slice(0,80);}
function safeFlight(value){if(typeof value!=='string'||!value.trim()||value.length>40||/[\r\n*_`]/.test(value))throw Error('OFFER_DIGEST_INVALID_OFFER');return value.trim();}
function time(value,legDate){
 if(typeof value!=='string'||value.length>120)throw Error('OFFER_DIGEST_INVALID_OFFER');
 const m=value.match(/(?:^|[ T])([01]?\d|2[0-3]):([0-5]\d)(?=$|[^\d])/);if(!m)throw Error('OFFER_DIGEST_INVALID_OFFER');
 const suffix=value.match(/\b(?:am|pm)\b/i),day=value.match(/\b\d{4}-\d{2}-\d{2}\b/);
 return m[1].padStart(2,'0')+':'+m[2]+(suffix?' '+suffix[0].toUpperCase():'')+(day&&day[0]!==legDate?' ('+day[0]+')':'');
}
function checked(value){if(!Number.isFinite(value)||value<0)throw Error('OFFER_DIGEST_INVALID_OFFER');return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));}
function validateOffer(o){
 if(!o||!Object.hasOwn(PROVIDERS,o.provider)||!Number.isInteger(o.reference)||o.reference<1||o.reference>80||!o.request||!['one_way','round_trip'].includes(o.request.tripType)||!date(o.request.departureDate)||!amount(o.price?.sellingTotal)||!Array.isArray(o.price?.weights)||!o.price.weights.length||o.price.weights.some(w=>!Number.isFinite(w.kg)||w.kg<0||w.kg>100))throw Error('OFFER_DIGEST_INVALID_OFFER');
 if(!airportCode(o.request.origin)||!airportCode(o.request.destination)||o.price.currency&&o.price.currency!=='AED')throw Error('OFFER_DIGEST_INVALID_OFFER');
 if(o.request.tripType==='round_trip'&&(!date(o.request.returnDate)||!o.timing?.back))throw Error('OFFER_DIGEST_INVALID_OFFER');
 safeFlight(o.timing?.out?.flight);time(o.timing?.out?.departure,o.request.departureDate);time(o.timing?.out?.arrival,o.request.departureDate);checked(o.checkedAt);
 if(o.timing?.back){if(!date(o.request.returnDate))throw Error('OFFER_DIGEST_INVALID_OFFER');safeFlight(o.timing.back.flight);time(o.timing.back.departure,o.request.returnDate);time(o.timing.back.arrival,o.request.returnDate);}
 return o;
}
function row(o,requested={}){
 const r=o.request,t=o.timing,weights=[...new Set(o.price.weights.map(w=>w.kg))].map(kg=>kg===0?'بدون أمتعة مسجّلة':kg+' كيلو مسجّل').join(' / ');
 const lines=[`*الخيار ${o.reference} — ${PROVIDERS[o.provider]}*`,`📅 ${r.departureDate} | من ${airport(r.origin)} إلى ${airport(r.destination)}`,`✈️ ${safeFlight(t.out.flight)} | الإقلاع ${time(t.out.departure,r.departureDate)} — الوصول ${time(t.out.arrival,r.departureDate)}`];
 if(date(requested.departureDate)&&requested.departureDate!==r.departureDate){const delta=Math.round((Date.parse(r.departureDate+'T00:00:00Z')-Date.parse(requested.departureDate+'T00:00:00Z'))/86400000),distance=Math.abs(delta);lines.splice(1,0,`بديل ${delta<0?'قبل':'بعد'} موعدك ${distance===1?'بيوم':distance===2?'بيومين':`بـ${distance} أيام`}`);}
 if(t.back)lines.push(`↩️ ${r.returnDate} | ${safeFlight(t.back.flight)} | الإقلاع ${time(t.back.departure,r.returnDate)} — الوصول ${time(t.back.arrival,r.returnDate)}`);
 lines.push(`🧳 ${weights}${o.provider==='flycham'?' + عشرة كيلو يد':''}`,`💰 *الإجمالي: ${o.price.sellingTotal} درهم*`);
 if(o.provider==='flycham'&&amount(o.price.voucherValue))lines.push(`🎁 فاوجر ${o.price.voucherValue} درهم للاستخدام القادم`);
 lines.push(`آخر مراجعة: ${checked(o.checkedAt)} بتوقيت دبي`);return lines.join('\n');
}
function header(request={},isMore=false,hasOffers=true){
 const lines=[isMore?'*تكملة خيارات رحلتك ✈️ | مجموعة الرمال*':'*خيارات رحلتك ✈️ | مجموعة الرمال*'];
 if(airportCode(request.origin)&&airportCode(request.destination))lines.push(`طلبك: من ${airport(request.origin)} إلى ${airport(request.destination)}`);
 if(request.departureRange&&date(request.departureRange.start)&&date(request.departureRange.end))lines.push(`📅 الفترة: ${request.departureRange.start} إلى ${request.departureRange.end}`);
 else if(date(request.departureDate))lines.push(`📅 التاريخ المطلوب: ${request.departureDate}`);
 const p=request.passengers;
 if(Number.isInteger(p?.adults)&&Number.isInteger(p?.children)&&Number.isInteger(p?.infants)){
  lines.push(`👤 ${p.adults} بالغ${p.children?'، '+p.children+' طفل':''}${p.infants?'، '+p.infants+' رضيع':''}${request.tripType==='round_trip'?' | ذهاب وعودة':request.tripType==='one_way'?' | ذهاب فقط':''}`);
  if((p.children||p.infants)&&Array.isArray(p.ages)&&p.ages.length===p.children+p.infants&&p.ages.every(n=>Number.isInteger(n)&&n>=0&&n<18))lines.push('أعمار الأطفال والرضّع وقت السفر: '+p.ages.join('، '));
 }
 if(hasOffers)lines.push('رتّبتلك الأسعار من الأقل ضمن الخيارات المتحققة؛ تفاصيل المطار والوزن موضحة بكل عرض 🌷');return lines.join('\n');
}
function supplierSummary(snapshot){
 const statuses=(Array.isArray(snapshot.statuses)?snapshot.statuses:[]).filter(s=>s&&Object.hasOwn(PROVIDERS,s.provider));
 const offers=Array.isArray(snapshot.offers)?snapshot.offers:[],lines=[];
 const providers=['flycham','airarabia'].filter(provider=>statuses.some(s=>s.provider===provider)||(Array.isArray(snapshot.providers)?snapshot.providers:[]).includes(provider));
 for(const provider of providers){
  const own=statuses.filter(s=>s.provider===provider),ownOffers=offers.filter(o=>o.provider===provider),requestedOrigin=airportCode(snapshot.request?.origin);
  const origins=[...new Set([...own.map(s=>airportCode(s.origin)),...ownOffers.map(o=>airportCode(o.request.origin))].filter(Boolean))];
  if(requestedOrigin&&origins.length&&!origins.includes(requestedOrigin)){
   const actual=origins.map(airport).join(' و');
   lines.push(own.length&&own.every(s=>airportCode(s.origin))?`مقارنة ${PROVIDERS[provider]} هنا من ${actual}؛ لا تشمل فحص المغادرة من ${airport(requestedOrigin)}.`:`عروض ${PROVIDERS[provider]} المتحققة هنا من ${actual}؛ لم يتأكد عرض من ${airport(requestedOrigin)}.`);
  }
  const groups=new Map();
  for(const s of own){const origin=airportCode(s.origin),destination=airportCode(s.destination);if(!origin||!destination)continue;const key=[origin,destination,s.phase||'exact'].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(s);}
  let described=0;
  for(const group of groups.values()){
   const first=group[0],origin=airportCode(first.origin),destination=airportCode(first.destination),days=new Set(group.map(s=>s.date));
   if(ownOffers.some(o=>airportCode(o.request.origin)===origin&&airportCode(o.request.destination)===destination&&days.has(o.request.departureDate)))continue;
   const route=`${PROVIDERS[provider]} — من ${airport(origin)} إلى ${airport(destination)}`;
   const dates=[...days].filter(date).sort(),scope=(first.phase==='alternatives'?'الأيام القريبة المفحوصة':'الأيام المفحوصة')+(dates.length?` (${dates[0]}${dates.length>1?' إلى '+dates.at(-1):''})`:'');
   // A route/phase with any unconfirmed child must never become a claim of no inventory.
   if(group.every(s=>date(s.date)&&['no_flights','sold_out'].includes(s.status))){
    const outcome=group.every(s=>s.status==='no_flights')?'لا توجد رحلات متاحة':group.every(s=>s.status==='sold_out')?'لا تتوفر مقاعد لهذا الطلب':'لم يظهر خيار متاح';
    lines.push(`${route}: ${outcome} ضمن ${scope}.`);
   }else lines.push(`${route}: لم يتأكد عرض جاهز حتى الآن؛ هذا لا يعني عدم وجود رحلات أو امتلاء المقاعد.`);
   if(++described===2)break;
  }
  if(!groups.size&&!ownOffers.length)lines.push(`${PROVIDERS[provider]}: لم يتأكد عرض جاهز لهذه الشركة حتى الآن؛ هذا لا يعني عدم وجود رحلات.`);
 }
 return lines;
}
function footer(snapshot,shown,remaining){
 const lines=supplierSummary(snapshot);
 if(shown.some(o=>o.provider==='flycham'&&amount(o.price.voucherValue)))lines.push('فاوجر فلاي شام يصدر بعد إصدار التذكرة، صالح سنة للاستخدام القادم ضمن خدماتنا؛ لا يُخصم من السعر المعروض.');
 const uncertain=(snapshot.statuses||[]).some(s=>['pending','partial','unverified','auth_required'].includes(s.status));
 if(uncertain||snapshot.ready===false)lines.push('هذه الخيارات تأكدت؛ بعض الأيام أو التواقيت الأخرى لم يكتمل التحقق منها، لذلك المقارنة لا تثبت الأرخص في كامل الفترة.');
 lines.push('التواقيت كما تظهر لدى الشركة. السعر والتوفر يُعاد التحقق منهما قبل متابعة التثبيت؛ لم يُنشأ حجز.');
 if(remaining)lines.push(`في ${remaining} خيار متأكد إضافي لم يُعرض ضمن هذه الرسالة. اكتب «المزيد» لبقية التواقيت، أو اذكر رقم الخيار المناسب إلك.`);
 else lines.push('أي رقم خيار بناسبك لنكمل عليه؟');return lines.join('\n');
}
function noOffers(snapshot,maxLength){
 let text=typeof snapshot.reply==='string'?snapshot.reply:undefined;
 if(!text&&snapshot.children&&snapshot.providers)text=renderComparison(snapshot);
 if(text&&text.length<=maxLength)return text;
 const lines=[header(snapshot.request,false,false),snapshot.ready===false?'البحث لسه قيد التحقق؛ منرسل المقارنة بعد اكتمال مراجعة الخيارات.':'لم يتأكد سعر جاهز للإرسال لهذا الطلب؛ هالنتيجة لا تعني عدم وجود رحلات أو امتلاء المقاعد.'];
 if(snapshot.ready!==false)lines.push('إذا مواعيدك مرنة، بتحب نوسّع البحث سبعة أيام بعد آخر تاريخ طلبته، مع الحفاظ على باقي التفاصيل؟');
 return lines.join('\n\n');
}
function buildOfferDigest(snapshot={},options={}){
 const maxLength=options.maxLength===undefined?3900:options.maxLength;
 if(!Number.isInteger(maxLength)||maxLength<1200||maxLength>3900)throw Error('OFFER_DIGEST_BUDGET_INVALID');
 const input=Array.isArray(snapshot.offers)?snapshot.offers:[],seen=new Set(),all=[];
 for(const o of input){validateOffer(o);if(seen.has(o.reference))throw Error('OFFER_DIGEST_REFERENCE_COLLISION');seen.add(o.reference);all.push(o);}
 const excluded=new Set(Array.isArray(options.excludeRefs)?options.excludeRefs.filter(Number.isInteger):[]);
 const pending=all.filter(o=>!excluded.has(o.reference)).sort((a,b)=>{const x=BigInt(a.price.sellingTotal.replace('.','')),y=BigInt(b.price.sellingTotal.replace('.',''));return x<y?-1:x>y?1:a.request.departureDate.localeCompare(b.request.departureDate)||a.reference-b.reference;});
 if(!all.length){const text=noOffers(snapshot,maxLength);if(text.length>maxLength)throw Error('OFFER_DIGEST_BUDGET_INVALID');return {text,shownOffers:[],remainingOffers:[],totalCount:0};}
 if(!pending.length)return {text:'كل الخيارات المتأكدة ضمن هالمقارنة سبق إرسالها. اذكر رقم الخيار اللي حابب نراجعه معك 🌷',shownOffers:[],remainingOffers:[],totalCount:all.length};
 const start=header(snapshot.request,excluded.size>0),shown=[],rows=[];
 for(const o of pending){const candidate=[...shown,o],candidateRows=[...rows,row(o,snapshot.request)],end=footer(snapshot,candidate,pending.length-candidate.length),text=[start,...candidateRows,end].join('\n\n');if(text.length>maxLength)break;shown.push(o);rows.push(candidateRows.at(-1));}
 if(!shown.length)throw Error('OFFER_DIGEST_ROW_TOO_LARGE');
 const remaining=pending.slice(shown.length),text=[start,...rows,footer(snapshot,shown,remaining.length)].join('\n\n');
 return {text,shownOffers:shown,remainingOffers:remaining,totalCount:all.length};
}
module.exports={buildOfferDigest};
