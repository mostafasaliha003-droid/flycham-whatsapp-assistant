'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildOfferDigest}=require('../src/offer-digest');
const NOW=Date.parse('2026-10-25T04:05:00Z');
const request={origin:'دبي',destination:'دمشق',departureRange:{start:'2026-11-01',end:'2026-11-30'},tripType:'one_way',passengers:{adults:1,children:0,infants:0}};
function offer(n,{round=false,price}={}){const day=String(1+(n%20)).padStart(2,'0');return {reference:n,provider:n%2?'flycham':'airarabia',request:{...request,origin:n%2?'دبي':'الشارقة',departureDate:'2026-11-'+day,departureRange:null,tripType:round?'round_trip':'one_way',returnDate:round?'2026-12-'+day:null},price:{currency:'AED',sellingTotal:price||String(500+n)+'.00',weights:[{kg:30}],...(n%2?{voucherValue:round?'25.00':'10.00'}:{})},timing:{out:{flight:n%2?'XH'+n:'G9'+n,departure:'08:15',arrival:'11:40'},...(round?{back:{flight:n%2?'XH'+(n+100):'G9'+(n+100),departure:'18:30',arrival:'21:45'}}:{})},checkedAt:NOW};}
test('consolidates both airlines sorted by actual price while preserving original option references and facts',()=>{
 const input=[offer(8,{price:'620.25'}),offer(3,{price:'610.05'}),offer(1,{price:'700.00'})],before=structuredClone(input),result=buildOfferDigest({request,offers:input,ready:true,statuses:[]});
 assert.deepEqual(result.shownOffers.map(o=>o.reference),[3,8,1]);assert.deepEqual(result.remainingOffers,[]);assert.equal(result.totalCount,3);assert.ok(result.text.indexOf('*الخيار 3 —')<result.text.indexOf('*الخيار 8 —'));
 for(const o of input){assert.match(result.text,new RegExp(o.price.sellingTotal.replace('.','\\.')));assert.ok(result.text.includes(o.request.departureDate));assert.ok(result.text.includes(o.timing.out.flight));}assert.match(result.text,/العربية للطيران/);assert.match(result.text,/فلاي شام/);assert.match(result.text,/من دبي إلى دمشق/);assert.match(result.text,/من الشارقة إلى دمشق/);assert.match(result.text,/08:15.*11:40/);assert.match(result.text,/30 كيلو مسجّل/);assert.match(result.text,/صالح سنة/);assert.match(result.text,/لا يُخصم/);assert.match(result.text,/08:05.*بتوقيت دبي/);assert.deepEqual(input,before);
});
test('all eighty roundtrip offers paginate without silent omission or renumbering and each final message fits WhatsApp',()=>{
 const offers=Array.from({length:80},(_,i)=>offer(i+1,{round:true})),snapshot={request:{...request,tripType:'round_trip'},offers,ready:true,statuses:[{status:'unverified'}]},seen=[];
 for(let page=0;page<80;page++){
  const result=buildOfferDigest(snapshot,{excludeRefs:seen});assert.ok(result.text.length<=3900);assert.ok(result.shownOffers.length>0);assert.equal(result.totalCount,80);
  const refs=result.shownOffers.map(o=>o.reference);assert.equal(new Set([...seen,...refs]).size,seen.length+refs.length);for(const o of result.shownOffers){assert.ok(result.text.includes('*الخيار '+o.reference+' —'));assert.ok(result.text.includes(o.request.returnDate));assert.ok(result.text.includes(o.timing.back.flight));assert.ok(result.text.includes(o.price.sellingTotal));}
  seen.push(...refs);assert.equal(result.remainingOffers.length,80-seen.length);assert.ok(result.remainingOffers.every(o=>!seen.includes(o.reference)));assert.match(result.text,/لا تثبت الأرخص في كامل الفترة/);
  if(!result.remainingOffers.length)break;assert.match(result.text,/المزيد.*لبقية التواقيت/);
 }
 assert.equal(seen.length,80);assert.equal(new Set(seen).size,80);const exhausted=buildOfferDigest(snapshot,{excludeRefs:seen});assert.equal(exhausted.remainingOffers.length,0);assert.match(exhausted.text,/سبق إرسالها/);
});
test('return dates, flight numbers, overnight arrival dates and exact cents remain visible',()=>{
 const o=offer(7,{round:true,price:'599.09'});o.timing.out.departure=o.request.departureDate+' 23:30';o.timing.out.arrival='2026-11-09 02:15';const result=buildOfferDigest({request:{...request,tripType:'round_trip'},offers:[o],ready:true});assert.match(result.text,/599\.09/);assert.ok(result.text.includes(o.request.returnDate));assert.match(result.text,/18:30.*21:45/);assert.match(result.text,/02:15 \(2026-11-09\)/);assert.match(result.text,/25\.00/);
});
test('no offers preserve the application-rendered no-inventory-claim followup and pending never announces completion',()=>{
 const reply='لم يتأكد سعر جاهز، وهذا لا يعني عدم وجود رحلات. بتحب نوسّع البحث سبعة أيام؟';assert.equal(buildOfferDigest({request,offers:[],ready:true,reply}).text,reply);
 const pending=buildOfferDigest({request,offers:[],ready:false});assert.match(pending.text,/لسه قيد التحقق/);assert.doesNotMatch(pending.text,/ما في رحلات|ممتلئة|بتحب نوسّع|رتّبتلك الأسعار/);
 const long=buildOfferDigest({request,offers:[],ready:true,reply:'نص طويل '.repeat(1000)});assert.ok(long.text.length<=3900);assert.match(long.text,/لم يتأكد سعر/);assert.doesNotMatch(long.text,/ما في رحلات متاحة/);
});
test('a verified family total keeps actual party composition and supplied ages visible',()=>{
 const r={...request,passengers:{adults:1,children:1,infants:1,ages:[7,1]}},o=offer(1,{price:'1450.00'});o.request.passengers=r.passengers;const result=buildOfferDigest({request:r,offers:[o],ready:true});assert.match(result.text,/1 بالغ، 1 طفل، 1 رضيع/);assert.match(result.text,/وقت السفر: 7، 1/);assert.match(result.text,/1450\.00/);assert.doesNotMatch(result.text,/للشخص/);
});
test('a smaller explicit budget retains undisplayed options and never drops a price mid-card',()=>{
 const offers=Array.from({length:12},(_,i)=>offer(i+1)),result=buildOfferDigest({request,offers,ready:true},{maxLength:1600});assert.ok(result.text.length<=1600);assert.ok(result.shownOffers.length>0);assert.equal(result.shownOffers.length+result.remainingOffers.length,12);for(const o of result.shownOffers)assert.ok(result.text.includes(o.price.sellingTotal));assert.match(result.text,/خيار متأكد إضافي/);
});
test('malformed untrusted prices, reference collisions and incomplete return facts are not rendered',()=>{
 const o=offer(1);assert.throws(()=>buildOfferDigest({request,offers:[{...o,price:{...o.price,sellingTotal:'500 درهم'}}]}),/INVALID_OFFER/);assert.throws(()=>buildOfferDigest({request,offers:[o,o]}),/REFERENCE_COLLISION/);assert.throws(()=>buildOfferDigest({request,offers:[{...offer(2,{round:true}),timing:{out:o.timing.out}}]}),/INVALID_OFFER/);assert.throws(()=>buildOfferDigest({request,offers:[o]},{maxLength:300}),/BUDGET_INVALID/);
});
function checkStatus(provider,origin,status,{date='2026-11-11',phase='exact',destination='دمشق'}={}){return {provider,origin,destination,date,phase,status};}
test('a supplier with no offer gets a compact route-scoped negative only from wholly verified negative checks',()=>{
 const result=buildOfferDigest({request,offers:[offer(1)],ready:true,statuses:[checkStatus('airarabia','الشارقة','no_flights'),checkStatus('airarabia','الشارقة','no_flights',{date:'2026-11-12'})],reply:'LEGACY_GIANT_COMPARISON '.repeat(300)});
 assert.match(result.text,/العربية للطيران — من الشارقة إلى دمشق: لا توجد رحلات متاحة ضمن الأيام المفحوصة \(2026-11-11 إلى 2026-11-12\)/);assert.match(result.text,/501\.00/);assert.doesNotMatch(result.text,/LEGACY_GIANT|راجعت الفترة المطلوبة|كامل الشهر|الخيار 2/);assert.ok(result.text.length<=3900);
 const sold=buildOfferDigest({request,offers:[offer(1)],ready:true,statuses:[checkStatus('airarabia','الشارقة','sold_out')]});assert.match(sold.text,/لا تتوفر مقاعد لهذا الطلب ضمن الأيام المفحوصة/);
 const mixed=buildOfferDigest({request,offers:[offer(1)],ready:true,statuses:[checkStatus('airarabia','الشارقة','no_flights'),checkStatus('airarabia','الشارقة','sold_out',{date:'2026-11-12'})]});assert.match(mixed.text,/لم يظهر خيار متاح ضمن الأيام المفحوصة/);assert.doesNotMatch(mixed.text,/لا توجد رحلات متاحة/);
});
for(const status of ['unverified','auth_required','pending','partial'])test('an '+status+' child prevents a supplier inventory claim despite other negative checks',()=>{
 const result=buildOfferDigest({request,offers:[offer(1)],ready:status!=='pending',statuses:[checkStatus('airarabia','الشارقة','no_flights'),checkStatus('airarabia','الشارقة',status,{date:'2026-11-12'})]});
 assert.match(result.text,/العربية للطيران — من الشارقة إلى دمشق: لم يتأكد عرض جاهز حتى الآن/);assert.match(result.text,/لا يعني عدم وجود رحلات أو امتلاء المقاعد/);assert.doesNotMatch(result.text,/لا توجد رحلات متاحة|لا تتوفر مقاعد|لم يظهر خيار متاح|تسجيل الدخول|auth_required/);
});
test('FlyCham alternatives to Abu Dhabi identify their real origin airports without claiming an Abu Dhabi check',()=>{
 const dubai=offer(1),sharjah=offer(3);sharjah.request.origin='الشارقة';
 const result=buildOfferDigest({request:{...request,origin:'أبوظبي'},offers:[dubai,sharjah],ready:true,statuses:[checkStatus('flycham','دبي','available',{date:dubai.request.departureDate,phase:'airports'}),checkStatus('flycham','الشارقة','available',{date:sharjah.request.departureDate,phase:'airports'}),checkStatus('airarabia','أبوظبي','unverified')]});
 assert.match(result.text,/طلبك: من أبوظبي إلى دمشق/);assert.match(result.text,/مقارنة فلاي شام هنا من دبي والشارقة؛ لا تشمل فحص المغادرة من أبوظبي/);assert.match(result.text,/العربية للطيران — من أبوظبي إلى دمشق: لم يتأكد عرض/);assert.doesNotMatch(result.text,/فلاي شام — من أبوظبي|راجعت.*أبوظبي|لا توجد رحلات متاحة/);assert.deepEqual(result.shownOffers.map(o=>o.reference),[1,3]);
});
test('exact-date negatives remain separate from verified nearby offers on the same supplier route',()=>{
 const o=offer(2);o.request.departureDate='2026-11-12';
 const result=buildOfferDigest({request:{...request,origin:'الشارقة',departureDate:'2026-11-11',departureRange:null},offers:[o],ready:true,statuses:[checkStatus('airarabia','الشارقة','no_flights'),checkStatus('airarabia','الشارقة','available',{date:'2026-11-12',phase:'alternatives'})]});
 assert.match(result.text,/لا توجد رحلات متاحة ضمن الأيام المفحوصة \(2026-11-11\)/);assert.match(result.text,/الخيار 2/);assert.match(result.text,/2026-11-12/);assert.match(result.text,/502\.00/);assert.doesNotMatch(result.text,/لا توجد رحلات متاحة ضمن الأيام القريبة/);
});
test('missing route or date provenance cannot support a route-specific inventory claim',()=>{
 for(const statuses of [[{provider:'airarabia',status:'no_flights'}],[checkStatus('airarabia','الشارقة','no_flights',{date:'invalid'})]]){
  const result=buildOfferDigest({request,offers:[offer(1)],ready:true,statuses});assert.match(result.text,/لم يتأكد عرض جاهز/);assert.doesNotMatch(result.text,/لا توجد رحلات متاحة|لا تتوفر مقاعد|لم يظهر خيار متاح/);
 }
});
test('supplier summaries participate in pagination without losing or renumbering any verified quote',()=>{
 const offers=Array.from({length:40},(_,i)=>offer(2*i+1,{round:true})),statuses=[checkStatus('airarabia','أبوظبي','no_flights'),checkStatus('airarabia','الشارقة','auth_required')],snapshot={request:{...request,tripType:'round_trip'},offers,ready:true,statuses},seen=[];
 while(seen.length<offers.length){const result=buildOfferDigest(snapshot,{excludeRefs:seen});assert.ok(result.text.length<=3900);assert.ok(result.shownOffers.length>0);assert.match(result.text,/العربية للطيران — من أبوظبي إلى دمشق: لا توجد رحلات متاحة/);assert.match(result.text,/العربية للطيران — من الشارقة إلى دمشق: لم يتأكد عرض/);for(const o of result.shownOffers){assert.ok(result.text.includes('*الخيار '+o.reference+' —'));assert.ok(result.text.includes(o.price.sellingTotal));assert.ok(!seen.includes(o.reference));seen.push(o.reference);}assert.equal(result.remainingOffers.length,offers.length-seen.length);}
 assert.equal(new Set(seen).size,40);
});
test('nearby dates keep explicit before/after labels relative to the requested day and never relabel an exact match',()=>{
 const target={...request,origin:'الشارقة',departureDate:'2026-11-11',departureRange:null};
 for(const [date,label]of [['2026-11-10','قبل موعدك بيوم'],['2026-11-09','قبل موعدك بيومين'],['2026-11-08','قبل موعدك بـ3 أيام'],['2026-11-12','بعد موعدك بيوم'],['2026-11-13','بعد موعدك بيومين'],['2026-11-14','بعد موعدك بـ3 أيام']]){
  const o=offer(2);o.request.departureDate=date;const result=buildOfferDigest({request:target,offers:[o],ready:true});assert.ok(result.text.includes(label));assert.ok(result.text.includes(date));assert.match(result.text,/التاريخ المطلوب: 2026-11-11/);assert.match(result.text,/الخيار 2/);
 }
 const same=offer(2);same.request.departureDate=target.departureDate;assert.doesNotMatch(buildOfferDigest({request:target,offers:[same],ready:true}).text,/بديل قبل|بديل بعد/);
});
