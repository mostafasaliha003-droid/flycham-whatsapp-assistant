'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {airportSearchPlan}=require('../src/airport-comparison'),{QuoteJobs}=require('../src/quote-jobs');
const NOW=Date.parse('2026-10-25T00:00:00Z');
const request=(extra={})=>({origin:'دبي',destination:'دمشق',departureRange:{start:'2026-11-01',end:'2026-11-30'},departureDate:null,tripType:'one_way',returnDate:null,passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,requestedByCustomer:false,source:'default30'},...extra});
test('Dubai comparison checks both airlines only at configured airports and preserves the complete month',()=>{
 const r=request(),before=structuredClone(r),plan=airportSearchPlan(r,['flycham','airarabia']);
 assert.deepEqual(plan.requests.map(x=>[x.provider,x.request.origin,x.phase]),[['flycham','دبي','exact'],['flycham','الشارقة','airports'],['airarabia','الشارقة','airports'],['airarabia','أبوظبي','airports']]);
 for(const x of plan.requests){assert.deepEqual(x.request.departureRange,r.departureRange);assert.deepEqual(x.request.passengers,r.passengers);assert.deepEqual(x.request.baggageRequest,r.baggageRequest);}
 assert.deepEqual(r,before);assert.equal(plan.routing.airarabia.excludedRequested,true);assert.equal(plan.routing.flycham.excludedRequested,false);
});
test('reverse Syria to Dubai compares valid arrival airports without changing the requested arrival',()=>{
 const r=request({origin:'دمشق',destination:'دبي'}),p=airportSearchPlan(r,['flycham','airarabia']);
 assert.deepEqual(p.requests.map(x=>[x.provider,x.request.destination]),[['flycham','دبي'],['flycham','الشارقة'],['airarabia','الشارقة'],['airarabia','أبوظبي']]);assert.ok(p.requests.every(x=>x.request.origin==='دمشق'));assert.equal(p.routing.airarabia.airportSide,'destination');assert.equal(r.destination,'دبي');
});
test('monthly jobs interleave both FlyCham airports, then let AirArabia progress after the first probe',()=>{
 const q=new QuoteJobs({now:()=>NOW});const p=q.enqueueComparison('c',request(),{compareFlyChamAirports:true,waitForProviders:true});
 assert.equal(p.statuses.length,120);assert.equal(q.claim('airarabia'),null);
 const f=q.claim('flycham');assert.equal(f.request.origin,'دبي');assert.equal(f.request.departureDate,'2026-11-01');q.completeComparisonChild(f.id,f.lease,{outcome:'failed'});
 const a=q.claim('airarabia');assert.equal(a.request.origin,'الشارقة');assert.equal(a.request.departureDate,'2026-11-01');
 const other=q.claim('flycham');assert.equal(other.request.origin,'الشارقة');assert.equal(other.request.departureDate,'2026-11-01');
 assert.equal(q.comparisonResult(p.id).request.origin,'دبي');assert.ok([...q.jobs.values()].every(j=>j.request.provider!=='airarabia'||j.request.origin!=='دبي'));
});
test('an unavailable FlyCham worker cannot indefinitely suppress a ready AirArabia worker',()=>{
 let now=NOW;const q=new QuoteJobs({now:()=>now});q.enqueueComparison('c',request(),{compareFlyChamAirports:true,waitForProviders:true});assert.equal(q.claim('airarabia'),null);now+=15000;const a=q.claim('airarabia');assert.equal(a.request.provider,'airarabia');assert.equal(a.request.origin,'الشارقة');
});
test('explicit airline-only searches keep the provider filter while offering valid airports',()=>{
 const q=new QuoteJobs({now:()=>NOW}),r=request({provider:'airarabia',providerExclusive:true,providerRestrictionSource:'customer'});const p=q.enqueueComparison('c',r,{providers:['airarabia'],compareFlyChamAirports:true,waitForProviders:true});assert.equal(q.claim('flycham'),null);assert.equal(p.statuses.length,60);assert.ok(p.statuses.every(x=>x.provider==='airarabia'));assert.equal(q.claim('airarabia').request.origin,'الشارقة');
});
