'use strict';
const {randomUUID}=require('node:crypto');
const P=require('./saudi-visa-policy');
const {SaudiVisaEngine,isComplaint}=require('./saudi-visa-engine');
const {conversationIntent,applicationReference}=require('./visa-conversation-intent');
const TTL=30*60000;
const PROMPT='أهلاً فيك 🌷 كيف بتحب نساعدك؟\n\n• طلب أو استفسار جديد\n• متابعة طلب حالي — منطلب منك رقم الطلب';
const social=t=>/^(?:شكرا.*|يسلمو.*|مشكور.*|تمام|اوكي|حاضر|ما بتقصر.*)$/.test(t);
const greeting=t=>/^(?:سلام|مرحبا|هلا|اهلا(?: وسهلا)?|السلام عليكم.*|هاي|hello|hi|صباح الخير|مساء الخير)[،,!؟?. 🌷]*$/i.test(t);
// Spoken menu labels select only the currently delivered menu. Keep the whole
// utterance bounded so questions, application facts and actions are not lost.
function spokenScopeChoice(text){
 const n=P.normalize(text).replace(/[،,!؟?. 🌷]+$/u,'').trim(),prefix='(?:(?:بدي|بدنا|اريد|عايز|عاوز|ابي|ابغي|حابب|حابه) )?';
 if(new RegExp('^'+prefix+'(?:استفسار جديد|طلب جديد|طلب او استفسار جديد|طلب / استفسار جديد)$','u').test(n))return'new';
 if(new RegExp('^'+prefix+'(?:متابعه (?:طلب حالي|الطلب الحالي|طلبي)|اتابع (?:طلبي|الطلب الحالي))$','u').test(n))return'followup';
 return null;
}
class VisaConversationScope {
 constructor({store,engine,now=Date.now}){Object.assign(this,{store,engine,now});store.data.visaConversationScopes||={};}
 current(id){const s=this.store.data.visaConversationScopes[id],c=this.engine.getCase(id);return s&&c&&s.caseId===c.id&&s.expiresAt>this.now()?s:null;}
 menu(id,text){const c=this.engine.getCase(id),s={token:randomUUID(),caseId:c.id,mode:'choice',pendingText:require('./saudi-visa-nlu').redactVisaText(String(text||'')).slice(0,3000),expiresAt:this.now()+TTL};this.store.data.visaConversationScopes[id]=s;this.store.save();return{handled:true,reply:PROMPT,scopeMenu:{token:s.token}};}
 bind(id,token,messageId){const s=this.current(id);if(s?.token===token&&s.mode==='choice'&&typeof messageId==='string'){s.messageId=messageId;this.store.save();}}
 async handle(id,text,{messages=[]}={}){
  const c=this.engine.getCase(id);if(!c)return{handled:false};
  const n=P.normalize(text),button=messages.find(m=>m.visaScopeChoice),jobs=this.engine.ownedApplications(id);
  let s=this.current(id);
  const spoken=!button&&s?.mode==='choice'&&s.messageId&&!messages.some(m=>m.media||m.payload||m.contextId&&m.contextId!==s.messageId||Object.keys(m).some(key=>/Choice$|Action$|Answer$|Confirmation$/.test(key)))?spokenScopeChoice(text):null;
  if(button||spoken){const choice=button?.visaScopeChoice||{action:spoken};if(button&&(!s||s.mode!=='choice'||s.token!==choice.token||!s.messageId||button.contextId!==s.messageId||!['new','followup'].includes(choice.action)))return this.menu(id,'');
   if(choice.action==='followup'){s.mode='followup';s.expiresAt=this.now()+TTL;delete s.pendingText;this.store.save();return{handled:true,reply:'أكيد 🌷 ابعت رقم الطلب الحالي حتى نتابع الملف الصحيح.'};}
   s.mode='inquiry';s.inquiry=this.engine.newCase();s.inquiry.greeted=true;this.store.save();
   const following=button?messages.filter(m=>!m.visaScopeChoice).map(m=>m.text||'').filter(Boolean).join('، '):'';
   text=following||s.pendingText||'';delete s.pendingText;
   if(!text||greeting(P.normalize(text)))return{handled:true,reply:'أكيد 🌷 شو الخدمة اللي حابب تستفسر عنها؟ وإذا سؤالك عن فيزا السعودية، شو جنسية المتقدم؟'};
  }
  // Never divert a complaint, cancellation, privacy request or explicit reference.
  const intent=conversationIntent(text),ref=applicationReference(text,{awaiting:s?.mode==='followup',known:jobs.map(j=>j.applicationReference)});
  if(isComplaint(text)||/احذف بياناتي|امسح بياناتي|شكوي|اشتك|الغاء|كنسل|استرداد|رجع.*(?:مصاري|فلوس)/.test(n))return{handled:false};
  if(ref){delete this.store.data.visaConversationScopes[id];this.store.save();return{handled:true,reply:(await this.engine.handle(id,'رقم الطلب '+ref,{messages:[]})).reply};}
  if(intent==='case_summary'&&s?.mode!=='inquiry')return{handled:false};
  if(jobs.length&&intent==='status'&&/طلبي|طلبنا|حاله الطلب|حاله المعامله|رقم الطلب|الطلب الحالي/.test(n)){this.store.data.visaConversationScopes[id]={token:randomUUID(),caseId:c.id,mode:'followup',expiresAt:this.now()+TTL};this.store.save();return{handled:true,reply:'أكيد 🌷 ابعت رقم الطلب الحالي حتى نتابع الملف الصحيح.'};}
  if(c.pendingNewApplication&&/^(?:نعم|اي|تمام|اوافق|موافق|اكد|نعم طلب جديد|لا|الغاء)[.! ]*$/.test(n)){delete this.store.data.visaConversationScopes[id];this.store.save();return{handled:false};}
  if(c.pendingNewApplication&&s?.mode==='inquiry'){delete c.pendingNewApplication;this.engine.save(id,c);}
  if(!button&&greeting(n)&&jobs.length)return this.menu(id,text);
  if(s?.mode==='inquiry'){
   const proceed=/(?:بدي|بدنا|اريد|حابب|ممكن)\s*(?:ثبت|اثبت|اقدم|قدم)|قدملي|كيف بثبت|كيف بدي ثبت/.test(P.normalize(text));
   if(proceed||messages.some(m=>m.media)){
    const facts=s.inquiry||{};c.pendingNewApplication={requestedAt:this.now(),facts:{applicantCount:facts.applicantCount,applicants:facts.applicants}};
    if(messages.some(m=>m.media)){this.store.data.pendingNewVisaMedia||={};const old=this.store.data.pendingNewVisaMedia[id];this.store.data.pendingNewVisaMedia[id]={sourceCaseId:c.id,createdAt:this.now(),messages:[...(old?.sourceCaseId===c.id?old.messages:[]),...messages.filter(m=>m.media)].slice(-20)};}
    const out=this.engine.conversationReply(id,c,text,'أكيد، فينا نبدأ طلب جديد مستقل مع الاحتفاظ بطلبك الحالي. تأكدلي: بدك نفتح طلب جديد؟');return{handled:true,reply:out.reply};
   }
   if(/فلسطين/.test(P.normalize(text))&&/سوري|سوريا/.test(P.normalize(text))&&!/وثيق|جواز/.test(P.normalize(text))){s.awaitingPalestinianDocument=true;this.store.save();return{handled:true,reply:'أكيد 🌷 للتأكد من المسار الصحيح: معه جواز سفر سوري، أو وثيقة سفر فلسطينية صادرة من سوريا؟'};}
   if(s.awaitingPalestinianDocument&&/سفر|سوري|سوريا/.test(P.normalize(text))&&!/وثيق|جواز/.test(P.normalize(text)))return{handled:true,reply:'تقصد وثيقة سفر فلسطينية صادرة من سوريا، أو جواز سفر سوري؟ هالتفصيل بيحدد طريقة التقديم المناسبة إلك 🌷'};
   if(s.awaitingPalestinianDocument&&/وثيق/.test(P.normalize(text))){text='فلسطيني معه وثيقة سفر '+text;s.awaitingPalestinianDocument=false;}else if(s.awaitingPalestinianDocument&&/جواز/.test(P.normalize(text)))s.awaitingPalestinianDocument=false;
   const previousIntervention=JSON.stringify(s.inquiry?.operatorIntervention||null),token=s.token,local={data:{visaCases:{[id]:s.inquiry}},save:()=>{}};
   const isolated=new SaudiVisaEngine({store:local,now:this.now,env:this.engine.env,privateConfig:this.engine.privateConfig,understand:this.engine.understand?async(...args)=>{const d=await this.engine.understand(...args);return d&&['status','existing_application'].includes(d.intent)?{...d,intent:'other'}:d;}:null});
   const out=await isolated.handle(id,text,{messages:[]});
   if(this.current(id)?.token!==token)return{handled:true,reply:null};
   s=this.current(id);s.inquiry=local.data.visaCases[id];s.expiresAt=this.now()+TTL;this.store.save();const intervention=s.inquiry?.operatorIntervention;return{handled:true,reply:out.reply,...(intervention&&JSON.stringify(intervention)!==previousIntervention?{intervention:{...intervention,question:require('./saudi-visa-nlu').redactVisaText(text).slice(0,500)},scopeToken:token}:{})};
  }
  if(s?.mode==='choice')return{handled:true,reply:PROMPT,scopeMenu:{token:s.token}};
  if(/استفسار جديد|سوال جديد|القائمه|خيارات/.test(P.normalize(text)))return this.menu(id,'');
  if(s?.mode==='followup')return this.menu(id,text);
  if(/استفسار جديد|سوال جديد|القائمه|خيارات/.test(n)||jobs.length&&!messages.some(m=>m.media)&&!social(n))return this.menu(id,text);
  return{handled:false};
 }
}
module.exports={VisaConversationScope,PROMPT};
