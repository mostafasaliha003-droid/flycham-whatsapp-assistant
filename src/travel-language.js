'use strict';
const {normalize}=require('./arabic-dates');
const aliases=[
 ['الشارقة',/^(?:ال)?شار(?:ق[هة]?|ج[هة])$|^sharjah$|^shj$/i],['دمشق',/^(?:ال)?شام$|^دمشق$|^damascus$|^dam$/i],
 ['حلب',/^حلا?ب$|^aleppo$|^alp$/i],['آل مكتوم',/^(?:ال\s*مكتوم|المكتوم|دبي وورلد سنترال|al\s*maktoum|dubai world central|dwc)$/i],['دبي',/^دبي(?: الدولي)?$|^dubai$|^dxb$/i],['أبوظبي',/^ابو\s*ظبي$|^ab[uou]\s*dhabi$|^auh$/i],
 ['رأس الخيمة',/^راس\s*الخيم[هة]$|^rak$/i],['الفجيرة',/^(?:ال)?فجير[هة]$|^fjr$/i],['اللاذقية',/^(?:ال)?لاذقي[هة]$|^latakia$|^ltk$/i]
];
function city(value){const text=normalize(String(value||'')).replace(/^مطار\s+/,'').trim();return aliases.find(([,p])=>p.test(text))?.[0]||null;}
function languagePatch(raw,awaiting){
 const t=normalize(String(raw)).replace(/ة/g,'ه');const out={};
 const names='(?:مطار\\s*)?(?:الشارق[هة]|الشارج[هة]|شارق[هة]?|شارج[هة]|دمشق|الشام|شام|حلاب|حلب|ال\\s*مكتوم|المكتوم|دبي وورلد سنترال|دبي(?: الدولي)?|ابو\\s*ظبي|راس\\s*الخيم[هة]|الفجير[هة]|اللاذقي[هة]|sharjah|damascus|aleppo|dubai|shj|dam|alp|al\\s*maktoum|dubai world central|dwc|dxb|auh|rak|fjr|ltk)';
 const pattern=new RegExp('(^|[\\s،,])(?:(من|from)\\s+|(الى|الي|على|علي|ع|to)\\s*|(لل|ل)(?='+names+'))('+names+')(?=$|[\\s\\d،,.؟?])','gi');
 for(const m of t.matchAll(pattern)){const prefix=t.slice(Math.max(0,m.index-24),m.index+m[1].length);if(/(?:مو|مش|ليس|لا|بدون|الا)\s*$/.test(prefix))continue;const value=city(m[5]);if(value)out[m[2]?'origin':'destination']=value;}
 const single=city(t);if(single&&['origin','destination'].includes(awaiting)&&!Object.keys(out).length)out[awaiting]=single;
 const spoken={'واحد':1,'واحدة':1,'اتنين':2,'اثنين':2,'تنين':2,'تلاتة':3,'ثلاثة':3,'اربعة':4,'خمسة':5,'ستة':6,'سبعة':7,'تمانية':8,'ثمانية':8,'تسعة':9};
 const p=t.match(/(?:شخص|بالغ|مسافر)\s+(واحد|اتنين|اثنين|تلاته|ثلاثه|اربعه|خمسه)|(?:نحن|عددنا)\s+(واحد|اتنين|اثنين|تلاته|ثلاثه|اربعه|خمسه)|(?:^|\s)(تلاته|ثلاثه|اربعه|خمسه)\s+(?:كبار|بالغين)/);
 if(p){const word=p[1]||p[2]||p[3];const n=Object.entries(spoken).find(([k])=>normalize(k).replace(/ة/g,'ه')===word)?.[1];if(n)out.adults=n;}
 if(/^(?:انا ومرتي|انا وزوجتي|انا وزوجي|انا ورفيقي)$/.test(t))out.adults=2;
 if(/^(?:لحالي|انا لحالي|انا بس)$/.test(t))out.adults=1;
 const weights=[['تلاتين|ثلاثين',30],['عشرين',20],['اربعين',40],['خمسين',50]];
 for(const [words,kg]of weights)if(new RegExp('(?:'+words+')\\s*(?:كيلو|كغ)|^(?:'+words+')$').test(t)&&(awaiting==='baggage'||/وزن|كيلو|كغ|شنط/.test(t)))out.weightKg=kg;
 if(/بدون\s*(?:وزن|شنط[هة]|امتع[هة])|بلا\s*(?:وزن|شنط[هة])/.test(t))out.weightKg=0;
 if(/ارخص/.test(t)&&/(?:20|٢٠|عشرين|بدون وزن|بدون شنط)/.test(t))out.provider='airarabia';
 if(/(?:اي|ايا)\s*شركه|الشركتين|كل\s*الشركات|ما\s*بتفرق\s*(?:معي\s*)?الشركه/.test(t))out.providerExclusive=false;
 else if(/(?:حصرا|بس|فقط)(?:\s+(?:بدي|بدنا|اريد))?(?:\s+(?:على|مع|طيران))?\s*(?:فلاي\s*شام|العربي[هة](?:\s*للطيران)?|air\s*arabia|fly\s*cham)|(?:فلاي\s*شام|العربي[هة](?:\s*للطيران)?|air\s*arabia|fly\s*cham)\s*(?:حصرا|بس|فقط)/.test(t))out.providerExclusive=true;
 if(typeof out.providerExclusive==='boolean')out.providerRestrictionSource=out.providerExclusive?'customer':null;
 if(/العربي[هة]|air\s*arabia/.test(t))out.provider='airarabia';
 else if(/فلاي\s*شام|fly\s*cham/.test(t))out.provider='flycham';
 return out;
}
function applyDefaultBaggage(request){if(!request.baggageRequest)request.baggageRequest={checkedWeightKg:30,source:'default30',requestedByCustomer:false};return request;}
function reconcileRoute(request,previous={},raw,awaiting){
 const canonical=v=>city(v)||v||null;
 const known={origin:canonical(previous.origin),destination:canonical(previous.destination)};
 const t=normalize(String(raw)).replace(/[،,.!؟?]+$/g,'').replace(/^(?:اي|نعم|تمام|قصدي)\s+/,'').trim();
 const bare=city(t),direct=languagePatch(raw);
 const shortDirection=city(t.replace(/^(?:من|from|الى|على|ع|to)\s+/i,''));
 const directed=!/(?:^|\s)(?:مو|مش|ليس|لا|بدون|الا)(?:\s|$)/.test(t);
 let clarify=null;
 // A repeated airport confirms the known endpoint. It never supplies the other endpoint.
 if(bare&&(known.origin===bare||known.destination===bare||['origin','destination'].includes(awaiting))){
  Object.assign(request,known);
  if(['origin','destination'].includes(awaiting)){
   const opposite=awaiting==='origin'?'destination':'origin';
   if(known[opposite]===bare){if(!known[awaiting])clarify=awaiting;}
   else request[awaiting]=bare;
  }
 }else if(shortDirection&&directed&&(direct.origin||direct.destination)){
  Object.assign(request,known);
  if(direct.origin===known.origin&&!known.destination)clarify='destination';
  if(direct.destination===known.destination&&!known.origin)clarify='origin';
 }
 // A negated location must not survive the older broad parser or a model guess.
 const negative=t.match(/(?:^|[\s،,])(?:مو|مش|ليس|لا)\s+(?:(من|from|الى|الي|على|علي|لل|ل|to)\s*)?([^،,.؟?]+)/i);
 if(negative){
  const rejected=city(negative[2].split(/\s+(?:بدي|بدنا|خلي|لكن|بس)\s+/)[0]);
  const field=negative[1]?/^(?:من|from)$/i.test(negative[1])?'origin':'destination':awaiting;
  if(rejected&&['origin','destination'].includes(field)&&!direct[field]){request[field]=known[field]===rejected?null:known[field];if(!request[field])clarify=field;}
 }
 // Explicit positive direction in the customer's wording outranks a conflicting model extraction.
 for(const k of ['origin','destination'])if(direct[k])request[k]=direct[k];
 request.origin=canonical(request.origin);request.destination=canonical(request.destination);
 // A country is useful directional context, but is not an airport choice.
 if(/(?:^|[\s،,])(?:من|from)\s+سوري[اةه](?:$|[\s،,.؟?])/i.test(t)&&!/(?:^|\s)(?:مو|مش|ليس|لا)\s+من\s+سوري/.test(t)){
  request.originCountry='سوريا';
  if(!direct.origin)request.origin=['دمشق','حلب','اللاذقية'].includes(known.origin)?known.origin:null;
  if(!['دمشق','حلب','اللاذقية'].includes(request.destination))delete request.destinationCountry;
 }
 // Validate AFTER all model/local patches, before deciding the request is complete.
 if(request.origin&&request.origin===request.destination){
  clarify=directed&&direct.destination&&!direct.origin?'origin':'destination';
  request[clarify]=null;
 }
 return clarify;
}
function flyChamBaggageAllowed(r){return !r?.baggageRequest||(!r.baggageRequest.pieces&&r.baggageRequest.scope!=='total'&&r.baggageRequest.checkedWeightKg<=30);}
module.exports={city,languagePatch,applyDefaultBaggage,flyChamBaggageAllowed,reconcileRoute};
