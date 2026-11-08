'use strict';
const {normalize}=require('./arabic-dates');
const {conversationIntent,applicationReference}=require('./visa-conversation-intent');
const visaPolicy=require('./saudi-visa-policy');
const {naturalDate}=require('./arabic-dates');
const {randomUUID}=require('node:crypto');
const SERVICE_MENU='*أهلاً وسهلاً فيك بمجموعة الرمال 🌷*\nخلّينا نوصلك للمختص بطلبك:\n\n✈️ *طيران إلى سوريا*\nمع أحمد لمقارنة الرحلات والأسعار.\n\n🇸🇦 *فيزا السعودية*\nمع إسماعيل لمعرفة نوع التأشيرة والمتطلبات والتكلفة.\n\n*شو حابب نساعدك فيه اليوم؟* اختار من الأزرار تحت، أو اكتب طلبك مباشرة.';
function serviceMenu(store,id,prefix=''){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{revision:0};s.awaitingService=true;s.menuId=randomUUID();s.at=Date.now();store.data.serviceSessions[id]=s;store.save();return{service:'choose',menuId:s.menuId,reply:(prefix?prefix+'\n\n':'')+SERVICE_MENU};}
function visaEnabled(env=process.env){return env.SAUDI_VISA_ENABLED!=='false';}
function activeService(store,id){return store.data.serviceSessions?.[id]?.service||'flight';}
function incomingRevision(store,id){return store.data.serviceSessions?.[id]?.revision||0;}
function noteIncoming(store,id){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{};s.revision=(s.revision||0)+1;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();return s.revision;}
function setService(store,id,service){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{revision:0};s.service=service;s.awaitingService=false;delete s.menuId;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();}
// When a visa service is explicit, a travel mode or excluded flight is context,
// not a second service. Keep positive clauses so a later request still routes.
function visaFlightRequestText(text){
 return String(text||'').split(/[،,؛;.!?؟]|\s+(?:but|mais|ama|لیکن|लेकिन)\s+/iu).filter(part=>{
  if(/\b(?:without|not|no|do not|don['’]?t)\s+(?:(?:need|want|require|book)\s+)?(?:(?:a|any|the)\s+)?(?:flights?|(?:flight\s+)?tickets?)\b|\b(?:flights?|tickets?)\s+(?:are\s+|is\s+)?not\s+(?:needed|required|wanted)\b/iu.test(part))return false;
  if(/\b(?:pas\s+de|sans)\s+(?:vols?|billets?\s+d[’']avion)\b|(?:uçuş|uçak\s+bileti)\s+(?:istemiyorum|gerekmiyor)|(?:پرواز|ٹ[کك]ٹ).{0,12}نہ[يی]ں\s*(?:چاہ[يی]ے|چاہتا|چاہتی)/iu.test(part))return false;
  // Questions about what a visa quote includes are not flight bookings.
  if(/\b(?:does|do|is|are)\b.{0,65}\b(?:include|cover|included)\b.{0,20}\b(?:flights?|tickets?)\b|\b(?:are|is)\s+(?:the\s+)?(?:flights?|tickets?)\s+(?:already\s+)?(?:included|covered)\b|\b(?:visa|fee|price)\b.{0,35}\b(?:vs\.?|versus|compared\s+(?:with|to))\b.{0,30}\b(?:flights?|tickets?)\b/iu.test(part))return false;
  return true;
 }).map(part=>part.replace(/\bby\s+(?:air|plane|flight)\b|\b(?:travel(?:ling|ing)?|fly(?:ing)?|go(?:ing)?)\s+on\s+(?:a\s+|the\s+)?flight\b|پرواز\s+سے|उड़ान\s+से/giu,' ')).join(' ');
}
// Entry routing only: an explicit visa destination/service is not evidence of
// nationality, eligibility or a request to alter an existing application.
function multilingualVisaHints(text){
 const t=String(text||'').normalize('NFKC').toLowerCase().replace(/\u0307/g,'').replace(/[یى]/g,'ي').replace(/ک/g,'ك');
 const boundary='(?:^|[^\\p{L}\\p{M}])',end='(?=$|[^\\p{L}\\p{M}])';
 const phrases=[
  // Urdu and Hindi: keep destination and visa adjacent, rather than joining
  // unrelated country and visa mentions anywhere in the message.
  'سعودي(?:\\s+عرب)?(?:\\s+ك[ايے])?\\s+ويز[اے]',
  'عمر[ہه](?:\\s+ك[ايے])?\\s+ويز[اے]',
  '(?:सऊदी|सऊदि|सौदी)(?:\\s+अरब)?(?:\\s+का)?\\s+वीज़?ा',
  'उमरा(?:ह)?(?:\\s+का)?\\s+वीज़?ा',
  '(?:saudi(?:\\s+arabia)?|ksa)\\s+(?:(?:tourist|visit|tourism)\\s+)?(?:visa|e-?visa)|(?:visa|e-?visa)\\s+(?:to|for)\\s+(?:saudi(?:\\s+arabia)?|ksa)',
  // Destination stays adjacent to the service, allowing common adjectives.
  'visa\\s+(?:touristique\\s+)?(?:saoudien(?:ne)?|(?:pour\\s+)?(?:l[’\x27]\\s*)?arabie\\s+saoudite|(?:pour\\s+)?(?:l[’\x27]\\s*)?omra)',
  '(?:visa|visado)\\s+(?:tur[ií]stic[oa]\\s+)?(?:para\\s+)?arabia\\s+saudita',
  'visum\\s+(?:f[uü]r\\s+)?saudi[-\\s]arabien',
  'ويزا(?:ي)?\\s+عربستان\\s+سعودي',
  'visa\\s+(?:3al|lal)\\s+sa3oudiy[ea]',
  '(?:саудовск(?:ая|ую)\\s+виз(?:а|у)|виз(?:а|у|ы)\\s+(?:в|для)\\s+саудовск(?:ую|ой)\\s+арави(?:ю|и)|виз(?:а|у|ы)\\s+(?:для|на)\\s+умр(?:у|ы))',
  '(?:suudi(?:\\s+arabistan)?|umre)\\s+vize(?:si|sine|sini|siyle)?'
 ];
 // Chinese does not require spaces between words. Match the complete adjacent
 // destination+visa phrase, not Latin-style boundaries or a bare country name.
 const chineseVisa=/(?:沙特(?:阿拉伯)?|沙烏地阿拉伯)(?:旅游|旅遊|电子|電子)?(?:签证|簽證)/u.test(t);
 const visa=chineseVisa||phrases.some(pattern=>new RegExp(boundary+'(?:'+pattern+')'+end,'u').test(t));
 const flightText=visa?visaFlightRequestText(t):text;
 const flight=visa&&(new RegExp(boundary+'(?:billets?\\s+d[’\x27]avion|vols?|billetes?\\s+de\\s+avi[oó]n|flugtickets?|авиабилеты?|билеты?|перел[её]т|uçak\\s+bileti|uçuş|टिकट|उड़ान|ٹكٹ|پرواز|بليط\\s+هواپيما)'+end,'u').test(flightText)||chineseVisa&&/(?:机票|機票)/u.test(flightText));
 return {visa,flight,flightText};
}
function routeService(store,id,text,{env=process.env,media=false,hasFlight=false,hasActiveRequest=false,serviceChoice=null}={}){
 if(!visaEnabled(env))return {service:'flight'};
 const t=normalize(String(text||'')),s=store.data.serviceSessions?.[id],multilingual=multilingualVisaHints(t);
 if(serviceChoice){if(s?.awaitingService&&s.menuId===serviceChoice.id&&['flight','saudi_visa'].includes(serviceChoice.service)){setService(store,id,serviceChoice.service);return{service:serviceChoice.service,selectedText:serviceChoice.service==='flight'?'طيران إلى سوريا':'فيزا السعودية'};}return serviceMenu(store,id,'القائمة السابقة لم تعد نشطة. اختار الخدمة من القائمة الحالية ومنكمل معك.');}
 if(s?.awaitingService&&/^(?:1|الاول|الخيار الاول|الاول طيران)$/.test(t)){setService(store,id,'flight');return{service:'flight',selectedText:'طيران إلى سوريا'};}
 if(s?.awaitingService&&/^(?:2|الثاني|التاني|الخيار الثاني|الخيار التاني)$/.test(t)){setService(store,id,'saudi_visa');return{service:'saudi_visa',selectedText:'فيزا السعودية'};}
 const otherService=t.match(/(?:فيزا|فيزه|تاشيره|تاشير|رحله|بكيج|بكج|سفر)\s+(?:الي?\s+)?(تركيا|عمان|الكويت|قطر|البحرين|تايلاند|تنزانيا|فيتنام|اندونيسيا|الهند|شنغن|بريطانيا)|(?:تخفيض|تخفي ض)\s+غرامات/);
 if(otherService){const requestedService=otherService[1]||'تخفيض الغرامات';store.data.serviceSessions||={};const session=store.data.serviceSessions[id]||{revision:0};session.serviceInquiry={service:requestedService,at:Date.now()};store.data.serviceSessions[id]=session;store.save();return{service:'service_inquiry',reply:'أكيد، سجلت استفسارك عن '+requestedService+'. شو حابب تعرف: المتطلبات، التكلفة أو طريقة التقديم؟ تفاصيل هالخدمة تحتاج مراجعة المختص، وطلبك الحالي بيضل محفوظ.'};}
 if(!s?.awaitingService&&(['status','case_summary'].includes(conversationIntent(t))||applicationReference(t,{known:Object.values(store.data.visaFulfilment?.jobs||{}).filter(job=>job.customer===id).map(job=>job.applicationReference)}))&&(s?.service==='saudi_visa'||!s?.service&&!hasFlight)){setService(store,id,'saudi_visa');return{service:'saudi_visa'};}
 if(s?.serviceInquiry&&!multilingual.visa&&!/السعوديه|السعودية|سعودي|اسماعيل|احمد|طيران|فلاي شام|حلب|دمشق|الشام|القائمه|الخدمات/.test(t)&&!conversationIntent(t)&&!applicationReference(t,{awaiting:true})){
  const inquiry=s.serviceInquiry,nationalities=visaPolicy.nationalities(t);if(nationalities.length===1&&!/مقيم|اقامه|زيارة|سفر|الى|الي/.test(t))inquiry.nationality=nationalities[0];if(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(t)){const dates=naturalDate(t);if(dates.dates?.length===1&&!dates.invalid)inquiry.travelDate=dates.dates[0];}inquiry.status='needs_specialist';store.save();return{service:'service_inquiry',reply:'استفسارك عن '+inquiry.service+' محفوظ بشكل منفصل. '+(!inquiry.nationality?'شو جنسية المسافر؟':!inquiry.travelDate?'جنسية المسافر محفوظة. شو تاريخ السفر المطلوب؟':'حفظت الجنسية ('+inquiry.nationality+') وتاريخ السفر ('+inquiry.travelDate+') لخدمة '+inquiry.service+' للمراجعة مع المختص 🌷 ما في سعر أو شروط معتمدة لهالخدمة عند المساعد حاليًا، وبيتابع معك الفريق بالتفاصيل.')};
 }
 if(s?.serviceInquiry&&(multilingual.visa||/السعوديه|السعودية|سعودي|اسماعيل|احمد|طيران|فلاي شام|حلب|دمشق|الشام|القائمه|الخدمات/.test(t))){delete s.serviceInquiry;store.save();}
 const generic=/^(?:(?:مرحبا|هلا|اهلا(?: وسهلا)?|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|هاي|hello|hi|صباح الخير|مساء الخير|لو سمحت|ممكن|عندي استفسار|ممكن استفسار|بدي استفسر|شو عندكن|شو عندكم|شو خدماتكم|شو خدماتكن|شو الخيارات|شو الخيارات المتاحه|القائمه|الخدمات)[،,!؟?. 🌷]*)+$/i.test(t);
 const explicitMenu=/^(?:القائم[هة]|الخدمات|شو خدماتكم|شو خدماتكن|شو الخيارات|شو الخيارات المتاح[هة]|بدي خدم[هة] جديد[هة]|بدي (?:اسال|استفسر) عن خدم[هة] (?:جديد[هة]|تاني[هة]|ثاني[هة]))$/.test(t);
 if(explicitMenu)return serviceMenu(store,id);
 // A greeting within a visa conversation belongs to that same conversation.
 // The customer can still open the menu or explicitly choose another service.
 if(generic&&s?.service==='saudi_visa')return{service:'saudi_visa'};
 if(generic&&s?.service==='flight'&&require('./customer-profile').returningGreeting(store,id,'flight'))return{service:'flight'};
 if(generic&&!hasActiveRequest)return serviceMenu(store,id);
 const visa=multilingual.visa||/زيار[ةه]\s*(?:عائلي[ةه]|شخصي[ةه]|للسعودي[ةه]|سعودي[ةه])|(?:تقديم|اقدم|نقدم|(?:ال)?اوراق|(?:ال)?مطلوب[ةه]?)(?:\s+(?:ال)?مطلوب[ةه]?)?\s+(?:عل[ىي]\s*ال|ل(?:ل)?|ال)سعودي[ةه]|معامل[ةه]\s*(?:فيزا|تاشير|تأشير|السعودي[ةه])|منفذ البطحاء|فيزا|فيزه|تاشير|عمره|عمرة|نسك|اسماعيل|رعد|ismail|raad|saudi visa|umrah/i.test(t);
 const flightText=multilingual.flightText;
 const englishRoute=require('./bilingual-intake').parseEnglishFlightPatch(flightText);
 const flight=multilingual.flight||Boolean(englishRoute.origin&&englishRoute.destination)||/(?:من|مغادر).{0,30}(?:دبي|الشارق[هة]|ابوظبي|ابو ظبي|دمشق|الشام|حلب|سوريا).{0,15}(?:الي|الى|لل|لدمشق|للشام|لحلب|للشارق|لدبي)|ذهاب (?:بس|فقط)|ذهاب وعود|فلاي شام|flycham|airarabia/i.test(flightText)||/تذاكر|تيكتات|العربي[ةه]\s*للطيران|اجنح[ةه]\s*الشام|أجنحة\s*الشام|اللاذقي[ةه]|لاذقي[ةه]|طيران|طياره|تذكره|تيكت|رحلات|حجز.*رحله|flight|ticket|احمد/i.test(flightText);
 if(visa&&flight&&!s?.service)return serviceMenu(store,id,'فينا نساعدك بالتأشيرة والطيران. بأي خدمة بتحب نبدأ؟');
 if(visa&&!flight){setService(store,id,'saudi_visa');return{service:'saudi_visa'};}
 if(flight&&!visa){setService(store,id,'flight');return{service:'flight'};}
 if(s?.service)return{service:s.service};
 if(hasFlight){setService(store,id,'flight');return{service:'flight'};}
 if(media)return serviceMenu(store,id,'وصل المرفق، شكراً إلك. حتى نوجّهه للقسم المناسب، اختار الخدمة المطلوبة.');
 return serviceMenu(store,id);
}
function isComplaint(text){const t=normalize(text||'');if(/(?:قالوا|قالولي|حكولي|سمعت|بيقولوا|في ناس).{0,25}(?:نصاب|حرامي)|هل.*(?:نصاب|حرامي)|شو.*(?:نصاب|حرامي)/.test(t))return false;
 return /شكوي|شكوى/.test(t)||(/قدمت|دافع|دفعت|حولت|معاملتي|طلبت|مصاري|فلوسي|رسوم/.test(t)&&/نصاب|حرامي|نصبت|ما ?رجعت|ما ?رجع|ما ?طلعت|ما ?صدرت|تاخر|تأخر|استرد|ارجاع|رجعولي/.test(t))||/(?:انتو|انتم|انك[من]|شركتكم).{0,15}(?:نصاب|حرامي|حرميه)/.test(t);
}
module.exports={SERVICE_MENU,serviceMenu,visaEnabled,activeService,incomingRevision,noteIncoming,setService,routeService,isComplaint};
