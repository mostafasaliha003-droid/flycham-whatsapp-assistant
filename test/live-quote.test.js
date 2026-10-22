'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateLiveRequest,quoteFromScans}=require('../src/live-quote');
const {QuoteJobs,validQueueKey}=require('../src/quote-jobs');
const request=()=>({origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',returnDate:'2090-11-18',tripType:'round_trip',passengers:{adults:1,children:0,infants:0,ages:[]}});
function scans(){return{
 seats:{complete:true,segments:[0,1].map(segment=>({segment,complete:true,cheapestOrdinarySeat:{amount:0,currency:'AED'}}))},
 catalogs:{complete:true,provisionalTotal:{base:{amount:1000,currency:'AED'}},feeAudit:{amounts:{ancillaryTotal:'0.00'}},
 results:['meal','baggage'].map(type=>({type,complete:true,catalogs:[0,1].map(segment=>({complete:true,classificationsComplete:true,coveredSegments:[segment],options:type==='meal'?
 [{available:true,foodKind:'food',price:{amount:0,currency:'AED'}}]:[
 {available:true,checkedWeightKg:20,price:{amount:0,currency:'AED'}},{available:true,checkedWeightKg:30,price:{amount:35,currency:'AED'}}]}))}))}};}
test('live supported itinerary keeps exact dates and rejects substitutions or passenger counts',()=>{
 const r=request(),v=validateLiveRequest(r);assert.equal(v.returnDate,'18/11/2090');assert.equal(v.origin,'SHJ');
 for(const change of [{origin:'دبي'},{tripType:'one_way'},{returnDate:'2090-11-10'},{passengers:{adults:2,children:0,infants:0}}])assert.throws(()=>validateLiveRequest({...r,...change}));
});
test('uses displayed tax-inclusive total, adds supplier costs once and extra weight margin once',()=>{
 const {seats,catalogs}=scans(),r=request();assert.equal(quoteFromScans(r,seats,catalogs).sellingTotal,'1025.00');
 r.baggageRequest={checkedWeightKg:30,requestedByCustomer:true};assert.equal(quoteFromScans(r,seats,catalogs).sellingTotal,'1105.00');
 catalogs.feeAudit.amounts.ancillaryTotal='35.00';assert.throws(()=>quoteFromScans(r,seats,catalogs));
});
test('missing seats, mixed currency, insufficient food and overlapping groups cannot produce customer price',()=>{
 for(const mutate of [s=>{s.seats.complete=false;},s=>{s.catalogs.results[0].catalogs[0].options[0].foodKind='drink';},s=>{s.catalogs.results[1].catalogs[0].coveredSegments=[0,1];},s=>{s.seats.segments[0].cheapestOrdinarySeat.currency='USD';}]){
 const s=scans();mutate(s);if(s.catalogs.results[1].catalogs[0].coveredSegments.length===2)s.catalogs.results[1].catalogs[1].coveredSegments=[1,2];assert.throws(()=>quoteFromScans(request(),s.seats,s.catalogs));
 }
});
test('queue authenticates, deduplicates, isolates recipients, expires jobs and completes leases once',()=>{
 let now=100;const q=new QuoteJobs({now:()=>now,ttl:1000});assert.throws(()=>q.enqueue('private',request()));
 assert.equal(validQueueKey('Bearer '+ 'x'.repeat(32),'x'.repeat(32)),true);assert.equal(validQueueKey('Bearer bad','x'.repeat(32)),false);
 assert.equal(q.acceptMessage('m1'),true);assert.equal(q.acceptMessage('m1'),false);
 assert.equal(q.claim(),null);q.enqueue('private',request());const j=q.claim();assert.ok(!JSON.stringify(j).includes('private'));
 assert.equal(q.takeResult(j.id,'wrong'),null);assert.deepEqual(q.takeResult(j.id,j.lease),{recipient:'private'});assert.equal(q.takeResult(j.id,j.lease),null);
 q.finish(j.id);q.enqueue('private',request());now+=1001;assert.equal(q.claim(),null);
});
