'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {diagnoseFlyChamAirports}=require('../src/airport-menu-diagnostics');
test('airport capability check confirms supplier IATA using pointer selection and never submits a search',async()=>{
 let opens=0,code='',selected='',clicks=0;const reports=[];
 const frame={
  locator:s=>{
   assert.ok(['#fAirport','#fromAirport'].includes(s));
   return {fill:async v=>assert.equal(v,''),pressSequentially:async v=>{code=v;},inputValue:async()=>selected};
  },
  evaluate:async(fn,args)=>({status:args.operation==='input'?'INPUT_READY':'READY'}),
  evaluateHandle:async()=>({asElement:()=>({click:async()=>{selected=code;clicks++;}}),dispose:async()=>{}}),
 };
 await diagnoseFlyChamAirports({openSearchForm:async()=>{opens++;return frame;},report:e=>reports.push(e)});
 assert.equal(opens,5);assert.equal(clicks,4);
 assert.deepEqual(reports,['DXB','DWC','AUH','SHJ'].map(c=>'FLYCHAM_ORIGIN_SELECTION_CONFIRMED_'+c));
});
