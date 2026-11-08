'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/saudi-visa-policy');
const tourist=age=>({nationality:'سوريا',documentType:'passport',...(age===undefined?{}:{age})});
const make=(applicants,paymentMethod='bank')=>({applicantCount:applicants.length,applicants,paymentMethod});
const quote=(people,options={})=>P.calculateQuote(make(people,options.paymentMethod),{agePricing:true,feesEnabled:options.feesEnabled===true});

test('tourist age pricing applies compulsory insurance only above the confirmed threshold',()=>{
 assert.equal(P.TOURIST_AGE_THRESHOLD,53);assert.equal(P.TOURIST_INSURANCE_SURCHARGE,190);
 for(const [age,total,surcharge] of [[18,640,0],[30,640,0],[52,640,0],[54,830,190],[75,830,190],[119,830,190]]){
  const q=quote([tourist(age)]);assert.equal(q.total,total,String(age));assert.equal(q.rows[0].baseAmount,640);assert.equal(q.rows[0].insuranceSurcharge,surcharge);assert.equal(q.rows[0].amount,total);assert.equal(q.visaSubtotal,640);assert.equal(q.insuranceSubtotal,surcharge);assert.equal(q.policyVersion,P.AGE_PRICING_POLICY_VERSION);
  assert.equal(P.touristInsuranceApplies(tourist(age)),age>53);assert.equal(P.touristAgeNeedsReview(tourist(age)),false);
  if(surcharge)assert.equal(q.insuranceRefundPolicy,'pending_confirmation');else assert.equal(q.insuranceRefundPolicy,undefined);
 }
 const egypt=quote([{nationality:'مصر',documentType:'passport',age:54}]);assert.equal(egypt.total,830);assert.equal(egypt.rows[0].product,'tourist_single');
});

test('unknown invalid and exactly 53 ages cannot yield a finalized tourist amount',()=>{
 for(const [age,reason] of [[undefined,'tourist_age_required'],[null,'tourist_age_required'],['54','tourist_age_required'],[52.5,'tourist_age_required'],[120,'tourist_age_required'],[Infinity,'tourist_age_required'],[NaN,'tourist_age_required'],[53,'tourist_age_53_review']]){
  const q=quote([tourist(age)]);assert.equal(q.requiresReview,true,String(age));assert.equal(q.reason,reason);assert.equal(q.total,undefined);assert.equal(q.subtotal,undefined);assert.equal(q.paymentFee,undefined);assert.equal(q.rows,undefined);assert.equal(q.baseTouristAmount,640);assert.equal(q.insuranceSurchargeAmount,190);assert.deepEqual(q.ageReviewApplicants,[1]);assert.deepEqual(q.ageReviewDetails,[{applicant:1,reason}]);assert.equal(P.touristAgeReviewReason(tourist(age)),reason);
 }
 const group=quote([tourist(40),tourist(),tourist(53)]);assert.deepEqual(group.ageReviewApplicants,[2,3]);assert.equal(group.reason,'tourist_age_required');assert.equal(group.total,undefined);
});

test('insurance is per applicant and payment fees apply to the complete confirmed subtotal',()=>{
 const q=quote([tourist(52),tourist(54),tourist(70)]);assert.equal(q.visaSubtotal,1920);assert.equal(q.insuranceSubtotal,380);assert.equal(q.subtotal,2300);assert.equal(q.total,2300);assert.deepEqual(q.rows.map(row=>row.insuranceSurcharge),[0,190,190]);assert.equal(q.groupDiscount,false);
 for(const [method,fee,total] of [['bank',0,830],['link',41.5,871.5],['tabby',74.7,904.7]]){
  const paid=quote([tourist(54)],{paymentMethod:method,feesEnabled:true});assert.equal(paid.paymentFee,fee);assert.equal(paid.total,total);assert.equal(paid.insuranceSubtotal,190);assert.equal(paid.feePending,false);
 }
 const pending=quote([tourist(54)],{paymentMethod:'tabby'});assert.equal(pending.total,830);assert.equal(pending.paymentFee,0);assert.equal(pending.feePending,true);
});

test('children and Umrah retain their existing pricing decisions',()=>{
 const child=quote([tourist(12)]);assert.equal(child.reason,'child_pricing');assert.equal(child.total,undefined);
 const minorCase=P.calculateQuote({...make([tourist(30)]),hasMinors:true},{agePricing:true});assert.equal(minorCase.reason,'child_pricing');
 for(const age of [undefined,53,75]){
  const person={nationality:'العراق',documentType:'passport',...(age===undefined?{}:{age})},q=quote([person]);assert.equal(q.total,850);assert.equal(q.insuranceSubtotal,0);assert.equal(P.touristAgeReviewReason(person),null);assert.equal(P.touristInsuranceApplies(person),false);
 }
 const mixed=quote([tourist(54),{nationality:'فلسطين',documentType:'travel_document'}]);assert.equal(mixed.total,1680);assert.equal(mixed.visaSubtotal,1490);assert.equal(mixed.insuranceSubtotal,190);assert.equal(mixed.mixedGroupReview,true);
});

test('age pricing is opt-in and disabled quotes preserve the legacy contract',()=>{
 for(const people of [[tourist()],[tourist(53)],[tourist(75)],[tourist(40),tourist(75)]]){
  const c=make(people,'tabby'),legacy=P.calculateQuote(c,{feesEnabled:true}),disabled=P.calculateQuote(c,{feesEnabled:true,agePricing:false});assert.deepEqual(disabled,legacy);assert.equal(legacy.total,Math.round(people.length*640*1.09*100)/100);assert.equal(legacy.policyVersion,P.POLICY_VERSION);
  assert.deepEqual(Object.keys(legacy).sort(),['policyVersion','rows','subtotal','paymentFee','total','paymentMethod','groupDiscount','mixedGroupReview','feePending','courierIncluded','currency'].sort());
  for(const row of legacy.rows)assert.deepEqual(Object.keys(row).sort(),['applicant','product','label','amount'].sort());
 }
});
