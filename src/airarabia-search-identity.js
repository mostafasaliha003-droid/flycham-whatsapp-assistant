'use strict';

// Grounded in the cached supplier tabSearchFlight28102018.js:
// returnCallSearchFlight assigns objResSrchParams/flight arrays from the same
// response; searchOnClick/its callback maintain searchStartTime/searchEndTime.
// No search, booking, supplier-global mutation or guessed API field is used.
function captureSearchBaselineAction(){
 if(location.origin!=='https://agents.airarabia.com')return null;
 const ui=typeof UI_tabSearchFlights==='undefined'?null:UI_tabSearchFlights;
 if(!ui)return null;
 const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 return {startedAt:number(ui.searchStartTime),endedAt:number(ui.searchEndTime)};
}

// false means a matching fresh response has not completed. A terminal
// unverified result never becomes NO_FLIGHTS_CONFIRMED, including empty arrays
// left over from an older or failed search. Everything returned is a fixed
// classification or count; source payloads and RPH strings remain in the frame.
function searchIdentityAction({expected,baseline,selected=null}){
 const reject=reason=>({status:'unverified',reason});
 if(location.origin!=='https://agents.airarabia.com')return reject('UNTRUSTED');
 const ui=typeof UI_tabSearchFlights==='undefined'?null:UI_tabSearchFlights;
 if(!ui||typeof jQuery==='undefined')return false;
 const integer=v=>Number.isSafeInteger(v)&&v>=0;
 const started=ui.searchStartTime,ended=ui.searchEndTime;
 if(!integer(started)||!integer(ended)||started<=(baseline.startedAt??-1)||ended<=(baseline.endedAt??-1)||ended<started||jQuery.active!==0)return false;
 const response=ui.latestResponse,p=ui.objResSrchParams;
 if(!response||response.success!==true)return reject('RESPONSE');
 if(!p||p!==response.searchParams)return reject('PARAMETERS');
 const out=typeof jsonOutFlts==='undefined'?null:jsonOutFlts;
 const back=typeof jsonRetFlts==='undefined'?null:jsonRetFlts;
 if(!Array.isArray(out)||!Array.isArray(back)||out!==response.outboundFlights||back!==response.returnFlights)return reject('ARRAY_BINDING');
 const code=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v.trim().toUpperCase())?v.trim().toUpperCase():null;
 if(code(p.fromAirport)!==expected.origin||code(p.toAirport)!==expected.destination)return reject('ROUTE');
 const returnDate=p.returnDate===null?'':p.returnDate;
 if(p.departureDate!==expected.departureDate||returnDate!==(expected.returnDate||''))return reject('DATE');
 const count=v=>Number.isInteger(v)?v:typeof v==='string'&&/^\d+$/.test(v)?Number(v):NaN;
 if(count(p.adultCount)!==1||count(p.childCount)!==0||count(p.infantCount)!==0)return reject('PARTY');
 if(p.selectedCurrency!=='AED'||p.selectedCurrency!==expected.currency)return reject('CURRENCY');
 if(p.searchSystem!==expected.carrier.value)return reject('SEARCH_SYSTEM');
 if(ui.strOutDate!==expected.departureDate||ui.strRetDate!==(expected.returnDate||''))return reject('DATE');
 if(!expected.returnDate&&back.length)return reject('TRIP_KIND');
 const calendar=(year,month,day)=>{
  const d=new Date(Date.UTC(year,month-1,day));
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day;
 };
 const dateFromRPH=ref=>{
  // inOutFlightRPHList uses split('$')[3].substr(0,8) as YYYYMMDD.
  if(typeof ref!=='string'||!ref.length||ref.length>1000)return null;
  const token=ref.split('$')[3],m=token&&token.match(/^(\d{4})(\d{2})(\d{2})/);
  if(!m||!calendar(+m[1],+m[2],+m[3]))return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
 };
 const compactDate=(value,date)=>{
  // Supplier _getDate reads YYMMDDHHmm with substr(). Its two-digit Date
  // constructor has a century bug, so validate against the RPH's full year.
  if(typeof value!=='string'||value.length<10||value.length>120||!/^\d{10}/.test(value))return false;
  const [day,month,year]=date.split('/');
  return value.slice(0,6)===year.slice(2)+month+day&&+value.slice(6,8)<24&&+value.slice(8,10)<60;
 };
 const flight=value=>typeof value==='string'?value.toUpperCase().replace(/[\s-]+/g,''):null;
 const records=new Map();
 const checkRows=(rows,from,to,date,leg)=>{
  if(rows.length>200)return 'ROWS';
  for(let index=0;index<rows.length;index++){
   const row=rows[index],keys=['segmentCodeList','flightNoList','carrierList','depatureTimeList','flightRPHList'];
   if(!row||keys.some(k=>!Array.isArray(row[k])))return 'ROWS';
   const length=row.flightRPHList.length;
   if(!length||length>8||keys.some(k=>row[k].length!==length))return 'ROWS';
   let last=from;const rowRefs=new Set();
   for(let segment=0;segment<length;segment++){
    const route=typeof row.segmentCodeList[segment]==='string'?row.segmentCodeList[segment].split('/'):[];
    if(route.length<2||route.length>8||route.some(token=>code(token)!==token)||route[0]!==last)return 'ROW_ROUTE';
    last=route.at(-1);
    const ref=row.flightRPHList[segment],refDate=dateFromRPH(ref);
    if(!refDate||!compactDate(row.depatureTimeList[segment],refDate)||segment===0&&refDate!==date)return 'ROW_DATE';
    const carrier=row.carrierList[segment],number=flight(row.flightNoList[segment]);
    // Search All is not carrier evidence. Until a live codeshare model has
    // been verified, require the explicit raw carrier and flight designator.
    if(carrier!==expected.carrier.carrier||!number||!new RegExp('^'+expected.carrier.carrier+'\\d{1,4}$').test(number))return 'ROW_CARRIER';
    if(Array.isArray(row.csOcCarrierList)&&row.csOcCarrierList[segment]!=null&&row.csOcCarrierList[segment]!==''&&row.csOcCarrierList[segment]!==carrier)return 'CODESHARE';
    if(rowRefs.has(ref))return 'ROW_REFERENCE';rowRefs.add(ref);
    records.set(leg+':'+(index+1)+':'+ref,{leg,row:index+1,segment,route:row.segmentCodeList[segment],flight:row.flightNoList[segment],carrier});
   }
   if(last!==to)return 'ROW_ROUTE';
  }
  return null;
 };
 let reason=checkRows(out,expected.origin,expected.destination,expected.departureDate,'out');
 if(!reason&&expected.returnDate)reason=checkRows(back,expected.destination,expected.origin,expected.returnDate,'back');
 if(reason)return reject(reason);
 if(selected){
  const selectedRefs=[],selectedRecords=new Map();
  for(const [leg,rows]of [['out',out],['back',back]]){
   const chosen=selected[leg];if(!chosen){if(leg==='back'&&!expected.returnDate)continue;return reject('SELECTED_ROW');}
   if(!Number.isInteger(chosen.row)||chosen.row<1||chosen.row>rows.length)return reject('SELECTED_ROW');
   const row=rows[chosen.row-1];
   const displayedFlight=flight(chosen.flight),actualFlight=row.flightNoList.map(flight).join('');
   if(displayedFlight!==actualFlight)return reject('SELECTED_FLIGHT');
   selectedRefs.push(...row.flightRPHList);for(const ref of row.flightRPHList)selectedRecords.set(ref,records.get(leg+':'+chosen.row+':'+ref));
  }
  const info=ui.flightInfo;
  if(!Array.isArray(info)||info.length!==selectedRefs.length||new Set(selectedRefs).size!==selectedRefs.length)return reject('SELECTED_REFERENCES');
  const seen=new Set();
  for(const segment of info){
   const ref=segment?.flightRefNumber,record=selectedRecords.get(ref);
   if(!record||!selectedRefs.includes(ref)||seen.has(ref)||segment.orignNDest!==record.route||segment.airLine!==record.carrier||flight(segment.flightNo)!==flight(record.flight))return reject('SELECTED_REFERENCES');
   seen.add(ref);
  }
 }
 return {status:'confirmed',outbound:out.length,inbound:back.length};
}

