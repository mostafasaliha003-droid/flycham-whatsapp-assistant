'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildOfferDigest}=require('../src/offer-digest');
const {isMoreRequest,setOfferPages,nextOfferPage,acceptOfferPage,MAX_AGE_MS}=require('../src/offer-pages');
const NOW=Date.parse('2026-10-25T00:00:00Z');
function request(){return {origin:'دبي',destination:'دمشق',departureRange:{start:'2026-11-01',end:'2026-11-30'},departureDate:null,returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}};}
function offers(count=30){return Array.from({length:count},(_,i)=>{const provider=i%2?'airarabia':'flycham',ref=i+1;return {provider,reference:ref,request:{...request(),origin:provider==='flycham'?'دبي':'الشارقة',departureDate:'2026-11-'+String(ref).padStart(2,'0'),departureRange:null},timing:{out:{flight:(provider==='flycham'?'XH':'G9')+(200+ref),departure:'10:00',arrival:'12:00'}},price:{currency:'AED',sellingTotal:(1000-ref*5).toFixed(2),weights:[{kg:30}],...(provider==='flycham'?{voucherValue:'10.00'}:{})},checkedAt:NOW};});}
function fixture(count=30){const r=request(),all=offers(count),snapshot={request:r,offers:all,statuses:[{provider:'flycham',status:'partial',phase:'exact',date:'2026-11-01',origin:'دبي',destination:'دمشق'}],ready:true},first=buildOfferDigest(snapshot),state={activeComparisonId:'comparison',tripId:'journey',status:'done',base:{request:structuredClone(r)}};setOfferPages(state,{comparisonId:'comparison',revision:2,...snapshot,shownOffers:first.shownOffers,now:NOW});return {state,all,first,snapshot};}
const acknowledge=(state,page)=>acceptOfferPage(state,{comparisonId:page.comparisonId,revision:page.revision,pageKey:page.pageKey,shownOffers:page.shownOffers});
test('more requests are narrowly anchored and never consume a changed-date or baggage request',()=>{
 for(const s of ['المزيد','باقي الخيارات','بقية التواقيت','كمل العروض','لو سمحت بدي المزيد','ممكن تبعتلي باقي العروض لو سمحت','المزيد شكرا'])assert.equal(isMoreRequest(s),true,s);
 for(const s of ['بدي ارخص الاسبوع الجاي','المزيد بعد 3 ايام','كمل العروض من الشارقة','بدي 30 كيلو','غير التاريخ','خلص شكرا','شو صار بالبحث'])assert.equal(isMoreRequest(s),false,s);
});
test('building a page does not acknowledge it and repeated requests produce identical keys and exact verified facts',()=>{
 const {state}=fixture(),before=structuredClone(state),a=nextOfferPage(state,{now:NOW}),b=nextOfferPage(state,{now:NOW});assert.equal(a.status,'ready');assert.deepEqual(a,b);assert.deepEqual(state,before);assert.ok(a.text.length<=3900);assert.ok(a.shownOffers.every(o=>!state.offerPages.shownRefs.includes(o.reference)));assert.ok(a.shownOffers.every(o=>o.price.sellingTotal===(1000-o.reference*5).toFixed(2)));assert.match(a.text,new RegExp('الخيار '+a.shownOffers[0].reference));
});
test('Meta acceptance advances exactly one page and callback replay remains idempotent across restart',()=>{
 const {state}=fixture(),page=nextOfferPage(state,{now:NOW}),before=state.offerPages.pageCounter;
 assert.equal(acknowledge(state,page),true);assert.equal(state.offerPages.pageCounter,before+1);assert.ok(page.shownOffers.every(o=>state.offerPages.shownRefs.includes(o.reference)));
 const restored=JSON.parse(JSON.stringify(state));assert.equal(acknowledge(restored,page),true);assert.equal(restored.offerPages.pageCounter,before+1);
 const staff=structuredClone(restored);staff.humanOwned=true;assert.equal(acknowledge(staff,page),true);assert.equal(staff.offerPages.pageCounter,before+1);
 const next=nextOfferPage(restored,{now:NOW});assert.notEqual(next.pageKey,page.pageKey);assert.ok(next.shownOffers.every(o=>!page.shownOffers.some(a=>a.reference===o.reference)));
});
test('all pages retain original references and complete without creating another search',()=>{
 const {state,all}=fixture();let count=0;for(;;){const page=nextOfferPage(state,{now:NOW});if(page.status==='complete'){assert.deepEqual(page.shownOffers,[]);assert.equal(page.pageKey,null);break;}assert.equal(page.status,'ready');assert.equal(acknowledge(state,page),true);if(++count>20)assert.fail('Unbounded page loop');}
 assert.deepEqual(state.offerPages.shownRefs,all.map(o=>o.reference));assert.equal(state.status,'done');assert.equal(state.activeComparisonId,'comparison');
});
test('caller mutations and private metadata cannot leak into the canonical saved page book',()=>{
 const {state,snapshot}=fixture(),all=offers();all[0].customer='PRIVATE_CUSTOMER';all[0].rawSupplier='PRIVATE_SUPPLIER';all[0].request.passport='PRIVATE_PASSPORT';
 setOfferPages(state,{comparisonId:'comparison',revision:3,...snapshot,offers:all,shownOffers:[],now:NOW});all[0].price.sellingTotal='1.00';snapshot.request.origin='أبوظبي';assert.equal(state.offerPages.offers[0].price.sellingTotal,'995.00');assert.doesNotMatch(JSON.stringify(state.offerPages),/PRIVATE_/);
 const page=nextOfferPage(state,{now:NOW});page.shownOffers[0].price.sellingTotal='1.00';assert.equal(acknowledge(state,page),false);assert.notEqual(state.offerPages.offers.find(o=>o.reference===page.shownOffers[0].reference).price.sellingTotal,'1.00');
});
test('another comparison, journey, request amendment or human takeover invalidates the old pages',()=>{
 for(const mutate of [s=>s.activeComparisonId='new-comparison',s=>s.tripId='new-journey',s=>s.base.request.baggageRequest.checkedWeightKg=40,s=>s.base.request.departureRange.end='2026-12-01',s=>s.humanOwned=true]){const {state}=fixture(),page=nextOfferPage(state,{now:NOW});mutate(state);assert.equal(nextOfferPage(state,{now:NOW}).status,'unavailable');assert.equal(acknowledge(state,page),false);}
});
test('a selected already-shown verified offer permits More, while failed amendments and unseen selections do not',()=>{
 const {state}=fixture(),selected=structuredClone(state.offerPages.offers.find(o=>state.offerPages.shownRefs.includes(o.reference)));selected.id='selected-offer';state.offers=[selected];state.selected=selected.id;state.base.request={...structuredClone(selected.request),providerExclusive:true,providerRestrictionSource:'selection'};
 const page=nextOfferPage(state,{now:NOW});assert.equal(page.status,'ready');assert.ok(page.shownOffers.every(o=>o.reference!==selected.reference));assert.equal(acknowledge(state,page),true);
 for(const mutate of [s=>s.base.request.baggageRequest.checkedWeightKg=40,s=>s.base.request.departureDate='2026-12-01',s=>s.base.request.passengers.adults=2]){const copy=structuredClone(state);mutate(copy);assert.equal(nextOfferPage(copy,{now:NOW}).status,'unavailable');}
 const hidden=fixture().state,unseen=structuredClone(hidden.offerPages.offers.find(o=>!hidden.offerPages.shownRefs.includes(o.reference)));unseen.id='unseen';hidden.offers=[unseen];hidden.selected='unseen';hidden.base.request={...structuredClone(unseen.request),providerExclusive:true};assert.equal(nextOfferPage(hidden,{now:NOW}).status,'unavailable');
});
test('collecting and active new-search statuses never expose previous page prices',()=>{
 for(const status of ['collecting','queued','searching','cancelled','paused']){const {state}=fixture();state.status=status;const page=nextOfferPage(state,{now:NOW});assert.equal(page.status,'unavailable');assert.equal(page.shownOffers.length,0);assert.doesNotMatch(page.text,/درهم|995\.00/);}
});
test('six-hour validity is bounded by each offer check time and rejects future timestamps',()=>{
 const {state}=fixture();assert.equal(nextOfferPage(state,{now:NOW+MAX_AGE_MS}).status,'ready');const expired=nextOfferPage(state,{now:NOW+MAX_AGE_MS+1});assert.equal(expired.reason,'expired');assert.match(expired.text,/مراجعة جديدة/);
 const {state:future}=fixture();assert.equal(nextOfferPage(future,{now:NOW-1}).reason,'expired');
 for(const checkedAt of [NOW+1,NOW-MAX_AGE_MS-1]){const {state:s,snapshot}=fixture(),all=offers();all[0].checkedAt=checkedAt;assert.throws(()=>setOfferPages(s,{comparisonId:'comparison',revision:2,...snapshot,offers:all,shownOffers:[],now:NOW}),/STALE_SNAPSHOT/);}
});
test('wrong revisions, forged refs, altered snapshot facts and stale page keys cannot advance acknowledgement',()=>{
 const {state}=fixture(),page=nextOfferPage(state,{now:NOW}),before=structuredClone(state.offerPages.shownRefs);
 assert.equal(acceptOfferPage(state,{...page,revision:99}),false);assert.equal(acceptOfferPage(state,{...page,pageKey:'forged'}),false);assert.equal(acceptOfferPage(state,{...page,shownOffers:[80]}),false);assert.deepEqual(state.offerPages.shownRefs,before);
 state.offerPages.offers[0].price.sellingTotal='1.00';assert.equal(acknowledge(state,page),false);assert.equal(nextOfferPage(state,{now:NOW}).status,'unavailable');
});
test('snapshot bounds and validation reject invalid offers, references and unbounded records',()=>{
 const {state,snapshot}=fixture();assert.throws(()=>setOfferPages(state,{comparisonId:'comparison',revision:2,...snapshot,offers:offers(81),now:NOW}),/INVALID_SNAPSHOT/);
 const bad=offers();bad[0].price.sellingTotal='unverified';assert.throws(()=>setOfferPages(state,{comparisonId:'comparison',revision:2,...snapshot,offers:bad,now:NOW}),/INVALID_OFFER/);
 assert.throws(()=>setOfferPages(state,{comparisonId:'comparison',revision:2,...snapshot,shownOffers:[80],now:NOW}),/INVALID_REFERENCES/);
 assert.throws(()=>setOfferPages(state,{comparisonId:'comparison',revision:2,...snapshot,statuses:[{provider:'PRIVATE',status:'available'}],now:NOW}),/INVALID_STATUSES/);
});
