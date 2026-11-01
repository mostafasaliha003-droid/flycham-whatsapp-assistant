'use strict';

// This catalog contains applicant answers, never office policy defaults. In
// particular, absence of a health answer is not evidence for a negative answer.
const YES_NO = [
  {id: 'yes', label: 'نعم', value: true},
  {id: 'no', label: 'لا', value: false}
];
const choice = (prompt, options = YES_NO) => ({type: 'choice', prompt, options});
const text = (prompt, maxLength = 200, format = 'text') => ({type: 'text', prompt, maxLength, format});
const CATALOG = {
  maritalStatus: choice('ما الحالة الاجتماعية الحالية؟', [
    {id: 'single', label: 'أعزب / عزباء', value: 'single'},
    {id: 'married', label: 'متزوج / متزوجة', value: 'married'},
    {id: 'divorced', label: 'مطلق / مطلقة', value: 'divorced'},
    {id: 'widowed', label: 'أرمل / أرملة', value: 'widowed'},
    {id: 'separated', label: 'منفصل / منفصلة', value: 'separated'}
  ]),
  previousNationality: choice('هل سبق أن حملت جنسية أخرى غير جنسيتك الحالية؟'),
  previousNationalityDetails: {...text('ما الجنسية أو الجنسيات السابقة؟ اذكر التفاصيل الصحيحة.', 1500), dependsOn: {field: 'previousNationality', value: true}},
  travelledLastFiveYears: choice('هل سافرت إلى أي دولة خلال السنوات الخمس الماضية؟'),
  travelHistory: {...text('ما الدول التي زرتها خلال السنوات الخمس الماضية؟ اذكر التفاصيل الصحيحة المتاحة.', 1500), dependsOn: {field: 'travelledLastFiveYears', value: true}},
  performUmrah: choice('هل تنوي أداء العمرة في هذه الزيارة؟'),
  gccResident: choice('هل لديك حالياً إقامة سارية في إحدى دول مجلس التعاون الخليجي؟'),
  priorGccDeportation: choice('هل سبق أن صدر بحقك إبعاد أو ترحيل من إحدى دول مجلس التعاون الخليجي؟'),
  priorGccRuleViolation: choice('هل سبق أن صدر بحقك منع دخول أو مخالفة لأنظمة الإقامة أو الزيارة في إحدى دول مجلس التعاون الخليجي؟'),
  'health.hospitalizedOrEmergency': choice('هل هناك حالة تنويم في المستشفى حالياً أو تتلقى علاج الطوارئ؟'),
  'health.accidentDisability': choice('هل تعرضت لحادث أدى إلى إصابتك بعلة أو إعاقة؟'),
  'health.congenitalCondition': choice('هل لديك حالات ضعف أو تشوه خلقي؟'),
  saudiAddress: text('ما عنوان الإقامة المقصود داخل السعودية؟ اذكر العنوان الفعلي أو اسم الفندق والمدينة بعد تأكيدهما.', 1500),
  birthPlace: text('ما مكان الميلاد كما هو مثبت في جواز السفر؟'),
  sex: choice('ما الجنس المثبت في جواز السفر؟', [
    {id: 'male', label: 'ذكر (M)', value: 'M'},
    {id: 'female', label: 'أنثى (F)', value: 'F'},
    {id: 'unspecified', label: 'غير محدد في الجواز (X)', value: 'X'}
  ]),
  latinFirstName: text('ما الاسم الأول بالأحرف اللاتينية كما هو في جواز السفر؟', 200, 'latinName'),
  latinFamilyName: text('ما اسم العائلة بالأحرف اللاتينية كما هو في جواز السفر؟', 200, 'latinName'),
  latinFatherName: text('ما اسم الأب بالأحرف اللاتينية كما هو في جواز السفر؟', 200, 'latinName'),
  latinGrandfatherName: text('ما اسم الجد بالأحرف اللاتينية كما هو في جواز السفر؟', 200, 'latinName'),
  arabicFirstName: text('ما الاسم الأول بالعربية كما هو مثبت في المستندات؟', 200, 'arabicName'),
  arabicFamilyName: text('ما اسم العائلة بالعربية كما هو مثبت في المستندات؟', 200, 'arabicName'),
  arabicFatherName: text('ما اسم الأب بالعربية كما هو مثبت في المستندات؟', 200, 'arabicName'),
  arabicGrandfatherName: text('ما اسم الجد بالعربية كما هو مثبت في المستندات؟', 200, 'arabicName'),
  passportNumber: text('ما رقم جواز السفر بالضبط كما هو في الجواز؟', 20, 'passportNumber'),
  passportType: choice('ما نوع جواز السفر المثبت في الجواز؟', [
    {id: 'ordinary', label: 'عادي', value: 'ordinary'},
    {id: 'diplomatic', label: 'دبلوماسي', value: 'diplomatic'},
    {id: 'service', label: 'خدمة', value: 'service'},
    {id: 'special', label: 'خاص', value: 'special'}
  ]),
  nationalityCode: text('ما رمز الجنسية الحالي المكون من ثلاثة أحرف كما هو في الجواز؟', 3, 'countryCode'),
  issuingCountryCode: text('ما رمز دولة إصدار الجواز المكون من ثلاثة أحرف كما هو في الجواز؟', 3, 'countryCode'),
  birthDate: text('ما تاريخ الميلاد الكامل كما هو في الجواز؟ أرسله بصيغة سنة-شهر-يوم (YYYY-MM-DD).', 10, 'date'),
  issueDate: text('ما تاريخ إصدار الجواز؟ أرسله بصيغة سنة-شهر-يوم (YYYY-MM-DD).', 10, 'date'),
  expiryDate: text('ما تاريخ انتهاء الجواز؟ أرسله بصيغة سنة-شهر-يوم (YYYY-MM-DD).', 10, 'date'),
  residenceExpiry: text('ما تاريخ انتهاء الإقامة الحالية؟ أرسله بصيغة سنة-شهر-يوم (YYYY-MM-DD).', 10, 'date'),
  emiratesId: text('ما رقم الهوية الإماراتية كما هو مثبت على الهوية؟', 30, 'emiratesId'),
  entryDate: text('ما تاريخ الدخول المقصود إلى السعودية؟ أرسله بصيغة سنة-شهر-يوم (YYYY-MM-DD).', 10, 'date'),
  'guardian.relationship': choice('ما صلة ولي الأمر لهذا المتقدم القاصر؟', [
    {id: 'father', label: 'الأب', value: 'father'},
    {id: 'mother', label: 'الأم', value: 'mother'}
  ]),
  'guardian.status': choice('ما الحالة الفعلية لتأشيرة ولي الأمر؟', [
    {id: 'issued', label: 'صدرت التأشيرة', value: 'issued'},
    {id: 'pending', label: 'لم تصدر بعد', value: 'pending'}
  ]),
  'guardian.visaReference': text('ما رقم التأشيرة الصادرة لولي الأمر؟ اذكر الرقم كما هو في التأشيرة.')
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const QUESTION_CATALOG = deepFreeze(CATALOG);
const REQUIRED_FIELDS = Object.freeze([
  'maritalStatus', 'previousNationality', 'travelledLastFiveYears', 'performUmrah',
  'gccResident', 'priorGccDeportation', 'priorGccRuleViolation',
  'health.hospitalizedOrEmergency', 'health.accidentDisability', 'health.congenitalCondition',
  'saudiAddress', 'birthPlace', 'sex', 'latinFirstName', 'latinFamilyName'
]);

function fail(code, field) { throw Object.assign(Error(code), {code, field}); }
function definition(field) {
  if (typeof field !== 'string' || !Object.hasOwn(QUESTION_CATALOG, field)) fail('VISA_QUESTION_UNKNOWN', field);
  return QUESTION_CATALOG[field];
}
function questionFor(field, {applicantIndex, applicantName} = {}) {
  const question = definition(field);
  if (!Number.isSafeInteger(applicantIndex) || applicantIndex < 0 || applicantIndex > 99) fail('VISA_APPLICANT_INDEX_INVALID', field);
  if (applicantName !== undefined && (typeof applicantName !== 'string' || applicantName.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(applicantName))) fail('VISA_APPLICANT_NAME_INVALID', field);
  const name = typeof applicantName === 'string' ? applicantName.trim() : '';
  return {
    field, applicantIndex,
    ...structuredClone(question),
    prompt: `للمتقدم رقم ${applicantIndex + 1}${name ? ` (${name})` : ''}: ${question.prompt}`
  };
}
function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validateAnswer(field, value) {
  const question = definition(field);
  if (question.type === 'choice') {
    const option = question.options.find(option => option.value === value);
    if (!option) fail('VISA_ANSWER_INVALID', field);
    return option.value;
  }
  if (typeof value !== 'string' || value.length > question.maxLength || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail('VISA_ANSWER_INVALID', field);
  const answer = value.trim();
  // An unknown answer is a request for clarification, never a usable fact.
  if (!answer || /^(?:unknown|not\s+known|n\/?a|لا\s*[أا]?عرف|لا\s*[أا]دري|غير\s*معروف|غير\s*مؤكد)$/iu.test(answer)) fail('VISA_ANSWER_INVALID', field);
  const valid = {
    text: () => true,
    latinName: () => /^[\p{Script=Latin}\p{M} .'-]+$/u.test(answer) && /\p{Script=Latin}/u.test(answer),
    arabicName: () => /^[\p{Script=Arabic}\p{M} .'-]+$/u.test(answer) && /\p{Script=Arabic}/u.test(answer),
    passportNumber: () => /^[A-Z0-9]{1,20}$/i.test(answer),
    countryCode: () => /^[A-Z]{3}$/.test(answer),
    date: () => realDate(answer),
    emiratesId: () => /^784\d{12}$/.test(answer.replace(/[ -]/g, ''))
  }[question.format];
  if (!valid || !valid()) fail('VISA_ANSWER_INVALID', field);
  return question.format === 'emiratesId' ? answer.replace(/[ -]/g, '') : answer;
}
function atPath(object, path) {
  return path.split('.').reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
}
function requiredQuestions(fields = {}, {requestedFields} = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail('VISA_APPLICANT_FIELDS_INVALID');
  if (requestedFields !== undefined && (!Array.isArray(requestedFields) || requestedFields.some(field => typeof field !== 'string'))) fail('VISA_QUESTION_FIELDS_INVALID');
  const requested = requestedFields === undefined ? [...REQUIRED_FIELDS] : [...new Set(requestedFields)];
  for (const field of requested) definition(field);
  for (const field of [...requested]) {
    const dependency = definition(field).dependsOn;
    if (!dependency || requested.includes(dependency.field)) continue;
    try { validateAnswer(dependency.field, atPath(fields, dependency.field)); }
    catch { requested.push(dependency.field); }
  }
  // Dependent details follow their controlling question even when the caller
  // requested only that question, so affirmative facts cannot lose their detail.
  for (const [field, question] of Object.entries(QUESTION_CATALOG)) {
    if (question.dependsOn && (requested.includes(question.dependsOn.field) || requested.includes(field)) && atPath(fields, question.dependsOn.field) === question.dependsOn.value && !requested.includes(field)) requested.push(field);
  }
  return requested.filter(field => {
    const question = definition(field);
    if (question.dependsOn && atPath(fields, question.dependsOn.field) !== question.dependsOn.value) return false;
    try { validateAnswer(field, atPath(fields, field)); return false; } catch { return true; }
  });
}

module.exports = {QUESTION_CATALOG, questionFor, validateAnswer, requiredQuestions};
