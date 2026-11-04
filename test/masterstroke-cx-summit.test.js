'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {AssistantEngine}=require('../src/assistant-engine');
const {SaudiVisaEngine,extractLocal}=require('../src/saudi-visa-engine');
const profile=require('../src/customer-profile'),bilingual=require('../src/bilingual-intake'),bridge=require('../src/cross-service-bridge'),ready=require('../src/prebooking-readiness'),analytics=require('../src/cx-analytics');
const {languagePatch}=require('../src/travel-language');
const {routeService}=require('../src/service-routing');
const now=Date.parse('2026-11-04T12:00:00Z'),day=86400000;
const store=()=>new AssistantState({file:null,now:()=>now});
const flight=()=>new AssistantEngine({store:store(),nlu:async()=>null,env:{}});
const visa=()=>new SaudiVisaEngine({store:store(),now:()=>now,env:{},understand:null});
const request={origin:'SHJ',destination:'DAM',tripType:'one_way',provider:'airarabia',providerExclusive:true,passengers:{adults:1},baggageRequest:{checkedWeightKg:30}};
const applicant={nationality:'سوريا',documentType:'passport'};
test('16 profiles whitelist preferences and never retain identity, dates, quotes or payment evidence',()=>{
 const s=store();profile.rememberFlightJourney(s,'synthetic-a',{...request,departureDate:'2090-01-01',passportNumber:'SECRET',payment:{amount:999},price:999},{now});
 profile.rememberVisaJourney(s,'synthetic-a',{applicantCount:1,applicants:[{...applicant,name:'PRIVATE',passportNumber:'SECRET'}],paymentStatus:'verified',documents:['PRIVATE'],quote:{total:999}},{now});
 const p=s.data.customerProfiles['synthetic-a'];assert.equal(p.flight.origin,'الشارقة');assert.equal(p.flight.destination,'دمشق');assert.equal(p.visa.nationality,'سوريا');assert.doesNotMatch(JSON.stringify(p),/SECRET|PRIVATE|2090|999|payment|passportNumber/);
 profile.rememberFlightJourney(s,'synthetic-a',{...request,providerExclusive:false},{now});assert.equal(s.data.customerProfiles['synthetic-a'].flight.provider,null);
 assert.match(profile.returningGreeting(s,'synthetic-a','flight',{now}),/الشارقة إلى دمشق/);assert.match(profile.returningGreeting(s,'synthetic-a','saudi_visa',{now}),/سوريا.*جواز سفر عادي/);
});
test('16 each service expires independently, insertion cap is exact, and unsafe keys cannot pollute prototypes',()=>{
 const s={data:{},save(){}};profile.rememberFlightJourney(s,'a',request,{now:now-181*day});profile.rememberVisaJourney(s,'a',{applicants:[applicant]},{now});
 assert.equal(profile.returningGreeting(s,'a','flight',{now}),null);assert.ok(profile.returningGreeting(s,'a','saudi_visa',{now}));
 for(let i=0;i<2000;i++)s.data.customerProfiles['c'+i]={flight:{origin:'الشارقة',destination:'دمشق',lastAt:now},updatedAt:now};profile.rememberFlightJourney(s,'newest',request,{now:now+1});assert.equal(Object.keys(s.data.customerProfiles).length,2000);
 for(const id of ['__proto__','constructor','prototype'])assert.equal(profile.rememberFlightJourney(s,id,request,{now}),null);
 assert.equal({}.flight,undefined);assert.equal(profile.rememberVisaJourney(s,'unknown',{applicants:[{nationality:'name SECRET',documentType:'travel_document',documentIssuer:'PRIVATE'}]},{now}).documentIssuer,null);
});
test('16 encrypted state prunes old profiles and both deletion paths remove them',async()=>{
 const e=flight();profile.rememberFlightJourney(e.store,'delete-flight',request,{now});await e.handle('delete-flight','حذف بياناتي',{now});assert.equal(e.store.data.customerProfiles['delete-flight'],undefined);
 const v=visa();profile.rememberVisaJourney(v.store,'delete-visa',{applicants:[applicant]},{now});await v.handle('delete-visa','امسح بياناتي');assert.equal(v.store.data.customerProfiles['delete-visa'],undefined);
 e.store.data.customerProfiles={expired:{flight:{...request,lastAt:now-181*day},updatedAt:now-181*day}};e.store.save();assert.deepEqual(e.store.data.customerProfiles,{});
});
test('16 completed flight intake and quoted visa remember preferences; return greetings do not restore old facts',async()=>{
 const e=flight(),r=await e.handle('complete','من الشارقة إلى دمشق 15/11/2026 ذهاب فقط 1 بالغ وزن 30 كيلو',{now});assert.equal(r.complete,true);assert.equal(e.store.data.customerProfiles.complete.flight.origin,'الشارقة');
 const v=visa();await v.handle('quoted','سوري جواز عادي لحالي');assert.equal(v.getCase('quoted').stage,'quoted');assert.equal(v.store.data.customerProfiles.quoted.visa.nationality,'سوريا');
 profile.rememberFlightJourney(e.store,'returner',request,{now});const greeting=await e.handle('returner','مرحبا',{now});assert.match(greeting.reply,/بآخر طلب/);assert.equal(e.state('returner').base?.request?.origin??null,null);
 profile.rememberVisaJourney(v.store,'returner',{applicants:[applicant]},{now});assert.match((await v.handle('returner','مرحبا')).reply,/بآخر استفسار/);assert.deepEqual(v.getCase('returner').applicants,[]);
 const before=structuredClone(v.getCase('quoted').applicants);await v.handle('quoted','مرحبا');assert.deepEqual(v.getCase('quoted').applicants,before);
});
test('17 bilingual route aliases, passenger counts, baggage and carrier restrictions merge into real intake',()=>{
 const p=languagePatch('بدي SHJ to DAM, one-way, two adults, 30 kg, only Air Arabia');assert.equal(p.origin,'الشارقة');assert.equal(p.destination,'دمشق');assert.equal(p.tripType,'one_way');assert.equal(p.adults,2);assert.equal(p.weightKg,30);assert.equal(p.providerExclusive,true);assert.equal(p.providerRestrictionSource,'customer');
 for(const [route,o,d]of [['DWC -> ALP','آل مكتوم','حلب'],['from Dubai World Central to Aleppo','آل مكتوم','حلب'],['Fujairah to Latakia','الفجيرة','اللاذقية'],['Ras Al Khaimah to Damascus','رأس الخيمة','دمشق']]){const p=languagePatch(route);assert.equal(p.origin,o);assert.equal(p.destination,d);}
 assert.equal(languagePatch('return ticket, just me, hand luggage only').tripType,'round_trip');assert.equal(languagePatch('return ticket, just me, hand luggage only').weightKg,0);
 assert.equal(languagePatch('any airline').providerExclusive,false);assert.equal(languagePatch('Air Arabia').providerExclusive,undefined);
 assert.equal(bilingual.detectLanguageStyle('بدي 30 kg'),'mixed');assert.equal(bilingual.detectLanguageStyle('hello'),'en');assert.equal(bilingual.detectLanguageStyle('مرحبا'),'ar');
});
test('17 negated facts, issuer countries and bank statements are never positive declarations',()=>{
 for(const text of ['not from SHJ to DAM','not one way','not 2 adults','not 30 kg','not Air Arabia'])assert.deepEqual(languagePatch(text),{},text);
 assert.equal(languagePatch('not one way, return ticket').tripType,'round_trip');
 assert.deepEqual(bilingual.parseEnglishVisaFacts('I do not have a passport'),{});assert.deepEqual(extractLocal('not Syrian, no passport',{applicants:[]}),{});
 const p=extractLocal('Palestinian travel document issued by Lebanon, 1 person, by car',{applicants:[]});assert.equal(p.nationality,'فلسطين');assert.equal(p.documentIssuer,'لبنان');assert.equal(p.transport,'car');
 assert.equal(extractLocal('bank statement',{applicants:[]}).paymentMethod,undefined);
 assert.equal(bilingual.parseEnglishVisaFacts('two applicants, by air, bank transfer').paymentMethod,'bank');
});
test('17 English route and visa facts reach engines without model assistance or invented prices',async()=>{
 const e=flight(),r=await e.handle('english','SHJ to DAM, one way, 15/11/2026, 1 adult, 30 kg',{now});assert.equal(r.complete,true);assert.equal(r.request.destination,'دمشق');assert.equal(r.request.passengers.adults,1);
 const v=visa(),out=await v.handle('english','Syrian regular passport, just me');assert.equal(out.stage,'quoted');assert.equal(v.getCase('english').applicants[0].nationality,'سوريا');assert.equal(v.getCase('english').paymentStatus,'unverified');
 const routed=routeService(store(),'iata','SHJ to DAM');assert.equal(routed.service,'flight');
});
test('18 both transition directions preserve independent requests and banners are added only once',()=>{
 const f={base:{request:{origin:'الشارقة',destination:'دمشق'}}},v={id:'synthetic-case',stage:'quoted',applicants:[applicant],paymentStatus:'verified'},s=store();s.data.customers.a=f;s.data.visaCases={a:v};s.data.serviceSessions={a:{service:'flight'}};
 const before=JSON.stringify([f,v]),change=bridge.detectCrossServiceSwitch('flight','فيزا السعودية',{flightState:f,visaCase:v});assert.equal(change.preserveFlight,true);
 const b=bridge.transitionBanner(change.from,change.to,change);assert.match(b,/أحمد.*إسماعيل/);assert.equal(bridge.withTransitionBanner(bridge.withTransitionBanner('hello',b),b).split(b).length,2);
 routeService(s,'a','فيزا السعودية');assert.equal(s.data.serviceSessions.a.service,'saudi_visa');const back=bridge.detectCrossServiceSwitch('saudi_visa','طيران',{flightState:f,visaCase:v});assert.equal(back.preserveVisa,true);assert.match(bridge.transitionBanner(back.from,back.to,back),/إسماعيل.*أحمد/);routeService(s,'a','طيران');assert.equal(JSON.stringify([f,v]),before);
 assert.equal(bridge.detectCrossServiceSwitch('flight','طيران وفيزا').switched,false);assert.equal(bridge.transitionBanner('flight','saudi_visa',{}),null);assert.doesNotMatch(b,/رعد|Raad/i);
});
test('19 strict dates and boundary day counts reject impossible dates and avoid month/approval claims',()=>{
 assert.equal(ready.parseIsoDate('29/02/2028'),'2028-02-29');assert.equal(ready.parseIsoDate('31/02/2026'),null);assert.equal(ready.parseIsoDate('٢٠٢٦-١١-٠٤'),'2026-11-04');
 for(const [days,status]of [[-1,'expired'],[0,'under_3_months'],[89,'under_3_months'],[90,'under_6_months'],[179,'under_6_months'],[180,'valid']]){const date=new Date(Date.parse('2026-01-01')+days*day).toISOString().slice(0,10),r=ready.checkPassportValidityDate(date,'2026-01-01');assert.equal(r.daysRemaining,days);assert.equal(r.status,status);assert.doesNotMatch(r.warningCopy,/أكثر من 6 أشهر/);}
 assert.equal(ready.checkResidencyValidityDate('2026-04-01','2026-01-01').status,'valid');assert.equal(ready.checkResidencyValidityDate('2026-03-31','2026-01-01').status,'under_3_months');assert.equal(ready.checkPassportValidityDate('bad','2026-01-01'),null);
 assert.equal(ready.readinessReferenceDate({},Date.parse('2026-11-04T22:30:00Z')),'2026-11-05');
});
test('19 expiry extraction associates the right document and rejects travel dates and conflicting expiry claims',()=>{
 assert.deepEqual(ready.extractMentionedExpiryDates('جواز السفر ينتهي 2027-01-01'),{passportExpiry:'2027-01-01'});
 assert.deepEqual(ready.extractMentionedExpiryDates('جوازي ينتهي ٢٠٢٧-٠١-٠١، وإقامتي تنتهي ٢٠٢٦-١٢-٠١'),{passportExpiry:'2027-01-01',residencyExpiry:'2026-12-01'});
 assert.deepEqual(ready.extractMentionedExpiryDates('passport expires 01/01/2027, residency expires 01/12/2026'),{passportExpiry:'2027-01-01',residencyExpiry:'2026-12-01'});
 assert.deepEqual(ready.extractMentionedExpiryDates('جوازي صالح، سفري 2026-11-20'),{});
 assert.deepEqual(ready.extractMentionedExpiryDates('جوازي ينتهي 2027-01-01، جوازي ينتهي 2027-02-01'),{});
 assert.deepEqual(ready.extractMentionedExpiryDates('passport issued 2026-01-01, expiry unknown'),{});
});
test('19 expiry advice cannot mutate an active trip or a paid visa case and uses the right reference date',async()=>{
 const e=flight();await e.handle('validity','من الشارقة إلى دمشق 15/11/2026 ذهاب فقط 1 بالغ وزن 30 كيلو',{now});const before=structuredClone(e.state('validity').base);
 const out=await e.handle('validity','جوازي ينتهي 2026-12-15',{now});assert.match(out.reply,/30 يوماً/);assert.equal(out.validityWarning,true);assert.deepEqual(e.state('validity').base,before);
 const v=visa();await v.handle('paid','سوري جواز عادي لحالي');const c=v.getCase('paid');c.paymentStatus='verified';c.departureDate='2026-11-15';v.save('paid',c);const facts=structuredClone(c);
 const result=await v.handle('paid','passport expires 2026-12-15, residency expires 2026-12-01');assert.match(result.reply,/30 يوماً/);assert.match(result.reply,/16 يوماً/);assert.equal(result.validityWarning,true);
 for(const k of ['applicants','departureDate','paymentStatus','quote','stage'])assert.deepEqual(v.getCase('paid')[k],facts[k]);
});
test('19 selected offer warns about the actual return airport without changing its fare or booking',async()=>{
 const e=flight();await e.handle('airport','من الشارقة إلى دمشق 15/11/2026 ذهاب فقط 1 بالغ وزن 30 كيلو',{now});const r=e.state('airport').base.request;
 e.progress('airport',{offer:{reference:1,provider:'airarabia',checkedAt:now,request:{...r,returnDestination:'دبي'},timing:{out:{flight:'G9123',departure:'08:00',arrival:'10:00'},back:{flight:'G9124',destination:'DXB'}},price:{currency:'AED',sellingTotal:'650.10',weights:[{kg:30}]}}},'synthetic-offer');
 const result=await e.handle('airport','الخيار 1',{now});assert.match(result.reply,/الشارقة.*العودة إلى مطار \*دبي\*/);assert.match(result.reply,/650\.10/);assert.match(result.reply,/إعادة تحقق/);assert.equal(result.handoff,undefined);
 assert.equal(ready.offerAirportMismatchNotice({request:{origin:'SHJ',returnDestination:'الشارقة'}}),null);
});
test('20 aggregate analytics are bounded and cannot retain identifiers, text or arbitrary reason keys',()=>{
 const s=store();analytics.recordCxEvent(s,{service:'flight',category:'resolved',customerId:'PRIVATE',rawText:'SECRET',language:'en',now});analytics.recordCxEvent(s,{service:'saudi_visa',category:'escalated',reason:'complaint',language:'mixed',sentiment:'frustrated',now});
 analytics.recordCxEvent(s,{service:'flight',category:'voice_transcribed',now});analytics.recordCxEvent(s,{service:'flight',category:'voice_fallback',now});analytics.recordCxEvent(s,{service:'flight',category:'escalated',reason:'__proto__',now});
 const summary=analytics.cxAnalyticsSummary(s,{now});assert.equal(summary.selfServiceRate,33.3);assert.equal(summary.voice.transcribed,1);assert.equal(summary.voice.fallback,1);assert.equal(summary.escalationReasons.complaint,1);assert.equal(summary.languageCounts.en,1);assert.doesNotMatch(JSON.stringify(s.data.cxAnalytics),/PRIVATE|SECRET|__proto__/);
 assert.equal(analytics.recordCxEvent(s,{service:'other',category:'resolved',now}),false);
 s.data.cxAnalytics.events.push({service:'flight',category:'resolved',at:now+1},{service:'flight',category:'resolved',at:now-31*day},{service:'__proto__',category:'resolved',at:now});assert.equal(analytics.cxAnalyticsSummary(s,{now}).totalEvents,5);assert.equal(analytics.cxAnalyticsSummary(s,{now,windowHours:Infinity}).windowHours,168);
 const fast={data:{},save(){}};for(let i=0;i<1501;i++)analytics.recordCxEvent(fast,{service:'flight',category:'resolved',now:now+i});assert.equal(fast.data.cxAnalytics.events.length,1500);assert.equal(analytics.cxAnalyticsSummary({data:{}},{now}).selfServiceRate,null);
});
test('17 English family requests cannot quote a child as an adult, and denials preserve saved facts',async()=>{
 const e=flight();await e.handle('family-en','SHJ to DAM, one way, 15/11/2026, 1 adult and 1 child, 30 kg',{now});assert.equal(e.state('family-en').base.request.passengers.children,1);assert.notEqual(e.state('family-en').status,'queued');
 const v=visa(),r=await v.handle('family-en','Syrian passport, 1 adult and 1 child');assert.equal(v.getCase('family-en').hasMinors,true);assert.equal(r.quote?.total,undefined);
 await e.handle('denial','من الشارقة إلى دمشق 15/11/2026 ذهاب وعودة 20/11/2026 1 بالغ وزن 30 كيلو',{now});const before=structuredClone(e.state('denial').base);await e.handle('denial','not one way',{now});assert.deepEqual(e.state('denial').base,before);
 await v.handle('denial','مرحبا');await v.handle('denial','not Syrian');assert.deepEqual(v.getCase('denial').applicants,[]);
});
