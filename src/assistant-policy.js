'use strict';
const {airportCode,AIRPORTS}=require('./airports');
const {flyChamBaggageAllowed}=require('./travel-language');
const POLICY=Object.freeze({version:'2026-10-23.5',name:'أحمد',company:'مجموعة الرمال',askPassengerCount:true,discountAllowed:false,ticketMarginAED:25,extraWeightMarginAED:10,paidSeatMarginAED:10,paidMealMarginAED:5,bookingByHumanOnly:true,providers:process.env.FLYCHAM_PORTAL_ENABLED==='true'?['airarabia','flycham']:['airarabia'],futureProviders:process.env.FLYCHAM_PORTAL_ENABLED==='true'?[]:['flycham'],supportedAirports:Object.keys(AIRPORTS),maxAdults:1,childrenSupported:false});
function capabilityIssue(r){
 const origin=airportCode(r.origin),destination=airportCode(r.destination);
 if(!origin||!destination||origin===destination)return 'route';
 if(r.passengers?.adults!==1||r.passengers.children||r.passengers.infants)return 'passengers';
 if(r.provider==='flycham'&&!flyChamBaggageAllowed(r))return 'constraints';
 if(r.seatRequest||r.baggageRequest?.pieces||r.baggageRequest?.scope==='total'||r.constraints)return 'constraints';
 return null;
}
module.exports={POLICY,capabilityIssue};
