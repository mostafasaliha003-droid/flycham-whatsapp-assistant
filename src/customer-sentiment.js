'use strict';
// Deterministic tone signals only. They change the opening sentence and staff
// priority, never travel facts, prices, payment state or eligibility.
const {normalize}=require('./saudi-visa-policy');
const FRUSTRATED=/صرلي\s*(?:ساعه|ساعتين|يوم|يومين|زمان|كتير|فتره)|(?:ليش|ليه|لماذا)\s*(?:ما|مش|مو)?\s*(?:حدا|احد|حد)?\s*(?:رد|ردي|يرد|بترد|ترد|رديتو|رديتوا|رديتم)|ما\s*(?:حدا|احد|حد)\s*(?:رد|يرد|عم يرد)|ما\s*(?:عم|حدا عم)\s*تردو|زهقت|طفشت|مليت|تعبتوني|تعبت معكم|كل شوي نفس السؤال|عم تعيد(?:ولي)?\s*نفس|سالتني\s*(?:هالسؤال|نفس السؤال)|قلتلك\s*(?:مليون|الف|كذا)\s*مره|خدمه\s*(?:سيئه|زفت|سيئة)|تاخرتو|تاخرتوا|تاخرتم|وين الرد|ولا رد/;
const URGENT=/(?:سفري|سفرتي|رحلتي|طيارتي|موعدي)\s*(?:بكرا|بكره|اليوم|الليله|بعد بكرا|بعد بكره|خلال يوم|خلال يومين|الاسبوع هاد|هالاسبوع)|(?:ضروري|مستعجل|مستعجله|عاجل|طارئ|طارئه|بسرعه لو سمحت|اسرع وقت)(?=$|[\s،,.!؟?])|حاله\s*(?:وفاه|طارئه|مرضيه)|(?:توفي|توفيت|متوفي)|عزاء/;
const ANXIOUS=/خايف|خايفه|قلقان|قلقانه|متوتر|متوتره|مضمون|مضمونه|بتنرفض|رح تنرفض|ممكن ترفض|اذا رفضو|اذا انرفضت|بخاف/;
function detectSentiment(text){
 const n=normalize(text);
 if(!n||n.length>3000)return {frustrated:false,urgent:false,anxious:false,priority:'normal'};
 const frustrated=FRUSTRATED.test(n),urgent=URGENT.test(n),anxious=!frustrated&&ANXIOUS.test(n);
 return {frustrated,urgent,anxious,priority:frustrated||urgent?'urgent':'normal'};
}
const LEADS={
 frustrated:'حقك علينا، وبعتذر عن الانتظار 🌷 خليني أخدمك فوراً ومن نفس النقطة بدون ما تعيد شي.',
 urgent:'واضح إن الموضوع مستعجل، ومنعطيه أولوية الآن 🌷',
 frustrated_urgent:'حقك علينا، ومفهوم إن الوقت ضيق 🌷 أعطيت طلبك أولوية ومنكمل فوراً من نفس النقطة.',
 anxious:'طمّن بالك 🌷 منمشي معك خطوة بخطوة وبوضوح كامل.'
};
function empathyLead(sentiment){
 if(!sentiment)return null;
 if(sentiment.frustrated&&sentiment.urgent)return LEADS.frustrated_urgent;
 if(sentiment.frustrated)return LEADS.frustrated;
 if(sentiment.urgent)return LEADS.urgent;
 if(sentiment.anxious)return LEADS.anxious;
 return null;
}
// Adds one empathy sentence once. Complaint/escalation copy already carries its
// own acknowledgement, and a reply never receives two openings.
function withEmpathy(reply,sentiment,{complaint=false}={}){
 if(typeof reply!=='string'||!reply.trim()||complaint)return reply;
 const lead=empathyLead(sentiment);if(!lead)return reply;
 if(/^(?:حقك علينا|بعتذر|نعتذر|منفهم انزعاجك|طمّن بالك|واضح إن الموضوع مستعجل)/.test(reply.trim()))return reply;
 return lead+'\n\n'+reply;
}
module.exports={detectSentiment,empathyLead,withEmpathy};
