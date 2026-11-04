'use strict';
const {aiConfigured,aiProvider}=require('./assistant-nlu');

const crypto=require('node:crypto');
const {rememberFlightJourney,returningGreeting,clearCustomerProfile}=require('./customer-profile');
const {extractMentionedExpiryDates,checkPassportValidityDate,readinessReferenceDate,offerAirportMismatchNotice}=require('./prebooking-readiness');
const legacy=require('./conversation');
const {normalize,naturalDate}=require('./arabic-dates');
const {languagePatch,city}=require('./travel-language');
const {affirmativeEnglishText,parseEnglishFlightPatch}=require('./bilingual-intake');
const {understand}=require('./assistant-nlu');
const {AssistantState}=require('./assistant-state');
const {POLICY,capabilityIssue}=require('./assistant-policy');
const {formatOffer,verifiedOffer}=require('./quote-comparison');
const {knownTripFollowup}=require('./travel-followups');
const {understandConsultant}=require('./consultant-brain');
const {updateConsultantMemory,recommendVerifiedOffers}=require('./consultant-memory');
const {toFils,formatAED}=require('./money');
const {enabled,finishConsultantTurn}=require('./consultant-runtime');
const {chooseApprovedReply}=require('./response-library');
const {shouldOfferRequestChoice,createRequestChoice,readRequestChoice}=require('./request-choice');
const dateText=d=>d.split('-').reverse().join('-');
const clean=t=>String(t||'').replace(/[\u0000-\u001f]/g,' ').slice(0,9000);
function offerId(o){return crypto.createHash('sha256').update(JSON.stringify([o.request,o.timing,o.price?.weights])).digest('hex').slice(0,12);}
// Model context contains identification and deterministic price ordering, never money or raw supplier payloads.
function offerSummaries(offers=[]){
 const verified=offers.slice(-80).filter(o=>o.request&&o.timing?.out?.flight&&/^\d+\.\d{2}$/.test(o.price?.sellingTotal||''));
 const amount=o=>BigInt(o.price.sellingTotal.replace('.',''));
 const amounts=[...new Set(verified.map(o=>amount(o).toString()))].map(v=>BigInt(v)).sort((a,b)=>a<b?-1:a>b?1:0);
 const bounded=v=>typeof v==='string'?v.slice(0,80):null;
 return verified.map(o=>({provider:['airarabia','flycham'].includes(o.provider||o.request.provider||'airarabia')?(o.provider||o.request.provider||'airarabia'):null,reference:Number.isInteger(o.reference)&&o.reference>=1&&o.reference<=80?o.reference:offers.indexOf(o)+1,
  origin:bounded(o.request.origin),destination:bounded(o.request.destination),departureDate:bounded(o.request.departureDate),returnDate:bounded(o.request.returnDate),
  flight:bounded(o.timing.out.flight),departureTime:bounded(o.timing.out.departure),arrivalTime:bounded(o.timing.out.arrival),
  returnFlight:bounded(o.timing.back?.flight),returnDepartureTime:bounded(o.timing.back?.departure),returnArrivalTime:bounded(o.timing.back?.arrival),
  cheapestRank:amounts.findIndex(v=>v===amount(o))+1}));
}
function questionField(question){
 const t=normalize(question||'');
 if(/اعمار|عمر.*(?:طفل|رضيع|ابن)/.test(t))return 'childrenAges';
 if(/(?:موعد|تاريخ|ايمت|متي|وقت).*(?:عود[هة]|رجع[هة])/.test(t))return 'returnDate';
 if(/عدد|كم.*(?:شخص|مسافر|بالغ)/.test(t))return 'passengers';
 if(/من اي|مغادر|من وين/.test(t))return 'origin';
 if(/الى اي|وجه[هة]|(?:وين|لوين).*(?:رايح|مسافر|توصل)|لوين/.test(t))return 'destination';
 if(/تاريخ.*(?:ذهاب|سفر)|ايمت|متي.*(?:سفر|ذهاب)|اي (?:فتر[هة]|تاريخ|تواريخ|موعد)|فتر[هة].*بتناسب/.test(t))return 'departureDate';
 if(/ذهاب|عود[هة]|رجع[هة]|نوع الرحل/.test(t))return 'tripType';
 return null;
}
function answeredField(field,r={}){
 if(field==='passengers')return Number.isInteger(r?.passengers?.adults);
 if(field==='childrenAges')return Boolean(r?.passengers&&(r.passengers.children||0)+(r.passengers.infants||0)<=(r.passengers.ages?.length||0));
 if(field==='departureDate')return Boolean(r?.departureDate||r?.departureRange);
 if(field==='returnDate')return Boolean(r?.returnDate||r?.stayNights);
 return Boolean(r?.[field]);
}
function knownQuestion(question,r={}){return answeredField(questionField(question),r);}
function familyRequestCard(r={}){
 const p=r.passengers||{},dates=r.departureDate||(r.departureRange?`${r.departureRange.start} – ${r.departureRange.end}`:null);
 const people=[`${p.adults||0} بالغ`,p.children?`${p.children} طفل`:null,p.infants?`${p.infants} رضيع`:null].filter(Boolean).join(' + ');
 const lines=['*طلب سفر عائلي ✈️*',r.origin||r.destination?`• المسار: من ${r.origin||'—'} إلى ${r.destination||'—'}${r.tripType==='round_trip'?' (ذهاب وعودة)':' (ذهاب فقط)'}`:null,dates?`• الموعد: ${dates}`:null,`• المسافرون: ${people}`].filter(Boolean);
 return lines.join('\n')+'\n\nكل تفاصيلكم محفوظة 🌷 التسعير الآلي المتحقق حالياً للشخص الواحد، وما منعطي سعر عائلة بالتخمين أو بضرب سعر الشخص.\nاختار اللي بيريحك:\n1️⃣ «شوف سعر شخص واحد» — مقارنة أولية فورية، مع حفظ عددكم الأصلي.\n2️⃣ «حوّلني للموظف» — بيجهزلكم تسعير العائلة كاملاً من نفس الملف بدون ما تعيدوا أي معلومة.';
}

