'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {QuoteJobs}=require('../src/quote-jobs');
const {nearbyRequests,completionStatus}=require('../src/quote-comparison');
const NOW=Date.parse('2090-11-08T10:00:00Z');
function request(extra={}){return {origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},...extra};}
function offer(r,provider,price='600.00'){return {provider,request:{...r,provider},price:{currency:'AED',sellingTotal:price,weights:[{kg:30}]},timing:{out:{flight:provider==='flycham'?'XH647':'G9917',departure:r.departureDate+' 06:00',arrival:r.departureDate+' 08:00'},...(r.tripType==='round_trip'?{back:{flight:provider==='flycham'?'XH648':'G9918',departure:r.returnDate+' 09:00',arrival:r.returnDate+' 12:00'}}:{})}};}
function queue(options={}){const q=new QuoteJobs({now:()=>NOW,...options});q.claim('airarabia');q.claim('flycham');return q;}
function done(q,job,status='confirmed'){return q.completeComparisonChild(job.id,job.lease,{outcome:'done',coverage:[{date:job.request.departureDate,status}]});}

test('one travel request creates independent supplier children and one combined final response',()=>{
 const q=queue(),parent=q.enqueueComparison('private-customer',request());assert.equal(parent.ready,false);
 const a=q.claim('airarabia'),f=q.claim('flycham');assert.ok(a.id&&f.id);assert.notEqual(a.id,f.id);assert.ok(q.current(a.id,a.lease));assert.ok(!JSON.stringify(a).includes('private-customer'));
 q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia','600.00')});assert.equal(done(q,a).ready,false);
 q.comparisonProgress(f.id,f.lease,{offer:offer(f.request,'flycham','650.00')});const result=done(q,f);
 assert.equal(result.ready,true);assert.equal(result.offers.length,2);assert.match(result.reply,/600\.00/);assert.match(result.reply,/650\.00/);assert.match(result.reply,/فاوجر 10\.00/);assert.doesNotMatch(result.reply,/640\.00/);
 assert.deepEqual(new Set(result.offers.map(o=>o.reference)),new Set([1,2]));assert.match(result.reply,/الخيار 1/);assert.match(result.reply,/الخيار 2/);
 assert.ok(q.markComparisonDelivered(parent.id,{version:result.version,final:true}));assert.equal(q.isComparisonCurrent(parent.id),false);assert.equal(q.comparisonResult(parent.id),null);
});

test('a ready airline remains useful when the other airline is offline; errors never mean full',()=>{
 const q=new QuoteJobs({now:()=>NOW});q.claim('airarabia');const parent=q.enqueueComparison('a',request());const a=q.claim();q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});const result=done(q,a);
 assert.ok(result.ready);assert.match(result.reply,/600\.00/);assert.ok(result.statuses.some(s=>s.provider==='flycham'&&s.status==='unverified'));assert.doesNotMatch(result.reply,/عدم توفر مقاعد/);assert.equal(q.claim('flycham'),null);
 const offline=new QuoteJobs({now:()=>NOW});const r=offline.enqueueComparison('b',request());assert.ok(r.ready);assert.equal(r.offers.length,0);assert.equal(r.statuses.length,2);
});

test('verified no-flight exact results start six nearby dates only for the unavailable supplier',()=>{
 const q=queue();const parent=q.enqueueComparison('a',request());const a=q.claim(),f=q.claim('flycham');
 q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});done(q,a);const next=done(q,f,'no_flights');assert.equal(next.phase,'alternatives');assert.equal(next.ready,false);
 assert.deepEqual(next.pending.map(p=>p.date),['2090-11-10','2090-11-12','2090-11-09','2090-11-13','2090-11-08','2090-11-14']);assert.ok(next.pending.every(p=>p.provider==='flycham'));assert.equal(q.claim(),null);
 for(let n=0;n<6;n++){const j=q.claim('flycham');assert.ok(j.id);if(n===0)q.comparisonProgress(j.id,j.lease,{offer:offer(j.request,'flycham','550.00')});done(q,j,n===0?'confirmed':'no_flights');}
 const result=q.comparisonResult(parent.id);assert.ok(result.ready);assert.match(result.reply,/بدائل قريبة/);assert.match(result.reply,/2090-11-10/);assert.match(result.reply,/550\.00/);assert.match(result.reply,/التاريخ المطلوب: 2090-11-11/);
});

test('timeouts and unsupported sold-out claims do not trigger nearby searches',()=>{
 const q=queue();q.enqueueComparison('a',request());const a=q.claim(),f=q.claim('flycham');
 q.completeComparisonChild(a.id,a.lease,{outcome:'failed',reply:'sold out'});const result=q.completeComparisonChild(f.id,f.lease,{outcome:'failed',availability:'sold_out'});assert.ok(result.ready);assert.equal(result.phase,'done');assert.equal(q.jobs.size,0);assert.ok(result.statuses.every(s=>s.status==='unverified'));
 assert.equal(completionStatus({availability:'sold_out',availabilityEvidence:'supplier-explicit'},[],request()),'sold_out');
 assert.equal(completionStatus({availability:'auth_required'},[],request()),'auth_required');
});

