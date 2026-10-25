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
test('eight full round-trip examples fit the WhatsApp budget while retaining actual flight facts and voucher conditions',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now}),accepted=[];
 for(const provider of ['flycham','airarabia'])for(const date of ['2026-10-29','2026-10-30','2026-11-11','2026-11-12']){
  const returnDate=new Date(Date.parse(date+'T00:00:00Z')+14*86400000).toISOString().slice(0,10),r=request({provider,origin:provider==='flycham'?'دبي':'أبوظبي',destination:'حلب',departureDate:date,returnDate,tripType:'round_trip',stayNights:14});
  const prefix=provider==='flycham'?'XH':'G9',n=accepted.length+1,o=offer(r,`${9000000+n}.99`,prefix+(8100+n));
  o.timing={out:{flight:prefix+(8100+n),departure:date+' 23:55',arrival:date+' 23:59'},back:{flight:prefix+(9100+n),departure:returnDate+' 00:05',arrival:returnDate+' 02:55'}};o.price.weights=[{kg:30},{kg:40}];
  now+=60000;assert.equal(c.acceptOffer(o,provider),true);accepted.push({...o,checkedAt:now});
 }
 const reply=c.reply();assert.ok(reply.length<=3600,`Indicative response has ${reply.length} characters`);assert.equal((reply.match(/آخر إجمالي رصدناه/g)||[]).length,8);
 const dt=new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',dateStyle:'short',timeStyle:'short'});
 for(const o of accepted){for(const fact of [o.request.origin,o.request.destination,o.request.departureDate,o.request.returnDate,o.timing.out.flight,o.timing.out.departure,o.timing.out.arrival,o.timing.back.flight,o.timing.back.departure,o.timing.back.arrival,o.price.sellingTotal,dt.format(o.checkedAt)])assert.ok(reply.includes(fact),'Missing actual observed fact: '+fact);}
 assert.match(reply,/30 كغ مسجل \/ 40 كغ مسجل/);assert.match(reply,/\+10 كغ يد/);assert.match(reply,/إقامة مرجعية 14 ليلة/);assert.match(reply,/الفئة: بالغ واحد/);assert.match(reply,/بتوقيت دبي/);assert.match(reply,/استرشادية/);assert.match(reply,/ليست تأكيدًا للسعر الحالي/);assert.match(reply,/لفلاي شام فقط: فاوجر بعد إصدار التذكرة/);assert.match(reply,/10 دراهم للذهاب و25 للذهاب والعودة/);assert.match(reply,/صالح سنة/);assert.match(reply,/لا يخصم من السعر الحالي/);assert.match(reply,/نعيد تأكيد السعر والتوفر/);
});
test('oversized supplier timing facts omit whole examples explicitly and preserve balanced observations within the hard budget',()=>{
 const c=new FareCatalog({now:()=>NOW});let n=0;
 for(const provider of ['flycham','airarabia'])for(const date of ['2026-10-29','2026-11-11'])for(const nights of [0,7]){
  const returnDate=nights?new Date(Date.parse(date+'T00:00:00Z')+nights*86400000).toISOString().slice(0,10):null,r=request({provider,departureDate:date,returnDate,tripType:nights?'round_trip':'one_way',...(nights?{stayNights:nights}:{})}),o=offer(r,`${600+(++n)}.00`,(provider==='flycham'?'XH':'G9')+(8100+n));
  const detail=' (supplier local departure and arrival date with verified timezone information)'.repeat(3);o.timing.out.departure=date+' 10:00'+detail;o.timing.out.arrival=date+' 12:00'+detail;
  if(o.timing.back){o.timing.back.departure=returnDate+' 13:00'+detail;o.timing.back.arrival=returnDate+' 15:00'+detail;}assert.equal(c.acceptOffer(o,provider),true);
 }
 const reply=c.reply(),shown=(reply.match(/آخر إجمالي رصدناه/g)||[]).length;assert.ok(reply.length<=3600);assert.ok(shown>0&&shown<8);assert.ok(reply.includes(`لم نعرض ${8-shown} من الأمثلة المحفوظة`));assert.match(reply,/2026-10/);assert.match(reply,/2026-11/);assert.match(reply,/فلاي شام/);assert.match(reply,/العربية للطيران/);assert.match(reply,/ذهاب فقط/);assert.match(reply,/ذهاب وعودة/);assert.match(reply,/نعيد تأكيد السعر/);assert.doesNotMatch(reply,/أرخص سعر في كامل الشهر|فحصنا كل الشهر/);
});
test('background starts are bounded per provider while the cached search plan remains complete',()=>{
 const c=new FareCatalog({now:()=>NOW}),planned=c.plan('flycham').length;
 for(const provider of ['flycham','airarabia'])for(let n=0;n<2;n++){
  const job=c.claim(provider);assert.ok(job?.catalog);assert.equal(c.backgroundBudget(provider).used,n+1);
  assert.equal(c.finish(job.id,job.lease,'done',[{date:job.request.departureDate,status:'no_flights'}]),true);
 }
 assert.equal(c.claim('flycham'),null);assert.equal(c.claim('airarabia'),null);
 assert.equal(c.plan('flycham').length,planned-2);
 const budget=c.status().backgroundBudget;assert.equal(budget.policy,'starts_per_provider_window');
 assert.deepEqual(budget.providers.flycham,{limit:2,windowMs:FRESH_MS,used:2,remaining:0,eligible:false,windowStartedAt:NOW,nextWindowAt:NOW+FRESH_MS});
 assert.equal(c.status().completeMonthlyCoverage,false);
});
test('a claimed start is durable before return and cannot be reset by reloading the catalog',()=>{
 let now=NOW,saves=0;const store={data:{},save(){saves++;}};
 const firstCatalog=new FareCatalog({now:()=>now,store}),first=firstCatalog.claim('flycham');
 assert.ok(first);assert.equal(saves,1);assert.equal(store.data.catalogBudget.providers.flycham.used,1);
 const restored=new FareCatalog({now:()=>now,store}),second=restored.claim('flycham');assert.ok(second);assert.equal(store.data.catalogBudget.providers.flycham.used,2);
 restored.finish(second.id,second.lease,'failed',[]);
 const again=new FareCatalog({now:()=>now,store});assert.equal(again.claim('flycham'),null);assert.equal(again.backgroundBudget('flycham').remaining,0);
 assert.ok(again.claim('airarabia'));assert.equal(again.backgroundBudget('airarabia').used,1);
});
test('failed or abandoned expired work consumes its start instead of causing an unbounded retry burst',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now}),first=c.claim('airarabia');
 assert.ok(first);assert.equal(c.claim('airarabia'),null);assert.equal(c.backgroundBudget('airarabia').used,1);
 now+=4*60000+1;assert.equal(c.current(first.id,first.lease),false);
 const second=c.claim('airarabia');assert.ok(second);assert.equal(c.leases.has(first.id),false);assert.equal(c.backgroundBudget('airarabia').used,2);
 assert.equal(c.finish(second.id,second.lease,'failed',[]),true);assert.equal(c.claim('airarabia'),null);
});
test('window rollover permits only the configured new batch without catching up missed windows',()=>{
 let now=NOW+12345;const c=new FareCatalog({now:()=>now,backgroundJobsPerWindow:1}),start=now,first=c.claim('flycham');c.finish(first.id,first.lease,'failed',[]);
 now=start+FRESH_MS-1;assert.equal(c.claim('flycham'),null);
 now=start+FRESH_MS;const second=c.claim('flycham');assert.ok(second);c.finish(second.id,second.lease,'failed',[]);assert.equal(c.backgroundBudget('flycham').windowStartedAt,now);
 now+=10*FRESH_MS;assert.equal(c.backgroundBudget('flycham').used,0);const later=c.claim('flycham');assert.ok(later);c.finish(later.id,later.lease,'failed',[]);assert.equal(c.claim('flycham'),null);assert.equal(c.backgroundBudget('flycham').used,1);
});
test('a persisted future window remains spent when the system clock moves backwards',()=>{
 let now=NOW;const store={data:{},save(){}},c=new FareCatalog({now:()=>now,store,backgroundJobsPerWindow:1}),job=c.claim('flycham');c.finish(job.id,job.lease,'failed',[]);
 now-=60000;const restored=new FareCatalog({now:()=>now,store,backgroundJobsPerWindow:1});assert.equal(restored.claim('flycham'),null);assert.equal(restored.backgroundBudget('flycham').nextWindowAt,NOW+FRESH_MS);
 now=NOW+FRESH_MS;assert.ok(restored.claim('flycham'));
});
test('an exhausted or disabled budget skips expensive plan generation and an empty plan spends nothing',()=>{
 const zero=new FareCatalog({now:()=>NOW,backgroundJobsPerWindow:0});zero.plan=()=>{throw Error('disabled budget must not build a plan');};assert.equal(zero.claim('flycham'),null);assert.equal(zero.status().backgroundBudget.providers.flycham.eligible,false);
 const disabled=new FareCatalog({now:()=>NOW,enabled:false});disabled.plan=()=>{throw Error('disabled catalog must not build a plan');};assert.equal(disabled.claim('airarabia'),null);
 const store={data:{},save(){throw Error('no actual start to persist');}},empty=new FareCatalog({now:()=>NOW,store});empty.plan=()=>[];assert.equal(empty.claim('flycham'),null);assert.equal(empty.backgroundBudget('flycham').used,0);assert.equal(store.data.catalogBudget,undefined);
 const capped=new FareCatalog({now:()=>NOW,backgroundJobsPerWindow:1}),job=capped.claim('airarabia');capped.finish(job.id,job.lease,'done',[]);capped.plan=()=>{throw Error('exhausted budget must not build a plan');};assert.equal(capped.claim('airarabia'),null);
});
test('budget configuration is bounded and persisted expiry is retained across a configuration change',()=>{
 for(const options of [{backgroundJobsPerWindow:-1},{backgroundJobsPerWindow:1.5},{backgroundJobsPerWindow:21},{backgroundWindowMs:0},{backgroundWindowMs:Infinity},{backgroundWindowMs:86400001}])assert.throws(()=>new FareCatalog(options),/CATALOG_BACKGROUND_BUDGET_INVALID/);
 let now=NOW;const store={data:{},save(){}},c=new FareCatalog({now:()=>now,store,backgroundJobsPerWindow:1,backgroundWindowMs:60000}),job=c.claim('flycham');c.finish(job.id,job.lease,'failed',[]);
 const restored=new FareCatalog({now:()=>now,store,backgroundJobsPerWindow:1,backgroundWindowMs:1000});assert.equal(restored.claim('flycham'),null);assert.equal(restored.backgroundBudget('flycham').nextWindowAt,NOW+60000);now+=60000;assert.ok(restored.claim('flycham'));assert.equal(restored.backgroundBudget('flycham').nextWindowAt,NOW+61000);
});
test('cold eligibility probe detects real work without claiming, pruning or advancing any state',()=>{
 let saves=0;const c=new FareCatalog({now:()=>NOW,store:{data:{},save(){saves++;}}});
 c.records.set('expired',{...offer(),checkedAt:NOW-86400001});c.coverage.set('expired',{at:NOW-86400001});c.routeFailures.set('expired',{until:NOW-1});
 const snapshot=()=>structuredClone({records:[...c.records],coverage:[...c.coverage],routeFailures:[...c.routeFailures],attempts:[...c.attempts],leases:[...c.leases],tasks:[...c.tasks],cycles:[...c.cycles],windows:c.backgroundWindows});
 const before=snapshot();assert.equal(c.hasEligibleWork('flycham'),true);assert.equal(c.hasEligibleWork('airarabia'),true);assert.deepEqual(snapshot(),before);assert.equal(saves,0);
});
test('cold eligibility probe respects active leases and budget without refunding expired starts',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now}),first=c.claim('flycham');assert.equal(c.hasEligibleWork('flycham'),false);assert.equal(c.hasEligibleWork('airarabia'),true);
 now+=4*60000+1;assert.equal(c.hasEligibleWork('flycham'),true);assert.equal(c.leases.has(first.id),true);assert.equal(c.backgroundBudget('flycham').used,1);
 const second=c.claim('flycham');c.finish(second.id,second.lease,'failed',[]);c.plan=()=>{throw Error('spent probe must not build a plan');};assert.equal(c.hasEligibleWork('flycham'),false);
});
test('cold eligibility probe does not wake for cooled routes or for already fresh candidate tasks',()=>{
 let now=NOW;const c=new FareCatalog({now:()=>now});
 for(const task of c.plan('flycham'))c.routeFailures.set(JSON.stringify(['flycham',require('../src/airports').airportCode(task.request.origin),require('../src/airports').airportCode(task.request.destination)]),{until:NOW+60000});
 assert.equal(c.hasEligibleWork('flycham'),false);assert.equal(c.backgroundBudget('flycham').used,0);
 now+=60000;assert.equal(c.hasEligibleWork('flycham'),true);
 const fresh=new FareCatalog({now:()=>NOW});for(const task of fresh.plan('airarabia'))fresh.attempts.set(catalogRequestKey(task.request),NOW);assert.equal(fresh.hasEligibleWork('airarabia'),false);assert.equal(fresh.leases.size,0);assert.equal(fresh.backgroundBudget('airarabia').used,0);
});
test('cold eligibility probe rejects disabled or unknown providers without planning',()=>{
 for(const c of [new FareCatalog({now:()=>NOW,enabled:false}),new FareCatalog({now:()=>NOW,backgroundJobsPerWindow:0})]){c.plan=()=>{throw Error('disabled probe must not plan');};assert.equal(c.hasEligibleWork('flycham'),false);}
 const c=new FareCatalog({now:()=>NOW});c.plan=()=>{throw Error('unknown provider must not plan');};assert.equal(c.hasEligibleWork('unknown'),false);
});
