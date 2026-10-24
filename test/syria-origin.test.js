'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine'),{AssistantState}=require('../src/assistant-state');
const now=Date.parse('2026-10-24T13:45:00Z');
function make(){const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu:async()=>{throw Error('NLU_TIMEOUT');}});e.store.set('u',{introduced:true,status:'collecting',history:[],offers:[],base:{request:{origin:null,destination:'أبوظبي',departureDate:null,departureRange:{start:'2026-10-26',end:'2026-11-01'},tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,requestedByCustomer:true}},awaiting:'origin',submitted:false,at:now}});return e;}
for(const answer of ['الشام','دمشق','حلب'])test('country origin is remembered and asks a Syrian city before searching: '+answer,async()=>{
 const e=make();await e.handle('u','ابوظبي',{now});const r=await e.handle('u','من سوريا',{now});assert.equal(r.complete,false);assert.match(r.reply,/دمشق.*حلب/);assert.equal(e.state('u').base.request.originCountry,'سوريا');assert.equal(e.state('u').base.request.origin,null);assert.equal(e.state('u').base.request.destination,'أبوظبي');
 const result=await e.handle('u',answer,{now});assert.equal(result.complete,true);assert.equal(result.request.origin,answer==='حلب'?'حلب':'دمشق');assert.equal(result.request.destination,'أبوظبي');assert.equal(result.request.departureRange.start,'2026-10-26');assert.equal(result.request.passengers.adults,1);assert.equal(result.request.baggageRequest.checkedWeightKg,30);
});
test('repeating country stays specific and never invents Damascus',async()=>{const e=make();await e.handle('u','من سوريا',{now});const r=await e.handle('u','من سوريا',{now});assert.equal(r.complete,false);assert.match(r.reply,/دمشق.*حلب/);assert.equal(e.state('u').base.request.origin,null);});
