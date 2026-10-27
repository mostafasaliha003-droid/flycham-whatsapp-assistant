'use strict';

// This is a local display mapper, not an executor. Only observed stable
// controls are listed. Unknown dropdown values and declaration controls are
// deliberately never guessed, ticked, or transmitted.
const TEXT_BINDINGS = Object.freeze([
  ['arabicFirstName', 'الاسم الأول بالعربية', 'AFIRSTNAME'],
  ['arabicFatherName', 'اسم الأب بالعربية', 'AFATHER'],
  ['arabicGrandfatherName', 'اسم الجد بالعربية', 'AGRAND'],
  ['arabicFamilyName', 'اسم العائلة بالعربية', 'AFAMILY'],
  ['latinFirstName', 'الاسم الأول بالإنجليزية', 'EFIRSTNAME'],
  ['latinFatherName', 'اسم الأب بالإنجليزية', 'EFATHER'],
  ['latinGrandfatherName', 'اسم الجد بالإنجليزية', 'EGRAND'],
  ['latinFamilyName', 'اسم العائلة بالإنجليزية', 'EFAMILY'],
  ['passportNumber', 'رقم جواز السفر', 'PASSPORTnumber'],
  ['birthPlace', 'مكان الميلاد', 'BIRTH_PLACE'],
  ['saudiAddress', 'عنوان السكن داخل السعودية (KSA Home Address)', 'ADDRESS_HOME']
]);
const DATE_BINDINGS = Object.freeze([
  ['issueDate', 'تاريخ إصدار الجواز', 'PASSPORT_ISSUE_DATE'],
  ['expiryDate', 'تاريخ انتهاء الجواز', 'PASSPORT_EXPIRY_DATe'],
  ['birthDate', 'تاريخ الميلاد', 'BIRTH_DATE'],
  ['entryDate', 'تاريخ الدخول المتوقع', 'ExpectedEntryDate', 'proposedEntryDate']
]);
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code) { throw Object.assign(Error(code), {code, statusCode: 409}); }

