'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditPortalFees } = require('../src/portal-fee-audit');
const sample = () => ({currency:'AED', fareTotal:'1000', displayedTotal:'1012',
  originalAdminFee:'10', currentAdminFee:'12', originalFareTax:'20', currentFareTax:'25',
  ancillaryTax:'5', ancillaryTotal:'0', fareTaxRecalculated:true,
  simpleFareConfirmed:true, taxReviewPending:false,
  selections:[{seat:true,meal:true,baggage:true}]});

test('reconciles fee deltas without double counting original tax or admin; never approves quote', () => {
  const audit = auditPortalFees(sample());
  assert.equal(audit.reconstructedTotal,'1012.00');
  assert.equal(audit.displayedMatches,true);
  assert.equal(audit.customerQuoteReady,false);
  assert.equal(audit.allChargesChecked,false);
  assert.deepEqual(audit.blockers,['FINAL_REVIEW_NOT_VERIFIED','HAND_BAGGAGE_NOT_VERIFIED']);
});
test('missing amounts and unselected free services remain explicit blockers', () => {
  const s=sample(); s.ancillaryTax=''; s.selections=[{seat:false,meal:false,baggage:false}];
  s.taxReviewPending=true;
  const a=auditPortalFees(s);
  assert.equal(a.amounts.ancillaryTax,null);
  assert.equal(a.reconstructedTotal,null);
  for(const code of ['FEE_COMPONENTS_INCOMPLETE','TAX_REVIEW_NOT_COMPLETED','SERVICES_NOT_SELECTED']) assert.ok(a.blockers.includes(code));
});
test('unreviewed promotions and unexplained totals cannot pass reconciliation', () => {
  assert.equal(auditPortalFees({...sample(),simpleFareConfirmed:false}).reconstructedTotal,null);
  assert.equal(auditPortalFees({...sample(),displayedTotal:'1013'}).displayedMatches,false);
  assert.equal(auditPortalFees({...sample(),currency:'USD'}).currency,null);
});
test('allowlisted output excludes untrusted extra fields and rejects unsafe numeric values', () => {
  const a=auditPortalFees({...sample(),cookie:'secret',passenger:'private',fareTotal:'1e3'});
  assert.equal(a.amounts.fareTotal,null);
  assert.ok(!JSON.stringify(a).includes('secret'));
  assert.ok(!JSON.stringify(a).includes('private'));
});
