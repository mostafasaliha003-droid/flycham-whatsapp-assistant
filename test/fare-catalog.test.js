'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FareCatalog,FRESH_MS,INDICATIVE_MS,catalogRequestKey}=require('../src/fare-catalog');
const {catalogParties,partyKey}=require('../src/catalog-party');
const NOW=Date.parse('2026-10-23T08:00:00Z');
const request=extra=>({provider:'airarabia',origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},...extra});
const offer=(r=request(),price='600.00',flight='G9123')=>({provider:r.provider,request:r,timing:{out:{flight,departure:'10:00',arrival:'12:00'},...(r.tripType==='round_trip'?{back:{flight:'G9124',departure:'13:00',arrival:'15:00'}}:{})},price:{currency:'AED',sellingTotal:price,weights:[{kg:30}]}});
test('organized plan spans both months, both directions and configured airport candidates with explicit return samples',()=>{
 const c=new FareCatalog({now:()=>NOW}),p=c.plan('airarabia');assert.equal(p.length,39*8*3);assert.ok(p.some(x=>x.request.origin==='أبوظبي'&&x.request.destination==='حلب'));assert.ok(p.some(x=>x.request.origin==='حلب'&&x.request.destination==='أبوظبي'));assert.ok(!p.some(x=>x.request.origin==='اللاذقية'||x.request.destination==='اللاذقية'));assert.ok(!p.some(x=>x.request.origin==='دبي'||x.request.destination==='دبي'));
 const firstLayer=p.slice(0,72);assert.ok(firstLayer.some(x=>x.request.departureDate.startsWith('2026-10')));assert.ok(firstLayer.some(x=>x.request.departureDate.startsWith('2026-11')));assert.ok(firstLayer.some(x=>x.request.stayNights===14));assert.ok(p.some(x=>x.request.returnDate==='2026-12-14'));assert.ok(c.plan('flycham').some(x=>x.request.origin==='دبي'&&x.request.destination==='حلب'));assert.ok(c.plan('flycham').every(x=>x.request.origin!=='أبوظبي'&&x.request.destination!=='أبوظبي'));
});
test('a provider feature flag cannot activate unverified child or infant jobs',()=>{
 const c=new FareCatalog({now:()=>NOW,familyEnabled:true});assert.ok(c.plan('flycham').every(x=>x.request.passengers.children===0&&x.request.passengers.infants===0));assert.deepEqual(c.status().familyPricing.activeProviders,[]);
 const scoped=new FareCatalog({now:()=>NOW,familyEnabled:true,verifiedFamilyProviders:['flycham']});assert.ok(scoped.plan('flycham').some(x=>x.request.passengers.children===1&&x.request.passengers.ages[0]===7));assert.ok(scoped.plan('flycham').some(x=>x.request.passengers.infants===1&&x.request.passengers.ages[0]===1));assert.ok(scoped.plan('airarabia').every(x=>x.request.passengers.children===0&&x.request.passengers.infants===0));
 assert.equal(catalogParties().length,1);assert.equal(catalogParties({familyEnabled:true,verified:true}).length,3);
});
test('party ages and baggage constraints cannot share keys or contaminate quotes',()=>{
 const adult=request(),child=request({passengers:{adults:1,children:1,infants:0,ages:[7]}}),other=request({passengers:{adults:1,children:1,infants:0,ages:[9]}}),infant=request({passengers:{adults:1,children:0,infants:1,ages:[1]}});
 assert.equal(new Set([adult,child,other,infant].map(catalogRequestKey)).size,4);assert.notEqual(catalogRequestKey(adult),catalogRequestKey(request({baggageRequest:{checkedWeightKg:30,pieces:2}})));assert.notEqual(partyKey(child.passengers),partyKey(other.passengers));
 const c=new FareCatalog({now:()=>NOW});assert.equal(c.acceptOffer(offer(child),'airarabia'),false);assert.equal(c.acceptOffer(offer(infant),'airarabia'),false);assert.equal(c.acceptOffer(offer(adult),'airarabia'),true);assert.deepEqual(c.find(child),[]);assert.deepEqual(c.find(infant),[]);
});
test('cached indicative prices have their own honest lifetime and never seed an expired live quote',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now});assert.equal(c.acceptOffer(offer(),'airarabia'),true);now+=FRESH_MS+1;assert.equal(c.find().length,0);const reply=c.reply({destinationCountry:'سوريا'});assert.match(reply,/استرشادية/);assert.match(reply,/600.00/);assert.match(reply,/آخر تحقق/);assert.match(reply,/نعيد تأكيد السعر/);assert.doesNotMatch(reply,/أفضل أسعار متأكدين/);now=NOW+INDICATIVE_MS+1;assert.equal(c.reply(),null);
});
test('cheapest actual observed flight is retained per date instead of overwritten by a more expensive flight',()=>{
 const c=new FareCatalog({now:()=>NOW});c.acceptOffer(offer(request(),'500.00','G9111'),'airarabia');c.acceptOffer(offer(request(),'900.00','G9222'),'airarabia');const reply=c.reply();assert.match(reply,/500.00/);assert.doesNotMatch(reply,/900.00/);assert.match(reply,/G9111/);assert.equal(c.acceptOffer({...offer(),price:{...offer().price,currency:'USD'}},'airarabia'),false);
});
test('explicit airport lookup failure cools down that route only, never from a generic unverified day',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now}),first=c.claim('flycham');assert.ok(first);c.finish(first.id,first.lease,'failed',[{date:first.request.departureDate,status:'unverified'}],{status:'airport_unconfirmed'});assert.ok(c.plan('flycham').every(t=>!(t.request.origin===first.request.origin&&t.request.destination===first.request.destination)));assert.equal(c.status().routeFailures.length,1);
 const normal=new FareCatalog({now:()=>now}),job=normal.claim('flycham');normal.finish(job.id,job.lease,'failed',[{date:job.request.departureDate,status:'unverified'}]);assert.ok(normal.plan('flycham').some(t=>t.request.origin===job.request.origin&&t.request.destination===job.request.destination));now+=30*60000+1;assert.equal(c.status().routeFailures.length,0);
});
test('attempted route groups rotate behind untouched groups and coverage survives state reload',()=>{
 let now=NOW;const store={data:{},save(){}};const c=new FareCatalog({now:()=>now,store}),first=c.claim('airarabia');c.finish(first.id,first.lease,'done',[{date:first.request.departureDate,status:'no_flights'}]);now+=FRESH_MS+1;const next=c.plan('airarabia')[0];assert.ok(next.request.origin!==first.request.origin||next.request.destination!==first.request.destination||next.request.tripType!==first.request.tripType||next.request.stayNights!==first.request.stayNights||next.request.departureDate.slice(0,7)!==first.request.departureDate.slice(0,7));
 const restored=new FareCatalog({now:()=>now,store});assert.equal(restored.status().providers.airarabia.outcome,'done');assert.equal(restored.status().months[0].attemptedRequests,1);assert.equal(restored.status().completeMonthlyCoverage,false);assert.equal(restored.status().familyPricing.enabled,false);
});
test('lease and offer request matching includes party and return details',()=>{
 const c=new FareCatalog({now:()=>NOW}),job=c.claim('airarabia'),wrong=request({...job.request,passengers:{adults:1,children:1,infants:0,ages:[7]}});assert.equal(c.acceptOffer(offer(wrong),'airarabia',job.request),false);assert.equal(c.current(job.id,'wrong'),false);assert.equal(c.progress(job.id,job.lease,{offer:offer(job.request)}),true);assert.equal(c.records.size,1);assert.equal(c.finish(job.id,'wrong','done',[]),false);
});
test('family cached records require verified support and exact ages even after a capability is disabled',()=>{
 const r=request({provider:'flycham',passengers:{adults:1,children:1,infants:0,ages:[7]}}),c=new FareCatalog({now:()=>NOW,familyEnabled:true,verifiedFamilyProviders:['flycham'],validateRequest:()=>{}});
 assert.equal(c.acceptOffer(offer(r,'1200.00','XH123'),'flycham'),true);assert.equal(c.find(r).length,1);assert.equal(c.find({...r,passengers:{adults:1,children:1,infants:0,ages:[9]}}).length,0);assert.equal(c.find().length,0);c.familyEnabled=false;assert.equal(c.find(r).length,0);
});
test('short general catalog response reserves both months, trip types and both suppliers',()=>{
 const c=new FareCatalog({now:()=>NOW});for(const provider of ['flycham','airarabia'])for(const date of ['2026-10-29','2026-11-11'])for(const nights of [0,7]){
  const r=request({provider,departureDate:date,tripType:nights?'round_trip':'one_way',returnDate:nights?(date==='2026-10-29'?'2026-11-05':'2026-11-18'):null,...(nights?{stayNights:nights}:{})});assert.equal(c.acceptOffer(offer(r,provider==='flycham'?'400.00':'700.00',provider==='flycham'?'XH123':'G9123'),provider),true);
 }const reply=c.reply();assert.equal((reply.match(/آخر إجمالي رصدناه/g)||[]).length,8);assert.match(reply,/2026-10/);assert.match(reply,/2026-11/);assert.match(reply,/فلاي شام/);assert.match(reply,/العربية للطيران/);assert.match(reply,/إقامة مرجعية 7 ليلة/);
});
