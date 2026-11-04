'use strict';
// One-tap satisfaction rating for customer-facing assistants (Ahmed, Ismail).
// Raad never talks to customers, so it never requests a rating.
const {validCustomer}=require('./conversation-journal');
const {normalize}=require('./saudi-visa-policy');
const WINDOW_MS=48*3600000,COOLDOWN_MS=30*24*3600000;
const NAMES={flight:'أحمد',saudi_visa:'إسماعيل'};
function ratings(store){store.data.serviceRatings||={pending:{},history:[]};return store.data.serviceRatings;}
function requestRating(store,customer,{service,reference=null,now=Date.now()}={}){
 if(!NAMES[service]||!validCustomer(customer))return null;
 const r=ratings(store);
 if(r.pending[customer]&&now-r.pending[customer].requestedAt<COOLDOWN_MS)return null;
 if(r.history.some(h=>h.customer===customer&&h.service===service&&now-h.at<COOLDOWN_MS))return null;
 r.pending[customer]={service,reference:typeof reference==='string'?reference.slice(0,80):null,requestedAt:now,expiresAt:now+WINDOW_MS};
 store.save?.();
 return `يسعدنا إننا خدمناك 🌷 كيف كانت تجربتك مع ${NAMES[service]} ومجموعة الرمال؟\nرد برقم من 1 لـ 5 (5 = ممتازة) ⭐ رأيك بيفرق معنا كتير.`;
}
function parseScore(text){
 const raw=String(text||'').trim();
 const stars=(raw.match(/⭐/g)||[]).length;
 if(stars>=1&&stars<=5&&/^[⭐\s]+$/.test(raw))return stars;
 const n=normalize(raw).replace(/[.!،,؟?🌷\s]+$/g,'').trim();
 const m=n.match(/^(?:تقييمي\s*)?([1-5])(?:\s*(?:\/\s*5|من\s*5))?$/);
 return m?Number(m[1]):null;
}
function readRating(store,customer,text,{now=Date.now()}={}){
 if(!validCustomer(customer))return {handled:false};
 const r=ratings(store),pending=r.pending[customer];
 if(!pending)return {handled:false};
 if(pending.expiresAt<=now){delete r.pending[customer];r.history.push({customer,service:pending.service,reference:pending.reference,score:null,skipped:true,at:pending.requestedAt});r.history=r.history.slice(-2000);store.save?.();return {handled:false};}
 const score=parseScore(text);
 if(!score){
  // The customer moved on: never let a later numeric answer (e.g. applicant
  // count «2») be captured as a rating. The skip still respects the cooldown.
  delete r.pending[customer];r.history.push({customer,service:pending.service,reference:pending.reference,score:null,skipped:true,at:now});r.history=r.history.slice(-2000);store.save?.();
  return {handled:false};
 }
 delete r.pending[customer];
 r.history.push({customer,service:pending.service,reference:pending.reference,score,at:now});r.history=r.history.slice(-2000);
 store.save?.();
 if(score>=4)return {handled:true,score,service:pending.service,lowScore:false,reply:'شكراً كتير لتقييمك الحلو 🌷 وجودك معنا بيشرفنا، ونحنا بالخدمة بأي وقت.'};
 if(score===3)return {handled:true,score,service:pending.service,lowScore:false,reply:'شكراً لتقييمك 🌷 بيهمنا نوصل معك للأفضل؛ إذا حابب تخبرنا شو الشي اللي كان ممكن نعمله أحسن، اكتبلنا وبيوصل مباشرة للمسؤول.'};
 return {handled:true,score,service:pending.service,lowScore:true,reply:'بعتذر منك إن التجربة ما كانت بالمستوى اللي بتستاهله 🌷 وصل تقييمك مباشرة للمسؤول، ورح يتواصل معك شخصياً ليسمع منك ويصحح أي تقصير.'};
}
function approvedVisaRating(store,customer,options={}){
 const c=store.data.visaCases?.[customer],d=c?.staffVerification?.decision;
 if(d?.value!=='approved'||d.actor!=='staff'||d.caseSignature!==require('./visa-case-signature').visaCaseSignature(c)||!require('./visa-case-signature').currentVisaEvidence(c).submission)return null;
 return requestRating(store,customer,{...options,service:'saudi_visa',reference:d.reference});
}
async function sendRating(store,customer,{service,reference,send,guard=()=>true,now=Date.now()}={}){
 if(typeof send!=='function'||!guard())return false;
 const prompt=service==='saudi_visa'?approvedVisaRating(store,customer,{now}):requestRating(store,customer,{service,reference,now});
 if(!prompt)return false;
 const pending=ratings(store).pending[customer];
 try{if(!guard())throw Error('RATING_PAUSED');const result=await send(customer,prompt);if(result?.dryRun||!result?.messages?.[0]?.id)throw Error('RATING_NOT_ACCEPTED');return true;}
 catch{
  // An unseen/uncertain prompt must not consume the next numeric trip answer.
  const r=ratings(store);if(r.pending[customer]===pending){delete r.pending[customer];r.history.push({customer,service:pending.service,reference:pending.reference,score:null,skipped:true,deliveryUnconfirmed:true,at:now});r.history=r.history.slice(-2000);store.save?.();}
  return false;
 }
}
function ratingSummary(store){
 const h=ratings(store).history,by={};
 for(const item of h){if(!item.score)continue;by[item.service]||={count:0,total:0};by[item.service].count++;by[item.service].total+=item.score;}
 return Object.fromEntries(Object.entries(by).map(([k,v])=>[k,{count:v.count,average:Math.round(v.total/v.count*100)/100}]));
}
module.exports={sendRating,approvedVisaRating,requestRating,readRating,parseScore,ratingSummary};
