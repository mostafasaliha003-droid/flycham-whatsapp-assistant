'use strict';

const {createHash, randomUUID} = require('node:crypto');
const P = require('./saudi-visa-policy');
const {validCustomer} = require('./conversation-journal');
const {visaCaseSignature, currentVisaEvidence} = require('./visa-case-signature');
const {validateApplicant, proposedEntryDate} = require('./raad-document-validation');

// This module prepares protected local drafts. It has no portal client, payment
// client, session credentials, submission action, or legal-consent action.
const FIELD_ALLOWLIST = Object.freeze([
  'nationalityCode', 'passportNumber', 'passportType', 'issuingCountryCode',
  'issueDate', 'expiryDate', 'birthDate', 'birthPlace', 'sex',
  'latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName',
  'arabicFirstName', 'arabicFamilyName', 'emiratesId', 'residenceExpiry',
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

class RaadVisaWorkflow {
  constructor({store, mediaStore, now = Date.now, env = {}, privateConfig = {}} = {}) {
    if (!store?.data || typeof store.save !== 'function') fail('RAAD_STORE_REQUIRED', 500);
    if (typeof mediaStore?.get !== 'function') fail('RAAD_MEDIA_STORE_REQUIRED', 500);
    Object.assign(this, {store, mediaStore, now, env, privateConfig});
  }

  portalStatus() { return {connected: false, mode: 'preparation', reason: 'PORTAL_NOT_CONNECTED'}; }

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
      if (ids.has(metadata.mediaId)) issues.push(issue(field, 'DOCUMENT_REUSED', 'Select a separate document for each document type.'));
      ids.add(metadata.mediaId);
      if (!['image/jpeg', 'image/png'].includes(metadata.mimeType)) issues.push(issue(field, 'DOCUMENT_FORMAT_INVALID', 'Portal preparation accepts JPEG or PNG documents.'));
      if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > 1000000) issues.push(issue(field, 'DOCUMENT_SIZE_INVALID', 'Each prepared document must be at most 1,000,000 bytes.'));
    }
    return {issues, current};
  }

  assess(context, job) {
    const referenceDate = dubaiDate(this.now()), fields = job.fields || {}, defaults = job.defaults || this.defaults(context, referenceDate);
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
    return clone({applicantIndex: context.applicantIndex, jobId: job.jobId, revision: job.revision, state, fields: job.fields, defaults: assessment.defaults, defaultStatus: 'suggestions_pending_portal_review', issues: assessment.issues, missing: assessment.missing, reviewRequiredFields: assessment.requiredFields, review: {scope: 'staff_data_review', confirmedFields: assessment.stale ? [] : review.confirmedFields || [], requiredFields: assessment.requiredFields, complete: assessment.complete, invalidated: assessment.stale, reviewedAt: assessment.complete ? review.reviewedAt : null}, portal: this.portalStatus(), caseId: job.caseId, caseSignature: job.caseSignature, documents: job.documents, age: assessment.age ?? null, isMinor: assessment.isMinor ?? null, ...(context.blockedReason ? {blockedReason: context.blockedReason} : {})});
  }

  get(customer, {applicantIndex = 0} = {}) {
    const context = this.context(customer, applicantIndex), job = this.job(context);
    if (!job) return clone({applicantIndex, jobId: null, revision: 0, state: 'not_started', fields: {}, defaults: this.defaults(context, dubaiDate(this.now())), defaultStatus: 'suggestions_pending_portal_review', documents: {}, missing: [], issues: [], reviewRequiredFields: [], review: {scope: 'staff_data_review', confirmedFields: [], requiredFields: [], complete: false, invalidated: false, reviewedAt: null}, portal: this.portalStatus(), caseId: context.c.id, caseSignature: context.caseSignature, ...(context.blockedReason ? {blockedReason: context.blockedReason} : {})});
    return this.summary(context, job);
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

module.exports = {RaadVisaWorkflow, FIELD_ALLOWLIST, DOCUMENT_KINDS, HEALTH_FIELDS, CONTACT_FIELDS};