function tripSummaryQuestion(text){
 const t=normalize(text).replace(/ة/g,'ه');
 return /(?:لخص|تلخيص|ملخص)\s*(?:لي\s*)?(?:طلبي|الطلب|رحلتي|الرحله|حجزي)|(?:شو|ايش|ما هي)\s*(?:تفاصيل|بيانات|ملخص)\s*(?:رحلتي|طلبي)|(?:شو|ايش)\s*(?:سجلت|سجلتوا|سجلتو)\s*(?:عندي|لي|برحلتي)|عل[ىي] شو عم تبحث/.test(t);
}
function tripSummaryReply(s,{now=Date.now()}={}){
 const r=s?.base?.request;
 if(!r||(!r.origin&&!r.destination&&!r.departureDate&&!r.departureRange&&!r.passengers))return 'لسا ما حددنا تفاصيل الرحلة 🌷 خبرني من أي مدينة وإلى أي مدينة حابب تسافر وأي فترة بتناسبك لنبدأ.';
 const lines=['*ملخص طلب الطيران المحفوظ لديك ✈️*'];
 const tripType=r.tripType==='round_trip'?'ذهاب وعودة':r.tripType==='one_way'?'ذهاب فقط':'نوع الرحلة غير محدد بعد';
 if(r.origin||r.destination)lines.push(`• المسار: من ${r.origin||'غير محدد بعد'} إلى ${r.destination||'غير محدد بعد'} (${tripType})`);
 if(r.departureDate)lines.push(`• تاريخ الذهاب: ${r.departureDate}`);
 else if(r.departureRange)lines.push(`• الفترة المطلوبة: من ${r.departureRange.start} إلى ${r.departureRange.end}`);
 if(r.tripType==='round_trip'&&(r.returnDate||r.stayNights))lines.push(`• العودة: ${r.returnDate||`بعد ${r.stayNights} ليالٍ`}`);
 if(r.passengers?.adults)lines.push(`• المسافرون: ${r.passengers.adults} بالغ${r.passengers.children?` + ${r.passengers.children} طفل`:''}${r.passengers.infants?` + ${r.passengers.infants} رضيع`:''}`);
 const weightKg=r.baggageRequest?.checkedWeightKg??r.weightKg;
 if(weightKg!=null)lines.push(`• الوزن المطلوب: ${weightKg===0?'بدون وزن مسجل (حقيبة يد فقط)':weightKg+' كغ'}`);
 // Apply the same freshness, route and price checks used by offer comparisons.
 const offers=currentShownOffers({...s,offers:s.offers||[]},now);
 lines.push(`• العروض المتحققة الظاهرة: ${offers.length} عرض`);
 const picked=s.selected&&offers.find(o=>o.id===s.selected);
 if(picked)lines.push(`• العرض المختار: الخيار ${picked.reference} (${picked.timing.out.flight}) — ${picked.price.sellingTotal} درهم`);
 else if(s.selected)lines.push('• العرض المختار يحتاج إعادة تحقق من السعر والتوفر.');
 lines.push(['queued','searching'].includes(s.status)?'• الحالة: جاري التحقق من الأسعار والتواقيت على هذه التفاصيل.':s.status==='cancelled'?'• الحالة: البحث متوقف.':s.status==='failed'?'• الحالة: تعذر إكمال البحث؛ التفاصيل محفوظة لإعادة التحقق.':'• الحالة: التفاصيل محفوظة، وفينا نعدّل أي نقطة أو نتابع مع موظف الحجوزات.');
 lines.push('الملخص لا يُعد تأكيد حجز أو إصدار تذكرة؛ السعر والتوفر يُعاد التحقق منهما قبل التثبيت.');
 return lines.join('\n');
}
function flightAdviceKind(text){
 const t=normalize(text).replace(/ة/g,'ه');
 if(/(?:قبل كم ساعه|متي احضر|ايمت كون|وقت الحضور|موعد الحضور|متي بيفتح|متي يفتح).*(?:مطار|بوردينغ|البوردينغ|طياره|رحله)|(?:بوردينغ|البوردينغ|كاونتر المطار)/.test(t))return 'checkin_time';
 if(/كم ساعه|مده الرحله|قديش بتاخد الطياره|كم بتستغرق/.test(t))return 'duration';
 if(/الفرق بين.*(?:دبي|الشارق|ابو\s*ظبي)|اي مطار (?:احسن|افضل|اقرب)|مطار دبي ولا الشارقه|مطار الشارقه ولا دبي/.test(t))return 'airports';
 if(/(?:وزن|شنط|امتعه|كيلو).*(?:رضيع|بيبي|طفل|اطفال)|(?:رضيع|بيبي|طفل|اطفال).*(?:وزن|شنط|امتعه|كيلو)/.test(t)){
  // A real travel/baggage amendment must still reach intake, not become an FAQ.
  if(/(?:بدي|ابحث|شوفلي|شفلي|غير|خلي|بدل).*(?:رحله|سافر|كيلو|وزن|شنط)/.test(t)&&!/كم|شو|قديش|هل|بيحق|مسموح|اسال/.test(t))return null;
  return 'child_baggage';
 }
 if(/(?:شراء|زياده|اضافه|اضافي).*(?:وزن|كيلو|شنط|حقيبه)|(?:وزن|كيلو|شنط|حقيبه).*(?:زياده|اضافي)|(?:سعر|بكم|بكام|قديش)\s*(?:ال)?كيلو/.test(t)){
  if(/(?:بدي|ابحث|شوفلي|شفلي|غير|خلي|بدل).*(?:رحله|سافر|كيلو|وزن|شنط)/.test(t)&&!/كم|شو|قديش|بكم|بكام|هل|مسموح|اسال|سعر/.test(t))return null;
  return 'extra_baggage';
 }
 // A new itinerary mentioning assistance still belongs to travel intake.
 if(/(?:بدي|ابحث|شوفلي|شفلي|غير|خلي|بدل).*?(?:رحله|سافر|طيران|تذكره)/.test(t)&&!/[؟?]|كم|شو|قديش|هل|كيف|اسال/.test(t))return null;
 if(/كرسي متحرك|wheelchair|كبار السن|(?:^|[\s،,])مسن(?:ه)?(?=$|[\s،,.؟?!])|ذوي الاحتياجات|حامل|شهر سابع|شهر ثامن|شهر تاسع|تقرير طبي/.test(t))return 'special_assistance';
 if(/(?:جواز(?:ي)?|باسبور(?:ي)?|باسبورت(?:ي)?)\s*(?:ال)?سوري.*(?:منتهي|تمديد|ممدد)|(?:منتهي|تمديد|ممدد).*(?:جواز(?:ي)?|باسبور(?:ي)?|باسبورت(?:ي)?)\s*(?:ال)?سوري|تذكره مرور|ورقه عبور/.test(t))return 'syrian_passport';
 if(/تصريف\s*(?:100|ميه|مئه)\s*دولار|شروط الدخول.*(?:سوريا|دمشق|حلب|الشام)|موافقه امنيه/.test(t))return 'entry_rules';
 if(/(?:ذهب|موبايلات|جوالات|اجهزه كهربائيه|لابتوب|بطاريه|باور بانك|سوائل|ادويه).*(?:مسموح|بالطياره|بالشحن|بالمطار|معي)|(?:مسموح|فيني ا(?:خد|خذ)).*(?:ذهب|موبايل|لابتوب|باور بانك|بطاريه|سوائل|ادويه)/.test(t))return 'customs_items';
 if(/(?:صلاحيه|انتهاء|ينتهي|تنتهي|منتهي|تجديد|صالح).*(?:جواز|باسبور|باسبورت)|(?:جواز|باسبور|باسبورت).*(?:ينتهي|تنتهي|منتهي|صلاحيته|صالح)|(?:expiry|expire|validity).*(?:passport)|passport.*(?:expiry|expire|validity|valid until)/i.test(t))return 'passport_validity';
 return null;
}
function explainService(t,request={},status,now=Date.now()){
 if(/طرق الدفع|وسائل الدفع|كيف الدفع|تحويل بنكي|كاش|بطاقه|فيزا كارد|تابي|اقساط/.test(t))return require('./remal-service-policy').PAYMENT;
 if(/عنوان|وين مكتب|مكان المكتب|موقع المكتب|فرع/.test(t))return require('./remal-service-policy').OFFICE;
 const advice=flightAdviceKind(t);
 if(advice==='child_baggage')return 'بالنسبة لأمتعة الأطفال والرضّع 🌷 الطفل بمقعد مستقل بياخد عادةً وزن الفئة المحددة بالتذكرة، أما الرضيع (أقل من سنتين بدون مقعد) فتختلف حصته حسب شركة الطيران والفئة؛ منتحقق من الوزن الفعلي المشمول لكل مسافر ضمن العرض قبل التثبيت.';
 if(advice==='extra_baggage')return 'بخصوص الوزن الإضافي 🌷 فلاي شام تشمل بالعرض المعتاد لدينا 30 كغ شحن + 10 كغ يد، والعربية للطيران تتوفر عليها فئات وزن متدرجة (مثل 20 أو 30 أو 40 كغ حسب الرحلة). إذا بتحتاج وزن إضافي فوق المشمول، منتحقق من توفره وتكلفته الفعلية على رحلتك مع موظف الحجوزات قبل التثبيت.';
 if(advice==='checkin_time')return 'ننصح بالحضور إلى المطار قبل 3 ساعات على الأقل من موعد الإقلاع للرحلات الدولية ✈️ كاونتر تسليم الأمتعة بيغلق عادةً قبل 60 دقيقة من الإقلاع، وقد يختلف حسب المطار والشركة؛ منأكدلك الموعد المعتمد بتذكرتك والمطار والصالة والتوقيت المحلي قبل التثبيت.';
 if(advice==='special_assistance')return 'بالنسبة لخدمات المساندة الخاصة 🌷 خدمة الكرسي المتحرك (Wheelchair) لكبار السن تُطلب مسبقاً على الحجز بالتنسيق مع موظف الحجوزات عند التثبيت، ويُؤكد توفرها مع الشركة. وللمسافرات الحوامل، تختلف شروط التقرير الطبي حسب أسبوع الحمل وشركة الطيران، فمنراجعها معك قبل الإصدار.';
 if(advice==='syrian_passport')return 'بخصوص السفر بالجواز السوري المنتهي أو الممدد أو تذكرة المرور 🌷 قبول الصعود للطائرة بيخضع لتعليمات شركة الطيران ومطار المغادرة والوجهة والترانزيت السارية يوم السفر. منتحقق من حالة الجواز والمستندات مع موظف الحجوزات قبل تثبيت التذكرة؛ ما منأكد إمكانية السفر قبل مراجعة الحالة.';
 if(advice==='entry_rules')return 'بخصوص إجراءات وتعليمات الدخول إلى سوريا (مثل تصريف العملة أو الموافقات الرسمية) 🌷 التعليمات الحدودية بتخضع للجهات الرسمية المختصة وقت الوصول وممكن تتحدث دورياً؛ لازم نتأكد من آخر تعليمات رسمية تنطبق على جنسيتك ووثيقة سفرك قبل التثبيت، وما منعتبر أي إجراء قديم شرطاً سارياً دون تحقق.';
 if(advice==='customs_items')return 'بخصوص حمل الأجهزة والمقتنيات على الطائرة 🌷 الباور بانك وبطاريات الليثيوم الاحتياطية تكون بحقيبة اليد وليس بالشحن، مع حماية الأقطاب والالتزام بقيود السعة والعدد لدى الشركة. الأفضل الاحتفاظ بالذهب واللابتوب بحقيبة اليد، مع مراجعة متطلبات التصريح الجمركي. الأدوية والسوائل إلها شروط خاصة حسب المادة والكمية والوجهة؛ منراجع متطلبات الوصفة والتصريح مع الجهة المختصة قبل السفر، وما منأكد السماح لمادة غير محددة.';
 if(advice==='passport_validity'){const mentioned=extractMentionedExpiryDates(t),check=checkPassportValidityDate(mentioned.passportExpiry,readinessReferenceDate(request,now));return 'بالنسبة لصلاحية الجواز 🌷 كثير من الوجهات تطلب 6 أشهر من تاريخ السفر، لكن الشرط يختلف حسب الجنسية والوجهة ونوع الإقامة. منراجع المتطلبات الفعلية مع موظف الحجوزات قبل تثبيت التذكرة، خصوصاً إذا كان الجواز قريب الانتهاء.'+(check?'\n\n'+check.warningCopy:'');}
 if(advice==='duration'){
  // Indicative only for the named UAE–Syria route, never for an arbitrary trip.
  const uae=/دبي|الشارق|شارق|ابو\s*ظبي|SHJ|DXB|AUH|DWC/i,sy=/دمشق|حلب|DAM|ALP/i;
  const approximate=uae.test(request?.origin||'')&&sy.test(request?.destination||'');
  return (approximate?'للرحلة المباشرة من الإمارات إلى دمشق أو حلب، المدة التقريبية حوالي 3 إلى 3 ساعات ونصف ✈️ ':'مدة الرحلة بتختلف حسب المسار وشركة الطيران، وإذا كانت مباشرة أو فيها توقف ✈️ ')+'منراجع المدة ومواعيد الإقلاع والوصول المحلية في العرض المتحقق، مع مراعاة فرق التوقيت، قبل التثبيت.';
 }
 if(advice==='airports')return 'الأنسب بين مطارات دبي والشارقة وأبوظبي بيعتمد على مكانك وموعد الرحلة والسعر ووقت الوصول للمطار 🌷 منبدأ بالشارقة كأولوية ومنقارن البدائل المتاحة حسب جدول الشركات الفعلي؛ منوضحلك مطار المغادرة والتوقيت والتكلفة بكل عرض متحقق.';
 if(/(?:فرق|مقارن[هة]|قارن|احسن|افضل).*(?:فلاي|العربي)|(?:فلاي|العربي).*(?:فرق|احسن|افضل)/.test(t))return 'فلاي شام بتشمل حسب سياسة خدمتنا المعتادة ثلاثين كيلو وزن مسجّل وعشرة كيلو يد. العربية منراجع وزنها وتكلفتها حسب الخيار الفعلي. المقارنة الأنسب بتكون على نفس المسار والأيام والوزن، ومنعرضلك التواقيت والسعر المتحقق لكل خيار.';
 if(/وزن|شنط|امتع[هة]|كيلو/.test(t))return request.provider==='flycham'?'فلاي شام بتشمل ثلاثين كيلو وزن مسجّل وعشرة كيلو يد بالعرض المعتاد. إذا صار عرض وزن إضافي منحدّثه حسب الإعلان المعتمد. أي طلب مختلف لازم نتحقق من توفره قبل تأكيده.':'البحث المعتاد بيكون على ثلاثين كيلو وزن مسجّل. إذا بتفضّل أقل وزن لحتى نقارن بسعر أوفر على العربية، منحافظ على باقي تفاصيل رحلتك ومنتحقق من التكلفة الفعلية.';
 if(/مطار بديل|ترانزيت|مباشر|ليش السعر|تغير السعر/.test(t))return 'السعر بيتأثر بالموعد والمطار وفئة الأمتعة. الرحلة المباشرة ما فيها تبديل طائرة، والترانزيت فيه توقف وربما تبديل؛ منراجع تفاصيل العرض الفعلي قبل تأكيد أي مسار أو سعر. إذا بتحب نقارن مطاراً أو موعداً بديلاً، حدد الأنسب إلك.';
 if(/دفع|تثبيت|حجز|اصدار/.test(t))return 'منرتّبلك الخيارات المتحققة أولًا، وبتختار الأنسب. لما تطلب متابعة التثبيت، بيتابع معك موظف الحجوزات بعد مراجعة السعر والتوفر؛ الاستعلام بحد ذاته ما بيحجز ولا بيصدر تذكرة.';
 if(/تعديل|الغاء|استرجاع/.test(t))return 'شروط التعديل والإلغاء بتختلف حسب التذكرة والخيار المحدد. ما منأكد مرونة أو رسوم قبل مراجعة شروط العرض نفسه؛ فينا نحافظ على هالنقطة ضمن طلبك.';
 if(/طول|تأخير|تاخير|تعب|مستعجل/.test(t))return ['searching','queued'].includes(status)?'معك، وبقدّر وقتك. طلبك قيد التحقق على نفس التفاصيل؛ ما رح أغيّر المسار أو الوزن من عندي، ومنبعتلك النتيجة بعد تأكدها.':'معك، وبقدّر وقتك. التفاصيل اللي ذكرتها محفوظة؛ منكمل من آخر نقطة واضحة حتى ما تعيد طلبك.';
 return null;
}
function airlineComparisonQuestion(t){return /فرق|مقارن[هة]|قارن|ايهم افضل|ايهما افضل/.test(t)&&/فلاي|الشام|العربي/.test(t)||/فلاي|الشام/.test(t)&&/العربي/.test(t)&&/افضل|ارخص|احسن/.test(t);}
function ticketServiceQuestion(t){return /(?:تعديل|الغاء|استرجاع|استرداد).*(?:تذكر[هة]|تذاكر)|(?:تذكر[هة]|تذاكر).*(?:تعديل|الغاء|استرجاع|استرداد)|استرجاع/.test(t);}
function currentShownOffers(s,now){
 return recommendVerifiedOffers(s.offers.map((o,i)=>({...o,reference:o.reference||i+1})),s.base?.request,s.consultant?.preferences||{},{now}).offers;
}
function compareShownAirlines(s,now){
 const offers=currentShownOffers(s,now),aa=offers.find(o=>o.provider==='airarabia'),fc=offers.find(o=>o.provider==='flycham');
 if(!aa||!fc)return null;
 const difference=toFils(aa.price.sellingTotal,'Price')-toFils(fc.price.sellingTotal,'Price');
 const conclusion=difference===0n?'السعر الإجمالي متساوٍ في هذين الخيارين':`${difference<0n?'العربية للطيران':'فلاي شام'} أوفر بـ${formatAED(difference<0n?-difference:difference)} درهم بين هذين الخيارين`;
 return ['📊 *مقارنة مباشرة بين أقل عرض متحقق لكل شركة ضمن خياراتك الحالية:*',formatOffer(aa),formatOffer(fc),`💡 *الخلاصة:* ${conclusion}. راجع اختلاف المطار والتاريخ والتوقيت والوزن أعلاه.`,`أرسل رقم الخيار الأنسب لنراجع متابعة تثبيته مع الموظف. السعر والتوفر يُعاد التحقق منهما؛ لم يُنشأ حجز.`].join('\n\n');
}
function priceSavingAdvice(s,now){
 const cheapest=currentShownOffers(s,now)[0];
 if(!cheapest)return null;
 return ['أقدّر حرصك على أفضل سعر 🌷 هذا الأقل سعراً بين العروض الحديثة المتحققة والمطابقة لطلبك:',formatOffer(cheapest),'💡 *خيارات ممكن تساعدنا نوفر بعد فحص السعر الفعلي:*','1. تاريخ قريب قبل أو بعد بيوم أو يومين.','2. وزن شحن أقل، مثل 20 كيلو أو بدون شحن، إذا كانت الفئة متاحة.','3. مطار قريب بديل يناسبك؛ إذا مغادرتك من الإمارات فينا نقارن الشارقة ودبي وأبوظبي.','أي مسار توفير بتفضّل نفحصه؟ السعر والتوفر يحتاجان إعادة تحقق قبل التثبيت، ولم يتم حجز تذكرة.'].join('\n\n');
}
function acceptsExpansion(base,text,now){const p=base?.proposal,t=normalize(text).replace(/[؟?!،,.]+$/g,'');return Boolean(p?.choiceCount===1&&p.expiresAt>=now&&p.requestFingerprint===JSON.stringify(base.request)&&/^(?:شفلي|شوفلي|شوف لي|اي شفلي|اي شوفلي|نعم|اي|تابع|كمل|تمام)$/.test(t));}
function selectedSupplierRequest(request){return {...request,providerExclusive:true,providerRestrictionSource:request.providerExclusive&&request.providerRestrictionSource==='customer'?'customer':'selection'};}
function reconcileSupplierRestriction(id,s,text,modelPatch={}){
 const base=legacy.exportSession(id),r=base?.request;
 if(!r?.providerExclusive)return;
 const direct=languagePatch(text),t=normalize(text).replace(/[؟?!،,.]+$/g,'').trim();
 if(typeof direct.providerExclusive==='boolean')return; // Applied authoritatively below.
 if(r.providerRestrictionSource==='customer')return;
 // Migrate an older restriction only when the customer's own bounded history
 // proves an airline-only instruction. Assistant offer text is not consent.
 if(!r.providerRestrictionSource){
  const evidence=[...s.history].reverse().filter(m=>m.role==='user').map(m=>languagePatch(m.text)).find(p=>typeof p.providerExclusive==='boolean');
  if(evidence?.providerExclusive&&evidence.provider===r.provider){r.providerRestrictionSource='customer';legacy.importSession(id,base);s.base=base;return;}
 }
 const target={...modelPatch,...direct};
 const changedRoute=['origin','destination'].some(k=>target[k]&&city(target[k])!==city(r[k]));
 const broadCheapest=/ارخص|اقل سعر|اوفر/.test(t)&&/ابحث|شوف|شفلي|شيك|بدي|اريد|شو|او\s*ارخص/.test(t);
 const anyCompany=direct.providerExclusive===false;
 const legacyRetry=!r.providerRestrictionSource&&!s.offers.length&&['done','failed'].includes(s.status)&&/^(?:اعد البحث|عيد البحث|شفلي|شوفلي|شوف لي|تابع|كمل|نفس الرحله|نفس التفاصيل)$/.test(t);
 if(changedRoute||broadCheapest||anyCompany||legacyRetry){const before=JSON.stringify(r);r.providerExclusive=false;delete r.providerRestrictionSource;if(base.proposal?.requestFingerprint===before)base.proposal.requestFingerprint=JSON.stringify(r);s.selected=null;legacy.importSession(id,base);s.base=base;}
}
class AssistantEngine{
 constructor({store=new AssistantState(),nlu=null,env=process.env}={}){this.store=store;this.nlu=nlu||(enabled(env)?understandConsultant:understand);this.env=env;this.locks=new Map();this.prepared=new Map();}
 state(id){return {history:[],offers:[],selected:null,base:null,previous:[],comparison:null,status:'idle',coverage:[],...this.store.get(id)};}
 save(id,s){s.base=legacy.exportSession(id);this.store.set(id,s);}
 preparationKey(s,text,turnMessages){return JSON.stringify([clean(text),s.base,s.history,s.questions,s.lastQuestion,s.offers,s.selected,s.status,turnMessages]);}
 async prepare(id,text,{turnMessages=[],quotedMessageId=null,now=Date.now()}={}){
  if(flightAdviceKind(text)||tripSummaryQuestion(text))return;
  if(quotedMessageId||turnMessages.some(m=>m.quotedOfferReference||m.quotedOfferReferences?.length))return;
  const s=this.state(id),key=this.preparationKey(s,text,turnMessages);
  if(s.requestChoice||shouldOfferRequestChoice({state:s,text,followup:knownTripFollowup(text,s.base?.request,now,{monthScope:s.base?.monthScope}),now}))return;
  if(!s.pendingQuotedOffer&&(acceptsExpansion(s.base,text,now)||knownTripFollowup(text,s.base?.request,now,{monthScope:s.base?.monthScope})))return;
  if(this.prepared.get(id)?.key===key)return;
  const snapshot=structuredClone(s);
  const promise=Promise.resolve().then(()=>this.nlu(clean(text),{request:snapshot.base?.request,lastQuestion:snapshot.lastQuestion,history:[...snapshot.history,{role:'user',text:clean(text)}].slice(-12),questions:snapshot.questions||{},proposal:snapshot.base?.proposal,quotedOfferReferences:[],turnMessages,awaiting:snapshot.base?.awaiting,selectedOffer:snapshot.offers.find(o=>o.id===snapshot.selected),offerSummaries:offerSummaries(snapshot.offers),status:snapshot.status,consultantMemory:snapshot.consultant},{env:this.env,now})).then(decision=>({decision}),error=>({error}));
  if(this.prepared.size>=100)this.prepared.delete(this.prepared.keys().next().value);
  this.prepared.set(id,{key,promise,at:now});
 }
 async handle(id,text,{now=Date.now(),quotedMessageId=null,turnMessages=[],buttonChoice=null,choiceExtras=[]}={}){
  const before=this.locks.get(id)||Promise.resolve();
  const work=before.catch(()=>{}).then(async()=>{
   const choiceResult=await this.processRequestChoice(id,text,{now,quotedMessageId,turnMessages,buttonChoice,choiceExtras});
   const result=await finishConsultantTurn(this,id,text,choiceResult||await this.process(id,text,{now,quotedMessageId,turnMessages}),{now});
   const s=this.state(id);if(!s.introduced&&!result.cancel){const introduction='أهلًا وسهلًا فيك 🌷 معك أحمد، مساعد مجموعة الرمال الافتراضي.';s.introduced=true;if(!/(?:معك|أنا)\s+أحمد/.test(result.reply)){result.reply=introduction+'\n\n'+result.reply;result.introduction=introduction;const last=s.history[s.history.length-1];if(last?.role==='assistant')last.text=result.reply;}this.store.set(id,s);}return result;
  });
  this.locks.set(id,work);try{return await work;}finally{if(this.locks.get(id)===work)this.locks.delete(id);}
 }

