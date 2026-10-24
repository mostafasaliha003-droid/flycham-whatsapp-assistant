'use strict';
const {airportCode}=require('./airports');
function flyChamAirportRequests(request){
 const origin=airportCode(request.origin),destination=airportCode(request.destination);
 if(!['SHJ','DXB','AUH','DWC'].includes(origin)||!['DAM','ALP'].includes(destination))return [];
 return ['الشارقة','دبي'].filter(name=>airportCode(name)!==origin).map(name=>({...structuredClone(request),origin:name,provider:'flycham'}));
}
// Company-configured airport coverage narrows where we submit a search. It is
// not evidence of flight inventory on any date. Keep the customer's trip intact.
function airportSearchPlan(request,providers){
 const origin=airportCode(request.origin),destination=airportCode(request.destination);
 const uae=new Set(['SHJ','DXB','AUH','DWC']),syria=new Set(['DAM','ALP','LTK']);
 const side=uae.has(origin)&&syria.has(destination)?'origin':syria.has(origin)&&uae.has(destination)?'destination':null;
 const routing={},requests=[];
 for(const provider of providers){
  if(!side){requests.push({provider,request:{...structuredClone(request),provider},phase:'exact'});continue;}
  const requested=airportCode(request[side]),allowed=provider==='airarabia'?['SHJ','AUH']:['DXB','SHJ'];
  const ordered=allowed.includes(requested)?[requested,...allowed.filter(a=>a!==requested)]:allowed;
  const names={SHJ:'الشارقة',AUH:'أبوظبي',DXB:'دبي',DWC:'آل مكتوم'};
  routing[provider]={requestedAirport:names[requested],airportSide:side,excludedRequested:!allowed.includes(requested),reason:'configured_airport',airports:ordered.map(a=>names[a])};
  for(const code of ordered)requests.push({provider,request:{...structuredClone(request),[side]:names[code],provider},phase:code===requested?'exact':'airports'});
 }
 return {requests,routing};
}
function searchPlanText(request,providers){
 const plan=airportSearchPlan(request,providers);
 return providers.map(p=>{const route=plan.routing[p],label=p==='flycham'?'فلاي شام':'العربية للطيران';return route?label+' '+(route.airportSide==='origin'?'من مطار ':'إلى مطار ')+route.airports.join(' و'):label;}).join('، و');
}
module.exports={flyChamAirportRequests,airportSearchPlan,searchPlanText};
