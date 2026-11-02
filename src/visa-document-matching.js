'use strict';

const {parseTD3MRZ, validateApplicant, proposedEntryDate} = require('./raad-document-validation');
const {corroboratedPassportDate}=require('./visa-document-review');
const {parseTD1MRZ, matchesPrintedEmiratesId, resolvePrintedDate} = require('./visa-id-mrz');

const THRESHOLD = 0.98;
const PRIVATE_NUMERIC_THRESHOLD = 0.90;
const PRIVATE_PASSPORT_NUMERIC = new Set(['passportNationalNumber','printedPassportExpiry']);
const KINDS = new Set(['passport', 'uae_id_front', 'uae_id_back', 'portrait', 'other']);
const PASSPORT_FIELDS = Object.freeze(['latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName', 'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName', 'passportNumber', 'passportType', 'nationalityCode', 'issuingCountryCode', 'birthDate', 'birthPlace', 'sex', 'issueDate', 'expiryDate']);
const ALL_FIELDS = new Set([...PASSPORT_FIELDS, 'latinFullName', 'arabicFullName', 'visiblePassportNumber', 'passportNationalNumber', 'printedPassportExpiry', 'printedResidenceExpiry', 'emiratesId', 'residenceExpiry']);
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
  RESIDENCE_MRZ_INVALID: 'المنطقة الآلية في الهوية غير مكتملة أو لم تجتز فحوص التحقق؛ يلزم مراجعة نسخة الهوية الأصلية.',
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
  if (['passportNumber','visiblePassportNumber'].includes(field)) return result.toUpperCase();
  if (['nationalityCode', 'issuingCountryCode'].includes(field)) return result.toUpperCase() === 'D<<' ? 'DEU' : result.toUpperCase();
  if (field === 'sex') { const values = {male:'M',female:'F',unspecified:'X',m:'M',f:'F',x:'X'}, key = result.toLowerCase(); return Object.hasOwn(values,key) ? values[key] : result; }
  return result;
}
function equivalent(field, first, second) {
  if (field.includes('Name')) return normalizedName(first) === normalizedName(second);
  return normalizedValue(field, first) === normalizedValue(field, second);
}
function labelledFullName(fields) {
  if (!fields.latinFirstName || !fields.latinFamilyName) return '';
  return normalizedName([fields.latinFirstName, fields.latinFatherName, fields.latinGrandfatherName, fields.latinFamilyName].filter(Boolean).join(' '));
}
function fullName(fields) {
  return typeof fields.latinFullName === 'string' ? normalizedName(fields.latinFullName) : labelledFullName(fields);
}
function identityFields(document) {
  return document.identityName ? {...document.fields, latinFullName:document.identityName, _documentNameVariants:document.identityNameVariants || [document.identityName]} : document.fields;
}
function exactIdentityNameMatch(first,second) {
  const primaryFirst=fullName(first),primarySecond=fullName(second);
  if (primaryFirst && primaryFirst===primarySecond) return true;
  // A separately labelled patronymic may be absent from MRZ given names. Its
  // exact printed composite is usable only with the same explicit full DOB.
  if (!realDate(first.birthDate) || first.birthDate!==second.birthDate) return false;
  const variants=fields=>Array.isArray(fields._documentNameVariants)?fields._documentNameVariants:[fullName(fields)];
  return variants(first).some(value=>value&&variants(second).includes(value));
}
function nationalDigits(value) {
  if (typeof value!=='string' || !/^[0-9< -]+$/.test(value)) return null;
  const normalized=value.replace(/[< -]/g,'');
  return /^\d{10,14}$/.test(normalized)&&!/^0+$/.test(normalized)?normalized:null;
}
function structurallyCheckedTD3(parsed) {
  const checks=['documentNumber','birthDate','expiryDate','optionalData','composite'];
  return parsed?.format==='TD3'&&checks.every(name=>parsed.checks?.[name]?.ok===true)&&parsed.issues.every(item=>item.code==='ambiguous_century');
}
function checkedOptionalDigits(parsed) {
  return structurallyCheckedTD3(parsed)?nationalDigits(parsed.fields?.optionalDataRaw):null;
}
function evidenceConfidence(document,field){return document.fieldProvenance?.[field]?.[0]?.confidence??document.extraction?.fields?.[field]?.confidence;}
function validPrivateNumeric(field,value){
  if(typeof value!=='string')return false;const literal=value.trim();
  if(field==='passportNationalNumber')return /^[0-9]+(?:[ -][0-9]+)*$/.test(literal)&&nationalDigits(literal)!==null;
  if(field!=='printedPassportExpiry')return false;const match=literal.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);if(!match)return false;
  return [[match[1],match[2]],[match[2],match[1]]].some(([day,month])=>realDate(match[3]+'-'+month.padStart(2,'0')+'-'+day.padStart(2,'0')));
}
function optionalNationalAnchor(mrz,visible){
  if(!mrz.checkedOptionalDigits||mrz.checkedOptionalDigits!==nationalDigits(visible.fields.passportNationalNumber))return false;
  const confidence=evidenceConfidence(visible,'passportNationalNumber');
  if(confidence>=THRESHOLD)return true;
  // Lower-confidence private digits never identify a page on their own. They
  // need the full printed year and exact checked expiry intersection as well.
  return confidence>=PRIVATE_NUMERIC_THRESHOLD&&evidenceConfidence(visible,'printedPassportExpiry')>=PRIVATE_NUMERIC_THRESHOLD
    &&Boolean(mrz.checkedMrzDates&&resolvePrintedDate(visible.fields.printedPassportExpiry,mrz.checkedMrzDates.expiryDateRaw));
}
function nationalPageAnchor(first,second) {
  return optionalNationalAnchor(first,second)||optionalNationalAnchor(second,first);
}
function passportPageLink(first,second) {
  if (matchesIdentity(identityFields(first),identityFields(second))) return 'printed_identity';
  if (nationalPageAnchor(first,second)) return 'printed_national_number_and_checked_mrz_optional';
  return null;
}
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
  if(document.readReviewIssue?.code==='SOURCE_CONFLICT'&&ALL_FIELDS.has(document.readReviewIssue.field))parsed.issues.push(issue('SOURCE_CONFLICT',document.readReviewIssue.field));
  if (!extraction.readable) { parsed.issues.push(issue('DOCUMENT_UNREADABLE')); return parsed; }
  for (const field of ALL_FIELDS) {
    if (!Object.hasOwn(extraction.fields, field)) continue;
    const evidence = extraction.fields[field];
    if (!plain(evidence) || typeof evidence.visible !== 'boolean' || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1 || (evidence.visible ? typeof evidence.value !== 'string' : evidence.value !== null)) { parsed.invalidFields.push(field); continue; }
    if (!evidence.visible) continue;
    const privateNumeric=parsed.kind==='passport'&&PRIVATE_PASSPORT_NUMERIC.has(field)&&validPrivateNumeric(field,evidence.value);
    const corroboratedDate=corroboratedPassportDate(document,field);
    if (evidence.confidence < (privateNumeric?PRIVATE_NUMERIC_THRESHOLD:THRESHOLD)&&!corroboratedDate) { parsed.lowConfidence.push(field); continue; }
    const value = normalizedValue(field, evidence.value);
    if (value === null) { parsed.invalidFields.push(field); continue; }
    parsed.fields[field] = value;
    if(corroboratedDate){parsed.fieldProvenance||={};parsed.fieldProvenance[field]=[{...ref(document),method:'two_visible_full_dates_and_checked_td3',readerPolicy:document.reviewEvidence.policy}];}
  }
  if(parsed.kind==='passport'){
    // Keep literal visual/legacy observations separate from the number parsed
    // from fixed TD3 positions. A new read cannot relabel a cached mismatch.
    parsed.passportNumberObservations=['passportNumber','visiblePassportNumber'].filter(field=>Object.hasOwn(parsed.fields,field)).map(field=>({...ref(parsed),evidenceField:field,value:extraction.fields[field].value,confidence:extraction.fields[field].confidence}));
    if(!parsed.fields.passportNumber&&parsed.fields.visiblePassportNumber){
      parsed.fields.passportNumber=parsed.fields.visiblePassportNumber;
      parsed.fieldProvenance={...parsed.fieldProvenance,passportNumber:[{...ref(parsed),evidenceField:'visiblePassportNumber',confidence:extraction.fields.visiblePassportNumber.confidence,method:'visible_unconfirmed'}]};
    }
  }
  if(parsed.kind==='uae_id_back'&&document.mrzFocusStatus==='checked'&&parseTD1MRZ(extraction.mrzLines).ok)parsed.nativeTd1Checked=true;
  if (typeof document.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(document.sourceSha256)) parsed.sourceSha256 = document.sourceSha256;
  return parsed;
}
function validationIssues(fields, referenceDate, entryDate, allowed) {
  const date = realDate(entryDate) ? entryDate : proposedEntryDate(referenceDate);
  return validateApplicant({...fields, entryDate: date}, {referenceDate}).issues.filter(item => allowed.has(item.field)).map(item => issue(item.code === 'required' || item.code === 'invalid_date' && !fields[item.field] ? 'DOCUMENT_FIELD_REQUIRED' : item.code === 'insufficient_passport_validity' ? 'PASSPORT_VALIDITY' : item.code === 'insufficient_residence_validity' ? 'RESIDENCE_VALIDITY' : 'DOCUMENT_FIELD_INVALID', item.field));
}
function inspectPassport(document, referenceDate) {
  const fields = {...document.fields}, fieldProvenance={...document.fieldProvenance}, issues = [...document.issues];
  const mrzLines = document.extraction?.mrzLines;
  let mrzChecked = false, mrzIdentity = null, optionalDigits = null, checkedMrzDates = null;
  if (!Array.isArray(mrzLines) || mrzLines.length !== 2) issues.push(issue('PASSPORT_MRZ_REQUIRED', 'mrz'));
  else {
    const parsed = parseTD3MRZ(mrzLines, {referenceDate, ...(fields.birthDate ? {confirmedBirthDate: fields.birthDate} : {}), ...(fields.expiryDate ? {confirmedExpiryDate: fields.expiryDate} : {})});
    optionalDigits=checkedOptionalDigits(parsed);
    if(structurallyCheckedTD3(parsed))checkedMrzDates={birthDateRaw:parsed.fields.birthDateRaw,expiryDateRaw:parsed.fields.expiryDateRaw};
    if (!parsed.ok) {
      const ambiguous = parsed.issues.some(item => ['ambiguous_century', 'confirmed_date_mismatch'].includes(item.code));
      issues.push(issue(ambiguous ? 'PASSPORT_MRZ_DATE_AMBIGUOUS' : 'PASSPORT_MRZ_INVALID', 'mrz'));
    }
    let mismatch = false;
    for (const field of MRZ_FIELDS.filter(field=>field!=='passportNumber')) if (fields[field] && parsed.fields?.[field] !== null && parsed.fields?.[field] !== undefined && !equivalent(field, fields[field], parsed.fields[field])) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', field)); }
    const observedNumbers=document.passportNumberObservations||[];
    if(observedNumbers.some(observed=>parsed.fields?.passportNumber&&!equivalent('passportNumber',observed.value,parsed.fields.passportNumber))){mismatch=true;issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH','passportNumber'));}
    if(structurallyCheckedTD3(parsed)){
      fields.passportNumber=parsed.fields.passportNumber;
      // Check-digit validation is deterministic evidence, not an OCR confidence
      // estimate. Keep the literal VIZ observation above even when it disagrees.
      fieldProvenance.passportNumber=[{...ref(document),evidenceField:'mrzLines',method:'td3_document_number_checked',checks:['documentNumber','birthDate','expiryDate','optionalData','composite']}];
      // These zones are literal transcriptions, not values protected by a TD3
      // check digit. Existing visual values and every conflict are retained.
      for(const [field,line,positions]of [['nationalityCode',2,[11,13]],['issuingCountryCode',1,[3,5]]])if(!fields[field]){
        fields[field]=normalizedValue(field,parsed.fields[field]);
        fieldProvenance[field]=[{...ref(document),evidenceField:'mrzLines',method:'td3_zone_transcription',line,positions}];
      }
    }
    const labelledGiven=normalizedName(fields.latinFirstName);
    const given = normalizedName([fields.latinFirstName, fields.latinFatherName, fields.latinGrandfatherName].filter(Boolean).join(' '));
    const mrzGiven = normalizedName(parsed.fields?.latinNames?.givenNames);
    // Missing optional trailing name labels are not reconstructed. Known VIZ
    // given names still must match the exact beginning of the checked MRZ.
    const knownGivenMatches = labelledGiven === mrzGiven || given === mrzGiven || !fields.latinGrandfatherName && mrzGiven.startsWith(given + ' ');
    const separatePatronymicOmitted=Boolean(labelledGiven && labelledGiven===mrzGiven && (fields.latinFatherName||fields.latinGrandfatherName));
    if (given && mrzGiven && !knownGivenMatches) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFirstName')); }
    if (fields.latinFamilyName && parsed.fields?.latinNames?.family && normalizedName(fields.latinFamilyName) !== normalizedName(parsed.fields.latinNames.family)) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFamilyName')); }
    const mrzFull = normalizedName([parsed.fields?.latinNames?.givenNames,parsed.fields?.latinNames?.family].filter(Boolean).join(' '));
    if (fields.latinFullName && normalizedName(fields.latinFullName) !== mrzFull && !(separatePatronymicOmitted && normalizedName(fields.latinFullName)===labelledFullName(fields))) { mismatch = true; issues.push(issue('PASSPORT_VIZ_MRZ_MISMATCH', 'latinFullName')); }
    mrzChecked = parsed.ok && !mismatch;
    if (mrzChecked) {
      document.identityName = mrzFull;
      document.identityNameVariants=[...new Set([mrzFull,...(separatePatronymicOmitted?[labelledFullName(fields)]:[])].filter(Boolean))];
      mrzIdentity = {...Object.fromEntries(MRZ_FIELDS.map(field => [field, parsed.fields[field]])), latinFullName:mrzFull};
    }
  }
  for (const field of document.invalidFields) if (DOCUMENT_FIELDS.has(field)||field==='visiblePassportNumber') issues.push(issue('DOCUMENT_FIELD_INVALID',field==='visiblePassportNumber'?'passportNumber':field));
  return {...document, fields, fieldProvenance, issues, mrzChecked, mrzIdentity, checkedOptionalDigits:optionalDigits, checkedMrzDates};
}
function conflictsWithCase(document, known) {
  const issues = [];
  for (const field of [...IDENTITY_FIELDS, 'latinFirstName', 'latinFamilyName', 'issuingCountryCode', 'issueDate', 'expiryDate', 'emiratesId', 'residenceExpiry']) if (known[field] && document.fields[field] && !equivalent(field, known[field], document.fields[field])) issues.push(issue('CASE_DATA_MISMATCH', field));
  return issues;
}
function matchesIdentity(first, second) {
  return Boolean(first.passportNumber && second.passportNumber && first.passportNumber === second.passportNumber || first.birthDate && second.birthDate && first.birthDate === second.birthDate && exactIdentityNameMatch(first,second));
}
function identityConflicts(first, second) {
  const issues = [];
  for (const field of IDENTITY_FIELDS) if (first[field] && second[field] && !equivalent(field, first[field], second[field])) issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', field));
  if (fullName(first) && fullName(second) && !exactIdentityNameMatch(first,second)) issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', 'latinFullName'));
  return issues;
}
function addSources(result, document, acceptedFields, method) {
  for (const field of acceptedFields) {
    if (!Object.hasOwn(document.fields, field)) continue;
    result.evidence.fieldSources[field] ||= [];
    const sources = document.fieldProvenance?.[field] || [{...ref(document), confidence: document.extraction.fields[field].confidence}];
    result.evidence.fieldSources[field].push(...sources.map(source => ({...source, method:source.method||method})));
  }
}

function completePrintedId(document){return /^784\d{12}$/.test(document.fields.emiratesId||'');}
function residenceNameComponentConflicts(document,passport){
  return ['latinFirstName','latinFatherName','latinGrandfatherName','latinFamilyName'].filter(field=>document.fields[field]&&passport.fields[field]&&!equivalent(field,document.fields[field],passport.fields[field])).map(field=>issue('DOCUMENT_IDENTITY_MISMATCH',field));
}
function uncertainNativeId(document){
  const field=document.extraction.fields.emiratesId;
  return document.kind==='uae_id_back'&&document.nativeTd1Checked===true&&field?.visible===true&&typeof field.value==='string'&&Number.isFinite(field.confidence)&&field.confidence>=0&&field.confidence<THRESHOLD&&!Object.hasOwn(document.fields,'emiratesId');
}
function pairPrintedConflicts(document,passport,eid){
  const expected={birthDate:passport.fields.birthDate,sex:passport.fields.sex,nationalityCode:passport.fields.nationalityCode,emiratesId:eid};
  for(const [field,value]of Object.entries(expected)){
    if(!value)continue;
    // A low-confidence model ID is not an accepted fact. Only a locally
    // checked TD1 back may leave that observation uncertain; the complete
    // printed front ID still has to match the whole protected optional zone.
    if(field==='emiratesId'&&uncertainNativeId(document))continue;
    const printed=document.extraction.fields[field];
    const observed=document.fields[field]??(printed?.visible===true&&typeof printed.value==='string'?normalizedValue(field,printed.value):null);
    if(observed&&!equivalent(field,observed,value))return true;
  }
  return document.issues.length>0||residenceNameComponentConflicts(document,passport).length>0||document.invalidFields.some(field=>['birthDate','sex','nationalityCode','emiratesId','latinFullName','latinFirstName','latinFamilyName'].includes(field));
}
function pairComparisonFields(document,front,birthDate){
  // This temporary view is used only by matching and conflict comparisons.
  // The original fields and government field-source manifests remain untouched.
  return {...document.fields,...(!document.fields.birthDate?{birthDate}:{}),...(!fullName(document.fields)?{latinFullName:fullName(front.fields)}:{})};
}
function checkedResidencePair(passport,front,back){
  if(passport.mrzChecked!==true||passport.issues.length||!realDate(passport.fields.birthDate)||!completePrintedId(front)||!front.fields.latinFullName)return null;
  const parsed=parseTD1MRZ(back.extraction.mrzLines);
  if(!parsed.ok||parsed.fields.latinNames.truncated||!matchesPrintedEmiratesId(parsed,front.fields.emiratesId))return null;
  const identity=identityFields(passport),variants=identity._documentNameVariants||[fullName(identity)];
  const name=normalizedName([parsed.fields.latinNames.givenNames,parsed.fields.latinNames.family].filter(Boolean).join(' '));
  if(name!==fullName(front.fields)||!variants.includes(name)||passport.fields.birthDate.replaceAll('-','').slice(2)!==parsed.fields.birthDateRaw)return null;
  for(const document of [front,back]){
    if(pairPrintedConflicts(document,passport,front.fields.emiratesId))return null;
    const comparison=pairComparisonFields(document,front,passport.fields.birthDate);
    if(identityConflicts(identity,comparison).length)return null;
  }
  if([front.fields,back.fields,passport.fields].some(fields=>fields.sex&&fields.sex!==parsed.fields.sex||fields.nationalityCode&&!equivalent('nationalityCode',fields.nationalityCode,parsed.fields.nationalityCode)))return null;
  return {front,back,birthDate:passport.fields.birthDate,method:'printed_front_identity_and_checked_td1'};
}
function assignedFrontContext(passport,document,fronts){
  if(passport.mrzChecked!==true||passport.issues.length||document.fields.birthDate||!completePrintedId(document)||document.extraction.mrzLines.length)return null;
  const identity=identityFields(passport);
  const front=fronts.find(source=>source!==document&&completePrintedId(source)&&source.fields.emiratesId===document.fields.emiratesId&&realDate(source.fields.birthDate)&&source.fields.birthDate===passport.fields.birthDate&&matchesIdentity(identity,source.fields)&&identityConflicts(identity,source.fields).length===0&&!pairPrintedConflicts(document,passport,source.fields.emiratesId)&&!pairPrintedConflicts(source,passport,source.fields.emiratesId));
  return front?{front,back:document,birthDate:front.fields.birthDate,method:'printed_id_and_assigned_front_birth_date'}:null;
}

function projectPrintedResidenceDates(result, documents, passport, known) {
  const fronts=documents.filter(document=>document.kind==='uae_id_front');
  const suppliedBacks=documents.filter(document=>document.kind==='uae_id_back'&&document.extraction.mrzLines.length);
  if(!suppliedBacks.length)return;
  const checked=[];
  for(const back of suppliedBacks){
    const parsed=parseTD1MRZ(back.extraction.mrzLines);
    if(!parsed.ok){result.issues.push(issue('RESIDENCE_MRZ_INVALID','residence'));continue;}
    // Both sides are already assigned to this same applicant.
    // Optional data becomes an anchor only after an explicit, complete front
    // ID matches its whole protected zone. Never extract or repair an ID here.
    const linked=fronts.filter(front=>checkedResidencePair(passport,front,back));
    if(!linked.length){
      result.issues.push(issue('RESIDENCE_CONFLICT','residence'));continue;
    }
    checked.push({back,parsed});
  }
  // A second supplied but invalid/contradictory reading cannot be ignored in
  // favour of a successful one. Existing explicit ISO facts remain visible.
  if(checked.length!==suppliedBacks.length)return;
  for(const document of documents){
    if(document.fields.residenceExpiry&&checked.some(({parsed})=>document.fields.residenceExpiry.replaceAll('-','').slice(2)!==parsed.fields.expiryDateRaw))result.issues.push(issue('RESIDENCE_CONFLICT','residenceExpiry'));
  }
  if(result.issues.some(item=>['RESIDENCE_CONFLICT','RESIDENCE_MRZ_INVALID','DOCUMENT_IDENTITY_MISMATCH','SOURCE_CONFLICT'].includes(item.code)))return;
  const candidates=[];
  for(const document of documents){
    const raw=document.fields.printedResidenceExpiry;if(!raw)continue;
    const resolved=checked.map(({back,parsed})=>({back,value:resolvePrintedDate(raw,parsed.fields.expiryDateRaw)}));
    const values=[...new Set(resolved.map(item=>item.value).filter(Boolean))];
    if(values.length!==1||resolved.some(item=>!item.value)||document.fields.residenceExpiry&&document.fields.residenceExpiry!==values[0]){
      result.issues.push(issue('RESIDENCE_CONFLICT','residenceExpiry'));continue;
    }
    candidates.push({document,value:values[0],back:resolved[0].back});
  }
  if(!candidates.length)return;
  const values=[...new Set(candidates.map(item=>item.value))];
  if(values.length!==1||result.fields.residenceExpiry&&result.fields.residenceExpiry!==values[0]||known.residenceExpiry&&known.residenceExpiry!==values[0])result.issues.push(issue('RESIDENCE_CONFLICT','residenceExpiry'));
  if(result.issues.some(item=>item.code==='RESIDENCE_CONFLICT'))return;
  result.fields.residenceExpiry=values[0];
  result.evidence.fieldSources.residenceExpiry||=[];
  for(const {document,back}of candidates){
    const sources=document.fieldProvenance?.printedResidenceExpiry||[{...ref(document),confidence:document.extraction.fields.printedResidenceExpiry.confidence}];
    result.evidence.fieldSources.residenceExpiry.push(...sources.map(source=>({...source,evidenceField:'printedResidenceExpiry',corroboratedBy:ref(back),method:'visible_and_passport_identity_matched'})));
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
        else { fields[field]=value; fieldProvenance[field]=document.fieldProvenance?.[field]||[{...ref(document),confidence:document.extraction.fields[field].confidence}]; }
      }
      if (document.extraction.rotation !== primary.extraction.rotation) issues.push(issue('SOURCE_CONFLICT','rotation'));
      if (document.extraction.mrzLines.length && primary.extraction.mrzLines.length && JSON.stringify(document.extraction.mrzLines) !== JSON.stringify(primary.extraction.mrzLines)) issues.push(issue('SOURCE_CONFLICT','mrz'));
      const box=document.extraction.portraitBox,chosenBox=primary.extraction.portraitBox;
      if (box && chosenBox && ['x','y','width','height'].some(key => box[key] !== chosenBox[key])) issues.push(issue('SOURCE_CONFLICT','portraitBox'));
    }
    const passportNumberObservations=group.flatMap(document=>document.passportNumberObservations||[]);
    if(group.length>1&&new Set(passportNumberObservations.map(observed=>normalizedValue('passportNumber',observed.value))).size>1)issues.push(issue('SOURCE_CONFLICT','passportNumber'));
    const nativeTd1Checked=group.some(document=>document.nativeTd1Checked===true&&JSON.stringify(document.extraction.mrzLines)===JSON.stringify(primary.extraction.mrzLines));
    return {...primary,fields,fieldProvenance,passportNumberObservations,...(nativeTd1Checked?{nativeTd1Checked:true}:{}),issues:uniqueIssues(issues),invalidFields:[...new Set(group.flatMap(document=>document.invalidFields))],lowConfidence:[...new Set(group.flatMap(document=>document.lowConfidence))]};
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
function projectPrintedPassportDates(parts) {
  return parts.map(part=>{
    const raw=part.fields.printedPassportExpiry;if(!raw)return part;
    // Resolve only the full printed four-digit year. A separate page must have
    // its explicit national number anchored to the complete checked optional
    // TD3 field; dates alone and arbitrary optional data are not a page link.
    const witnesses=parts.filter(other=>other.checkedMrzDates&&(other===part&&evidenceConfidence(part,'printedPassportExpiry')>=THRESHOLD||nationalPageAnchor(other,part)));
    if(!witnesses.length)return part;
    const resolved=witnesses.map(witness=>({witness,value:resolvePrintedDate(raw,witness.checkedMrzDates.expiryDateRaw)}));
    const values=[...new Set(resolved.map(item=>item.value).filter(Boolean))];
    const conflicts=values.length!==1||resolved.some(item=>!item.value)||part.fields.expiryDate&&part.fields.expiryDate!==values[0];
    if(conflicts)return {...part,issues:[...part.issues,issue('PASSPORT_VIZ_MRZ_MISMATCH','expiryDate')]};
    if(part.fields.expiryDate)return part;
    const source=part.fieldProvenance?.printedPassportExpiry?.[0]||{...ref(part),confidence:part.extraction.fields.printedPassportExpiry.confidence};
    const witness=resolved.find(item=>item.value===values[0]).witness;
    return {...part,fields:{...part.fields,expiryDate:values[0]},fieldProvenance:{...part.fieldProvenance,expiryDate:[{...source,evidenceField:'printedPassportExpiry',corroboratedBy:ref(witness)}]}};
  });
}
function consistentPartValue(field,first,second){
  if(field==='passportNationalNumber')return Boolean(nationalDigits(first)&&nationalDigits(first)===nationalDigits(second));
  if(field==='printedPassportExpiry'||field==='printedResidenceExpiry'){
    const numeric=value=>{const match=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return match?[Number(match[1]),Number(match[2]),match[3]].join('/'):value;};
    return numeric(first)===numeric(second);
  }
  return equivalent(field,first,second);
}
function selectResidenceFrontPreparation(documents,passport){
  const backs=documents.filter(document=>document.kind==='uae_id_back'),groups=new Map(),selected=[],duplicates=[];
  for(const front of documents.filter(document=>document.kind==='uae_id_front')){
    const witnesses=backs.filter(back=>checkedResidencePair(passport,front,back));
    if(!witnesses.length){selected.push(front);continue;}
    const key=JSON.stringify([front.fields.emiratesId,fullName(front.fields)]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push({front,witnesses});
  }
  for(const group of groups.values()){
    if(group.length===1){selected.push(group[0].front);continue;}
    const parts=group.map(item=>item.front),union={};
    const common=group[0].witnesses.map(back=>JSON.stringify(back.extraction.mrzLines)).filter(lines=>group.every(item=>item.witnesses.some(back=>JSON.stringify(back.extraction.mrzLines)===lines)));
    let consistent=common.length>0&&parts.every(part=>part.extraction.rotation===parts[0].extraction.rotation);
    for(const part of parts)for(const [field,value]of Object.entries(part.fields)){
      if(Object.hasOwn(union,field)&&!consistentPartValue(field,union[field],value))consistent=false;
      else union[field]=value;
    }
    const critical=[...DOCUMENT_FIELDS,'printedResidenceExpiry'].filter(field=>Object.hasOwn(union,field));
    const covering=consistent?parts.filter(part=>critical.every(field=>Object.hasOwn(part.fields,field)&&consistentPartValue(field,part.fields[field],union[field]))).sort(compareReference):[];
    if(!covering.length){selected.push(...parts);continue;}
    const representative=covering[0],lines=[...new Set(common)].sort()[0];selected.push(representative);
    const witness=group.find(item=>item.front===representative).witnesses.filter(back=>JSON.stringify(back.extraction.mrzLines)===lines).sort(compareReference)[0];
    for(const source of parts.filter(part=>part!==representative).sort(compareReference))duplicates.push({representative:ref(representative),source:ref(source),back:ref(witness),method:'same_printed_front_identity_and_exact_checked_td1'});
  }
  return {selected:selected.sort(compareReference),duplicates:duplicates.sort((a,b)=>compareReference(a.source,b.source))};
}
function selectResidencePreparation(result,documents,passport){
  if(result.issues.some(item=>['SOURCE_CONFLICT','DOCUMENT_IDENTITY_MISMATCH','RESIDENCE_CONFLICT','RESIDENCE_MRZ_INVALID','CASE_DATA_MISMATCH','DOCUMENT_FIELD_INVALID'].includes(item.code)))return;
  // Several photographs can prove the same front. Select one actual covering
  // front first, using a shared exact checked TD1 witness; retain all evidence.
  const frontSelection=selectResidenceFrontPreparation(documents,passport);
  const fronts=frontSelection.selected,groups=new Map(),selected=[...fronts],duplicates=[];
  for(const document of documents.filter(document=>document.kind==='uae_id_back')){
    const proofs=fronts.map(front=>checkedResidencePair(passport,front,document)).filter(Boolean);
    if(proofs.length!==1){selected.push(document);continue;}
    const front=proofs[0].front,key=JSON.stringify({mrzLines:document.extraction.mrzLines,front:ref(front)});
    if(!groups.has(key))groups.set(key,{front,parts:[]});groups.get(key).parts.push(document);
  }
  for(const {front,parts}of groups.values()){
    if(parts.length===1){selected.push(parts[0]);continue;}
    const union={};let consistent=parts.every(part=>part.extraction.rotation===parts[0].extraction.rotation);
    for(const part of parts)for(const [field,value]of Object.entries(part.fields)){
      if(Object.hasOwn(union,field)&&!consistentPartValue(field,union[field],value))consistent=false;
      else union[field]=value;
    }
    // An actual uploaded image must cover every accepted government fact and
    // any printed expiry witness. Complementary OCR fragments cannot invent a
    // complete back image, even when their exact checked TD1 lines agree.
    const critical=[...DOCUMENT_FIELDS,'printedResidenceExpiry'].filter(field=>Object.hasOwn(union,field));
    const covering=consistent?parts.filter(part=>critical.every(field=>Object.hasOwn(part.fields,field)&&consistentPartValue(field,part.fields[field],union[field]))).sort(compareReference):[];
    if(!covering.length){selected.push(...parts);continue;}
    const representative=covering[0];selected.push(representative);
    for(const source of parts.filter(part=>part!==representative).sort(compareReference))duplicates.push({representative:ref(representative),source:ref(source),front:ref(front),method:'exact_checked_td1_same_paired_identity_and_visible_values'});
  }
  if(!duplicates.length&&!frontSelection.duplicates.length)return;
  // Only preparation references are reduced. Every original remains in the
  // intake manifest, matching evidence and pair links for integrity checks.
  result.documents.residence=selected.map(ref);
  if(duplicates.length)result.evidence.residenceLogicalDuplicates=duplicates.sort((a,b)=>compareReference(a.source,b.source));
  if(frontSelection.duplicates.length)result.evidence.residenceFrontLogicalDuplicates=frontSelection.duplicates;
}
function selectPassportPreparation(parts){
  const groups=new Map(),selected=[],duplicates=[],issues=[];
  for(const part of parts){
    // The complete two-line transcription, not an image resemblance or just a
    // document number, defines a possible repeated main page.
    const lines=part.extraction.mrzLines;
    const key=part.checkedMrzDates&&lines.length===2&&lines.every(line=>/^[A-Z0-9<]{44}$/.test(line))?JSON.stringify(lines):null;
    if(!key){selected.push(part);continue;}
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(part);
  }
  for(const group of groups.values()){
    if(group.length===1){selected.push(group[0]);continue;}
    const union={},numberValues=new Set(group.flatMap(part=>part.passportNumberObservations||[]).map(observed=>normalizedValue('passportNumber',observed.value)));
    let consistent=numberValues.size<=1;if(!consistent)issues.push(issue('SOURCE_CONFLICT','passportNumber'));
    for(const part of group)for(const [field,value]of Object.entries(part.fields)){
      if(Object.hasOwn(union,field)&&!consistentPartValue(field,union[field],value)){consistent=false;issues.push(issue('SOURCE_CONFLICT',field));}
      else union[field]=value;
    }
    const critical=PASSPORT_FIELDS.filter(field=>Object.hasOwn(union,field));
    const covering=consistent?group.filter(part=>critical.every(field=>Object.hasOwn(part.fields,field)&&equivalent(field,part.fields[field],union[field]))).sort(compareReference):[];
    if(!covering.length){selected.push(...group);continue;}
    const representative=covering[0];selected.push(representative);
    for(const source of group.filter(part=>part!==representative).sort(compareReference))duplicates.push({representative:ref(representative),source:ref(source),method:'exact_checked_td3_same_visible_values'});
  }
  selected.sort((a,b)=>Number(b.extraction.mrzLines.length===2)-Number(a.extraction.mrzLines.length===2)||compareReference(a,b));
  return {selected,duplicates:duplicates.sort((a,b)=>compareReference(a.source,b.source)),issues:uniqueIssues(issues)};
}
function passportGroups(documents, referenceDate) {
  // Strong identity edges may reveal a contradiction; keep that contradiction
  // in the group and block it instead of silently selecting the latest page.
  const remaining = new Set(documents), groups = [];
  while (remaining.size) {
    let parts = [remaining.values().next().value]; remaining.delete(parts[0]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const document of remaining) if (parts.some(other => passportPageLink(other,document))) {
        parts.push(document); remaining.delete(document); changed = true;
      }
    }
    parts.sort((a,b) => Number(b.extraction.mrzLines.length === 2) - Number(a.extraction.mrzLines.length === 2) || compareReference(a,b));
    parts=projectPrintedPassportDates(parts);
    const fields = {}, issues = [], invalidFields = [];
    for (const part of parts) {
      issues.push(...part.issues); invalidFields.push(...part.invalidFields);
      for (const field of [...PASSPORT_FIELDS, 'latinFullName', 'arabicFullName']) if (Object.hasOwn(part.fields, field)) {
        if (Object.hasOwn(fields, field) && !equivalent(field, fields[field], part.fields[field])) issues.push(issue('MULTIPLE_PASSPORTS', field));
        else fields[field] = part.fields[field];
      }
    }
    // Full printed dates may be on a strongly linked supplementary page. A
    // two-digit MRZ date never chooses its own century, and name components
    // are never inferred. Literal country zones are handled separately above.
    const mrzParts = parts.filter(part => part.extraction.mrzLines.length > 0);
    const checked = (mrzParts.length ? mrzParts : [parts[0]]).map(part => inspectPassport({...part, fields, invalidFields:[]}, referenceDate));
    for (const document of checked) issues.push(...document.issues);
    for (const field of invalidFields) if (DOCUMENT_FIELDS.has(field)) issues.push(issue('DOCUMENT_FIELD_INVALID', field));
    const preparation=selectPassportPreparation(parts),selectedRef=part=>preparation.selected.some(source=>source.mediaId===part.mediaId&&source.page===part.page&&source.sha256===part.sha256);
    issues.push(...preparation.issues);
    const primary = checked.find(part => part.mrzChecked&&selectedRef(part)) || checked.find(selectedRef) || checked[0];
    if(fields.passportNumber&&!primary.fieldProvenance?.passportNumber){
      const source=parts.find(part=>part.fields.passportNumber&&equivalent('passportNumber',part.fields.passportNumber,fields.passportNumber));
      if(source)primary.fieldProvenance={...primary.fieldProvenance,passportNumber:source.fieldProvenance?.passportNumber||[{...ref(source),confidence:source.extraction.fields.passportNumber.confidence}]};
    }
    if (checked.some(part => part.mrzIdentity && primary.mrzIdentity && [...MRZ_FIELDS, 'latinFullName'].some(field => part.mrzIdentity[field] && primary.mrzIdentity[field] && !equivalent(field, part.mrzIdentity[field], primary.mrzIdentity[field])))) issues.push(issue('MULTIPLE_PASSPORTS', 'mrz'));
    if (preparation.selected.length > 2) issues.push(issue('MULTIPLE_PASSPORTS', 'passport'));
    const ordered = [parts.find(part => part.mediaId === primary.mediaId && part.page === primary.page), ...parts.filter(part => part.mediaId !== primary.mediaId || part.page !== primary.page)];
    const preparationParts=[...preparation.selected].sort((a,b)=>Number(b.mediaId===primary.mediaId&&b.page===primary.page)-Number(a.mediaId===primary.mediaId&&a.page===primary.page)||Number(b.extraction.mrzLines.length===2)-Number(a.extraction.mrzLines.length===2)||compareReference(a,b));
    groups.push({...primary, fields, parts:ordered,preparationParts,logicalDuplicates:preparation.duplicates,issues:uniqueIssues(issues),mrzChecked:checked.length > 0 && checked.every(part => part.mrzChecked)});
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
  // An ambiguous/unassigned duplicate must still surface its known source
  // contradictions; absence of an applicant assignment cannot erase them.
  for(const document of distinct)output.issues.push(...document.issues.filter(item=>item.code==='SOURCE_CONFLICT'));
  // Strip the provisional per-page MRZ issues before group inspection. A page
  // with no MRZ can supplement a proven passport, but any supplied bad MRZ must
  // still fail the final group inspection.
  const passports = passportGroups(distinct.filter(document => document.kind === 'passport').map(document => ({...document, issues:document.issues.filter(item => !['PASSPORT_MRZ_REQUIRED','PASSPORT_MRZ_INVALID','PASSPORT_MRZ_DATE_AMBIGUOUS','PASSPORT_VIZ_MRZ_MISMATCH','DOCUMENT_FIELD_INVALID'].includes(item.code))})), referenceDate);
  const known = applicants.map(knownFields), assignments = new Map(), passportFor = new Map();
  const strongPassports=passports.filter(hasStrongVisualIdentity);
  const uniqueVisualPassport=strongPassports.length===1&&passports.every(document=>document===strongPassports[0]||!hasPassportIdentityAnchor(document))?strongPassports[0]:null;
  for (const document of passports) {
    let candidates = known.map((fields, index) => ({fields, index})).filter(({fields}) => fields.passportNumber && document.fields.passportNumber && fields.passportNumber === document.fields.passportNumber).map(item => item.index);
    if (!candidates.length) candidates = known.map((fields, index) => ({fields, index})).filter(({fields}) => fields.birthDate && document.fields.birthDate && fields.birthDate === document.fields.birthDate && exactIdentityNameMatch(fields,identityFields(document))).map(item => item.index);
    // An unanchored dates-only page must not erase the one identifiable main
    // passport. Keep it unassigned; its dates cannot complete the main page.
    if (!candidates.length && applicants.length === 1 && (passports.length === 1 || document === uniqueVisualPassport)) candidates = [0];
    if (candidates.length !== 1) { const sourceConflict=document.issues.some(item=>item.code==='SOURCE_CONFLICT');document.parts.forEach(part => unassign(part,sourceConflict?'SOURCE_CONFLICT':'DOCUMENT_UNASSIGNED')); continue; }
    const index = candidates[0], result = output.applicants[index];
    result.issues.push(...document.issues, ...conflictsWithCase(document, known[index]));
    if (passportFor.has(index)) { result.issues.push(issue('MULTIPLE_PASSPORTS', 'passport')); document.parts.forEach(part => unassign(part, 'MULTIPLE_PASSPORTS')); continue; }
    passportFor.set(index, document); document.parts.forEach(part => assignments.set(part, index));
    result.documents.passport = ref(document); result.evidence.passportMrzChecked = document.mrzChecked;
    if(document.preparationParts.length>1&&document.preparationParts.length<=2)result.documents.passportParts=document.preparationParts.map(ref);
    if(document.preparationParts.length>2)for(const part of document.preparationParts.filter(part=>part.mediaId!==document.mediaId||part.page!==document.page))unassign(part,'MULTIPLE_PASSPORTS');
    if(document.logicalDuplicates.length)result.evidence.passportLogicalDuplicates=document.logicalDuplicates;
    for (const field of PASSPORT_FIELDS) if (Object.hasOwn(document.fields, field)) result.fields[field] = document.fields[field];
    result.evidence.passportNumberObservations=document.parts.flatMap(part=>part.passportNumberObservations||[]);
    for (const part of document.parts) addSources(result, part, PASSPORT_FIELDS.filter(field=>field!=='passportNumber'), document.mrzChecked ? 'visible_and_mrz_checked' : 'visible_unconfirmed');
    addSources(result,document,['passportNumber'],'visible_unconfirmed');
  }
  const identities = distinct.filter(document => document.kind === 'uae_id_front' || document.kind === 'uae_id_back').sort((a,b) => Number(a.kind === 'uae_id_back') - Number(b.kind === 'uae_id_back') || compareReference(a,b));
  const closedPairs=[];
  for(const [index,passport]of passportFor)for(const front of identities.filter(document=>document.kind==='uae_id_front'))for(const back of identities.filter(document=>document.kind==='uae_id_back')){
    const pair=checkedResidencePair(passport,front,back);if(pair)closedPairs.push({...pair,index});
  }
  const contextsFor=(document,index)=>closedPairs.filter(pair=>(index===undefined||pair.index===index)&&(pair.front===document||pair.back===document)&&[pair.front,pair.back].every(source=>!assignments.has(source)||assignments.get(source)===pair.index));
  const pending = new Set(identities);
  let changed = true;
  while (changed) {
    changed = false;
    for (const document of pending) {
      let candidates = [...passportFor].filter(([, passport]) => matchesIdentity(identityFields(passport), document.fields)).map(([index]) => index);
      if (!candidates.length && document.fields.emiratesId) candidates = [...passportFor].filter(([index]) => known[index].emiratesId === document.fields.emiratesId || identities.some(other => assignments.get(other) === index && other.fields.emiratesId === document.fields.emiratesId)).map(([index]) => index);
      if(!candidates.length)candidates=[...new Set(contextsFor(document).map(pair=>pair.index))];
      if (candidates.length !== 1) continue;
      const index = candidates[0], result = output.applicants[index], passport = passportFor.get(index);
      const context=contextsFor(document,index)[0]||assignedFrontContext(passport,document,identities.filter(other=>other.kind==='uae_id_front'&&assignments.get(other)===index));
      const comparison=context?pairComparisonFields(document,context.front,context.birthDate):document.fields;
      pending.delete(document); changed = true; assignments.set(document, index);
      result.documents.residence.push(ref(document));
      result.issues.push(...document.issues, ...identityConflicts(identityFields(passport), comparison), ...residenceNameComponentConflicts(document,passport), ...conflictsWithCase({fields:Object.fromEntries(Object.entries(document.fields).filter(([field]) => field !== 'expiryDate' && field !== 'issueDate' && field !== 'issuingCountryCode'))}, known[index]));
      if(context){
        result.evidence.residencePairLinks||=[];
        const link={front:ref(context.front),source:ref(context.back),method:context.method};
        if(!result.evidence.residencePairLinks.some(value=>value.front.mediaId===link.front.mediaId&&value.source.mediaId===link.source.mediaId&&value.method===link.method))result.evidence.residencePairLinks.push(link);
      }
      if(uncertainNativeId(document)){
        result.evidence.residenceUncertainIdObservations||=[];
        result.evidence.residenceUncertainIdObservations.push({...ref(document),evidenceField:'emiratesId',confidence:document.extraction.fields.emiratesId.confidence,method:'uncertain_raw_id_with_native_td1'});
      }
      for (const field of ['emiratesId', 'residenceExpiry']) if (document.fields[field]) {
        if (result.fields[field] && !equivalent(field, result.fields[field], document.fields[field])) result.issues.push(issue('RESIDENCE_CONFLICT', field));
        else result.fields[field] = document.fields[field];
      }
      for (const field of document.invalidFields) if (['emiratesId','residenceExpiry','birthDate'].includes(field)) result.issues.push(issue('DOCUMENT_FIELD_INVALID', field));
      addSources(result, document, ['emiratesId','residenceExpiry'], 'visible_and_passport_identity_matched');
    }
  }
  for (const document of pending) {
    const possible = [...passportFor].filter(([, passport]) => fullName(identityFields(passport)) && exactIdentityNameMatch(identityFields(passport),document.fields) || passport.fields.birthDate && passport.fields.birthDate === document.fields.birthDate).map(([index]) => index);
    if (possible.length === 1) output.applicants[possible[0]].issues.push(issue('DOCUMENT_IDENTITY_MISMATCH', 'residence'));
    unassign(document);
  }
  for(const [index,passport]of passportFor){
    const documents=identities.filter(document=>assignments.get(document)===index),result=output.applicants[index];
    projectPrintedResidenceDates(result,documents,passport,known[index]);
    selectResidencePreparation(result,documents,passport);
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
    result.evidence.matchedResidence = result.documents.residence.length > 0 && !result.issues.some(item => ['DOCUMENT_IDENTITY_MISMATCH','RESIDENCE_CONFLICT','RESIDENCE_MRZ_INVALID'].includes(item.code));
    const nationalitySources=result.evidence.fieldSources.nationalityCode||[];
    if(nationalitySources.some(source=>source.method==='td3_zone_transcription')){
      const code=result.fields.nationalityCode;
      const caseMatch=Boolean(code&&known[result.applicantIndex].nationalityCode===code);
      const identityMatch=identities.some(document=>assignments.get(document)===result.applicantIndex&&document.fields.nationalityCode===code);
      result.evidence.nationalityCorroborated=caseMatch||identityMatch;
      if(!result.evidence.nationalityCorroborated)result.issues.push(issue('DOCUMENT_FIELD_REQUIRED','nationalityCode'));
    }
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

module.exports = {reconcileDocumentEvidence, DOCUMENT_CONFIDENCE_THRESHOLD:THRESHOLD, DOCUMENT_MATCH_ISSUE_CODES:Object.freeze(Object.keys(MESSAGES))};
