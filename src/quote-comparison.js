'use strict';
const {dubaiDay,iso,addDays}=require('./arabic-dates');
const PROVIDERS=Object.freeze(['airarabia','flycham']);
const LABELS={airarabia:'العربية للطيران',flycham:'فلاي شام'};
const NEGATIVE=new Set(['no_flights','sold_out']);
const STATUSES=new Set(['available','no_flights','sold_out','unverified','auth_required','partial']);
const city=v=>({DXB:'دبي',Dubai:'دبي',AUH:'أبوظبي','Abu Dhabi':'أبوظبي',ابوظبي:'أبوظبي','ابو ظبي':'أبوظبي',DWC:'آل مكتوم','Al Maktoum':'آل مكتوم','ال مكتوم':'آل مكتوم',المكتوم:'آل مكتوم',ALP:'حلب',Aleppo:'حلب',حلاب:'حلب',SHJ:'الشارقة',Sharjah:'الشارقة',الشارقه:'الشارقة',DAM:'دمشق',Damascus:'دمشق',الشام:'دمشق',شام:'دمشق'}[v]||v);
function sameRequest(a,b){
 return ['origin','destination'].every(k=>city(a?.[k])===city(b?.[k]))&&['departureDate','returnDate','tripType'].every(k=>(a?.[k]||null)===(b?.[k]||null))&&
  (a?.baggageRequest?.checkedWeightKg??30)===(b?.baggageRequest?.checkedWeightKg??30)&&
  ['adults','children','infants'].every(k=>(a?.passengers?.[k]||0)===(b?.passengers?.[k]||0));
}
function offerKey(o){return JSON.stringify([o.provider,city(o.request.origin),city(o.request.destination),o.request.departureDate,o.request.returnDate,o.timing.out.flight,o.timing.out.departure,o.timing.back?.flight,o.timing.back?.departure]);}
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
function statusText(status){return {available:'سعر متأكد',partial:'تأكدت عروض؛ بقية التواقيت لم يكتمل فحصها',no_flights:'راجعت الفترة المطلوبة؛ ما في رحلات متاحة على هالمسار بهالتواريخ',sold_out:'راجعت الرحلة المطلوبة؛ ما في مقاعد متاحة لهالطلب حاليًا',auth_required:'عرض هالشركة لسه غير مؤكد؛ منرسل لك السعر بعد التحقق، حتى تختار على أساس واضح',unverified:'لم يتأكد عرض الشركة الآن'}[status]||'الفحص جارٍ';}
function formatOffer(o){
 const r=o.request,t=o.timing,checkedAt=new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',dateStyle:'short',timeStyle:'short'}).format(new Date(o.checkedAt||Date.now())),weights=o.price.weights.map(w=>w.kg===0?'بدون أمتعة مسجلة':w.kg+' كيلو مسجل').join(' / ');
 return `*الخيار ${o.reference} — ${LABELS[o.provider]}*\nالمسار: من مطار ${city(r.origin)} إلى مطار ${city(r.destination)}\n📅 الذهاب: ${r.departureDate}\nرقم الرحلة: ${t.out.flight}\nالإقلاع: ${t.out.departure}\nالوصول: ${t.out.arrival}${t.back?`\n📅 العودة: ${r.returnDate}\nرقم الرحلة: ${t.back.flight}\nالإقلاع: ${t.back.departure}\nالوصول: ${t.back.arrival}`:''}\n🧳 ${weights}${o.provider==='flycham'?' +10 كيلو يد':''}\n💰 *الإجمالي: ${o.price.sellingTotal} درهم*\nآخر تحقق: ${checkedAt} بتوقيت دبي${o.provider==='flycham'?`\n🎁 فاوجر ${o.price.voucherValue} درهم بعد إصدار التذكرة، صالح سنة للاستخدام القادم ضمن خدماتنا؛ لا يخصم من السعر الحالي.`:''}`;
}
function renderComparison(parent,{excludeOfferKeys=[]}={}){
 const sent=new Set(excludeOfferKeys),allChildren=parent.children||[],pending=allChildren.some(c=>c.status==='pending');
 const exact=allChildren.filter(c=>c.phase==='exact'),alternatives=allChildren.filter(c=>c.phase==='alternatives'),airportChildren=allChildren.filter(c=>c.phase==='airports');
 const allParentOffers=allChildren.flatMap(c=>c.offers||[]);
 const parts=['*مقارنة رحلتك | مجموعة الرمال*',`من ${city(parent.request.origin)} إلى ${city(parent.request.destination)}`,parent.request.departureRange?`الفترة المطلوبة: ${parent.request.departureRange.start} إلى ${parent.request.departureRange.end}`:`التاريخ المطلوب: ${parent.request.departureDate}`,'لشخص بالغ واحد، '+(parent.request.tripType==='round_trip'?'ذهاب وعودة':'ذهاب فقط')];
 function renderGroup(children,provider,request){
  const all=children.flatMap(c=>c.offers||[]),fresh=all.filter(o=>!sent.has(offerKey(o))).sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal));
  if(fresh.length)parts.push(fresh.map(formatOffer).join('\n\n'));
  else if(all.length)parts.push('العروض المتأكدة لهذه الشركة سبق إرسالها أعلاه، وأرقام خياراتها محفوظة.');
  if(!children.length){parts.push('لم يبدأ فحص خيارات هذه الشركة لهذا المطار؛ لا يوجد سعر متأكد معروض له.');return;}
  if(children.some(c=>c.status==='pending')){parts.push('خيارات هذا المطار لسه قيد التحقق، ومنرسل كل عرض بعد تأكيد سعره.');return;}
  if(all.length){if(children.some(c=>c.status!=='available'))parts.push('العروض الموضحة متأكدة؛ بعض الأيام أو التواقيت الأخرى لم يكتمل فحصها.');return;}
  const route=`من مطار ${city(request.origin)} إلى مطار ${city(request.destination)} على ${LABELS[provider]}`;
  if(children.every(c=>c.status==='no_flights')){
   parts.push(`راجعت الفترة المطلوبة ${route}؛ ما في رحلات متاحة بهالتواريخ على هالمسار. هالنتيجة تخص هالشركة والفترة اللي شيّكتها.`);
   const sameAirportOffers=allParentOffers.filter(o=>o.provider!==provider&&city(o.request?.origin)===city(request.origin)&&city(o.request?.destination)===city(request.destination)&&
    (parent.request.departureRange?o.request.departureDate>=parent.request.departureRange.start&&o.request.departureDate<=parent.request.departureRange.end:o.request.departureDate===parent.request.departureDate));
   if(sameAirportOffers.length)parts.push(`والخبر الحلو، لقيتلك بديل متأكد على ${[...new Set(sameAirportOffers.map(o=>LABELS[o.provider]))].join(' و')} من ${city(request.origin)}؛ تفاصيل المواعيد والأسعار موضحة ضمن الخيارات.`);
   if(city(request.origin)==='أبوظبي'&&!airportChildren.length)parts.push('المغادرة من دبي أو الشارقة ممكن تكون بديلًا للمقارنة إذا بتناسبك؛ لم يتأكد عرض منهما ضمن هالفحص.');
  }
  else if(children.every(c=>NEGATIVE.has(c.status)))parts.push(`ما ظهر خيار متاح ${route} ضمن الأيام والتواقيت اللي اكتمل فحصها.`);
  else parts.push(`لم يتأكد سعر جاهز للإرسال ${route} حتى الآن. هالنتيجة ما تعني أن الرحلات غير موجودة أو المقاعد ممتلئة.`);
 }
 for(const provider of parent.providers){
  const routing=parent.airportRouting?.[provider],side=routing?.airportSide==='destination'?'destination':'origin';
  const ownExact=exact.filter(c=>c.provider===provider),ownAirports=airportChildren.filter(c=>c.provider===provider);
  parts.push(`\n*${LABELS[provider]} — التاريخ المطلوب*`);
  if(ownExact.length)renderGroup(ownExact,provider,ownExact[0].request||parent.request);
  else if(routing?.excludedRequested){
   const airport=city(routing.requestedAirport||parent.request[side]);
   parts.push(`ل${side==='origin'?'لمغادرة من':'لوصول إلى'} مطار ${airport}، ما عندي عرض متأكد على ${LABELS[provider]}. المقارنة مع هذه الشركة تشمل المطارات البديلة الموضحة أدناه، مع بقاء ${side==='origin'?'مطار مغادرتك':'مطار وصولك'} الأساسي حسب طلبك.`);
  }else if(!ownAirports.length)renderGroup([],provider,parent.request);
  if(ownAirports.length){
   parts.push(`\n*${LABELS[provider]} — مقارنة مطارات ${side==='origin'?'المغادرة':'الوصول'}*`);
   parts.push('المقارنة على نفس التواريخ والوزن وعدد المسافرين؛ أي تغيير بالمطار بيكون باختيارك.');
   const requested=city(parent.request[side]),airports=[...new Set(ownAirports.map(c=>city(c.request[side])))].sort((a,b)=>Number(b===requested)-Number(a===requested));
   for(const airport of airports){
    const children=ownAirports.filter(c=>city(c.request[side])===airport);
    parts.push(`\n*${side==='origin'?'المغادرة من':'الوصول إلى'} مطار ${airport} — ${LABELS[provider]}*`);
    renderGroup(children,provider,children[0].request);
   }
  }
  if(provider==='flycham'){
   const flyOffers=[...ownExact,...ownAirports].flatMap(c=>c.offers||[]);
   const dubai=flyOffers.filter(o=>city(o.request[side])==='دبي').sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal))[0],sharjah=flyOffers.filter(o=>city(o.request[side])==='الشارقة').sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal))[0];
   if(dubai&&sharjah&&Number(dubai.price.sellingTotal)<Number(sharjah.price.sellingTotal))parts.push(`💡 ضمن الخيارات المتأكدة، أقل سعر ${side==='origin'?'من':'إلى'} دبي ${dubai.price.sellingTotal} درهم، وأقل سعر ${side==='origin'?'من':'إلى'} الشارقة ${sharjah.price.sellingTotal} درهم. راجع تواريخ وتواقيت الخيارين فوق؛ إذا دبي بتناسبك ممكن تكون أوفر إلك.`);
  }
 }
 if(alternatives.length){
  parts.push('\n*بدائل قريبة من التاريخ المطلوب*');
  const allOffers=alternatives.flatMap(c=>(c.offers||[]).map(o=>({o,delta:c.delta}))),offers=allOffers.filter(({o})=>!sent.has(offerKey(o))).sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta)||Number(a.o.price.sellingTotal)-Number(b.o.price.sellingTotal));
  if(offers.length){
   parts.push('لقيتلك هالبدائل القريبة والمتأكدة أسعارها 👇');
   parts.push(offers.map(({o,delta})=>`*${delta<0?'قبل':'بعد'} موعدك ${Math.abs(delta)===1?'بيوم':Math.abs(delta)===2?'بيومين':`بـ${Math.abs(delta)} أيام`}*\n${formatOffer(o)}`).join('\n\n'));
  }else if(allOffers.length)parts.push('البدائل المتأكدة سبق إرسالها أعلاه، وأرقام خياراتها محفوظة.');
  else if(alternatives.some(c=>c.status==='pending'))parts.push('الأيام القريبة من موعدك لسه قيد التحقق؛ منرسل الخيارات المتأكدة فور توفرها.');
  else if(alternatives.every(c=>NEGATIVE.has(c.status)))parts.push('ما ظهر خيار متاح لدى الشركات المفحوصة ضمن الأيام القريبة اللي راجعناها.');
  else parts.push('لم يتأكد عرض في الأيام القريبة التي فحصناها؛ هالنتيجة ما تعني عدم وجود رحلات في الأيام التي لم يكتمل فحصها.');
  if(alternatives.some(c=>['partial','unverified','auth_required','pending'].includes(c.status))&&offers.length)parts.push('هذه البدائل تأكدت؛ بعض الأيام أو التواقيت القريبة لم يكتمل فحصها.');
 }
 if(allParentOffers.length){
  parts.push('\nالأسعار تشمل الرسوم وعمولة الخدمة، حسب الوزن الموضح لكل عرض. المواعيد كما تظهر في البوابة. السعر والتوفر قابلان للتغير حتى إصدار التذكرة؛ لم يتم إنشاء حجز.');
  parts.push(pending?'بقية الخيارات لسه قيد التحقق؛ العروض الموضحة أعلاه متأكدة حسب آخر مراجعة.':'أي خيار من هالخيارات بناسبك لنكمل عليه؟');
 }else if(pending)parts.push('\nبقية الخيارات لسه قيد التحقق؛ ما في داعي تعيد تفاصيل رحلتك، ومنرسل أي سعر بعد تأكيده.');
 else{
  parts.push('\nحتى تختار على أساس واضح، ما عندي سعر متأكد جاهز للإرسال من الفحوص المنجزة لهالطلب.');
  parts.push('إذا مواعيدك مرنة، بتحب نوسّع البحث لفترة أبعد: سبعة أيام بعد آخر تاريخ طلبته، مع الحفاظ على باقي التفاصيل؟');
 }
 return parts.join('\n');
}
module.exports={PROVIDERS,NEGATIVE,STATUSES,sameRequest,offerKey,verifiedOffer,nearbyRequests,completionStatus,renderComparison,formatOffer};
