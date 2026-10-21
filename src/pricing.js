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

// Every passenger/segment needs a verified seat and meal result. Missing results
// must never be interpreted as free. includedInBase prevents double charging
// extras already present in the portal's itemized total.
function priceAncillaries({ passengerCount, segmentIds, ancillaries }, seatMargin, mealMargin) {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0 ||
      segmentIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(segmentIds).size !== segmentIds.length) {
    throw new RangeError('Verified itinerary segmentIds are required');
  }
  if (!Array.isArray(ancillaries) || ancillaries.length !== passengerCount * segmentIds.length * 2) {
    throw new RangeError('Seat and meal checks are required for every passenger and segment');
  }
  const seen = new Set();
  let addedCost = 0n;
  let seatMarkup = 0n;
  let mealMarkup = 0n;
  const lines = [];
  for (const item of ancillaries) {
    if (!item || !['seat', 'meal'].includes(item.type) ||
        !segmentIds.includes(item.segmentId) ||
        !Number.isSafeInteger(item.passengerIndex) || item.passengerIndex < 1 ||
        item.passengerIndex > passengerCount) {
      throw new RangeError('Invalid ancillary passenger, segment or type');
    }
    const key = JSON.stringify([item.passengerIndex, item.segmentId, item.type]);
    if (seen.has(key)) throw new RangeError('Duplicate ancillary check');
    seen.add(key);
    if (item.available !== true || typeof item.freeOptionAvailable !== 'boolean' ||
        typeof item.includedInBase !== 'boolean') {
      throw new RangeError('Ancillary availability and inclusion must be verified');
    }
    const cost = toFils(item.cost, 'Ancillary cost');
    if ((item.freeOptionAvailable && cost !== 0n) || (!item.freeOptionAvailable && cost === 0n)) {
      throw new RangeError('Choose the verified free option, or provide its paid alternative cost');
    }
    const markup = item.freeOptionAvailable ? 0n : (item.type === 'seat' ? seatMargin : mealMargin);
    const costToAdd = item.includedInBase ? 0n : cost;
    addedCost += costToAdd;
    if (item.type === 'seat') seatMarkup += markup;
    else mealMarkup += markup;
    lines.push({
      type: item.type, segmentId: item.segmentId, passengerIndex: item.passengerIndex,
      freeOptionAvailable: item.freeOptionAvailable, includedInBase: item.includedInBase,
      cost: formatAED(cost), costAdded: formatAED(costToAdd), margin: formatAED(markup)
    });
  }
  return { addedCost, seatMarkup, mealMarkup, lines };
}

// The caller must verify a fresh portal quote and actual ancillary availability.
// This pure helper does not fetch fares, reserve extras, or create bookings.
function priceAirArabiaQuote(quote, env = process.env) {
  const { currency, baseTotal, passengerCount } = quote;
  if (currency !== 'AED') throw new RangeError('Air Arabia pricing requires AED');
  if (!Number.isSafeInteger(passengerCount) || passengerCount < 1 || passengerCount > 9) {
    throw new RangeError('passengerCount must be an integer from 1 to 9');
  }
  const baseFils = toFils(baseTotal, 'baseTotal');
  if (baseFils === 0n) throw new RangeError('baseTotal must be greater than zero');
  const marginFils = toFils(env.AIR_ARABIA_MARGIN_AED ?? '25', 'AIR_ARABIA_MARGIN_AED');
  const seatMargin = toFils(env.AIR_ARABIA_SEAT_MARGIN_AED ?? '10', 'AIR_ARABIA_SEAT_MARGIN_AED');
  const mealMargin = toFils(env.AIR_ARABIA_MEAL_MARGIN_AED ?? '5', 'AIR_ARABIA_MEAL_MARGIN_AED');
  const extras = priceAncillaries(quote, seatMargin, mealMargin);
  const ticketMarginFils = marginFils * BigInt(passengerCount);
  const totalMarginFils = ticketMarginFils + extras.seatMarkup + extras.mealMarkup;
  const sellingFils = baseFils + extras.addedCost + totalMarginFils;
  if (sellingFils > MAX_FILS) throw new RangeError('Selling total is too large');

  return {
    provider: 'airarabia',
    currency: 'AED',
    passengerCount,
    baseTotal: formatAED(baseFils),
    marginPerPassenger: formatAED(marginFils),
    ticketMargin: formatAED(ticketMarginFils),
    ancillaryCostAdded: formatAED(extras.addedCost),
    seatMargin: formatAED(extras.seatMarkup),
    mealMargin: formatAED(extras.mealMarkup),
    totalMargin: formatAED(totalMarginFils),
    sellingTotal: formatAED(sellingFils),
    ancillaryLines: extras.lines
  };
}

module.exports = { priceAirArabiaQuote };
