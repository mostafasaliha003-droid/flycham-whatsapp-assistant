'use strict';
// Bounded display language only. This helper cannot change applicant facts,
// eligibility, quote amounts, payment state or the meaning of a chosen action.
const {normalize}=require('./saudi-visa-policy');
const {detectLanguageStyle}=require('./bilingual-intake');
const VISA_INTRO_EN='Welcome to REMAL GROUP. I’m Ismail, the virtual assistant specializing in Saudi visas.';
const VISA_INTRO_FR='Bienvenue chez REMAL GROUP. Je suis Ismail, l’assistant virtuel spécialisé dans les visas pour l’Arabie saoudite.';
const REFUND_BENEFIT_EN='Visa fees are fully refundable in the event of an official refusal, under the service terms explained before payment. This office commitment applies to tourist and Umrah applications.';
const REFUND_REMINDER_EN='Visa fees are fully refundable in the event of an official refusal, subject to the service terms.';

function visaReplyLanguage(text,previous='ar'){
 const fallback=['ar','en','fr'].includes(previous)?previous:'ar';
 const value=String(text||'').trim(),n=normalize(value);
 if(!n)return fallback;
 const preferences=[];
 let negatedPreference=false;
 // Language mentions alone (e.g. "English passport") are not preferences.
 const collect=(pattern,language)=>{
  for(const match of n.matchAll(pattern)){
   const before=n.slice(Math.max(0,match.index-35),match.index);
   if(/(?:\b(?:do not|don't|dont|never|not|ne|pas|jamais)|(?:^|\s)(?:لا|مو|مش|ما))\s*$/u.test(before)){negatedPreference=true;continue;}
   preferences.push({at:match.index,language:language||(['english','anglais','انجليزي','انكليزي'].includes(match[1])?'en':['french','français','فرنسي','فرنسيه'].includes(match[1])?'fr':'ar')});
  }
 };
 collect(/(?:^|[.!?,،]\s*)(?:please\s+)?(?:in\s+)?(english|arabic|french)(?:\s+please)?(?=$|[.!?,،])/gu);
 collect(/\b(?:reply|respond|answer|speak|write|continue)(?:\s+to\s+me)?(?:\s+only)?\s+in\s+(english|arabic|french)\b/gu);
 collect(/(?:^|\s)(?:رد|جاوب|احكي|اكتب|كمل)(?:\s+(?:علي|معي|لي))?\s+بال(انجليزي|انكليزي|عربي|عربيه|فرنسي|فرنسيه)(?=$|[^\p{L}])/gu);
 collect(/^(?:بال)?(انجليزي|انكليزي|عربي|عربيه|فرنسي|فرنسيه)(?:\s+(?:لو سمحت|من فضلك))?[.!؟?]*$/gu);
 collect(/(?:^|[.!?,،]\s*)(?:en\s+)?(français|anglais|arabe)(?:\s+s['’]il\s+(?:vous|te)\s+pla[iî]t)?(?=$|[.!?,،])/gu);
 collect(/(?:^|\s)(?:réponds?|répondez|parle|parlez|écris|écrivez|continue|continuez)(?:\s+(?:moi|nous))?\s+en\s+(français|anglais|arabe)(?=$|[^\p{L}])/gu);
 if(preferences.length)return preferences.sort((a,b)=>a.at-b.at).at(-1).language;
 if(negatedPreference)return fallback;

 const style=detectLanguageStyle(value);
 if((style==='ar'||style==='mixed')&&/(?:^|[^\p{L}])(?:بدي|اريد|ابغي|اشتي|شو|كيف|انا|نحن|كم|وين|مرحبا|شكرا|مش|مو|لو سمحت)(?=$|[^\p{L}])/u.test(n))return 'ar';
 // A French sentence is useful evidence of display language; a greeting,
 // passport label or country name alone still preserves the previous choice.
 if(style==='en'&&!/\p{Script=Cyrillic}|\p{Script=Devanagari}|\p{Script=Han}|\p{Script=Thai}/u.test(value)&&
  /(?:^|[^\p{L}])(?:je\s+(?:veux|voudrais|souhaite|cherche|suis|dois|voyage|peux)|j['’](?:ai|aimerais)|nous\s+(?:voulons|souhaitons|sommes)|combien\s+(?:co[uû]te|de\s+temps)|quels?\s+(?:sont|documents|papiers)|quelles?\s+(?:est|sont)|pouvez[- ]vous|est[- ]ce|je\s+ne\s+comprends\s+pas|c['’]est\s+(?:trop\s+)?cher)(?=$|[^\p{L}])/iu.test(value))return 'fr';
 // Latin script is not proof of English: French/Turkish greetings, country
 // names, document labels, identifiers and short answers keep the prior choice.
 if(style==='en'&&!/\p{Script=Cyrillic}|\p{Script=Devanagari}|\p{Script=Han}|\p{Script=Thai}/u.test(value)&&
  /\b(?:hello|hi|thanks|thank you|please|how (?:much|long|can|do|does)|what (?:is|are|do|does)|where (?:is|are)|why (?:is|are|should|choose)|can (?:you|i|we)|i (?:am|want|need|have|paid|would|don['’]?t|do not)|my (?:passport|application|visa)|too expensive|think about it)\b|\bi['’]m\b/i.test(value))return 'en';
 return fallback;
}

function frenchVisaQuestion(key,{repeated=false}={}){
 let question;
 if(key==='nationality')question='Quelle nationalité figure sur le passeport ou le document de voyage du demandeur ?';
 else if(key==='documentType')question='Le demandeur possède-t-il un passeport ordinaire ou un document de voyage ?';
 else if(key==='applicantCount')question='Combien de personnes souhaitent déposer une demande, enfants compris ?';
 else if(key==='documentIssuer')question='Quel pays a délivré le document de voyage ?';
 else if(key==='scope')question='Souhaitez-vous ajouter cette personne au même groupe ou ouvrir une demande séparée ?';
 else{
  const match=String(key||'').match(/^(nationality|documentType|issuer)_(\d+)$/);
  if(!match||Number(match[2])>29)return null;
  const person=Number(match[2])+1;
  question=match[1]==='nationality'?`Quelle nationalité figure sur le passeport ou le document de voyage du demandeur ${person} ?`:match[1]==='documentType'?`Le demandeur ${person} possède-t-il un passeport ordinaire ou un document de voyage ?`:`Quel pays a délivré le document de voyage du demandeur ${person} ?`;
 }
 return (repeated?'Pour reprendre au même point : ':'')+question;
}

function frenchVisaClarification(c={}){
 const relative=c.pendingRelative?.awaiting,key=relative||c.lastQuestion||'';
 if(relative==='nationality')return 'Je parle de la nationalité inscrite sur le passeport ou le document de voyage de la personne dont vous parlez. Quelle nationalité figure sur son document ?';
 if(relative==='documentType')return 'Je parle du document détenu par cette personne. Possède-t-elle un passeport ordinaire ou un document de voyage ?';
 if(relative==='documentIssuer')return 'Je parle du pays qui a délivré le document de voyage de cette personne. Il peut être différent de sa nationalité ou de son pays de résidence. Quel pays figure comme pays de délivrance ?';
 if(relative==='scope')return 'Je parle de la manière d’organiser la demande de cette personne. '+frenchVisaQuestion('scope');
 if(/^nationality(?:_\d+)?$/.test(key))return 'Je parle de la nationalité inscrite sur le document du demandeur. Son pays de résidence peut être différent. '+(frenchVisaQuestion(key)||frenchVisaQuestion('nationality'));
 if(/^documentType(?:_\d+)?$/.test(key))return 'Je parle du type de document de voyage : il détermine le parcours de demande à vérifier. '+(frenchVisaQuestion(key)||frenchVisaQuestion('documentType'));
 if(key==='documentIssuer'||/^issuer_\d+$/.test(key))return 'Je parle du pays qui a délivré le document de voyage. Il peut être différent de la nationalité ou du pays de résidence. '+(frenchVisaQuestion(key)||frenchVisaQuestion('documentIssuer'));
 if(key==='applicantCount')return 'Je parle de toutes les personnes de ce groupe qui ont besoin d’une demande, y compris les enfants qui voyagent avec vous. Combien de personnes au total ?';
 if(/^age_\d+$/.test(key))return 'Je parle de l’âge du voyageur en années révolues pour vérifier les frais d’assurance. Quel âge a-t-il ?';
 return 'Bien sûr, nous pouvons reprendre étape par étape. Quel point souhaitez-vous préciser : le type de visa, les documents, les frais ou le suivi de la demande ?';
}

function frenchVisaConsultationReply(intent,c={}, {nextQuestion=null,includeNextStep=true}={}){
 if(intent==='hesitation')return 'Bien sûr, prenez le temps de consulter les détails. Quand vous serez prêt, nous pourrons reprendre au même point. Vous pouvez me demander de préciser ce qui reste flou.';
 if(intent==='clarify_question')return frenchVisaClarification(c);
 if(intent==='approval_guarantee')return 'L’autorité compétente décide de l’acceptation ou du refus. Nous ne pouvons garantir ni l’approbation ni une date de délivrance. Notre rôle est de vérifier vos documents, de vous expliquer le parcours et les pièces nécessaires, puis de suivre la demande selon son état enregistré. Les conditions de remboursement doivent être examinées séparément.';
 if(intent==='trust_concern')return 'Vous avez raison de vérifier les informations avant de payer. Vous pouvez consulter les coordonnées de la société et les conditions du service. Nous précisons les frais et le parcours de demande avant votre accord. La réception d’un paiement est confirmée après vérification.'+(includeNextStep?' Quel point souhaitez-vous vérifier en premier ?':'');
 if(intent==='compare_service')return 'Bien sûr, vous pouvez comparer les offres. Comparons le même type de visa, les services inclus, les frais de paiement et les conditions de remboursement, sans supposer ce qu’une autre agence propose.'+(includeNextStep?' Quel type de visa et quels services figurent dans l’autre offre ?':'');
 if(intent!=='price_objection')return null;
 if(c.quote?.requiresReview)return 'Je comprends que le coût compte pour vous. Le tarif de ce dossier doit être vérifié avant de confirmer le total. Le montant validé sera précisé avant le paiement.';
 // Policy terms and amounts remain in the approved quote, not a second
 // localized source of refund rules, payment fees or discounts.
 if(c.quote&&Number.isFinite(c.quote.total))return 'Je comprends que le prix soit important. Comparons le même type de visa et les services inclus. Nous pouvons préciser le détail du devis, les éventuels frais de paiement et les conditions du service avant votre décision.'+(includeNextStep?' Souhaitez-vous détailler les frais ou comparer une autre offre ?':'');
 const missing=frenchVisaQuestion(nextQuestion)||frenchVisaQuestion(c.pendingRelative?.awaiting||c.lastQuestion);
 return 'Je comprends que vous souhaitiez un coût adapté et clair. Identifions d’abord le parcours de demande pour comparer les offres sur la même base.'+(includeNextStep?'\n\n'+(missing||'Quel type de visa souhaitez-vous comparer ?'):'');
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
 if(/^age_\d+$/.test(key))return 'I mean the traveler’s age in completed years so we can check the insurance charge. How old is the traveler?';
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
module.exports={visaReplyLanguage,englishVisaQuestion,englishVisaClarification,englishVisaConsultationReply,VISA_INTRO_EN,REFUND_BENEFIT_EN,REFUND_REMINDER_EN,frenchVisaQuestion,frenchVisaClarification,frenchVisaConsultationReply,VISA_INTRO_FR};
