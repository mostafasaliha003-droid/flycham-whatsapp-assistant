'use strict';

const {createHash, randomUUID} = require('node:crypto');
const P = require('./saudi-visa-policy');
const {validCustomer} = require('./conversation-journal');
const {visaCaseSignature, currentVisaEvidence} = require('./visa-case-signature');
const {validateApplicant, proposedEntryDate} = require('./raad-document-validation');
const {requiredQuestions} = require('./visa-client-questions');
const {reconcileDocumentEvidence} = require('./visa-document-matching');

// This module prepares protected local drafts. It has no portal client, payment
// client, session credentials, submission action, or legal-consent action.
const FIELD_ALLOWLIST = Object.freeze([
  'nationalityCode', 'passportNumber', 'passportType', 'issuingCountryCode',
  'issueDate', 'expiryDate', 'birthDate', 'birthPlace', 'sex',
  'latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName',
  'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName', 'emiratesId', 'residenceExpiry',
  'maritalStatus', 'previousNationality', 'previousNationalityDetails',
  'travelledLastFiveYears', 'travelHistory', 'performUmrah', 'saudiAddress',
  'entryDate', 'transport', 'arrivalPort', 'gccResident', 'health', 'guardian',
  'priorGccDeportation', 'priorGccRuleViolation',
  'mission', 'residenceCountryCode', 'visitPurpose', 'entries', 'visaValidityDays',
  'applicationPhone', 'contactEmail', 'insurancePhone', 'postalCode', 'city', 'postOfficeBox'
]);
const FIELD_SET = new Set(FIELD_ALLOWLIST);
const BOOLEAN_FIELDS = new Set(['previousNationality', 'travelledLastFiveYears', 'performUmrah', 'gccResident', 'priorGccDeportation', 'priorGccRuleViolation']);
const HEALTH_FIELDS = Object.freeze(['hospitalizedOrEmergency', 'accidentDisability', 'congenitalCondition']);
const GUARDIAN_FIELDS = Object.freeze(['relationship', 'visaReference', 'status']);
const DOCUMENT_KINDS = Object.freeze(['passport', 'residence', 'photo']);
const DOCUMENT_FACT_FIELDS = Object.freeze([
  'nationalityCode', 'passportNumber', 'passportType', 'issuingCountryCode',
  'issueDate', 'expiryDate', 'birthDate', 'birthPlace', 'sex',
  'latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName',
  'arabicFirstName', 'arabicFatherName', 'arabicGrandfatherName', 'arabicFamilyName',
  'emiratesId', 'residenceExpiry'
]);
const DOCUMENT_FACT_SET = new Set(DOCUMENT_FACT_FIELDS);
const CONTACT_FIELDS = Object.freeze(['applicationPhone', 'contactEmail', 'insurancePhone', 'postalCode']);
const CONTACT_ENV = Object.freeze({applicationPhone: 'RAAD_APPLICATION_PHONE', contactEmail: 'RAAD_CONTACT_EMAIL', insurancePhone: 'RAAD_INSURANCE_PHONE', postalCode: 'RAAD_POSTAL_CODE', city: 'RAAD_CITY', postOfficeBox: 'RAAD_POST_OFFICE_BOX'});
const NATIONALITY_CODES = Object.freeze({
  'سوريا': 'SYR', 'الأردن': 'JOR', 'لبنان': 'LBN', 'جزر القمر': 'COM',
  'اليمن': 'YEM', 'السودان': 'SDN', 'مصر': 'EGY', 'فلسطين': 'PSE',
  'ليبيا': 'LBY', 'العراق': 'IRQ', 'أفغانستان': 'AFG', 'إيران': 'IRN',
  'تشاد': 'TCD', 'ماليزيا': 'MYS', 'إندونيسيا': 'IDN', 'الهند': 'IND',
  'باكستان': 'PAK', 'بنغلاديش': 'BGD', 'الولايات المتحدة': 'USA', 'كندا': 'CAN',
  'بريطانيا': 'GBR', 'فرنسا': 'FRA', 'ألمانيا': 'DEU', 'إيطاليا': 'ITA',
  'إسبانيا': 'ESP', 'هولندا': 'NLD', 'السويد': 'SWE', 'النرويج': 'NOR',
  'الدنمارك': 'DNK', 'سويسرا': 'CHE', 'البرتغال': 'PRT', 'النمسا': 'AUT',
  'بلجيكا': 'BEL', 'اليونان': 'GRC', 'أيرلندا': 'IRL', 'فنلندا': 'FIN',
  'بولندا': 'POL', 'رومانيا': 'ROU', 'بلغاريا': 'BGR', 'دومينيكا': 'DMA',
  'سانت كيتس ونيفيس': 'KNA', 'أنتيغوا وباربودا': 'ATG', 'غرينادا': 'GRD', 'سانت لوسيا': 'LCA'
});
const COUNTRY_BY_CODE = Object.fromEntries(Object.entries(NATIONALITY_CODES).map(([name, code]) => [code, name]));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clone = value => structuredClone(value);
const countryCode = value => typeof value === 'string' ? (value.trim().toUpperCase() === 'D<<' ? 'DEU' : value.trim().toUpperCase()) : value;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(code, statusCode = 400) { throw Object.assign(Error(code), {code, statusCode}); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value === undefined ? null : value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const issue = (field, code, message) => ({field, code, message});
function cleanString(value, max = 500) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('RAAD_FIELDS_INVALID');
  return value.trim();
}
function cleanFields(input, {source = false} = {}) {
  if (!isObject(input)) fail('RAAD_FIELDS_INVALID');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FIELD_SET.has(key)) { if (source) continue; fail('RAAD_FIELD_NOT_ALLOWED'); }
    if (value === null) { result[key] = null; continue; }
    if (key === 'health' || key === 'guardian') {
      if (!isObject(value)) { if (source) continue; fail('RAAD_FIELDS_INVALID'); }
      const permitted = key === 'health' ? HEALTH_FIELDS : GUARDIAN_FIELDS, nested = {};
      for (const [name, fact] of Object.entries(value)) {
        if (!permitted.includes(name)) { if (source) continue; fail('RAAD_FIELD_NOT_ALLOWED'); }
        if (fact === null) { nested[name] = null; continue; }
        if (key === 'health') {
          if (typeof fact !== 'boolean') { if (source) continue; fail('RAAD_FIELDS_INVALID'); }
          nested[name] = fact;
        } else if (typeof fact === 'string') {
          try { nested[name] = cleanString(fact, 200); } catch (error) { if (!source) throw error; }
        }
        else if (!source) fail('RAAD_FIELDS_INVALID');
      }
      if (Object.keys(nested).length) result[key] = nested;
    } else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean') { if (source) continue; fail('RAAD_FIELDS_INVALID'); }
      result[key] = value;
    } else if (key === 'visaValidityDays') {
      if (!Number.isSafeInteger(value) || value < 1 || value > 3650) { if (source) continue; fail('RAAD_FIELDS_INVALID'); }
      result[key] = value;
    } else if (typeof value === 'string') {
      try {
        result[key] = cleanString(value, ['travelHistory', 'saudiAddress', 'previousNationalityDetails'].includes(key) ? 1500 : 200);
        if (['nationalityCode', 'issuingCountryCode', 'residenceCountryCode'].includes(key)) result[key] = countryCode(result[key]);
      }
      catch (error) { if (!source) throw error; }
    } else if (!source) fail('RAAD_FIELDS_INVALID');
  }
  return result;
}
function mergeFields(base, patch) {
  const next = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') { delete next[key]; continue; }
    if (key === 'health' || key === 'guardian') {
      next[key] = {...next[key]};
      for (const [name, fact] of Object.entries(value)) if (fact === null || fact === '') delete next[key][name]; else next[key][name] = fact;
      if (!Object.keys(next[key]).length) delete next[key];
    } else next[key] = value;
  }
  return next;
}
function fieldPaths(object, prefix) {
  return Object.keys(object).sort().flatMap(key => isObject(object[key]) ? fieldPaths(object[key], prefix + '.' + key) : [prefix + '.' + key]);
}
function sourceFields(person = {}) {
  const fields = mergeFields({}, cleanFields(person, {source: true}));
  // Issuing country is deliberately never used to establish nationality.
  const nationality = NATIONALITY_CODES[P.canonicalNationality(person.nationality)];
  if (!fields.nationalityCode && nationality) fields.nationalityCode = nationality;
  return fields;
}
function sourceProduct(person = {}) {
  const nationality = person.nationality || COUNTRY_BY_CODE[countryCode(person.nationalityCode)];
  return P.productFor({...person, nationality});
}
function dubaiDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(now));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function equivalentFact(field, first, second) {
  const normalized = value => {
    if (typeof value !== 'string') return value;
    let result = value.normalize('NFKC').trim();
    if (field.includes('Name')) return result.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[ .’'\-]+/g, ' ').trim();
    if (field === 'sex') return ({male: 'M', female: 'F', unspecified: 'X', m: 'M', f: 'F', x: 'X'})[result.toLowerCase()] || result;
    if (field === 'emiratesId') return result.replace(/[ -]/g, '');
    if (['nationalityCode', 'issuingCountryCode'].includes(field)) return countryCode(result);
    if (field === 'passportNumber') return result.toUpperCase();
    return result;
  };
  return hash(normalized(first)) === hash(normalized(second));
}
function documentFields(input) {
  if (!isObject(input) || Object.keys(input).some(field => !DOCUMENT_FACT_SET.has(field))) fail('RAAD_MACHINE_FIELDS_INVALID', 409);
  return cleanFields(input);
}
function imageHeader(bytes, mimeType) {
  return mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : mimeType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
function validPortraitBox(value) {
  return isObject(value) && ['x', 'y', 'width', 'height', 'confidence'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1) && value.width > 0 && value.height > 0 && value.x + value.width <= 1 && value.y + value.height <= 1 && value.confidence >= 0.98;
}

// Recompute from the protected intake and actual decrypted media on every use.
// This is document-consistency evidence, never a staff review or authenticity
// assertion. Caller authorization and client consent are separate gates.
function verifyMachineDossier({store, mediaStore, customer, applicantIndex, expectedCaseSignature, evidenceId, now = Date.now} = {}) {
  const notReady = code => ({ready: false, evidenceId: evidenceId || null, evidenceFingerprint: null, fields: {}, documents: {}, issues: [issue('documents', code, 'The current document evidence requires review.')], blockedReason: code});
  try {
    const at = typeof now === 'function' ? now() : now;
    if (!store?.data || typeof mediaStore?.read !== 'function' || !Number.isFinite(at) || !validCustomer(customer)) return notReady('RAAD_MACHINE_CONFIG_INVALID');
    const c = store.data.visaCases?.[customer];
    if (!c || !Number.isSafeInteger(c.applicantCount) || !Array.isArray(c.applicants) || c.applicants.length !== c.applicantCount || !Number.isSafeInteger(applicantIndex) || applicantIndex < 0 || applicantIndex >= c.applicantCount || !UUID.test(evidenceId || '')) return notReady('RAAD_MACHINE_EVIDENCE_INVALID');
    const signature = visaCaseSignature(c);
    if (expectedCaseSignature !== signature || !currentVisaEvidence(c).payment) return notReady('RAAD_MACHINE_CASE_STALE');
    const intake = store.data.visaDocumentIntake;
    const record = intake?.version === 1 && intake.cases?.[customer];
    if (!isObject(record) || record.caseId !== c.id || record.caseSignature !== signature || !['ready', 'needs_confirmation', 'needs_review'].includes(record.status) || !Number.isSafeInteger(record.generation) || record.generation < 1 || !Array.isArray(record.documents) || record.documents.length > 100 || !Array.isArray(record.applicants)) return notReady('RAAD_MACHINE_CASE_STALE');
    const applicant = record.applicants.find(item => item?.id === evidenceId && item.applicantIndex === applicantIndex);
    if (!applicant || !['ready', 'needs_confirmation'].includes(applicant.status) || record.applicants.filter(item => item?.applicantIndex === applicantIndex).length !== 1 || record.applicants.filter(item => item?.id === evidenceId).length !== 1 || !Array.isArray(applicant.sourceManifest) || !applicant.sourceManifest.length || applicant.sourceManifest.length > 30 || !Array.isArray(applicant.preparedManifest) || applicant.preparedManifest.length !== 3 || !isObject(applicant.documents) || Object.keys(applicant.documents).sort().join(',') !== 'passport,photo,residence') return notReady('RAAD_MACHINE_EVIDENCE_INVALID');
    const sources = new Map(), sourceSnapshots = [];
    const read = id => {
      const result = mediaStore.read(id, {customer}), metadata = result?.metadata, bytes = result?.bytes;
      if (!isObject(metadata) || metadata.customer !== customer || metadata.id !== id || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length !== metadata.size || metadata.expiresAt !== undefined && metadata.expiresAt !== null && metadata.expiresAt <= at) fail('RAAD_MACHINE_MEDIA_INVALID', 409);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const raw = store.data.visaMedia?.[id];
      const recordedDigests = raw ? [raw.checksum, raw.sha256].filter(value => value !== undefined) : [];
      if (!raw || raw.customer !== customer || !recordedDigests.length || recordedDigests.some(value => value !== sha256)) fail('RAAD_MACHINE_MEDIA_INVALID', 409);
      return {metadata, bytes, raw, sha256};
    };
    for (const manifest of applicant.sourceManifest) {
      if (!isObject(manifest) || !UUID.test(manifest.mediaId || '') || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || sources.has(manifest.mediaId)) return notReady('RAAD_MACHINE_SOURCE_INVALID');
      const observed = read(manifest.mediaId);
      if (observed.sha256 !== manifest.sha256 || ['raad_pdf_preview', 'raad_portal_upload', 'raad_application_copy'].includes(observed.raw.purpose)) return notReady('RAAD_MACHINE_SOURCE_INVALID');
      sources.set(manifest.mediaId, observed);
      sourceSnapshots.push({mediaId: manifest.mediaId, sha256: observed.sha256, expiresAt: observed.metadata.expiresAt ?? null});
    }
    for (const document of record.documents) {
      if (!isObject(document) || !UUID.test(document.mediaId || '') || !Number.isInteger(document.page) || document.page < 1 || document.page > 10 || !/^[a-f0-9]{64}$/.test(document.sha256 || '') || !/^[a-f0-9]{64}$/.test(document.sourceSha256 || '')) return notReady('RAAD_MACHINE_EXTRACTION_INVALID');
      if (sources.has(document.mediaId) && sources.get(document.mediaId).sha256 !== document.sourceSha256) return notReady('RAAD_MACHINE_SOURCE_INVALID');
    }
    const matched = reconcileDocumentEvidence({documents: record.documents, applicants: c.applicants, referenceDate: dubaiDate(at)}).applicants[applicantIndex];
    const clientFieldsRequired = matched?.clientFieldsRequired || [];
    const allowedClientGaps = new Set(['passportType', 'issueDate', 'birthPlace']);
    const identityReady = matched && (matched.status === 'ready' && !matched.issues.length || matched.status === 'needs_confirmation' && matched.identityReady === true && Array.isArray(clientFieldsRequired) && clientFieldsRequired.length > 0 && clientFieldsRequired.every(field => allowedClientGaps.has(field)) && matched.issues.every(item => item.code === 'DOCUMENT_FIELD_REQUIRED' && clientFieldsRequired.includes(item.field)));
    if (!identityReady || applicant.status !== matched.status || matched.evidence.passportMrzChecked !== true || matched.evidence.matchedResidence !== true || hash(applicant.clientFieldsRequired || []) !== hash(clientFieldsRequired)) return notReady('RAAD_MACHINE_MATCH_REVIEW_REQUIRED');
    const fields = documentFields(matched.fields);
    if (hash(documentFields(applicant.fields)) !== hash(fields) || hash(applicant.evidence) !== hash(matched.evidence)) return notReady('RAAD_MACHINE_MATCH_CHANGED');
    const extractionDigest = hash({documents: record.documents, applicantIndex, fields: matched.fields, matchedDocuments: matched.documents, evidence: matched.evidence});
    if (applicant.extractionDigest !== extractionDigest) return notReady('RAAD_MACHINE_EXTRACTION_CHANGED');
    const matchedRefs = [matched.documents.passport, ...matched.documents.residence, ...(matched.documents.photo ? [matched.documents.photo] : [])];
    if (matchedRefs.some(ref => !sources.has(ref.mediaId) || !record.documents.some(document => document.mediaId === ref.mediaId && document.page === ref.page && document.sha256 === ref.sha256))) return notReady('RAAD_MACHINE_SOURCE_INVALID');
    const byRef = ref => record.documents.find(document => document.mediaId === ref.mediaId && document.page === ref.page && document.sha256 === ref.sha256);
    const cropRefs = [matched.documents.passport, ...matched.documents.residence].filter(ref => validPortraitBox(byRef(ref)?.extraction?.portraitBox));
    const roleSources = {
      passport: new Set([matched.documents.passport.mediaId]),
      residence: new Set(matched.documents.residence.map(ref => ref.mediaId)),
      photo: new Set((matched.documents.photo ? [matched.documents.photo] : cropRefs).map(ref => ref.mediaId))
    };
    if (!roleSources.photo.size) return notReady('RAAD_MACHINE_PHOTO_REVIEW_REQUIRED');
    const documents = {}, preparedSnapshots = [], usedIds = new Set(), usedDigests = new Set();
    for (const manifest of applicant.preparedManifest) {
      const kind = manifest?.kind;
      if (!DOCUMENT_KINDS.includes(kind) || documents[kind] || !UUID.test(manifest.mediaId || '') || manifest.mediaId !== applicant.documents[kind] || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || usedIds.has(manifest.mediaId)) return notReady('RAAD_MACHINE_PREPARED_INVALID');
      const observed = read(manifest.mediaId), sourceIds = observed.raw.sourceIds;
      if (observed.sha256 !== manifest.sha256 || observed.raw.purpose !== 'raad_portal_upload' || observed.raw.kind !== kind || !['image/jpeg', 'image/png'].includes(observed.metadata.mimeType) || observed.bytes.length > 1000000 || !imageHeader(observed.bytes, observed.metadata.mimeType) || !Array.isArray(sourceIds) || !sourceIds.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !sources.has(id) || !roleSources[kind].has(id)) || (kind !== 'photo' && [...roleSources[kind]].some(id => !sourceIds.includes(id))) || usedDigests.has(observed.sha256)) return notReady('RAAD_MACHINE_PREPARED_INVALID');
      if (record.applicants.some(other => other.id !== applicant.id && Array.isArray(other.preparedManifest) && other.preparedManifest.some(entry => entry?.mediaId === manifest.mediaId || entry?.sha256 === observed.sha256))) return notReady('RAAD_MACHINE_DOCUMENT_REUSED');
      usedIds.add(manifest.mediaId); usedDigests.add(observed.sha256);
      documents[kind] = {mediaId: manifest.mediaId, sha256: observed.sha256, mimeType: observed.metadata.mimeType, size: observed.bytes.length, expiresAt: observed.metadata.expiresAt ?? null};
      preparedSnapshots.push({kind, ...documents[kind], sourceIds: [...sourceIds].sort()});
    }
    const evidenceFingerprint = hash({version: 1, matcherVersion: 1, customer, caseId: c.id, caseSignature: signature, applicantIndex, evidenceId, generation: record.generation, extractionDigest, fields, clientFieldsRequired, sources: sourceSnapshots.sort((a, b) => a.mediaId.localeCompare(b.mediaId)), prepared: preparedSnapshots.sort((a, b) => a.kind.localeCompare(b.kind))});
    return {ready: true, evidenceId, evidenceFingerprint, caseId: c.id, caseSignature: signature, applicantIndex, generation: record.generation, fields, clientFieldsRequired: clone(clientFieldsRequired), documents, extractionDigest, issues: [], blockedReason: null};
  } catch { return notReady('RAAD_MACHINE_EVIDENCE_INVALID'); }
}

class RaadVisaWorkflow {
  constructor({store, mediaStore, now = Date.now, env = {}, privateConfig = {}, canAutomate = () => false} = {}) {
    if (!store?.data || typeof store.save !== 'function') fail('RAAD_STORE_REQUIRED', 500);
    if (typeof mediaStore?.get !== 'function') fail('RAAD_MEDIA_STORE_REQUIRED', 500);
    Object.assign(this, {store, mediaStore, now, env, privateConfig, canAutomate});
  }

  portalStatus() { return {connected: false, mode: 'preparation', reason: 'PORTAL_NOT_CONNECTED'}; }

  hotelSuggestion() {
    const value = this.env.RAAD_SAUDI_HOTEL_SUGGESTION ?? this.privateConfig.raad?.hotelSuggestion;
    return typeof value === 'string' && value.trim() && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : 'Hilton Al Riyadh';
  }

  context(customer, applicantIndex) {
    if (!validCustomer(customer)) fail('INVALID_CUSTOMER');
    const c = Object.hasOwn(this.store.data.visaCases || {}, customer) ? this.store.data.visaCases[customer] : null;
    if (!c) fail('VISA_CASE_NOT_FOUND', 404);
    if (!Number.isInteger(applicantIndex) || !Number.isInteger(c.applicantCount) || applicantIndex < 0 || applicantIndex >= c.applicantCount) fail('RAAD_APPLICANT_INDEX_INVALID');
    const person = c.applicants?.[applicantIndex] || {};
    const caseSignature = visaCaseSignature(c), evidence = currentVisaEvidence(c);
    const complaint = (this.store.data.complaints || []).find(record => record.customer === customer && ['pending', 'claimed'].includes(record.state));
    const complaintPending = this.store.data.conversationJournal?.customers?.[customer]?.complaintPending;
    const pendingAmendment = c.pendingAmendment && !['applied', 'rejected', 'cancelled', 'resolved'].includes(c.pendingAmendment.state);
    let blockedReason = null;
    if (c.submissionStatus === 'submitted' || c.stage === 'submitted' || c.staffVerification?.decision) blockedReason = 'RAAD_CASE_ALREADY_PROCESSED';
    else if (pendingAmendment) blockedReason = 'RAAD_CASE_AMENDMENT_PENDING';
    else if (complaint || complaintPending || c.stage === 'complaint_pending') blockedReason = 'RAAD_COMPLAINT_ACTIVE';
    const product = sourceProduct(person);
    if (!blockedReason && !['tourist_single', 'tourist_multi'].includes(product.code)) blockedReason = 'RAAD_TOURIST_CASE_REQUIRED';
    const parentSignature = hash({caseSignature, paymentStatus: c.paymentStatus, submissionStatus: c.submissionStatus, verification: c.staffVerification || {}, pendingAmendment: c.pendingAmendment || null, complaint: complaint ? {id: complaint.id, state: complaint.state} : complaintPending || null});
    return {customer, applicantIndex, c, person, caseSignature, parentSignature, evidence, product, blockedReason};
  }

  defaults(context, referenceDate) {
    const result = {mission: 'Abu Dhabi', residenceCountryCode: 'ARE', proposedEntryDate: proposedEntryDate(referenceDate), transport: 'air', arrivalPort: 'مطار الملك خالد الدولي'};
    if (['tourist_single', 'tourist_multi'].includes(context.product.code)) {
      const egyptian = sourceFields(context.person).nationalityCode === 'EGY';
      Object.assign(result, {visitPurpose: 'tourism', entries: egyptian ? 'single' : 'multiple', visaValidityDays: egyptian ? 90 : 365});
    }
    for (const [field, variable] of Object.entries(CONTACT_ENV)) {
      const value = this.env[variable] ?? this.privateConfig.raad?.contacts?.[field] ?? this.privateConfig.raad?.[field] ?? this.privateConfig[field];
      if (typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value)) result[field] = value.trim();
    }
    return result;
  }

  job(context) {
    const container = Object.hasOwn(this.store.data.raadApplications || {}, context.customer) ? this.store.data.raadApplications[context.customer] : null;
    return container?.applicants?.[context.applicantIndex] || null;
  }

  assertRevision(job, revision) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || revision !== (job?.revision || 0)) fail('RAAD_REVISION_CONFLICT', 409);
  }

  observeDocument(id, context) {
    try {
      const metadata = this.mediaStore.get(id, {customer: context.customer});
      if (!isObject(metadata) || metadata.customer !== context.customer || metadata.id !== id) return null;
      const record = this.store.data.visaMedia?.[id];
      const digest = metadata.sha256 || metadata.checksum || metadata.hash || (record?.customer === context.customer ? record.checksum || record.sha256 || record.hash : null);
      const snapshot = {mediaId: id, mimeType: metadata.mimeType, size: metadata.size, status: metadata.status || null, receivedAt: metadata.receivedAt ?? null, expiresAt: metadata.expiresAt ?? null};
      const details = {};
      for (const name of ['purpose', 'sourceIds', 'needsVisualReview', 'width', 'height']) if (metadata[name] !== undefined || record?.[name] !== undefined) details[name] = metadata[name] ?? record[name];
      if (details.purpose === 'raad_pdf_preview') snapshot.purpose = 'raad_pdf_preview';
      return {...snapshot, fingerprint: hash({...snapshot, digest, details})};
    } catch { return null; }
  }

  documentIssues(documents, context) {
    const issues = [], current = {}, ids = new Set();
    for (const kind of DOCUMENT_KINDS) {
      const saved = documents[kind], field = 'documents.' + kind;
      if (!saved?.mediaId) { issues.push(issue(field, 'REQUIRED', 'Select the applicant’s document from this case.')); continue; }
      const metadata = this.observeDocument(saved.mediaId, context);
      if (!metadata || metadata.expiresAt !== null && metadata.expiresAt <= this.now()) { issues.push(issue(field, 'DOCUMENT_UNAVAILABLE', 'The selected document is unavailable.')); continue; }
      current[kind] = metadata;
      if (metadata.purpose === 'raad_pdf_preview') issues.push(issue(field, 'DOCUMENT_PREVIEW_ONLY', 'A neutral preview cannot be used as an application document. Prepare and review the appropriate document first.'));
      if (ids.has(metadata.mediaId)) issues.push(issue(field, 'DOCUMENT_REUSED', 'Select a separate document for each document type.'));
      ids.add(metadata.mediaId);
      if (!['image/jpeg', 'image/png'].includes(metadata.mimeType)) issues.push(issue(field, 'DOCUMENT_FORMAT_INVALID', 'Portal preparation accepts JPEG or PNG documents.'));
      if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > 1000000) issues.push(issue(field, 'DOCUMENT_SIZE_INVALID', 'Each prepared document must be at most 1,000,000 bytes.'));
    }
    return {issues, current};
  }

  assess(context, job) {
    const referenceDate = dubaiDate(this.now()), fields = job.fields || {}, storedDefaults = job.defaults || this.defaults(context, referenceDate);
    // Recalculate only the office estimate as the Dubai date changes; never
    // replace an applicant's explicitly supplied entry date. At this stage no
    // request is submitted, so this is still a preview-time estimate.
    const defaults = Object.hasOwn(fields, 'entryDate') ? storedDefaults : {...storedDefaults, proposedEntryDate: proposedEntryDate(referenceDate)};
    const validation = validateApplicant(fields, {referenceDate});
    const issues = [...validation.issues];
    const source = sourceFields(context.person);
    for (const [field, expected] of Object.entries(source)) {
      if (Object.hasOwn(fields, field) && hash(fields[field]) !== hash(expected)) issues.push(issue(field, 'CASE_FACT_MISMATCH', 'This value differs from the original applicant record; resolve the case facts before review.'));
    }
    if (context.blockedReason) issues.push(issue('case', context.blockedReason, 'The original case must be resolved before preparing this tourist application.'));
    if (fields.gccResident === false) issues.push(issue('gccResident', 'GCC_RESIDENCE_REQUIRED', 'This draft route requires confirmed current GCC residence.'));
    if (fields.visitPurpose !== undefined && fields.visitPurpose !== 'tourism') issues.push(issue('visitPurpose', 'TOURIST_ONLY', 'This workflow prepares tourist drafts only.'));
    for (const key of ['entries', 'visaValidityDays']) if (Object.hasOwn(fields, key) && fields[key] !== defaults[key]) issues.push(issue(key, 'OFFICE_POLICY_MISMATCH', 'This differs from the tentative office policy and needs portal review.'));
    const contact = {...defaults, ...fields};
    for (const field of CONTACT_FIELDS) {
      if (!contact[field]) issues.push(issue(field, 'REQUIRED', 'Configure or enter this application contact value.'));
      else if (field === 'contactEmail' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact[field]) : field.endsWith('Phone') ? !/^\+?[0-9 ()-]{7,25}$/.test(contact[field]) : !/^[\p{L}\p{N} -]{1,20}$/u.test(contact[field])) issues.push(issue(field, 'CONTACT_INVALID', 'Verify this application contact value.'));
    }
    const documents = this.documentIssues(job.documents || {}, context);
    issues.push(...documents.issues);
    if (!context.evidence.payment) issues.push(issue('evidence.payment', 'PAYMENT_NOT_VERIFIED', 'Current payment evidence must be verified on the original case.'));
    if (!context.evidence.documents) issues.push(issue('evidence.documents', 'DOCUMENTS_NOT_REVIEWED', 'Staff must review the current documents on the original case.'));
    const suggested = Object.fromEntries(Object.entries(defaults).filter(([key]) => !Object.hasOwn(fields, key)));
    const requiredFields = [...fieldPaths(fields, 'fields'), ...fieldPaths(suggested, 'defaults'), ...DOCUMENT_KINDS.filter(kind => job.documents?.[kind]?.mediaId).map(kind => 'documents.' + kind)].sort();
    const documentSignature = hash(documents.current);
    const fingerprint = hash({caseId: context.c.id, caseSignature: context.caseSignature, parentSignature: context.parentSignature, fields, defaults, documents: documents.current});
    const stale = job.caseId !== context.c.id || job.caseSignature !== context.caseSignature || job.parentSignature !== context.parentSignature || DOCUMENT_KINDS.some(kind => job.documents?.[kind] && job.documents[kind].fingerprint !== documents.current[kind]?.fingerprint);
    const review = job.review || {};
    const confirmed = Array.isArray(review.confirmedFields) ? review.confirmedFields : [];
    const exact = confirmed.length === requiredFields.length && requiredFields.every((field, index) => confirmed[index] === field);
    const complete = !stale && review.fingerprint === fingerprint && exact;
    const missing = issues.filter(item => {
      if (item.field === 'case') return false;
      if (['REQUIRED', 'PAYMENT_NOT_VERIFIED', 'DOCUMENTS_NOT_REVIEWED', 'DOCUMENT_UNAVAILABLE', 'explicit_boolean_required'].includes(item.code)) return true;
      const value = item.field.split('.').reduce((value, key) => value?.[key], fields);
      return value === undefined || value === null || value === '';
    }).map(item => item.field);
    return {referenceDate, defaults, issues, missing: [...new Set(missing)].sort(), requiredFields, documentSignature, fingerprint, stale, complete, age: validation.age, isMinor: validation.isMinor};
  }

  summary(context, job, assessment = this.assess(context, job)) {
    const review = job.review || {};
    const state = assessment.stale ? 'stale' : assessment.issues.length ? 'needs_information' : assessment.complete ? 'ready_for_portal_review' : 'draft';
    return clone({applicantIndex: context.applicantIndex, jobId: job.jobId, revision: job.revision, state, fields: job.fields, defaults: assessment.defaults, officeHotelSuggestion: this.hotelSuggestion(), defaultStatus: 'suggestions_pending_portal_review', issues: assessment.issues, missing: assessment.missing, reviewRequiredFields: assessment.requiredFields, review: {scope: 'staff_data_review', confirmedFields: assessment.stale ? [] : review.confirmedFields || [], requiredFields: assessment.requiredFields, complete: assessment.complete, invalidated: assessment.stale, reviewedAt: assessment.complete ? review.reviewedAt : null}, portal: this.portalStatus(), caseId: job.caseId, caseSignature: job.caseSignature, documents: job.documents, age: assessment.age ?? null, isMinor: assessment.isMinor ?? null, ...(context.blockedReason ? {blockedReason: context.blockedReason} : {})});
  }

  get(customer, {applicantIndex = 0} = {}) {
    const context = this.context(customer, applicantIndex), job = this.job(context);
    if (!job) return clone({applicantIndex, jobId: null, revision: 0, state: 'not_started', fields: {}, defaults: this.defaults(context, dubaiDate(this.now())), officeHotelSuggestion: this.hotelSuggestion(), defaultStatus: 'suggestions_pending_portal_review', documents: {}, missing: [], issues: [], reviewRequiredFields: [], review: {scope: 'staff_data_review', confirmedFields: [], requiredFields: [], complete: false, invalidated: false, reviewedAt: null}, portal: this.portalStatus(), caseId: context.c.id, caseSignature: context.caseSignature, ...(context.blockedReason ? {blockedReason: context.blockedReason} : {})});
    return this.summary(context, job);
  }

  machineAllowed(customer) {
    try { return typeof this.canAutomate === 'function' && this.canAutomate(customer) === true; }
    catch { return false; }
  }

  executionOwnershipBlock(customer) {
    const journal = this.store.data.conversationJournal?.customers?.[customer];
    if (journal?.blocked || journal?.whatsappBlocked || ['pending', 'uncertain'].includes(journal?.whatsappBlockState)) return 'RAAD_CUSTOMER_BLOCKED';
    if (journal?.operatorOwned || this.store.data.customers?.[customer]?.humanOwned || this.store.data.conversations?.[customer]?.humanOwned) return 'RAAD_HUMAN_OWNERSHIP';
    return null;
  }

  applyMachineDossier(customer, {applicantIndex = 0, expectedRevision, expectedCaseSignature, evidenceId} = {}) {
    const context = this.context(customer, applicantIndex), previous = this.job(context);
    this.assertRevision(previous, expectedRevision);
    const ownershipBlock = this.executionOwnershipBlock(customer);
    if (ownershipBlock) fail(ownershipBlock, 409);
    if (!this.machineAllowed(customer)) fail('RAAD_MACHINE_AUTOMATION_PAUSED', 409);
    if (context.blockedReason) fail(context.blockedReason, 409);
    if (expectedCaseSignature !== context.caseSignature) fail('RAAD_CASE_SIGNATURE_CONFLICT', 409);
    if (previous && (!previous.machineReview || previous.review?.reviewedAt || previous.review?.confirmedFields?.length || previous.machineReview.draftFingerprint !== hash({fields: previous.fields, documents: previous.documents}))) fail('RAAD_MANUAL_DRAFT_PROTECTED', 409);
    const dossier = verifyMachineDossier({store: this.store, mediaStore: this.mediaStore, customer, applicantIndex, expectedCaseSignature, evidenceId, now: this.now});
    if (!dossier.ready) fail(dossier.blockedReason || 'RAAD_MACHINE_REVIEW_REQUIRED', 409);
    for (const [field, value] of Object.entries(sourceFields(context.person))) if (DOCUMENT_FACT_SET.has(field) && Object.hasOwn(dossier.fields, field) && !equivalentFact(field, value, dossier.fields[field])) fail('RAAD_MACHINE_SOURCE_CONFLICT', 409);
    if (previous?.machineReview?.evidenceFingerprint === dossier.evidenceFingerprint) return clone({...this.summary(context, previous), ok: true, duplicate: true, evidenceId, evidenceFingerprint: dossier.evidenceFingerprint, machineReview: previous.machineReview});
    const documents = Object.fromEntries(DOCUMENT_KINDS.map(kind => [kind, this.observeDocument(dossier.documents[kind].mediaId, context)]));
    if (Object.values(documents).some(value => !value)) fail('RAAD_MACHINE_DOCUMENT_UNAVAILABLE', 409);
    const fields = clone(dossier.fields);
    const machineReview = {scope: 'machine_document_consistency', version: 1, evidenceId, evidenceFingerprint: dossier.evidenceFingerprint, extractionDigest: dossier.extractionDigest, verifiedAt: this.now(), draftFingerprint: hash({fields, documents}), authenticityVerified: false};
    const job = {jobId: previous?.jobId || randomUUID(), caseId: context.c.id, applicantIndex, revision: (previous?.revision || 0) + 1, caseSignature: context.caseSignature, parentSignature: context.parentSignature, sourceFields: sourceFields(context.person), fields, defaults: this.defaults(context, dubaiDate(this.now())), documents, machineReview, review: {scope: 'staff_data_review', confirmedFields: []}, createdAt: previous?.createdAt || this.now(), updatedAt: this.now()};
    this.persist(context, job);
    return clone({...this.summary(context, job), ok: true, duplicate: false, evidenceId, evidenceFingerprint: dossier.evidenceFingerprint, machineReview});
  }

  portalDossier(customer, {applicantIndex = 0, clientProof} = {}) {
    const context = this.context(customer, applicantIndex), job = this.job(context), issues = [];
    const source = job?.machineReview ? 'machine' : 'staff';
    const add = (field, code, message) => issues.push(issue(field, code, message));
    const ownershipBlock = this.executionOwnershipBlock(customer);
    if (ownershipBlock) add('case', ownershipBlock, 'Automatic execution is paused for this conversation.');
    if (!job) add('draft', 'RAAD_APPLICATION_NOT_PREPARED', 'Prepare a current applicant draft first.');
    if (context.blockedReason) add('case', context.blockedReason, 'The case is paused or unavailable for this route.');
    if (!context.evidence.payment) add('evidence.payment', 'PAYMENT_NOT_VERIFIED', 'Current payment evidence is required.');
    let dossier = null;
    if (source === 'machine') {
      if (!this.machineAllowed(customer)) add('case', 'RAAD_MACHINE_AUTOMATION_PAUSED', 'Automatic preparation is paused.');
      dossier = verifyMachineDossier({store: this.store, mediaStore: this.mediaStore, customer, applicantIndex, expectedCaseSignature: context.caseSignature, evidenceId: job.machineReview.evidenceId, now: this.now});
      if (!dossier.ready || dossier.evidenceFingerprint !== job.machineReview.evidenceFingerprint || job.machineReview.draftFingerprint !== hash({fields: job.fields, documents: job.documents})) add('documents', 'RAAD_MACHINE_EVIDENCE_STALE', 'Document evidence has changed and must be checked again.');
    } else if (job) {
      const assessment = this.assess(context, job);
      if (!assessment.complete || assessment.stale) add('review', 'RAAD_STAFF_REVIEW_REQUIRED', 'The current staff draft requires review.');
      if (!context.evidence.documents) add('evidence.documents', 'DOCUMENTS_NOT_REVIEWED', 'Current staff document review is required.');
    }
    const defaults = this.defaults(context, dubaiDate(this.now()));
    let answers = {};
    const live = isObject(clientProof) ? this.store.data.visaFulfilment?.jobs?.[clientProof.jobId] : null;
    const confirmation = clientProof?.confirmation;
    const finance = this.store.data.visaFulfilment?.cases?.[customer], approval = finance?.approvals?.[finance.activeApprovalId];
    if (!live || !approval || live.approvalId !== approval.id || approval.state !== 'approved' || approval.caseId !== context.c.id || approval.caseSignature !== context.caseSignature || approval.paymentFingerprint !== createHash('sha256').update(JSON.stringify(context.c.staffVerification?.payment || null)).digest('hex')) add('evidence.payment', 'ACCOUNTANT_APPROVAL_REQUIRED', 'A current accountant approval for this exact payment is required.');
    let consent = Boolean(live && clientProof.complete === true && clientProof.customer === customer && clientProof.caseId === context.c.id && clientProof.caseSignature === context.caseSignature && clientProof.applicantIndex === applicantIndex && clientProof.jobRevision === live.revision && live.customer === customer && live.caseId === context.c.id && live.caseSignature === context.caseSignature && live.applicantIndex === applicantIndex && ['ready', 'running', 'waiting_otp'].includes(live.state) && hash(clientProof.fields) === hash(live.confirmedFields) && hash(confirmation) === hash(live.answerConfirmation) && confirmation?.granted === true && confirmation.scope === 'saudi_visa_application' && confirmation.sender === customer && confirmation.caseSignature === context.caseSignature && typeof confirmation.messageId === 'string' && confirmation.messageId.length > 0 && confirmation.messageId.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(confirmation.messageId));
    try {
      if (!isObject(clientProof?.fields) || requiredQuestions(clientProof.fields).length) consent = false;
      else answers = cleanFields(clientProof.fields);
    } catch { consent = false; }
    if (clientProof?.documentEvidence) {
      if (!live?.documentFacts || clientProof.documentEvidence.id !== live.documentFacts.evidenceId || clientProof.documentEvidence.evidenceFingerprint !== live.documentFacts.evidenceFingerprint) consent = false;
    }
    if (source === 'machine' && (!dossier?.ready || clientProof?.documentEvidence?.id !== dossier.evidenceId || clientProof?.documentEvidence?.evidenceFingerprint !== dossier.evidenceFingerprint || confirmation?.documentEvidence?.id !== dossier.evidenceId || confirmation?.documentEvidence?.evidenceFingerprint !== dossier.evidenceFingerprint)) consent = false;
    if (dossier?.ready && requiredQuestions(answers, {requestedFields: dossier.clientFieldsRequired}).length) add('consent', 'RAAD_CLIENT_DOCUMENT_FACTS_REQUIRED', 'Missing document facts require the applicant’s explicit answer.');
    if (!consent) add('consent', 'RAAD_CLIENT_CONSENT_REQUIRED', 'A current explicit applicant confirmation and authorization is required.');
    let fields = mergeFields({...defaults}, job?.fields || {});
    fields = mergeFields(fields, answers);
    if (!Object.hasOwn(fields, 'entryDate')) fields.entryDate = defaults.proposedEntryDate;
    delete fields.proposedEntryDate;
    for (const [field, expected] of Object.entries(sourceFields(context.person))) if (DOCUMENT_FACT_SET.has(field) && Object.hasOwn(fields, field) && !equivalentFact(field, expected, fields[field])) add(field, 'CASE_FACT_MISMATCH', 'This document fact differs from the paid applicant record.');
    for (const [field, expected] of Object.entries(job?.fields || {})) if (DOCUMENT_FACT_SET.has(field) && Object.hasOwn(answers, field) && !equivalentFact(field, expected, answers[field])) add(field, 'DOCUMENT_DATA_CONFLICT', 'The client answer differs from the verified document fact.');
    const validation = validateApplicant(fields, {referenceDate: dubaiDate(this.now())});
    issues.push(...validation.issues);
    if (fields.gccResident !== true) add('gccResident', 'GCC_RESIDENCE_REQUIRED', 'Confirmed current GCC residence is required.');
    if (fields.visitPurpose !== 'tourism') add('visitPurpose', 'TOURIST_ONLY', 'This route supports tourism only.');
    for (const field of ['entries', 'visaValidityDays']) if (fields[field] !== defaults[field]) add(field, 'OFFICE_POLICY_MISMATCH', 'The visa product must match the paid case policy.');
    for (const field of CONTACT_FIELDS) {
      const value = fields[field];
      if (!value) add(field, 'REQUIRED', 'A configured application contact is required.');
      else if (typeof value !== 'string' || (field === 'contactEmail' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : field.endsWith('Phone') ? !/^\+?[0-9 ()-]{7,25}$/.test(value) : !/^[\p{L}\p{N} -]{1,20}$/u.test(value))) add(field, 'CONTACT_INVALID', 'Verify this application contact value.');
    }
    const observed = this.documentIssues(job?.documents || {}, context);
    issues.push(...observed.issues);
    // Staff paths retain their existing review contract; actual bytes are still
    // rechecked so an execution fingerprint never authorizes another image.
    const documents = {};
    for (const kind of DOCUMENT_KINDS) if (observed.current[kind]) {
      try {
        const {metadata, bytes} = this.mediaStore.read(observed.current[kind].mediaId, {customer});
        if (metadata?.customer !== customer || metadata.id !== observed.current[kind].mediaId || !Buffer.isBuffer(bytes) || !imageHeader(bytes, metadata.mimeType) || bytes.length > 1000000 || bytes.length !== metadata.size) throw Error();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (source === 'machine' && sha256 !== dossier?.documents?.[kind]?.sha256) throw Error();
        documents[kind] = {...observed.current[kind], sha256};
      } catch { add('documents.' + kind, 'DOCUMENT_CONTENT_UNAVAILABLE', 'The current prepared image could not be verified.'); }
    }
    const uniqueIssues = issues.filter((value, index) => issues.findIndex(other => other.field === value.field && other.code === value.code) === index);
    const ready = uniqueIssues.length === 0;
    const fingerprint = ready ? hash({version: 1, source, customer, caseId: context.c.id, caseSignature: context.caseSignature, applicantIndex, draftId: job.jobId, draftRevision: job.revision, machineEvidence: dossier?.evidenceFingerprint || null, staffReview: source === 'staff' ? job.review : null, fields, defaults, documents, payment: context.c.staffVerification.payment, clientProof}) : null;
    return clone({ready, source, fingerprint, fields, defaults, documents, issues: uniqueIssues, blockedReason: uniqueIssues[0]?.code || null, caseId: context.c.id, caseSignature: context.caseSignature, applicantIndex, ...(dossier?.ready ? {evidenceId: dossier.evidenceId, evidenceFingerprint: dossier.evidenceFingerprint} : {})});
  }

  persist(context, job) {
    const old = this.store.data.raadApplications;
    const oldCustomer = old?.[context.customer];
    this.store.data.raadApplications = {...old, [context.customer]: {caseId: context.c.id, applicants: {...oldCustomer?.applicants, [context.applicantIndex]: job}}};
    try { this.store.save(); }
    catch (error) { if (old === undefined) delete this.store.data.raadApplications; else this.store.data.raadApplications = old; throw error; }
  }

  prepare(customer, {applicantIndex = 0, expectedRevision, fields = {}, documents = {}, confirm = false} = {}) {
    const context = this.context(customer, applicantIndex), previous = this.job(context);
    this.assertRevision(previous, expectedRevision);
    if (context.blockedReason) fail(context.blockedReason, 409);
    if (typeof confirm !== 'boolean') fail('RAAD_CONFIRMATION_INVALID');
    const patch = cleanFields(fields);
    if (!isObject(documents) || Object.keys(documents).some(kind => !DOCUMENT_KINDS.includes(kind))) fail('RAAD_DOCUMENTS_INVALID');
    const sameCase = previous?.caseId === context.c.id;
    const source = sourceFields(context.person), original = sameCase ? clone(previous.fields) : source;
    // Refresh facts that came directly from the case; staff-entered values remain
    // visible and a mismatch with the current case blocks review.
    if (sameCase) for (const [key, value] of Object.entries(source)) if (!Object.hasOwn(original, key) || previous.sourceFields && hash(original[key]) === hash(previous.sourceFields[key])) original[key] = value;
    const nextDocuments = sameCase ? clone(previous.documents || {}) : {};
    for (const [kind, id] of Object.entries(documents)) {
      if (id === null || id === '') { delete nextDocuments[kind]; continue; }
      if (typeof id !== 'string' || !UUID.test(id)) fail('RAAD_DOCUMENTS_INVALID');
      const metadata = this.observeDocument(id, context);
      if (!metadata) fail('RAAD_DOCUMENT_UNAVAILABLE', 404);
      if (metadata.purpose === 'raad_pdf_preview') fail('RAAD_DOCUMENT_PREVIEW_ONLY', 422);
      nextDocuments[kind] = metadata;
    }
    // Re-observe existing attachments, including their content digest, on rebase.
    for (const kind of DOCUMENT_KINDS) if (nextDocuments[kind]) nextDocuments[kind] = this.observeDocument(nextDocuments[kind].mediaId, context) || nextDocuments[kind];
    const job = {jobId: sameCase ? previous.jobId : randomUUID(), caseId: context.c.id, applicantIndex, revision: (previous?.revision || 0) + (confirm ? 1 : 0), caseSignature: context.caseSignature, parentSignature: context.parentSignature, sourceFields: source, fields: mergeFields(original, patch), defaults: this.defaults(context, dubaiDate(this.now())), documents: nextDocuments, review: {scope: 'staff_data_review', confirmedFields: []}, createdAt: sameCase ? previous.createdAt : this.now(), updatedAt: this.now()};
    const summary = this.summary(context, job);
    if (confirm) this.persist(context, job);
    return {...summary, ...(!confirm ? {confirmationRequired: true} : {})};
  }

  review(customer, {applicantIndex = 0, expectedRevision, confirmedFields = [], confirm = false} = {}) {
    const context = this.context(customer, applicantIndex), previous = this.job(context);
    this.assertRevision(previous, expectedRevision);
    if (context.blockedReason) fail(context.blockedReason, 409);
    if (!previous) fail('RAAD_APPLICATION_NOT_PREPARED', 409);
    if (typeof confirm !== 'boolean') fail('RAAD_CONFIRMATION_INVALID');
    const assessment = this.assess(context, previous);
    if (assessment.stale) fail('RAAD_APPLICATION_STALE', 409);
    if (!Array.isArray(confirmedFields) || confirmedFields.some(field => typeof field !== 'string') || new Set(confirmedFields).size !== confirmedFields.length) fail('RAAD_REVIEW_FIELDS_INVALID');
    const confirmed = [...confirmedFields].sort();
    if (confirmed.length !== assessment.requiredFields.length || !assessment.requiredFields.every((field, index) => confirmed[index] === field)) fail('RAAD_REVIEW_FIELDS_MISMATCH', 409);
    const job = {...clone(previous), revision: previous.revision + (confirm ? 1 : 0), updatedAt: this.now(), review: {scope: 'staff_data_review', confirmedFields: confirmed, fingerprint: assessment.fingerprint, documentSignature: assessment.documentSignature, caseSignature: context.caseSignature, reviewedAt: this.now(), preparedRevision: previous.revision}};
    const summary = this.summary(context, job);
    if (confirm) this.persist(context, job);
    return {...summary, ...(!confirm ? {confirmationRequired: true} : {})};
  }
}

module.exports = {RaadVisaWorkflow, verifyMachineDossier, DOCUMENT_FACT_FIELDS, FIELD_ALLOWLIST, DOCUMENT_KINDS, HEALTH_FIELDS, CONTACT_FIELDS};
