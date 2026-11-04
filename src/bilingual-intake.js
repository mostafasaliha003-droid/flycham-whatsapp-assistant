'use strict';

const EN_NATIONALITIES=[
 [/\bsyrian?\b|\bsyria\b/i,'سوريا'],
 [/\begyptian?\b|\begypt\b/i,'مصر'],
 [/\bpalestinian?\b|\bpalestine\b/i,'فلسطين'],
 [/\bjordanian?\b|\bjordan\b/i,'الأردن'],
 [/\blebanese\b|\blebanon\b/i,'لبنان'],
 [/\biraqi?\b|\biraq\b/i,'العراق'],
 [/\byemeni?\b|\byemen\b/i,'اليمن'],
 [/\bsudanese\b|\bsudan\b/i,'السودان'],
 [/\bmoroccan?\b|\bmorocco\b/i,'المغرب'],
 [/\btunisian?\b|\btunisia\b/i,'تونس'],
 [/\balgerian?\b|\balgeria\b/i,'الجزائر'],
 [/\bpakistani?\b|\bpakistan\b/i,'باكستان'],
 [/\bindian?\b|\bindia\b/i,'الهند'],
 [/\bturkish\b|\bturkey\b/i,'تركيا']
];


function affirmativeEnglishText(raw){
 return String(raw||'').split(/([,;.!?،]|\bbut\b|\binstead\b)/i).map(part=>/\b(?:not|never|without|(?:do|does|did)n['’]?t|no(?!\s+(?:baggage|luggage|checked\s+bag)\b))\b/i.test(part)?' ':part).join('');
}

const EN_NUMBERS={one:1,two:2,three:3,four:4,five:5,six:6};

function detectLanguageStyle(text){
 const s=String(text||'');
 const ar=(s.match(/[\u0621-\u064a]/g)||[]).length;
 const en=(s.match(/[A-Za-z]/g)||[]).length;
 if(en>0&&ar>0)return 'mixed';
 if(en>0)return 'en';
 return 'ar';
}

function parseEnglishFlightPatch(raw){
 const s=affirmativeEnglishText(raw).trim();
 if(!s)return {};
 const {city}=require('./travel-language');
 const out={};
 const cityToken='(?:sharjah|shj|dubai(?:\\s+world\\s+central)?|dxb|dwc|al\\s*maktoum|ab[uou]\\s*dhabi|auh|ras\\s*al\\s*khaimah|rak|fujairah|fjr|damascus|dam|aleppo|alp|latakia|ltk)';
 const pairRe=new RegExp(`(^|[\\s,.;])(?:from\\s+)?(${cityToken})\\s*(?:to|->|→)\\s*(${cityToken})(?=$|[\\s,.;?!])`,'i');
 const directPair=s.match(pairRe);
 if(directPair){
  const prefix=s.slice(Math.max(0,directPair.index-20),directPair.index+directPair[1].length);
  if(!/(?:\bnot|\bno|مو|مش|ليس|لا)\s*$/i.test(prefix)){
   const o=city(directPair[2]),d=city(directPair[3]);
   if(o&&d&&o!==d){out.origin=o;out.destination=d;}
  }
 }
 if(/\bone[\s-]*way\b|\bsingle\s+trip\b/i.test(s))out.tripType='one_way';
 else if(/\bround[\s-]*trip\b|\breturn\s+(?:ticket|flight|trip)\b|\bboth\s+ways\b/i.test(s))out.tripType='round_trip';
 const adultsMatch=s.match(/\b(\d+|one|two|three|four|five)\s*(?:adult|adults|passenger|passengers|person|people|pax)\b/i);
 if(adultsMatch){
  const val=Number(adultsMatch[1])||EN_NUMBERS[adultsMatch[1].toLowerCase()];
  if(val>=1&&val<=9)out.adults=val;
 }else if(/\b(?:just\s+me|only\s+me|by\s+myself|travelling\s+alone|traveling\s+alone)\b/i.test(s)){
  out.adults=1;
 }else if(/\b(?:me\s+and\s+my\s+(?:wife|husband|mother|father|brother|sister|friend)|for\s+two\s+of\s+us)\b/i.test(s)){
  out.adults=2;
 }
 // Keep child/infant categories explicit so English intake cannot request an
 // adult-only fare for a family. Missing ages remain a question for the engine.
 for(const [field,re]of [['children',/\b(\d+|one|two|three|four|five)\s+(?:child(?:ren)?|kids?)\b/i],['infants',/\b(\d+|one|two|three|four|five)\s+(?:infants?|bab(?:y|ies))\b/i]]){
  const m=s.match(re),n=m&&(Number(m[1])||EN_NUMBERS[m[1].toLowerCase()]);if(n>=1&&n<=9)out[field]=n;
 }
 if(/\b(?:child|children|kid|kids|infant|baby|babies)\b/i.test(s)&&out.children===undefined&&out.infants===undefined)delete out.adults;
 if(/\b(?:no\s+(?:baggage|luggage|checked\s+bag)|hand\s+(?:luggage|baggage)\s+only|cabin\s+bag\s+only|0\s*kg)\b/i.test(s))out.weightKg=0;
 else{
  const kgMatch=s.match(/\b(20|30|40|50)\s*(?:kg|kilos?|kilograms?)\b/i);
  if(kgMatch)out.weightKg=Number(kgMatch[1]);
 }
 if(/\bair\s*arabia\b/i.test(s)&&!/\bfly\s*cham\b/i.test(s)){
  out.provider='airarabia';
  if(/\bonly\s+air\s*arabia\b|\bair\s*arabia\s+only\b/i.test(s)){out.providerExclusive=true;out.providerRestrictionSource='customer';}
 }else if(/\bfly\s*cham\b/i.test(s)&&!/\bair\s*arabia\b/i.test(s)){
  out.provider='flycham';
  if(/\bonly\s+fly\s*cham\b|\bfly\s*cham\s+only\b/i.test(s)){out.providerExclusive=true;out.providerRestrictionSource='customer';}
 }else if(/\b(?:any|either|both)\s+airlines?\b/i.test(s)){
  out.providerExclusive=false;out.providerRestrictionSource=null;
 }
 return out;
}

function parseEnglishVisaFacts(raw){
 const s=affirmativeEnglishText(raw).trim();
 if(!s)return {};
 const out={};
 const foundNats=[];
 const nationalityText=s.replace(/\bissued\s+(?:from|in|by)\s+\w+/ig,'');
 for(const [re,nat]of EN_NATIONALITIES)if(re.test(nationalityText))foundNats.push(nat);
 if(foundNats.length===1)out.nationality=foundNats[0];
 if(/\btravel\s+documents?\b|\brefugee\s+documents?\b/i.test(s)){
  out.documentType='travel_document';
  const issued=s.match(/\bissued\s+(?:from|in|by)\s+(syria|lebanon|egypt|jordan|iraq)\b/i);
  if(issued){
   const map={syria:'سوريا',lebanon:'لبنان',egypt:'مصر',jordan:'الأردن',iraq:'العراق'};
   out.documentIssuer=map[issued[1].toLowerCase()];
  }
 }else if(/\b(?:normal|regular|ordinary|valid)?\s*passports?\b/i.test(s)&&!/\bhow\b|\bvalidity\b|\bexpire/i.test(s)){
  out.documentType='passport';
 }
 const countMatch=s.match(/\b(\d+|one|two|three|four|five)\s*(?:applicants?|people|persons?|adults?|visas?|passengers?)\b/i);
 if(countMatch){
  const n=Number(countMatch[1])||EN_NUMBERS[countMatch[1].toLowerCase()];
  if(n>=1&&n<=30)out.applicantCount=n;
 }else if(/\b(?:just\s+me|only\s+me|for\s+myself|1\s+person)\b/i.test(s)){
  out.applicantCount=1;
 }else if(/\b(?:me\s+and\s+my\s+(?:wife|husband|mother|father|son|daughter|brother|sister))\b/i.test(s)){
  out.applicantCount=2;
 }
 const party=parseEnglishFlightPatch(s);if(party.adults&&(party.children||party.infants))out.applicantCount=party.adults+(party.children||0)+(party.infants||0);
 if(/\bby\s+(?:car|land|road)\b|\bal\s*batha\b|\bbatha\s+border\b/i.test(s))out.transport='car';
 else if(/\bby\s+(?:air|flight|plane)\b/i.test(s))out.transport='air';
 if(/\bbank\s+transfer\b|\biban\b/i.test(s)&&!/\bbank\s+statement\b/i.test(s))out.paymentMethod='bank';
 else if(/\bpayment\s+link\b/i.test(s))out.paymentMethod='link';
 else if(/\btabby\b/i.test(s))out.paymentMethod='tabby';
 return out;
}

module.exports={detectLanguageStyle,parseEnglishFlightPatch,parseEnglishVisaFacts,affirmativeEnglishText};
