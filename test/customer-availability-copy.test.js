'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderComparison}=require('../src/quote-comparison');
function parent(status,otherOffer=false){return {providers:['flycham','airarabia'],request:{origin:'AUH',destination:'DAM',departureRange:{start:'2026-10-26',end:'2026-11-01'},tripType:'one_way'},children:[{provider:'flycham',phase:'exact',status,offers:[]},{provider:'airarabia',phase:'exact',status:otherOffer?'available':'unverified',offers:otherOffer?[{reference:1,provider:'airarabia',request:{origin:'أبوظبي',destination:'دمشق',departureDate:'2026-10-26'},timing:{out:{flight:'TEST1',departure:'10:00',arrival:'12:00'}},price:{sellingTotal:'700.00',weights:[{kg:30}]},checkedAt:Date.now()}]:[]}]};}
test('confirmed negative names airline and bounded period, suggests airports without inventing availability',()=>{const text=renderComparison(parent('no_flights'));assert.match(text,/من مطار أبوظبي إلى مطار دمشق على فلاي شام/);assert.match(text,/هالشركة والفترة/);assert.match(text,/دبي أو الشارقة/);assert.doesNotMatch(text,/لقيتلك بديل متأكد|البوابة|نتائج المصدر/);});
test('confirmed other airline offer can be highlighted',()=>{assert.match(renderComparison(parent('no_flights',true)),/لقيتلك بديل متأكد على العربية للطيران من أبوظبي/);});
test('technical uncertainty never becomes an inventory statement',()=>{for(const status of ['unverified','auth_required']){const text=renderComparison(parent(status));assert.doesNotMatch(text,/ما في رحلات متاحة|لقيتلك بديل متأكد|دبي أو الشارقة|البوابة/);}});
test('a confirmed offer from another airport or outside the period is never highlighted as the requested route',()=>{
 for(const mismatch of ['airport','date']){const p=parent('no_flights',true),o=p.children[1].offers[0];if(mismatch==='airport')o.request.origin='الشارقة';else o.request.departureDate='2026-11-15';const text=renderComparison(p);assert.doesNotMatch(text,/لقيتلك بديل متأكد على العربية للطيران من أبوظبي/);}
});
