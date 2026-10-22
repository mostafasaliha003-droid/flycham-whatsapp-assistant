'use strict';
const { toFils, formatAED } = require('./money');

// A diagnostic, never a booking approval or customer quote. In particular,
// arithmetic agreement at the ancillary page cannot prove final fees.
function auditPortalFees(snapshot = {}) {
  const amount = value => {
    try { return formatAED(toFils(value, 'Supplier amount')); }
    catch { return null; }
  };
  const amounts = {};
  for (const key of ['fareTotal', 'displayedTotal', 'originalAdminFee', 'currentAdminFee',
    'originalFareTax', 'currentFareTax', 'ancillaryTax', 'ancillaryTotal']) amounts[key] = amount(snapshot[key]);
  const blockers = ['FINAL_REVIEW_NOT_VERIFIED', 'HAND_BAGGAGE_NOT_VERIFIED'];
  if (snapshot.currency !== 'AED') blockers.push('AED_TOTAL_NOT_VERIFIED');
  if (Object.values(amounts).some(v => v === null)) blockers.push('FEE_COMPONENTS_INCOMPLETE');
  if (snapshot.taxReviewPending !== false) blockers.push('TAX_REVIEW_NOT_COMPLETED');
  const segments = snapshot.selections;
  const servicesSelected = Array.isArray(segments) && segments.length > 0 && segments.length <= 20
    && segments.every(s => s && s.seat === true && s.meal === true && s.baggage === true);
  if (!servicesSelected) blockers.push('SERVICES_NOT_SELECTED');
  let reconstructedTotal = null;
  let displayedMatches = null;
  // Supplier's buildPriceSummary can also include promotions, Flexi and
  // auto-checkin. Without confirming those terms, do not invent a total.
  if (snapshot.simpleFareConfirmed === true && Object.values(amounts).every(v => v !== null)) {
    const f = key => toFils(amounts[key], key);
    let total = f('fareTotal') + f('ancillaryTotal') + f('ancillaryTax')
      + f('currentAdminFee') - f('originalAdminFee');
    if (snapshot.fareTaxRecalculated === true) total += f('currentFareTax') - f('originalFareTax');
    if (total >= 0n) {
      reconstructedTotal = formatAED(total);
      displayedMatches = total === f('displayedTotal');
    }
  }
  if (displayedMatches !== true) blockers.push('DISPLAYED_TOTAL_NOT_RECONCILED');
  return { stage:'ancillary', currency:snapshot.currency === 'AED' ? 'AED' : null,
    amounts, reconstructedTotal, displayedMatches, servicesSelected, blockers,
    allChargesChecked:false, customerQuoteReady:false };
}

async function readPortalFeeAudit(frame) {
  const snapshot = await frame.evaluate(() => {
    // Explicit field allowlist: no passenger objects, PNR, session or URLs.
    const q = UI_tabAnci.jsonFareQuoteSummary || {};
    const scalar = value => (typeof value === 'number' || typeof value === 'string')
      && String(value).length <= 24 && /^\d+(?:\.\d{1,2})?$/.test(String(value)) ? String(value) : null;
    const total = document.getElementById('divAnciTotal');
    const displayed = total && total.getClientRects().length
      ? total.textContent.trim().replace(/,/g,'') : null;
    return {
      currency:q.currency === 'AED' ? 'AED' : null,
      fareTotal:scalar(q.totalPrice), displayedTotal:scalar(displayed),
      originalAdminFee:scalar(q.adminFee), currentAdminFee:scalar(UI_tabAnci.adminFee),
      originalFareTax:scalar(q.totalServiceTax), currentFareTax:scalar(UI_tabAnci.salesTaxForFare),
      ancillaryTax:scalar(UI_tabAnci.salesTaxForServices), ancillaryTotal:scalar(UI_tabAnci.anciTotal),
      taxReviewPending:UI_tabAnci.continueToServiceTaxCalc !== false,
      // Promotions and other terms have not yet been audited individually.
      simpleFareConfirmed:false,
      fareTaxRecalculated:UI_tabAnci.continueToServiceTaxCalc === false && UI_tabAnci.salesTaxForFare !== 0,
      selections:jsAnciSeg.length <= 20 ? jsAnciSeg.map(s => ({
        seat:Array.isArray(s.pax) && s.pax.length === 1 && Boolean(s.pax[0].seat?.seatNumber),
        meal:Array.isArray(s.pax) && s.pax.length === 1 && Number(s.pax[0].meal?.mealQtyTotal) > 0,
        baggage:Array.isArray(s.pax) && s.pax.length === 1 && Number(s.pax[0].baggage?.baggageQtyTotal) > 0,
      })) : null,
    };
  });
  return auditPortalFees(snapshot);
}
module.exports = { auditPortalFees, readPortalFeeAudit };
