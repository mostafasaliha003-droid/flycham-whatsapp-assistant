'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/saudi-visa-policy');
const {touristQuoteCopy,touristPriceOverview,touristInsuranceCopy,visaRefundCopy,REFUND_COPY,INSURANCE_REFUND_COPY}=require('../src/visa-price-copy');
const quote=(ages,options={})=>P.calculateQuote({applicantCount:ages.length,applicants:ages.map(age=>({nationality:'سوريا',documentType:'passport',...(age===undefined?{}:{age})})),paymentMethod:options.paymentMethod||'bank'},{feesEnabled:options.feesEnabled!==false,agePricing:true});

test('tourist quote separates approved visa fees and mandatory senior insurance before the total',()=>{
 const q=quote([54]),before=structuredClone(q),copy=touristQuoteCopy(q);
 assert.match(copy,/640 درهم رسوم تأشيرة \+ 190 درهم تأمين طبي إلزامي/);
 assert.match(copy,/المجموع: 830 درهم/);assert.ok(copy.includes(REFUND_COPY.ar));assert.ok(copy.includes(INSURANCE_REFUND_COPY.ar));
 assert.doesNotMatch(copy,/اختياري|غير مسترد|كل المبلغ مسترد|830.*مسترد بالكامل/);assert.deepEqual(q,before);
 for(const language of ['en','fr']){
  const localized=touristQuoteCopy(q,{language});assert.match(localized,/640/);assert.match(localized,/190/);assert.match(localized,/830/);assert.ok(localized.includes(REFUND_COPY[language]));assert.ok(localized.includes(INSURANCE_REFUND_COPY[language]));assert.doesNotMatch(localized,/\p{Script=Arabic}/u);
 }
});

test('unknown and exactly 53 quotes request review without presenting a final total',()=>{
 const unknown=quote([undefined]),boundary=quote([53]);
 for(const language of ['ar','en','fr']){
  const missing=touristQuoteCopy(unknown,{language}),exact=touristQuoteCopy(boundary,{language});
  assert.match(missing,/640/);assert.match(missing,/190/);assert.equal((missing.match(/[؟?]/g)||[]).length,1);
  assert.match(exact,/53/);assert.match(exact,/640/);assert.doesNotMatch(exact,/830|190/);assert.equal((exact.match(/[؟?]/g)||[]).length,0);
  for(const text of [missing,exact])assert.doesNotMatch(text,/\*المجموع:|\*Total\s*:/);
 }
 const group=touristQuoteCopy(quote([40,undefined,53]));assert.match(group,/المتقدم 2/);assert.match(group,/عمر 53/);assert.doesNotMatch(group,/المجموع:|1920|2110/);
 assert.doesNotMatch(touristQuoteCopy(unknown,{includeNextStep:false}),/[؟?]/);
});

test('group and payment method totals use the approved quote without concealing the surcharge',()=>{
 const group=quote([40,54]),copy=touristQuoteCopy(group);assert.match(copy,/المتقدم 1:[^\n]+\n640/);assert.match(copy,/المتقدم 2:[^\n]+\n640.*190.*830/);assert.match(copy,/المجموع: 1,470/);
 const link=quote([54],{paymentMethod:'link'});assert.equal(link.total,871.5);assert.match(touristQuoteCopy(link),/رسوم وسيلة الدفع: 41.5/);assert.match(touristQuoteCopy(link),/المجموع: 871.5/);
 const pending=touristQuoteCopy(quote([54],{paymentMethod:'link',feesEnabled:false}));assert.match(pending,/المجموع قبل رسوم وسيلة الدفع: 830/);assert.doesNotMatch(pending,/\*المجموع:/);
});

test('refund question gives a direct visa-fee answer and leaves insurance refund terms unresolved',()=>{
 for(const [language,yes] of [['ar',/^نعم/],['en',/^Yes\./],['fr',/^Oui\./]]){
  const basic=visaRefundCopy({language}),insurance=visaRefundCopy({language,insuranceQuestion:true});
  assert.match(basic,yes);assert.ok(basic.includes(REFUND_COPY[language]));assert.ok(!basic.includes(INSURANCE_REFUND_COPY[language]));assert.ok(insurance.includes(INSURANCE_REFUND_COPY[language]));
  assert.doesNotMatch(insurance,/غير مسترد|non.refundable|non remboursable|يشمل التأمين|including insurance/);
 }
});

test('incomplete price and insurance replies respect the exact age boundary without inventing a total',()=>{
 for(const language of ['ar','en','fr']){
  const unknown=touristPriceOverview({language});assert.match(unknown,/640/);assert.match(unknown,/190/);assert.equal((unknown.match(/[؟?]/g)||[]).length,1);assert.doesNotMatch(unknown,/830/);
  const exact=touristPriceOverview({age:53,language});assert.match(exact,/53/);assert.doesNotMatch(exact,/830|190/);
  const senior=touristInsuranceCopy({age:54,language});assert.match(senior,/190/);assert.doesNotMatch(senior,/optional|facultative|اختياري/);
  const young=touristInsuranceCopy({age:40,language});assert.match(young,/190/);assert.doesNotMatch(young,/830/);
 }
 assert.equal(touristPriceOverview({age:12}),null);assert.equal(touristInsuranceCopy({age:12}),null);
});

test('new renderer leaves child, Umrah, mixed and legacy quote paths to existing code',()=>{
 assert.equal(touristQuoteCopy(quote([12])),null);
 const umrah=P.calculateQuote({applicantCount:1,applicants:[{nationality:'فلسطين',documentType:'travel_document',age:54}]},{feesEnabled:true,agePricing:true});assert.equal(touristQuoteCopy(umrah),null);
 const mixed=P.calculateQuote({applicantCount:2,applicants:[{nationality:'سوريا',documentType:'passport',age:54},{nationality:'فلسطين',documentType:'passport',age:40}]},{feesEnabled:true,agePricing:true});assert.equal(touristQuoteCopy(mixed),null);
 const legacy=P.calculateQuote({applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}]},{feesEnabled:true});assert.equal(touristQuoteCopy(legacy),null);
 assert.equal(touristQuoteCopy(null),null);
});