test('changing the request supersedes both supplier leases and prevents a stale final delivery',()=>{
 const q=queue(),old=q.enqueueComparison('a',request()),a=q.claim(),f=q.claim('flycham');
 const next=q.enqueueComparison('a',request({departureDate:'2090-11-12'}));assert.notEqual(old.id,next.id);assert.equal(q.current(a.id,a.lease),false);assert.equal(q.current(f.id,f.lease),false);assert.equal(q.isComparisonCurrent(old.id),false);assert.equal(q.completeComparisonChild(a.id,a.lease,{outcome:'done'}).accepted,false);assert.ok(next.revision>old.revision);
});

test('nearby fixed-return offers preserve the stated return; explicit stay length moves both dates',()=>{
 const fixed=request({tripType:'round_trip',returnDate:'2090-11-12'}),nights={...fixed,stayNights:7,returnDate:'2090-11-18'};
 const a=nearbyRequests(fixed,NOW);assert.ok(a.every(x=>x.request.returnDate==='2090-11-12'));assert.ok(a.every(x=>x.request.departureDate<='2090-11-12'));assert.ok(!a.some(x=>x.request.departureDate==='2090-11-13'));
 const b=nearbyRequests(nights,NOW);assert.equal(b.find(x=>x.delta===1).request.returnDate,'2090-11-19');assert.equal(b.find(x=>x.delta===-1).request.returnDate,'2090-11-17');
});

test('nearby alternatives exclude Dubai past dates and never invent alternatives for a range',()=>{
 const now=Date.parse('2090-11-10T21:00:00Z');assert.ok(nearbyRequests(request(),now).every(x=>x.request.departureDate>='2090-11-11'));
 assert.deepEqual(nearbyRequests(request({departureRange:{start:'2090-11-11',end:'2090-11-12'}}),NOW),[]);
});

test('partial delivery uses global offer references and a fingerprint without consuming the comparison',()=>{
 const q=queue(),p=q.enqueueComparison('a',request()),a=q.claim(),f=q.claim('flycham');
 q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});const partial=q.comparisonResult(p.id);assert.ok(partial.hasVerifiedOffers);assert.equal(partial.ready,false);
 assert.ok(q.markComparisonDelivered(p.id,{final:false,fingerprint:partial.deliveryFingerprint}));assert.ok(q.isComparisonCurrent(p.id));assert.equal(q.markComparisonDelivered(p.id,{final:false,fingerprint:partial.deliveryFingerprint}),false);assert.ok(q.comparisonResult(p.id).partialAlreadyDelivered);
 q.comparisonProgress(f.id,f.lease,{offer:offer(f.request,'flycham')});const changed=q.comparisonResult(p.id);assert.notEqual(changed.deliveryFingerprint,partial.deliveryFingerprint);assert.equal(changed.partialAlreadyDelivered,false);assert.equal(q.markComparisonDelivered(p.id,{final:true}),false);
 assert.doesNotMatch(changed.reply,/الخيار 1 —/);assert.match(changed.reply,/الخيار 2 —/);assert.equal(changed.offers.length,2);
});

test('forty-offer supplier allocation leaves room for the other airline and caps the parent at eighty',()=>{
 const q=queue(),p=q.enqueueComparison('a',request()),a=q.claim(),f=q.claim('flycham');
 for(let i=0;i<60;i++){const o=offer(a.request,'airarabia');o.timing.out.flight='G9'+(100+i);q.comparisonProgress(a.id,a.lease,{offer:o});}
 for(let i=0;i<60;i++){const o=offer(f.request,'flycham');o.timing.out.flight='XH'+(100+i);q.comparisonProgress(f.id,f.lease,{offer:o});}
 const r=q.comparisonResult(p.id);assert.equal(r.offers.length,80);assert.equal(r.offers.filter(o=>o.provider==='flycham').length,40);assert.equal(new Set(r.offers.map(o=>o.reference)).size,80);
});

test('cached seeds must match dates, party, provider and weight and actually be fresh',()=>{
 const q=queue(),r=request(),valid={...offer(r,'airarabia'),checkedAt:NOW-1000},wrongWeight={...offer(request({baggageRequest:{checkedWeightKg:20}}),'flycham'),checkedAt:NOW},stale={...offer(r,'flycham'),checkedAt:NOW-900001};
 const p=q.enqueueComparison('a',r,{seedOffers:[valid,wrongWeight,stale]});assert.equal(p.offers.length,1);assert.equal(q.claim(),null);assert.ok(q.claim('flycham')?.id);assert.ok(p.offers[0].reference);
});

test('a bounded comparison deadline preserves verified offers and invalidates only unfinished child leases',()=>{
 let now=NOW;const q=queue({now:()=>now,comparisonTimeoutMs:1000});const p=q.enqueueComparison('a',request()),a=q.claim(),f=q.claim('flycham');q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});
 now+=1001;const [due]=q.dueComparisons();assert.equal(due.id,p.id);assert.ok(due.ready);assert.equal(due.offers.length,1);assert.ok(due.statuses.some(s=>s.status==='unverified'));assert.equal(q.current(f.id,f.lease),false);assert.deepEqual(q.dueComparisons(),[]);
});

test('parent and child state survive a configured store snapshot without leaking the recipient to workers',()=>{
 const store={data:{},save(){}};const q=queue({store}),p=q.enqueueComparison('private-customer',request()),a=q.claim();q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});
 const restarted=new QuoteJobs({now:()=>NOW,store});const result=restarted.comparisonResult(p.id);assert.equal(result.offers.length,1);const claimed=restarted.claim();assert.ok(claimed.id);assert.ok(!JSON.stringify(claimed).includes('private-customer'));assert.equal(restarted.current(a.id,a.lease),false);
});
