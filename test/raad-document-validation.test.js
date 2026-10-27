'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTD3MRZ, validateApplicant, chooseCheapestInsurance, proposedEntryDate } = require('../src/raad-document-validation');

const referenceDate = '2026-10-26';
function digit(value) {
  return String([...value].reduce((sum, character, index) => sum + (character === '<' ? 0 : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55) * [7, 3, 1][index % 3], 0) % 10);
}
function mrz({ number = 'N12345678', birth = '900115', expiry = '310101', optional = '<'.repeat(14), optionalCheck } = {}) {
  const first = 'P<UTOEXAMPLE<<SYNTHETIC<PERSON'.padEnd(44, '<');
  const body = number.padEnd(9, '<') + digit(number.padEnd(9, '<')) + 'ZZZ' + birth + digit(birth) + 'F' + expiry + digit(expiry) + optional + (optionalCheck ?? digit(optional));
  return [first, body + digit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43))];
}
function confirmed(lines = mrz(), options = {}) {
  return parseTD3MRZ(lines, { referenceDate, confirmedBirthDate: '1990-01-15', confirmedExpiryDate: '2031-01-01', ...options });
}
function applicant(overrides = {}) {
  return {
    nationalityCode: 'ZZZ', passportNumber: 'N12345678', passportType: 'ordinary', issuingCountryCode: 'UTO',
    issueDate: '2021-01-01', expiryDate: '2031-01-01', birthDate: '1990-01-15', birthPlace: 'Synthetic City',
    sex: 'female', latinFirstName: 'Synthetic', latinFamilyName: 'Example', emiratesId: '784-0000-0000000-0',
    residenceExpiry: '2028-01-01', maritalStatus: 'single', previousNationality: false, travelledLastFiveYears: false,
    performUmrah: false, saudiAddress: 'Synthetic address', entryDate: '2026-11-10', transport: 'air', arrivalPort: 'Synthetic airport', gccResident: true,
    health: { hospitalizedOrEmergency: false, accidentDisability: false, congenitalCondition: false }, ...overrides,
  };
}

test('TD3 validates every digit, keeps exact number and distinct nationality and issuer, and does not invent family relations', () => {
  const result = confirmed();
  assert.equal(result.ok, true);
  assert.equal(result.format, 'TD3');
  assert.equal(result.fields.passportNumber, 'N12345678');
  assert.equal(result.fields.nationalityCode, 'ZZZ');
  assert.equal(result.fields.issuingCountryCode, 'UTO');
  assert.equal(result.fields.latinNames.family, 'EXAMPLE');
  assert.equal(result.fields.latinNames.givenNames, 'SYNTHETIC PERSON');
  assert.equal(result.fields.latinNames.givenNamesRaw.startsWith('SYNTHETIC<PERSON'), true);
  assert.equal(result.fields.latinFatherName, undefined);
  assert.equal(result.fields.documentReviewed, false);
  assert.equal(Object.values(result.checks).every(check => check.ok), true);
  assert.equal(confirmed(mrz({ number: '12345678' })).fields.passportNumber, '12345678');
});

test('TD3 never repairs unsupported layouts or characters', () => {
  const lines = mrz();
  assert.equal(confirmed([lines[0].slice(1), lines[1]]).issues[0].code, 'unsupported_layout');
  assert.equal(confirmed([lines[0].toLowerCase(), lines[1]]).issues[0].code, 'invalid_characters');
  assert.equal(confirmed(`${lines[0]}\r\n${lines[1]}`).ok, true);
  assert.equal(confirmed([lines[0], `<${lines[1].slice(1)}`]).ok, false);
  const extended = [lines[0], lines[1].slice(0, 9) + '<' + lines[1].slice(10)];
  assert.equal(confirmed(extended).issues.some(item => item.code === 'unsupported_extended_number'), true);
});

test('TD3 independently rejects each altered check digit', () => {
  for (const position of [9, 19, 27, 42, 43]) {
    const lines = mrz();
    lines[1] = lines[1].slice(0, position) + ((Number(lines[1][position]) + 1) % 10) + lines[1].slice(position + 1);
    const result = confirmed(lines);
    assert.equal(result.ok, false);
    assert.equal(Object.values(result.checks).some(check => !check.ok), true);
  }
});

test('optional fillers allow a filler check digit but populated optional data requires its real digit', () => {
  assert.equal(confirmed(mrz({ optionalCheck: '<' })).ok, true);
  assert.equal(confirmed(mrz({ optional: '12345678901234', optionalCheck: '<' })).ok, false);
});

