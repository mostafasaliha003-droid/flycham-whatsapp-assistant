'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFlyChamFirstPage}=require('../src/flycham-first-page');
function frame({total='ER: AED 1.00 = USD 0.2717 AED 643.00',origin='https://reservations.flycham.com',back=false}={}){
 const row={textContent:'SHJ/DAM i XH744 XH Wed 11Nov26 05:30 Wed 11Nov26 08:00 1+/1+',getClientRects:()=>[1]},ret={...row,textContent:'DAM/SHJ i XH745 XH Wed 18Nov26 09:00 Wed 18Nov26 13:30 1+/1+'};
 const nodes={divFQTxnCurr:{textContent:total,getClientRects:()=>[1]},tblOutboundFlights:{querySelector:()=>({closest:()=>row})},...(back?{tblInboundFlights:{querySelector:()=>({closest:()=>ret})}}:{})};
 return {evaluate:fn=>vm.runInNewContext('('+fn.toString()+')()',{location:{origin},document:{getElementById:id=>nodes[id]},getComputedStyle:()=>({visibility:'visible'})})};
}
test('first page uses the displayed AED final equivalent, not USD or the AED 1 exchange-rate numerator',async()=>{const q=await readFlyChamFirstPage(frame(),{tripType:'one_way'});assert.equal(q.price.baseTotal,'643.00');assert.equal(q.price.sellingTotal,'683.00');assert.equal(q.timing.out.flight,'XH744');assert.match(q.timing.out.departure,/05:30/);});
test('return quote carries both timings, 90 margin and 25 future gift',async()=>{const q=await readFlyChamFirstPage(frame({back:true}),{tripType:'round_trip'});assert.equal(q.price.sellingTotal,'733.00');assert.equal(q.price.voucherValue,'25.00');assert.equal(q.timing.back.flight,'XH745');});
test('unknown currency, foreign origin, missing return or inconsistent itinerary cannot become a quote',async()=>{await assert.rejects(readFlyChamFirstPage(frame({total:'USD 174.69'}),{tripType:'one_way'}));await assert.rejects(readFlyChamFirstPage(frame({origin:'https://other.example'}),{tripType:'one_way'}));await assert.rejects(readFlyChamFirstPage(frame(),{tripType:'round_trip'}));await assert.rejects(readFlyChamFirstPage(frame({back:true}),{tripType:'one_way'}));});
