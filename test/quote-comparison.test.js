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

test('verified no-flight results search adjacent dates first and stop after finding a verified nearby option',()=>{
 const q=queue();const parent=q.enqueueComparison('a',request());const a=q.claim(),f=q.claim('flycham');
 q.comparisonProgress(a.id,a.lease,{offer:offer(a.request,'airarabia')});done(q,a);const next=done(q,f,'no_flights');assert.equal(next.phase,'alternatives');assert.equal(next.ready,false);
 assert.deepEqual(next.pending.map(p=>p.date),['2090-11-10','2090-11-12']);assert.ok(next.pending.every(p=>p.provider==='flycham'));assert.equal(q.claim(),null);
 for(let n=0;n<2;n++){const j=q.claim('flycham');assert.ok(j.id);if(n===0)q.comparisonProgress(j.id,j.lease,{offer:offer(j.request,'flycham','550.00')});done(q,j,n===0?'confirmed':'no_flights');}
 const result=q.comparisonResult(parent.id);assert.ok(result.ready);assert.match(result.reply,/بدائل قريبة/);assert.match(result.reply,/2090-11-10/);assert.match(result.reply,/550\.00/);assert.match(result.reply,/التاريخ المطلوب: 2090-11-11/);
 assert.match(result.reply,/قبل موعدك بيوم/);assert.match(result.reply,/06:00/);assert.match(result.reply,/30 كيلو/);assert.match(result.reply,/أي خيار/);assert.equal(q.claim('flycham'),null);assert.equal(result.request.departureDate,'2090-11-11');
});

test('nearby discovery widens in day pairs and never beyond three days',()=>{
 const q=queue(),p=q.enqueueComparison('wave-customer',request(),{providers:['flycham']});done(q,q.claim('flycham'),'no_flights');
 for(const distance of [1,2,3]){
  const pending=q.comparisonResult(p.id).pending;assert.equal(pending.length,2);
  assert.deepEqual(pending.map(x=>x.date),[11-distance,11+distance].map(day=>'2090-11-'+String(day).padStart(2,'0')));
  for(let i=0;i<2;i++)done(q,q.claim('flycham'),'no_flights');
 }
 const final=q.comparisonResult(p.id);assert.equal(final.ready,true);assert.equal(final.statuses.length,7);assert.equal(q.claim('flycham'),null);assert.match(final.reply,/ما ظهر خيار متاح/);assert.match(final.reply,/فترة أبعد/);
});

test('one supplier starts nearby work while another still checks the requested date',()=>{
 const q=queue(),p=q.enqueueComparison('independent-customer',request()),a=q.claim(),f=q.claim('flycham');done(q,f,'no_flights');
 assert.equal(q.current(a.id,a.lease),true);assert.deepEqual(q.comparisonResult(p.id).pending.filter(x=>x.provider==='flycham').map(x=>x.date),['2090-11-10','2090-11-12']);
 const before=q.claim('flycham'),after=q.claim('flycham');q.comparisonProgress(before.id,before.lease,{offer:offer(before.request,'flycham','620.00')});done(q,before);q.comparisonProgress(after.id,after.lease,{offer:offer(after.request,'flycham','610.00')});done(q,after);
 done(q,a,'no_flights');const nearAir=q.claim();done(q,nearAir,'no_flights');done(q,q.claim(),'no_flights');
 const current=q.comparisonResult(p.id);assert.ok(current.pending.every(x=>x.provider==='airarabia'));assert.deepEqual(current.pending.map(x=>x.date),['2090-11-09','2090-11-13']);assert.equal(q.claim('flycham'),null);assert.match(current.reply,/قبل موعدك بيوم/);assert.match(current.reply,/بعد موعدك بيوم/);
});

test('authentication or airport-selection failure during nearby discovery stops widening that supplier',()=>{
 for(const status of ['authentication_required','airport_unconfirmed']){
  const q=queue(),p=q.enqueueComparison('blocked-'+status,request(),{providers:['flycham']});done(q,q.claim('flycham'),'no_flights');
  const first=q.claim('flycham');q.completeComparisonChild(first.id,first.lease,{status,outcome:'failed'});
  const other=q.claim('flycham');if(other)done(q,other,'no_flights');
  const result=q.comparisonResult(p.id);assert.equal(result.ready,true);assert.equal(result.statuses.length,3);assert.equal(q.claim('flycham'),null);assert.doesNotMatch(result.reply,/ما ظهر خيار متاح لدى الشركات المفحوصة ضمن الأيام/);
 }
});

test('a restarted nearby wave retains trip facts and does not repeat already attempted dates',()=>{
 const store={data:{},save(){}};let q=queue({store});const r=request({tripType:'round_trip',returnDate:'2090-11-20',passengers:{adults:1,children:0,infants:0},baggageRequest:{checkedWeightKg:30,requestedByCustomer:true}}),p=q.enqueueComparison('restart-nearby',r,{providers:['flycham']});done(q,q.claim('flycham'),'no_flights');
 const first=q.claim('flycham');done(q,first,'no_flights');q=new QuoteJobs({now:()=>NOW,store});const second=q.claim('flycham');assert.equal(second.request.departureDate,'2090-11-12');assert.equal(second.request.returnDate,r.returnDate);assert.deepEqual(second.request.passengers,r.passengers);assert.deepEqual(second.request.baggageRequest,r.baggageRequest);done(q,second,'no_flights');
 assert.deepEqual(q.comparisonResult(p.id).pending.map(x=>x.date),['2090-11-09','2090-11-13']);assert.equal(q.comparisonResult(p.id).request.departureDate,r.departureDate);
});

test('an unverified adjacent day never becomes a claim that a farther option is the closest available',()=>{
 const q=queue(),p=q.enqueueComparison('uncertain-nearby',request(),{providers:['flycham']});done(q,q.claim('flycham'),'no_flights');
 const uncertain=q.claim('flycham');q.completeComparisonChild(uncertain.id,uncertain.lease,{outcome:'failed'});done(q,q.claim('flycham'),'no_flights');
 const farther=q.claim('flycham');q.comparisonProgress(farther.id,farther.lease,{offer:offer(farther.request,'flycham')});done(q,farther);done(q,q.claim('flycham'),'no_flights');
 const result=q.comparisonResult(p.id);assert.equal(result.ready,true);assert.match(result.reply,/قبل موعدك بيومين/);assert.match(result.reply,/بعض الأيام أو التواقيت القريبة لم يكتمل فحصها/);assert.doesNotMatch(result.reply,/الأقرب المتاح/);
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
