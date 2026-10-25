'use strict';
const {randomUUID}=require('node:crypto');
const {dubaiDay,iso,addDays}=require('./arabic-dates');
const {validateLiveRequest}=require('./live-quote');
const {airportCode}=require('./airports');
const {airportSearchPlan}=require('./airport-comparison');
const {catalogParties,partyKey,fixtureFor}=require('./catalog-party');
const FRESH_MS=15*60*1000,INDICATIVE_MS=6*60*60*1000,DAY_MS=86400000;
const PROVIDERS=Object.freeze(['airarabia','flycham']);
const BACKGROUND_JOBS_PER_WINDOW=2;
const providerOf=r=>r?.provider||'airarabia';
const baggageKey=r=>JSON.stringify([r.baggageRequest?.checkedWeightKg??30,r.baggageRequest?.pieces||null,r.baggageRequest?.scope||'per_person']);
function key(r){return JSON.stringify([providerOf(r),airportCode(r.origin)||r.origin,airportCode(r.destination)||r.destination,r.departureDate,r.returnDate||null,r.tripType,partyKey(r.passengers),baggageKey(r)]);}
function routeKey(r){return JSON.stringify([providerOf(r),airportCode(r.origin)||r.origin,airportCode(r.destination)||r.destination]);}
const same=(a,b)=>key(a)===key(b);
const nameEqual=(a,b)=>(airportCode(a)||a)===(airportCode(b)||b);
const amount=o=>BigInt(o.price.sellingTotal.replace('.',''));
const priceSort=(a,b)=>amount(a)<amount(b)?-1:amount(a)>amount(b)?1:0;
const REPLY_MAX_CHARS=3600;
function indicativeCard(o,dt){
 const r=o.request,line=(label,date,leg)=>`${label} ${date} | ${leg.flight} | ${leg.departure} ← ${leg.arrival}`;
 return `*${o.provider==='flycham'?'فلاي شام':'العربية للطيران'} — ${r.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'}*\nمن ${r.origin} إلى ${r.destination}\n${line('الذهاب:',r.departureDate,o.timing.out)}${o.timing.back?`\n${line('العودة:',r.returnDate,o.timing.back)}\nإقامة مرجعية ${r.stayNights||'بحسب التاريخ'} ليلة`:''}\n🧳 ${o.price.weights.map(w=>w.kg+' كغ مسجل').join(' / ')}${o.provider==='flycham'?' +10 كغ يد':''}\n*آخر إجمالي رصدناه: ${o.price.sellingTotal} درهم*\nآخر تحقق: ${dt.format(o.checkedAt)}`;
}
class FareCatalog{
 constructor({now=Date.now,store=null,enabled=true,indicativeMs=INDICATIVE_MS,familyEnabled=false,verifiedFamilyProviders=[],validateRequest=validateLiveRequest,backgroundJobsPerWindow=BACKGROUND_JOBS_PER_WINDOW,backgroundWindowMs=FRESH_MS}={}){
  if(!Number.isSafeInteger(backgroundJobsPerWindow)||backgroundJobsPerWindow<0||backgroundJobsPerWindow>20||!Number.isSafeInteger(backgroundWindowMs)||backgroundWindowMs<1000||backgroundWindowMs>DAY_MS)throw Error('CATALOG_BACKGROUND_BUDGET_INVALID');
  Object.assign(this,{now,store,enabled,familyEnabled,validateRequest});this.indicativeMs=Math.max(FRESH_MS,Math.min(DAY_MS,Number(indicativeMs)||INDICATIVE_MS));
  Object.assign(this,{backgroundJobsPerWindow,backgroundWindowMs});this.backgroundWindows={};
  const saved=store?.data?.catalogBudget;
  if(saved?.version===1)for(const provider of PROVIDERS){
   const record=saved.providers?.[provider];
   if(record&&Number.isFinite(record.startedAt)&&record.startedAt>=0&&Number.isFinite(record.endsAt)&&record.endsAt>record.startedAt&&record.endsAt-record.startedAt<=DAY_MS&&Number.isSafeInteger(record.used)&&record.used>=0&&record.used<=100000)this.backgroundWindows[provider]={startedAt:record.startedAt,endsAt:record.endsAt,used:record.used};
  }
  // Passing a feature flag alone does not prove supplier passenger support.
  this.verifiedFamilyProviders=new Set(verifiedFamilyProviders.filter(p=>['airarabia','flycham'].includes(p)));
  this.records=new Map(store?.data?.catalog||[]);this.attempts=new Map(store?.data?.catalogAttempts||[]);this.coverage=new Map(store?.data?.catalogCoverage||[]);this.routeFailures=new Map(store?.data?.catalogRouteFailures||[]);
  this.leases=new Map();this.tasks=new Map();this.cycles=new Map();this.stats=store?.data?.catalogStats||{};this.prune();
 }
 save(){this.prune();if(this.store){Object.assign(this.store.data,{catalog:[...this.records],catalogAttempts:[...this.attempts].slice(-16000),catalogCoverage:[...this.coverage].slice(-16000),catalogRouteFailures:[...this.routeFailures].slice(-100),catalogStats:this.stats,catalogBudget:{version:1,providers:structuredClone(this.backgroundWindows)}});this.store.save();}}
 backgroundBudget(provider){
  if(!PROVIDERS.includes(provider))return null;
  const stored=this.backgroundWindows[provider],active=stored&&this.now()<stored.endsAt,used=active?stored.used:0,remaining=Math.max(0,this.backgroundJobsPerWindow-used);
  return {limit:this.backgroundJobsPerWindow,windowMs:this.backgroundWindowMs,used,remaining,eligible:this.enabled&&remaining>0,windowStartedAt:active?stored.startedAt:null,nextWindowAt:remaining===0&&active?stored.endsAt:null};
 }
 spendBackgroundStart(provider){
  const now=this.now(),stored=this.backgroundWindows[provider];
  this.backgroundWindows[provider]=stored&&now<stored.endsAt?{...stored,used:stored.used+1}:{startedAt:now,endsAt:now+this.backgroundWindowMs,used:1};
 }
 prune(){
  const day=dubaiDay(this.now()),today=iso(day),end=iso(new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+2,0)));
  for(const [k,v]of this.records)if(!v?.request||v.request.departureDate<today||v.request.departureDate>end||!Number.isFinite(v.checkedAt)||v.checkedAt>this.now()||this.now()-v.checkedAt>DAY_MS)this.records.delete(k);
  for(const [k,v]of this.coverage)if(!v||this.now()-v.at>DAY_MS)this.coverage.delete(k);
  for(const [k,v]of this.routeFailures)if(v.until<=this.now())this.routeFailures.delete(k);
  while(this.records.size>12000)this.records.delete(this.records.keys().next().value);
 }
 routes(provider){
  // These are search candidates from configured airport coverage, not a claim
  // that every candidate has inventory. The portal confirms each date/route.
  const rows=[];for(const syria of ['دمشق','حلب','اللاذقية'])for(const reverse of [false,true]){
   const request=reverse?{origin:syria,destination:'الشارقة'}:{origin:'الشارقة',destination:syria};
   for(const item of airportSearchPlan(request,[provider]).requests)if(airportCode(item.request.origin)&&airportCode(item.request.destination))rows.push([item.request.origin,item.request.destination]);
  }return rows;
 }
 plan(provider,{prune=true}={}){
  if(!['airarabia','flycham'].includes(provider))return [];
  if(prune)this.prune();const today=dubaiDay(this.now()),end=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+2,0)),from=iso(today),to=iso(end),recent=new Map(),best=new Map(),groups=new Map(),groupVisits=new Map();
  for(const o of this.records.values()){
   // A read-only cold-worker probe must ignore the same expired/future records
   // as pruning would, without deleting them or advancing any task cursor.
   if(!o?.request||typeof o.request.departureDate!=='string'||o.request.departureDate<from||o.request.departureDate>to||!Number.isFinite(o.checkedAt)||o.checkedAt>this.now()||this.now()-o.checkedAt>DAY_MS)continue;
   const k=key(o.request);recent.set(k,Math.max(recent.get(k)||0,o.checkedAt));
   const g=[routeKey(o.request),o.request.departureDate.slice(0,7),o.request.tripType,o.request.stayNights||0,partyKey(o.request.passengers)].join(':');if(!best.has(g)||priceSort(o,best.get(g))<0)best.set(g,o);
  }
  const bestKeys=new Set([...best.values()].map(o=>key(o.request))),parties=catalogParties({familyEnabled:this.familyEnabled,verified:this.verifiedFamilyProviders.has(provider)});
  for(let d=today;d<=end;d=addDays(d,1))for(const [origin,destination]of this.routes(provider))for(const nights of [0,7,14])for(const party of parties){
   const request={provider,origin,destination,departureDate:iso(d),returnDate:nights?iso(addDays(d,nights)):null,tripType:nights?'round_trip':'one_way',passengers:structuredClone(party.passengers),baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},...(nights?{stayNights:nights}:{})};
   if(this.routeFailures.get(routeKey(request))?.until>this.now())continue;
   const k=key(request),last=Math.max(recent.get(k)||0,this.attempts.get(k)||0);
   const group=[routeKey(request),request.tripType,nights,party.id,request.departureDate.slice(0,7)].join(':');groupVisits.set(group,Math.max(groupVisits.get(group)||0,last));if(this.now()-last<FRESH_MS)continue;
   if(!groups.has(group))groups.set(group,[]);groups.get(group).push({request,party:party.id,priority:bestKeys.has(k)?-1:recent.has(k)?0:1,last});
  }
  // Each rotation covers both months, directions, airports and return samples.
  // A repeatedly cheap known route cannot starve unvisited date/route groups.
  const lists=[...groups.entries()].sort((a,b)=>(groupVisits.get(a[0])||0)-(groupVisits.get(b[0])||0)).map(([,list])=>list.sort((a,b)=>a.last-b.last||a.priority-b.priority||a.request.departureDate.localeCompare(b.request.departureDate))),tasks=[];
  for(let i=0;i<Math.max(0,...lists.map(l=>l.length));i++)for(const list of lists)if(list[i])tasks.push(list[i]);
  return tasks;
 }
 hasEligibleWork(provider){
  if(!this.enabled||!PROVIDERS.includes(provider)||!this.backgroundBudget(provider).eligible)return false;
  if([...this.leases.values()].some(job=>job.request.provider===provider&&job.expires>this.now()))return false;
  return this.plan(provider,{prune:false}).length>0;
 }
 claim(provider){
  if(!this.enabled||!['airarabia','flycham'].includes(provider))return null;
  for(const [id,j]of this.leases)if(j.expires<=this.now())this.leases.delete(id);
  if([...this.leases.values()].some(j=>j.request.provider===provider))return null;
  // A bounded number of starts gives the worker a genuine idle period.
  // Count starts, not successful prices: expired or superseded work consumed
  // supplier/browser resources too and must not be refunded into another burst.
  if(!this.backgroundBudget(provider).eligible)return null;
  if(!this.tasks.get(provider)?.length||this.now()-(this.cycles.get(provider)||0)>=FRESH_MS){this.tasks.set(provider,this.plan(provider));this.cycles.set(provider,this.now());}
  let task;while((task=this.tasks.get(provider).shift()))if(!(this.routeFailures.get(routeKey(task.request))?.until>this.now()))break;
  if(!task)return null;const id='catalog-'+randomUUID(),lease=randomUUID(),j={id,lease,request:task.request,catalog:true,expires:this.now()+4*60*1000};this.spendBackgroundStart(provider);this.leases.set(id,j);this.save();return structuredClone(j);
 }
 current(id,lease){const j=this.leases.get(id);return Boolean(j&&j.lease===lease&&j.expires>this.now());}
 acceptOffer(offer,provider,expected){
  const r=offer?.request;try{this.validateRequest(r,this.now());}catch{return false;}
  if(!['airarabia','flycham'].includes(provider)||providerOf(r)!==provider||expected&&!same(r,expected)||!/^\d{1,7}\.\d{2}$/.test(offer?.price?.sellingTotal||'')||offer.price.currency&&offer.price.currency!=='AED'||Number(offer.price.sellingTotal)<=0||!offer.timing?.out?.flight||!offer.timing.out.departure||!offer.timing.out.arrival||r.tripType==='round_trip'&&(!offer.timing.back?.flight||!offer.timing.back.departure||!offer.timing.back.arrival))return false;
  const family=(r.passengers?.children||0)+(r.passengers?.infants||0)>0;if(family&&(!this.familyEnabled||!this.verifiedFamilyProviders.has(provider)||!fixtureFor(r.passengers)))return false;
  if(provider==='flycham'&&!/^XH\s*\d/.test(offer.timing.out.flight))return false;
  if(!offer.price.weights?.length||!offer.price.weights.every(w=>Number.isInteger(w.kg)&&w.kg>=(r.baggageRequest?.checkedWeightKg??30)))return false;
  const clean={request:structuredClone(r),price:{currency:'AED',sellingTotal:offer.price.sellingTotal,weights:structuredClone(offer.price.weights),...(provider==='flycham'?{voucherValue:r.tripType==='round_trip'?'25.00':'10.00'}:{})},timing:structuredClone(offer.timing),provider,checkedAt:this.now(),coverage:'partial'};
  const id=key(r)+':'+offer.timing.out.flight+':'+(offer.timing.back?.flight||'')+':'+offer.timing.out.departure;this.records.set(id,clean);this.save();return true;
 }
 progress(id,lease,metadata){const j=this.leases.get(id);if(!this.current(id,lease))return false;if(metadata?.offer)this.acceptOffer(metadata.offer,j.request.provider,j.request);return true;}
 finish(id,lease,outcome,coverage,details={}){
  const j=this.leases.get(id);if(!j||j.lease!==lease)return false;this.leases.delete(id);const at=this.now(),k=key(j.request);this.attempts.set(k,at);
  const rows=Array.isArray(coverage)?coverage.filter(x=>x&&x.date===j.request.departureDate).map(x=>({date:x.date,status:['confirmed','no_flights','sold_out','unverified','authentication_required'].includes(x.status)?x.status:'unverified'})).slice(0,32):[];
  this.coverage.set(k,{at,provider:j.request.provider,origin:j.request.origin,destination:j.request.destination,departureDate:j.request.departureDate,tripType:j.request.tripType,party:partyKey(j.request.passengers),status:rows[0]?.status||'unverified'});
  if(details.status==='airport_unconfirmed')this.routeFailures.set(routeKey(j.request),{provider:j.request.provider,origin:j.request.origin,destination:j.request.destination,reason:'airport_unconfirmed',until:at+30*60000});
  this.stats[j.request.provider]={lastFinishedAt:at,outcome:['done','partial','failed'].includes(outcome)?outcome:'failed',coverage:rows,lastRequest:{origin:j.request.origin,destination:j.request.destination,departureDate:j.request.departureDate,returnDate:j.request.returnDate,tripType:j.request.tripType,party:partyKey(j.request.passengers)}};this.save();return true;
 }
 find(request={}, {maxAgeMs=FRESH_MS}={}){
  this.prune();const expectedParty=partyKey(request.passengers);return [...this.records.values()].filter(o=>this.now()-o.checkedAt<=maxAgeMs&&(!(o.request.passengers?.children||o.request.passengers?.infants)||this.familyEnabled&&this.verifiedFamilyProviders.has(o.provider)&&Boolean(fixtureFor(o.request.passengers)))&&(!request.provider||request.provider===o.provider)&&(!request.origin||nameEqual(o.request.origin,request.origin))&&(!request.destination||nameEqual(o.request.destination,request.destination))&&(!request.destinationCountry||request.destinationCountry!=='سوريا'||['DAM','ALP','LTK'].includes(airportCode(o.request.destination)))&&partyKey(o.request.passengers)===expectedParty&&(!request.tripType||o.request.tripType===request.tripType)&&baggageKey(o.request)===baggageKey(request)&&(!request.departureDate||o.request.departureDate===request.departureDate)&&(!request.returnDate||o.request.returnDate===request.returnDate)&&(!request.departureRange||o.request.departureDate>=request.departureRange.start&&o.request.departureDate<=request.departureRange.end)).sort(priceSort);
 }
 reply(request={}){
  const scopes=request.origin&&request.destination?airportSearchPlan(request,request.providerExclusive&&request.provider?[request.provider]:['flycham','airarabia']).requests.map(x=>x.request):[request,...(['SHJ','DXB','AUH','DWC'].includes(airportCode(request.origin))?['دبي','الشارقة','أبوظبي'].filter(origin=>!nameEqual(origin,request.origin)).map(origin=>({...request,origin})):[])];
  const found=[];for(const scope of scopes)found.push(...this.find(scope,{maxAgeMs:this.indicativeMs}));
  if(!found.length)return null;const unique=new Map();for(const offer of found.sort(priceSort)){const k=key(offer.request);if(!unique.has(k))unique.set(k,offer);}
  const sorted=[...unique.values()].sort((a,b)=>Number(Boolean(request.origin)&&!nameEqual(a.request.origin,request.origin))-Number(Boolean(request.origin)&&!nameEqual(b.request.origin,request.origin))||priceSort(a,b)),groups=new Map();
  for(const o of sorted){const k=[o.request.departureDate.slice(0,7),o.request.tripType,o.provider,partyKey(o.request.passengers)].join(':');if(!groups.has(k))groups.set(k,o);}
  // Reserve a slot per month/trip/provider first, so cheap FlyCham examples
  // cannot hide every Air Arabia or next-month example in a short response.
  const shown=[...groups.values()].sort((a,b)=>a.request.departureDate.slice(0,7).localeCompare(b.request.departureDate.slice(0,7))||Number(a.provider!=='flycham')-Number(b.provider!=='flycham')).slice(0,8),picked=new Set(shown.map(o=>key(o.request)));
  for(const o of sorted)if(shown.length<8&&!picked.has(key(o.request))){shown.push(o);picked.add(key(o.request));}
  shown.sort((a,b)=>Number(Boolean(request.origin)&&!nameEqual(a.request.origin,request.origin))-Number(Boolean(request.origin)&&!nameEqual(b.request.origin,request.origin))||a.request.departureDate.slice(0,7).localeCompare(b.request.departureDate.slice(0,7))||Number(a.provider!=='flycham')-Number(b.provider!=='flycham')||priceSort(a,b));
  const dt=new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',dateStyle:'short',timeStyle:'short'}),party=fixtureFor(shown[0].request.passengers),p=shown[0].request.passengers;
  const header='*رحلات سوريا | مجموعة الرمال*\nأسعار استرشادية من أقل ما رصدناه ضمن التواريخ المفحوصة، وليست تأكيدًا للسعر الحالي.\nالفئة: '+(party?.label||`${p.adults} بالغ، ${p.children} طفل، ${p.infants} رضيع`)+'؛ الإجمالي لهذه التركيبة. التواقيت: إقلاع ← وصول كما بالبوابة؛ آخر تحقق بتوقيت دبي.';
  const footer='الأسعار شاملة الرسوم وعمولة الخدمة للوزن المبين، والتوفر قابل للتغير. نعيد تأكيد السعر والتوفر قبل التثبيت. ابعت الفترة وعدد المسافرين وأعمار الأطفال لنتحقق لطلبك.';
  const voucher='لفلاي شام فقط: فاوجر بعد إصدار التذكرة، 10 دراهم للذهاب و25 للذهاب والعودة، صالح سنة لخدماتنا القادمة؛ لا يخصم من السعر الحالي.';
  const cards=new Map(shown.map(o=>[o,indicativeCard(o,dt)]));
  const render=rows=>[header,...rows.map(o=>cards.get(o)),...(unique.size>rows.length?[`لم نعرض ${unique.size-rows.length} من الأمثلة المحفوظة هنا؛ فينا نتابع حسب الفترة المناسبة إلك.`]:[]),...(rows.some(o=>o.provider==='flycham')?[voucher]:[]),footer].join('\n\n');
  let selected=shown;
  if(render(selected).length>REPLY_MAX_CHARS){
   // Preserve month/supplier/trip balance when unusually long supplier facts
   // leave less space. Never cut a flight, timestamp, price or disclaimer.
   selected=[];const pending=[...shown],covered=new Set(),features=o=>[o.request.departureDate.slice(0,7),o.provider,o.request.tripType];
   while(pending.length){pending.sort((a,b)=>features(b).filter(x=>!covered.has(x)).length-features(a).filter(x=>!covered.has(x)).length||cards.get(a).length-cards.get(b).length);const o=pending.shift();if(render([...selected,o]).length<=REPLY_MAX_CHARS){selected.push(o);for(const feature of features(o))covered.add(feature);}}
   selected.sort((a,b)=>shown.indexOf(a)-shown.indexOf(b));
  }
  return render(selected);
 }
 status(){
  this.prune();const records=[...this.records.values()],coverage=[...this.coverage.values()],today=dubaiDay(this.now()),months=[iso(today).slice(0,7),iso(new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+1,1))).slice(0,7)];
  return {version:'2026-10-25.catalog.3',enabled:this.enabled,records:this.records.size,fresh:records.filter(o=>this.now()-o.checkedAt<=FRESH_MS).length,indicative:records.filter(o=>this.now()-o.checkedAt<=this.indicativeMs).length,refreshIntervalMs:FRESH_MS,refreshPolicy:'bounded_rotating_background_not_full_month_every_interval',indicativeMaxAgeMs:this.indicativeMs,completeMonthlyCoverage:false,returnReferenceNights:[7,14],providers:this.stats,
   backgroundBudget:{policy:'starts_per_provider_window',providers:Object.fromEntries(PROVIDERS.map(provider=>[provider,this.backgroundBudget(provider)]))},
   familyPricing:{enabled:this.familyEnabled&&this.verifiedFamilyProviders.size>0,requested:this.familyEnabled,verifiedProviders:[...this.verifiedFamilyProviders],activeProviders:this.familyEnabled?[...this.verifiedFamilyProviders]:[],defaultParty:'one_adult',requiresVerifiedSupplierSupport:true},
   months:months.map(month=>({month,pricedDates:new Set(records.filter(o=>o.request.departureDate.startsWith(month)).map(o=>o.request.departureDate)).size,attemptedDates:new Set(coverage.filter(o=>o.departureDate.startsWith(month)).map(o=>o.departureDate)).size,attemptedRequests:coverage.filter(o=>o.departureDate.startsWith(month)).length,complete:false})),
   rotation:['flycham','airarabia'].map(provider=>({provider,startedAt:this.cycles.get(provider)||null,remaining:this.tasks.get(provider)?.length??null,nextRefreshAt:this.cycles.has(provider)?this.cycles.get(provider)+FRESH_MS:null})),
   routeCandidates:['flycham','airarabia'].map(provider=>({provider,routes:this.routes(provider).map(([origin,destination])=>({origin,destination})),inventoryVerified:false})),
   active:[...this.leases.values()].filter(j=>j.expires>this.now()).map(j=>({provider:j.request.provider,origin:j.request.origin,destination:j.request.destination,departureDate:j.request.departureDate,returnDate:j.request.returnDate,tripType:j.request.tripType,party:fixtureFor(j.request.passengers)?.id||'custom',expiresAt:j.expires})),routeFailures:[...this.routeFailures.values()]};
 }
}
module.exports={FareCatalog,FRESH_MS,INDICATIVE_MS,BACKGROUND_JOBS_PER_WINDOW,catalogRequestKey:key};
