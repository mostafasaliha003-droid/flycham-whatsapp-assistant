'use strict';
const {normalize}=require('./arabic-dates');
const aliases=[
 ['الشارقة',/^(?:ال)?شار(?:ق[هة]?|ج[هة])$|^sharjah$|^shj$/i],['دمشق',/^(?:ال)?شام$|^دمشق$|^damascus$|^dam$/i],
 ['حلب',/^حلا?ب$|^aleppo$|^alp$/i],['دبي',/^دبي$|^dubai$|^dxb$/i],['أبوظبي',/^ابو\s*ظبي$|^ab[uou]\s*dhabi$|^auh$/i],
 ['رأس الخيمة',/^راس\s*الخيم[هة]$|^rak$/i],['الفجيرة',/^(?:ال)?فجير[هة]$|^fjr$/i],['اللاذقية',/^(?:ال)?لاذقي[هة]$|^latakia$|^ltk$/i]
];
function city(value){const text=normalize(String(value||'')).replace(/^مطار\s+/,'').trim();return aliases.find(([,p])=>p.test(text))?.[0]||null;}
function languagePatch(raw,awaiting){
 const t=normalize(String(raw));const out={};
 const names='(?:مطار\\s*)?(?:الشارق[هة]|الشارج[هة]|شارق[هة]?|شارج[هة]|دمشق|الشام|شام|حلاب|حلب|دبي|ابو\\s*ظبي|راس\\s*الخيم[هة]|الفجير[هة]|اللاذقي[هة]|sharjah|damascus|aleppo|dubai|shj|dam|alp|dxb|auh|rak|fjr|ltk)';
 const pattern=new RegExp('(^|[\\s،,])(?:(من|from)\\s+|(الى|الي|على|علي|ع|to)\\s*|(لل|ل)(?='+names+'))('+names+')(?=$|[\\s\\d،,.؟?])','gi');
 for(const m of t.matchAll(pattern)){const value=city(m[5]);if(value)out[m[2]?'origin':'destination']=value;}
 const single=city(t);if(single&&['origin','destination'].includes(awaiting)&&!Object.keys(out).length)out[awaiting]=single;
 const spoken={'واحد':1,'واحدة':1,'اتنين':2,'اثنين':2,'تنين':2,'تلاتة':3,'ثلاثة':3,'اربعة':4,'خمسة':5,'ستة':6,'سبعة':7,'تمانية':8,'ثمانية':8,'تسعة':9};
 const p=t.match(/(?:شخص|بالغ|مسافر)\s+(واحد|اتنين|اثنين|تلاته|ثلاثه|اربعه|خمسه)|(?:نحن|عددنا)\s+(واحد|اتنين|اثنين|تلاته|ثلاثه|اربعه|خمسه)|\b(تلاته|ثلاثه|اربعه|خمسه)\s+(?:كبار|بالغين)/);
 if(p){const word=p[1]||p[2]||p[3];const n=Object.entries(spoken).find(([k])=>normalize(k)===word)?.[1];if(n)out.adults=n;}
 if(/^(?:انا ومرتي|انا وزوجتي|انا وزوجي|انا ورفيقي)$/.test(t))out.adults=2;
 if(/^(?:لحالي|انا لحالي|انا بس)$/.test(t))out.adults=1;
 const weights=[['تلاتين|ثلاثين',30],['عشرين',20],['اربعين',40],['خمسين',50]];
 for(const [words,kg]of weights)if(new RegExp('(?:'+words+')\\s*(?:كيلو|كغ)|^(?:'+words+')$').test(t)&&(awaiting==='baggage'||/وزن|كيلو|كغ|شنط/.test(t)))out.weightKg=kg;
 if(/بدون\s*(?:وزن|شنط[هة]|امتع[هة])|بلا\s*(?:وزن|شنط[هة])/.test(t))out.weightKg=0;
 if(/ارخص/.test(t)&&/(?:20|٢٠|عشرين|بدون وزن|بدون شنط)/.test(t))out.provider='airarabia';
 return out;
}
function applyDefaultBaggage(request){if(!request.baggageRequest)request.baggageRequest={checkedWeightKg:30,source:'default30',requestedByCustomer:false};return request;}
function flyChamBaggageAllowed(r){return !r?.baggageRequest||(!r.baggageRequest.pieces&&r.baggageRequest.scope!=='total'&&r.baggageRequest.checkedWeightKg<=30);}
module.exports={city,languagePatch,applyDefaultBaggage,flyChamBaggageAllowed};
