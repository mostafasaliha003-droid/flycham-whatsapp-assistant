'use strict';
const {normalize}=require('./saudi-visa-policy');
const referenceKey=value=>String(value||'').toUpperCase().replace(/^E(?=\d)/,'');
function applicationReference(text,{awaiting=false,known=[]}={}){
 const t=normalize(String(text||'')).toUpperCase();
 const labelled=t.match(/(?:رقم\s*(?:الطلب|طلبي|المعامله)|طلب\s*رقم|APPLICATION\s*(?:NO\.?|NUMBER|REFERENCE))\s*[:#-]?\s*(E?\d{7,12})(?!\d)/);
 if(labelled)return referenceKey(labelled[1]);
 const bare=t.match(/^\s*(E?\d{7,12})\s*[.!؟?]*$/);
 if(bare&&(awaiting||known.some(value=>referenceKey(value)===referenceKey(bare[1]))))return referenceKey(bare[1]);
 const inline=[...t.matchAll(/(?:^|[^\p{L}\p{N}])(E?\d{7,12})(?=$|[^\p{L}\p{N}])/gu)].map(m=>referenceKey(m[1]));
 const matched=inline.find(ref=>known.some(value=>referenceKey(value)===ref));
 if(matched)return matched;
 // An awaiting followup can still receive one unambiguous, explicitly cued reference.
 if(inline.length===1&&awaiting&&/(?:رقم|طلبي|الطلب|تفضل|هاد|هذا|مرجع|بخصوص)/.test(t))return inline[0];
 return null;
}
function conversationIntent(text){
 const t=normalize(String(text||''));
 if(/(?:لا|مو|مش|ما بدي)\s+(?:طلب\s+جديد|اقدم\s+(?:طلب\s+)?جديد)/.test(t))return 'status';
 if(/(?:طلب|تقديم|معامله|فيزا|تاشيره)\s+(?:تاني|ثاني|جديد|تانيه|ثانيه|جديده)|\bnew (?:application|visa|request)\b/i.test(t))return 'new_application';
 if(/(?:رقم\s*(?:الطلب|طلبي|المعامله)|طلب\s*رقم|حاله\s*(?:الطلب|المعامله)|(?:طلعت|صدرت)\s*(?:الفيزا|التاشيره)|(?:شو|ايش)\s+صار\s*(?:بالطلب|بطلبي|مع الطلب)?|وين\s+(?:وصل|وصلتوا|وصلتو|وصلت|صار)\s*(?:طلبي|الطلب|المعامله)?|متابعه\s*(?:طلب|طلبي|معامل)|بدي\s+تابع|\b(?:application status|track my application)\b)/i.test(t)&&!/اوراق|صور|جواز|هويه|مستند|مرفق/.test(t))return 'status';
 return null;
}
module.exports={referenceKey,applicationReference,conversationIntent};
