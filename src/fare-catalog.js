'use strict';
const {randomUUID}=require('node:crypto');
const {dubaiDay,iso,addDays}=require('./arabic-dates');
const {validateLiveRequest}=require('./live-quote');
const FRESH_MS=15*60*1000;
const providerOf=r=>r?.provider||'airarabia';
const same=(a,b)=>['origin','destination','departureDate','returnDate','tripType'].every(k=>(a[k]||null)===(b[k]||null))&&a.baggageRequest?.checkedWeightKg===b.baggageRequest?.checkedWeightKg;
function key(r){return JSON.stringify([providerOf(r),r.origin,r.destination,r.departureDate,r.returnDate,r.tripType,r.baggageRequest?.checkedWeightKg]);}
class FareCatalog{
 constructor({now=Date.now,store=null,enabled=true}={}){this.now=now;this.store=store;this.enabled=enabled;this.records=new Map(store?.data?.catalog||[]);this.leases=new Map();this.tasks=new Map();this.cycles=new Map();this.stats={};this.attempts=new Map(store?.data?.catalogAttempts||[]);this.prune();}
 save(){this.prune();if(this.store){this.store.data.catalog=[...this.records];this.store.data.catalogAttempts=[...this.attempts].slice(-3000);this.store.save();}}
 prune(){const day=dubaiDay(this.now()),today=iso(day),end=iso(new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+2,0)));for(const [k,v]of this.records)if(v.request.departureDate<today||v.request.departureDate>end||this.now()-v.checkedAt>86400000)this.records.delete(k);while(this.records.size>12000)this.records.delete(this.records.keys().next().value);}
 plan(provider){
  const today=dubaiDay(this.now()),end=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+2,0));const tasks=[];const recent=new Map(),best=new Map();
  for(const o of this.records.values()){const k=key(o.request);recent.set(k,Math.max(recent.get(k)||0,o.checkedAt));const g=[o.provider,o.request.origin,o.request.destination,o.request.departureDate.slice(0,7),o.request.tripType].join(':');if(!best.has(g)||Number(o.price.sellingTotal)<Number(best.get(g).price.sellingTotal))best.set(g,o);}
  const bestKeys=new Set([...best.values()].map(o=>key(o.request)));
  // Catalog return dates are explicit 7/14-night reference examples, never a
  // silent assumption about the customer's own return itinerary.
  for(let d=today;d<=end;d=addDays(d,1))for(const [origin,destination]of [['الشارقة','دمشق'],['دمشق','الشارقة']])for(const nights of [0,7,14]){
   const request={provider,origin,destination,departureDate:iso(d),returnDate:nights?iso(addDays(d,nights)):null,tripType:nights?'round_trip':'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false},...(nights?{stayNights:nights}:{})};
   const k=key(request),last=Math.max(recent.get(k)||0,this.attempts.get(k)||0);
   if(this.now()-last>=FRESH_MS)tasks.push({request,priority:bestKeys.has(k)?-1:recent.has(k)?0:1,last});
  }
  return tasks.sort((a,b)=>a.priority-b.priority||a.last-b.last||a.request.departureDate.localeCompare(b.request.departureDate));
 }
 claim(provider){
  if(!this.enabled||!['airarabia','flycham'].includes(provider))return null;
  for(const [id,j]of this.leases)if(j.expires<=this.now())this.leases.delete(id);
  if([...this.leases.values()].some(j=>j.request.provider===provider))return null;
  if(!this.tasks.get(provider)?.length||this.now()-(this.cycles.get(provider)||0)>=FRESH_MS){this.tasks.set(provider,this.plan(provider));this.cycles.set(provider,this.now());}
  const task=this.tasks.get(provider).shift();if(!task)return null;
  const id='catalog-'+randomUUID(),lease=randomUUID(),j={id,lease,request:task.request,catalog:true,expires:this.now()+4*60*1000};this.leases.set(id,j);return structuredClone(j);
 }
 current(id,lease){const j=this.leases.get(id);return Boolean(j&&j.lease===lease&&j.expires>this.now());}
 acceptOffer(offer,provider,expected){
  const r=offer?.request;
  try{validateLiveRequest(r,this.now());}catch{return false;}
  if(providerOf(r)!==provider||expected&&!same(r,expected)||!/^\d{1,7}\.\d{2}$/.test(offer?.price?.sellingTotal||'')||!offer.timing?.out?.flight||!offer.timing.out.departure||!offer.timing.out.arrival||r.tripType==='round_trip'&&!offer.timing.back)return false;
  if(provider==='flycham'&&!/^XH\s*\d/.test(offer.timing.out.flight))return false;
  if(provider==='airarabia'&&(!offer.price.weights?.length||!offer.price.weights?.every(w=>Number.isInteger(w.kg)&&w.kg>=r.baggageRequest?.checkedWeightKg)))return false;
  const clean={request:structuredClone(r),price:{sellingTotal:offer.price.sellingTotal,weights:offer.price.weights||[],voucherValue:offer.price.voucherValue},timing:structuredClone(offer.timing),provider,checkedAt:this.now(),coverage:'partial'};
  const id=key(r)+':'+offer.timing.out.flight+':'+(offer.timing.back?.flight||'')+':'+offer.timing.out.departure;this.records.set(id,clean);this.save();return true;
 }
 progress(id,lease,metadata){const j=this.leases.get(id);if(!this.current(id,lease))return false;if(metadata?.offer)this.acceptOffer(metadata.offer,j.request.provider,j.request);return true;}
 finish(id,lease,outcome,coverage){const j=this.leases.get(id);if(!j||j.lease!==lease)return false;this.leases.delete(id);this.attempts.set(key(j.request),this.now());this.save();this.stats[j.request.provider]={lastFinishedAt:this.now(),outcome,coverage:coverage?.map(x=>({date:x.date,status:x.status})).slice(0,32)};return true;}
 find(request={}){this.prune();return [...this.records.values()].filter(o=>this.now()-o.checkedAt<=FRESH_MS&&(!request.provider||request.provider===o.provider)&&(!request.origin||o.request.origin===request.origin)&&(!request.destination||o.request.destination===request.destination)&&(!request.destinationCountry||request.destinationCountry!=='سوريا'||['دمشق','حلب','اللاذقية'].includes(o.request.destination))&&(!request.tripType||o.request.tripType===request.tripType)&&o.request.baggageRequest?.checkedWeightKg===(request.baggageRequest?.checkedWeightKg??30)&&(!request.departureDate||o.request.departureDate===request.departureDate)&&(!request.returnDate||o.request.returnDate===request.returnDate)&&(!request.departureRange||o.request.departureDate>=request.departureRange.start&&o.request.departureDate<=request.departureRange.end)).sort((a,b)=>Number(a.price.sellingTotal)-Number(b.price.sellingTotal));}
 reply(request={}){
  const found=this.find(request);if(!found.length)return null;
  const groups=new Map();for(const o of found){const k=[o.request.departureDate.slice(0,7),o.request.tripType,o.provider].join(':');if(!groups.has(k))groups.set(k,o);}
  const shown=[...groups.values()].slice(0,8);const dt=new Intl.DateTimeFormat('ar-AE',{timeZone:'Asia/Dubai',dateStyle:'short',timeStyle:'short'});
  return '*رحلات سوريا | مجموعة الرمال*\nأفضل أسعار متأكدين منها حتى الآن ضمن التواريخ المفحوصة، لشخص بالغ واحد:\n\n'+shown.map(o=>`*${o.request.departureDate.slice(0,7)} — ${o.request.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'}*\nشركة الطيران: ${o.provider==='flycham'?'فلاي شام':'العربية للطيران'}\nالمسار: من ${o.request.origin} إلى ${o.request.destination}\n📅 الذهاب: ${o.request.departureDate}\nرقم الرحلة: ${o.timing.out.flight}\nالإقلاع: ${o.timing.out.departure}\nالوصول: ${o.timing.out.arrival}${o.timing.back?`\nالعودة: ${o.request.returnDate} — إقامة ${o.request.stayNights} ليلة\n${o.timing.back.flight}: ${o.timing.back.departure} — ${o.timing.back.arrival}`:''}\n🧳 الوزن: ${o.provider==='flycham'?'30 كيلو مسجل +10 كيلو يد':o.price.weights.map(w=>w.kg+' كيلو مسجل').join(' / ')}\n💰 *الإجمالي: ${o.price.sellingTotal} درهم*${o.provider==='flycham'?`\nهدية بعد إصدار التذكرة: فاوجر ${o.price.voucherValue} درهم لخدماتنا القادمة، صالح سنة؛ لا يخصم من السعر الحالي.`:''}\nآخر تحقق: ${dt.format(o.checkedAt)} بتوقيت دبي`).join('\n\n')+'\n\nالأسعار شاملة الرسوم وعمولة الخدمة، والتوفر قابل للتغير. المقارنة ضمن الخيارات المفحوصة وليست تأكيدًا لأرخص سعر بكامل الشهر.';
 }
 status(){return{enabled:this.enabled,records:this.records.size,fresh:[...this.records.values()].filter(o=>this.now()-o.checkedAt<=FRESH_MS).length,refreshIntervalMs:FRESH_MS,completeMonthlyCoverage:false,returnReferenceNights:[7,14],providers:this.stats};}
}
module.exports={FareCatalog,FRESH_MS};
