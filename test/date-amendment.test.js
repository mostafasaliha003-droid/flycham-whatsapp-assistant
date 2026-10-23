'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const {naturalDate}=require('../src/arabic-dates');
const now=Date.parse('2026-10-23T20:20:00Z');
const request={origin:'الشارقة',destination:'دمشق',departureDate:'2026-10-25',tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,requestedByCustomer:true}};
function make(nlu){const e=new AssistantEngine({store:new AssistantState({now:()=>now}),env:{},nlu});e.store.set('u',{history:[],offers:[],selected:null,base:{request:structuredClone(request),submitted:true,awaiting:null,at:now},status:'done'});return e;}
for(const mode of ['explain','timeout'])test('other dates override '+mode+' while retaining trip facts',async()=>{
 const e=make(async()=>{if(mode==='timeout')throw Error('NLU_TIMEOUT');return{intent:'explain',fields:{},question:null,option:null};});
 const first=await e.handle('u','عطيني تواريخ تانيه ارخص سعر',{now});assert.equal(first.complete,false);assert.match(first.reply,/أي فترة/);assert.doesNotMatch(first.reply,/طلبك السابق مسجل/);
 const result=await e.handle('u','غير تواريخ السفر فقط، اريد ارخص رحله خلال شهر ١٠ و ١١ ذهاب فقط الى دمشق',{now});
 assert.equal(result.complete,true);assert.equal(result.request.departureDate,null);assert.equal(result.request.departureRange.start,'2026-10-24');assert.equal(result.request.departureRange.end,'2026-11-30');assert.equal(result.request.searchMode,'cheapest');assert.equal(result.request.origin,'الشارقة');assert.equal(result.request.destination,'دمشق');assert.equal(result.request.passengers.adults,1);assert.equal(result.request.baggageRequest.checkedWeightKg,30);assert.equal(result.request.tripType,'one_way');
});
test('explicit month handles year rollover and never includes past dates',()=>{
 assert.equal(naturalDate('شهر 12 و1',now).range.end,'2027-01-31');assert.equal(naturalDate('شهر 11',now).range.start,'2026-11-01');
});
test('two full months enqueue every date on both airlines without truncation',()=>{
 const {QuoteJobs}=require('../src/quote-jobs');const q=new QuoteJobs({now:()=>now});q.workerAt=now;q.providerAt.set('flycham',now);
 const range={...request,departureDate:null,departureRange:{start:'2026-11-01',end:'2026-12-31'}};
 const result=q.enqueueComparison('two-months',range);assert.ok(result);assert.equal(q.jobs.size,122);
 assert.equal([...q.jobs.values()].filter(j=>j.request.departureDate==='2026-12-31').length,2);
});
