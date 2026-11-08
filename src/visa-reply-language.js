'use strict';
// Bounded display language only. This helper cannot change applicant facts,
// eligibility, quote amounts, payment state or the meaning of a chosen action.
const {normalize}=require('./saudi-visa-policy');
const {detectLanguageStyle}=require('./bilingual-intake');
const VISA_INTRO_EN='Welcome to REMAL GROUP. I’m Ismail, the virtual assistant specializing in Saudi visas.';
const REFUND_BENEFIT_EN='Visa fees are fully refundable in the event of an official refusal, under the service terms explained before payment. This office commitment applies to tourist and Umrah applications.';
const REFUND_REMINDER_EN='Visa fees are fully refundable in the event of an official refusal, subject to the service terms.';

function visaReplyLanguage(text,previous='ar'){
 const fallback=['ar','en'].includes(previous)?previous:'ar';
 const value=String(text||'').trim(),n=normalize(value);
 if(!n)return fallback;
 const preferences=[];
 // Language mentions alone (e.g. "English passport") are not preferences.
 const collect=(pattern,language)=>{
  for(const match of n.matchAll(pattern)){
   const before=n.slice(Math.max(0,match.index-35),match.index);
   if(/(?:\b(?:do not|don't|dont|never|not)|(?:^|\s)(?:لا|مو|مش|ما))\s*$/u.test(before))continue;
   preferences.push({at:match.index,language:language||(['english','انجليزي','انكليزي'].includes(match[1])?'en':'ar')});
  }
 };
 collect(/(?:^|[.!?,،]\s*)(?:please\s+)?(?:in\s+)?(english|arabic)(?:\s+please)?(?=$|[.!?,،])/gu);
 collect(/\b(?:reply|respond|answer|speak|write|continue)(?:\s+to\s+me)?(?:\s+only)?\s+in\s+(english|arabic)\b/gu);
 collect(/(?:^|\s)(?:رد|جاوب|احكي|اكتب|كمل)(?:\s+(?:علي|معي|لي))?\s+بال(انجليزي|انكليزي|عربي|عربيه)(?=$|[^\p{L}])/gu);
 collect(/^(?:بال)?(انجليزي|انكليزي|عربي|عربيه)(?:\s+(?:لو سمحت|من فضلك))?[.!؟?]*$/gu);
 if(preferences.length)return preferences.sort((a,b)=>a.at-b.at).at(-1).language;

 const style=detectLanguageStyle(value);
 if((style==='ar'||style==='mixed')&&/(?:^|[^\p{L}])(?:بدي|اريد|ابغي|اشتي|شو|كيف|انا|نحن|كم|وين|مرحبا|شكرا|مش|مو|لو سمحت)(?=$|[^\p{L}])/u.test(n))return 'ar';
 // Latin script is not proof of English: French/Turkish greetings, country
 // names, document labels, identifiers and short answers keep the prior choice.
 if(style==='en'&&!/\p{Script=Cyrillic}|\p{Script=Devanagari}|\p{Script=Han}|\p{Script=Thai}/u.test(value)&&
  /\b(?:hello|hi|thanks|thank you|please|how (?:much|long|can|do|does)|what (?:is|are|do|does)|where (?:is|are)|why (?:is|are|should|choose)|can (?:you|i|we)|i (?:am|want|need|have|paid|would|don['’]?t|do not)|my (?:passport|application|visa)|too expensive|think about it)\b|\bi['’]m\b/i.test(value))return 'en';
 return fallback;
}

function englishVisaQuestion(key,{repeated=false}={}){
 let question;
 if(key==='nationality')question='What nationality is shown on the applicant’s passport or travel document?';
 else if(key==='documentType')question='Does the applicant hold an ordinary passport or a travel document?';
 else if(key==='applicantCount')question='How many people will apply, including any children traveling with you?';
 else if(key==='documentIssuer')question='Which country issued the travel document?';
 else if(key==='scope')question='Would you like to add this person to the same group or open a separate application?';
 else{
  const match=String(key||'').match(/^(nationality|documentType|issuer)_(\d+)$/);
  if(!match||Number(match[2])>29)return null;
  const person=Number(match[2])+1;
  question=match[1]==='nationality'?`What nationality is shown on applicant ${person}’s passport or travel document?`:match[1]==='documentType'?`Does applicant ${person} hold an ordinary passport or a travel document?`:`Which country issued applicant ${person}’s travel document?`;
 }
 return (repeated?'To continue from the same point: ':'')+question;
}

function englishVisaClarification(c={}){
 const relative=c.pendingRelative?.awaiting,key=relative||c.lastQuestion||'';
 if(relative==='nationality')return 'I mean the nationality shown on the passport or travel document of the person you are asking about, not your own nationality. What nationality is written on that person’s document?';
 if(relative==='documentType')return 'I mean the travel document held by the person you are asking about. Is it an ordinary passport or a travel document?';
 if(relative==='documentIssuer')return 'I mean the country that issued that person’s travel document, which may differ from their nationality or residence. Which country is listed as the issuer?';
 if(relative==='scope')return 'I mean how you would like to organize this person’s application. '+englishVisaQuestion('scope');
 if(/^nationality(?:_\d+)?$/.test(key))return 'I mean the nationality shown on the applicant’s passport or travel document. The country of residence may be different. '+englishVisaQuestion(key);
 if(/^documentType(?:_\d+)?$/.test(key))return 'I mean the type of travel document itself: an ordinary passport or a travel document. This affects the application route. What document type is printed on its cover?';
 if(/^issuer_\d+$/.test(key))return 'I mean the country that issued the travel document, which may differ from the nationality or country of residence. '+(englishVisaQuestion(key)||'Which country is listed as the issuer?');
 if(key==='applicantCount')return 'I mean everyone who needs an application in this group, including any children traveling with you. How many people are there in total?';
 return 'Of course, we can go through it step by step. Which part would you like me to explain: the visa type, documents, fees or application follow-up?';
}

function englishVisaConsultationReply(intent,c={}, {nextQuestion=null,includeNextStep=true,refundShown=false}={}){
 if(intent==='hesitation')return 'Of course, take your time to review the details. When you are ready, we can continue from the same point. You can ask me about anything that is unclear.';
 if(intent==='clarify_question')return englishVisaClarification(c);
 if(intent==='approval_guarantee')return 'The relevant authority decides whether to approve or refuse the application. We cannot guarantee approval or an issuance date. Our role is to review your documents, explain the application route and requirements, and follow up according to the recorded status. Approval is separate from the refund terms for an official refusal.';
 if(intent==='trust_concern')return 'You are entitled to check before making any payment. You can review the company details and service terms, and we explain the fees and application route before you agree. Payments use the company’s approved methods, and receipt of funds is confirmed after verification.'+(includeNextStep?' What would you like to verify first?':'');
 if(intent==='compare_service')return 'Of course, you can compare offers. For an accurate comparison, let’s check the visa type, what the price includes, payment fees and refund terms, without assuming what another office offers.'+(includeNextStep?' What visa type and services are listed in the other offer?':'');
 if(intent!=='price_objection')return null;
 if(c.quote?.requiresReview)return 'I understand that cost matters. This case needs a pricing review before we can confirm the total. We will explain the approved amount before payment.';
 if(c.quote&&Number.isFinite(c.quote.total))return 'I understand that price is an important factor. Let’s compare the same visa type and included services, and clarify any payment-method fees before you decide. A bank transfer to the company’s account has no additional office commission.\n\n'+(refundShown?REFUND_REMINDER_EN:REFUND_BENEFIT_EN)+(includeNextStep?'\n\nWould you like a breakdown of the fees, or to compare another offer?':'');
 // Use the engine's next missing-field key; never translate or echo arbitrary
 // customer/model prose as a follow-up question.
 const missing=englishVisaQuestion(nextQuestion)||englishVisaQuestion(c.pendingRelative?.awaiting||c.lastQuestion);
 return 'I understand that you want a suitable, clear price. Let’s identify the right application route first so the comparison is accurate.'+(includeNextStep?'\n\n'+(missing||'Which visa type are you comparing?'):'');
}
module.exports={visaReplyLanguage,englishVisaQuestion,englishVisaClarification,englishVisaConsultationReply,VISA_INTRO_EN,REFUND_BENEFIT_EN,REFUND_REMINDER_EN};
