'use strict';
// Conversation copy only. Routing, ownership, payment and submission remain
// caller responsibilities; a customer's claim is not operational evidence.
const P=require('./saudi-visa-policy');
const {currentVisaEvidence}=require('./visa-case-signature');
const lang=value=>['en','fr'].includes(value)?value:'ar';
const pick=(language,ar,en,fr)=>({ar,en,fr})[lang(language)];

// A timing question is conversational intent only. This recognizer neither
// extracts/saves a date nor claims that the customer's deadline can be met.
function classifyVisaTimingInquiry(text){
 if(typeof text!=='string'||!text.trim()||text.length>4000)return null;
 const raw=text.trim();if(/^["'«“].*["'»”]$/su.test(raw))return null;
 const n=P.normalize(raw).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');
 const clauses=n.split(/[،,؛;.!?؟]+|\s+(?:and|et)\s+|\s+(?=و(?:بتلحق|بلحق|الحق|بنلحق|تلحق|بتطلع|تطلع|بتصدر|تصدر|بتجهز|تجهز|قديش|شقد|كم|متي|ايمت|امتي))/u).map(s=>s.trim()).filter(Boolean);
 let processing=false;
 for(let clause of clauses){
  // Preserve an explicit conditional question as a question, never a date
  // declaration. Only the caller can decide whether a date was asserted.
  clause=clause.replace(/^(?:لو|اذا)\s+(?:قدمت|قدمنا|اقدم|قدمته|قدمنا الطلب)\s+(?:اليوم|هلق|الحين|بكرا|الان)\s+/u,'');
  clause=clause.replace(/^و(?=بتلحق|بلحق|الحق|بنلحق|تلحق|بتطلع|تطلع|بتصدر|تصدر|بتجهز|تجهز|قديش|شقد|كم|متي|ايمت|امتي)/u,'');
  clause=clause.replace(/^(?:(?:طيب|طب|يعني|بس|هل|ممكن|لو سمحت|بدي اعرف|عايز اعرف|ابغي اعرف|اريد اعرف)\s+){1,2}/u,'');
  const time='(?:اليوم|بكرا|بكره|غدا|الجمعة|الجمعه|الخميس|السبت|الاحد|الاثنين|الاتنين|الثلاثاء|التلاتا|الاربعاء|الاربعا|سفري|السفر|رحلتي|الرحله|موعد(?: السفر| سفري)?|تاريخ|(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}(?:[-/]\\d{2,4})?)(?!\\d))';
  const deadlineVerb='(?:بتلحق|بلحق|الحق|بنلحق|تلحق|يلحق|نلحق)';
  const issuedVerb='(?:بتطلع|تطلع|بتصدر|تصدر|بتجهز|تجهز)';
  const subject='(?:(?:الفيزا|التاشيره|الطلب)\\s+)?(?:رح\\s+)?';
  const deadline=new RegExp('^'+subject+'(?:'+deadlineVerb+'(?:\\s+(?:اسافر|سافر|نسافر|السفر))?(?:\\s+(?:(?:قبل|بحلول|يوم|ليوم|لحد)\\s+)?'+time+'.*)?|'+issuedVerb+'\\s+(?:(?:قبل|بحلول|يوم|ليوم|لحد)\\s+)?'+time+'.*)$','u');
  if(deadline.test(clause))return 'travel_deadline';
  if(/^(?:if i (?:apply|submit) today\s+)?(?:will (?:it|the visa|my visa) (?:be (?:ready|issued)|arrive)|can i (?:travel|leave)|can (?:it|the visa) be ready)\s+(?:before|by|on|in time for)\s+.+$/u.test(clause)||
   /^(?:est-ce que )?(?:le visa sera pret|je peux partir)\s+(?:avant|pour|d'ici|jeudi|vendredi|samedi|dimanche|lundi|mardi|mercredi|demain)\b.*$/u.test(clause)||
   /^(?:sera-t-il pret|pourrai-je partir)\s+(?:avant|pour|d'ici|jeudi|vendredi|samedi|dimanche|lundi|mardi|mercredi|demain)\b.*$/u.test(clause))return 'travel_deadline';
  const arabicProcessing=/^(?:(?:قديش|شقد|كم)\s+وقت(?:\s+(?:بتاخد|بتحتاج|تاخد|تحتاج|بتطول|تطول|يبغالها|تشتي))?(?:\s+(?:الفيزا|التاشيره|المعامله|الطلب))?|(?:كم|قديش|شقد|شحال)\s+(?:يوم\s+)?(?:بدها|بتاخد|تاخد|تحتاج|يبغالها|تاخذ|بتطول|بتحتاج|تستغرق|تشتي)(?:\s+(?:وقت|يوم|ايام))?(?:\s+(?:الفيزا|التاشيره|المعامله|الطلب))?|بتاخد وقت قد ايه|(?:متي|ايمت|ايمتي|امتي)\s+(?:بتطلع|تطلع|تصدر|بتصدر|تجهز|بتجهز|بتخلص|تخلص)(?:\s+(?:الفيزا|التاشيره|المعامله|الطلب))?|(?:كم|قديش)\s+(?:مده\s+)?(?:المعالجه|معالجه الطلب|الاجراءات|اجراءات الفيزا|استخراج الفيزا|اصدار التاشيره))$/u;
  const englishProcessing=/^(?:how long (?:does|will) (?:it|the visa|my visa|visa processing|the application) take|how many (?:working )?days (?:does (?:it|the visa|visa processing) take|to process (?:the|my) visa)|when will (?:it|the visa|my visa) be (?:ready|issued)|what is the (?:usual )?processing time)$/u;
  const frenchProcessing=/^(?:combien de temps (?:faut-il|prend le traitement|prend la demande)|quel est le delai (?:de traitement|pour le visa)|quand (?:le visa sera-t-il|sera le visa) pret)$/u;
  if(arabicProcessing.test(clause)||englishProcessing.test(clause)||frenchProcessing.test(clause))processing=true;
 }
 return processing?'processing_time':null;
}

function visaProcessingCopy({language='ar',repeated=false,askTravelDate=false,deadlineConcern=false,travelDateKnown=false,includeFollowup=true}={}){
 if(deadlineConcern){
  const text=pick(language,
   repeated?'عادةً 6–7 أيام عمل حسب السفارة، من دون السبت والأحد والعطل. ما فينا نضمن الموافقة أو إنها بتصدر قبل سفرك.':'بالنسبة لموعد سفرك: المدة المعتادة 6–7 أيام عمل حسب السفارة، من دون السبت والأحد والعطل المعتمدة. ما فينا نضمن الموافقة أو صدور التأشيرة قبل موعد السفر.',
   'The usual processing time is 6–7 working days, excluding Saturdays, Sundays and public holidays. Approval and timing depend on the embassy; we cannot guarantee approval or that the visa will be issued before your trip.',
   'Le délai habituel est de 6–7 jours ouvrés, hors samedis, dimanches et jours fériés. La décision et le délai dépendent de l’ambassade ; nous ne pouvons garantir l’accord ni la délivrance avant votre départ.');
  return text+(includeFollowup&&!travelDateKnown?'\n'+pick(language,'شو تاريخ السفر الكامل، باليوم والشهر والسنة؟','What is your full travel date, including day, month and year?','Quelle est votre date complète de départ, avec le jour, le mois et l’année ?'):'');
 }
 const text=pick(language,
  repeated?'عادةً 6–7 أيام عمل حسب السفارة، من دون السبت والأحد والعطل. ما فينا نضمن الموافقة أو موعد الصدور.':'المدة المعتادة 6–7 أيام عمل حسب السفارة. السبت والأحد والعطل المعتمدة ما بتنحسب، وما فينا نضمن الموافقة أو الصدور بتاريخ محدد.',
  'The usual processing time is 6–7 working days, excluding Saturdays, Sundays and public holidays. Approval and timing depend on the embassy; we cannot guarantee an issue date.',
  'Le délai habituel est de 6–7 jours ouvrés, hors samedis, dimanches et jours fériés. L’accord et le délai dépendent de l’ambassade ; aucune date de délivrance n’est garantie.');
 return text+(includeFollowup&&askTravelDate&&!travelDateKnown?'\n'+pick(language,'شو تاريخ السفر؟','What is your travel date?','Quelle est votre date de départ ?'):'');
}

function routeChecklist(route,{language,repeated,includeNextStep}){
 let text;
 if(route==='tourist'){
  text=pick(language,repeated?'للسياحية أونلاين بنحتاج:\n• نسخة جواز سكانر واضحة، الاسم والباركود كاملين، بلا فلاش أو انعكاس؛ صلاحية 6 أشهر عند السفر.\n• وجه الهوية وخلفها بدقة عالية من تطبيق UAEICP.\n• صورة شخصية حديثة بخلفية بيضاء.':P.TOURIST_DOCS,
   'For the online tourist application, we need:\n• A clear passport scan with the full name and barcode visible, without flash or glare; valid for 6 months at travel.\n• High-resolution front and back of the Emirates ID from UAEICP.\n• A recent personal photo on a white background.',
   'Pour la demande touristique en ligne, il faut :\n• Un scan net du passeport, avec le nom et le code-barres complets, sans flash ni reflet ; validité de 6 mois au départ.\n• Le recto et le verso de l’Emirates ID en haute résolution depuis UAEICP.\n• Une photo d’identité récente sur fond blanc.');
  if(includeNextStep)text+='\n'+pick(language,'ابعتهن هون، ومنراجع الواضح والناقص معك.','Send them here and we can review what is clear or missing.','Envoyez-les ici pour que nous puissions vérifier leur lisibilité et les éléments manquants.');
 }else if(route==='umrah'){
  text=pick(language,repeated?'لمسار العمرة عبر السفارة بنحتاج أصل الجواز وأصل الهوية، وتاريخ الذهاب والعودة. الصور وحدها ما بتكفي. تفاصيل الرحلة والسكن منرتبها بعد مراجعة الملف.':P.UMRAH_DOCS,
   repeated?'The embassy Umrah route needs the original passport and Emirates ID, plus departure and return dates. Copies alone are not enough. Travel and accommodation details are arranged after the file review.':'For our embassy Umrah route, the application cannot be completed online. We need the original passport and Emirates ID, plus departure and return dates.\nAfter reviewing the file: a confirmed ticket for air travel, or vehicle registration and entry/exit ports for travel by car. Accommodation requires the Saudi host’s ID details or a hotel booking through us via Nusuk, according to the application requirements.',
   repeated?'Le parcours Omra via l’ambassade nécessite le passeport et l’Emirates ID originaux, ainsi que les dates de départ et de retour. Les copies seules ne suffisent pas. Les détails du voyage et du logement sont organisés après examen du dossier.':'Pour notre parcours Omra via l’ambassade, la demande ne se fait pas entièrement en ligne. Il faut le passeport et l’Emirates ID originaux, ainsi que les dates de départ et de retour.\nAprès examen du dossier : un billet confirmé pour un voyage en avion, ou la carte grise et les points d’entrée et de sortie pour un trajet en voiture. Pour le logement : les coordonnées d’identité de l’hébergeant en Arabie saoudite ou une réservation d’hôtel par notre intermédiaire via Nusuk, selon les exigences du dossier.');
  if(includeNextStep)text+='\n'+pick(language,'مننسق معك طريقة تسليم الأصول قبل إرسالها.','We will coordinate how to deliver the originals before you send them.','Nous conviendrons du mode de remise des originaux avant leur envoi.');
 }else return null;
 return text;
}

// Pass only products already established by approved policy. Unknown products,
// duplicate indices and incomplete lists return null for the caller to clarify.
function visaDocumentChecklist({route='tourist',quoteRows,applicantProducts,language='ar',repeated=false,includeNextStep=true}={}){
 const source=quoteRows??applicantProducts,options={language,repeated,includeNextStep};
 if(source===undefined)return routeChecklist(route,options);
 if(!Array.isArray(source)||!source.length||source.length>30)return null;
 const rows=source.map((row,index)=>({applicant:typeof row==='string'?index+1:row?.applicant??index+1,product:typeof row==='string'?row:row?.product??row?.code}));
 if(rows.some(r=>!Number.isInteger(r.applicant)||r.applicant<1||r.applicant>30||!['tourist_multi','tourist_single','umrah'].includes(r.product))||new Set(rows.map(r=>r.applicant)).size!==rows.length)return null;
 const tourist=rows.filter(r=>r.product!=='umrah').map(r=>r.applicant),umrah=rows.filter(r=>r.product==='umrah').map(r=>r.applicant);
 if(!tourist.length||!umrah.length)return routeChecklist(umrah.length?'umrah':'tourist',options);
 const indices=values=>values.join(lang(language)==='ar'?'، ':', ');
 return pick(language,'*توضيح مسار المستندات للمجموعة المختلطة:*','*Documents for each route in your group:*','*Documents selon le parcours de chaque demandeur :*')+'\n'+[
  pick(language,`المتقدم (${indices(tourist)} — سياحية أونلاين)`, `Applicant(s) ${indices(tourist)} — online tourist visa`, `Demandeur(s) ${indices(tourist)} — visa touristique en ligne`),
  routeChecklist('tourist',{...options,includeNextStep:false}),
  pick(language,`المتقدم (${indices(umrah)} — عمرة عبر السفارة)`, `Applicant(s) ${indices(umrah)} — embassy Umrah route`, `Demandeur(s) ${indices(umrah)} — Omra via l’ambassade`),
  routeChecklist('umrah',{...options,includeNextStep:false})
 ].join('\n\n')+(includeNextStep?'\n\n'+pick(language,'ابعت صور مستندات السياحية هون، ومننسق طريقة تسليم أصول العمرة قبل إرسالها.','Send the tourist-document copies here; we will coordinate delivery of the Umrah originals before you send them.','Envoyez ici les copies pour le visa touristique ; nous conviendrons du mode de remise des originaux pour l’Omra avant leur envoi.'):'');
}

function visaDocumentsSentCopy({language='ar',repeated=false}={}){
 return pick(language,repeated?'تمام، فهمت إنك أرسلت المستندات. منراجع الموجود والناقص قبل الخطوة التالية.':'وصلتنا رسالتك المتعلقة بالمستندات. منراجع الموجود والناقص قبل الخطوة التالية؛ تأكيد استلام الأوراق بيكون بعد التحقق من الملفات.',
  'Thanks for letting us know you sent the documents. We will check the files and confirm what was received and what is missing.',
  'Merci de nous avoir indiqué l’envoi des documents. Nous vérifierons les fichiers pour confirmer ce qui a été reçu et ce qui manque.');
}

function visaPaymentChoiceCopy({language='ar',repeated=false,includeNextStep=true}={}){
 const text=pick(language,repeated?'خيارات الدفع: تحويل بنكي دون عمولة إضافية من المكتب، رابط دفع بعمولة 5%، أو تابي بعمولة 9%.':'خيارات الدفع:\n• تحويل بنكي على حسابات الشركة: دون عمولة إضافية من المكتب.\n• رابط دفع: عمولة 5%.\n• تابي: عمولة 9%.\nمنأكد وسيلة الدفع والإجمالي قبل الدفع.',
  'Payment options:\n• Bank transfer: no additional office commission.\n• Payment link: 5% fee.\n• Tabby: 9% fee.\nWe confirm the payment method and total before payment.',
  'Options de paiement :\n• Virement bancaire : sans commission supplémentaire de notre agence.\n• Lien de paiement : 5 % de frais.\n• Tabby : 9 % de frais.\nNous confirmons le moyen de paiement et le total avant le règlement.');
 return text+(includeNextStep?'\n'+pick(language,'شو الطريقة الأنسب إلك؟','Which option suits you?','Quelle option vous convient ?'):'');
}

function visaPaymentReceiptCopy(c,{language='ar',receiptReceived=false,repeated=false}={}){
 if(currentVisaEvidence(c).payment)return pick(language,'الدفعة مؤكدة بالفعل من القسم بحسب السجل، شكراً إلك. ما في داعي تعيد التحويل. منتابع الخطوة التالية حسب حالة المعاملة.','Your payment is confirmed in the team’s record. Thank you; there is no need to transfer it again. The next step depends on the application’s status.','Votre paiement est confirmé dans le dossier de notre équipe. Merci, inutile de refaire le virement. La prochaine étape dépend de l’état de la demande.');
 const lead=receiptReceived?pick(language,'وصل إيصال التحويل، شكرًا إلك.','We received the transfer receipt, thank you.','Nous avons reçu le justificatif de virement, merci.'):pick(language,'شكرًا إلك، وصل إشعار التحويل.','Thank you for letting us know about the transfer.','Merci de nous avoir signalé le virement.');
 return lead+' '+pick(language,'نتحقق من وصول الدفعة بمطابقتها مع الحساب البنكي، ومنأكد الاستلام بعد المطابقة.','We will confirm receipt of the funds after matching the transfer against the bank account.','Nous confirmerons la réception des fonds après rapprochement avec le compte bancaire.')+(!repeated&&!receiptReceived?'\n'+pick(language,'إذا ما أرسلت صورة الإيصال بعد، ابعتها هون.','If you have not sent a copy of the receipt yet, send it here.','Si vous n’avez pas encore envoyé le justificatif, envoyez-le ici.'):'');
}

// documentStatus must come from the caller's current, owned document record,
// never from the customer's message or an unverified model decision.
function visaFollowupCopy(c,{language='ar',repeated=false,hasOwnedApplication=false,documentStatus=null}={}){
 const evidence=currentVisaEvidence(c),decision=c?.staffVerification?.decision;
 if(decision?.caseSignature===evidence.signature&&decision.value==='approved')return pick(language,'بحسب تحديث القسم المسجل، صدر قرار الموافقة على طلبك. تسليم التأشيرة وتفاصيلها يكون من القسم المختص.','The team’s record confirms an approval decision. The responsible team will handle delivery of the visa and its details.','Le dossier de notre équipe confirme une décision favorable. L’équipe concernée s’occupe de la remise du visa et de ses détails.');
 if(decision?.caseSignature===evidence.signature&&['refused','rejected'].includes(decision.value))return pick(language,'بحسب تحديث القسم المسجل، صدر رفض رسمي لطلبك. منراجع معك الاسترداد حسب سياسة الخدمة؛ هالشي ما بيعني إن التحويل المالي تنفّذ.','The team’s record confirms an official refusal. We will review the refund with you under the service policy; this does not mean a refund transfer has been made.','Le dossier de notre équipe confirme un refus officiel. Nous examinerons avec vous le remboursement selon les conditions du service ; cela ne signifie pas qu’un virement de remboursement a été effectué.');
 if(evidence.submission)return pick(language,'بحسب تأكيد القسم المسجل، تم تقديم المعاملة فعلياً وهي بانتظار النتيجة. لا يوجد قرار مسجل حتى الآن.','The team’s record confirms the application was submitted. It is awaiting a result; no decision is recorded yet.','Le dossier de notre équipe confirme le dépôt de la demande. Elle est en attente du résultat ; aucune décision n’est encore enregistrée.');
 if(evidence.payment)return pick(language,'طلبك معنا، والدفعة مؤكدة من القسم. ما في داعي تعيد التحويل؛ منأكد لك التقديم بعد إتمامه.','Your payment is confirmed by the team. There is no need to transfer it again; we will confirm submission once completed.','Votre paiement est confirmé par notre équipe. Inutile de refaire le virement ; nous confirmerons le dépôt une fois effectué.');
 if(c?.paymentStatus==='awaiting_verification')return pick(language,'إشعار التحويل عندنا، وبانتظار التحقق من وصول الدفعة للحساب. ما في داعي تعيد التحويل خلال المراجعة.','Your transfer notification is awaiting verification against the bank account. There is no need to transfer again while it is being checked.','Votre avis de virement attend la vérification sur le compte bancaire. Inutile de refaire le virement pendant cette vérification.');
 if(evidence.documents||documentStatus==='reviewed')return pick(language,'طلبك معنا، وتمت مراجعة المستندات. منراجع مع القسم الخطوة التالية؛ مراجعة الأوراق ما بتعني إن المعاملة تقدمت للسفارة.','Your documents have been reviewed. We will check the next step with the team; document review does not mean the application was submitted to the embassy.','Vos documents ont été examinés. Nous vérifierons la prochaine étape avec l’équipe ; cet examen ne signifie pas que la demande a été déposée à l’ambassade.');
 if(documentStatus==='pending'||c?.documents?.length)return pick(language,'طلبك معنا، والأوراق بانتظار المراجعة. منوضح لك إذا في شي ناقص قبل استكمال التقديم.','Your documents are awaiting review. We will let you know if anything is missing before proceeding with the application.','Vos documents attendent leur examen. Nous vous préciserons les éléments manquants avant de poursuivre la demande.');
 if(hasOwnedApplication||c?.paymentStatus==='verified'||c?.submissionStatus==='submitted'||c?.staffVerification?.decision)return pick(language,'طلبك معنا. منراجع آخر حالة مسجلة مع القسم قبل تأكيد التقديم أو النتيجة. ما في داعي تعيد الأوراق أو الدفع.','We have your file. We will check the latest recorded status with the team before confirming submission or a result. There is no need to resend documents or pay again.','Nous avons votre dossier. Nous vérifierons le dernier état enregistré avec l’équipe avant de confirmer le dépôt ou le résultat. Inutile de renvoyer les documents ou de payer à nouveau.');
 return pick(language,repeated?'ابعت رقم الطلب، وتابع من نفس رقم واتساب اللي قدمت منه حتى نراجع الملف الصحيح.':'أكيد، بساعدك بمتابعة طلبك. ابعت رقم الطلب، وتابع من نفس رقم واتساب اللي قدمت منه حتى نربطه بملفك الصحيح.','Send your application reference and contact us from the same WhatsApp number used to apply, so we can find the right file.','Envoyez la référence de votre demande depuis le même numéro WhatsApp que celui utilisé pour déposer le dossier, afin de retrouver le bon dossier.');
}

module.exports={classifyVisaTimingInquiry,visaProcessingCopy,visaDocumentChecklist,visaDocumentsSentCopy,visaPaymentChoiceCopy,visaPaymentReceiptCopy,visaFollowupCopy};
