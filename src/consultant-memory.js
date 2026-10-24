'use strict';
const {airportCode}=require('./airports');
const {verifiedOffer}=require('./quote-comparison');
const {toFils,formatAED}=require('./money');
const PRIORITIES=new Set(['cheapest','time','airport','balanced']);
const MAX_AGE=15*60*1000;
function normalize(text){return String(text||'').slice(0,4000).normalize('NFKC').toLowerCase().replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\s+/g,' ').trim();}
function memory(state){
 if(!state||typeof state!=='object')throw Error('CONSULTANT_STATE_REQUIRED');
 const old=state.consultant;
 if(!old||typeof old!=='object'||old.tripId&&state.tripId&&old.tripId!==state.tripId)state.consultant={tripId:state.tripId||null,preferences:{priority:null,airportFlexibility:null,flexibleAirports:null,flexibleDates:null,preferredAirport:null,preferredTime:null,budgetAED:null},facts:{},objections:[],stage:'collecting',lastNextStep:null};
 const c=state.consultant;c.tripId ||= state.tripId||null;c.preferences||={priority:null,airportFlexibility:null,flexibleAirports:null};c.facts||={};c.objections=Array.isArray(c.objections)?c.objections.slice(-6):[];
 return c;
}
function inferredStage(state,c){if(c.stage==='issued')return 'issued';if(state.humanOwned)return 'handoff';if(state.selected)return 'selected';if(['queued','searching'].includes(state.status))return 'searching';if(state.offers?.length)return 'offers';if(state.base?.submitted)return 'qualified';return 'collecting';}
function updateConsultantMemory(state,text,{now=Date.now(),preferences}={}){
 const c=memory(state),t=normalize(text),at=Number.isFinite(now)?now:Date.now(),patch={};
 // Preferences inferred by a model are hints, never evidence by themselves.
 // Raw customer language must support every newly stored preference below.
 void preferences;
 const cheapNegated=/(?:مو|مش|ما|ماني)\s*(?:كتير\s*)?(?:مهم|مهمه|فارقه|فارقه معي)\s*(?:معي\s*)?(?:السعر|التكلفه)|السعر\s*(?:مو|مش)\s*مهم/.test(t);
 const cheap=/(?:ارخص|الاقل سعرا|اقل سعر|اوفر|ميزانيتي|المهم السعر|السعر اهم)/.test(t);
 const flexible=/(?:اي|ايا)\s*مطار|(?:المطار|مطار)\s*(?:ما|مو|مش)\s*(?:بيفرق|بتفرق|مهم)|ما\s*بتفرق\s*(?:معي\s*)?(?:المطار|من وين)|(?:كل|جميع)\s*المطارات/.test(t);
 const airportMention=t.match(/(?:حصرا|فقط|بس|الا)\s*(?:(?:من|مطار)\s*)?(الشارقه|شارقه|شارجه|دبي|ابو\s*ظبي|ال\s*مكتوم|شج|shj|dxb|auh|dwc)|(?:من\s+)?(الشارقه|شارقه|شارجه|دبي|ابو\s*ظبي|ال\s*مكتوم|shj|dxb|auh|dwc)\s*(?:حصرا|فقط|بس)/);
 const lockedAirport=!/(?:مو|مش|مش ضروري|مو ضروري)\s*(?:حصرا|بس|فقط)/.test(t)&&airportMention&&airportCode(airportMention[1]||airportMention[2]);
 const timeImportant=/(?:المهم|اهم شي|اهم شيء|بهمني|بدي)\s*(?:الوقت|التوقيت|موعد الوصول)|(?:الوقت|التوقيت)\s*اهم|لازم\s*(?:اوصل|وصل|اكون)|بدي\s*(?:الصبح|صباح|المسا|مساء|بالليل)/.test(t);
 const timeIgnored=/(?:مو|مش)\s*مهم\s*(?:الوقت|التوقيت)|(?:الوقت|التوقيت)\s*(?:ما|مو|مش)\s*(?:بيفرق|مهم)/.test(t);
 if(cheapNegated&&c.preferences.priority==='cheapest')patch.priority='balanced';
 if(cheap&&!cheapNegated)patch.priority='cheapest';
 if(timeImportant&&!timeIgnored)patch.priority='time';
 if(flexible){patch.airportFlexibility='flexible';patch.flexibleAirports=true;patch.preferredAirport=null;if(!patch.priority&&c.preferences.priority==='airport')patch.priority='balanced';}
 // Explicit airport restriction wins over cheaper-airport flexibility in a turn.
 if(lockedAirport){patch.airportFlexibility='fixed';patch.flexibleAirports=false;patch.preferredAirport=lockedAirport;patch.priority='airport';}
 if(/(?:الموعد|التاريخ|اليوم)\s*(?:ما|مو|مش)\s*(?:بيفرق|مهم)|(?:اي|ايا)\s*(?:يوم|تاريخ)|مرن\s*بالتاريخ/.test(t))patch.flexibleDates=true;
 if(/(?:نفس|هدا|هذا|هالتاريخ|هالموعد)\s*(?:اليوم|التاريخ|الموعد)?\s*(?:حصرا|فقط)|التاريخ\s*ثابت/.test(t))patch.flexibleDates=false;
 if(!/(?:مو|مش|ما بدي|بدون)\s*(?:الصبح|صباح|المسا|مساء|بالليل)/.test(t)){
  if(/(?:الصبح|صباح|بكير)/.test(t))patch.preferredTime='morning';
  else if(/بعد الظهر|العصر/.test(t))patch.preferredTime='afternoon';
  else if(/المسا|مساء/.test(t))patch.preferredTime='evening';
  else if(/بالليل|نص الليل/.test(t))patch.preferredTime='night';
 }
 const budget=t.match(/(?:ميزانيتي|حدي|ما بقدر ادفع اكتر من|حد اقصي)\s*(\d{1,6}(?:\.\d{1,2})?)\s*(?:درهم|aed)/);
 if(budget&&Number(budget[1])>0)patch.budgetAED=formatAED(toFils(budget[1],'Budget'));
 for(const [key,value]of Object.entries(patch)){c.preferences[key]=value;c.facts[key]={value,source:'customer_explicit',at,evidence:String(text).slice(0,180)};}
 const objections=[];
 if(!/(?:مو|مش)\s*غالي/.test(t)&&/غالي|غاليه|كتير السعر|زبطني بالسعر|زبطونا بالسعر|نزل السعر/.test(t))objections.push('price');
 if(/طول|تأخير|تاخير|مستعجل|وين الاسعار|شو صار/.test(t))objections.push('waiting');
 if(/بفكر|برجعلكن|برجعلك|بشوف وبرجع/.test(t))objections.push('considering');
 for(const type of objections){c.objections=c.objections.filter(x=>x.type!==type);c.objections.push({type,at,source:'customer_explicit'});}
 c.objections=c.objections.slice(-6);c.stage=inferredStage(state,c);c.updatedAt=at;return c;
}
function updateConsultantStage(state,event,{now=Date.now()}={}){
 const c=memory(state),type=typeof event==='string'?event:event?.type;
 const stages={qualified:'qualified',search_started:'searching',offers_verified:'offers',offer_selected:'selected',handoff_accepted:'handoff'};
 if(type==='ticket_issued'){if(typeof event!=='object'||event.verified!==true)return c;c.stage='issued';}
 else if(stages[type])c.stage=stages[type];
 else return c;
 c.stageAt=now;c.lastNextStep={qualified:'search',searching:'await_verified_offers',offers:'choose_offer',selected:'confirm_booking_intent',handoff:'await_staff',issued:null}[c.stage];return c;
}
function oneAdult(r){return r?.passengers?.adults===1&&(r.passengers.children||0)===0&&(r.passengers.infants||0)===0;}
function dayAllowed(offer,request){
 const date=offer.departureDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return false;
 if(request.departureRange){if(date<request.departureRange.start||date>request.departureRange.end)return false;}
 else if(request.departureDate){const delta=(Date.parse(date+'T00:00:00Z')-Date.parse(request.departureDate+'T00:00:00Z'))/86400000;if(!Number.isInteger(delta)||Math.abs(delta)>3)return false;}
 else return false;
 if(request.tripType==='round_trip'){
  if(request.stayNights){if(Date.parse(offer.returnDate+'T00:00:00Z')-Date.parse(date+'T00:00:00Z')!==request.stayNights*86400000)return false;}
  else if(offer.returnDate!==request.returnDate)return false;
 }
 return true;
}
function timeRank(o,preferred){const t=String(o.timing.out.departure),match=t.match(/(?:^|[ T])(\d{1,2}):(\d{2})(?:$|\s)/);if(!match)return 1;const hour=Number(match[1]),kind=hour>=5&&hour<12?'morning':hour>=12&&hour<17?'afternoon':hour>=17&&hour<22?'evening':'night';return kind===preferred?0:1;}
function weightSignature(o){return o.price.weights.map(w=>w.kg).sort((a,b)=>a-b).join(',');}
function recommendVerifiedOffers(offers,request,preferences={},options={}){
 const now=Number.isFinite(options.now)?options.now:Date.now(),maxAgeMs=Math.min(MAX_AGE,Math.max(0,Number.isFinite(options.maxAgeMs)?options.maxAgeMs:MAX_AGE));
 const empty={primary:null,cheapest:null,reason:'no_verified_matching_offers',comparisonText:null,offers:[]};
 if(!oneAdult(request))return empty;
 const target=request.baggageRequest?.checkedWeightKg??30,requestedOrigin=airportCode(request.origin),requestedDestination=airportCode(request.destination);
 if(!requestedOrigin||!requestedDestination)return empty;
 const flexibleAirports=preferences.airportFlexibility==='fixed'?false:preferences.airportFlexibility==='flexible'?true:preferences.flexibleAirports;
 const strict=flexibleAirports===false,locked=airportCode(preferences.preferredAirport)||requestedOrigin;
 const verified=[];
 for(const o of (Array.isArray(offers)?offers:[]).slice(0,160)){
  if(!o?.request||!oneAdult(o.request)||o.request.tripType!==request.tripType||airportCode(o.request.destination)!==requestedDestination||!dayAllowed(o.request,request)||(o.request.baggageRequest?.checkedWeightKg??30)!==target)continue;
  const origin=airportCode(o.request.origin),uae=['SHJ','DXB','AUH','DWC'];if(!origin||(uae.includes(requestedOrigin)?!uae.includes(origin):origin!==requestedOrigin)||strict&&origin!==locked)continue;
  const provider=o.provider||o.request.provider;if(request.providerExclusive&&provider!==request.provider)continue;
  const at=Number.isFinite(o.checkedAt)?o.checkedAt:Date.parse(o.verifiedAt);if(!Number.isFinite(at)||at>now||now-at>maxAgeMs)continue;
  const checked=verifiedOffer(o,o.request,provider);if(!checked)continue;
  verified.push({...checked,...(Number.isInteger(o.reference)&&o.reference>=1&&o.reference<=80?{reference:o.reference}:{}),...(typeof o.id==='string'?{id:o.id}:{})});
 }
 if(!verified.length)return empty;
 const comparePrice=(a,b)=>{const x=toFils(a.price.sellingTotal,'Price'),y=toFils(b.price.sellingTotal,'Price');return x<y?-1:x>y?1:(a.reference||999)-(b.reference||999);};
 verified.sort(comparePrice);const cheapest=verified[0],original=verified.filter(o=>airportCode(o.request.origin)===requestedOrigin),priority=PRIORITIES.has(preferences.priority)?preferences.priority:'balanced';
 let primary,reason;
 if(priority==='cheapest'&&flexibleAirports!==false){primary=cheapest;reason='lowest_verified_price';}
 else if(priority==='time'&&preferences.preferredTime){const pool=flexibleAirports===true?verified:original.length?original:verified;primary=pool.slice().sort((a,b)=>timeRank(a,preferences.preferredTime)-timeRank(b,preferences.preferredTime)||comparePrice(a,b))[0];reason=timeRank(primary,preferences.preferredTime)===0?'matches_requested_time':'requested_time_not_found';}
 else{primary=(original.length?original:verified)[0];reason=original.length?'matches_requested_airport':'verified_alternative_airport';}
 let comparisonText=null;
 if(primary!==cheapest&&weightSignature(primary)===weightSignature(cheapest)){
  const saving=toFils(primary.price.sellingTotal,'Price')-toFils(cheapest.price.sellingTotal,'Price');
  if(saving>0n)comparisonText=`الخيار ${cheapest.reference||'الأقل سعرًا'} أوفر بـ${formatAED(saving)} درهم ضمن العروض المتحققة لنفس عدد المسافرين والوزن. المغادرة من ${cheapest.request.origin} بتاريخ ${cheapest.request.departureDate} الساعة ${cheapest.timing.out.departure}، مقابل ${primary.request.origin} بتاريخ ${primary.request.departureDate} الساعة ${primary.timing.out.departure}${request.tripType==='round_trip'?`؛ العودة ${cheapest.request.returnDate} مقابل ${primary.request.returnDate}`:''}. تغيير المطار أو الموعد يكون حسب اختيارك.`;
 }
 return {primary,cheapest,reason,comparisonText,offers:verified};
}
module.exports={updateConsultantMemory,updateConsultantStage,recommendVerifiedOffers};
