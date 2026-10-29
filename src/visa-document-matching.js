'use strict';

const {parseTD3MRZ, validateApplicant, proposedEntryDate} = require('./raad-document-validation');

const THRESHOLD = 0.98;
const KINDS = new Set(['passport', 'uae_id_front', 'uae_id_back', 'portrait', 'other']);
const PASSPORT_FIELDS = Object.freeze(['latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName', 'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName', 'passportNumber', 'passportType', 'nationalityCode', 'issuingCountryCode', 'birthDate', 'birthPlace', 'sex', 'issueDate', 'expiryDate']);
const ALL_FIELDS = new Set([...PASSPORT_FIELDS, 'latinFullName', 'arabicFullName', 'emiratesId', 'residenceExpiry']);
const DOCUMENT_FIELDS = new Set([...PASSPORT_FIELDS, 'emiratesId', 'residenceExpiry']);
const IDENTITY_FIELDS = ['passportNumber', 'birthDate', 'nationalityCode', 'sex'];
const MRZ_FIELDS = ['passportNumber', 'nationalityCode', 'issuingCountryCode', 'birthDate', 'expiryDate', 'sex'];
const CLIENT_GAP_FIELDS = Object.freeze(['passportType', 'issueDate', 'birthPlace']);
const COUNTRY_CODES = Object.freeze({'سوريا':'SYR','الأردن':'JOR','لبنان':'LBN','جزر القمر':'COM','اليمن':'YEM','السودان':'SDN','مصر':'EGY','فلسطين':'PSE','ليبيا':'LBY','العراق':'IRQ','أفغانستان':'AFG','إيران':'IRN','تشاد':'TCD','ماليزيا':'MYS','إندونيسيا':'IDN','الهند':'IND','باكستان':'PAK','بنغلاديش':'BGD','الولايات المتحدة':'USA','كندا':'CAN','بريطانيا':'GBR','المملكة المتحدة':'GBR','فرنسا':'FRA','ألمانيا':'DEU','إيطاليا':'ITA','إسبانيا':'ESP','هولندا':'NLD','السويد':'SWE','النرويج':'NOR','الدنمارك':'DNK','سويسرا':'CHE','البرتغال':'PRT','النمسا':'AUT','بلجيكا':'BEL','اليونان':'GRC','أيرلندا':'IRL','فنلندا':'FIN','بولندا':'POL','رومانيا':'ROU','بلغاريا':'BGR','دومينيكا':'DMA','سانت كيتس ونيفيس':'KNA','أنتيغوا وباربودا':'ATG','غرينادا':'GRD','سانت لوسيا':'LCA'});
const MESSAGES = Object.freeze({
  INVALID_EXTRACTION: 'تعذر اعتماد قراءة هذا المستند؛ يحتاج صورة أو قراءة أوضح.',
  DOCUMENT_UNREADABLE: 'المستند غير واضح بما يكفي لقراءة البيانات المطلوبة.',
  SOURCE_CONFLICT: 'تغير أحد المرفقات أثناء القراءة؛ يلزم إعادة فحص النسخة الحالية.',
  DOCUMENT_UNASSIGNED: 'تعذر ربط المستند بمتقدم محدد دون تخمين.',
  PASSPORT_MISSING: 'لم تُحدد صفحة جواز واضحة لهذا المتقدم.',
  PASSPORT_MRZ_REQUIRED: 'يلزم ظهور السطرين المقروءين آلياً أسفل صفحة الجواز بوضوح.',
  PASSPORT_MRZ_INVALID: 'قراءة منطقة الجواز الآلية لم تجتز فحوص الأرقام والتحقق.',
  PASSPORT_MRZ_DATE_AMBIGUOUS: 'يلزم تأكيد التاريخ الكامل الظاهر في الجواز؛ لا نستنتج القرن من المنطقة الآلية.',
  PASSPORT_VIZ_MRZ_MISMATCH: 'توجد بيانات غير متطابقة بين النص الظاهر والمنطقة الآلية في الجواز.',
  CASE_DATA_MISMATCH: 'توجد بيانات في المستند تختلف عن بيانات المتقدم المسجلة؛ يلزم توضيحها.',
  MULTIPLE_PASSPORTS: 'توجد صفحات جوازات مختلفة للمتقدم؛ يلزم تحديد الجواز الحالي.',
  RESIDENCE_MISSING: 'لم تُربط هوية أو إقامة واضحة ومطابقة لهذا المتقدم.',
  DOCUMENT_IDENTITY_MISMATCH: 'بيانات الهوية والإقامة لا تتطابق مع جواز المتقدم.',
  RESIDENCE_CONFLICT: 'توجد بيانات مختلفة بين صور الهوية والإقامة؛ يلزم توضيحها.',
  DOCUMENT_FIELD_REQUIRED: 'إحدى البيانات الأساسية غير ظاهرة أو غير مؤكدة في المستند.',
  DOCUMENT_FIELD_INVALID: 'إحدى البيانات المقروءة تحتاج توضيحاً أو تصحيحاً من المستند.',
  PASSPORT_VALIDITY: 'صلاحية الجواز لا تحقق مدة الستة أشهر من موعد الدخول المستخدم في الملف.',
  RESIDENCE_VALIDITY: 'صلاحية الإقامة لا تحقق مدة ثلاثة أشهر من تاريخ التقديم.',
  APPLICANT_REQUIRED: 'يلزم تحديد المتقدم أو عدد المتقدمين قبل ربط المستندات.'
});

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => plain(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const issue = (code, field = 'documents') => ({code, field, message: MESSAGES[code] || MESSAGES.DOCUMENT_FIELD_INVALID});
const uniqueIssues = values => values.filter((value, index) => values.findIndex(other => other.code === value.code && other.field === value.field) === index);
const digits = value => value.replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function normalizedName(value) {
  return typeof value === 'string' ? value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[ .’'\-]+/g, ' ').trim() : '';
}
function normalizedValue(field, value) {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFKC').trim();
  if (!result || result.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) return null;
  if (field === 'emiratesId') return digits(result).replace(/[ -]/g, '');
  if (field === 'passportNumber') return result.toUpperCase();
  if (['nationalityCode', 'issuingCountryCode'].includes(field)) return result.toUpperCase() === 'D<<' ? 'DEU' : result.toUpperCase();
  if (field === 'sex') { const values = {male:'M',female:'F',unspecified:'X',m:'M',f:'F',x:'X'}, key = result.toLowerCase(); return Object.hasOwn(values,key) ? values[key] : result; }
  return result;
}
function equivalent(field, first, second) {
  if (field.includes('Name')) return normalizedName(first) === normalizedName(second);
  return normalizedValue(field, first) === normalizedValue(field, second);
}
function fullName(fields) {
  if (typeof fields.latinFullName === 'string') return normalizedName(fields.latinFullName);
  if (!fields.latinFirstName || !fields.latinFamilyName) return '';
  return normalizedName([fields.latinFirstName, fields.latinFatherName, fields.latinGrandfatherName, fields.latinFamilyName].filter(Boolean).join(' '));
}
function identityFields(document) { return document.identityName ? {...document.fields, latinFullName:document.identityName} : document.fields; }
function knownFields(person) {
  const fields = {};
  if (!plain(person)) return fields;
  for (const field of ALL_FIELDS) {
    const value = normalizedValue(field, own(person, field));
    if (value !== null) fields[field] = value;
  }
  if (!fields.nationalityCode && typeof own(person, 'nationality') === 'string' && Object.hasOwn(COUNTRY_CODES, person.nationality.trim())) fields.nationalityCode = COUNTRY_CODES[person.nationality.trim()];
  return fields;
}
function ref(document) { return {mediaId: document.mediaId, page: document.page, sha256: document.sha256}; }
function extractionKey(extraction) {
  if (!plain(extraction)) return null;
  const fields = {};
  if (plain(extraction.fields)) for (const field of ALL_FIELDS) if (Object.hasOwn(extraction.fields, field)) {
    const value = extraction.fields[field];
    fields[field] = plain(value) ? {value:value.value, confidence:value.confidence, visible:value.visible} : null;
  }
  return JSON.stringify({version:extraction.version, kind:extraction.kind, readable:extraction.readable, rotation:extraction.rotation, fields, mrzLines:extraction.mrzLines, portraitBox:extraction.portraitBox});
}
function validateReference(document) {
  return plain(document) && typeof document.mediaId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(document.mediaId) && Number.isInteger(document.page) && document.page >= 1 && document.page <= 10 && typeof document.sha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sha256);
}
function readDocument(document) {
  const parsed = {...ref(document), extraction: document.extraction, fields: {}, lowConfidence: [], invalidFields: [], issues: []};
  const extraction = document.extraction;
  if (!plain(extraction) || extraction.version !== 1 || !KINDS.has(extraction.kind) || typeof extraction.readable !== 'boolean' || ![0,90,180,270].includes(extraction.rotation) || !plain(extraction.fields) || !Array.isArray(extraction.mrzLines) || extraction.mrzLines.length > 3 || extraction.mrzLines.some(line => typeof line !== 'string' || line.length > 44)) {
    parsed.kind = 'other'; parsed.issues.push(issue('INVALID_EXTRACTION')); return parsed;
  }
  parsed.kind = extraction.kind;
  if (!extraction.readable) { parsed.issues.push(issue('DOCUMENT_UNREADABLE')); return parsed; }
  for (const field of ALL_FIELDS) {
    if (!Object.hasOwn(extraction.fields, field)) continue;
    const evidence = extraction.fields[field];
    if (!plain(evidence) || typeof evidence.visible !== 'boolean' || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1 || (evidence.visible ? typeof evidence.value !== 'string' : evidence.value !== null)) { parsed.invalidFields.push(field); continue; }
    if (!evidence.visible) continue;
    if (evidence.confidence < THRESHOLD) { parsed.lowConfidence.push(field); continue; }
    const value = normalizedValue(field, evidence.value);
    if (value === null) { parsed.invalidFields.push(field); continue; }
    parsed.fields[field] = value;
  }
  if (typeof document.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sourceSha256)) parsed.sourceSha256 = document.sourceSha256;
  return parsed;
}
function validationIssues(fields, referenceDate, entryDate, allowed) {
  const date = realDate(entryDate) ? entryDate : proposedEntryDate(referenceDate);
  return validateApplicant({...fields, entryDate: date}, {referenceDate}).issues.filter(item => allowed.has(item.field)).map(item => issue(item.code === 'required' || item.code === 'invalid_date' && !fields[item.field] ? 'DOCUMENT_FIELD_REQUIRED' : item.code === 'insufficient_passport_validity' ? 'PASSPORT_VALIDITY' : item.code === 'insufficient_residence_validity' ? 'RESIDENCE_VALIDITY' : 'DOCUMENT_FIELD_INVALID', item.field));
}
function inspectPassport(document, referenceDate) {
  const fields = document.fields, issues = [...document.issues];
  const mrzLines = document.extraction?.mrzLines;
  let mrzChecked = false, mrzIdentity = null;
  if (!Array.isArray(mrzLines) || mrzLines.length !== 2) issues.push(issue('PASSPORT_MRZ_REQUIRED', 'mrz'));
  else {
    const parsed = parseTD3MRZ(mrzLines, {referenceDate, ...(fields.birthDate ? {confirmedBirthDate: fields.birthDate} : {}), ...(fields.expiryDate ? {confirmedExpiryDate: fields.expiryDate} : {})});
    if (!parsed.ok) {
      const ambiguous = parsed.issues.some(item => ['ambiguous_century', 'confirmed_date_mismatch'].includes(item.code));
      issues.push(issue(ambiguous ? 'PASSPORT_MRZ_DATE_AMBIGUOUS' : 'PASSPORT_MRZ_INVALID', 'mrz'));
    }
    let mismatch = false;
    for (const field of MRZ_FIELDS) if (fields[field] && parsed.fields?.[field] !== null && parsed.fields?.[field] !== undefined && !equivalent(field, fields[field], parsed.fields[field])) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', field)); }
    const given = normalizedName([fields.latinFirstName, fields.latinFatherName, fields.latinGrandfatherName].filter(Boolean).join(' '));
    const mrzGiven = normalizedName(parsed.fields?.latinNames?.givenNames);
    // Missing optional trailing name labels are not reconstructed. Known VIZ
    // given names still must match the exact beginning of the checked MRZ.
    const knownGivenMatches = given === mrzGiven || !fields.latinGrandfatherName && mrzGiven.startsWith(given + ' ');
    if (given && mrzGiven && !knownGivenMatches) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFirstName')); }
    if (fields.latinFamilyName && parsed.fields?.latinNames?.family && normalizedName(fields.latinFamilyName) !== normalizedName(parsed.fields.latinNames.family)) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFamilyName')); }
    const mrzFull = normalizedName([parsed.fields?.latinNames?.givenNames,parsed.fields?.latinNames?.family].filter(Boolean).join(' '));
    if (fields.latinFullName && normalizedName(fields.latinFullName) !== mrzFull) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFullName')); }
    mrzChecked = parsed.ok && !mismatch;
    if (mrzChecked) {
      document.identityName = mrzFull;
      mrzIdentity = {...Object.fromEntries(MRZ_FIELDS.map(field => [field, parsed.fields[field]])), latinFullName:mrzFull};
    }
  }
  for (const field of document.invalidFields) if (DOCUMENT_FIELDS.has(field)) issues.push(issue('DOCUMENT_FIELD_INVALID', field));
  return {...document, issues, mrzChecked, mrzIdentity};
}
function conflictsWithCase(document, known) {
  const issues = [];
  for (const field of [...IDENTITY_FIELDS, 'latinFirstName', 'latinFamilyName', 'issuingCountryCode', 'issueDate', 'expiryDate', 'emiratesId', 'residenceExpiry']) if (known[field] && document.fields[field] && !equivalent(field, known[field], document.fields[field])) issues.push(issue('CASE_DATA_MISMATCH', field));
  return issues;
}
function matchesIdentity(first, second) {
  return Boolean(first.passportNumber && second.passportNumber && first.passportNumber === second.passportNumber || first.birthDate && second.birthDate && first.birthDate === second.birthDate && fullName(first) && fullName(first) === fullName(second));
}
function identityConflicts(first, second) {
  const issues = [];
  for (const field of IDENTITY_FIELDS) if (first[field] && second[field] && !equivalent(field, first[field], second[field])) issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', field));
  if (fullName(first) && fullName(second) && fullName(first) !== fullName(second)) issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', 'latinFullName'));
  return issues;
}
function addSources(result, document, acceptedFields, method) {
  for (const field of acceptedFields) {
    if (!Object.hasOwn(document.fields, field)) continue;
    result.evidence.fieldSources[field] ||= [];
    const sources = document.fieldProvenance?.[field] || [{...ref(document), confidence: document.extraction.fields[field].confidence}];
    result.evidence.fieldSources[field].push(...sources.map(source => ({...source, method})));
  }
}

