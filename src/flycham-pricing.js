'use strict';
const {toFils,formatAED,MAX_FILS}=require('./money');
const TERMS=Object.freeze({one_way:{margin:4000n,voucher:1000n},round_trip:{margin:9000n,voucher:2500n}});
function priceFlyChamQuote({currency,baseTotal,tripType,passengerCount=1,verifiedFirstPage=false}){
 if(currency!=='AED'||verifiedFirstPage!==true)throw Error('FLYCHAM_VERIFIED_AED_TOTAL_REQUIRED');
 if(passengerCount!==1)throw Error('FLYCHAM_PARTY_NOT_VERIFIED');
 const terms=TERMS[tripType];if(!terms)throw Error('FLYCHAM_TRIP_TYPE_REQUIRED');
 const base=toFils(baseTotal,'baseTotal');if(base<=0n||base+terms.margin>MAX_FILS)throw Error('FLYCHAM_TOTAL_INVALID');
 return {provider:'flycham',currency:'AED',tripType,passengerCount,baseTotal:formatAED(base),ticketMargin:formatAED(terms.margin),sellingTotal:formatAED(base+terms.margin),voucherValue:formatAED(terms.voucher),voucherEligibility:'after_confirmed_ticket',pricingSource:'verified-first-page'};
}
function voucherPromise(price){
 if(price.provider!=='flycham'||!TERMS[price.tripType])return '';
 return `🎁 رحلتك معها هدية! مع إتمام حجزك على فلاي شام، إلك فاوجر باسمك بقيمة ${formatAED(TERMS[price.tripType].voucher)} درهم، صالح لسنة من الإصدار. بتستفيد منه بطلب قادم على أي طيران، الفنادق، شرائح الإنترنت أو رسوم التعديل ضمن خدمات مجموعة الرمال. الفاوجر للاستخدام لاحقًا ولا يُخصم من سعر هالحجز.`;
}
module.exports={priceFlyChamQuote,voucherPromise,TERMS};
