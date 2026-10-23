'use strict';
const {flyChamBaggageAllowed}=require('./travel-language');
const {priceFlyChamQuote,voucherPromise}=require('./flycham-pricing');
// Read only the search-results DOM. Never enters passengers, ancillaries or payment.
async function readFlyChamFirstPage(frame,{tripType,passengerCount=1,request}={}){
 const observed=await Promise.resolve().then(()=>frame.evaluate(()=>{
  if(location.origin!=='https://reservations.flycham.com')throw Error('FLYCHAM_UNTRUSTED_ORIGIN');
  const visible=e=>e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const total=document.getElementById('divFQTxnCurr');if(!visible(total))throw Error('FLYCHAM_AED_TOTAL_NOT_VISIBLE');
  const text=(total.textContent||'').replace(/\s+/g,' ').trim();
  const amount=text.match(/\bAED\s+([\d,]+\.\d{2})\s*$/);if(!amount)throw Error('FLYCHAM_AED_TOTAL_AMBIGUOUS');
  function flight(tableId,name){const table=document.getElementById(tableId);const radio=table?.querySelector('input[name="'+name+'"]:checked');const row=radio?.closest('tr.jqgrow')||radio?.closest('tr');if(!row||!visible(row))return null;const text=(row.textContent||'').replace(/\s+/g,' ').trim();const number=text.match(/\bXH\s*\d{1,4}\b/),route=text.match(/\b([A-Z]{3})\s*\/\s*([A-Z]{3})\b/),times=[...text.matchAll(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}[A-Za-z]{3}(?:\d{4}|\d{2})\s+\d{2}:\d{2}/g)].map(m=>m[0]);if(!number||!route||times.length!==2)throw Error('FLYCHAM_FLIGHT_DETAILS_INCOMPLETE');return{flight:number[0].replace(/\s/g,''),origin:route[1],destination:route[2],departure:times[0],arrival:times[1]};}
  return {baseTotal:amount[1].replace(/,/g,''),out:flight('tblOutboundFlights','depatureSelection'),back:flight('tblInboundFlights','returnSelection')};
 })).catch(error=>{const code=String(error.message).match(/\bFLYCHAM_(?:UNTRUSTED_ORIGIN|AED_TOTAL_NOT_VISIBLE|AED_TOTAL_AMBIGUOUS|FLIGHT_DETAILS_INCOMPLETE)\b/)?.[0];throw Error(code||'FLYCHAM_FIRST_PAGE_UNCONFIRMED');});
 if(!observed.out||tripType==='round_trip'&&!observed.back||tripType==='one_way'&&observed.back)throw Error('FLYCHAM_ITINERARY_INCOMPLETE');
 if(request){
  const codes=new Map([['الشارقة','SHJ'],['الشارقه','SHJ'],['SHJ','SHJ'],['دمشق','DAM'],['DAM','DAM']]);
  const date=value=>{const m=String(value).match(/\b(\d{1,2})([A-Za-z]{3})(\d{4}|\d{2})\b/);if(!m)return null;const month=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].findIndex(x=>x.toLowerCase()===m[2].toLowerCase())+1;return month?`${m[3].length===2?"20"+m[3]:m[3]}-${String(month).padStart(2,'0')}-${m[1].padStart(2,'0')}`:null;};
  const origin=codes.get(request.origin),destination=codes.get(request.destination);
  if(!origin||!destination||observed.out.origin!==origin||observed.out.destination!==destination||date(observed.out.departure)!==request.departureDate||request.tripType!==tripType||!flyChamBaggageAllowed(request))throw Error('FLYCHAM_REQUEST_NOT_MATCHED');
  if(tripType==='round_trip'&&(observed.back.origin!==destination||observed.back.destination!==origin||date(observed.back.departure)!==request.returnDate))throw Error('FLYCHAM_REQUEST_NOT_MATCHED');
 }
 const price=priceFlyChamQuote({currency:'AED',baseTotal:observed.baseTotal,tripType,passengerCount,verifiedFirstPage:true});
 price.weights=[{kg:30,handKg:10,source:'operator-standard-policy'}];
 return {provider:'flycham',price,timing:{out:observed.out,back:observed.back},voucherMessage:voucherPromise(price),verifiedAt:new Date().toISOString()};
}
module.exports={readFlyChamFirstPage};