function validExpected(expected){
 if(!expected||!['G9','3L'].includes(expected.carrier?.carrier)||!['EXPLICIT','SEARCH_ALL'].includes(expected.carrier.mode)||typeof expected.carrier.value!=='string'||!expected.carrier.value.length||expected.carrier.value.length>80||expected.currency!=='AED')return false;
 if(expected.carrier.mode==='SEARCH_ALL'&&expected.carrier.carrier!=='3L')return false;
 if((expected.origin==='AUH'||expected.destination==='AUH')!==(expected.carrier.carrier==='3L'))return false;
 const airports=['SHJ','AUH','DAM','ALP','DXB','DWC'];
 if(!airports.includes(expected.origin)||!airports.includes(expected.destination)||expected.origin===expected.destination)return false;
 const date=value=>typeof value==='string'&&/^\d{2}\/\d{2}\/\d{4}$/.test(value)&&(()=>{const [d,m,y]=value.split('/').map(Number),v=new Date(Date.UTC(y,m-1,d));return v.getUTCFullYear()===y&&v.getUTCMonth()===m-1&&v.getUTCDate()===d;})();
 return date(expected.departureDate)&&(expected.returnDate==null||date(expected.returnDate));
}
function payload(expected,baseline,selected){
 if(!validExpected(expected)||!baseline||!['startedAt','endedAt'].every(k=>baseline[k]===null||Number.isSafeInteger(baseline[k])&&baseline[k]>=0))throw Error('SEARCH_IDENTITY_UNVERIFIED');
 return {expected:structuredClone(expected),baseline:{startedAt:baseline.startedAt,endedAt:baseline.endedAt},selected:selected?structuredClone(selected):null};
}
function verify(result,report=()=>{}){
 if(result?.status!=='confirmed'){
  const reason=typeof result?.reason==='string'&&/^[A-Z_]{1,40}$/.test(result.reason)?result.reason:'INCOMPLETE';
  report('PORTAL_SEARCH_IDENTITY_'+reason);throw Error('SEARCH_IDENTITY_UNVERIFIED');
 }
 return result;
}
async function captureSearchBaseline(frame){
 const result=await frame.evaluate(captureSearchBaselineAction);
 if(!result||!['startedAt','endedAt'].every(k=>result[k]===null||Number.isSafeInteger(result[k])&&result[k]>=0))throw Error('SEARCH_IDENTITY_UNVERIFIED');
 return {startedAt:result.startedAt,endedAt:result.endedAt};
}
async function waitForSearchIdentity(frame,expected,baseline,{report=()=>{},timeoutMs=45000}={}){
 let handle;
 try{
  handle=await frame.waitForFunction(searchIdentityAction,payload(expected,baseline),{timeout:timeoutMs});
  const result=await handle.jsonValue();verify(result,report);report('PORTAL_SEARCH_IDENTITY_CONFIRMED');return result;
 }catch(error){if(error?.message==='SEARCH_IDENTITY_UNVERIFIED')throw error;report('PORTAL_SEARCH_IDENTITY_INCOMPLETE');throw Error('SEARCH_IDENTITY_UNVERIFIED');}
 finally{await handle?.dispose?.().catch(()=>{});}
}
async function assertSearchIdentity(frame,expected,baseline,{selected=null,report=()=>{}}={}){
 try{return verify(await frame.evaluate(searchIdentityAction,payload(expected,baseline,selected)),report);}
 catch(error){if(error?.message==='SEARCH_IDENTITY_UNVERIFIED')throw error;report('PORTAL_SEARCH_IDENTITY_INCOMPLETE');throw Error('SEARCH_IDENTITY_UNVERIFIED');}
}
module.exports={captureSearchBaseline,waitForSearchIdentity,assertSearchIdentity,captureSearchBaselineAction,searchIdentityAction};
