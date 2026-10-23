'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');const {AssistantState}=require('../src/assistant-state');
const {validateLiveRequest}=require('../src/live-quote');const {airportCodeConfirmed,chooseAirport}=require('../src/portal-search-probe');
const now=Date.parse('2026-10-24T00:00:00Z');
for(const [name,code]of [['دبي','DXB'],['ابوظبي','AUH'],['ابو ظبي','AUH'],['مطار ال مكتوم','DWC'],['مطار آل مكتوم','DWC']])test('origin amendment searches '+name+' and retains remaining trip',async()=>{
 const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}};
 const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>({intent:'explain',fields:{},question:null,option:null})});
 e.store.set('u',{history:[],offers:[],base:{request,submitted:true,awaiting:null,at:now},status:'done'});
 const r=await e.handle('u','طيب شفلي من '+name,{now});assert.equal(r.complete,true);assert.equal(validateLiveRequest(r.request,now).origin,code);assert.equal(r.request.destination,'دمشق');assert.equal(r.request.departureDate,'2026-11-11');assert.equal(r.request.baggageRequest.checkedWeightKg,30);assert.doesNotMatch(r.reply,/من الشارقة إلى/);
});
for(const [code,label]of [['DXB','Dubai'],['AUH','Abu Dhabi'],['DWC','Al Maktoum']])test('portal only confirms exact '+code+' supplier selection',async()=>{
 assert.equal(airportCodeConfirmed(code+' - '+label,code),true);assert.equal(airportCodeConfirmed('DXB / DWC',code),false);
 let hidden='';const frame={evaluate:async(fn,args)=>({status:args.operation==='input'?'INPUT_READY':'READY'}),locator:()=>({fill:async()=>{},pressSequentially:async()=>{},press:async()=>{},inputValue:async()=>hidden}),evaluateHandle:async()=>({asElement:()=>({click:async()=>{hidden=code+' - '+label;}}),dispose:async()=>{}})};
 await chooseAirport(frame,'fAirport','fromAirport',code,{lookupMs:0});assert.equal(hidden,code+' - '+label);
});
