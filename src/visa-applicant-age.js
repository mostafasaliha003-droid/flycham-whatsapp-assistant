'use strict';
// Conversation extraction only. Age is never inferred from a price, date,
// document lifetime or another applicant, and this module owns no pricing rule.
const UNITS={صفر:0,واحد:1,واحده:1,احد:1,اثنان:2,اثنين:2,اتنين:2,تنين:2,اثنتين:2,ثلاث:3,ثلاثه:3,تلات:3,تلاته:3,اربع:4,اربعه:4,خمس:5,خمسه:5,ست:6,سته:6,سبع:7,سبعه:7,ثمان:8,ثمانيه:8,تمان:8,تمانيه:8,تسع:9,تسعه:9};
const TENS={عشرون:20,عشرين:20,ثلاثون:30,ثلاثين:30,تلاتين:30,اربعون:40,اربعين:40,خمسون:50,خمسين:50,ستون:60,ستين:60,سبعون:70,سبعين:70,ثمانون:80,ثمانين:80,تمانون:80,تمانين:80,تسعون:90,تسعين:90};
const SPECIAL={عشر:10,عشره:10,حداش:11,حدعش:11,احدعش:11,اتناشر:12,اتنعش:12,اثناشر:12,تلتعش:13,تلاتعش:13,اربعتعش:14,خمستعش:15,ستعش:16,سبعتعش:17,تمنتعش:18,تسعتعش:19,ميه:100,مئه:100,مائه:100};
const NUMBER_WORDS=[...Object.keys(UNITS),...Object.keys(TENS),...Object.keys(SPECIAL),'اثنا','اثني','اثنتا','اثنتي'].sort((a,b)=>b.length-a.length).join('|');
const WORD_NUMBER=new RegExp('^((?:'+NUMBER_WORDS+')(?:\\s+(?:و\\s*)?(?:'+NUMBER_WORDS+')){0,4})(?=$|[^\\p{L}])','u');
const ORDINALS={الاول:0,الاولي:0,الثاني:1,الثانيه:1,التاني:1,التانيه:1,الثالث:2,الثالثه:2,التالت:2,التالته:2,الرابع:3,الرابعه:3,الخامس:4,الخامسه:4,السادس:5,السادسه:5,السابع:6,السابعه:6,الثامن:7,الثامنه:7,التاسع:8,التاسعه:8,العاشر:9,العاشره:9,first:0,second:1,third:2,fourth:3,fifth:4,premier:0,premiere:0,deuxieme:1,seconde:1,troisieme:2,quatrieme:3,cinquieme:4};
const ORDINAL_SOURCE=Object.keys(ORDINALS).sort((a,b)=>b.length-a.length).join('|');
const TARGET=new RegExp('(?:^|[^\\p{L}\\p{N}])(?:و)?(?:(?:المتقدم[ه]?|الشخص|المسافر[ه]?|الفرد|applicant|person|travell?er|demandeur|personne|voyageur)\\s*(?:(?:رقم|number|no\\.?|numero|n°)\\s*)?(\\d{1,2}|'+ORDINAL_SOURCE+')|('+ORDINAL_SOURCE+')(?:\\s+(?:applicant|person|demandeur|personne))?)(?=$|[^\\p{L}\\p{N}])','gu');
const AGE_LABEL=/(?:^|[^\p{L}])(?:(?:و)?(?:عمري|عمره|عمرها|عمر|العمر|سني|السن)|my age|age|aged|mon age)(?:\s+(?:هو|هي|الان|حاليا|is|est|de))?\s*[:=]?\s*/u;
const SELF_LABEL=/(?:^|[^\p{L}])(?:انا|i am|i['’]m|j['’]ai)\s*/u;
const RELATIVE=/(?:زوجتي|زوجي|مرتي|مراتي|امي|ابي|ابوي|والدي|والدتي|اخي|اختي|ابني|بنتي|صديقي|صديقتي|my (?:wife|husband|mother|father|son|daughter|friend)|ma (?:femme|mere|fille)|mon (?:mari|pere|fils|ami))/u;
const YEAR_UNIT=/^(?:سنه|سنين|سنوات|عاما?|اعوام|years?(?:\s+old)?|yrs?(?:\s+old)?|ans)(?=$|[^\p{L}])/u;
const NOT_AGE_UNIT=/^(?:درهم|دراهم|ريال|دولار|aed|usd|euros?|dollars?|days?|months?|weeks?|يوم|ايام|شهر|شهور|اشهر|اسبوع|اسابيع|mois|jours?|semaines?)(?=$|[^\p{L}])/u;

