'use strict';
const {createHash}=require('node:crypto');
const {buildOfferDigest}=require('./offer-digest');
const {normalize}=require('./arabic-dates');
const {airportCode}=require('./airports');
const MAX_AGE_MS=6*60*60*1000;
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function isMoreRequest(text){
 const t=normalize(String(text||'')).replace(/ة/g,'ه').replace(/[؟?!،,.]+$/g,'').trim();
 return /^(?:(?:لو سمحت|من فضلك|بدي|بدنا|ممكن|اعطيني|عطيني|ورجيني|فرجيني|ابعث|ابعت|ارسل|تبعتلي|ترسللي|اعرضلي|شوفلي|شفلي)\s+)*(?:المزيد|مزيد(?:\s+من\s+(?:الخيارات|العروض|التواقيت))?|باقي\s+(?:الخيارات|العروض|التواقيت)|بقيه\s+(?:الخيارات|العروض|التواقيت)|كمل\s+(?:العروض|الخيارات|التواقيت))(?:\s+(?:لو سمحت|من فضلك|شكرا|بليز))?$/.test(t);
}
function canonicalRequest(r={}){
 const out={};
 for(const key of ['origin','destination','departureDate','returnDate','tripType','stayNights','provider','providerExclusive'])if(r[key]!==undefined)out[key]=r[key];
 for(const key of ['origin','destination'])if(out[key]!==undefined&&(typeof out[key]!=='string'||!airportCode(out[key])))throw Error('OFFER_PAGES_INVALID_REQUEST');
 for(const key of ['departureDate','returnDate'])if(out[key]!==undefined&&out[key]!==null&&(typeof out[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(out[key])))throw Error('OFFER_PAGES_INVALID_REQUEST');
 if(out.provider!==undefined&&out.provider!==null&&!['airarabia','flycham'].includes(out.provider)||out.providerExclusive!==undefined&&typeof out.providerExclusive!=='boolean')throw Error('OFFER_PAGES_INVALID_REQUEST');
 if(r.departureRange)out.departureRange={start:r.departureRange.start,end:r.departureRange.end};
 if(r.passengers){const p=r.passengers;if(!['adults','children','infants'].every(k=>Number.isInteger(p[k])&&p[k]>=0&&p[k]<=9)||p.adults+p.children+p.infants<1||p.adults+p.children+p.infants>9||p.ages!==undefined&&(!Array.isArray(p.ages)||p.ages.length>9||p.ages.some(a=>!Number.isInteger(a)||a<0||a>=18)))throw Error('OFFER_PAGES_INVALID_PARTY');out.passengers={adults:p.adults,children:p.children,infants:p.infants,ages:clone(p.ages||[])};}
 if(r.baggageRequest)out.baggageRequest=Object.fromEntries(['checkedWeightKg','scope','pieces','source','requestedByCustomer'].filter(k=>r.baggageRequest[k]!==undefined).map(k=>[k,r.baggageRequest[k]]));
 return out;
}
function canonicalOffer(o){
 const leg=t=>({flight:t.flight,departure:t.departure,arrival:t.arrival});
 return {provider:o.provider,reference:o.reference,request:canonicalRequest(o.request),timing:{out:leg(o.timing.out),...(o.timing.back?{back:leg(o.timing.back)}:{})},price:{currency:'AED',sellingTotal:o.price.sellingTotal,weights:o.price.weights.map(w=>({kg:w.kg})),...(o.price.voucherValue?{voucherValue:o.price.voucherValue}:{})},checkedAt:o.checkedAt};
}
function refsFrom(offers,all){
 if(!Array.isArray(offers))throw Error('OFFER_PAGES_INVALID_REFERENCES');
 const refs=[...new Set(offers.map(o=>Number.isInteger(o)?o:o?.reference))];
 if(refs.some(r=>!Number.isInteger(r)||!all.some(o=>o.reference===r)))throw Error('OFFER_PAGES_INVALID_REFERENCES');
 if(offers.some(o=>!Number.isInteger(o)&&hash(canonicalOffer(o))!==hash(all.find(a=>a.reference===o.reference))))throw Error('OFFER_PAGES_REFERENCE_FACTS_CHANGED');
 return refs.sort((a,b)=>a-b);
}
function snapshotKey(book){return hash([book.request,book.offers,book.statuses]);}
function pageKey(book,shown){return 'offers:'+hash([book.comparisonId,book.revision,book.snapshotKey,book.shownRefs,[...shown].sort((a,b)=>a-b)]).slice(0,48);}
function canonicalStatus(s){
 const out={};if(!s||!['airarabia','flycham'].includes(s.provider)||!['available','partial','pending','unverified','auth_required','no_flights','sold_out'].includes(s.status))throw Error('OFFER_PAGES_INVALID_STATUSES');
 out.provider=s.provider;out.status=s.status;
 if(s.phase!==undefined){if(!['exact','airports','alternatives'].includes(s.phase))throw Error('OFFER_PAGES_INVALID_STATUSES');out.phase=s.phase;}
 if(s.date!==undefined){if(typeof s.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.date))throw Error('OFFER_PAGES_INVALID_STATUSES');out.date=s.date;}
 for(const key of ['origin','destination'])if(s[key]!==undefined){if(typeof s[key]!=='string'||!airportCode(s[key]))throw Error('OFFER_PAGES_INVALID_STATUSES');out[key]=s[key];}
 return out;
}
function identityCurrent(state,book){
 if(!book||state.activeComparisonId!==book.comparisonId||(state.tripId??null)!==book.journey)return false;
 if(!['done','failed'].includes(state.status)||state.humanOwned)return false;
 if(snapshotKey(book)!==book.snapshotKey)return false;
 if(state.base?.request&&hash(canonicalRequest(state.base.request))!==book.requestKey){
  // Selecting a previously displayed verified offer binds the base request to
  // its exact flight. It does not discard other offers from the same journey.
  // Any subsequent weight/date/party amendment still fails the exact match.
  const selected=(state.offers||[]).find(o=>o.id===state.selected),stored=book.offers.find(o=>o.reference===selected?.reference);
  if(!selected||!stored||!book.shownRefs.includes(stored.reference)||hash(canonicalOffer(selected))!==hash(stored))return false;
  const selectedRequest=canonicalRequest({...stored.request,providerExclusive:true});
  if(hash(canonicalRequest(state.base.request))!==hash(selectedRequest))return false;
 }
 return true;
}
function freshness(book,now){return Number.isFinite(now)&&Number.isFinite(book.createdAt)&&book.createdAt<=now&&now-book.createdAt<=MAX_AGE_MS&&book.offers.every(o=>Number.isFinite(o.checkedAt)&&o.checkedAt<=now&&now-o.checkedAt<=MAX_AGE_MS);}
function unavailable(reason){
 const text=reason==='busy'?'طلبك الحالي لسه قيد التحقق 🌷 منرسل المقارنة بعد اكتمال مراجعة الخيارات، وما في داعي تعيد تفاصيلك.':reason==='expired'?'الخيارات المحفوظة صارت بحاجة لمراجعة جديدة للسعر والتوفر 🌷 اكتب «أعد البحث» لنراجع نفس تفاصيل رحلتك.':'ما عندي صفحة خيارات إضافية صالحة لطلبك الحالي 🌷 اكتب «أعد البحث» إذا بتحب نراجع تفاصيل الرحلة من جديد.';
 return {status:'unavailable',reason,text,shownOffers:[],remainingOffers:[],totalCount:0,pageKey:null};
}
function setOfferPages(state,{comparisonId,revision,request,offers,statuses=[],shownOffers=[],now=Date.now()}={}){
 if(!state||typeof comparisonId!=='string'||!comparisonId.length||comparisonId.length>120||!Number.isSafeInteger(revision)||revision<0||!Number.isFinite(now)||!Array.isArray(offers)||offers.length<1||offers.length>80||!Array.isArray(statuses))throw Error('OFFER_PAGES_INVALID_SNAPSHOT');
 buildOfferDigest({request,offers,statuses});
 const canonical=offers.map(canonicalOffer),safeRequest=canonicalRequest(request),shownRefs=refsFrom(shownOffers,canonical);
 const book={comparisonId,revision,journey:state.tripId??null,createdAt:now,request:safeRequest,requestKey:hash(safeRequest),offers:canonical,statuses:statuses.slice(0,320).map(canonicalStatus),shownRefs,pageCounter:shownRefs.length?1:0,acceptedPageKeys:[]};
 book.snapshotKey=snapshotKey(book);
 if(!freshness(book,now))throw Error('OFFER_PAGES_STALE_SNAPSHOT');
 buildOfferDigest({request:safeRequest,offers:canonical,statuses:book.statuses});
 state.offerPages=book;return clone(book);
}
function nextOfferPage(state,{now=Date.now()}={}){
 const book=state?.offerPages;
 if(['queued','searching'].includes(state?.status))return unavailable('busy');
 try{
  if(!identityCurrent(state,book))return unavailable('superseded');
  if(!freshness(book,now))return unavailable('expired');
  const digest=buildOfferDigest({request:book.request,offers:book.offers,statuses:book.statuses,ready:true},{excludeRefs:book.shownRefs});
  return {...clone(digest),status:digest.shownOffers.length?'ready':'complete',comparisonId:book.comparisonId,revision:book.revision,pageKey:digest.shownOffers.length?pageKey(book,digest.shownOffers.map(o=>o.reference)):null};
 }catch{return unavailable('invalid');}
}
// Call only after Meta has accepted the complete message containing these refs.
// Merely constructing, queueing or attempting a send must never call this.
function acceptOfferPage(state,{comparisonId,revision,pageKey:acceptedKey,shownOffers}={}){
 const book=state?.offerPages;
 try{
  if(typeof acceptedKey!=='string'||!acceptedKey.length)return false;
  if(!book||book.comparisonId!==comparisonId||book.revision!==revision)return false;
  // A persisted acceptance receipt may be replayed after staff takeover or a
  // state transition; it changes nothing and must not strand an outbox callback.
  if(book.acceptedPageKeys.includes(acceptedKey))return true;
  if(!identityCurrent(state,book))return false;
  const refs=refsFrom(shownOffers,book.offers);
  if(!refs.length||refs.some(r=>book.shownRefs.includes(r))||pageKey(book,refs)!==acceptedKey)return false;
  const expected=buildOfferDigest({request:book.request,offers:book.offers,statuses:book.statuses,ready:true},{excludeRefs:book.shownRefs});
  if(JSON.stringify(refs)!==JSON.stringify(expected.shownOffers.map(o=>o.reference).sort((a,b)=>a-b)))return false;
  book.shownRefs=[...new Set([...book.shownRefs,...refs])].sort((a,b)=>a-b);book.pageCounter++;book.acceptedPageKeys.push(acceptedKey);book.acceptedPageKeys=book.acceptedPageKeys.slice(-80);return true;
 }catch{return false;}
}
module.exports={isMoreRequest,setOfferPages,nextOfferPage,acceptOfferPage,MAX_AGE_MS};