test('MRZ date centuries remain unresolved until dates are independently confirmed', () => {
  const result = parseTD3MRZ(mrz({ birth: '000115' }), { referenceDate });
  assert.equal(result.ok, false);
  assert.equal(result.fields.birthDate, null);
  assert.equal(result.fields.expiryDate, null);
  assert.equal(result.fields.birthDateRaw, '000115');
  assert.deepEqual(result.fields.birthDateCandidates, ['1900-01-15', '2000-01-15']);
  assert.equal(result.issues.some(item => item.code === 'ambiguous_century'), true);
  const unconfirmedBirth = parseTD3MRZ(mrz(), { referenceDate, confirmedExpiryDate: '2031-01-01' });
  assert.equal(unconfirmedBirth.fields.birthDate, null);
  assert.equal(unconfirmedBirth.ok, false);
  assert.equal(confirmed(mrz({ birth: '000115' }), { confirmedBirthDate: '2000-01-15' }).ok, true);
  assert.equal(confirmed(mrz(), { confirmedBirthDate: '1990-01-16' }).issues.some(item => item.code === 'confirmed_date_mismatch'), true);
  assert.equal(confirmed(mrz({ birth: '900231' })).issues.some(item => item.code === 'invalid_mrz_date'), false);
  assert.equal(confirmed(mrz({ birth: '900231' })).ok, false);
  assert.equal(parseTD3MRZ(mrz({ birth: '900231' }), { referenceDate }).issues.some(item => item.code === 'invalid_mrz_date'), true);
});

test('complete adult applicant validates with truthful affirmative health answers and no inferred names', () => {
  const fields = applicant({ health: { hospitalizedOrEmergency: true, accidentDisability: false, congenitalCondition: false } });
  const result = validateApplicant(fields, { referenceDate });
  assert.equal(result.ok, true);
  assert.equal(result.age, 36);
  assert.equal(result.isMinor, false);
  assert.equal(result.proposedEntryDate, '2026-11-10');
  assert.equal(fields.latinFatherName, undefined);
  assert.equal(fields.health.hospitalizedOrEmergency, true);
});

test('every required declaration must be an actual explicit boolean', () => {
  for (const field of ['previousNationality', 'travelledLastFiveYears', 'performUmrah', 'gccResident']) {
    assert.equal(validateApplicant(applicant({ [field]: undefined }), { referenceDate }).issues.some(item => item.field === field && item.code === 'explicit_boolean_required'), true);
  }
  for (const field of ['hospitalizedOrEmergency', 'accidentDisability', 'congenitalCondition']) {
    const fields = applicant();
    delete fields.health[field];
    assert.equal(validateApplicant(fields, { referenceDate }).issues.some(item => item.field === `health.${field}`), true);
  }
  assert.equal(validateApplicant(applicant({ performUmrah: 'false' }), { referenceDate }).ok, false);
  assert.equal(validateApplicant(applicant({ previousNationality: true }), { referenceDate }).ok, false);
  assert.equal(validateApplicant(applicant({ travelledLastFiveYears: true }), { referenceDate }).ok, false);
  assert.equal(validateApplicant(applicant({ previousNationality: true, previousNationalityDetails: 'Synthetic former nationality', travelledLastFiveYears: true, travelHistory: ['Synthetic visit'] }), { referenceDate }).ok, true);
});

test('calendar validity uses six and three calendar months with end-of-month clamping', () => {
  const options = { referenceDate: '2026-01-31' };
  const fields = applicant({ entryDate: '2026-03-31', expiryDate: '2026-09-30', residenceExpiry: '2026-04-30' });
  assert.equal(validateApplicant(fields, options).ok, true);
  assert.equal(validateApplicant({ ...fields, expiryDate: '2026-09-29' }, options).issues.some(item => item.code === 'insufficient_passport_validity'), true);
  assert.equal(validateApplicant({ ...fields, residenceExpiry: '2026-04-29' }, options).issues.some(item => item.code === 'insufficient_residence_validity'), true);
});

test('invalid dates, entry in the past, and issue/expiry ordering fail', () => {
  assert.equal(validateApplicant(applicant({ birthDate: '2001-02-29' }), { referenceDate }).ok, false);
  assert.equal(validateApplicant(applicant({ birthDate: '2000-02-29' }), { referenceDate }).ok, true);
  assert.equal(validateApplicant(applicant({ entryDate: '2026-10-25' }), { referenceDate }).issues.some(item => item.code === 'past_entry_date'), true);
  assert.equal(validateApplicant(applicant({ issueDate: '2031-01-01' }), { referenceDate }).issues.some(item => item.code === 'invalid_date_order'), true);
});

