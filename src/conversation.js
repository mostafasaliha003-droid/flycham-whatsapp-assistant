'use strict';

const sessions = new Map();

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
  return { origin: null, destination: null, departureDate: null, tripType: null, returnDate: null, passengers: null };
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

function applyParsed(request, text) {
  text = normalizeDigits(text);
  let invalidDate = false;
  const route = parseRoute(text);
  if (route.origin) request.origin = route.origin;
  if (route.destination) request.destination = route.destination;

  const dateTokens = [...text.matchAll(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/g)].map((m) => m[0]);
  const dates = dateTokens.map((token) => parseDate(token));
  const today = new Date().toISOString().slice(0, 10);
  if (dates.some((date) => !date || date < today)) invalidDate = true;
  const hasReturn = /ذهاب\s*(?:و|مع)\s*عود|ذهاب\s*عودة|round\s*trip|return\s*flight/i.test(text);
  const oneWay = /ذهاب\s*فقط|one\s*way/i.test(text);
  if (dates.length && !invalidDate) {
    if (dates.length > 1 && dates[1] < dates[0]) invalidDate = true;
    else {
      request.departureDate = dates[0];
      if (dates.length > 1) request.returnDate = dates[1];
    }
  }
  if (hasReturn || dates.length > 1) request.tripType = 'round_trip';
  if (oneWay) {
    request.tripType = 'one_way';
    request.returnDate = null;
  }
  const passengers = parsePassengerCount(text);
  if (passengers) request.passengers = passengers;
  return invalidDate;
}

function missingFields(request) {
  return ['origin', 'destination', 'departureDate', 'tripType', ...(request.tripType === 'round_trip' ? ['returnDate'] : []), 'passengers']
    .filter((field) => !request[field]);
}

function summarize(request) {
  const passengerParts = [`${request.passengers.adults} بالغ`];
  if (request.passengers.children) passengerParts.push(`${request.passengers.children} طفل (${request.passengers.ages.join('، ')} سنة)`);
  if (request.passengers.infants) passengerParts.push(`${request.passengers.infants} رضيع`);
  return [
    `المسار: ${request.origin} ← ${request.destination}`,
    `الذهاب: ${request.departureDate}`,
    request.tripType === 'round_trip' ? `العودة: ${request.returnDate}` : 'نوع الرحلة: ذهاب فقط',
    `المسافرون: ${passengerParts.join('، ')}`
  ].join('\n');
}

function handleMessage(sender, text) {
  const normalized = String(text ?? '').trim();
  if (/^(إلغاء|الغاء|إلغاء الطلب|الغاء الطلب|cancel|restart|ابدأ من جديد)$/i.test(normalized)) {
    sessions.delete(sender);
    return { complete: false, reply: 'تم إلغاء طلب التسعير. إذا أردت البدء من جديد، أرسل تفاصيل رحلتك أو اكتب «ابدأ».' };
  }
  if (/^(ابدأ|مرحبا|مرحباً|السلام عليكم|hi|hello|start)$/i.test(normalized) && !sessions.has(sender)) {
    return { complete: false, reply: 'أهلًا بك في خدمة طلبات طيران فلاي شام. أرسل مسار الرحلة وتاريخ الذهاب، مثل: من دبي إلى دمشق، 11-11-2026، ذهاب فقط.' };
  }
  const request = sessions.get(sender) ?? emptyRequest();
  const invalidDate = applyParsed(request, normalized);
  const missing = missingFields(request);
  sessions.set(sender, request);

  if (invalidDate) {
    return { complete: false, reply: 'التاريخ غير صالح أو مضى، أو أن العودة تسبق الذهاب. أرسل تاريخًا مستقبليًا صحيحًا بصيغة يوم-شهر-سنة، مثل 11-11-2026.' };
  }

  if (missing.length) {
    return { complete: false, reply: `حتى أتحقق من السعر، أحتاج هذه المعلومة: ${prompts[missing[0]]}` };
  }
  sessions.delete(sender);
  return {
    complete: true,
    request: structuredClone(request),
    reply: `وصلتني تفاصيل طلب الاستعلام:\n${summarize(request)}\nالتحقق من السعر غير متاح تلقائيًا حاليًا؛ يحتاج الطلب إلى مراجعة موظف على بوابة فلاي شام قبل تأكيد أي سعر. لا يتم حجز أو إصدار تذكرة تلقائيًا.`
  };
}

function resetSessions() { sessions.clear(); }

module.exports = { handleMessage, resetSessions, parseDate, parsePassengerCount, normalizeDigits };
