'use strict';

const sessions = new Map();
const { pricingDemo } = require('./pricing-demo');
const {naturalDate,normalize,dubaiDay,addDays,iso}=require('./arabic-dates');

const prompts = {
  origin: 'من أي مدينة أو مطار؟',
  destination: 'إلى أي مدينة أو مطار؟',
  departureDate: 'ما تاريخ الذهاب؟ اكتب التاريخ مثل 11-11-2026.',
  tripType: 'هل الرحلة ذهاب فقط أم ذهاب وعودة؟',
  returnDate: 'ما تاريخ العودة؟',
  passengers: 'كم عدد المسافرين؟ اذكر البالغين والأطفال والرضع، وأعمار الأطفال والرضع.'
};

const digitMap = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
function normalizeDigits(text) { return String(text).replace(/[٠-٩۰-۹]/g, (digit) => digitMap[digit]); }

function emptyRequest() {
  return { origin: null, destination: null, departureDate: null, departureRange:null, stayNights:null, tripType: null, returnDate: null, passengers: null, baggageRequest:null };
}

function parseDate(text) {
  text = normalizeDigits(text);
  const match = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseRoute(text) {
  const match = text.match(/(?:من|from)\s+([^،,\n]+?)\s+(?:إلى|الى|لـ|to)\s+([^،,\n]+)/i);
  return match ? { origin: match[1].trim(), destination: match[2].trim() } : {};
}

function parsePassengerCount(text) {
  text = normalizeDigits(text);
  const adult = text.match(/(?:بالغ(?:ين)?\s*[:：]?\s*(\d+)|(\d+)\s*بالغ(?:ين)?)/i);
  const child = text.match(/أطفال?\s*[:：]?\s*(\d+)/i);
  const infant = text.match(/رضع?\s*[:：]?\s*(\d+)/i);
  const generic = text.match(/(?:نحن|عددنا|لـ|for)?\s*(\d+)\s*(?:مسافرين|مسافر|أشخاص|شخص)/i);
  if (!adult && !child && !infant && !generic) return null;
  const adults = adult ? Number(adult[1] || adult[2]) : (generic ? Number(generic[1]) : 1);
  const children = child ? Number(child[1]) : 0;
  const infants = infant ? Number(infant[1]) : 0;
  const ages = [...text.matchAll(/(?:عمر|أعمار|عمره|عمرها)\s*(\d{1,2})/g)].map((m) => Number(m[1]));
  if (adults + children + infants < 1 || adults + children + infants > 9) return null;
  if (children + infants > 0 && ages.length < children + infants) return null;
  return { adults, children, infants, ages };
}

function applyParsed(request, text, {now=Date.now(),awaiting}={}) {
  const previousDepartureDate=request.departureDate;
  text = normalizeDigits(text);
  const plain=normalize(text);
  if(/ارخص|اقل سعر/.test(plain))request.searchMode='cheapest';
  const weight=text.match(/(?:وزن(?:\s+إضافي|\s+اضافي)?|بدي|أريد|اريد)\s*(\d{1,3})\s*(?:كيلو|كغ|kg)/i);
  if (weight && Number(weight[1]) > 0 && Number(weight[1]) <= 100) request.baggageRequest={checkedWeightKg:Number(weight[1]),requestedByCustomer:true};
  let invalidDate = false;
  const route = parseRoute(text);
  if (route.origin) request.origin = route.origin;
  if (route.destination) request.destination = route.destination;
  const cities=[['الشارقة','الشارقة'],['الشارقه','الشارقة'],['دمشق','دمشق'],['دبي','دبي'],['حلب','حلب'],['اللاذقية','اللاذقية']];
  for(const [alias,city]of cities){
    if(new RegExp('(?:من|from)\\s+'+alias).test(text))request.origin=city;
    if(new RegExp('(?:الى|إلى|على|علي|ع)\\s*'+alias).test(text))request.destination=city;

  }
  // A reply to a city question may include airport names, fillers or IATA codes.
  // Match known names only; never assign a vague country to an airport.
  const airportNames=[['الشارقة',/(?:ال)?شار(?:ق[ةه]?|ج[ةه])|\bsharjah\b|\bshj\b/i],['دمشق',/دمشق|(?:ال)?شام|\bdamascus\b|\bdam\b/i],['دبي',/دبي|\bdubai\b|\bdxb\b/i],['حلب',/حلا?ب|\baleppo\b|\balp\b/i],['اللاذقية',/اللاذقي[ةه]|\blatakia\b|\bltk\b/i]];
  for(const [city,pattern]of airportNames){
    const match=plain.match(pattern);if(!match)continue;
    const prefix=plain.slice(0,match.index);
    if(/(?:من|from)\s*(?:مطار\s*)?$/.test(prefix))request.origin=city;
    if(/(?:الى|علي|على|ع|to)\s*(?:مطار\s*)?$/.test(prefix))request.destination=city;
  }
  const anyUae=/(?:اي|ايا|كل|جميع)\s*(?:مطار|مطارات)(?:\s+ب?الامارات|\s+في\s+الامارات)|(?:ما\s*(?:بتفرق|بيفرق)|مو\s*مهم).*مطار/.test(plain);
  if(anyUae){request.origin='الشارقة';request.originScope='any_uae';}
  const mentioned=airportNames.filter(([,pattern])=>pattern.test(plain));
  if(!anyUae&&mentioned.length===1&&(awaiting==='origin'||awaiting==='destination')){
    const city=mentioned[0][0];
    if(!/(?:من|from)\s/.test(plain)&&!/(?:الى|علي|على|to)\s/.test(plain)){
      const opposite=awaiting==='origin'?'destination':'origin';
      if(request[opposite]!==city)request[awaiting]=city;
    }
    else if(awaiting==='origin'&&/(?:من|from)\s/.test(plain))request.origin=city;
    else if(awaiting==='destination'&&/(?:الى|علي|على|to)\s/.test(plain))request.destination=city;
  }
  if(/سوريا|سورية|سوريه/.test(text))request.destinationCountry='سوريا';
  if(request.origin&&request.origin===request.destination)request.destination=null;

  const dateTokens = [...text.matchAll(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/g)].map((m) => m[0]);
  const dates = dateTokens.map((token) => parseDate(token));
  const today = iso(dubaiDay(now));
  if (dates.some((date) => !date || date < today)) invalidDate = true;
  const hasReturn = /ذهاب\s*(?:و|مع)\s*عود|ذهاب\s*عودة|روحة\s*(?:و|مع)\s*رجعة|رايح\s*(?:و)?راجع|مع\s*رجعة|round\s*trip|return\s*flight/i.test(text);
  const oneWay = /ذهاب\s*(?:فقط|بس)|روحة\s*(?:فقط|بس)|one\s*way/i.test(text) || plain==='ذهاب';
  if (dates.length && !invalidDate) {
    if (dates.length > 1 && dates[1] < dates[0]) invalidDate = true;
    else {
      if((awaiting==='returnDate'||/^(?:العودة|الرجعة|رجعة|عودة)/.test(text))&&dates.length===1)request.returnDate=dates[0];
      else {request.departureDate = dates[0];request.departureRange=null;}
      if (dates.length > 1) request.returnDate = dates[1];
    }
  }
  if (hasReturn || dates.length > 1) request.tripType = 'round_trip';
  const duration=plain.match(/(?:بعد|لمدة|مده|مدة)\s*(\d+)\s*(?:ايام|يوم|ليالي|ليلة)/);
  let nights=duration?Number(duration[1]):/(?:بعد|لمدة|مده|مدة)\s*اسبوعين/.test(plain)?14:/(?:بعد|لمدة|مده|مدة)\s*اسبوع/.test(plain)?7:null;
  if(awaiting==='returnDate'&&plain==='اسبوع')nights=7;
  if(nights&&nights<=90){request.stayNights=nights;if(request.departureDate)request.returnDate=iso(addDays(new Date(request.departureDate+'T00:00:00Z'),nights));}
  if(!dates.length && !nights){
    const natural=naturalDate(text,now);
    if(natural.invalid)invalidDate=true;
    if(natural.range){request.departureRange=natural.range;request.departureDate=null;}
    else if(natural.dates.length){if(awaiting==='returnDate'||/^(?:العودة|الرجعة|رجعة|عودة)/.test(text))request.returnDate=natural.dates[0];
      else {request.departureDate=natural.dates[0];request.departureRange=null;}}
  }
  if (oneWay) {
    request.tripType = 'one_way';
    request.returnDate = null;
    request.stayNights=null;
  }
  let passengers = parsePassengerCount(text);
  if(/^(?:لحالي|انا لحالي|انا بس|شخص واحد|واحد|1)$/.test(plain)&&awaiting==='passengers')passengers={adults:1,children:0,infants:0,ages:[]};
  if(/^(?:شخصين|نحن شخصين|اتنين|اثنين|2)$/.test(plain)&&awaiting==='passengers')passengers={adults:2,children:0,infants:0,ages:[]};
  if(awaiting==='passengers'&&/^\d+$/.test(plain)&&Number(plain)>=1&&Number(plain)<=9)passengers={adults:Number(plain),children:0,infants:0,ages:[]};
  if (passengers) request.passengers = passengers;
  if(request.departureRange){
    if(!request.tripType){request.tripType='one_way';request.comparisonTripDefault=true;}
    if(!request.passengers){request.passengers={adults:1,children:0,infants:0,ages:[]};request.comparisonPassengerDefault=true;}
  }
  if(request.stayNights&&request.departureDate&&request.departureDate!==previousDepartureDate&&dates.length<=1&&awaiting!=='returnDate')request.returnDate=iso(addDays(new Date(request.departureDate+'T00:00:00Z'),request.stayNights));
  if(request.departureDate&&request.returnDate&&request.returnDate<request.departureDate)invalidDate=true;
  return invalidDate;
}

function missingFields(request) {
  return ['origin', 'destination', ...(!request.departureDate&&!request.departureRange?['departureDate']:[]), 'tripType',
    ...(request.tripType === 'round_trip'&&!request.returnDate&&!request.stayNights ? ['returnDate'] : []), 'passengers'].filter(field=>!request[field]);
}

function summarize(request) {
  const passengerParts = [`${request.passengers.adults} بالغ`];
  if (request.passengers.children) passengerParts.push(`${request.passengers.children} طفل (${request.passengers.ages.join('، ')} سنة)`);
  if (request.passengers.infants) passengerParts.push(`${request.passengers.infants} رضيع`);
  return [
    `المسار: ${request.origin} ← ${request.destination}`,
    request.departureRange?`فترة البحث: ${request.departureRange.start} إلى ${request.departureRange.end}`:`الذهاب: ${request.departureDate}`,
    request.tripType === 'round_trip' ? (request.stayNights?`مدة الإقامة: ${request.stayNights} أيام`:`العودة: ${request.returnDate}`) : 'نوع الرحلة: ذهاب فقط',
    `المسافرون: ${passengerParts.join('، ')}`,
    ...(request.baggageRequest ? [`الوزن المطلوب: ${request.baggageRequest.checkedWeightKg} كغ؛ يحتاج التحقق من توفره وسعره.`] : [])
  ].join('\n');
}

function handleMessage(sender, text, {now=Date.now()}={}) {
  const normalized = String(text ?? '').trim();
  if (normalized === 'اختبار التسعير') return {complete:false,reply:pricingDemo()};
  if (/^(إلغاء|الغاء|إلغاء الطلب|الغاء الطلب|cancel|restart|ابدأ من جديد)$/i.test(normalized)) {
    sessions.delete(sender);
    return { complete: false, reply: 'تم إلغاء طلب التسعير. إذا أردت البدء من جديد، أرسل تفاصيل رحلتك أو اكتب «ابدأ».' };
  }
  if (/^(ابدأ|مرحبا|مرحباً|السلام عليكم|hi|hello|start)$/i.test(normalized) && !sessions.has(sender)) {
    return { complete: false, reply: 'أهلًا بك في خدمة طلبات الطيران من مجموعة الرمال. أرسل مسار الرحلة وتاريخ الذهاب، مثل: من الشارقة إلى دمشق، 11-11-2026، ذهاب فقط.' };
  }
  const state=sessions.get(sender) ?? {request:emptyRequest(),awaiting:null,submitted:false,at:now};
  const request=state.request;
  const before=JSON.stringify(request);
  const invalidDate = applyParsed(request, normalized,{now,awaiting:state.awaiting});
  const missing = missingFields(request);
  state.at=now;sessions.set(sender,state);

  if (invalidDate) {
    return { complete: false, reply: 'التاريخ غير صالح أو مضى، أو أن العودة تسبق الذهاب. أرسل تاريخًا مستقبليًا صحيحًا بصيغة يوم-شهر-سنة، مثل 11-11-2026.' };
  }

  if (missing.length) {
    state.awaiting=missing[0];
    const prompt=missing[0]==='destination'&&request.origin?`مطار المغادرة ${request.origin} واضح. إلى أي مدينة${request.destinationCountry?' بسوريا':''} بدك تسافر؟ مثل دمشق أو حلب.`:missing[0]==='returnDate'&&request.departureRange?'قديش مدة إقامتك؟ مثل أسبوع أو 10 أيام، حتى أقارن أسعار الذهاب والعودة.':missing[0]==='destination'&&request.destinationCountry?'على أي مدينة بسوريا: دمشق أو حلب أو غيرها؟':prompts[missing[0]];
    const understood=request.departureRange?`تمام، رح نبحث ضمن الفترة من ${request.departureRange.start} إلى ${request.departureRange.end}. `:request.departureDate&&/بكر|بكره|غد|الاحد|الاثنين|الاتنين|الثلاث|التلات|الاربع|الخميس|الجمع|السبت/.test(normalize(normalized))?`تمام، فهمت تاريخ الذهاب ${request.departureDate}. `:'';
    return { complete: false, reply: `${request.originScope==='any_uae'?'فهمت إنك تقبل أي مطار بالإمارات. الربط الحالي يفحص الشارقة فقط، لذلك المقارنة لا تشمل باقي مطارات الإمارات. ':''}${understood}${prompt}` };
  }
  if(state.submitted&&before===JSON.stringify(request))return{complete:false,reply:'طلبك السابق مسجل. إذا بدك تغيّر الموعد أو المسار، ابعتلي التعديل.'};
  state.submitted=true;state.awaiting=null;
  return {
    complete: true,
    request: structuredClone(request),
    reply: `وصلتني تفاصيل طلب الاستعلام:\n${summarize(request)}\nالتحقق من السعر غير متاح تلقائيًا حاليًا؛ يحتاج الطلب إلى مراجعة موظف على بوابة الطيران قبل تأكيد أي سعر. لا يتم حجز أو إصدار تذكرة تلقائيًا.`
  };
}

function resetSessions() { sessions.clear(); }

module.exports = { handleMessage, resetSessions, parseDate, parsePassengerCount, normalizeDigits };
