'use strict';
const {normalize}=require('./arabic-dates');
function visaEnabled(env=process.env){return env.SAUDI_VISA_ENABLED!=='false';}
function activeService(store,id){return store.data.serviceSessions?.[id]?.service||'flight';}
function incomingRevision(store,id){return store.data.serviceSessions?.[id]?.revision||0;}
function noteIncoming(store,id){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{};s.revision=(s.revision||0)+1;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();return s.revision;}
function setService(store,id,service){store.data.serviceSessions||={};const s=store.data.serviceSessions[id]||{revision:0};s.service=service;s.awaitingService=false;s.at=Date.now();store.data.serviceSessions[id]=s;store.save();}
function routeService(store,id,text,{env=process.env,media=false,hasFlight=false}={}){
 if(!visaEnabled(env))return {service:'flight'};
 const t=normalize(String(text||'')),s=store.data.serviceSessions?.[id];
 const visa=/فيزا|فيزه|تاشير|عمره|عمرة|نسك|اسماعيل|ismail|saudi visa|umrah/i.test(t);
 const flight=/(?:من|مغادر).{0,30}(?:دبي|الشارق[هة]|ابوظبي|ابو ظبي|دمشق|الشام|حلب|سوريا).{0,15}(?:الي|الى|لل|لدمشق|للشام|لحلب|للشارق|لدبي)|ذهاب (?:بس|فقط)|ذهاب وعود|فلاي شام|flycham|airarabia/i.test(t)||/طيران|طياره|تذكره|تيكت|رحلات|حجز.*رحله|flight|ticket|احمد/i.test(t);
 if(visa&&flight&&!s?.service)return {service:'choose',reply:'أهلاً فيك بمجموعة الرمال 🌷 فينا نساعدك بالتأشيرة والطيران. بتحب نبدأ بفيزا السعودية مع إسماعيل أو بالطيران مع أحمد؟'};
 if(visa&&!flight){setService(store,id,'saudi_visa');return{service:'saudi_visa'};}
 if(flight&&!visa){setService(store,id,'flight');return{service:'flight'};}
 if(s?.service)return{service:s.service};
 if(hasFlight){setService(store,id,'flight');return{service:'flight'};}
 if(media)return{service:'choose',reply:'وصل المرفق، شكراً إلك. هل هو لمعاملة فيزا السعودية أو لطلب طيران؟ حتى نوجّه الأوراق للقسم المناسب.'};
 store.data.serviceSessions||={};store.data.serviceSessions[id]={...(s||{}),awaitingService:true,at:Date.now()};store.save();
 return{service:'choose',reply:'أهلاً وسهلاً فيك بمجموعة الرمال 🌷 كيف فينا نساعدك: فيزا السعودية مع إسماعيل أو حجز طيران مع أحمد؟'};
}
function isComplaint(text){const t=normalize(text||'');if(/(?:قالوا|قالولي|حكولي|سمعت|بيقولوا|في ناس).{0,25}(?:نصاب|حرامي)|هل.*(?:نصاب|حرامي)|شو.*(?:نصاب|حرامي)/.test(t))return false;
 return /شكوي|شكوى/.test(t)||(/قدمت|دافع|دفعت|حولت|معاملتي|طلبت|مصاري|فلوسي|رسوم/.test(t)&&/نصاب|حرامي|نصبت|ما ?رجعت|ما ?رجع|ما ?طلعت|ما ?صدرت|تاخر|تأخر|استرد|ارجاع|رجعولي/.test(t))||/(?:انتو|انتم|انك[من]|شركتكم).{0,15}(?:نصاب|حرامي|حرميه)/.test(t);
}
module.exports={visaEnabled,activeService,incomingRevision,noteIncoming,setService,routeService,isComplaint};
