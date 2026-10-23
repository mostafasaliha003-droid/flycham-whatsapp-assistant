'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFlyChamFirstPage}=require('../src/flycham-first-page');
function frame({total='ER: AED 1.00 = USD 0.2717 AED 643.00',origin='https://reservations.flycham.com',back=false,fullYear=false,spaced=false}={}){
 const row={textContent:'SHJ/DAM i XH744 XH Wed 11Nov26 05:30 Wed 11Nov26 08:00 1+/1+',getClientRects:()=>[1]},ret={...row,textContent:'DAM/SHJ i XH745 XH Wed 18Nov26 09:00 Wed 18Nov26 13:30 1+/1+'};
 if(spaced)row.textContent=row.textContent.replaceAll('11Nov26','11 Nov 2026').replace('SHJ/DAM','SHJ - DAM');
 if(fullYear)row.textContent=row.textContent.replaceAll('Nov26','Nov2026');
 const nodes={divFQTxnCurr:{textContent:total,getClientRects:()=>[1]},tblOutboundFlights:{querySelector:()=>({closest:()=>row})},...(back?{tblInboundFlights:{querySelector:()=>({closest:()=>ret})}}:{})};
 return {evaluate:fn=>vm.runInNewContext('('+fn.toString()+')()',{location:{origin},document:{getElementById:id=>nodes[id]},getComputedStyle:()=>({visibility:'visible'})})};
}
test('first page uses the displayed AED final equivalent, not USD or the AED 1 exchange-rate numerator',async()=>{const q=await readFlyChamFirstPage(frame(),{tripType:'one_way'});assert.equal(q.price.baseTotal,'643.00');assert.equal(q.price.sellingTotal,'683.00');assert.equal(q.timing.out.flight,'XH744');assert.match(q.timing.out.departure,/05:30/);});
test('return quote carries both timings, 90 margin and 25 future gift',async()=>{const q=await readFlyChamFirstPage(frame({back:true}),{tripType:'round_trip'});assert.equal(q.price.sellingTotal,'733.00');assert.equal(q.price.voucherValue,'25.00');assert.equal(q.timing.back.flight,'XH745');});
test('unknown currency, foreign origin, missing return or inconsistent itinerary cannot become a quote',async()=>{await assert.rejects(readFlyChamFirstPage(frame({total:'USD 174.69'}),{tripType:'one_way'}));await assert.rejects(readFlyChamFirstPage(frame({origin:'https://other.example'}),{tripType:'one_way'}));await assert.rejects(readFlyChamFirstPage(frame(),{tripType:'round_trip'}));await assert.rejects(readFlyChamFirstPage(frame({back:true}),{tripType:'one_way'}));});

test('first-page total must match the requested route and dates before it can be quoted',async()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'};
 const q=await readFlyChamFirstPage(frame(),{tripType:'one_way',request});assert.equal(q.price.sellingTotal,'683.00');
 await assert.rejects(readFlyChamFirstPage(frame(),{tripType:'one_way',request:{...request,departureDate:'2026-11-12'}}),/FLYCHAM_REQUEST_NOT_MATCHED/);
 await assert.rejects(readFlyChamFirstPage(frame(),{tripType:'one_way',request:{...request,origin:'دمشق',destination:'الشارقة'}}),/FLYCHAM_REQUEST_NOT_MATCHED/);
 await assert.rejects(readFlyChamFirstPage(frame(),{tripType:'one_way',request:{...request,baggageRequest:{checkedWeightKg:40}}}),/FLYCHAM_REQUEST_NOT_MATCHED/);
});

test('FlyCham supplier dates can use a four-digit year without losing request validation',async()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'};const q=await readFlyChamFirstPage(frame({fullYear:true}),{tripType:'one_way',request});assert.equal(q.price.sellingTotal,'683.00');assert.match(q.timing.out.departure,/2026/);
});

test('Playwright-prefixed page errors retain only the known safe failure code',async()=>{
 const f={evaluate:async()=>{throw Error('frame.evaluate: Error: FLYCHAM_FLIGHT_DETAILS_INCOMPLETE at private-page-details');}};await assert.rejects(readFlyChamFirstPage(f,{tripType:'one_way'}),error=>error.message==='FLYCHAM_FLIGHT_DETAILS_INCOMPLETE');
});

test('supplier-spaced dates and explicit hyphenated airport pairs remain request-verified',async()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way'};const q=await readFlyChamFirstPage(frame({spaced:true}),{tripType:'one_way',request});assert.equal(q.timing.out.origin,'SHJ');assert.equal(q.price.sellingTotal,'683.00');
});
