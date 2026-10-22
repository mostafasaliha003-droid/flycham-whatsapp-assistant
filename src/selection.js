'use strict';
const { toFils, formatAED, MAX_FILS } = require('./money');
const { priceAirArabiaQuote } = require('./pricing');
const keyOf = item => JSON.stringify([item.passengerIndex, item.segmentId, item.type]);

// Catalog completeness is an assertion the portal adapter must establish by
// inspecting every page/seat-map section. This module never inspects a portal.
function buildAirArabiaQuote(quote, env = process.env) {
  const { passengerCount, segmentIds, catalogs, seatRequests = [], baggageRequests = [] } = quote;
  if (quote.currency !== 'AED' || !Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 9 ||
      !Array.isArray(segmentIds) || !segmentIds.length || segmentIds.some(s => typeof s !== 'string' || !s.trim()) ||
      new Set(segmentIds).size !== segmentIds.length || !Array.isArray(catalogs) ||
      catalogs.length !== passengerCount * segmentIds.length * 3 || !Array.isArray(seatRequests) || !Array.isArray(baggageRequests)) {
    throw new RangeError('Complete seat, meal and baggage catalogs are required for the verified itinerary');
  }
  const catalogMap = new Map();
  for (const catalog of catalogs) {
    if (!catalog || !['seat', 'meal', 'baggage'].includes(catalog.type) || !segmentIds.includes(catalog.segmentId) ||
        !Number.isInteger(catalog.passengerIndex) || catalog.passengerIndex < 1 || catalog.passengerIndex > passengerCount ||
        catalog.allOptionsChecked !== true || !Array.isArray(catalog.options) || !catalog.options.length || catalogMap.has(keyOf(catalog))) {
      throw new RangeError('Incomplete or duplicate service catalog');
    }
    const ids = new Set();
    for (const option of catalog.options) {
      if (!option || typeof option.id !== 'string' || !option.id || ids.has(option.id) ||
          typeof option.available !== 'boolean' || typeof option.eligible !== 'boolean') throw new RangeError('Unverified option');
      ids.add(option.id);
      if (!option.available || !option.eligible) continue;
      toFils(option.cost, 'Option cost');
      if (typeof option.includedInBase !== 'boolean') throw new RangeError('Unverified option inclusion');
      if (catalog.type === 'seat' && (typeof option.seatNumber !== 'string' || !option.seatNumber)) throw new RangeError('Verified seat numbers are required');
      if (catalog.type === 'meal' && typeof option.providesService !== 'boolean') throw new RangeError('Meal inclusion must be explicit');
      if (catalog.type === 'baggage' && (!Number.isFinite(option.checkedWeightKg) || option.checkedWeightKg < 0 ||
          !Number.isFinite(option.handWeightKg) || option.handWeightKg < 0)) throw new RangeError('Verified baggage weights are required');
    }
    catalogMap.set(keyOf(catalog), catalog);
  }
  const baggageRequestMap = new Map();
  for (const request of baggageRequests) {
    const key = keyOf({ ...request, type:'baggage' });
    if (!catalogMap.has(key) || baggageRequestMap.has(key) || request.requestedByCustomer !== true ||
        !Number.isFinite(request.checkedWeightKg) || request.checkedWeightKg <= 0) {
      throw new RangeError('Additional baggage must be an explicit customer request');
    }
    baggageRequestMap.set(key, request);
  }
  const requests = new Map();
  for (const request of seatRequests) {
    const key = keyOf({ ...request, type: 'seat' });
    if (!catalogMap.has(key) || requests.has(key) || request.requestedByCustomer !== true ||
        (!request.seatNumber && !request.features?.length) ||
        (request.seatNumber !== undefined && typeof request.seatNumber !== 'string') ||
        (request.features !== undefined && (!Array.isArray(request.features) || request.features.some(f => typeof f !== 'string' || !f)))) {
      throw new RangeError('Seat preference must be an explicit customer request');
    }
    requests.set(key, request);
  }
  // Fulfill explicit seat requests first so default choices do not consume them.
  const ordered = [...catalogMap.values()].sort((a, b) => Number(requests.has(keyOf(b))) - Number(requests.has(keyOf(a))));
  const occupied = new Set();
  const ancillaries = [];
  const baggageOptions = [];
  let baggageCost = 0n;
  const baggageMarginPassengers = new Set();
  for (const catalog of ordered) {
    let options = catalog.options.filter(o => o.available && o.eligible &&
      (catalog.type !== 'meal' || o.providesService === true) &&
      (catalog.type !== 'seat' || !occupied.has(JSON.stringify([catalog.segmentId, o.seatNumber || o.id]))));
    const freeOptionAvailable = options.some(o => toFils(o.cost, 'Option cost') === 0n);
    const request = requests.get(keyOf(catalog));
    if (request) options = options.filter(o => (!request.seatNumber || o.seatNumber === request.seatNumber) &&
      (!request.features || request.features.every(f => o.features?.includes(f))));
    const baggageRequest = baggageRequestMap.get(keyOf(catalog));
    const defaultBaggage = catalog.type === 'baggage' ? options.slice().sort((a,b)=>{
      const delta=toFils(a.cost,'Baggage cost')-toFils(b.cost,'Baggage cost');
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    })[0] : null;
    if (baggageRequest) options = options.filter(o => o.checkedWeightKg >= baggageRequest.checkedWeightKg);
    options = options.slice().sort((a, b) => {
      const delta = toFils(a.cost, 'Option cost') - toFils(b.cost, 'Option cost');
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
    if (!options.length) throw new RangeError('Requested or default service is unavailable; do not substitute silently');
    const choice = options[0];
    if (catalog.type === 'seat') occupied.add(JSON.stringify([catalog.segmentId, choice.seatNumber || choice.id]));
    if (catalog.type === 'baggage') {
      if (baggageRequest && defaultBaggage && choice.checkedWeightKg > defaultBaggage.checkedWeightKg) baggageMarginPassengers.add(catalog.passengerIndex);
      const cost = toFils(choice.cost, 'Baggage cost');
      if (!choice.includedInBase) baggageCost += cost;
      baggageOptions.push({ passengerIndex: catalog.passengerIndex, segmentId: catalog.segmentId, selectedId: choice.id,
        options: options.map(o => ({ id: o.id, checkedWeightKg: o.checkedWeightKg, handWeightKg: o.handWeightKg,
          cost: formatAED(toFils(o.cost, 'Baggage cost')), includedInBase: o.includedInBase })) });
    } else {
      ancillaries.push({ type: catalog.type, passengerIndex: catalog.passengerIndex, segmentId: catalog.segmentId,
        optionId: choice.id, available: true, freeOptionAvailable, customerRequested: Boolean(request),
        includedInBase: choice.includedInBase, cost: choice.cost });
    }
  }
  const originalBase = toFils(quote.baseTotal, 'baseTotal');
  if (originalBase + baggageCost > MAX_FILS) throw new RangeError('Baggage-adjusted total is too large');
  const priced = priceAirArabiaQuote({ ...quote, baseTotal: formatAED(originalBase + baggageCost), ancillaries }, env);
  const supplierTotal = originalBase + baggageCost + toFils(priced.ancillaryCostAdded, 'Ancillary costs');
  if (quote.allChargesChecked !== true || toFils(quote.finalPortalTotal, 'Final portal total') !== supplierTotal) {
    throw new RangeError('Final portal review is incomplete or contains unexplained charges');
  }
  // AED 10 once per passenger requesting extra baggage, across the itinerary.
  // Supplier costs are reconciled above; the markup never changes portal cost.
  const baggageMargin = toFils(env.AIR_ARABIA_BAGGAGE_MARGIN_AED ?? '10','Baggage margin') * BigInt(baggageMarginPassengers.size);
  const sellingTotal = toFils(priced.sellingTotal,'Selling total') + baggageMargin;
  if (sellingTotal > MAX_FILS) throw new RangeError('Selling total is too large');
  return { ...priced, sellingTotal:formatAED(sellingTotal),
    totalMargin:formatAED(toFils(priced.totalMargin,'Margin') + baggageMargin), baggageMargin:formatAED(baggageMargin),
    baseTotal: formatAED(originalBase), baggageCostAdded: formatAED(baggageCost),
    verifiedPortalTotal: formatAED(supplierTotal), baggageOptions, selectedServices: ancillaries };
}
module.exports = { buildAirArabiaQuote };
