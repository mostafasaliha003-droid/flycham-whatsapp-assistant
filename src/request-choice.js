'use strict';
const {randomUUID}=require('node:crypto');
const {normalize,naturalDate}=require('./arabic-dates');
const {languagePatch}=require('./travel-language');

const CHOICE_TTL_MS=30*60*1000;
const CHOICES=Object.freeze([
 Object.freeze({action:'continue',title:'متابعة طلبي الحالي'}),
 Object.freeze({action:'new',title:'طلب جديد مختلف'})
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROMPT='أكيد، أنا معك 🌷 حتى أتابع معك بالطريقة الأنسب، بتحب:\n\n1️⃣ *متابعة طلبي الحالي*\nنكمل على نفس الرحلة والتفاصيل اللي اتفقنا عليها.\n\n2️⃣ *طلب جديد مختلف*\nنبدأ رحلة جديدة بتفاصيل مستقلة عن طلبك الحالي.\n\nاختار 1 أو 2، ومنكمل سوا ✈️';
const REMINDER='أكيد 🌷 بتحب نكمل على طلبك الحالي، أو نبدأ طلب جديد مختلف؟ اختار 1 أو 2 حتى أتابع على أساس واضح.';
const STALE='هالخيار من رسالة سابقة وما رح يغيّر طلبك الحالي 🌷 استخدم آخر خيارات أرسلتها إلك، أو ابعتلي طلبك بكلماتك حتى نتابع على أساس واضح.';
const clean=value=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,3000);
const normalized=value=>normalize(clean(value)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/ة/g,'ه').replace(/[؟?!،,.]+$/g,'').trim().toLowerCase();

function hasCurrentRequest(state){
 const r=state?.base?.request;
 return Boolean(r&&typeof r==='object'&&(r.origin||r.destination||r.departureDate||r.departureRange)&&state.status!=='cancelled');
}
function activeChoice(state,now){
 const p=state?.requestChoice;
 return Boolean(p&&UUID.test(p.id||'')&&(p.tripId??null)===(state.tripId??null)&&Number.isFinite(p.createdAt)&&Number.isFinite(p.expiresAt)&&Number.isFinite(now)&&p.createdAt<=now&&p.expiresAt>now&&p.expiresAt-p.createdAt===CHOICE_TTL_MS&&typeof p.text==='string'&&p.text.length<=3000&&hasCurrentRequest(state));
}
function explicitNew(t){return /(?:طلب|رحل[هة]|سفر[هة])\s+(?:جديد[هة]?|مختلف[هة]?|تاني[هة]?|ثاني[هة]?)|(?:ابدا|نبدا|بلش|نبلش)\s+(?:بـ?طلب\s+)?(?:جديد|من\s+جديد)|(?:طلب|رحل[هة])\s*(?:اخر|غيره)|(?:وكمان|و كمان)\s+(?:بدي\s+)?(?:رحل[هة]|تذكر[هة]|تيكت|من\s)/.test(t);}
function explicitCurrent(t){return /(?:نفس|هال|هاد|هذا)\s*(?:ال)?(?:طلب|رحل[هة]|عرض|خيار|حجز|تفاصيل)|طلبي\s*(?:الحالي|السابق)|طلبنا\s*الحالي|(?:عدل|عدلي|تعديل|بدل|غير|خلي|خليه|قصدي|صحح|تابع|نكمل|كمل على|عيد البحث|اعد البحث)/.test(t);}
function operationalOrSocial(t){return /(?:تثبيت|ثبتلي|ثبت لي|بدي ثبت|احجزلي|احجز لي|رابط الدفع|دفعت|حجزت|التذكره الصادره|حجزي|عندي حجز)|^(?:المزيد|باقي (?:الخيارات|العروض|التواقيت)|بقيه (?:الخيارات|العروض|التواقيت)|كمل (?:العروض|الخيارات|التواقيت))$|^(?:احذف بياناتي|امسح بياناتي|الغاء|الغي|وقف البحث|اوقف البحث|الغاء الطلب|cancel|شكرا|شكراً|شكرا كتير|شكرا ناطرك|شكرا لانتظارك|يسلمو|مشكور|مرحبا|اهلا|هلا|السلام عليكم|hi|hello|تمام|اوكي|حاضر|نعم|اي|شو صار|وين وصلتوا|وين وصلت|وين الاسعار|بانتظاركن|بانتظاركم|بانتظار|بانتظار الاسعار|ناطر|ناطر الاسعار|منتظر|منتظر الاسعار|خلص برجعلكن)$/.test(t);}
function dateAnswer(t,now){
 if(/طلب|رحل[هة]|حجز|تذكر[هة]|تيكت|طيران|شخص|مسافر|كيلو|مطار/.test(t))return false;
 const route=languagePatch(t);if(route.origin||route.destination)return false;
 const parsed=naturalDate(t,now);
 return Boolean(parsed.range||parsed.dates?.length||/\b\d{4}-\d{2}-\d{2}\b/.test(t));
}

// This gate only asks about the relationship between two requests. It never
// applies model fields, clears the current trip or cancels a supplier job.
function shouldOfferRequestChoice({state,text,decision,followup,quotedOfferReferences=[],now=Date.now()}={}){
 if(!hasCurrentRequest(state)||state.humanOwned||state.base?.awaiting||state.pendingQuotedOffer||state.status==='handoff_pending')return false;
 if(activeChoice(state,now)||followup||quotedOfferReferences.length)return false;
 if(['booking','select','status','thanks','greeting','goodbye','cancel','explain','compare','negotiate','knowledge'].includes(decision?.intent))return false;
 const t=normalized(text);
 if(!t||operationalOrSocial(t)||explicitNew(t)||explicitCurrent(t))return false;
 const noun=/(?:تذكر[هة]|تذاكر|تيكت|تيكيت|تكيت|حجز|رحل[هة]|رحلات|طيران|سفر|طلب)/.test(t);
 const wants=/(?:بدي|بدنا|اريد|عايز|عاوز|ابي|ابغي|حابب|حابه|حابين|محتاج|محتاجه|عندي|بدنا|ممكن|شوفلي|شوف لي|شفلي|تشوفلي|احصل|احجز)|(?:شو|ايش|ما|هل)\s*(?:عندك|عندكن|عندكم|في|متوفر)|(?:عندك|عندكن|عندكم)\s*(?:تذاكر|رحلات|طيران)/.test(t);
 return noun&&wants;
}

function publicChoice(p){return {...structuredClone(p),reply:PROMPT,choices:CHOICES.map(c=>({...c}))};}
function createRequestChoice(state,text,{now=Date.now()}={}){
 if(!hasCurrentRequest(state)||state.humanOwned||!Number.isFinite(now))throw Error('REQUEST_CHOICE_INVALID_STATE');
 if(activeChoice(state,now))return publicChoice(state.requestChoice);
 const value=clean(text);if(!value)throw Error('REQUEST_CHOICE_INVALID_TEXT');
 const pending={id:randomUUID(),tripId:state.tripId??null,createdAt:now,expiresAt:now+CHOICE_TTL_MS,text:value};
 state.requestChoice=pending;
 return publicChoice(pending);
}

function textAction(t){
 if(/^(?:1|الاول|الاولي|اول|الاولى|(?:بدي\s+)?متابعه(?:\s+(?:طلبي|الطلب))?(?:\s+الحالي)?|(?:بدي\s+)?(?:تابع|اتابع|كمل|نكمل)(?:\s+(?:علي\s+)?ب?(?:طلبي|الطلب|طلبنا))?(?:\s+الحالي)?|(?:نفس|علي نفس)\s+(?:الطلب|طلبي|الرحله)|طلبي الحالي|الطلب الحالي|continue(?: my)?(?: current)? request)$/.test(t))return 'continue';
 if(/^(?:2|الثاني|التاني|الثانيه|التانيه|تاني|ثاني|(?:بدي\s+)?طلب جديد(?: مختلف)?|(?:بدي\s+)?(?:ابدا|نبدا|بلش|نبلش)(?:\s+(?:(?:بـ?)?طلب|رحله))?\s+(?:جديد[هة]?|مختلف[هة]?|من جديد)|(?:بدي\s+)?رحله جديده|new(?: different)? request)$/.test(t))return 'new';
 return null;
}

// Numbered replies have meaning here only while this exact, unexpired choice
// is pending. Signed button input still needs its nonce checked against state.
function readRequestChoice(state,text,{now=Date.now(),buttonChoice}={}){
 if(state?.humanOwned)return {action:'none'};
 const pending=state?.requestChoice;
 if(!pending)return {action:buttonChoice?'stale':'none',...(buttonChoice?{reply:STALE,reason:'missing'}:{})};
 if(!activeChoice(state,now))return {action:'stale',reason:'expired_or_superseded',reply:STALE,pending:structuredClone(pending)};
 if(buttonChoice){
  if(buttonChoice.id!==pending.id||!['continue','new'].includes(buttonChoice.action))return {action:'stale',reason:'nonce',reply:STALE,pending:structuredClone(pending)};
  return {action:buttonChoice.action,pending:structuredClone(pending)};
 }
 const t=normalized(text),action=textAction(t);
 if(action)return {action,pending:structuredClone(pending)};
 if(/^(?:نعم|اي|تمام|اوكي|حاضر|ok|yes)$/.test(t))return {action:'repeat',pending:structuredClone(pending),reply:REMINDER,choices:CHOICES.map(c=>({...c}))};
 // A clearly scoped operation can proceed through the normal engine. It must
// not turn a status question, known baggage change or quoted offer into a new
// journey merely because a choice happens to be pending.
 if(explicitCurrent(t)||dateAnswer(t,now)||/^(?:(?:بدي|بدنا|خلي|خليه|بدل)\s+)?(?:وزن\s+)?(?:\d{1,3}|عشرين|ثلاثين|تلاتين|اربعين|خمسين)\s*(?:كيلو|كغ|kg)(?:\s+(?:بس|لو سمحت))?$/.test(t)||/^(?:الخيار|العرض)\s*\d{1,2}$/.test(t))return {action:'none',resolvedCurrent:true,pending:structuredClone(pending)};
 if(operationalOrSocial(t))return {action:'none',pending:structuredClone(pending)};
 return {action:'repeat',pending:structuredClone(pending),reply:REMINDER,choices:CHOICES.map(c=>({...c}))};
}

module.exports={shouldOfferRequestChoice,createRequestChoice,readRequestChoice,CHOICE_TTL_MS,CHOICES};
