'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFlightTimes,flightPairs}=require('../src/portal-flight-times');
const {expandLiveRequests,formatQuoteOptions}=require('../src/live-quote');
function frame({missingTime=false,origin='https://agents.airarabia.com'}={}){
 const table=()=>({p:{colModel:[{name:'index'},{name:'flightNoList'},{name:'depatureList'},{name:'arrivalList'}]},querySelectorAll:()=>[1,2].map(n=>({
  querySelector:()=>({value:String(n),disabled:false,checked:n===1}),
  cells:[{innerText:''},{innerText:'G943'+n},{innerText:missingTime?'unconfirmed':'Wed 11Nov2026 0'+n+':15'},{innerText:'Wed 11Nov2026 12:30'}],
 }))});
 return{evaluate:async (fn,arg)=>JSON.parse(JSON.stringify(vm.runInNewContext('('+fn.toString()+')(arg)',{arg,location:{origin},document:{getElementById:table}})))};
}
test('reads clocks by supplier colModel, retains separate timings and enumerates all round-trip combinations',async()=>{
 const choices=await readFlightTimes(frame());assert.equal(choices.out.length,2);assert.equal(flightPairs(choices).length,4);
 assert.equal(choices.out[0].departure,'Wed 11Nov2026 01:15');
 await assert.rejects(readFlightTimes(frame({missingTime:true})),/TIMES_UNCONFIRMED/);
});
test('month/week date ranges expand without silently choosing a random date or stay',()=>{
 const r={origin:'الشارقة',destination:'دمشق',tripType:'round_trip',passengers:{adults:1,children:0,infants:0},departureRange:{start:'2090-11-01',end:'2090-11-03'},stayNights:7};
 const dates=expandLiveRequests(r);assert.equal(dates.length,3);assert.equal(dates[2].returnDate,'2090-11-10');
 assert.throws(()=>expandLiveRequests({...r,stayNights:null}));
});
test('each timing carries its own verified price and partial comparisons never claim the entire month is cheapest',()=>{
 const request={};const results=[1000,1200].map((n,i)=>({timing:{out:{flight:'G9'+i,departure:'11Nov 08:00',arrival:'11Nov 10:00'},back:{flight:'G9434',departure:'18Nov 12:00',arrival:'18Nov 16:00'}},price:{sellingTotal:n+'.00',weights:[{kg:20},{kg:20}]}}));
 const text=formatQuoteOptions(request,results,{complete:false,attempted:2,totalDates:31});assert.match(text,/1000.00/);assert.match(text,/1200.00/);assert.match(text,/بقية الفترة لم يكتمل تأكيد أسعارها/);assert.match(text,/08:00/);
});

test('one-way range enumerates every day without a return date; all results are listed instead of top three',async()=>{
 const r={origin:'الشارقة',destination:'دمشق',tripType:'one_way',passengers:{adults:1,children:0,infants:0},departureRange:{start:'2090-11-01',end:'2090-11-07'}};
 assert.equal(expandLiveRequests(r).length,7);const times=await readFlightTimes(frame(),true);assert.equal(times.back.length,0);assert.equal(flightPairs(times).length,2);
 const results=[1,2,3,4,5].map(n=>({timing:{out:{flight:'G9'+n,departure:`0${n}:00`,arrival:'10:00'},back:null},price:{sellingTotal:String(1000+n),weights:[{kg:20}]}}));
 const text=formatQuoteOptions(r,results,{complete:true,attempted:5,totalDates:7});assert.match(text,/1005/);assert.doesNotMatch(text,/العودة/);assert.match(text,/ذهاب فقط/);
});

test('search results can be ready while Make Reservation remains hidden',async()=>{
 const {waitForFlightResults}=require('../src/portal-flight-times');
 const sandbox={location:{origin:'https://agents.airarabia.com'},jQuery:{active:0},UI_tabSearchFlights:{objResSrchParams:{}},jsonOutFlts:[{}],jsonRetFlts:[]};
 const f={waitForFunction:async(fn,arg)=>{assert.equal(vm.runInNewContext('('+fn.toString()+')(arg)',{...sandbox,arg}),true);},evaluate:async(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{...sandbox,arg})};
 await waitForFlightResults(f,true);
 sandbox.jsonOutFlts=[];await assert.rejects(waitForFlightResults(f,true),/NO_FLIGHTS_CONFIRMED/);
});
test('already selected flight still confirms its visible fare before waiting for reservation',async()=>{
 const {selectFlightTimes}=require('../src/portal-flight-times'),f=frame(),calls=[];
 f.locator=selector=>({count:async()=>selector.includes('outboundConfirm')?1:0,click:async()=>calls.push('confirm'),waitFor:async()=>calls.push('reservation')});
 f.waitForFunction=async()=>{};
 const choices=await readFlightTimes(f,true);await selectFlightTimes(f,{out:choices.out[0],back:null});
 assert.deepEqual(calls,['confirm','reservation']);
});

test('a disabled fare quote button is skipped after the supplier has already quoted the selected flight',async()=>{
 const {selectFlightTimes}=require('../src/portal-flight-times'),f=frame(),calls=[];
 f.locator=selector=>({count:async()=>selector==='#btnFQ:visible'?1:0,isEnabled:async()=>false,click:async()=>{throw Error('must not click disabled fare button');},waitFor:async()=>calls.push('reservation')});
 f.waitForFunction=async()=>{};
 const choices=await readFlightTimes(f,true);await selectFlightTimes(f,{out:choices.out[0],back:null});assert.deepEqual(calls,['reservation']);
});

test('professional coverage names the origin and verified dates without claiming a whole-week minimum',()=>{
 const request={origin:'الشارقة',destination:'دمشق',tripType:'one_way',departureRange:{start:'2026-10-23',end:'2026-10-25'}};
 const q={request:{departureDate:'2026-10-24'},timing:{out:{flight:'G9433',departure:'08:00',arrival:'10:00'}},price:{sellingTotal:'750.50',weights:[{kg:30}]}};
 const text=formatQuoteOptions(request,[q],{complete:false,attempted:3,totalDates:3});assert.match(text,/من مطار الشارقة/);assert.match(text,/هذه العروض تأكدت لتواريخ 2026-10-24/);assert.match(text,/قد تتوفر خيارات أوفر/);assert.match(text,/بدك نوسّع البحث/);
 const progress=formatQuoteOptions(request,[q],{complete:false,inProgress:true});assert.match(progress,/البحث مستمر/);assert.doesNotMatch(progress,/بدك نوسّع البحث/);
});

test('FlyCham first-page timing reads require its exact origin; unrelated origins are refused',async()=>{
 const choices=await readFlightTimes(frame({origin:'https://reservations.flycham.com'}),true,'https://reservations.flycham.com');assert.equal(choices.out.length,2);
 await assert.rejects(readFlightTimes(frame({origin:'https://other.example'}),true,'https://reservations.flycham.com'),/UNTRUSTED/);
 await assert.rejects(readFlightTimes(frame(),true,'https://other.example'),/UNTRUSTED/);
});
