'use strict';

const MAX_FILS = BigInt(Number.MAX_SAFE_INTEGER);

function toFils(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} must be an AED decimal amount`);
  }
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new RangeError(`${label} must have at most two decimal places`);
  }
  const [whole, fraction = ''] = text.split('.');
  const fils = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (fils > MAX_FILS) throw new RangeError(`${label} is too large`);
  return fils;
}

function formatAED(fils) {
  return `${fils / 100n}.${String(fils % 100n).padStart(2, '0')}`;
}

// Calculate only after the caller verifies the complete portal quote, itinerary,
// currency, passenger counts and freshness. This helper does not fetch fares.
function priceAirArabiaQuote({ currency, baseTotal, passengerCount }, env = process.env) {
  if (currency !== 'AED') throw new RangeError('Air Arabia pricing requires AED');
  if (!Number.isSafeInteger(passengerCount) || passengerCount < 1 || passengerCount > 9) {
    throw new RangeError('passengerCount must be an integer from 1 to 9');
  }
  const baseFils = toFils(baseTotal, 'baseTotal');
  if (baseFils === 0n) throw new RangeError('baseTotal must be greater than zero');
  const marginFils = toFils(env.AIR_ARABIA_MARGIN_AED ?? '25', 'AIR_ARABIA_MARGIN_AED');
  const totalMarginFils = marginFils * BigInt(passengerCount);
  const sellingFils = baseFils + totalMarginFils;
  if (sellingFils > MAX_FILS) throw new RangeError('Selling total is too large');

  return {
    provider: 'airarabia',
    currency: 'AED',
    passengerCount,
    baseTotal: formatAED(baseFils),
    marginPerPassenger: formatAED(marginFils),
    totalMargin: formatAED(totalMarginFils),
    sellingTotal: formatAED(sellingFils)
  };
}

module.exports = { priceAirArabiaQuote };