test('minor applicants need an issued father or mother visa with its reference', () => {
  const minor = applicant({ birthDate: '2010-10-27' });
  const result = validateApplicant(minor, { referenceDate });
  assert.equal(result.age, 15);
  assert.equal(result.isMinor, true);
  assert.equal(result.ok, false);
  assert.equal(validateApplicant({ ...minor, guardian: { relationship: 'father', status: 'issued', visaReference: 'SYNTHETIC-REF' } }, { referenceDate }).ok, true);
  assert.equal(validateApplicant({ ...minor, guardian: { relationship: 'mother', status: 'pending', visaReference: 'SYNTHETIC-REF' } }, { referenceDate }).ok, false);
  assert.equal(validateApplicant(applicant({ birthDate: '2008-10-26' }), { referenceDate }).isMinor, false);
});

test('Emirates ID strips only spaces/hyphens and retains an exact 15-digit 784 prefix', () => {
  for (const emiratesId of ['784000000000000', '784 0000 0000000 0']) assert.equal(validateApplicant(applicant({ emiratesId }), { referenceDate }).ok, true);
  for (const emiratesId of ['785000000000000', '78400000000000', '7840000000000000', '784\t000000000000', '784_0000_0000000_0']) assert.equal(validateApplicant(applicant({ emiratesId }), { referenceDate }).ok, false);
});

test('proposed entry uses UTC calendar days and refuses invalid inputs', () => {
  assert.equal(proposedEntryDate('2026-12-25'), '2027-01-09');
  assert.equal(proposedEntryDate('2024-02-28', 1), '2024-02-29');
  assert.throws(() => proposedEntryDate('2026-02-29'), RangeError);
  assert.throws(() => proposedEntryDate(referenceDate, -1), RangeError);
});

test('insurance uses integer USD cents, provider IDs for stable ties, and only explicit available offers', () => {
  const offers = [
    { id: 'unavailable', price: '0.01', currency: 'USD', available: false },
    { id: 'b', price: '10.10', currency: 'USD', available: true },
    { id: 'a', amount: 10.1, currency: 'USD', available: true },
    { id: 'missing-availability', amount: '1.00', currency: 'USD' },
  ];
  const snapshot = JSON.stringify(offers);
  const result = chooseCheapestInsurance(offers);
  assert.equal(result.ok, true);
  assert.equal(result.offer, offers[2]);
  assert.equal(result.cents, 1010);
  assert.equal(JSON.stringify(offers), snapshot);
});

test('insurance rejects malformed prices, missing IDs, nonpositive amounts, mixed currencies and pasted prices', () => {
  for (const price of [NaN, Infinity, 0, -1, 0.001, '1,00', '1,000.00', '$10.00', 'USD 10.00', '10.001', '']) {
    assert.equal(chooseCheapestInsurance([{ id: 'bad', price, currency: 'USD', available: true }]).ok, false, String(price));
  }
  assert.equal(chooseCheapestInsurance([{ price: '10.00', currency: 'USD', available: true }]).ok, false);
  assert.equal(chooseCheapestInsurance([{ id: 'a', price: '10.00', currency: 'USD', available: true }, { id: 'b', price: '9.00', currency: 'AED', available: true }]).ok, false);
  assert.equal(chooseCheapestInsurance([{ id: 'a', amount: '10.00', price: '1.00', currency: 'USD', available: true }]).ok, false);
  assert.equal(chooseCheapestInsurance('Provider A $10, Provider B $8').ok, false);
});

test('insurance never claims a cheapest offer when any available offer is unreadable', () => {
  const valid = { id: 'valid', price: '10.00', currency: 'USD', available: true };
  for (const invalid of [
    { id: 'unknown-price', price: NaN, currency: 'USD', available: true },
    { price: '5.00', currency: 'USD', available: true },
    { id: 'unknown-currency', price: '5.00', available: true },
  ]) {
    const result = chooseCheapestInsurance([valid, invalid]);
    assert.equal(result.ok, false);
    assert.equal(result.offer, null);
    assert.equal(result.cents, null);
    assert.equal(result.issues.length > 0, true);
  }
});