 choiceReply(id,state,text,reply,extra={}){
  state.consultantDecision=null;state.history.push({role:'user',text:clean(text)},{role:'assistant',text:reply});state.history=state.history.slice(-24);this.store.set(id,state);
  return {complete:false,reply,requestChoiceHandled:true,...extra};
 }
 async processRequestChoice(id,text,{now,quotedMessageId,turnMessages=[],buttonChoice,choiceExtras=[]}){
  let state=this.state(id);if(state.humanOwned)return null;
  if(!buttonChoice&&(airlineComparisonQuestion(normalize(text))||ticketServiceQuestion(normalize(text))||flightAdviceKind(text)||tripSummaryQuestion(text)))return null;
  const oldChoice=state.requestChoice,quotedElsewhere=!buttonChoice&&quotedMessageId&&quotedMessageId!==oldChoice?.messageId;
  const followup=knownTripFollowup(text,state.base?.request,now,{monthScope:state.base?.monthScope});
  let picked=quotedElsewhere?{action:'none'}:readRequestChoice(state,text,{now,buttonChoice});
  if(picked.action==='stale'){
   // A stale button can never reset the current journey. Ordinary new text
   // may proceed after expiring an old prompt, without being discarded.
   if(buttonChoice)return this.choiceReply(id,state,text,picked.reply);
   delete state.requestChoice;this.store.set(id,state);
   if(/^(?:[12١٢]|الاول|الثاني|التاني|متابعة طلبي الحالي|طلب جديد مختلف)[.!؟? ]*$/.test(String(text).trim()))return this.choiceReply(id,state,text,picked.reply);
   picked={action:'none'};
  }
  if(picked.action==='repeat'&&followup)picked={action:'none'};
  if(picked.action==='none'&&oldChoice&&(picked.resolvedCurrent||followup||quotedElsewhere||/^(?:الخيار|العرض)\s*\d{1,2}$/.test(normalize(text))||/ثبتلي|بدي ثبت|احجزلي|وقف البحث|احذف بياناتي|امسح بياناتي|حذف بياناتي/.test(normalize(text)))){state.lastQuestion=oldChoice.previousQuestion||null;delete state.requestChoice;this.store.set(id,state);}
  if(picked.action==='repeat'){
   if(clean(text)!==state.requestChoice.text&&!state.requestChoice.text.includes(clean(text)))state.requestChoice.text=clean(state.requestChoice.text+'، '+text).slice(0,3000);
   return this.choiceReply(id,state,text,picked.reply,{requestChoice:{id:state.requestChoice.id}});
  }
  if(['continue','new'].includes(picked.action)){
   this.prepared.delete(id);delete state.requestChoice;state.lastQuestion=picked.pending.previousQuestion||null;state.consultantDecision=null;
   const original=clean(picked.pending.text+(choiceExtras.length?'، '+choiceExtras.join('، '):''));
   if(picked.action==='new'&&['queued','searching'].includes(state.status)){
    state.pendingRequests||=[];
    if(!state.pendingRequests.some(r=>normalize(r.text)===normalize(original))){
     if(state.pendingRequests.length>=5)return this.choiceReply(id,state,text,'عندي خمس طلبات إلك بانتظار البحث 🌷 خلّيني أخلصها بالترتيب، وبعدها منكمل الطلب الجديد.');
     state.pendingRequests.push({text:original,at:now});
    }
    return this.choiceReply(id,state,text,'أكيد 🌷 هاد طلب جديد ومنفصل عن رحلتك الحالية. رح أنهي البحث الحالي وأرسلك عروضه، وبعدها ببدأ بطلبك الجديد بتفاصيل مستقلة.');
   }
   if(picked.action==='new'){
    state.previous||=[];if(state.base)state.previous.push(state.base);state.previous=state.previous.slice(-5);
    state.base=null;state.history=[];state.questions={};state.lastQuestion=null;state.selected=null;state.offers=[];state.offerMessages={};state.comparison=null;state.activeComparisonId=null;state.queueReady=false;state.coverage=[];state.consultant={};state.status='collecting';state.tripId=crypto.randomUUID();delete state.offerPages;delete state.pendingQuotedOffer;delete state.previousComparisonOffers;delete state.handoffId;
    legacy.importSession(id,null);
   }
   this.store.set(id,state);
   const result=await this.process(id,original,{now,quotedMessageId:null,turnMessages:[],choiceMode:picked.action==='continue'?'continue':null});
   result.requestChoiceHandled=true;
   if(picked.action==='new')result.cancel=true;
   if(!result.complete){const current=this.state(id);result.reply=(picked.action==='new'?'تمام 🌷 منبدأ طلب جديد بتفاصيل مستقلة.':'تمام 🌷 منكمل على طلبك الحالي.')+'\n\n'+result.reply;const last=current.history.at(-1);if(last?.role==='assistant')last.text=result.reply;this.store.set(id,current);}
   return result;
  }
  if(!quotedElsewhere&&shouldOfferRequestChoice({state,text,followup,quotedOfferReferences:quotedMessageId?[1]:turnMessages.flatMap(m=>m.quotedOfferReference?[m.quotedOfferReference]:[]),now})){
   state.tripId||=crypto.randomUUID();const previousQuestion=state.lastQuestion,prompt=createRequestChoice(state,text,{now});state.requestChoice.previousQuestion=previousQuestion||null;
   return this.choiceReply(id,state,text,prompt.reply,{requestChoice:{id:prompt.id}});
  }
  return null;
 }