// Repeated physical uploads carry no extra page evidence. A raw-file digest must
// include the PDF page number; pages from one PDF are distinct documents.
function compareReference(first, second) {
  return first.mediaId.localeCompare(second.mediaId) || first.page - second.page || first.sha256.localeCompare(second.sha256);
}
function samePhysicalPage(first, second) {
  return first.kind === second.kind && (first.sha256 === second.sha256 || first.sourceSha256 && first.sourceSha256 === second.sourceSha256 && first.page === second.page);
}
function duplicatePriority(first, second) {
  return Number(second.extraction.mrzLines.length === 2) - Number(first.extraction.mrzLines.length === 2)
    || Number(second.mrzChecked === true) - Number(first.mrzChecked === true)
    || Number(Boolean(second.extraction.portraitBox)) - Number(Boolean(first.extraction.portraitBox))
    || Object.keys(second.fields).length - Object.keys(first.fields).length || compareReference(first,second);
}
function deduplicateDocuments(documents) {
  const groups = [];
  for (const document of [...documents].sort(compareReference)) {
    const linked = groups.filter(group => group.some(other => samePhysicalPage(document,other)));
    if (!linked.length) groups.push([document]);
    else {
      linked[0].push(document);
      for (const group of linked.slice(1)) { linked[0].push(...group); groups.splice(groups.indexOf(group),1); }
    }
  }
  return groups.map(group => {
    group.sort(duplicatePriority);
    const primary = group[0], fields = {}, fieldProvenance = {}, issues = group.flatMap(document => document.issues);
    // Identical physical pixels are the anchor, not model confidence or arrival
    // order. Abstentions and confidence-only differences do not add a page.
    // Retain every trusted contradiction as a blocker; never latest-value-wins.
    for (const document of group) {
      for (const [field,value] of Object.entries(document.fields)) {
        if (Object.hasOwn(fields,field)) { if (!equivalent(field,fields[field],value)) issues.push(issue('SOURCE_CONFLICT',field)); }
        else { fields[field]=value; fieldProvenance[field]=[{...ref(document),confidence:document.extraction.fields[field].confidence}]; }
      }
      if (document.extraction.rotation !== primary.extraction.rotation) issues.push(issue('SOURCE_CONFLICT','rotation'));
      if (document.extraction.mrzLines.length && primary.extraction.mrzLines.length && JSON.stringify(document.extraction.mrzLines) !== JSON.stringify(primary.extraction.mrzLines)) issues.push(issue('SOURCE_CONFLICT','mrz'));
      const box=document.extraction.portraitBox,chosenBox=primary.extraction.portraitBox;
      if (box && chosenBox && ['x','y','width','height'].some(key => box[key] !== chosenBox[key])) issues.push(issue('SOURCE_CONFLICT','portraitBox'));
    }
    return {...primary,fields,fieldProvenance,issues:uniqueIssues(issues),invalidFields:[...new Set(group.flatMap(document=>document.invalidFields))],lowConfidence:[...new Set(group.flatMap(document=>document.lowConfidence))]};
  }).sort(compareReference);
}
function hasStrongVisualIdentity(document) {
  const fields=document.fields;
  return /^[A-Z0-9]{1,20}$/.test(fields.passportNumber || '') && realDate(fields.birthDate)
    && ['latinFirstName','latinFamilyName'].every(field => typeof fields[field] === 'string' && /^[\p{Script=Latin}\p{M} .'-]+$/u.test(fields[field]) && normalizedName(fields[field]));
}
function hasPassportIdentityAnchor(document) {
  return Boolean(document.fields.passportNumber || document.extraction.mrzLines.length || fullName(document.fields) && document.fields.birthDate);
}
function passportGroups(documents, referenceDate) {
  // Strong identity edges may reveal a contradiction; keep that contradiction
  // in the group and block it instead of silently selecting the latest page.
  const remaining = new Set(documents), groups = [];
  while (remaining.size) {
    const parts = [remaining.values().next().value]; remaining.delete(parts[0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const document of remaining) if (parts.some(other => matchesIdentity(identityFields(other), identityFields(document)))) {
        parts.push(document); remaining.delete(document); changed = true;
      }
    }
    parts.sort((a,b) => Number(b.extraction.mrzLines.length === 2) - Number(a.extraction.mrzLines.length === 2) || compareReference(a,b));
    const fields = {}, issues = [], invalidFields = [];
    for (const part of parts) {
      issues.push(...part.issues); invalidFields.push(...part.invalidFields);
      for (const field of [...PASSPORT_FIELDS, 'latinFullName', 'arabicFullName']) if (Object.hasOwn(part.fields, field)) {
        if (Object.hasOwn(fields, field) && !equivalent(field, fields[field], part.fields[field])) issues.push(issue('MULTIPLE_PASSPORTS', field));
        else fields[field] = part.fields[field];
      }
    }
    // Full visual dates may be on a strongly linked supplementary page. Only
    // printed, confident values resolve MRZ centuries; MRZ-only fields are never
    // filled into the applicant, nor are name components inferred.
    const mrzParts = parts.filter(part => part.extraction.mrzLines.length > 0);
    const checked = (mrzParts.length ? mrzParts : [parts[0]]).map(part => inspectPassport({...part, fields, invalidFields:[]}, referenceDate));
    for (const document of checked) issues.push(...document.issues);
    for (const field of invalidFields) if (DOCUMENT_FIELDS.has(field)) issues.push(issue('DOCUMENT_FIELD_INVALID', field));
    const primary = checked.find(part => part.mrzChecked) || checked[0];
    if (checked.some(part => part.mrzIdentity && primary.mrzIdentity && [...MRZ_FIELDS, 'latinFullName'].some(field => part.mrzIdentity[field] && primary.mrzIdentity[field] && !equivalent(field, part.mrzIdentity[field], primary.mrzIdentity[field])))) issues.push(issue('MULTIPLE_PASSPORTS', 'mrz'));
    if (parts.length > 2) issues.push(issue('MULTIPLE_PASSPORTS', 'passport'));
    const ordered = [parts.find(part => part.mediaId === primary.mediaId && part.page === primary.page), ...parts.filter(part => part.mediaId !== primary.mediaId || part.page !== primary.page)];
    groups.push({...primary, fields, parts:ordered, issues:uniqueIssues(issues), mrzChecked:checked.length > 0 && checked.every(part => part.mrzChecked)});
  }
  return groups;
}

function reconcileDocumentEvidence({documents, applicants, referenceDate = new Date().toISOString().slice(0, 10)} = {}) {
  if (!Array.isArray(documents) || documents.length > 100 || !Array.isArray(applicants) || applicants.length > 30 || !applicants.every(plain) || !realDate(referenceDate)) throw Object.assign(Error('DOCUMENT_MATCH_INPUT_INVALID'), {code:'DOCUMENT_MATCH_INPUT_INVALID'});
  const output = {version: 1, complete: false, applicants: applicants.map((person, applicantIndex) => ({applicantIndex, status:'needs_review', identityReady:false, clientFieldsRequired:[], fields:{}, documents:{passport:null, residence:[], photo:null}, issues:[], evidence:{passportMrzChecked:false, matchedResidence:false, authenticityVerified:false, fieldSources:{}}})), unassigned:[], issues:[]};
  if (!applicants.length) output.issues.push(issue('APPLICANT_REQUIRED', 'applicants'));
  const unassign = (document, code = 'DOCUMENT_UNASSIGNED') => { output.unassigned.push({...ref(document), reason:code}); };
  const sourceGroups = new Map();
  for (const document of documents) {
    if (!validateReference(document)) { output.issues.push(issue('INVALID_EXTRACTION')); continue; }
    const key = document.mediaId + ':' + document.page;
    const group = sourceGroups.get(key) || []; group.push(document); sourceGroups.set(key, group);
  }
  const parsed = [];
  for (const group of sourceGroups.values()) {
    if (new Set(group.map(item => item.sha256)).size > 1 || new Set(group.map(item => extractionKey(item.extraction))).size > 1) { output.issues.push(issue('SOURCE_CONFLICT')); group.forEach(document => unassign(document, 'SOURCE_CONFLICT')); continue; }
    const document = readDocument(group[0]);
    if (document.issues.length || document.kind === 'other') { output.issues.push(...document.issues, ...(document.kind === 'other' && !document.issues.length ? [issue('DOCUMENT_UNASSIGNED')] : [])); unassign(document, document.issues[0]?.code || 'DOCUMENT_UNASSIGNED'); continue; }
    parsed.push(document.kind === 'passport' ? inspectPassport(document, referenceDate) : document);
  }
  const distinct = deduplicateDocuments(parsed);
  // Strip the provisional per-page MRZ issues before group inspection. A page
  // with no MRZ can supplement a proven passport, but any supplied bad MRZ must
  // still fail the final group inspection.
  const passports = passportGroups(distinct.filter(document => document.kind === 'passport').map(document => ({...document, issues:document.issues.filter(item => !['PASSPORT_MRZ_REQUIRED','PASSPORT_MRZ_INVALID','PASSPORT_MRZ_DATE_AMBIGUOUS','PASSPORT_VIZ_MRZ_MISMATCH','DOCUMENT_FIELD_INVALID'].includes(item.code))})), referenceDate);
  const known = applicants.map(knownFields), assignments = new Map(), passportFor = new Map();
  const strongPassports=passports.filter(hasStrongVisualIdentity);
  const uniqueVisualPassport=strongPassports.length===1&&passports.every(document=>document===strongPassports[0]||!hasPassportIdentityAnchor(document))?strongPassports[0]:null;
  for (const document of passports) {
    let candidates = known.map((fields, index) => ({fields, index})).filter(({fields}) => fields.passportNumber && document.fields.passportNumber && fields.passportNumber === document.fields.passportNumber).map(item => item.index);
    if (!candidates.length) candidates = known.map((fields, index) => ({fields, index})).filter(({fields}) => fields.birthDate && document.fields.birthDate && fields.birthDate === document.fields.birthDate && fullName(fields) && fullName(fields) === fullName(identityFields(document))).map(item => item.index);
    // An unanchored dates-only page must not erase the one identifiable main
    // passport. Keep it unassigned; its dates cannot complete the main page.
    if (!candidates.length && applicants.length === 1 && (passports.length === 1 || document === uniqueVisualPassport)) candidates = [0];
    if (candidates.length !== 1) { document.parts.forEach(part => unassign(part)); continue; }
    const index = candidates[0], result = output.applicants[index];
    result.issues.push(...document.issues, ...conflictsWithCase(document, known[index]));
    if (passportFor.has(index)) { result.issues.push(issue('MULTIPLE_PASSPORTS', 'passport')); document.parts.forEach(part => unassign(part, 'MULTIPLE_PASSPORTS')); continue; }
    passportFor.set(index, document); document.parts.forEach(part => assignments.set(part, index));
    result.documents.passport = ref(document); result.evidence.passportMrzChecked = document.mrzChecked;
    if (document.parts.length > 1) result.documents.passportParts = document.parts.slice(0,2).map(ref);
    for (const part of document.parts.slice(2)) unassign(part, 'MULTIPLE_PASSPORTS');
    for (const field of PASSPORT_FIELDS) if (Object.hasOwn(document.fields, field)) result.fields[field] = document.fields[field];
    for (const part of document.parts) addSources(result, part, PASSPORT_FIELDS, document.mrzChecked ? 'visible_and_mrz_checked' : 'visible_unconfirmed');
  }
  const identities = distinct.filter(document => document.kind === 'uae_id_front' || document.kind === 'uae_id_back').sort((a,b) => Number(a.kind === 'uae_id_back') - Number(b.kind === 'uae_id_back') || compareReference(a,b));
  const pending = new Set(identities);
  let changed = true;
  while (changed) {
    changed = false;
    for (const document of pending) {
      let candidates = [...passportFor].filter(([, passport]) => matchesIdentity(identityFields(passport), document.fields)).map(([index]) => index);
      if (!candidates.length && document.fields.emiratesId) candidates = [...passportFor].filter(([index]) => known[index].emiratesId === document.fields.emiratesId || identities.some(other => assignments.get(other) === index && other.fields.emiratesId === document.fields.emiratesId)).map(([index]) => index);
      if (candidates.length !== 1) continue;
      const index = candidates[0], result = output.applicants[index], passport = passportFor.get(index);
      pending.delete(document); changed = true; assignments.set(document, index);
      result.documents.residence.push(ref(document));
      result.issues.push(...document.issues, ...identityConflicts(identityFields(passport), document.fields), ...conflictsWithCase({fields:Object.fromEntries(Object.entries(document.fields).filter(([field]) => field !== 'expiryDate' && field !== 'issueDate' && field !== 'issuingCountryCode'))}, known[index]));
      for (const field of ['emiratesId', 'residenceExpiry']) if (document.fields[field]) {
        if (result.fields[field] && !equivalent(field, result.fields[field], document.fields[field])) result.issues.push(issue('RESIDENCE_CONFLICT', field));
        else result.fields[field] = document.fields[field];
      }
      for (const field of document.invalidFields) if (['emiratesId','residenceExpiry','birthDate'].includes(field)) result.issues.push(issue('DOCUMENT_FIELD_INVALID', field));
      addSources(result, document, ['emiratesId','residenceExpiry'], 'visible_and_passport_identity_matched');
    }
  }
  for (const document of pending) {
    const possible = [...passportFor].filter(([, passport]) => fullName(identityFields(passport)) && fullName(identityFields(passport)) === fullName(document.fields) || passport.fields.birthDate && passport.fields.birthDate === document.fields.birthDate).map(([index]) => index);
    if (possible.length === 1) output.applicants[possible[0]].issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', 'residence'));
    unassign(document);
  }
  const portraits = distinct.filter(document => document.kind === 'portrait');
  for (const document of portraits) {
    if (applicants.length === 1 && portraits.length === 1) { output.applicants[0].documents.photo = ref(document); output.applicants[0].issues.push(...document.issues); assignments.set(document, 0); }
    else unassign(document);
  }
  for (const result of output.applicants) {
    if (!result.documents.passport) result.issues.push(issue('PASSPORT_MISSING', 'passport'));
    if (!result.documents.residence.length) result.issues.push(issue('RESIDENCE_MISSING', 'residence'));
    if (result.documents.residence.length > 2) result.issues.push(issue('RESIDENCE_CONFLICT', 'residence'));
    result.documents.residence.sort((a,b) => identities.findIndex(document => document.mediaId === a.mediaId && document.page === a.page) - identities.findIndex(document => document.mediaId === b.mediaId && document.page === b.page));
    result.evidence.matchedResidence = result.documents.residence.length > 0 && !result.issues.some(item => ['DOCUMENT_IDENTITY_MISMATCH','RESIDENCE_CONFLICT'].includes(item.code));
    result.issues.push(...validationIssues(result.fields, referenceDate, applicants[result.applicantIndex].entryDate, DOCUMENT_FIELDS));
    result.issues = uniqueIssues(result.issues);
    const isClientGap = item => item.code === 'DOCUMENT_FIELD_REQUIRED' && CLIENT_GAP_FIELDS.includes(item.field) && !Object.hasOwn(result.fields,item.field);
    const blockers = result.issues.filter(item => !isClientGap(item));
    result.identityReady = result.evidence.passportMrzChecked && result.evidence.matchedResidence && blockers.length === 0;
    if (result.identityReady) result.clientFieldsRequired = CLIENT_GAP_FIELDS.filter(field => result.issues.some(item => item.field === field && isClientGap(item)));
    result.status = result.identityReady ? result.clientFieldsRequired.length ? 'needs_confirmation' : 'ready' : 'needs_review';
  }
  if (output.unassigned.length) output.issues.push(issue('DOCUMENT_UNASSIGNED'));
  output.issues = uniqueIssues(output.issues);
  output.complete = output.applicants.length > 0 && output.applicants.every(result => result.status === 'ready') && output.issues.length === 0 && output.unassigned.length === 0;
  return output;
}

module.exports = {reconcileDocumentEvidence, DOCUMENT_CONFIDENCE_THRESHOLD:THRESHOLD};