function buildMofaPreview(summary) {
  if (!object(summary) || !hasText(summary.jobId) || !hasText(summary.caseId) || !Number.isSafeInteger(summary.revision) || summary.revision < 1 || summary.state === 'not_started' || summary.confirmationRequired === true) fail('RAAD_PREVIEW_DRAFT_REQUIRED');
  if (summary.state === 'stale' || summary.invalidated === true || summary.review?.invalidated === true) fail('RAAD_PREVIEW_DRAFT_STALE');
  if (!['draft', 'needs_information', 'ready_for_portal_review'].includes(summary.state) || !object(summary.fields)) fail('RAAD_PREVIEW_DRAFT_INVALID');

  const sourceFields = summary.fields, defaults = object(summary.defaults) ? summary.defaults : {};
  const confirmed = new Set(Array.isArray(summary.review?.confirmedFields) ? summary.review.confirmedFields : []);
  const fields = [], unresolved = [], notices = [
    'هذه معاينة محلية للبيانات المحفوظة فقط؛ لا تُعبّئ البوابة ولا تُرسل طلباً أو بيانات إلى أي جهة.',
    'مراجعة بيانات المسودة ليست موافقة على تعهدات البوابة أو تفويضاً بقبولها؛ التعهدات والأسئلة الصحية والسجل السابق لا تُؤشّر تلقائياً.',
    'يجب التحقق من عناصر البوابة وتسمياتها الحالية قبل أي تنفيذ مستقبلي؛ المعاينة لا تتيح التنفيذ.'
  ];
  function source(field, defaultField = field) {
    if (Object.hasOwn(sourceFields, field) && hasText(sourceFields[field])) return {sourceField: 'fields.' + field, value: sourceFields[field], suggested: false};
    if (defaultField !== null && Object.hasOwn(defaults, defaultField) && hasText(defaults[defaultField])) return {sourceField: 'defaults.' + defaultField, value: defaults[defaultField], suggested: true};
    return null;
  }
  function reviewed(value) { return summary.review?.complete === true && confirmed.has(value.sourceField); }
  function row(value, portalLabel, control, kind, status, mappedValue = value.value) {
    const result = {sourceField: value.sourceField, portalLabel, ...control, kind, value: mappedValue, status};
    fields.push(result);
    return result;
  }
  for (const [field, label, id] of TEXT_BINDINGS) {
    // Names, passport identifiers, and addresses are never supplied by defaults.
    const value = source(field, null);
    if (value) row(value, label, {controlId: id}, 'text', value.suggested ? 'suggestion_requires_review' : reviewed(value) ? 'reviewed_fact' : 'saved_fact');
  }
  const phone = source('applicationPhone');
  if (phone) {
    row(phone, 'رقم الجوال', {controlName: 'MobileInfo.Mobile'}, 'text', 'display_only_phone_format_unverified');
    unresolved.push('تنسيق رقم الجوال غير متحقق مع بادئة الدولة المنفصلة؛ الرقم معروض كما حُفظ دون حذف رمز الدولة أو تقسيم الرقم إلى جزء محلي.');
  }
  for (const [field, label, id, defaultField] of DATE_BINDINGS) {
    const value = source(field, defaultField || null);
    if (value) row(value, label, {controlId: id}, 'date', value.suggested ? 'suggestion_date_format_unverified' : 'display_only_date_format_unverified');
  }
  if (fields.some(field => field.kind === 'date')) unresolved.push('صيغة التواريخ المطلوبة في البوابة غير متحققة؛ القيم المحفوظة معروضة كما هي دون تحويل أو تخمين.');

  const purpose = source('visitPurpose');
  if (purpose) {
    const fits = purpose.value === 'tourism';
    const approved = fits && reviewed(purpose);
    const field = row(purpose, 'نوع التأشيرة: زيارة سياحية', {controlName: 'VisaKind'}, 'select', !fits ? 'route_requires_review' : approved ? purpose.suggested ? 'suggestion_reviewed_option' : 'reviewed_option' : purpose.suggested ? 'suggestion_requires_review' : 'needs_review', approved ? '19' : purpose.value);
    if (approved) field.displayValue = 'زيارة سياحية';
    if (!fits) unresolved.push('غرض الزيارة المحفوظ يختلف عن مسار الزيارة السياحية؛ لم يُستبدل تلقائياً بالقيمة السياحية.');
    else if (!approved) unresolved.push('قيمة الزيارة السياحية المعروفة هي 19، وتبقى مرشحة حتى المراجعة الدقيقة لحقل غرض الزيارة المحفوظ.');
  }
  const mission = source('mission');
  if (mission) {
    const fits = mission.value === 'Abu Dhabi';
    const approved = fits && reviewed(mission);
    const field = row(mission, 'أقرب ممثلية سعودية', {controlName: 'EmbassyCode'}, 'select', !fits ? 'route_requires_review' : approved ? mission.suggested ? 'suggestion_reviewed_option' : 'reviewed_option' : mission.suggested ? 'suggestion_requires_review' : 'needs_review', approved ? '214' : mission.value);
    if (approved) field.displayValue = 'أبوظبي';
    if (!fits) unresolved.push('الممثلية السعودية المحفوظة تختلف عن أبوظبي المعتمدة لهذا المسار؛ يلزم مراجعتها ولم تُستبدل بقيمة أخرى.');
    else if (!approved) unresolved.push('قيمة ممثلية أبوظبي المعروفة هي 214، وتبقى مرشحة حتى المراجعة الدقيقة لحقل الممثلية المحفوظ.');
  }
  for (const [field, label, id] of [
    ['residenceCountryCode', 'بلد الإقامة', 'ddlResidenceCountry'],
    ['passportType', 'نوع جواز السفر', 'PASSPORType']
  ]) {
    const value = source(field, field === 'residenceCountryCode' ? field : null);
    if (!value) continue;
    row(value, label, {controlId: id}, 'select', value.suggested ? 'suggestion_needs_matching' : 'needs_matching');
    unresolved.push(`قيمة «${label}» في قائمة البوابة لم تُطابق بعد؛ القيمة المعروضة مصدرها المسودة وليست قيمة خيار مؤكدة في البوابة.`);
  }
  if (hasText(sourceFields.nationalityCode)) unresolved.push('معرّف عنصر الجنسية الحالية وقيمه لم يُحسما؛ عنصر عرض Select2 المرصود ليس عنصر إدخال متحققاً، وتبقى الجنسية في المسودة دون ربط تخميني.');
  if (hasText(sourceFields.issuingCountryCode)) unresolved.push('دولة إصدار الجواز مستقلة عن الجنسية؛ عنصرها وقيمه لم يُتحققا وتبقى في المسودة دون نسخ الجنسية إليها.');
  if (hasText(sourceFields.sex)) unresolved.push('عنصر الجنس وقيمه في البوابة غير متحققين؛ لم تُخمن قيمة اختيار أو معرّف عنصر.');
  unresolved.push('حقل المهنة (TextOccupationName) ظاهر، لكن مصدر بياناته ومطابقته غير متحققين؛ لم تُفترض مهنة.');
  unresolved.push('مطابقة حقول تصريح الإقامة في دول مجلس التعاون ورقم الهوية الإماراتية وتاريخ انتهاء الإقامة غير متحققة؛ لم تُخمن عناصرها أو قيمها.');
  unresolved.push('عناصر رفع الجواز والإقامة والصورة الشخصية غير متحققة؛ لا تُرفع مستندات من هذه المعاينة.');
  unresolved.push('عدد الدخول وصلاحية التأشيرة ومدة الإقامة تتطلب تحققاً بعد اختيار الجنسية؛ لم تُحوّل سياسة المكتب إلى قيم بوابة.');
  if (fields.some(field => field.controlId === 'ADDRESS_HOME')) notices.push('ربط عنوان السعودية يستند إلى التسمية المرصودة KSA Home Address؛ يجب التحقق من التسمية الحالية قبل أي تنفيذ مستقبلي.');
  if (fields.some(field => field.sourceField === 'defaults.proposedEntryDate')) notices.push('تاريخ الدخول المقترح محسوب من تجهيز المسودة؛ تحقق منه عند التقديم ومن موعد السفر الفعلي.');
  if (fields.some(field => field.sourceField.startsWith('defaults.'))) notices.push('كل قيمة مصدرها defaults اقتراح ظاهر للمراجعة، وليست حقيقة شخصية مستنتجة.');
  if (summary.state === 'needs_information') notices.push('المسودة تحتاج معلومات أو مراجعة إضافية؛ ظهور حقل في المعاينة لا يؤكد اكتمال الطلب.');
  return {mode: 'preview_only', canExecute: false, draftRevision: summary.revision, caseId: summary.caseId, fields, unresolved, notices};
}

module.exports = {buildMofaPreview};
