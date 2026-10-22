'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readFlightTimes,flightPairs}=require('../src/portal-flight-times');
const {expandLiveRequests,formatQuoteOptions}=require('../src/live-quote');
function frame({missingTime=false}={}){
 const table=()=>({p:{colModel:[{name:'index'},{name:'flightNoList'},{name:'depatureList'},{name:'arrivalList'}]},querySelectorAll:()=>[1,2].map(n=>({
  querySelector:()=>({value:String(n),disabled:false,checked:n===1}),
  cells:[{innerText:''},{innerText:'G943'+n},{innerText:missingTime?'unconfirmed':'Wed 11Nov2026 0'+n+':15'},{innerText:'Wed 11Nov2026 12:30'}],
 }))});
 return{evaluate:async fn=>JSON.parse(JSON.stringify(vm.runInNewContext('('+fn.toString()+')()',{location:{origin:'https://agents.airarabia.com'},document:{getElementById:table}})))};
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
 const text=formatQuoteOptions(request,results,{complete:false,attempted:2,totalDates:31});assert.match(text,/1000.00/);assert.match(text,/1200.00/);assert.match(text,/الفحص جزئي/);assert.match(text,/08:00/);
});
