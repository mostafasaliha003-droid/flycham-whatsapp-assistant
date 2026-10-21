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

function emptyRequest() {
  return { origin: null, destination: null, departureDate: null, tripType: null, returnDate: null, passengers: null };
}

function parseDate(text) {
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
  const route = parseRoute(text);
  if (route.origin) request.origin = route.origin;
  if (route.destination) request.destination = route.destination;

  const dates = [...text.matchAll(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g)].map((m) => parseDate(m[0])).filter(Boolean);
  const hasReturn = /ذهاب\s*(?:و|مع)\s*عود|ذهاب\s*عودة|round\s*trip|return\s*flight/i.test(text);
  const oneWay = /ذهاب\s*فقط|one\s*way/i.test(text);
  if (dates.length) {
    request.departureDate = dates[0];
    if (dates.length > 1) request.returnDate = dates[1];
  }
  if (hasReturn || dates.length > 1) request.tripType = 'round_trip';
  if (oneWay) {
    request.tripType = 'one_way';
    request.returnDate = null;
  }
  const passengers = parsePassengerCount(text);
  if (passengers) request.passengers = passengers;
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
  const request = sessions.get(sender) ?? emptyRequest();
  applyParsed(request, text);
  const missing = missingFields(request);
  sessions.set(sender, request);

  if (missing.length) {
    return { complete: false, reply: `حتى أتحقق من السعر، أحتاج هذه المعلومة: ${prompts[missing[0]]}` };
  }
  sessions.delete(sender);
  return {
    complete: true,
    request: structuredClone(request),
    reply: `وصلني طلب التسعير بهذه التفاصيل:\n${summarize(request)}\nسأتحقق من السعر المتاح وأرسل لك عرضًا. هذا الطلب للاستعلام فقط ولا يتم حجز أو إصدار تذكرة تلقائيًا.`
  };
}

function resetSessions() { sessions.clear(); }

module.exports = { handleMessage, resetSessions, parseDate, parsePassengerCount };
