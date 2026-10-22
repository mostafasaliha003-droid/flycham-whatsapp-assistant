'use strict';
const POLICY=Object.freeze({version:'2026-10-23.1',name:'أحمد',company:'مجموعة الرمال',askPassengerCount:true,discountAllowed:false,ticketMarginAED:25,extraWeightMarginAED:10,paidSeatMarginAED:10,paidMealMarginAED:5,bookingByHumanOnly:true,providers:['airarabia'],futureProviders:['flycham'],supportedAirports:['SHJ','DAM'],maxAdults:1,childrenSupported:false});
function capabilityIssue(r){
 const codes=new Map([['الشارقة','SHJ'],['الشارقه','SHJ'],['SHJ','SHJ'],['Sharjah','SHJ'],['دمشق','DAM'],['DAM','DAM'],['Damascus','DAM']]);
 if(!codes.has(r.origin)||!codes.has(r.destination)||codes.get(r.origin)===codes.get(r.destination))return 'route';
 if(r.passengers?.adults!==1||r.passengers.children||r.passengers.infants)return 'passengers';
 if(r.seatRequest||r.baggageRequest?.pieces||r.baggageRequest?.scope==='total'||r.constraints)return 'constraints';
 return null;
}
module.exports={POLICY,capabilityIssue};
