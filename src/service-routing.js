'use strict';
const {normalize}=require('./arabic-dates');
const {randomUUID}=require('node:crypto');
const SERVICE_MENU='*أهلاً وسهلاً فيك بمجموعة الرمال 🌷*\nخلّينا نوصلك للمختص بطلبك:\n\n✈️ *طيران إلى سوريا*\nمع أحمد لمقارنة الرحلات والأسعار.\n\n🇸🇦 *فيزا السعودية*\nمع إسماعيل لمعرفة نوع التأشيرة والمتطلبات والتكلفة.\n\n*شو حابب نساعدك فيه اليوم؟* اختار من الأزرار تحت، أو اكتب طلبك مباشرة.';
function serviceMenu(store,id,prefix=''){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{revision:0};s.awaitingService=true;s.menuId=randomUUID();s.at=Date.now();store.data.serviceSessions[id]=s;store.save();return{service:'choose',menuId:s.menuId,reply:(prefix?prefix+'\n\n':'')+SERVICE_MENU};}
function visaEnabled(env=process.env){return env.SAUDI_VISA_ENABLED!=='false';}
function activeService(store,id){return store.data.serviceSessions?.[id]?.service||'flight';}
function incomingRevision(store,id){return store.data.serviceSessions?.[id]?.revision||0;}
function noteIncoming(store,id){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{};s.revision=(s.revision||0)+1;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();return s.revision;}
function setService(store,id,service){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{revision:0};s.service=service;s.awaitingService=false;delete s.menuId;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();}
function routeService(store,id,text,{env=process.env,media=false,hasFlight=false,hasActiveRequest=false,serviceChoice=null}={}){
 if(!visaEnabled(env))return {service:'flight'};
 const t=normalize(String(text||'')),s=store.data.serviceSessions?.[id];
 if(serviceChoice){if(s?.awaitingService&&s.menuId===serviceChoice.id&&['flight','saudi_visa'].includes(serviceChoice.service)){setService(store,id,serviceChoice.service);return{service:serviceChoice.service,selectedText:serviceChoice.service==='flight'?'طيران إلى سوريا':'فيزا السعودية'};}return serviceMenu(store,id,'القائمة السابقة لم تعد نشطة. اختار الخدمة من القائمة الحالية ومنكمل معك.');}
 if(s?.awaitingService&&/^(?:1|الاول|الخيار الاول|الاول طيران)$/.test(t)){setService(store,id,'flight');return{service:'flight',selectedText:'طيران إلى سوريا'};}
 if(s?.awaitingService&&/^(?:2|الثاني|التاني|الخيار الثاني|الخيار التاني)$/.test(t)){setService(store,id,'saudi_visa');return{service:'saudi_visa',selectedText:'فيزا السعودية'};}
 const generic=/^(?:(?:مرحبا|هلا|اهلا(?: وسهلا)?|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|هاي|hello|hi|صباح الخير|مساء الخير|لو سمحت|ممكن|عندي استفسار|ممكن استفسار|بدي استفسر|شو عندكن|شو عندكم|شو خدماتكم|شو خدماتكن|شو الخيارات|شو الخيارات المتاحه|القائمه|الخدمات)[،,!؟?. 🌷]*)+$/i.test(t);
 if(/^(?:القائمه|الخدمات|شو خدماتكم|شو خدماتكن|شو الخيارات|شو الخيارات المتاحه)$/.test(t)||generic&&!hasActiveRequest)return serviceMenu(store,id);
 const visa=/فيزا|فيزه|تاشير|عمره|عمرة|نسك|اسماعيل|ismail|saudi visa|umrah/i.test(t);
 const flight=/(?:من|مغادر).{0,30}(?:دبي|الشارق[هة]|ابوظبي|ابو ظبي|دمشق|الشام|حلب|سوريا).{0,15}(?:الي|الى|لل|لدمشق|للشام|لحلب|للشارق|لدبي)|ذهاب (?:بس|فقط)|ذهاب وعود|فلاي شام|flycham|airarabia/i.test(t)||/طيران|طياره|تذكره|تيكت|رحلات|حجز.*رحله|flight|ticket|احمد/i.test(t);
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