function normalizeAgeText(value){
 return String(value||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
  .replace(/[٠-٩]/g,x=>'٠١٢٣٤٥٦٧٨٩'.indexOf(x)).replace(/[۰-۹]/g,x=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(x))
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function validAge(value){return Number.isInteger(value)&&value>=0&&value<120;}
function parseCompletedAge(value){
 const n=normalizeAgeText(value).replace(/\s+(?:سنه|سنين|سنوات|عاما?|اعوام|years?(?:\s+old)?|yrs?(?:\s+old)?|ans)$/u,'').trim();
 if(/^\d{1,3}$/.test(n))return validAge(Number(n))?Number(n):null;
 if(Object.hasOwn(UNITS,n))return UNITS[n];
 if(Object.hasOwn(TENS,n))return TENS[n];
 if(Object.hasOwn(SPECIAL,n))return SPECIAL[n];
 const words=n.split(/\s+/).filter(x=>x!=='و').map(x=>x.startsWith('و')&&x!=='واحد'&&x!=='واحده'?x.slice(1):x);
 let age=null;
 if(words.length===2&&Object.hasOwn(UNITS,words[0])&&Object.hasOwn(TENS,words[1]))age=UNITS[words[0]]+TENS[words[1]];
 else if(words.length===2&&['عشر','عشره'].includes(words[1])){
  const unit=({اثنا:2,اثني:2,اثنتا:2,اثنتي:2})[words[0]]??UNITS[words[0]];
  if(unit>=1&&unit<=9)age=10+unit;
 }else if(['ميه','مئه','مائه'].includes(words[0])&&words.length>1){const rest=parseCompletedAge(words.slice(1).join(' '));if(rest!==null&&rest<20)age=100+rest;}
 return validAge(age)?age:null;
}
function agePrefix(value){
 const n=value.trimStart(),number=n.match(/^\d{1,3}(?!\d)/)||n.match(WORD_NUMBER);
 if(!number)return null;
 const raw=number[1]||number[0],age=parseCompletedAge(raw),tail=n.slice(raw.length).trimStart();
 if(age===null||/^[\d.,٫/-]/.test(tail)||NOT_AGE_UNIT.test(tail))return null;
 // A number immediately attached to an unrelated word is not an age token.
 if(/^\p{L}/u.test(tail)&&raw.length<n.length&&!/^\s/u.test(n.slice(raw.length,raw.length+1))&&!YEAR_UNIT.test(tail))return null;
 return {age,tail,hasYears:YEAR_UNIT.test(tail)};
}
function pendingIndex(awaiting,applicantCount){
 const match=typeof awaiting==='string'&&awaiting.match(/^age_(\d{1,2})$/),index=match?Number(match[1]):awaiting==='age'?0:null;
 return index!==null&&index<30&&(applicantCount===null||index<applicantCount)?index:null;
}
function safeCount(value){return Number.isInteger(value)&&value>=1&&value<=30?value:null;}
function refusalOrHypothesis(text){
 return /(?:^|[^\p{L}])(?:لو(?!\s+سمحت)|اذا|افترض|فرض[ا]?|هل|لما اصير|لو صرت|اذا صار|if|suppose|assuming|what if|si|supposons)(?=$|[^\p{L}])/u.test(text)||
  /(?:^|[^\p{L}])(?:مو|مش|مب|ماني|لست|ليس|not|isn['’]?t|wasn['’]?t|ne|pas)(?=$|[^\p{L}])/u.test(text);
}
function ageClaim(clause,{indexHint=null,awaited=null,single=false,listMode=false}={}){
 if(refusalOrHypothesis(clause))return null;
 const ageLabel=clause.match(AGE_LABEL),selfLabel=clause.match(SELF_LABEL);
 let extracted=null,isSelf=false;
 if(ageLabel){
  isSelf=/عمري|سني|my age|mon age/u.test(ageLabel[0]);
  const prefix=clause.slice(0,ageLabel.index);
  if(!isSelf&&/جواز|باسبور|اقامه|هويه|فيزا|تاشيره|passport|residence|visa|passeport/u.test(prefix))return null;
  // عمرة and عمره normalize identically: a service request is not an age.
  if(!isSelf&&/بدي|بدنا|اريد|عايز|ابغي/u.test(prefix)&&!RELATIVE.test(prefix)&&indexHint===null)return null;
  extracted=agePrefix(clause.slice(ageLabel.index+ageLabel[0].length));
 }
 else if(selfLabel){extracted=agePrefix(clause.slice(selfLabel.index+selfLabel[0].length));isSelf=true;
  if(extracted&&/انا|j['’]ai/u.test(selfLabel[0])&&!extracted.hasYears&&awaited===null)extracted=null;
 }
 if(!extracted&&indexHint!==null&&listMode){
  const target=[...clause.matchAll(TARGET)].at(-1);if(target)extracted=agePrefix(clause.slice(target.index+target[0].length).replace(/^\s*(?:عمره|عمرها|is|a|age de|:)\s*/u,''));
 }
 if(!extracted)return null;
 let tail=extracted.tail.replace(YEAR_UNIT,'').trim();
 const correction=tail.match(/^(?:لا|قصدي|اقصد|بل|sorry|actually|pardon|plutot)\s+(.+)$/u);
 if(correction){const corrected=parseCompletedAge(correction[1]);if(corrected===null)return null;extracted.age=corrected;tail='';}
 // An age followed only by a question mark is uncertainty, not a statement.
 if(/^[؟?]+$/.test(tail)||/^(?:تقريبا|حوالي|او|ولا|ونص|ونصف|و نصف|or|about|environ|and a half)(?=$|[^\p{L}])/u.test(tail))return null;
 if(indexHint!==null)return {applicantIndex:indexHint,age:extracted.age};
 if(RELATIVE.test(clause))return {unbound:true};
 if(isSelf)return {applicantIndex:0,age:extracted.age};
 if(awaited!==null)return {applicantIndex:awaited,age:extracted.age};
 return single?{applicantIndex:0,age:extracted.age}:{unbound:true};
}

function extractApplicantAgeUpdates(text,{awaiting=null,applicantCount=null}={}){
 const n=normalizeAgeText(text),count=safeCount(applicantCount),awaited=pendingIndex(awaiting,count),updates=new Map();
 let needsClarification=false;
 if(!n)return {updates:[],needsClarification:false};
 if(n.length>4000)return {updates:[],needsClarification:true};
 // A standalone answer binds only to the exact age question being awaited.
 if(awaited!==null){const direct=parseCompletedAge(n);if(direct!==null)return {updates:[{applicantIndex:awaited,age:direct}],needsClarification:false};}
 const ageTopic=AGE_LABEL.test(n)||/اعمار|\bages\b|\bans\b|years? old|سنه|سنين/u.test(n),listMode=ageTopic||awaited!==null;
 let lastIndex=null;
 // Preserve question marks on each clause so an uncertain age is never saved.
 for(const sentence of n.split(/(?<!\d)[,.]|[,.](?!\d)|[،؛;!]|\s+(?:لكن|بس|but|mais)\s+/u)){
  if(!sentence.trim())continue;
  if(refusalOrHypothesis(sentence)){if(ageTopic||awaited!==null)needsClarification=true;continue;}
  const targets=[...sentence.matchAll(TARGET)],pieces=targets.length?targets.map((target,i)=>({text:sentence.slice(i?target.index:0,targets[i+1]?.index??sentence.length),target})): [{text:sentence,target:null}];
  for(const piece of pieces){
   let indexHint=null;
   if(piece.target){const token=piece.target[1]||piece.target[2];indexHint=/^\d+$/.test(token)?Number(token)-1:ORDINALS[token];
    if(!Number.isInteger(indexHint)||indexHint<0||indexHint>=30||count!==null&&indexHint>=count){needsClarification=true;continue;}
   }
   let claim=ageClaim(piece.text,{indexHint,awaited,single:count===1,listMode});
   // A separate explicit correction can replace the immediately preceding age.
   if(!claim&&lastIndex!==null&&/^(?:\s*)(?:لا|قصدي|اقصد|بل|sorry|actually|pardon|plutot)\s+/u.test(piece.text)){
    const corrected=parseCompletedAge(piece.text.trim().replace(/^(?:لا|قصدي|اقصد|بل|sorry|actually|pardon|plutot)\s+/u,''));
    if(corrected!==null)claim={applicantIndex:lastIndex,age:corrected};
   }
   if(claim?.unbound){needsClarification=true;continue;}
   if(claim){updates.set(claim.applicantIndex,claim.age);lastIndex=claim.applicantIndex;}
   else if((AGE_LABEL.test(piece.text)||indexHint!==null&&listMode)&&/\d|خمسين|ثلاث|اربع|اثنين/u.test(piece.text))needsClarification=true;
  }
 }
 return {updates:[...updates].sort(([a],[b])=>a-b).map(([applicantIndex,age])=>({applicantIndex,age})),needsClarification};
}
module.exports={extractApplicantAgeUpdates,parseCompletedAge};
