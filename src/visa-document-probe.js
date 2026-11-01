'use strict';

// A private, fixed synthetic diagnostic. No caller-supplied document, customer
// record, passport copy, destination URL or prompt can enter this check.
const sharp = require('sharp');
const {DOCUMENT_VISION_ERROR_CODES, DOCUMENT_FIELD_NAMES, SCHEMA_SECTIONS, SCHEMA_ISSUES} = require('./visa-document-vision');
const VISION_REASONS = new Set(DOCUMENT_VISION_ERROR_CODES);
function safeVisionReason(failure) { try { const code = failure?.code; return typeof code === 'string' && code.length <= 80 && VISION_REASONS.has(code) ? code : undefined; } catch { return undefined; } }
function safeSchemaDiagnostics(failure, reason) {
  if (reason !== 'DOCUMENT_VISION_SCHEMA_INVALID') return {};
  try {
    const section = failure?.schemaSection;
    if (!SCHEMA_SECTIONS.includes(section)) return {};
    const fieldName = section === 'fields' ? failure?.fieldName : undefined;
    const schemaIssue = failure?.schemaIssue;
    return {schemaSection: section, ...(DOCUMENT_FIELD_NAMES.includes(fieldName) ? {fieldName} : {}), ...(SCHEMA_ISSUES.includes(schemaIssue) ? {schemaIssue} : {})};
  } catch { return {}; }
}
const EXPECTED = Object.freeze({visiblePassportNumber: 'ZT1234567', latinFirstName: 'EXAMPLE', latinFamilyName: 'TESTER', birthDate: '1990-04-03', expiryDate: '2035-11-30'});
const lines = [
  'SYNTHETIC OCR DIAGNOSTIC — NOT A VALID DOCUMENT',
  'PASSPORT READING TEST',
  'Type: ORDINARY', 'Issuing country: UTO', 'Nationality: UTO',
  'Surname: TESTER', 'Given name: EXAMPLE', 'Passport number: ZT1234567',
  'Date of birth: 1990-04-03', 'Date of issue: 2025-01-01',
  'Date of expiry: 2035-11-30', 'Place of birth: TEST CITY', 'Sex: M',
  'TEST ONLY — NO REAL PERSON — NOT VALID FOR TRAVEL'
];
async function syntheticImage() {
  const text = lines.map((line, index) => '<text x="55" y="' + (65 + index * 57) + '" font-family="DejaVu Sans,sans-serif" font-size="30" fill="#111">' + line + '</text>').join('');
  return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900"><rect width="100%" height="100%" fill="white"/>' + text + '</svg>')).png().toBuffer();
}
function createDocumentProbe({vision, now = Date.now} = {}) {
  let busy = false, lastAt = null;
  return async function probe() {
    if (!vision?.ready?.()) return {ok: false, error: 'DOCUMENT_VISION_NOT_READY', status: 503};
    if (busy) return {ok: false, error: 'DOCUMENT_PROBE_BUSY', status: 409};
    if (lastAt !== null && now() - lastAt < 60000) return {ok: false, error: 'DOCUMENT_PROBE_COOLDOWN', status: 429};
    busy = true; lastAt = now();
    let stage = 'render';
    try {
      const bytes = await syntheticImage();
      stage = 'infer';
      const result = await vision.extract({bytes, mimeType: 'image/png', guard: () => { const status = vision.status?.(); return status ? status.enabled === true && status.configured === true : true; }});
      stage = 'verify';
      const fieldsRead = Object.entries(EXPECTED).filter(([field, value]) => result?.fields?.[field]?.visible === true && result.fields[field].value === value).length;
      const ok = result?.kind === 'passport' && result?.readable === true && fieldsRead === Object.keys(EXPECTED).length;
      return {ok, synthetic: true, providerResponded: true, fieldsRead, expectedFields: Object.keys(EXPECTED).length, status: ok ? 200 : 422, ...(!ok ? {stage} : {})};
    } catch (failure) { const reason = safeVisionReason(failure); return {ok: false, synthetic: true, error: 'DOCUMENT_PROBE_UNAVAILABLE', status: 503, stage, ...(reason ? {reason, ...safeSchemaDiagnostics(failure, reason)} : {})}; }
    finally { busy = false; }
  };
}
module.exports = {createDocumentProbe};
