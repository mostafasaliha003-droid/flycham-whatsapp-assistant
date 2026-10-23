'use strict';
const {priceFlyChamQuote,voucherPromise}=require('./flycham-pricing');
// Read only the search-results DOM. Never enters passengers, ancillaries or payment.
async function readFlyChamFirstPage(frame,{tripType,passengerCount=1}={}){
 const observed=await frame.evaluate(()=>{
  if(location.origin!=='https://reservations.flycham.com')throw Error('FLYCHAM_UNTRUSTED_ORIGIN');
  const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const total=document.getElementById('divFQTxnCurr');if(!visible(total))throw Error('FLYCHAM_AED_TOTAL_NOT_VISIBLE');
  const text=(total.textContent||'').replace(/\s+/g,' ').trim();
  const amount=text.match(/\bAED\s+([\d,]+\.\d{2})\s*$/);if(!amount)throw Error('FLYCHAM_AED_TOTAL_AMBIGUOUS');
  function flight(tableId,name){const table=document.getElementById(tableId);const radio=table?.querySelector('input[name="'+name+'"]:checked');const row=radio?.closest('tr');if(!row||!visible(row))return null;const text=(row.textContent||'').replace(/\s+/g,' ').trim();const number=text.match(/\bXH\s*\d{1,4}\b/),route=text.match(/\b([A-Z]{3})\s*\/\s*([A-Z]{3})\b/),times=[...text.matchAll(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}[A-Za-z]{3}\d{2}\s+\d{2}:\d{2}/g)].map(m=>m[0]);if(!number||!route||times.length!==2)throw Error('FLYCHAM_FLIGHT_DETAILS_INCOMPLETE');return{flight:number[0].replace(/\s/g,''),origin:route[1],destination:route[2],departure:times[0],arrival:times[1]};}
  return {baseTotal:amount[1].replace(/,/g,''),out:flight('tblOutboundFlights','depatureSelection'),back:flight('tblInboundFlights','returnSelection')};
 });
 if(!observed.out||tripType==='round_trip'&&!observed.back||tripType==='one_way'&&observed.back)throw Error('FLYCHAM_ITINERARY_INCOMPLETE');
 const price=priceFlyChamQuote({currency:'AED',baseTotal:observed.baseTotal,tripType,passengerCount,verifiedFirstPage:true});
 return {provider:'flycham',price,timing:{out:observed.out,back:observed.back},voucherMessage:voucherPromise(price),verifiedAt:new Date().toISOString()};
}
module.exports={readFlyChamFirstPage};
