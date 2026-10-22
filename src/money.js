'use strict';
const MAX_FILS = BigInt(Number.MAX_SAFE_INTEGER);
function toFils(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${label} must be an AED decimal amount`);
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new RangeError(`${label} must have at most two decimal places`);
  const [whole, fraction = ''] = text.split('.');
  const fils = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (fils > MAX_FILS) throw new RangeError(`${label} is too large`);
  return fils;
}
function formatAED(fils) { return `${fils / 100n}.${String(fils % 100n).padStart(2, '0')}`; }
module.exports = { MAX_FILS, toFils, formatAED };
