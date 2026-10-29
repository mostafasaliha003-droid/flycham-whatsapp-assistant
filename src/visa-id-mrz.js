'use strict';

// ICAO Doc 9303 Part 5 (2021), sections 4.2.2 and 4.2.4:
// https://www.icao.int/sites/default/files/publications/DocSeries/9303_p5_cons_en.pdf
// This validates transcription, not authenticity. It neither repairs OCR nor
// decides the century of a six-digit MRZ date. Long document numbers require
// separate review and deliberately remain unsupported here.
function checkDigit(value) {
  return String([...value].reduce((sum, character, index) => {
    const number = character === '<' ? 0 : /[0-9]/.test(character) ? Number(character) : character.charCodeAt(0) - 55;
    return sum + number * [7, 3, 1][index % 3];
  }, 0) % 10);
}

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validRawDate(raw) {
  // A Gregorian 400-year cycle includes the possible leap century. This tests
  // whether a calendar interpretation exists; it does not select that century.
  return /^\d{6}$/.test(raw) && realDate(`20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`);
}

function parseTD1MRZ(input) {
  const result = {ok:false, format:null, fields:{}, checks:{}, issues:[]};
  const issue = (field, code) => result.issues.push({field, code});
  const lines = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : [];
  if (lines.length !== 3 || lines.some(line => typeof line !== 'string' || line.length !== 30)) {
    issue('mrz', 'unsupported_layout'); return result;
  }
  result.format = 'TD1';
  if (lines.some(line => !/^[A-Z0-9<]{30}$/.test(line))) {
    issue('mrz', 'invalid_characters'); return result;
  }
  const [first, second, third] = lines;
  const type = first.slice(0, 2);
  if (!/^[ACI][A-Z<]$/.test(type) || type[1] === 'V' || type === 'AI' || type === 'AC') issue('mrz', 'unsupported_document_type');
  const documentNumberRaw = first.slice(5, 14);
  const birthDateRaw = second.slice(0, 6), expiryDateRaw = second.slice(8, 14);
  const separator = third.indexOf('<<');
  const primaryIdentifierRaw = separator < 0 ? third : third.slice(0, separator);
  const givenNamesRaw = separator < 0 ? '' : third.slice(separator + 2);
  const renderName = value => value.replace(/<+/g, ' ').trim();
  result.fields = {
    documentNumber:documentNumberRaw.replace(/<+$/, ''), documentNumberRaw,
    issuingCountryCode:first.slice(2, 5), nationalityCode:second.slice(15, 18),
    birthDateRaw, expiryDateRaw, sex:second[7] === '<' ? null : second[7],
    latinNames:{family:renderName(primaryIdentifierRaw), givenNames:renderName(givenNamesRaw), primaryIdentifierRaw, givenNamesRaw, truncated:/[A-Z]$/.test(third)},
    optionalDataRaw:first.slice(15, 30), optionalDataSecondRaw:second.slice(18, 29),
    documentReviewed:false,
  };
  if (!/^[A-Z0-9]+<*$/.test(documentNumberRaw)) issue('documentNumber', 'invalid_document_number');
  if (first[14] === '<') issue('documentNumber', 'unsupported_extended_number');
  for (const field of ['issuingCountryCode', 'nationalityCode']) if (!/^[A-Z][A-Z<]{2}$/.test(result.fields[field])) issue(field, 'invalid_country_code');
  if (!/^[MF<]$/.test(second[7])) issue('sex', 'invalid_sex');
  const primary = primaryIdentifierRaw.replace(/<+$/, ''), secondary = givenNamesRaw.replace(/<+$/, '');
  if (!/^[A-Z<]+$/.test(third) || !/^[A-Z]+(?:<[A-Z]+)*$/.test(primary) || secondary && !/^[A-Z]+(?:<[A-Z]+)*$/.test(secondary)) issue('latinNames', 'invalid_names');
  for (const [field, raw] of [['birthDate', birthDateRaw], ['expiryDate', expiryDateRaw]]) if (!validRawDate(raw)) issue(field, 'invalid_mrz_date');
  const check = (name, value, actual) => {
    const expected = checkDigit(value), ok = /^[0-9]$/.test(actual) && expected === actual;
    result.checks[name] = {ok, expected, actual};
    if (!ok) issue(name, 'invalid_check_digit');
  };
  check('documentNumber', documentNumberRaw, first[14]);
  check('birthDate', birthDateRaw, second[6]);
  check('expiryDate', expiryDateRaw, second[14]);
  check('composite', first.slice(5, 30) + second.slice(0, 7) + second.slice(8, 15) + second.slice(18, 29), second[29]);
  result.ok = result.issues.length === 0;
  return result;
}

function matchesPrintedEmiratesId(parsed, printedId) {
  if (!parsed?.ok || parsed.format !== 'TD1' || parsed.fields?.issuingCountryCode !== 'ARE' || typeof printedId !== 'string') return false;
  if (!/^(?:784\d{12}|784-\d{4}-\d{7}-\d)$/.test(printedId)) return false;
  // Optional data has no general identity meaning. An independently printed,
  // complete ID must match the *whole* protected optional zone; no substrings.
  return parsed.fields.optionalDataRaw === printedId.replaceAll('-', '');
}

function resolvePrintedDate(raw, yyMMdd) {
  // The caller must supply a date from an independently validated MRZ. The
  // century always comes from the printed four-digit year, including 00 years.
  if (typeof raw !== 'string' || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw) || typeof yyMMdd !== 'string' || !/^\d{6}$/.test(yyMMdd)) return null;
  const [first, second, year] = raw.split('/');
  const iso = (month, day) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const candidates = [...new Set([iso(second, first), iso(first, second)])].filter(value => realDate(value) && value.replaceAll('-', '').slice(2) === yyMMdd);
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {parseTD1MRZ, matchesPrintedEmiratesId, resolvePrintedDate};