 async process(id,text,{now,quotedMessageId,turnMessages=[],choiceMode=null}){
  const s=this.state(id),priorSelection=s.selected,priorBase=s.base;
  if(!s.humanOwned&&affirmativeEnglishText(text)!==text&&!Object.keys(parseEnglishFlightPatch(text)).length&&!/[\u0621-\u064a]/.test(text)){this.prepared.delete(id);s.consultantDecision=null;const reply='حتى أفهم التعديل صح، شو التفاصيل اللي حابب نعتمدها للرحلة؟';s.history.push({role:'user',text:clean(text)},{role:'assistant',text:reply});this.store.set(id,s);return{complete:false,reply};}
  // Answer before quote selection or route recovery can mutate the saved trip.
  if(!s.humanOwned&&(tripSummaryQuestion(text)||flightAdviceKind(text))){
   this.prepared.delete(id);s.consultantDecision=null;
   const reply=tripSummaryQuestion(text)?tripSummaryReply(s,{now}):explainService(normalize(text),s.base?.request,s.status,now);
   s.history.push({role:'user',text:clean(text)},{role:'assistant',text:reply});s.history=s.history.slice(-24);
   const expiry=extractMentionedExpiryDates(text),check=checkPassportValidityDate(expiry.passportExpiry,readinessReferenceDate(s.base?.request,now));
   this.store.set(id,s);return{complete:false,contextOnly:true,reply,validityWarning:Boolean(check&&check.status!=='valid')};
  }
  const prepared=this.prepared.get(id),preparedKey=this.preparationKey(s,text,turnMessages);
  const usePrepared=!quotedMessageId&&prepared?.key===preparedKey&&now-prepared.at<120000;
  if(prepared)this.prepared.delete(id);
  const availableReferences=new Set(s.offers.map((o,i)=>o.reference||i+1));
  const mapped=quotedMessageId?s.offerMessages?.[quotedMessageId]:undefined;
  const direct=mapped===undefined&&quotedMessageId?s.offers.flatMap((o,i)=>o.messageId===quotedMessageId?[o.reference||i+1]:[]):[];
  const quotedOfferReferences=[...new Set([...(Array.isArray(mapped)?mapped:direct),...turnMessages.flatMap(m=>Array.isArray(m.quotedOfferReferences)?m.quotedOfferReferences:Number.isInteger(m.quotedOfferReference)?[m.quotedOfferReference]:[])])].filter(r=>Number.isInteger(r)&&availableReferences.has(r)).slice(0,80);
  if(quotedOfferReferences.length===1){const quoted=s.offers.find((o,i)=>(o.reference||i+1)===quotedOfferReferences[0]);if(quoted){s.selected=quoted.id;legacy.importSession(id,{request:selectedSupplierRequest(quoted.request),submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);}}
  const recoveredRoute=s.status==='unsupported'&&s.base?.request&&!capabilityIssue(s.base.request);
  if(recoveredRoute){s.base.submitted=false;s.base.awaiting=null;s.status='collecting';}
  // Recover an incoherent saved country route only from the latest explicit
  // direction in this customer's bounded history, never from a guessed city.
  if(s.base?.request?.originCountry==='سوريا'&&!s.base.request.origin&&['دمشق','حلب','اللاذقية'].includes(s.base.request.destination)){
   let datedInJourney=false;
   for(const message of [...s.history].reverse()){
    if(message.role!=='user')continue;
    const parsedDate=naturalDate(message.text,now);datedInJourney ||= Boolean(parsedDate.range||parsedDate.dates?.length);
    const route=languagePatch(message.text);
    if(route.origin&&route.destination)break;
    if(/من\s+سوري[اةه]/.test(normalize(message.text))&&route.destination&&!['دمشق','حلب','اللاذقية'].includes(route.destination)){
     s.base.request.destination=route.destination;s.base.submitted=false;s.base.awaiting='origin';
     if(!datedInJourney){s.base.request.departureDate=null;s.base.request.departureRange=null;s.base.request.returnDate=null;}
     break;
    }
   }
  }
  const incomingRoute=languagePatch(text),incomingDate=naturalDate(text,now);
  if(s.base?.request&&['done','failed','paused'].includes(s.status)&&now-(s.base.at||now)>30*60000&&incomingRoute.origin&&incomingRoute.destination&&(incomingRoute.origin!==s.base.request.origin||incomingRoute.destination!==s.base.request.destination)&&!incomingDate.range&&!incomingDate.dates?.length){
   s.base.request.departureDate=null;s.base.request.departureRange=null;s.base.request.returnDate=null;s.base.submitted=false;s.base.awaiting='departureDate';s.questions={};s.lastQuestion=null;
  }
  legacy.importSession(id,s.base);
  s.questions ||= {};s.tripId ||= crypto.randomUUID();s.consultantDecision=null;if(enabled(this.env)&&!flightAdviceKind(text))updateConsultantMemory(s,text,{now});s.history.push({role:'user',text:clean(text)});s.history=s.history.slice(-24);
  const t=normalize(clean(text)),say=reply=>{
   if(/[؟?]/.test(reply))s.lastQuestion=reply;
   s.history.push({role:'assistant',text:reply});s.history=s.history.slice(-24);this.save(id,s);return{complete:false,reply};
  };
  const sayApproved=(kind,{suffix='',allowFreshModel=false}={})=>{
   const reply=chooseApprovedReply(kind,{state:s,now});
   // A safe first model greeting remains personalized. Repeated model prose
   // cannot replace the reviewed variation or the actual expansion question.
   const proposed=s.consultantDecision?.reply;
   const repeated=typeof proposed==='string'&&proposed.trim()&&s.history.some(m=>m.role==='assistant'&&normalize(m.text).includes(normalize(proposed)));
   if(s.consultantDecision&&(!allowFreshModel||repeated))s.consultantDecision.reply=null;
   return say(reply+(suffix?' '+suffix:''));
  };
  if(s.humanOwned)return say('المحادثة الآن بمتابعة موظف الحجوزات.');
  if(s.base?.request&&/(?:اي|شو)\s*(?:تواريخ|مواعيد)|(?:تواريخ|مواعيد)\s*(?:متاح[هة]|موجود[هة]?)/.test(t)&&!naturalDate(t,now).range&&!/\d|حجز|تثبيت|الغاء/.test(t)){
   const next=legacy.exportSession(id),route=require('./travel-language').languagePatch(text);
   Object.assign(next.request,route);next.request.departureDate=null;next.request.departureRange=null;next.submitted=false;next.awaiting='departureDate';delete next.proposal;legacy.importSession(id,next);s.base=next;s.status='collecting';
   return {...say(`أكيد 🌷 بشيكلك التواريخ المتاحة من ${next.request.origin} إلى ${next.request.destination}. أي فترة بتناسبك: هالأسبوع، الأسبوع الجاي، أو الشهر الجاي؟`),cancel:true};
  }
  let hasChange=/كيلو|كغ|\bkg\b|بدل|خلي|غير|قصدي|شخص|بالغ|طفل|رضيع|مسافر|على |الى |من |بكرا|بكره|اسبوع|شهر|الجمعة|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|\d|مطار|دمشق|الشام|حلب|الشارق|شارق|دبي|ذهاب|عوده|رجعه|وزن|شنط|رحله|توقيت/.test(t);
  if(/^(?:احذف بياناتي|امسح بياناتي|حذف بياناتي)$/.test(t)){clearCustomerProfile(this.store,id);this.store.delete(id);legacy.importSession(id,null);return{complete:false,cancel:true,reply:'تم حذف بيانات محادثتك المحفوظة وإيقاف طلب البحث الحالي.'};}
  if(/^(?:الغاء|الغي|وقف البحث|اوقف البحث|الغاء الطلب|cancel|ابد[اأ] من جديد)$/.test(t)){s.status='cancelled';s.pendingRequests=[];s.offers=[];s.selected=null;s.comparison=null;s.previous=[];s.questions={};delete s.pendingQuotedOffer;s.lastQuestion=null;s.tripId=crypto.randomUUID();legacy.importSession(id,null);return{...say('تم إيقاف بحث الأسعار. إذا قصدك إلغاء تذكرة صادرة، وضّحلي حتى نميّزها عن طلب الاستعلام.'),cancel:true};}
  // Explicit service questions read the current trip; model routing cannot cancel it.
  if(airlineComparisonQuestion(t)){
   s.selected=priorSelection;s.base=priorBase;legacy.importSession(id,priorBase);
   const comparison=compareShownAirlines(s,now);
   return say(comparison||((s.offers.length?'ما عندي الآن عرضان حديثان متحققان للشركتين ضمن طلبك. ':'')+(explainService(t,s.base?.request,s.status,now)||'منقارن السعر والتوقيت والوزن لكل شركة حسب الخيارات المتحققة لرحلتك.')));
  }
  if(ticketServiceQuestion(t)){
   s.selected=priorSelection;s.base=priorBase;legacy.importSession(id,priorBase);
   return say('شروط تعديل التذكرة أو إلغائها والاسترداد بتختلف حسب الفئة وشركة الطيران. موظف الحجوزات بيراجع شروط تذكرتك والرسوم قبل أي إجراء؛ هالسؤال ما ألغى بحثك أو تذكرتك.');
  }
  const followup=!quotedOfferReferences.length&&!s.pendingQuotedOffer?(acceptsExpansion(s.base,text,now)?{fields:{},proposal:true}:knownTripFollowup(text,s.base?.request,now,{monthScope:s.base?.monthScope})):null;
  if(followup&&!followup.proposal&&s.base?.submitted&&['queued','searching'].includes(s.status)&&Object.entries(followup.fields).every(([key,value])=>value===s.base.request[key]))return say('شكرًا لمتابعتك 🌷 البحث مستمر على نفس تفاصيل رحلتك، وأول ما تتأكد الأسعار والتواقيت منرسلها إلك.');
  let decision=followup?{intent:'change',fields:followup.fields,question:null,option:null}:null;
  if(!followup&&!/^(?:شكرا|شكرا لانتظارك|بانتظاركن|ناطر|منتظر|شو صار|وين وصلتوا|لسا ما رديتوا|ليش ما رديتوا|وين الاسعار)[؟?!. ]*$/.test(t))try{if(usePrepared){const value=await prepared.promise;if(value.error)throw value.error;decision=value.decision;}else decision=await this.nlu(clean(text),{request:s.base?.request,lastQuestion:s.lastQuestion,history:s.history.slice(-12),questions:s.questions,proposal:s.base?.proposal,quotedOfferReferences,turnMessages,awaiting:s.base?.awaiting,selectedOffer:s.offers.find(o=>o.id===s.selected),offerSummaries:offerSummaries(s.offers),status:s.status,consultantMemory:s.consultant},{env:this.env,now});if(decision)console.log('ASSISTANT_NLU_OK_'+decision.intent);}catch(error){console.log(/^NLU_[A-Z0-9_]+$/.test(error.message)?error.message:'ASSISTANT_NLU_UNAVAILABLE');}
  // The customer's explicit scope choice outranks a model's suggestion that
  // the held message should become a separate journey.
  if(choiceMode==='continue'&&decision?.intent==='additional_request')decision={...decision,intent:'change',...(decision.consultant?{consultant:{...decision.consultant,action:'amend',reply:null,nextStep:'search'}}:{})};
  if(decision?.consultant){s.consultantDecision={...decision.consultant,question:decision.question,at:now};updateConsultantMemory(s,text,{now,preferences:decision.consultant.preferences});}
  const repeatSearch=Boolean(s.base?.submitted&&['done','failed','paused'].includes(s.status)&&(followup||/(?:شفلي|شوفلي|شوف لي|شيك|ابحث|عيد البحث|اعد البحث|نفس الرحل[هة]|نفس التفاصيل)/.test(t)));
  if(repeatSearch){
   // A complete known itinerary can be checked again without collecting its dates.
   const retry=legacy.exportSession(id);retry.submitted=false;if(followup){retry.awaiting=null;if(!followup.proposal)delete retry.proposal;}
   legacy.importSession(id,retry);s.base=retry;
   decision={...(decision||{}),intent:'change',fields:{...(decision?.fields||{})},question:null,option:null};
  }
  const directedRoute=require('./travel-language').languagePatch(clean(text));
  if(directedRoute.origin||directedRoute.destination){
   decision={...(decision||{}),intent:decision?.intent==='additional_request'?'additional_request':'change',fields:{...(decision?.fields||{}),...(directedRoute.origin?{origin:directedRoute.origin}:{}),...(directedRoute.destination?{destination:directedRoute.destination}:{})},question:null,option:null};
  }
  // Explicit requests to change/expand dates take precedence over model explanations
  // of already displayed fares. Preserve every other trip fact.
  const dateAmendment=!followup&&/(?:تواريخ|تاريخ|موعد|ايام|شهر|اسبوع)/.test(t)&&/(?:غير|تاني|ثاني|ارخص|اقل سعر|ابحث|دور|شوف|شفلي|عطيني|اعطيني|اريد|بدي)/.test(t);
  if(dateAmendment){
   const parsed=naturalDate(t,now);
   const fields={...(decision?.fields||{})};
   if(parsed.range){fields.rangeStart=parsed.range.start;fields.rangeEnd=parsed.range.end;fields.departureDate=null;}
   else if(parsed.dates?.[0]&&!parsed.invalid)fields.departureDate=parsed.dates[0];
   if(fields.rangeStart&&fields.rangeEnd||fields.departureDate)decision={...(decision||{}),intent:'change',fields,question:null,option:null};
   else return say('أكيد 🌷 منبحث عن تواريخ تانية على نفس المسار وعدد المسافرين والوزن. أي فترة بتناسبك: هالشهر، الشهر الجاي، أو الاتنين؟');
  }
  const additional=choiceMode!=='continue'&&(decision?.intent==='additional_request'||/(?:طلب|رحل[هة]|سفر[هة])\s*(?:تاني|ثاني|تاني[هة]|ثاني[هة])|(?:وكمان|وكمان بدي)\s+(?:بدي\s+)?(?:رحل[هة]|من\s)/.test(t));
  if(additional&&['queued','searching'].includes(s.status)){
   s.pendingRequests ||= [];
   if(s.pendingRequests.some(r=>normalize(r.text)===t))return say('طلبك التاني بانتظار نتيجة الأول، وبس أرسلك الأسعار ببدأ فيه.');
   if(s.pendingRequests.length>=5)return say('عندي خمس طلبات إلك بانتظار البحث. خلّيني أخلصها بالترتيب، وبعدها منكمل باقي الرحلات.');
   s.pendingRequests.push({text:clean(text),at:now});
   return say('عم اشتغل حاليًا على طلبك الأول، وبس أرسلك الأسعار ببدأ بطلبك التاني.');
  }
  const pendingQuote=s.pendingQuotedOffer?.expiresAt>=now?s.pendingQuotedOffer:null;
  const scopedReferences=quotedOfferReferences.length>1?quotedOfferReferences:pendingQuote?.references||[];
  if(scopedReferences.length>1){
   const number=t.match(/(?:الخيار|العرض)\s*(\d+)|^(\d{1,2})$|(?:^|\s)(الاول|التاني|الثاني|الثالث)(?:\s|$)/);
   const numberRef=number?Number(number[1]||number[2]||({الاول:1,التاني:2,الثاني:2,الثالث:3})[number[3]]):null;
   const explicit=scopedReferences.filter(ref=>{const o=s.offers.find((o,i)=>(o.reference||i+1)===ref);return numberRef===ref||o&&[o.timing?.out?.flight,o.timing?.back?.flight,o.request.departureDate,o.request.departureDate?dateText(o.request.departureDate):null,o.request.returnDate,o.request.returnDate?dateText(o.request.returnDate):null].some(value=>value&&t.replace(/\s/g,'').toLowerCase().includes(String(value).replace(/\s/g,'').toLowerCase()));});
   if(explicit.length===1){
    const previousFields=pendingQuote?.fields||{},currentFields=decision?.fields||{};
    const merged=Object.fromEntries([...new Set([...Object.keys(previousFields),...Object.keys(currentFields)])].map(k=>[k,currentFields[k]!=null&&(!Array.isArray(currentFields[k])||currentFields[k].length)?currentFields[k]:previousFields[k]??currentFields[k]??null]));
    const ref=explicit[0],o=s.offers.find((o,i)=>(o.reference||i+1)===ref);
    decision={...(decision||{}),intent:decision?.intent==='booking'?'booking':decision?.intent==='explain'?'explain':'select',option:ref,fields:merged,question:null};
    if(decision.intent==='booking'){s.selected=o.id;legacy.importSession(id,{request:selectedSupplierRequest(o.request),submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);}
    if(s.questions.offerChoice){s.questions.offerChoice.answered=true;s.questions.offerChoice.status='answered';s.questions.offerChoice.answeredAt=now;}
    delete s.pendingQuotedOffer;
   }else if(['select','booking'].includes(decision?.intent)||/(?:هاد|هدا|هذا|هداك|نفسه|نفسها|هالرحل[هة]|ثبتلي|احجزلي|هالخيار)/.test(t)){
    const prior=s.questions.offerChoice;
    const oldFields=pendingQuote?.fields||{},newFields=decision?.fields||{};
    const pendingFields=Object.fromEntries([...new Set([...Object.keys(oldFields),...Object.keys(newFields)])].map(k=>[k,newFields[k]!=null&&(!Array.isArray(newFields[k])||newFields[k].length)?newFields[k]:oldFields[k]??newFields[k]??null]));
    s.pendingQuotedOffer={references:scopedReferences,fields:pendingFields,expiresAt:now+30*60000};
    s.questions.offerChoice={field:'offerChoice',tripId:s.tripId,askedAt:prior?.askedAt||now,answered:false,status:'asked',reason:'quoted_multiple_offers',options:scopedReferences};
    return say(prior&&!prior.answered?'المسار والتفاصيل محفوظة؛ الرسالة فيها أكتر من عرض، ورقم الخيار بيميّز الرحلة اللي قصدتها.':'الرسالة فيها أكتر من عرض. أي خيار تقصد؟ اذكر رقم الخيار أو رقم الرحلة حتى نكمل على العرض الصحيح.');
   }
  }
  const hasDecisionFields=Boolean(decision&&Object.values(decision.fields||{}).some(v=>Array.isArray(v)?v.length:v!==null));
  if(hasDecisionFields&&s.questions.clarification){s.questions.clarification.answered=true;s.questions.clarification.status='answered';s.questions.clarification.answeredAt=now;}
  const socialIntent=!hasDecisionFields?decision?.intent:null;
  const asksShownOffer=!/غالي|خصم|ارخص من هيك|ما في ارخص/.test(t)&&decision?.intent==='explain'&&(decision.option!==null||/سعر|قديش|بكم|افضل|احسن|ارخص|بتنصح|تنصحني|العرض|الخيار/.test(t)&&!hasDecisionFields);
  if(asksShownOffer){
   // An inquiry reads existing verified data; it never selects, changes or books.
   s.selected=priorSelection;legacy.importSession(id,priorBase);s.base=priorBase;
   const offered=s.offers.map((o,i)=>{
    const provider=o.provider||o.request?.provider||'airarabia',verified=verifiedOffer(o,o.request,provider);
    return verified?{...verified,reference:Number.isInteger(o.reference)?o.reference:i+1}:null;
   }).filter(Boolean);
   const option=decision.option;
   let matches=Number.isInteger(option)?offered.filter(o=>o.reference===option):offered;
   if(!Number.isInteger(option)){
    if(/فلاي\s*شام|fly\s*cham/i.test(t)&&!/العربي[هة]|air\s*arabia/i.test(t))matches=matches.filter(o=>o.provider==='flycham');
    else if(/العربي[هة]|air\s*arabia/i.test(t)&&!/فلاي\s*شام|fly\s*cham/i.test(t))matches=matches.filter(o=>o.provider==='airarabia');
   }
   if(!matches.length)return say('ما عندي عرض متحقق لهالخيار ضمن النتائج الحالية. تفاصيل طلبك محفوظة؛ ما رح أعطيك سعر بتخمين أو أغيّر اختيارك.');
   const recommendation=!Number.isInteger(option)&&/افضل|احسن|ارخص|بتنصح|تنصحني/.test(t);
   if(recommendation){matches.sort((a,b)=>{const x=BigInt(a.price.sellingTotal.replace('.','')),y=BigInt(b.price.sellingTotal.replace('.',''));return x<y?-1:x>y?1:0;});matches=matches.filter(o=>o.price.sellingTotal===matches[0].price.sellingTotal);}
   const heading=recommendation?'من ناحية السعر، هاد الأوفر بين العروض المتحققة المعروضة إلك، حسب تواريخ ووزن كل عرض:':'أكيد، هاي تفاصيل العرض المتحقق اللي سألت عنه:';
   return say(heading+'\n\n'+matches.slice(0,6).map(formatOffer).join('\n\n')+'\n\nالسعر والتوفر قابلان للتغير حتى الإصدار. هاد توضيح للعرض؛ ما تغيّر اختيارك وما تم حجز تذكرة.');
  }

  hasChange ||= hasDecisionFields||followup?.start;
  if(!followup?.start&&!hasDecisionFields&&(socialIntent==='greeting'||/^(?:مرحبا|اهلا|هلا|السلام عليكم|hi|hello|ابد[اأ])$/.test(t))){const greeted=s.greeted;s.greeted=true;const welcome=!s.base?.request?.origin&&!s.base?.request?.destination?returningGreeting(this.store,id,'flight',{now}):null;if(welcome){if(decision)decision.reply=null;return say(welcome);}return sayApproved(greeted?'welcome_back':'greeting',{allowFreshModel:true});}
  if(!hasDecisionFields&&(!hasChange||/^(?:كتير )?غالي|^ارخص من هيك|^ما في ارخص/.test(t))&&(socialIntent==='negotiate'||/زبط|تزبط|خصم|تخفيض|نزل.*سعر|غالي|ارخص من هيك|ما في ارخص/.test(t))){
   const advice=priceSavingAdvice(s,now);
   if(advice){if(s.consultantDecision)s.consultantDecision.reply=null;return say(advice);}
   const proposal=legacy.proposeExpansion(id,{now});
   return sayApproved('negotiation_ack',{suffix:proposal?'فينا نقارن سبعة أيام بعد آخر موعد مع الحفاظ على المسار والوزن. بتناسبك نوسّع البحث لهالفترة؟':'فينا نقارن أيام أو تواقيت أوسع إذا بتناسبك، بدون تغيير تفاصيلك من عندنا.'});
  }
  if(!hasChange&&(socialIntent==='goodbye'||/برجع|بعدي?ن بحكي|بدي فكر|بدي افكر|سلام$/.test(t))){s.status='paused';return{...sayApproved('goodbye'),cancel:true};}
  if(!recoveredRoute&&!hasChange&&(socialIntent==='status'||/بانتظار|بالانتظار|ناطر|منتظر|شو صار|وين وصلت|لسا|اصبر/.test(t))){
   const busy=['searching','queued'].includes(s.status);s.waitingCount=(s.waitingCount||0)+1;
   if(busy)return sayApproved('waiting');
   if(s.consultantDecision)s.consultantDecision.reply=null;
   return say(s.status==='failed'?'لم يكتمل التحقق من الأسعار للطلب السابق. فينا نعيد المحاولة على نفس التفاصيل، أو نحدد فترة ثانية.':s.status==='done'?'نتائج البحث المتحققة موجودة بالعرض السابق. فينا نراجع الخيار اللي بناسبك أو نوسّع الفترة إذا حبيت.':s.status==='unsupported'?'تفاصيل رحلتك موجودة، لكن ما تأكّد سعر لهالمسار بعد. بتحب نقارن من الشارقة إلى دمشق أو حلب، أو بالعكس؟':s.base?.awaiting?'تفاصيلك محفوظة، وبانتظار جوابك على النقطة اللي سألتك عنها حتى أكمل على نفس الطلب.':'معك، ما في بحث جارٍ حاليًا. ابعتلي تفاصيل رحلتك ومنرتّب الخيارات المناسبة.');
  }
  if(!recoveredRoute&&!hasChange&&(socialIntent==='thanks'||/^(?:شكرا|شكراً|يسلمو|مشكور|يعطيك العافيه|يعطيك العافية|تمام شكرا|👍)$/.test(t)))return sayApproved('thanks');
  if(socialIntent==='cancel'){s.status='cancelled';s.pendingRequests=[];s.questions={};s.lastQuestion=null;legacy.importSession(id,null);return{...say('تم إيقاف بحث الأسعار الحالي. إذا قصدك تذكرة صادرة، وضّحلي حتى نميّزها عن الاستعلام.'),cancel:true};}
  const selectOffer=(index,{announce=true}={})=>{
   const offer=s.offers.find(o=>o.reference===index+1)||s.offers[index];
   if(!offer)return say('أي عرض تقصد؟ اذكر تاريخ الرحلة أو رقم الخيار من آخر مقارنة.');
   s.selected=offer.id;
   // Subsequent amendments apply to the selected flight, not the whole earlier comparison.
   legacy.importSession(id,{request:selectedSupplierRequest(offer.request),submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);
   if(!announce)return null;
   const provider=offer.provider||offer.request?.provider||'airarabia',airline=provider==='flycham'?'فلاي شام':provider==='airarabia'?'العربية للطيران':'';
   const checkedAt=Number.isFinite(offer.checkedAt)?offer.checkedAt:Date.parse(offer.verifiedAt);
   const verified=Number.isFinite(checkedAt)&&checkedAt<=now&&now-checkedAt<=15*60000?verifiedOffer(offer,offer.request,provider):null,priceText=verified?` بسعر إجمالي ${verified.price.sellingTotal} درهم`:'';
   return say(`تمام 🌷 اخترت الخيار ${offer.reference||index+1}${airline?' ('+airline+')':''} بتاريخ ${offer.request.departureDate}، رحلة ${offer.timing.out.flight}${priceText}. السعر والتوفر يحتاجان إعادة تحقق عند التثبيت. لإتمام التثبيت مع موظف الحجوزات أرسل: *ثبتلي*، أو خبرني إذا عندك أي تعديل.`+(offerAirportMismatchNotice(offer)?'\n\n'+offerAirportMismatchNotice(offer):''));
  };
  const selection=t.match(/(?:الخيار|العرض)\s*(\d+)|^(الاول|التاني|الثاني|الثالث)$/);
  if(selection&&!hasDecisionFields&&!/كيلو|كغ|\bkg\b|بدل|خلي|غير|قصدي|ذهاب|عوده|رجعه/.test(t))return selectOffer(selection[1]?Number(selection[1])-1:({الاول:0,التاني:1,الثاني:1,الثالث:2})[selection[2]]);
  if(!hasDecisionFields&&/السعر.*(?:شخص|كلنا|اثنين|اتنين)|للشخص|للمجموع/.test(t))return say('العرض الآلي المؤكد حاليًا لشخص بالغ واحد، وليس سعر مجموعة. إذا عددكن أكثر لازم نتحقق من السعر والتوفر للعدد الصحيح، ولا نضرب سعر الشخص بالعدد كتقدير مؤكد.');
  if(/^(?:ارجع متل قبل|رجعه متل قبل|الغي اخر تعديل)$/.test(t)){
   const previous=s.previous.pop();if(!previous)return say('أي تفصيل بدك نرجعه: الوزن أو التاريخ أو المسار؟');legacy.importSession(id,previous);s.base=previous;s.status='queued';previous.submitted=false;legacy.importSession(id,previous);const result=legacy.handleMessage(id,'تابع نفس التفاصيل',{now});this.save(id,s);return result;
  }
  if(['اي','نعم','تمام','اوكي','حاضر','ok'].includes(t)&&['searching','queued'].includes(s.status)&&!s.lastQuestion)return say('تمام 🌷 البحث مستمر على نفس تفاصيل طلبك، وأول ما تتأكد الأسعار والتواقيت منرسلها إلك.');
  if(!recoveredRoute&&['اي','نعم','تمام'].includes(t)&&s.lastQuestion?.includes('أو'))return say('أكيد، أي خيار من المذكورين بتفضّل؟');
  if(decision?.intent==='select'&&decision.option!==null){const selected=selectOffer(decision.option-1,{announce:!hasDecisionFields});if(selected)return selected;}
  if(s.status==='unsupported'&&s.base?.request&&/شوف سعر شخص واحد/.test(t)){s.savedGroupPassengers=structuredClone(s.base.request.passengers);s.base.request.passengers={adults:1,children:0,infants:0,ages:[]};s.base.submitted=false;legacy.importSession(id,s.base);s.status='collecting';}
  const book=decision?.intent==='booking'||(!hasDecisionFields&&/كيف.*(?:ثبت|تثبيت|حجز|ادفع)|بدي ثبت|ثبتلي|ثب[تّ]لي|احجزلي|احجز لي|رابط الدفع|بدي احكي.*موظف|حولني للموظف/.test(t));
  if(book&&s.status==='unsupported'&&s.base?.request){if(!s.handoffId)s.handoffId=this.store.handoff(id,{request:s.base.request,offer:null,verificationRequired:true});s.status='handoff_pending';return{...say('وصل طلبك لموظف الحجوزات لمراجعة السعر والتوفر للعدد الصحيح؛ ما تم حجز أو إصدار تذكرة.'),cancel:true,handoff:s.handoffId};}
  if(book){
   const offer=s.offers.find(o=>o.id===s.selected)||s.offers.length===1&&s.offers[0];
   if(!offer)return say(s.offers.length?'أكيد، أي خيار بدك تتابع تثبيته؟ اذكر رقم الخيار أو تاريخ الرحلة.':'التثبيت يتم مع موظف الحجوزات. خلينا نحدد الرحلة أولًا حتى تكون تفاصيل طلبك واضحة.');
   if(!s.handoffId)s.handoffId=this.store.handoff(id,{request:offer.request,offer,verificationRequired:true});s.status='handoff_pending';
   const reference=offer.reference||s.offers.indexOf(offer)+1;
   const details=offer.timing?.out?.flight&&offer.request?.departureDate?` (الخيار ${reference} — رحلة ${offer.timing.out.flight} بتاريخ ${offer.request.departureDate})`:'';
   return{...say(`سجّلت رغبتك بمتابعة تثبيت الخيار المحدد${details} 🌷 التثبيت والإصدار مع موظف الحجوزات بعد إعادة التحقق من السعر والتوفر؛ لم يتم حجز أو إصدار تذكرة بعد. يمكنك تحضير صورة الجواز ليتابع معك الموظف مباشرة.`),cancel:true,handoff:s.handoffId};
  }
  const knownTripType=decision?.fields?.tripType||legacy.parseTripType(clean(text))||s.base?.request?.tripType;
  const repeatsKnownTrip=Boolean(knownTripType&&/ذهاب|عود[هة]|رجع[هة]|نوع الرحل/.test(normalize(decision?.question||'')));
  const hypothetical=decision?.intent==='compare'||(/لو |قديش.*(?:بيصير|بصير|بوفر|الفرق)|بس قلي|بس قولي|بكم/.test(t)&&Boolean(s.base?.submitted));
  if(/كيلو|كغ/.test(t)&&/معنا|سوا|مجموع/.test(t)&&!/(?:لكل|للشخص|اجمالي|مجموع)/.test(t))return say('الوزن المطلوب لكل شخص، أو مجموع الوزن للمسافرين سوا؟');
  if(/زيادة|اضافي|إضافي/.test(t)&&/كيلو|كغ/.test(t)&&!s.base?.request?.baggageRequest)return say('قصدك الوزن الإجمالي للشنط، أو زيادة فوق الوزن الموجود بالعرض؟');
  if(/مو هيك|ما فهمت|ما قلت|بدي اخف|غيره$|مو .*|لا تغير/.test(t)&&!decision)return say('خلينا نضبطها بدون تغيير التفاصيل الثانية: قصدك نعدّل الوزن، أو الموعد، أو نبحث عن سعر أقل؟');
  if(/الا |باستثناء|لازم.*(?:اوصل|وصول)|بدون ترانزيت|مباشر حصرا|قطعتين|قطعه|قطعة/.test(t)&&!decision)return say('فهمت إن عندك شرط إضافي على الرحلة. حتى ما نعرض خيارًا غير مناسب، حدد الشرط بدقة؛ التحقق الآلي من بعض شروط الوصول وعدد القطع غير مكتمل حاليًا.');
  if(!hasDecisionFields&&(decision?.intent==='explain'||/طرق الدفع|وسائل الدفع|كيف الدفع|تحويل بنكي|كاش|بطاقه|فيزا كارد|تابي|اقساط|عنوان|وين مكتب|مكان المكتب|موقع المكتب|فرع|اشرح|فهمني|كيف يعني|شو يعني|ليش السعر|تغير السعر|الوزن|الامتع[هة]|مطار بديل|ترانزيت|مباشر|رضيع|بيبي|كم ساع[هة]|مد[هة] الرحل[هة]|قديش بتاخد الطيار[هة]|كم بتستغرق|الفرق بين|اي مطار/.test(t))){
   const facts=explainService(t,s.base?.request,s.status,now);
   if(facts)return say(facts);
  }
  if(!recoveredRoute&&!hasDecisionFields&&['uncertain','other','explain'].includes(decision?.intent)&&decision?.question&&!knownQuestion(decision.question,s.base?.request)){
   const key='clarification',fingerprint=normalize(decision.question);const prior=s.questions[key];
   if(prior?.fingerprint===fingerprint&&!prior.answered)return say('أنا معك، والتفاصيل اللي اتفقنا عليها محفوظة. وضّحلي النقطة اللي قصدتها بكلمتين حتى أعطيك جواب مناسب.');
   s.questions[key]={field:key,tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:decision.intent,fingerprint};return say(decision.question);
  }
  reconcileSupplierRestriction(id,s,text,decision?.fields);
  const previous=legacy.exportSession(id);
  let result=legacy.handleMessage(id,affirmativeEnglishText(clean(text)),{now,patch:decision?.fields});let base;
  base=legacy.exportSession(id);
  const changed=JSON.stringify(previous?.request||{})!==JSON.stringify(base?.request||{});
  for(const [field,q]of Object.entries(s.questions)){
   const r=base?.request;const answered=answeredField(field,r);
   if(answered){q.answered=true;q.answeredAt ||= now;q.status='answered';}
  }
  if(!result.clarification&&decision?.intent==='clarify'&&!hasDecisionFields&&!changed&&!knownQuestion(decision.question,base?.request)&&decision.question)result.reply=decision.question;

  if(!result.complete&&base?.awaiting){
   const field=base.awaiting,prior=s.questions[field];
   if(prior&&!prior.answered&&(!result.clarification||prior.reason===result.clarification)){
    prior.reminderCount=(prior.reminderCount||0)+1;
    const r=base.request;
    const reminders={origin:r.destination?`الوجهة ${r.destination} واضحة؛ ناقصني مدينة الانطلاق فقط.`:'ناقصني مدينة الانطلاق حتى أحدد المسار.',destination:r.origin?`المغادرة من ${r.origin} واضحة؛ ناقصني المدينة اللي بدك توصل إلها فقط.`:'ناقصني المدينة اللي بدك توصل إلها.',departureDate:'تفاصيل المسار محفوظة؛ ناقصني يوم السفر أو فترة مناسبة مثل هالأسبوع.',tripType:'المسار والموعد محفوظين؛ ناقصني إذا بدك ذهاب بس أو مع رجعة.',returnDate:'تفاصيل الذهاب محفوظة؛ ناقصني موعد الرجعة أو مدة الإقامة.',passengers:'تفاصيل الرحلة محفوظة؛ ناقصني عدد المسافرين فقط، مثل «شخص واحد». إذا معك أطفال اذكر أعمارهن.'};
    result.reply=field==='origin'&&r.originCountry==='سوريا'?`الانطلاق من سوريا واضح 🌷 من دمشق ولا حلب بدك تطلع${r.destination?' إلى '+r.destination:''}؟`:reminders[field]||result.reply;
   }
   else{s.questions[field]={field,tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:result.clarification||'missing_fact',reminderCount:0};s.lastQuestion=result.reply;}
  }
  if(result.complete){s.lastQuestion=null;s.revision=(s.revision||0)+1;}
  if(changed&&previous?.submitted&&!result.complete){result.cancel=true;s.status='collecting';}
  if(base?.request?.passengers){const p=base.request.passengers;if(p.children+p.infants>(p.ages?.length||0)){result={complete:false,reply:s.questions.childrenAges&&!s.questions.childrenAges.answered?'عدد المسافرين محفوظ؛ باقي أعمار الأطفال والرضّع وقت السفر حتى نميّز الفئة الصحيحة.':'كم أعمار الأطفال والرضّع وقت السفر؟ اذكر عمر كل واحد حتى ما نحسب سعرًا لفئة غير صحيحة.'};s.questions.childrenAges ||= {field:'childrenAges',tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:'passenger_category'};}}
  if(hypothetical&&result.complete){result.comparison=true;s.comparison={request:result.request,base:previous};legacy.importSession(id,previous);}
  else if(result.complete){delete s.pendingQuotedOffer;if(previous)s.previous.push(previous);s.previous=s.previous.slice(-5);s.offers=[];s.selected=null;s.comparison=null;}
  if(result.complete){const issue=capabilityIssue(result.request.provider==='flycham'&&!result.request.providerExclusive?{...result.request,provider:'airarabia'}:result.request);if(issue){s.status='unsupported';const blocked=legacy.exportSession(id);if(blocked){blocked.submitted=false;legacy.importSession(id,blocked);}result={complete:false,reply:issue==='passengers'?familyRequestCard(result.request):issue==='route'?'ما عندي سعر مؤكّد لهالمسار حاليًا. بتحب نقارن من الشارقة إلى دمشق أو حلب، أو بالعكس؟':'سجّلت تفاصيلك، لكن شروط القطع أو المقعد الخاص أو قيود الوصول تحتاج تحققًا لا يدعمه الربط الحالي. لن أعرض خيارًا وكأنه يحققها دون تأكيد.'};}else{s.status='queued';s.coverage=[];}}
  if(!result.complete&&!['searching','queued'].includes(s.status)&&/طلبك السابق مسجل/.test(result.reply)){
   const r=base.request,dates=r.departureRange?`من ${dateText(r.departureRange.start)} إلى ${dateText(r.departureRange.end)}`:r.departureDate?dateText(r.departureDate):null;
   result.reply=`تفاصيل رحلتك عندي 🌷 من ${r.origin} إلى ${r.destination}${dates?'، '+dates:''}. إذا بدك أعيد التحقق من السعر على نفس التفاصيل، قلّي «أعد البحث».`;
  }
  if(!result.complete&&['searching','queued'].includes(s.status)&&/طلبك السابق مسجل/.test(result.reply))result.reply='شكرًا لمتابعتك 🌷 البحث مستمر على نفس تفاصيل رحلتك، وأول ما تتأكد الأسعار والتواقيت منرسلها إلك. أي تعديل تبعته منضيفه على نفس الطلب.';
  if(result.complete&&!result.comparison)rememberFlightJourney(this.store,id,result.request,{now});
  if(result.complete)s.lastQuestion=null;else if(/[؟?]/.test(result.reply))s.lastQuestion=result.reply;
  if(/^(?:يسلمو|شكرا|شكراً|مشكور)/.test(t)&&result.complete)result.reply='تكرم عيونك. '+result.reply;
  s.history.push({role:'assistant',text:result.reply});s.history=s.history.slice(-24);
  this.save(id,s);return result;
 }
 beginNextRequest(id){const s=this.state(id);if(!s.queueReady||!['done','failed'].includes(s.status)||!s.pendingRequests?.length)return null;const next=s.pendingRequests.shift();s.queueReady=false;s.previous ||= [];if(s.base)s.previous.push(s.base);s.previous=s.previous.slice(-5);s.base=null;s.history=[];s.consultant={};s.lastQuestion=null;s.questions={};s.selected=null;s.offers=[];s.offerMessages={};s.comparison=null;s.activeComparisonId=null;delete s.requestChoice;delete s.pendingQuotedOffer;delete s.offerPages;delete s.handoffId;s.status='collecting';s.tripId=crypto.randomUUID();legacy.importSession(id,null);this.store.set(id,s);return next;}
 proposeSearchExpansion(id,{now=Date.now()}={}){const s=this.state(id);if(!s.base?.submitted||!s.base.request||s.humanOwned)return null;legacy.importSession(id,s.base);const proposal=legacy.proposeExpansion(id,{now,days:7});if(proposal){s.base=legacy.exportSession(id);this.store.set(id,s);}return proposal;}
 jobState(id,status){const s=this.state(id);s.status=status;this.store.set(id,s);}
 progress(id,data,messageId){const s=this.state(id);s.status='searching';if(data.coverage)s.coverage=data.coverage.slice(0,32);if(data.offer){const o=data.offer;if(o.request&&o.timing?.out?.flight&&/^\d+\.\d{2}$/.test(o.price?.sellingTotal||'')){const item={...o,id:offerId(o),messageId};const index=s.offers.findIndex(x=>x.id===item.id);if(index<0)s.offers.push(item);else s.offers[index]=item;s.offers=s.offers.slice(-80);}}this.store.set(id,s);}
 status(){return{policy:POLICY.version,aiConfigured:aiConfigured(this.env),aiProvider:aiProvider(this.env),...this.store.status(),humanRoutingConfigured:Boolean(this.env.HUMAN_HANDOFF_RECIPIENT),providers:POLICY.providers};}
}
module.exports={AssistantEngine,offerId,tripSummaryQuestion,tripSummaryReply};
