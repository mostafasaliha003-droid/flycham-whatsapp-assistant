'use strict';
const {normalize}=require('./saudi-visa-policy');
const {classifyVisaTimingInquiry}=require('./visa-service-copy');

// A bounded question recognizer, not authorization or a replacement for NLU.
// Every substantive clause must match. Mixed actions, facts, quoted text and
// unsupported questions stay with the engine's existing contextual handling.
const INFORMATION=new Set(['price','processing_time','documents','payment','refund','address','bank','courier','visa_duration']);
const SAFE_SEMANTIC=new Set([...INFORMATION,'requirements','payment_options','bank_details','other','greeting','apply']);
const AR_Q='(?:كم|قديش|اديش|شقد|بكام|بكم|شو|وش|ايش|اش|شنو|ايه|كيف|ازاي|شلون|وين|فين|اين|متي|ايمت|امتي|هل|ما هي|ما هو)';
const AR_N='(?:السعر|التكلفه|الرسوم|الاوراق|الورق|المستندات|طرق الدفع|وسائل الدفع|صلاحيه|مده|عنوان|موقع|شروط الاسترداد)';
const AR_TIMING='(?:بتاخد|تاخد|بتطلع|تطلع|بتلحق|بلحق|الحق)';
const EN_Q='(?:how|what|which|where|when|will|is|are|can|do|does|price|cost|documents|payment|validity|processing|courier|bank)';
const FR_Q='(?:combien|quel|quelle|quels|quelles|comment|ou|est-ce|est ce|sera-t-il|pourrai-je|le visa|je peux|le prix|les documents|les frais|la duree|la validite)';
const CLAUSE_JOIN=new RegExp('\\s+(?:و(?='+AR_Q+'|'+AR_N+'|'+AR_TIMING+')|و\\s+(?='+AR_Q+'|'+AR_N+'|'+AR_TIMING+')|(?:and|also)\\s+(?='+EN_Q+'\\b)|et\\s+(?='+FR_Q+'\\b))','gu');
const CLAUSE_PREFIX=new RegExp('^(?:و\\s*(?='+AR_Q+'|'+AR_N+'|'+AR_TIMING+')|and |also |et )','u');
const APPLY_INTRO=/^(?:بدي اقدم|بدي قدم|عايز اقدم|عاوز اقدم|ابي اقدم|ابغي اقدم|اريد اقدم|i want to apply|i would like to apply|je voudrais demander un visa)\s*[,،؛;:]\s*/u;
const AR_DEADLINE_TARGET='(?:اليوم|بكرا|بكره|غدا|الجمعه|الخميس|السبت|الاحد|الاثنين|الاتنين|الثلاثاء|التلاتا|الاربعاء|الاربعا|سفري|السفر|رحلتي|موعد سفري|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|\\d{4}-\\d{1,2}-\\d{1,2})';
const DEADLINE_CLAUSES=[
 new RegExp('^(?:(?:هل|ممكن) )?(?:(?:الفيزا|التاشيره) )?(?:(?:بتطلع|تطلع|بتصدر|تصدر|بتجهز|تجهز)|(?:بتلحق|بلحق|الحق|بنلحق|تلحق)(?: (?:اسافر|سافر|نسافر|السفر))?) (?:(?:قبل|بحلول|يوم|ليوم|لحد) )?'+AR_DEADLINE_TARGET+'$','u'),
 /^(?:will (?:it|the visa|my visa) (?:be (?:ready|issued)|arrive)|can i (?:travel|leave)|can (?:it|the visa) be ready) (?:before|by|on|in time for) (?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|my (?:trip|flight|travel date)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})$/u,
 /^(?:(?:est-ce que )?(?:le visa sera pret|je peux partir)|sera-t-il pret|pourrai-je partir) (?:(?:avant|pour|d['’]ici) )?(?:demain|aujourd['’]hui|jeudi|vendredi|samedi|dimanche|lundi|mardi|mercredi|mon (?:voyage|depart)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/u
];
const DECORATION=/[🌷🙏\uFE0F]/gu;
const SOCIAL=/^(?:مرحبا|هلا|اهلا|السلام عليكم|شكرا|لو سمحت|من فضلك|بليز|hello|hi|thanks|thank you|please|bonjour|salut|merci|s['’]il vous plait)$/u;

// Exact clause grammars keep payment fees separate from the visa quote, and
// passport validity / current-case status separate from visa duration / timing.
const RULES={
 price:[
  /^(?:(?:كم|قديش|اديش|شقد|شو|وش|ايش|ايه|شنو) (?:السعر|التكلفه|الرسوم|سعر(?: الفيزا| التاشيره)?|رسوم(?: الفيزا| التاشيره)?)|(?:بكم|بكام|كام)(?: (?:الفيزا|التاشيره))?|(?:الفيزا|التاشيره) (?:بكم|بكام|بقديش|بشقد)|(?:كم|قديش|شقد) (?:بتكلف|تكلف|تكلفه) (?:الفيزا|التاشيره))(?: (?:للفرد|للشخص|عندكم|نفسها))?$/u,
  /^(?:how much(?: (?:is|does) (?:the )?visa(?: cost)?)?|what(?: is|'s) (?:the )?(?:price|cost|visa fee)|how much are (?:the )?visa fees)$/u,
  /^(?:combien(?: (?:ca coute|coute (?:le )?visa))?|quel est le (?:prix|cout)(?: du visa)?|quels sont les frais (?:de|du) visa)$/u
 ],
 processing_time:[
  /^(?:(?:كم|قديش|اديش|شقد) (?:يوم|وقت|مده)(?: (?:بتاخد|تاخد|تحتاج|يحتاج|يبغالها|تشتي))?(?: لتطلع)?|(?:كم|قديش|شقد) (?:بتاخد|تاخد|تحتاج|يبغالها|تشتي)(?: وقت)?|(?:متي|ايمت|امتي) (?:بتطلع|تطلع|بتصدر|تصدر)(?: الفيزا| التاشيره)?|(?:كم|قديش|شقد) مده (?:المعالجه|الاجراءات|الاصدار)|(?:بتاخد|تاخد) وقت قد ايه|قد ايه بتاخد وقت|قديش بتطول)$/u,
  /^(?:how long(?: (?:does|will) (?:it|the visa|processing) take)?|how many (?:working |business )?days(?: (?:does it take|for processing))?|what(?: is|'s) (?:the )?processing time|when (?:will|does) (?:the )?visa (?:come out|arrive))$/u,
  /^(?:combien de (?:temps|jours)(?: (?:pour le traitement|ca prend|cela prend))?|quel est le delai(?: de traitement)?|quelle est la duree du traitement|quand (?:le visa (?:sera-t-il|sera t il) pret|sort le visa))$/u
 ],
 documents:[
  /^(?:(?:شو|وش|ايش|اش|شنو|ايه) (?:الاوراق|المستندات|الوثائق)(?: المطلوبه)?|(?:شو|وش|ايش|ايه) (?:المطلوب|يلزم|لازم)(?: للتقديم)?|(?:ما هي|ما) (?:الاوراق|المستندات) المطلوبه|(?:الاوراق|المستندات) المطلوبه|ايه (?:المطلوب من اوراق|الورق المطلوب)|(?:شو|وش|ايش) (?:الاوراق|المستندات) (?:اللي|الي) (?:بدكم|تحتاجون)|(?:كيف|ازاي) (?:اقدم|بقدم)(?: (?:الطلب|للفيزا))?)$/u,
  /^(?:what (?:documents|papers)(?: (?:are (?:required|needed)|do (?:you need|i need)))?|which documents(?: are required)?|what do i need to (?:apply|submit)|what are (?:the )?(?:required documents|document requirements))$/u,
  /^(?:quels (?:documents|papiers)(?: (?:faut-il|faut il|sont (?:necessaires|requis)))?|quelles (?:pieces|sont les pieces)(?: (?:a fournir|necessaires))?|de quels documents ai-je besoin)$/u
 ],
 payment:[
  /^(?:(?:كيف|ازاي|شلون) (?:ادفع|الدفع)|(?:شو|وش|ايش|ايه|ما هي) (?:طرق|وسائل|خيارات|طريقه) الدفع|(?:طرق|وسائل|خيارات|طريقه) الدفع|(?:كم|قديش|شقد|كام) (?:رسوم|عموله) (?:تابي|رابط الدفع|التحويل البنكي)|(?:هل )?(?:عندكم|في|فيه) تابي|(?:هل )?(?:اقدر|بقدر|ممكن) ادفع (?:بتابي|برابط|تحويل بنكي)|(?:شو|ايه) الفرق بين التحويل البنكي وتابي)$/u,
  /^(?:how (?:can|do) i pay|what (?:are (?:the |your )?)?payment (?:methods|options)|do you (?:accept|offer) (?:tabby|bank transfer)|can i pay (?:by bank transfer|with tabby|via a payment link)|how much (?:is|are) (?:the )?(?:tabby|payment[- ]link|bank transfer) (?:fee|fees)|what(?: is|'s) (?:the )?(?:tabby|payment[- ]link) fee)$/u,
  /^(?:comment (?:payer|puis-je payer)|quels sont (?:les|vos) (?:moyens|modes) de paiement|acceptez-vous (?:tabby|le virement bancaire)|puis-je payer (?:par virement|avec tabby)|quels sont les frais (?:de tabby|du lien de paiement|de virement))$/u
 ],
 refund:[
  /^(?:(?:شو|وش|ايش|ايه|ما هي) (?:شروط|سياسه) (?:الاسترداد|استرداد الرسوم)|(?:هل )?(?:الرسوم|رسوم الفيزا|رسوم التاشيره) (?:مسترده|بترجع|بترجعوا)(?: (?:في حال|بحال|عند) الرفض)?|(?:اذا|لو) (?:انرفضت|ترفضت|اترفضت|رفضوا|انرفضت الفيزا|ترفضت الفيزا) (?:بترجع|بترجعوا|ترجع|بترجعولي) (?:الرسوم|المصاري|الفلوس)|(?:هل )?(?:بترجعوا|بترجع|ترجع) (?:الرسوم|المصاري|الفلوس) (?:اذا|لو) (?:انرفضت|ترفضت|رفضوا)|(?:هل )?(?:التامين|رسوم التامين) (?:مسترد|مسترده|بترجع))$/u,
  /^(?:what (?:is|'s) (?:the |your )?refund policy|are (?:the )?(?:visa )?fees refundable(?: (?:if refused|in case of refusal))?|(?:if (?:the )?visa is refused|if refused) (?:are (?:the )?fees refundable|do i get (?:my money|the fees) back)|is (?:the )?insurance refundable)$/u,
  /^(?:quelle est (?:la|votre) politique de remboursement|les frais(?: de visa)? sont-ils remboursables(?: en cas de refus)?|est-ce que les frais sont rembourses en cas de refus|l['’]assurance est-elle remboursable)$/u
 ],
 address:[
  /^(?:(?:وين|فين|اين) (?:مكتبكم|المكتب|مكانكم|موقعكم)|(?:شو|وش|ايش|ايه|ما هو) (?:عنوانكم|عنوان المكتب|موقع المكتب)|(?:كيف|ازاي) (?:اوصل|اصل) (?:للمكتب|لمكتبكم))$/u,
  /^(?:where (?:is|'s) (?:your|the) office|what (?:is|'s) your (?:address|office address)|how do i get to your office)$/u,
  /^(?:ou (?:est|se trouve) votre (?:bureau|agence)|quelle est votre adresse|comment aller a votre (?:bureau|agence))$/u
 ],
 bank:[
  /^(?:(?:شو|وش|ايش|ايه|ما هي) (?:بيانات|تفاصيل) (?:حسابكم البنكي|الحساب البنكي)|(?:شو|وش|ايش|ما هو) (?:الايبان|رقم الايبان|حسابكم البنكي))$/u,
  /^(?:what (?:are|is) your (?:bank details|bank account details|iban)|which bank account (?:do|should) i transfer to)$/u,
  /^(?:quelles sont vos coordonnees bancaires|quel est votre iban)$/u
 ],
 courier:[
  /^(?:(?:كم|قديش|شقد|كام) (?:رسوم|تكلفه|سعر) (?:زاجل|التوصيل|استلام الاصول)|(?:هل )?(?:عندكم|في|فيه) (?:خدمه توصيل|زاجل|خدمه استلام الاصول)|(?:شو|ايش|ما هي) مناطق (?:التوصيل|خدمه زاجل))$/u,
  /^(?:how much (?:is|does) (?:the )?courier(?: (?:cost|fee))?|do you (?:offer|have) (?:courier|document collection)(?: service)?|which areas does (?:the )?courier cover)$/u,
  /^(?:combien coute (?:la livraison|le coursier)|proposez-vous un service de livraison|quelles zones couvre le service de livraison)$/u
 ],
 visa_duration:[
  /^(?:(?:كم|قديش|شقد|ما هي) (?:مده|صلاحيه) (?:الفيزا|التاشيره|الاقامه)|(?:كم|قديش) مده صلاحيه (?:الفيزا|التاشيره)|(?:كم|قديش) (?:يوم|شهر) (?:صلاحيه الفيزا|صلاحيه التاشيره|اقدر اقعد|بقدر اقعد|الاقامه)(?: بالسعوديه)?|(?:كم|قديش) اقدر اقعد بالسعوديه|(?:كم|قديش) (?:دخول|مره ادخل)(?: بالسعوديه)?|(?:هل )?(?:الفيزا|التاشيره) (?:سفره واحده|متعدده الدخول|دخول متعدد))$/u,
  /^(?:how long (?:is (?:the )?visa valid(?: for)?|can i stay(?: in saudi arabia)?)|what (?:is|'s) (?:the )?(?:visa validity|length of stay)|how many (?:entries|days can i stay)|is (?:the )?visa (?:single.entry|multiple.entry))$/u,
  /^(?:quelle est la (?:validite du visa|duree du sejour)|combien de temps (?:le visa est-il valable|puis-je rester)(?: en arabie saoudite)?|combien d['’]entrees(?: sont autorisees)?|le visa est-il a entrees multiples)$/u
 ]
};
const FRAGMENTS={price:/^(?:السعر|التكلفه|price|cost|le prix|le cout)$/u,processing_time:/^(?:مده المعالجه|processing time|le delai|le delai de traitement)$/u,documents:/^(?:الاوراق|المستندات|documents|required documents|les documents)$/u,payment:/^(?:طرق الدفع|وسائل الدفع|payment options|payment methods|les moyens de paiement)$/u,visa_duration:/^(?:صلاحيه الفيزا|صلاحيه التاشيره|مده الاقامه|visa validity|length of stay|la validite du visa|la duree du sejour)$/u};

function localVisaInformationTopics(text,{semanticIntent=null,semanticAction=false,hasAttachments=false}={}){
 if(typeof text!=='string'||!text.trim()||text.length>1000||semanticAction||hasAttachments||semanticIntent!==null&&!SAFE_SEMANTIC.has(semanticIntent))return [];
 // Do not interpret quoted/forwarded instructions as this customer's questions.
 if(/["«»“”`<>]/u.test(text))return [];
 let n=normalize(text).normalize('NFD').replace(/[\u0300-\u036f\u0640]/g,'').replace(DECORATION,'');
 const questioned=/[؟?]/u.test(n);
 n=n.replace(/^(?:(?:مرحبا|هلا|اهلا|السلام عليكم|طيب|طب|لو سمحت|من فضلك|بليز|ممكن اعرف|بدي اعرف|عايز اعرف|عاوز اعرف|ابي اعرف|ابغي اعرف|hello|hi|please|bonjour|s['’]il vous plait)\s*[,،]?\s+)+/u,'');
 n=n.replace(/\s+(?:لو سمحت|من فضلك|بليز|please|s['’]il vous plait|شكرا|thanks|thank you|merci)[.!؟? ]*$/u,'').replace(APPLY_INTRO,'');
 const clauses=n.replace(CLAUSE_JOIN,'|').split(/[|\n,،؛;؟?!.]+/u).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
 if(!clauses.length||clauses.length>12)return [];
 const topics=[];
 for(let clause of clauses){
  if(SOCIAL.test(clause))continue;
  clause=clause.replace(CLAUSE_PREFIX,'');
  const matches=Object.entries(RULES).filter(([,rules])=>rules.some(rule=>rule.test(clause))).map(([topic])=>topic);
  if(!matches.length&&DEADLINE_CLAUSES.some(rule=>rule.test(clause))&&classifyVisaTimingInquiry(clause))matches.push('processing_time');
  if(!matches.length&&questioned)matches.push(...Object.entries(FRAGMENTS).filter(([,rule])=>rule.test(clause)).map(([topic])=>topic));
  if(matches.length!==1)return [];
  if(!topics.includes(matches[0]))topics.push(matches[0]);
 }
 return topics.length<=6?topics:[];
}
module.exports={localVisaInformationTopics};
