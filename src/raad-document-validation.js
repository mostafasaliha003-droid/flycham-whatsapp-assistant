'use strict';

function issue(field, code, message) { return { field, code, message }; }
function today() { return new Date().toISOString().slice(0, 10); }
function readDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
function dateText(date) { return date.toISOString().slice(0, 10); }
function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(result);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  result.setUTCDate(Math.min(day, last.getUTCDate()));
  return result;
}

function proposedEntryDate(referenceDate = today(), days = 15) {
  const date = readDate(referenceDate);
  if (!date || !Number.isSafeInteger(days) || days < 0) throw new RangeError('A real reference date and a nonnegative integer day count are required.');
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new RangeError('The proposed entry date is outside the supported date range.');
  return dateText(date);
}

function checkDigit(value) {
  const weights = [7, 3, 1];
  return String([...value].reduce((sum, character, index) => {
    const number = character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55;
    return sum + number * weights[index % 3];
  }, 0) % 10);
}

function mrzDate(raw, field, reference, confirmed, issues) {
  const candidates = [];
  if (!/^\d{6}$/.test(raw)) {
    issues.push(issue(field, 'invalid_mrz_date', 'The MRZ date must contain six digits.'));
    return { date: null, candidates };
  }
  const century = Math.floor(reference.getUTCFullYear() / 100) * 100;
  for (const base of [century - 100, century, century + 100]) {
    const value = `${String(base + Number(raw.slice(0, 2))).padStart(4, '0')}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
    const parsed = readDate(value);
    if (parsed && (field !== 'birthDate' || parsed <= reference)) candidates.push(value);
  }
  if (confirmed !== undefined) {
    const parsed = readDate(confirmed);
    if (!parsed || confirmed.replaceAll('-', '').slice(2) !== raw || (field === 'birthDate' && parsed > reference)) {
      issues.push(issue(field, 'confirmed_date_mismatch', 'The independently confirmed date must be real and match the MRZ date.'));
      return { date: null, candidates };
    }
    if (!candidates.includes(confirmed)) candidates.push(confirmed);
    return { date: confirmed, candidates: candidates.sort() };
  }
  if (!candidates.length) issues.push(issue(field, 'invalid_mrz_date', 'The MRZ date is not a real supported calendar date.'));
  else issues.push(issue(field, 'ambiguous_century', 'Confirm the full date from the visual document; nearby date candidates do not establish the century.'));
  return { date: null, candidates };
}

function parseTD3MRZ(input, { referenceDate = today(), confirmedBirthDate, confirmedExpiryDate } = {}) {
  const result = { ok: false, format: null, fields: {}, checks: {}, issues: [] };
  const reference = readDate(referenceDate);
  if (!reference) {
    result.issues.push(issue('referenceDate', 'invalid_date', 'A real YYYY-MM-DD reference date is required.'));
    return result;
  }
  const lines = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : [];
  if (lines.length !== 2 || lines.some(line => typeof line !== 'string' || line.length !== 44)) {
    result.issues.push(issue('mrz', 'unsupported_layout', 'Only two exact 44-character TD3 passport lines are supported.'));
    return result;
  }
  result.format = 'TD3';
  if (lines.some(line => !/^[A-Z0-9<]{44}$/.test(line))) {
    result.issues.push(issue('mrz', 'invalid_characters', 'MRZ characters must be uppercase A-Z, digits, or fillers.'));
    return result;
  }
  const [first, second] = lines;
  if (!/^P[A-Z<]/.test(first)) result.issues.push(issue('mrz', 'unsupported_layout', 'Only TD3 passport document types are supported.'));
  const documentNumberRaw = second.slice(0, 9);
  const birthDateRaw = second.slice(13, 19);
  const expiryDateRaw = second.slice(21, 27);
  const optionalDataRaw = second.slice(28, 42);
  const separator = first.indexOf('<<', 5);
  const primaryIdentifierRaw = separator < 0 ? first.slice(5) : first.slice(5, separator);
  const givenNamesRaw = separator < 0 ? '' : first.slice(separator + 2);
  const renderName = raw => raw.replace(/<+/g, ' ').trim();
  result.fields = {
    passportNumber: documentNumberRaw.replace(/<+$/, ''), documentNumberRaw,
    nationalityCode: second.slice(10, 13), issuingCountryCode: first.slice(2, 5),
    birthDate: null, birthDateRaw, birthDateCandidates: [],
    expiryDate: null, expiryDateRaw, expiryDateCandidates: [],
    sex: second[20] === '<' ? null : second[20],
    latinNames: { family: renderName(primaryIdentifierRaw), givenNames: renderName(givenNamesRaw), primaryIdentifierRaw, givenNamesRaw },
    optionalDataRaw, documentReviewed: false,
  };
  if (!/^[A-Z0-9]+<*$/.test(documentNumberRaw)) result.issues.push(issue('passportNumber', 'invalid_document_number', 'The document-number zone must contain a number followed only by trailing fillers.'));
  if (second[9] === '<') result.issues.push(issue('passportNumber', 'unsupported_extended_number', 'An extended document number needs independent document review; its continuation is not supported.'));
  for (const [field, value] of [['issuingCountryCode', first.slice(2, 5)], ['nationalityCode', second.slice(10, 13)]]) {
    if (!/^[A-Z][A-Z<]{2}$/.test(value)) result.issues.push(issue(field, 'invalid_country_code', 'The MRZ country-code zone is invalid.'));
  }
  if (separator < 0 || !/^[A-Z<]+$/.test(first.slice(5)) || !result.fields.latinNames.family) result.issues.push(issue('latinNames', 'invalid_names', 'The MRZ must contain a primary identifier and a given-name separator.'));
  if (!/^[MFX<]$/.test(second[20])) result.issues.push(issue('sex', 'invalid_sex', 'The MRZ sex character is invalid.'));
  const check = (name, value, actual, allowFiller = false) => {
    const expected = checkDigit(value);
    const ok = actual === expected || (allowFiller && actual === '<' && /^<+$/.test(value));
    result.checks[name] = { ok, expected, actual };
    if (!ok) result.issues.push(issue(name, 'invalid_check_digit', 'The MRZ check digit does not match.'));
  };
  check('documentNumber', documentNumberRaw, second[9]);
  check('birthDate', birthDateRaw, second[19]);
  check('expiryDate', expiryDateRaw, second[27]);
  check('optionalData', optionalDataRaw, second[42], true);
  check('composite', second.slice(0, 10) + second.slice(13, 20) + second.slice(21, 43), second[43]);
  const birth = mrzDate(birthDateRaw, 'birthDate', reference, confirmedBirthDate, result.issues);
  const expiry = mrzDate(expiryDateRaw, 'expiryDate', reference, confirmedExpiryDate, result.issues);
  Object.assign(result.fields, { birthDate: birth.date, birthDateCandidates: birth.candidates, expiryDate: expiry.date, expiryDateCandidates: expiry.candidates });
  result.ok = result.issues.length === 0;
  return result;
}

function validateApplicant(fields, { referenceDate = today() } = {}) {
  const issues = [];
  const reference = readDate(referenceDate);
  const result = { ok: false, issues, age: null, isMinor: null, proposedEntryDate: null };
  if (!reference) {
    issues.push(issue('referenceDate', 'invalid_date', 'A real YYYY-MM-DD reference date is required.'));
    return result;
  }
  result.proposedEntryDate = proposedEntryDate(referenceDate);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    issues.push(issue('applicant', 'required', 'Applicant fields are required.'));
    return result;
  }
  const hasText = value => typeof value === 'string' && value.trim().length > 0;
  const requiredText = field => {
    if (!hasText(fields[field])) { issues.push(issue(field, 'required', 'This field requires an explicit answer.')); return false; }
    return true;
  };
  for (const field of ['passportType', 'birthPlace', 'saudiAddress', 'arrivalPort']) requiredText(field);
  for (const field of ['nationalityCode', 'issuingCountryCode']) {
    if (requiredText(field) && !/^[A-Z][A-Z<]{2}$/i.test(fields[field])) issues.push(issue(field, 'invalid_country_code', 'Provide the three-character document country code.'));
  }
  if (requiredText('passportNumber') && !/^[A-Z0-9]{1,20}$/i.test(fields.passportNumber)) issues.push(issue('passportNumber', 'invalid_passport_number', 'Provide the exact alphanumeric passport number.'));
  for (const field of ['latinFirstName', 'latinFamilyName', 'latinFatherName', 'latinGrandfatherName']) {
    if ((['latinFirstName', 'latinFamilyName'].includes(field) ? requiredText(field) : hasText(fields[field])) && !/^[\p{Script=Latin}\p{M} .'-]+$/u.test(fields[field])) issues.push(issue(field, 'invalid_latin_name', 'Use the Latin name exactly as confirmed from the document.'));
  }
  for (const field of ['arabicFirstName', 'arabicFamilyName']) {
    if (hasText(fields[field]) && !/^[\p{Script=Arabic}\p{M} .'-]+$/u.test(fields[field])) issues.push(issue(field, 'invalid_arabic_name', 'Use the Arabic name as independently confirmed.'));
  }
  if (requiredText('sex') && !['m', 'f', 'x', 'male', 'female', 'unspecified'].includes(fields.sex.toLowerCase())) issues.push(issue('sex', 'invalid_sex', 'Provide an explicitly confirmed sex value.'));
  if (requiredText('maritalStatus') && !['single', 'married', 'divorced', 'widowed', 'widow', 'separated'].includes(fields.maritalStatus.toLowerCase())) issues.push(issue('maritalStatus', 'invalid_marital_status', 'Confirm the applicant marital status.'));
  if (requiredText('emiratesId') && !/^784\d{12}$/.test(fields.emiratesId.replace(/[ -]/g, ''))) issues.push(issue('emiratesId', 'invalid_emirates_id', 'The Emirates ID must be 784 followed by twelve digits; only spaces and hyphens may separate digits.'));
  if (requiredText('transport') && !['air', 'land', 'sea'].includes(fields.transport)) issues.push(issue('transport', 'invalid_transport', 'Choose air, land, or sea.'));
  for (const field of ['previousNationality', 'travelledLastFiveYears', 'performUmrah', 'gccResident']) {
    if (typeof fields[field] !== 'boolean') issues.push(issue(field, 'explicit_boolean_required', 'An explicit true or false answer is required.'));
  }
  const hasDetails = value => hasText(value) || (Array.isArray(value) && value.length > 0 && value.every(item => hasText(item) || (item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).some(hasText))));
  for (const [answer, details] of [['previousNationality', 'previousNationalityDetails'], ['travelledLastFiveYears', 'travelHistory']]) {
    if (fields[answer] === true && !hasDetails(fields[details])) issues.push(issue(details, 'required', 'Details are required for an affirmative answer.'));
  }
  for (const field of ['hospitalizedOrEmergency', 'accidentDisability', 'congenitalCondition']) {
    if (!fields.health || typeof fields.health[field] !== 'boolean') issues.push(issue(`health.${field}`, 'explicit_boolean_required', 'The applicant must explicitly answer this health question.'));
  }
  const dates = {};
  for (const field of ['issueDate', 'expiryDate', 'birthDate', 'residenceExpiry', 'entryDate']) {
    dates[field] = readDate(fields[field]);
    if (!dates[field]) issues.push(issue(field, 'invalid_date', 'A real YYYY-MM-DD calendar date is required.'));
  }
  if (dates.birthDate) {
    if (dates.birthDate > reference) issues.push(issue('birthDate', 'future_birth_date', 'The birth date cannot be after the application date.'));
    else {
      let age = reference.getUTCFullYear() - dates.birthDate.getUTCFullYear();
      if (reference.getUTCMonth() < dates.birthDate.getUTCMonth() || (reference.getUTCMonth() === dates.birthDate.getUTCMonth() && reference.getUTCDate() < dates.birthDate.getUTCDate())) age--;
      result.age = age;
      result.isMinor = age < 18;
    }
  }
  if (dates.issueDate && dates.issueDate > reference) issues.push(issue('issueDate', 'future_issue_date', 'The passport issue date cannot be after the application date.'));
  if (dates.issueDate && dates.expiryDate && dates.issueDate >= dates.expiryDate) issues.push(issue('issueDate', 'invalid_date_order', 'The passport issue date must precede its expiry date.'));
  if (dates.issueDate && dates.birthDate && dates.issueDate < dates.birthDate) issues.push(issue('issueDate', 'before_birth_date', 'The passport issue date cannot precede the birth date.'));
  if (dates.entryDate && dates.entryDate < reference) issues.push(issue('entryDate', 'past_entry_date', 'The entry date cannot precede the application date.'));
  if (dates.entryDate && dates.expiryDate && dates.expiryDate < addMonths(dates.entryDate, 6)) issues.push(issue('expiryDate', 'insufficient_passport_validity', 'The passport must be valid for six calendar months from entry.'));
  if (dates.residenceExpiry && dates.residenceExpiry < addMonths(reference, 3)) issues.push(issue('residenceExpiry', 'insufficient_residence_validity', 'Residence must remain valid for three calendar months from application.'));
  if (result.isMinor) {
    const guardian = fields.guardian;
    if (!guardian || !['father', 'mother'].includes(guardian.relationship)) issues.push(issue('guardian.relationship', 'guardian_required', 'A minor requires a confirmed father or mother guardian.'));
    if (!guardian || guardian.status !== 'issued') issues.push(issue('guardian.status', 'issued_guardian_visa_required', 'The guardian visa must already be issued.'));
    if (!guardian || !hasText(guardian.visaReference)) issues.push(issue('guardian.visaReference', 'guardian_reference_required', 'The issued guardian visa reference is required.'));
  }
  result.ok = issues.length === 0;
  return result;
}

function usdCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function chooseCheapestInsurance(offers) {
  const result = { ok: false, offer: null, cents: null, currency: 'USD', issues: [] };
  if (!Array.isArray(offers)) {
    result.issues.push(issue('offers', 'invalid_offers', 'Structured current provider offers are required.'));
    return result;
  }
  const available = offers.map((offer, index) => ({ offer, index })).filter(({ offer }) => offer && offer.available === true);
  const currencies = new Set(available.map(({ offer }) => typeof offer.currency === 'string' ? offer.currency.toUpperCase() : ''));
  if (currencies.size > 1 || (currencies.size === 1 && !currencies.has('USD'))) {
    result.issues.push(issue('offers', 'mixed_or_unsupported_currency', 'All available offers must use explicit USD prices.'));
    return result;
  }
  const candidates = [];
  for (const { offer, index } of available) {
    const amount = offer.amount !== undefined ? offer.amount : offer.price;
    const cents = usdCents(amount);
    const other = offer.amount !== undefined && offer.price !== undefined ? usdCents(offer.price) : cents;
    if (cents === null || other !== cents || !currencies.has('USD')) {
      result.issues.push(issue(`offers.${index}.price`, 'invalid_usd_price', 'Use an unambiguous positive USD amount with at most two decimal places.'));
      continue;
    }
    if ((typeof offer.id !== 'string' && typeof offer.id !== 'number') || String(offer.id).trim() === '' || (typeof offer.id === 'number' && !Number.isFinite(offer.id))) {
      result.issues.push(issue(`offers.${index}.id`, 'invalid_offer_id', 'A stable provider offer identifier is required.'));
      continue;
    }
    candidates.push({ offer, cents, index, id: String(offer.id) });
  }
  if (result.issues.length) return result;
  candidates.sort((a, b) => a.cents - b.cents || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index));
  if (!candidates.length) result.issues.push(issue('offers', 'no_available_offer', 'No valid available USD insurance offer was supplied.'));
  else Object.assign(result, { ok: true, offer: candidates[0].offer, cents: candidates[0].cents });
  return result;
}

module.exports = { parseTD3MRZ, validateApplicant, chooseCheapestInsurance, proposedEntryDate };
