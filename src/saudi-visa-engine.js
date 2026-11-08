'use strict';
const {rememberVisaJourney,returningGreeting,clearCustomerProfile}=require('./customer-profile');
const {extractMentionedExpiryDates,checkPassportValidityDate,checkResidencyValidityDate,readinessReferenceDate}=require('./prebooking-readiness');
const {parseEnglishVisaFacts,affirmativeEnglishText}=require('./bilingual-intake');
const {randomUUID}=require('node:crypto');
const P=require('./saudi-visa-policy');
const SERVICE=require('./remal-service-policy');
const {loadVisaPrivateConfig}=require('./saudi-visa-private');
const {currentVisaEvidence}=require('./visa-case-signature');
const {redactVisaText}=require('./saudi-visa-nlu');
const {detectDocumentStep}=require('./visa-document-conversation');
const {documentClarificationCopy}=require('./visa-workflow-progress');
const {referenceKey,applicationReference,conversationIntent}=require('./visa-conversation-intent');
const {CONSULTATION_INTENTS,consultationIntent,consultationReply:seniorConsultationReply}=require('./visa-consultation');
const {visaReplyLanguage,englishVisaQuestion,englishVisaConsultationReply,VISA_INTRO_EN,REFUND_BENEFIT_EN,REFUND_REMINDER_EN,frenchVisaQuestion,frenchVisaConsultationReply,VISA_INTRO_FR}=require('./visa-reply-language');
const {extractApplicantAgeUpdates}=require('./visa-applicant-age');
const {touristQuoteCopy,touristPriceOverview,touristInsuranceCopy,visaRefundCopy,REFUND_COPY}=require('./visa-price-copy');
const {classifyVisaShortReply}=require('./visa-short-reply');
const {visaProcessingCopy,classifyVisaTimingInquiry,visaDocumentChecklist,visaPaymentChoiceCopy,visaPaymentReceiptCopy,visaFollowupCopy,visaDocumentsSentCopy}=require('./visa-service-copy');
const {localVisaInformationTopics}=require('./visa-information-topics');
const {naturalDate,dubaiDay}=require('./arabic-dates');
const INTRO='أهلاً وسهلاً فيك بمجموعة الرمال 🌷 أنا إسماعيل، المساعد الافتراضي المختص بفيز السعودية.';
const REPLY_INTROS={ar:INTRO,en:VISA_INTRO_EN,fr:VISA_INTRO_FR};
const REPLY_QUESTIONS={en:englishVisaQuestion,fr:frenchVisaQuestion};
const REPLY_CONCERNS={ar:seniorConsultationReply,en:englishVisaConsultationReply,fr:frenchVisaConsultationReply};
const EGYPT_SINGLE_COPY='حسب سياسة منصة التقديم الحالية، التأشيرة السياحية المتاحة للجنسية المصرية خلال هذا الموسم هي سفرة واحدة، والتأشيرة متعددة الدخول غير متاحة حاليًا.';
const MONEY=x=>Number(x).toLocaleString('en-US',{maximumFractionDigits:2});
const SHORT_REPLIES=Object.freeze({
 ar:{acknowledgement:'تمام، أنا معك إذا حابب نكمل.',thanks:'العفو، بأي وقت 🌷',negative:'ولا يهمك. إذا حابب تسأل عن شي تاني، أنا معك.',pause:'أكيد، خذ وقتك. منكمّل من نفس النقطة لما يناسبك.'},
 en:{acknowledgement:'Of course. I’m here when you’re ready to continue.',thanks:'You’re welcome 🌷',negative:'No problem. I’m here if you need anything else.',pause:'Take your time. We can pick up here when you’re ready.'},
 fr:{acknowledgement:'D’accord. Je reste disponible si vous souhaitez continuer.',thanks:'Avec plaisir 🌷',negative:'Pas de souci. Je reste disponible si besoin.',pause:'Prenez votre temps. Nous reprendrons au même point quand vous le souhaiterez.'}
});
function standaloneVisaReply(c,text,messages){
 if(!c.greeted||messages.some(m=>m.media||Object.keys(m).some(k=>/Choice$|Action$|Answer$|Confirmation$/.test(k))||m.payload))return null;
 const short=classifyVisaShortReply(text);if(!short)return null;
 const previous=c.history.at(-1)?.role==='assistant'?c.history.at(-1).text:'';
 const cancellationAsked=c.cancellation?.state==='awaiting_confirmation'&&previous.includes('تحب نسجل طلب مراجعة الإلغاء؟');
 const newApplicationAsked=c.pendingNewApplication&&previous.endsWith('تأكدلي: بدك نفتح طلب جديد؟');
 if(cancellationAsked&&['acknowledgement','clarify'].includes(short.kind)&&!/^(?:نعم|اي|اكد|اوافق|موافق)[.! ]*$/.test(P.normalize(text)))return 'حتى أتأكد من قصدك: تحب نسجل طلب مراجعة الإلغاء؟ جاوب بنعم أو لا.';
 if(newApplicationAsked&&short.kind==='acknowledgement'&&!/^(?:نعم|اي|اكد|اوافق|موافق|yes)[.! ]*$/.test(P.normalize(text)))return 'إذا حابب تفتح ملف مستقل، جاوب بنعم. تأكدلي: بدك نفتح طلب جديد؟';
 if(short.kind==='clarify')return REPLY_CONCERNS[c.replyLanguage]('clarify_question',c);
 if(short.kind==='negative'&&cancellationAsked){c.cancellation.state='withdrawn';return 'تمام، منكمل على ملفك الحالي من غير طلب إلغاء.';}
 // Keep explicit confirmations on their existing case-bound workflow.
 const confirm=P.normalize(text);
 if((cancellationAsked||newApplicationAsked)&&/^(?:نعم|اي|اكد|اوافق|موافق|yes|لا)[.! ]*$/.test(confirm))return null;
 return SHORT_REPLIES[c.replyLanguage][short.kind]||null;
}
function quoteLocked(c){
 return c.paymentStatus==='verified'||c.submissionStatus==='submitted'||Boolean(c.staffVerification?.payment)||
  c.paymentStatus==='awaiting_verification'&&Number.isFinite(c.quote?.total);
}
function isTourist(product){return product.code==='tourist_multi'||product.code==='tourist_single';}
function ageQuestion(index,count,language){
 if(language==='en')return count===1?'How old is the traveler, in completed years?':`How old is applicant ${index+1}, in completed years?`;
 if(language==='fr')return count===1?'Quel âge a le voyageur, en années révolues ?':`Quel âge a le demandeur ${index+1}, en années révolues ?`;
 return count===1?'كم عمر المسافر بالسنوات؟ العمر بيحدد إذا في فرق تأمين.':`كم عمر المتقدم رقم ${index+1} بالسنوات؟`;
}
function countFrom(text){const n=P.normalize(text);if(/لحالي|لوحدي|بطولي|شخص واحد|شخص بالغ|انا فقط|انا بس|بس انا|one person|just me/.test(n))return 1;const m=n.match(/(?:نحن|نحنا|احنا|صرنا|عددنا|عدد الاشخاص|عدد المتقدمين|عيلتي|عايلتي|عائله من)\s*(\d{1,2})|\b(\d{1,2})\s*(?:اشخاص|شخص|افراد|متقدم|انفار|نفر)/);if(m)return Number(m[1]||m[2]);if(/(?:ثلاثه|ثلاث|تلاته|تلات)\s*(?:اشخاص|افراد|متقدمين)|(?:نحن|نحنا|احنا|صرنا|عددنا)\s*(?:ثلاثه|ثلاث|تلاته|تلات)/.test(n))return 3;if(/انا و(?:ام وابوي|امي وابوي|ابوي وامي|والدي ووالدتي)(?=$|[\s،,.؟?!])/.test(n))return 3;if(/شخصين|فردين|نفرين|(?:نحن|نحنا|احنا|صرنا|عددنا)\s*(?:اتنين|اثنين)|انا و(?:مرتي|مراتي|زوجتي|زوجي|جوزي|امي|والدتي|ابي|ابوي|والدي|اخي|اخوي|اختي|المدام|خطيبتي|الحرمه)/.test(n))return /(?:ولادي الاثنين|طفلين|ولدين)/.test(n)?4:/(?:ابني|بنتي|الولد|الطفل)/.test(n)?3:2;if(/اربعه اشخاص|اربع اشخاص/.test(n))return 4;if(/خمسه اشخاص|خمس اشخاص/.test(n))return 5;return null;}
function isComplaint(text){const n=P.normalize(text);const accusation=/نصاب|نصبتم|نصبتو|نصبتوا|حراميه|سرقتو|سرقتوا/.test(n),existing=/قدمت|مقدم|معاملتي|معامله|دفعت|حولت|فلوسي|مصرياتي|مصاري|مبلغ|ترجعو|رجعتو/.test(n);return existing&&(accusation||/(?:ما|لم|مو|ليس).{0,25}(?:طلعت|صدرت|رجعت|رجعتو|رجعوا|رجعتوا|استلمت)|شكوي|اشتك/.test(n));}
function safeText(s,max=120){return typeof s==='string'?s.trim().slice(0,max):null;}
function issuerAnswer(text){
 const place=P.normalize(text).replace(/[.!]+$/u,'').trim()
  .replace(/^(?:(?:ال)?وثيقه(?: السفر)?\s+)?(?:(?:صادره?|صدرت|اصدرت)\s+(?:من|في)\s+|من\s+)/u,'');
 return P.canonicalIssuer(place,{exact:true});
}
function dateValue(v){return typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:null;}
const VISA_WEEKDAYS=Object.freeze({monday:'الاثنين',lundi:'الاثنين',tuesday:'الثلاثاء',mardi:'الثلاثاء',wednesday:'الاربعاء',mercredi:'الاربعاء',thursday:'الخميس',jeudi:'الخميس',friday:'الجمعه',vendredi:'الجمعه',saturday:'السبت',samedi:'السبت',sunday:'الاحد',dimanche:'الاحد'});
function hasVisaDateHint(text){
 const n=P.normalize(text);
 return /\d{1,4}[-/.]\d{1,2}|الجمعه|الاحد|الاثنين|الاتنين|الثلاثاء|التلاتا|الثلاثا|الاربعاء|الاربعا|الخميس|السبت|بكرا|بكره|غدا|اليوم|اسبوع|شهر|\b(?:today|tomorrow|demain|next week)\b/u.test(n)||n.split(/[^a-z]+/u).some(word=>Object.hasOwn(VISA_WEEKDAYS,word));
}
function visaDeadlineTarget(text){
 return P.normalize(text).replace(/^(?:لو|اذا)\s+(?:قدمت|قدمنا الطلب|قدمنا|اقدم|قدمته)\s+(?:اليوم|هلق|الحين|بكرا|بكره|غدا|الان)[\s،,]+/u,'')
  .replace(/^if i (?:apply|submit) today[\s,]+/u,'');
}
function oneFutureVisaDate(text,now){
 const value=P.normalize(text).replace(/[؟?!]/g,' ')
  .replace(/\b(?:tomorrow|demain)\b/g,'بكرا').replace(/\b(?:today|aujourd['’]hui)\b/g,'اليوم')
  .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/g,word=>VISA_WEEKDAYS[word])
  .replace(/(?:^|\s)(جمعه|خميس|سبت|احد|اثنين|اتنين|ثلاثاء|ثلاثا|تلاتا|اربعاء|اربعا)(?=$|[\s،,.])/gu,(_,word)=>' ال'+word);
 if(/(?:^|\s)(?:او|ولا|or|ou)(?=\s|$)/u.test(value))return null;
 const weekdays=value.match(/(?:^|[^\p{L}])(?:الجمعه|الاحد|الاثنين|الاتنين|الثلاثاء|التلاتا|الثلاثا|الاربعاء|الاربعا|الخميس|السبت)(?=$|[^\p{L}])/gu)||[];
 if(weekdays.length>1)return null;
 const parsed=naturalDate(value,now);
 const date=!parsed.invalid&&!parsed.range&&parsed.dates?.length===1?dateValue(parsed.dates[0]):null;
 // A weekday that is also today's name needs a calendar date, unless the
 // customer explicitly said today or next week.
 if(date&&weekdays.length===1&&Date.parse(date)-dubaiDay(now).getTime()===7*86400000&&!/اليوم|الجاي|القادم|المقبل|\bnext\b|prochain|\d{1,4}[-/.]\d{1,2}/u.test(value))return null;
 return date;
}
function declaredVisaTravelDate(text,previousReply,now){
 const n=P.normalize(text);
 if(/(?:^|\s)(?:مو|مش|مب|ماني|لا|ما|اذا|لو|not|pas|if)(?=\s|$)/u.test(n))return null;
 const declares=/^(?:(?:انا|نحن|احنا)\s+)?(?:سفري|سفرنا|موعد سفري|موعد سفرنا|my travel date is|our travel date is|je pars|nous partons)\s+/u.test(n);
 const answers=/شو تاريخ السفر(?: الكامل، باليوم والشهر والسنه| الكامل، باليوم والشهر والسنة)?؟|What is your (?:full )?travel date(?:, including day, month and year)?\?|Quelle est votre (?:date de départ|date complète de départ, avec le jour, le mois et l’année) \?/u.test(previousReply)&&
  (/^(?:يوم\s+)?(?:(?:ال)?(?:جمعه|خميس|سبت|احد|اثنين|اتنين|ثلاثاء|ثلاثا|تلاتا|اربعاء|اربعا)(?:\s+(?:الجاي|الجايه|القادم|المقبل))?|بكرا|بكره|غدا|اليوم|tomorrow|today|demain|\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{1,4})?)[.! ]*$/u.test(n)||Object.hasOwn(VISA_WEEKDAYS,n));
 return declares||answers?oneFutureVisaDate(text,now):null;
}
function conversationText(text,{hasAttachments=false}={}){
 const withoutPlaceholders=hasAttachments?String(text||'').replace(/\[[^\[\]\n]{0,80}(?:مرفق|ملف|مراجعة|مراجعه)[^\[\]\n]{0,80}\]/g,''):String(text||'');
 const safe=redactVisaText(withoutPlaceholders).trim();
 // Redaction markers alone are not a customer question. Images, OCR output,
 // identifiers and credentials never enter semantic conversation understanding.
 const words=safe.replace(/\[(?:document omitted|document number|number|credential|name|redacted|email|bank account)\]/g,'').replace(/[،,\s]+/g,' ').trim();
 return /\p{L}/u.test(words)||/^\p{N}{1,2}$/u.test(words)?safe:'';
}
function relativeReply(pending,{group=false,question=''}={}){
 const person=pending.facts||{};
 if(group){pending.awaiting='scope';return 'أكيد، منراجع طلبات رفقاتك كل واحد حسب جنسيته ومستنده. بتحب نضيفهم معك بنفس المجموعة، أو كل واحد بملف مستقل؟';}
 if(!person.nationality){pending.awaiting='nationality';return 'أكيد، فينا نراجع حالة صديقك كمان. شو جنسيته؟';}
 const product=P.productFor(person);if(product.code==='umrah'&&P.umrahQuestion(question))return P.umrahConsultation(person,{objection:true});let lead='';
 if(product.code==='suspended'){pending.awaiting='scope';return 'حسب حالة التقديم الحالية عندنا، التقديم لهالجنسية متوقف. ما رح نطلب منه دفع أو نوعده بموعد فتح غير معتمد.';}
 if(person.nationality==='فلسطين')lead='للحالة الفلسطينية، '+P.UMRAH_ROUTE+' التقديم بأصل الجواز وأصل الهوية، والتكلفة 850 درهم مع ميزة استرداد الرسوم في حال الرفض الرسمي حسب شروط الخدمة، وما في ضمان للموافقة.';
 else if(!person.documentType&&product.code==='tourist_single')lead='إذا معه جواز مصري عادي: '+EGYPT_SINGLE_COPY;
 else if(product.code==='tourist_single')lead=EGYPT_SINGLE_COPY;
 else if(!person.documentType&&product.code==='tourist_multi')lead='إذا معه جواز عادي، المسار عندنا سياحية متعددة الدخول حسب سياسة المكتب.';
 else if(product.code==='unverified')lead='نوع التأشيرة لهالحالة يحتاج تحققًا قبل تأكيد الأهلية أو طلب الدفع.';
 else lead='حسب سياسة التقديم الحالية عندنا، المسار لهالحالة هو '+product.label+'، من دون ضمان للموافقة.';
 if(!person.documentType){pending.awaiting='documentType';return lead+' معه جواز سفر عادي أو وثيقة سفر؟';}
 if(person.documentType==='travel_document'&&!person.documentIssuer){pending.awaiting='documentIssuer';return lead+' وثيقته صادرة من أي بلد؟';}
 pending.awaiting='scope';return lead+' بدك نضيفه لنفس المجموعة أو تفتح له طلب مستقل؟';
}
function singlePalestinianDescriptor(n,ns){
 return ns.length===2&&ns.includes('فلسطين')&&!/زوج|مرتي|مراتي|جوزي|الحرمه|امي|ابي|والد|ابني|بنتي|اخوي/.test(n)&&!(countFrom(n)>1);
}
function explicitApplicantIndex(n){
 const matches=[...n.matchAll(/(?:المتقدم|الشخص|المسافر|الفرد)\s*(?:رقم\s*)?(?:(\d+)|(ال\p{L}+))(?=$|[^\p{L}\p{N}])/gu)];
 if(!matches.length)return null;
 // Invalid or multiple references must never fall back to the primary person.
 if(matches.length!==1)return -1;
 const m=matches[0],index=m[1]?Number(m[1])-1:({الاول:0,الثاني:1,التاني:1,الثالث:2,التالت:2,الرابع:3,الخامس:4})[m[2]];
 return Number.isInteger(index)&&index>=0&&index<30?index:-1;
}
function dailyVisaTopics(n){
 return [
  [/تامين|تأمين|التامين الطبي|\binsurance\b|\bassurance\b/, 'insurance'],
  [/(?:عمره).*(?:بالسياح|فيزا سياح|تاشيره سياح)|سياحيه.*عمره|تسمح بالعمره|فيني اعتمر|بقدر اعتمر/, 'umrah'],
  [/منفذ|البطحاء|البطحا|بالسياره|عن طريق البر|(?:^|\s)بري(?=$|[\s،؟?])|اي مطار بالسعوديه|مطار جده|مطار الرياض|مطار المدينه/, 'entry'],
  [/ستيكر|ملصق|عل[ىي] الجواز|عالجواز|الكترونيه|\bpdf\b|كيف بستلم الفيزا|كيف بتطلع الفيزا|ورقه/, 'delivery'],
  [/(?:فيزا|تاشيره)\s*زياره|زياره بالامارات|ما معي اقامه|ما عندي اقامه|بدون اقامه|زائر بالامارات/, 'visitor'],
  [/مهنه|مهنتي|المهنه بالهويه|مسمي وظيفي|المسمي الوظيفي/, 'profession'],
  [/بصمه|تبصيم|مقابله|حضور شخصي/, 'biometrics'],
  [/كشف حساب|راتب|شهاده راتب|لا مانع|\bnoc\b|تعريف بالراتب|تعريف راتب|حساب بنكي للتقديم/, 'financial_docs'],
  [/مقيم ب(?:قطر|الكويت|عمان|سلطنه عمان|البحرين)|اقامه (?:قطريه|كويتيه|عمانيه|بحرينيه|خليجيه)|دول الخليج|مقيم بالخليج/, 'gcc_residency'],
  [/(?:مضاف|مضافه|طفل|ابني|بنتي) عل[ىي] (?:ال)?جواز|مضافين عالجواز|مضاف عالجواز|جواز مستقل للطفل|جواز خاص للطفل/, 'child_passport']
 ].filter(([pattern,key])=>pattern.test(n)&&(key!=='entry'||!/زاجل|مندوب/.test(n))&&(key!=='delivery'||!/مضاف|طفل/.test(n))).map(([,key])=>key);
}
function dailyVisaCopy(topic,hasUmrah){
 // Dated office offer; government entry/Umrah instructions remain authoritative.
 const copy={
  insurance:`رسوم التأشيرة المعتمدة عندنا (${P.PRICES.tourist} درهم للسياحية و${P.PRICES.umrah} درهماً للعمرة) شاملة رسوم التأشيرة والتأمين الطبي الإلزامي المربوط بالمنصة 🌷 ما في مبلغ إضافي للتأمين ضمن هالعرض. رسوم وسيلة الدفع أو الخدمات الإضافية تُوضح منفصلة قبل الاتفاق.`,
  umrah:'التأشيرة السياحية السعودية تتيح أداء العمرة خارج موسم الحج، مع الالتزام بالتعليمات الرسمية والتصاريح المطلوبة عبر نسك 🌷 هذا توضيح لاستخدام التأشيرة الصادرة، وما بيغيّر مسار التقديم المناسب لجنسيتك أو بيضمن الموافقة.',
  entry:'يمكن استخدام التأشيرة السياحية الصادرة عبر المنافذ البرية الرسمية، مثل البطحاء بالسيارة، أو المطارات الدولية السعودية، حسب شروط التأشيرة والتعليمات السارية وقت السفر 🌷 منراجع معك المنفذ المناسب قبل الرحلة؛ القرار النهائي للدخول للجهة المختصة.',
  delivery:hasUmrah?'بمسار العمرة، التقديم عندنا عبر السفارة بأصل الجواز وأصل الهوية، ومنبلغك بطريقة استلام الجواز والتأشيرة فور صدورها 🌷':'بمسار السياحية الإلكترونية، التأشيرة بعد صدورها بتكون ملف PDF ومنبعتلك إياها هون على واتساب لتحتفظ بنسخة وتطبعها للسفر، بدون الحاجة لملصق على الجواز 🌷',
  visitor:'مسار التقديم السياحي أونلاين للمقيمين عندنا بيتطلب إقامة خليجية سارية بصلاحية لا تقل عن 3 أشهر، وهوية إماراتية للمقيم بالإمارات 🌷 إذا كنت زائراً بدون إقامة، منراجع مع المسؤول المسار المتاح حسب الجنسية، بما فيه العمرة إن كانت متاحة، قبل أي التزام أو دفع.',
  profession:'المسمى الوظيفي وحده ما بيكفي للحكم على أهلية التأشيرة 🌷 منراجع الجنسية ونوع الجواز والإقامة وفق شروط المسار الحالي، وما منعتبر اختلاف المهنة سبباً تلقائياً للرفض. منراجع الهوية والجواز قبل تأكيد الطلب والدفع.',
  biometrics:hasUmrah?'بمسار العمرة عندنا، مننسّق التقديم عبر المكتب والسفارة بأصل الجواز وأصل الهوية 🌷 إذا طُلب تسجيل بصمة أو حضور شخصي منوضحلك الإجراء قبل ترتيب الموعد؛ متطلبات البصمة بتتحدد حسب المسار وتعليمات الجهة المختصة.':'التقديم السياحي الإلكتروني عبر مكتبنا بيتم عن بُعد عبر واتساب، وعادةً ما بيتطلب مقابلة أو حضور شخصي للسفارة 🌷 تسجيل البصمة بيكون وفق تعليمات المسار أثناء التقديم أو عند الوصول، ومنبلغك إذا طُلب أي إجراء مسبق.',
  financial_docs:'ضمن ملفات التقديم المعتادة عبر مكتبنا، ما منطلب كشف حساب بنكي ولا شهادة راتب ولا رسالة لا مانع (NOC) من الكفيل 🌷 منبدأ بالمستندات الأساسية المحددة للمسار، وإذا طلبت الجهة المختصة مستنداً إضافياً منوضحلك المطلوب لحالتك.',
  gcc_residency:'مسار السياحية الإلكترونية يشمل حاملي الإقامة السارية في دول الخليج: الإمارات، قطر، الكويت، البحرين وعُمان 🌷 منراجع صلاحية الإقامة لثلاثة أشهر على الأقل والجواز لستة أشهر عند السفر، مع الجنسية ونوع المستند وشروط المنصة، قبل تأكيد أهلية الحالة والدفع.',
  child_passport:'للتقديم عبر مكتبنا، كل مسافر بما فيه الأطفال والرضّع بيحتاج جواز سفر مستقل وتأشيرة مستقلة خاصة فيه 🌷 ومنراجع تسعير الأطفال مع المسؤول قبل الدفع.'
 };
 return copy[topic];
}
// Only asserted clauses may update application facts. Conditions, alternatives
// and negation are useful conversational context, not declarations about a file.
function assertedVisaText(text){
 return P.normalize(affirmativeEnglishText(text))
  .split(/[،,؛;!؟?\n]|(?<!\d)\.(?!\d)/u)
  .map(part=>part.split(/(?:^|\s)(?:و?لو(?!\s+سمحت)|و?اذا|افترض|لنفترض|فرضنا|مثلا|if|suppose|imagine)(?=\s|$)/u)[0])
  .flatMap(part=>part.split(/(?:^|\s)(?:لكن|بس|بل|انما)(?=\s)|\s+(?=انا\s+(?!(?:مو|مش|ماني|لست)\s))/u))
  .filter(part=>!/^(?:هل|شو|ايش|وش|ايه|ما|what|which)\s.*(?:فرق|بين|جواز|وثيق|جنسي|passport|document|nationality)/iu.test(part.trim()))
  .filter(part=>!/(?:^|\s)(?:مو|مش|ماني|مانيش|مب|لست|ليس|ما|لا|لم|بدون|ماعندي|معنديش|مافيش|ماحولت|مادفعت|ماسددت)(?=\s|$)/u.test(part))
  .join('، ').trim();
}
function paymentMethodInquiry(text,decision){
 const n=P.normalize(text),asserted=assertedVisaText(text);
 const methods=[/تابي|\btabby\b/.test(n),/تحويل|بنكي|البنك|حساب بنكي|\bbank\b/.test(n),/رابط|لينك|\blink\b/.test(n)].filter(Boolean).length;
 const comparing=methods>1&&/(?:^|\s)(?:ولا|او|or|versus|vs)(?=\s)|فرق|قارن|مقارنه|difference|compare/.test(n);
 // A request for fees or a comparison is not a payment-method selection.
 // An explicit selection in the same turn still takes effect, unless the
 // customer is weighing alternatives rather than choosing one.
 const selected=/(?:بدي|بدنا|عايز|عاوز|ابي|ابغي|اريد|اشتي|حابب)\s+(?:(?:ادفع|دفع|الدفع|اسدد|احول)\s+)?(?:ب|عبر|عن طريق|على)?\s*(?:تابي|تحويل|البنك|حسابكم|رابط|لينك)|(?:اختار|اخترت|باختار|بدفع|بحول|بسدد|دفعت|حولت|سددت)\s*(?:ب|عبر|عن طريق|على)?\s*(?:تابي|تحويل|البنك|حسابكم|رابط|لينك)|(?:ارسل|ابعت|بعتلي|عطيني)\s+(?:رابط|لينك)|\b(?:i (?:choose|prefer)|i(?:'ll| will| want to) pay (?:via|by|with)|send (?:me )?(?:a |the )?payment link)\b/i.test(asserted);
 const information=methods>0&&/كم|قديش|شقد|رسوم|عمول|كيف|فرق|قارن|طرق|خيارات|وسائل|\b(?:how|what|fees?|charges?|cost|difference|compare)\b/i.test(n);
 const semanticChoice=['bank','link','tabby'].includes(decision?.fields?.paymentMethod||decision?.facts?.paymentMethod);
 const semanticInformation=!semanticChoice&&(decision?.intent==='payment'||Array.isArray(decision?.informationIntents)&&decision.informationIntents.includes('payment'));
 return comparing||!selected&&(information||semanticInformation);
}
function extractLocal(text,c){
 const original=P.normalize(text);
 text=assertedVisaText(text);
 const n=P.normalize(text),ns=P.nationalities(n),fields={},number=countFrom(n);
 if(number)fields.applicantCount=number;
 const doc=/وثيقه|وثيقة|وثيقته|وثيقتها|وثائق|travel document/.test(n)?'travel_document':/جواز|باسبور|باسبورت|passport/.test(n)?'passport':null;
 if(ns.length===1&&!(doc==='travel_document'&&!/فلسطين/.test(n)))fields.nationality=ns[0];
 else if(doc==='travel_document'&&ns.includes('فلسطين')||singlePalestinianDescriptor(n,ns)&&/فلسطينيه?\s+(?:سوري|مصري|لبناني)/.test(n))fields.nationality='فلسطين';
 if(doc)fields.documentType=doc;
 if(ns.length>1&&/(?:انا|زوج|مرتي|مراتي|جوزي|الحرمه|امي|ابي|والد|ابني|بنتي|اخوي)/.test(n)&&!doc&&!singlePalestinianDescriptor(n,ns)){fields.applicants=ns.map(nationality=>({nationality}));fields.applicantCount=number||Math.max(c.applicantCount||0,ns.length);}
 if(/كلنا|جميعنا|(?:نحن|نحنا|احنا).{0,10}سوريين/.test(n)&&ns.length===1&&number)fields.applicants=Array.from({length:number},()=>({nationality:ns[0],...(doc?{documentType:doc}:{})}));
 if(doc==='travel_document'){const issuer=P.canonicalIssuer(text);if(['سوريا','لبنان','مصر','الأردن','العراق'].includes(issuer))fields.documentIssuer=issuer;}
 if(/تحويل|حساب بنكي|حسابات|ايبان|iban|bank/.test(n)&&!/كشف حساب|حساب بنكي للتقديم|bank\s+statement/.test(n))fields.paymentMethod='bank';else if(/تابي|tabby/.test(n))fields.paymentMethod='tabby';else if(/رابط الدفع|لينك|payment link/.test(n))fields.paymentMethod='link';
 if(/بالسياره|بري|سيارتي|بالعربيه(?!\s*للطيران)/.test(n))fields.transport='car';else if(/بالطيران|بالطياره|جوي|بالعربيه\s*للطيران/.test(n))fields.transport='air';
 if(/عندي مستضيف|معي هويه مستضيف|عندي مضيف/.test(n))fields.hasHost=true;
 if(/(?:^|[،,.!؟?]\s*)(?:انا )?(?:ما عندي|ماعندي|ما عندنا|معنديش|مش عندي) (?:مستضيف|مضيف)(?:[،,.!؟?]|$)/.test(original))fields.hasHost=false;
 const dates=[...n.matchAll(/(?<![\p{L}\p{N}])(?:(20\d{2}-\d{2}-\d{2})|(\d{1,2})[/. -](\d{1,2})[/. -](20\d{2}))(?![\p{L}\p{N}])/gu)]
  .map(x=>dateValue(x[1]||`${x[4]}-${x[3].padStart(2,'0')}-${x[2].padStart(2,'0')}`)).filter(Boolean);
 if(/سفر|مسافر|ذهاب|رجعه|عوده|مغادر/.test(n)&&!/انتهاء|ينتهي|تنتهي|صلاحيه/.test(n)){
  if(dates.length){if(/رجعه|عوده/.test(n)&&!/سفر|مسافر|ذهاب|مغادر/.test(n))fields.returnDate=dates[0];else fields.departureDate=dates[0];}
  if(dates[1])fields.returnDate=dates[1];
 }
 const en=parseEnglishVisaFacts(text);
 for(const [k,v]of Object.entries(en))if(fields[k]===undefined)fields[k]=v;
 // Parse explicit relatives in mention order; the issuer of one person's
 // document must never replace a different applicant's nationality or passport.
 const parts=text.split(/(?:\s|،\s*)و(?=(?:زوجتي|مرتي|مراتي|زوجي|جوزي|امي|ابي|والدتي|والدي|اخي|اخوي|اختي|ابني|بنتي)(?=\s|$))/u);
 if(parts.length>1&&/^(?:انا|نحن|نحنا|احنا)(?=\s)/u.test(parts[0])&&parts.every(part=>P.nationalities(part).length||/جواز|باسبور|باسبورت|وثيق/.test(part))){
  fields.applicants=parts.map(part=>personFields(extractLocal(part,{})));
  fields.applicantCount=number||parts.length;
  for(const key of ['nationality','documentType','documentIssuer'])delete fields[key];
 }
 return fields;
}
function personFields(f){const p={};if(f&&typeof f==='object'){
 if(typeof f.nationality==='string'&&f.nationality.trim())p.nationality=P.canonicalNationality(f.nationality);
 if(['passport','travel_document'].includes(f.documentType))p.documentType=f.documentType;
 if(typeof f.documentIssuer==='string'&&f.documentIssuer.trim())p.documentIssuer=safeText(f.documentIssuer,70);
 if(Number.isInteger(f.age)&&f.age>=0&&f.age<120)p.age=f.age;
 }return p;}
function mergeFacts(c,f){
 if(!f||typeof f!=='object'||Array.isArray(f))return;
 if(Number.isInteger(f.applicantCount)&&f.applicantCount>=1&&f.applicantCount<=30){c.applicantCount=f.applicantCount;c.applicants=c.applicants.slice(0,c.applicantCount);}
 if(Array.isArray(f.applicants)&&f.applicants.length&&f.applicants.length<=30){
  if(!c.applicantCount)c.applicantCount=f.applicants.length;
  for(let i=0;i<Math.min(f.applicants.length,c.applicantCount);i++){const entry=personFields(f.applicants[i]);if(!Object.keys(entry).length)continue;c.applicants[i]={...c.applicants[i],...entry};if(c.applicants[i].documentType==='passport')delete c.applicants[i].documentIssuer;}
 }
 const primary=personFields(f);if(Object.keys(primary).length){c.applicants[0]={...c.applicants[0],...primary};if(c.applicants[0].documentType==='passport')delete c.applicants[0].documentIssuer;}
 for(const key of ['departureDate','returnDate'])if(dateValue(f[key]))c[key]=f[key];
 if(['air','car'].includes(f.transport||f.travelMode))c.transport=f.transport||f.travelMode;
 if(typeof f.hasHost==='boolean')c.hasHost=f.hasHost;
 if(['bank','link','tabby'].includes(f.paymentMethod))c.paymentMethod=f.paymentMethod;
}
const REFUND_REMINDER='🛡️ رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي حسب شروط الخدمة.';
function quoteText(q,{refundShown=false,language='ar',includeRefund=true}={}){
 if(!q)return '';
 const localized=touristQuoteCopy(q,{refundShown,language,includeNextStep:false,includeRefund});
 if(localized)return localized;
 if(q.requiresReview&&q.reason==='tourist_age_required')return touristPriceOverview({language,includeNextStep:false});
 if(q.requiresReview&&q.reason==='tourist_age_53_review')return touristPriceOverview({age:53,language,includeNextStep:false});
 if(q.requiresReview)return 'حتى نعطيك سعر الأطفال بشكل دقيق، بدنا نراجع تسعير الحالة قبل تأكيد المبلغ؛ ما رح نحسب الطفل تلقائياً بسعر البالغ.'+(q.adultReferenceAmount?'\n(للإرشاد: رسوم الشخص البالغ لـ'+q.adultLabel+' هي '+MONEY(q.adultReferenceAmount)+' درهم، ويُؤكد الإجمالي بعد مراجعة تسعير الطفل مع المسؤول).':'');
 let text='*عرض تأشيرات السعودية 🇸🇦*\n'+q.rows.map(r=>`• المتقدم ${r.applicant}: ${r.label} — ${MONEY(r.amount)} درهم`+(r.insuranceSurcharge?` (${MONEY(r.baseAmount)} رسوم التأشيرة + ${MONEY(r.insuranceSurcharge)} للتأمين الصحي الإلزامي)`:'')).join('\n');
 if(q.rows.some(row=>row.product==='tourist_multi'))text+='\n✨ السياحية المتعددة: صلاحية سنة مع إقامة تصل إلى 90 يوماً حسب شروط التأشيرة الصادرة.';
 if(q.rows.some(row=>row.product==='tourist_single'))text+='\n\n'+EGYPT_SINGLE_COPY;
 text+=`\n*${q.insuranceSubtotal?'إجمالي التأشيرات والتأمين':'إجمالي رسوم التأشيرات'}: ${MONEY(q.subtotal)} درهم*`;
 if(q.groupDiscount)text+='\nتم احتساب سعر المجموعة: '+P.PRICES.touristGroup+' درهماً للشخص.';
 if(q.mixedGroupReview){
  text+='\nالمجموعة فيها أنواع تأشيرات مختلفة؛ أي خصم إضافي يحتاج سياسة معتمدة، ولم يُحتسب تلقائياً.';
  const umrahApplicants=q.rows.filter(r=>r.product==='umrah').map(r=>r.applicant),touristApplicants=q.rows.filter(r=>['tourist_multi','tourist_single'].includes(r.product)).map(r=>r.applicant);
  if(umrahApplicants.length&&touristApplicants.length)text+=`\n📋 *توضيح مسار المستندات للمجموعة المختلطة:*\n• المتقدم (${touristApplicants.join('، ')} — سياحية أونلاين): نحتاج صور واضحة للجواز والهوية والصورة الشخصية هون على واتساب.\n• المتقدم (${umrahApplicants.join('، ')} — عمرة عبر السفارة): يحتاج أصل الجواز وأصل الهوية للمكتب (أو عبر زاجل برسوم 35 درهماً بعد تأكيد نطاق الخدمة) مع الصورة الشخصية.`;
 }
 if(q.paymentFee)text+=`\nرسوم طريقة الدفع: ${MONEY(q.paymentFee)} درهم\n*المجموع بهذه الطريقة: ${MONEY(q.total)} درهم*`;
 else if(q.feePending)text+='\nرسوم وسيلة الدفع تحتاج تأكيداً قبل إصدار رابط الدفع. التحويل البنكي دون عمولة إضافية من المكتب.';
 else text+='\nالتحويل البنكي دون عمولة إضافية من المكتب.';
 if(includeRefund)text+='\n\n'+(refundShown?REFUND_REMINDER:P.REFUND_BENEFIT);
 if(includeRefund&&q.insuranceSubtotal)text+='\nمنوضح شروط استرداد رسم التأمين بشكل منفصل قبل الدفع.';
 if(q.paymentFee||q.feePending)text+='\nرسوم وسيلة الدفع وأي خدمات إضافية تُوضح منفصلة قبل الاتفاق.';
 return text;
}
function caseSummaryCopy(c,completion){
 if(!c.applicantCount&&!c.applicants?.length&&!c.departureDate)return 'لسا ما سجلنا بيانات المتقدمين بملفك 🌷 خبرني بجنسية المسافر وهل معه جواز عادي أو وثيقة سفر وكم شخص بالطلب لنبدأ.';
 const lines=['*ملخص طلب فيزا السعودية المحفوظ لديك 🇸🇦*'];
 const count=Math.min(30,Math.max(c.applicantCount||0,c.applicants?.length||0));
 if(count)lines.push(`• عدد المتقدمين: ${count}`);
 for(let i=0;i<count;i++){
  const p=c.applicants?.[i]||{},doc=p.documentType==='travel_document'?'وثيقة سفر'+(p.documentIssuer?` (${p.documentIssuer})`:''):p.documentType==='passport'?'جواز سفر عادي':'المستند غير محدد',product=p.nationality?P.productFor(p).label:'المسار يُحدد بعد استكمال البيانات';
  lines.push(`• المتقدم ${i+1}: ${p.nationality||'الجنسية غير محددة'} — ${doc} (${product})`);
 }
 if(c.departureDate)lines.push(`• تاريخ السفر المسجل: ${c.departureDate}`);
 if(c.transport)lines.push(`• وسيلة السفر: ${c.transport==='car'?'برًا بالسيارة':'طيران'}`);
 if(c.quote&&!c.quote.requiresReview&&Number.isFinite(c.quote.total))lines.push(`• إجمالي الرسوم المعتمدة: ${MONEY(c.quote.total)} درهم`+(c.quote.feePending?'؛ رسوم وسيلة الدفع تحتاج تأكيداً منفصلاً.':''));
 const evidence=currentVisaEvidence(c);
 if(c.pendingAmendment)lines.push('• الحالة: التعديل المطلوب بانتظار مراجعة القسم قبل اعتماده.');
 else if(evidence.submission)lines.push('• الحالة: تم تقديم الطلب بحسب السجل المتحقق، ومنتابع نتيجته.');
 else if(evidence.payment)lines.push('• الحالة: الدفعة مؤكدة من القسم، ومنتابع استكمال الطلب.');
 else if(c.paymentStatus==='awaiting_verification')lines.push('• الحالة: إشعار التحويل بانتظار التحقق من وصول الدفعة للحساب.');
 else if(c.quote?.reason==='tourist_age_required')lines.push(`• الخطوة التالية: ${completion||'تأكيد أعمار المتقدمين للتسعير.'}`);
 else if(c.quote?.reason==='tourist_age_53_review')lines.push('• الخطوة التالية: تأكيد مبلغ التأمين مع المختص قبل تحديد الإجمالي.');
 else if(c.quote?.requiresReview)lines.push('• الخطوة التالية: مراجعة تسعير الأطفال مع المسؤول قبل تأكيد الإجمالي أو الدفع.');
 else lines.push(completion?`• الخطوة التالية: ${completion}`:'• الحالة: البيانات الأساسية مكتملة وجاهزة لمراجعة المستندات والدفع.');
 return lines.join('\n');
}
// Count weekdays after the start date through the end date, in UTC calendar days.
// Public holidays are not configured here; copy explicitly describes an estimate.
function workingDaysBetween(startMs,endMs){
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)return 0;
 const start=new Date(startMs),end=new Date(endMs);
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))return 0;
 start.setUTCHours(0,0,0,0);end.setUTCHours(0,0,0,0);
 const span=Math.round((end-start)/86400000);let days=Math.floor(span/7)*5;
 for(let i=1;i<=span%7;i++){const day=(start.getUTCDay()+i)%7;if(day!==0&&day!==6)days++;}
 return days;
}
function travelFitCopy(departureDate,nowMs=Date.now(),{deadline=false,language='ar'}={}){
 if(!dateValue(departureDate)||!Number.isFinite(nowMs))return '';
 const today=dubaiDay(nowMs).getTime(),depMs=Date.parse(departureDate+'T00:00:00Z');if(depMs<today)return '';
 const workDays=workingDaysBetween(today,depMs),subject=deadline?'الموعد اللي سألت عنه':'موعد سفرك';
 if(language==='en')return `For ${departureDate}, there ${workDays===1?'is about one working day':`are about ${workDays} working days`} left before public holidays. Processing usually takes 6–7 working days, so I can’t promise issuance by that date.`;
 if(language==='fr')return `Pour le ${departureDate}, il reste environ ${workDays} jour${workDays===1?'':'s'} ouvré${workDays===1?'':'s'}, hors jours fériés. Le délai habituel est de 6–7 jours ouvrés, donc je ne peux pas garantir une délivrance avant cette date.`;
 if(!workDays)return `بخصوص ${subject} (${departureDate})، ما بقي أيام عمل كافية. المعالجة عادةً 6–7 أيام عمل حسب السفارة، فما فيني أوعدك بالصدور قبله.`;
 if(workDays<6)return `بخصوص ${subject} (${departureDate})، باقي تقريبًا ${workDays===1?'يوم عمل واحد':workDays===2?'يومين عمل':`${workDays} أيام عمل`} قبل احتساب العطل الرسمية. المدة المعتادة 6–7 أيام عمل حسب السفارة، فالوقت ضيق وما فينا نضمن الصدور قبله.`;
 return `${subject} (${departureDate}) يتيح حوالي ${workDays} أيام عمل قبل احتساب العطل الرسمية، مقارنة بالمدة المعتادة 6–7 أيام عمل. هالتقدير ما بيضمن الموافقة أو الصدور قبل الموعد.`;
}
class SaudiVisaEngine{
 constructor({store,now=Date.now,understand=null,env=process.env,privateConfig=loadVisaPrivateConfig({env})}={}){
  if(!store?.data||typeof store.save!=='function')throw Error('VISA_STORE_REQUIRED');Object.assign(this,{store,now,understand,env,privateConfig});store.data.visaCases||={};
 }
 getCase(id){return this.store.data.visaCases[id]||null;}
 agePricingEnabled(){return this.env.VISA_TOURIST_AGE_PRICING==='on';}
 status(){return {enabled:true,policyVersion:P.POLICY_VERSION,cases:Object.keys(this.store.data.visaCases).length,feesEnabled:true,touristAgePricing:this.agePricingEnabled()};}
 delete(id){clearCustomerProfile(this.store,id);delete this.store.data.visaConversationScopes?.[id];delete this.store.data.pendingNewVisaMedia?.[id];if(this.store.data.serviceSessions?.[id])delete this.store.data.serviceSessions[id].documentConversation;for(const [key,item]of Object.entries(this.store.data.visaDocumentPreviews?.items||{}))if(item.customer===id)delete this.store.data.visaDocumentPreviews.items[key];delete this.store.data.visaCases[id];if(this.store.data.visaCaseArchives)delete this.store.data.visaCaseArchives[id];if(this.store.data.raadApplications)delete this.store.data.raadApplications[id];if(this.store.data.visaDocumentIntake){delete this.store.data.visaDocumentIntake.cases?.[id];for(const [key,item]of Object.entries(this.store.data.visaDocumentIntake.jobs||{}))if(item.customer===id)delete this.store.data.visaDocumentIntake.jobs[key];}for(const [key,item]of Object.entries(this.store.data.visaDocumentNotifications?.items||{}))if(item.customer===id)delete this.store.data.visaDocumentNotifications.items[key];for(const [key,item]of Object.entries(this.store.data.visaUpload?.sessions||{}))if(item.customer===id)delete this.store.data.visaUpload.sessions[key];for(const [key,item]of Object.entries(this.store.data.visaPreparedDeliveries?.items||{}))if(item.customer===id)delete this.store.data.visaPreparedDeliveries.items[key];this.store.save();}
 save(id,c){c.updatedAt=this.now();this.store.data.visaCases[id]=c;this.store.save();}
 recordDocumentTurn(id,text,reply,{caseId,expectedRevision,hasAttachments=false}={}){
  const current=this.getCase(id);if(!current||current.id!==caseId||current.revision!==expectedRevision)return{reply:null,superseded:true};
  const c=structuredClone(current);c.history||=[];c.history.push({role:'user',text:(hasAttachments?'[attachment received] ':'')+redactVisaText(String(text)).slice(0,1500)},{role:'assistant',text:redactVisaText(String(reply)).slice(0,2500)});c.history=c.history.slice(-16);c.revision++;this.save(id,c);return{reply,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage};
 }
 newCase(){return {id:randomUUID(),service:'saudi_visa',policyVersion:P.POLICY_VERSION,revision:0,stage:'inquiry',createdAt:this.now(),updatedAt:this.now(),applicantCount:null,applicants:[],askedQuestions:[],disclosuresShown:[],history:[],paymentStatus:'unverified',documents:[],submissionStatus:'not_submitted',greeted:false};}
 ask(c,key,text){
  const repeated=c.lastQuestion===key;c.lastQuestion=key;if(!c.askedQuestions.includes(key))c.askedQuestions.push(key);
  const localized=Object.hasOwn(REPLY_QUESTIONS,c.replyLanguage)?REPLY_QUESTIONS[c.replyLanguage](key,{repeated}):null;
  if(localized)return localized;
  return repeated?'حتى نكمل من نفس النقطة: '+text:text;
 }
 nextQuestion(c){
  const nat=c.applicants[0]?.nationality;
  if(!nat)return this.ask(c,'nationality','شو جنسية الشخص اللي بدنا نقدّم له؟');
  if(!c.applicants[0]?.documentType)return this.ask(c,'documentType',`تمام (${nat}) 🌷 معه جواز سفر عادي أو وثيقة سفر؟`);
  if(!c.applicantCount)return this.ask(c,'applicantCount','كم شخص حابب يقدّم بالطلب؟');
  for(let i=0;i<c.applicantCount;i++){
   const p=c.applicants[i]||{};if(!p.nationality)return this.ask(c,'nationality_'+i,`شو جنسية المتقدم ${i+1}؟`);
   if(!p.documentType)return this.ask(c,'documentType_'+i,`المتقدم ${i+1} معه جواز عادي أو وثيقة سفر؟`);
   if(p.documentType==='travel_document'&&!p.documentIssuer)return this.ask(c,'issuer_'+i,`وثيقة المتقدم ${i+1} صادرة من أي بلد؟`);
  }
  if(this.agePricingEnabled()&&!quoteLocked(c)&&!c.hasMinors&&!c.applicants.some(p=>Number.isInteger(p.age)&&p.age<18)){
   const index=c.applicants.findIndex((p,i)=>i<c.applicantCount&&P.touristAgeReviewReason(p)==='tourist_age_required');
   if(index>=0)return this.ask(c,'age_'+index,ageQuestion(index,c.applicantCount,c.replyLanguage));
  }
  return null;
 }
 conversationReply(id,c,text,reply){
  c.revision++;c.history.push({role:'user',text:redactVisaText(text).slice(0,1500)},{role:'assistant',text:redactVisaText(reply).slice(0,2500)});c.history=c.history.slice(-16);this.save(id,c);return{reply,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage};
 }
 ownedApplications(id){
  const cases=[this.getCase(id),...(this.store.data.visaCaseArchives?.[id]||[])].filter(Boolean);
  return Object.values(this.store.data.visaFulfilment?.jobs||{}).filter(job=>job.customer===id&&job.applicationReference&&cases.some(c=>c.id===job.caseId&&currentVisaEvidence(c).signature===job.caseSignature));
 }
 followupReply(id,c,text,intent){
  const jobs=this.ownedApplications(id),reference=applicationReference(text,{awaiting:c.followupAwaitingReference===true,known:jobs.map(job=>job.applicationReference)});
  if(!reference&&intent!=='status'&&intent!=='existing_application')return null;
  if(reference){const matches=jobs.filter(job=>referenceKey(job.applicationReference)===reference);if(matches.length!==1){c.followupAwaitingReference=true;return 'ما قدرت أربط رقم الطلب بملف مقدم من رقم واتسابك الحالي. لخصوصية ملفك، تواصل من نفس الرقم اللي قدمت منه حتى نراجع الطلب الصحيح 🌷 ما في داعي تعيد الأوراق أو الدفع.';}delete c.followupAwaitingReference;return this.applicationUpdate(matches[0]);}
  const currentJobs=jobs.filter(job=>job.caseId===c.id);
  if(currentJobs.length===1){delete c.followupAwaitingReference;return this.applicationUpdate(currentJobs[0]);}
  if(currentJobs.length>1){c.followupAwaitingReference=true;return 'عندك أكثر من طلب محفوظ معنا: '+currentJobs.map(job=>job.applicationReference).slice(0,10).join('، ')+'. أي رقم طلب حابب تتابع؟';}
  const evidence=currentVisaEvidence(c),receipts=this.store.data.visaFulfilment?.cases?.[id]?.receipts||{};
  const received=Object.values(this.store.data.visaMedia||{}).some(r=>r.customer===id&&r.receivedAt>=c.createdAt&&r.expiresAt>this.now()&&['image','document'].includes(r.type)&&!r.purpose&&!Object.hasOwn(receipts,r.id));
  if(intent==='status'&&(c.greeted||received||c.documents?.length||evidence.payment||evidence.submission||c.staffVerification?.decision)){
   const documentStatus=evidence.documents?'reviewed':received||c.documents?.length?'pending':null;
   if(!documentStatus&&!evidence.payment&&!evidence.submission&&!quoteLocked(c)&&!c.staffVerification?.decision){
    c.followupAwaitingReference=true;
    if(c.stage==='quoted'&&Number.isFinite(c.quote?.total))return {
     ar:'العرض جاهز عندي، ولسّا ما في تقديم مسجّل على هالملف. إذا قصدك طلب مقدّم من قبل، ابعت رقم الطلب من نفس رقم واتساب اللي قدمت منه.',
     en:'Your quote is ready. There is no submission recorded on this file yet. If you mean an earlier application, send its reference from the WhatsApp number you used to apply.',
     fr:'Votre devis est prêt. Aucun dépôt n’est enregistré sur ce dossier. Si vous parlez d’une demande précédente, envoyez sa référence depuis le numéro WhatsApp utilisé pour le dépôt.'
    }[c.replyLanguage];
   }
   return visaFollowupCopy(c,{language:c.replyLanguage,documentStatus});
  }
  if(c.paymentStatus==='verified'||c.submissionStatus==='submitted'||c.documents?.length||c.staffVerification?.decision)return null;
  c.followupAwaitingReference=true;return 'أكيد، بساعدك بمتابعة طلبك. ابعت رقم الطلب، وتابع من نفس رقم واتساب اللي قدمت منه حتى نربطه بملفك الصحيح.';
 }
 applicationUpdate(job){
  const c=[this.getCase(job.customer),...(this.store.data.visaCaseArchives?.[job.customer]||[])].find(c=>c?.id===job.caseId),evidence=c&&currentVisaEvidence(c),decision=c?.staffVerification?.decision;
  if(decision?.caseSignature===evidence?.signature&&decision?.value==='approved')return 'طلبك رقم '+job.applicationReference+' مسجل عليه قرار موافقة من القسم. منتابع إرسال التأشيرة إلك.';
  if(decision?.caseSignature===evidence?.signature&&['refused','rejected'].includes(decision?.value))return 'طلبك رقم '+job.applicationReference+' مسجل عليه قرار رفض من القسم. منراجع معك الخطوة التالية حسب سياسة الخدمة.';
  const stamp=[job.savedAt,job.manualCompletion?.at,...(['saved_application','manually_completed'].includes(job.state)?[job.createdAt]:[])].find(value=>Number.isFinite(value)&&value>=0&&value<=this.now());
  const elapsed=stamp===undefined?null:workingDaysBetween(stamp,this.now());
  const timeline=elapsed===null?'':` (مرّ ${elapsed} من أصل 6–7 أيام عمل معتادة حسب السفارة، قبل احتساب العطل الرسمية؛ المدة تقديرية وليست موعد صدور مضموناً)`;
  return 'طلبك رقم '+job.applicationReference+' محفوظ معنا، ومنتابع عليه'+timeline+'. ما وصلنا تحديث مسجل بصدور التأشيرة بعد؛ أول ما تصدر بنبعتها إلك مباشرة 🌷';
 }
 async handle(id,text,{messages=[]}={}){
  text=String(text||'').trim().slice(0,12000);const n=P.normalize(text);let c=structuredClone(this.getCase(id)||this.newCase()),decision=null;
  const agePricing=this.agePricingEnabled();
  const replyLanguage=visaReplyLanguage(text,c.replyLanguage),localConsultation=consultationIntent(text);
  c.replyLanguage=replyLanguage;
  const frenchVisaEntry=!c.greeted&&replyLanguage==='fr'&&/^(?:bonjour[, ]+)?je (?:veux|voudrais|souhaite) (?:demander |obtenir )?un visa (?:touristique )?(?:saoudien|pour (?:l[’']\s*)?arabie saoudite)[.!? ]*$/u.test(n);
  const explicitIdx=explicitApplicantIndex(n);
  const initialRevision=c.revision;
  if(/^(?:احذف بياناتي|امسح بياناتي|حذف بياناتي)$/.test(n)){this.delete(id);return{reply:'تم حذف ملف فيزا السعودية المحفوظ لدينا. إذا عندك معاملة مقدمة فعلياً أو التزام مالي، مراجعتها بتكون مع القسم المختص.',deleted:true,service:'saudi_visa'};}
  const socialReply=standaloneVisaReply(c,text,messages);
  if(socialReply)return this.conversationReply(id,c,text,socialReply);
  if(c.stage==='inquiry'&&!c.applicantCount&&!c.applicants.length&&/^(?:مرحبا|هلا|اهلا|السلام عليكم|hello|hi)[،,!؟?. 🌷]*$/i.test(n)){const welcome=returningGreeting(this.store,id,'saudi_visa',{now:this.now()});if(welcome)return this.conversationReply(id,c,text,welcome);}
  if(!localConsultation&&affirmativeEnglishText(text)!==text&&!Object.keys(parseEnglishVisaFacts(text)).length&&!/[\u0621-\u064a]/.test(text))return this.conversationReply(id,c,text,replyLanguage==='en'?'Which detail would you like to change?':'حتى أفهم قصدك صح، ممكن توضح النقطة اللي حابب تعدّلها؟');
  if(conversationIntent(text)==='case_summary'&&!isComplaint(text)){
   if(agePricing&&!quoteLocked(c))c.quote=P.calculateQuote(c,{feesEnabled:true,agePricing});
   const completion=this.nextQuestion(structuredClone(c));return this.conversationReply(id,c,text,caseSummaryCopy(c,completion));
  }
  if(explicitIdx!==null&&(explicitIdx<0||explicitIdx>=Math.max(c.applicantCount||0,c.applicants.length)))return this.conversationReply(id,c,text,'حتى نعدّل ملف الشخص الصحيح، حدد رقم متقدم واحد من الموجودين بملفك. ما غيّرنا أي بيانات.');
  // General validity guidance must not turn document mentions into applicant facts.
  if(/صلاحي[ته]|كم باقي|ينتهي|تنتهي|انتهاء|expir|validity|valid until/i.test(n)&&/جواز|اقام[هت]|هوي[هت]|passport|residenc[ey]|\beid\b/i.test(n)&&!isComplaint(text)){
   let reply='بالنسبة لصلاحية المستندات المطلوبة للتقديم عبر مجموعة الرمال:\n• *جواز السفر:* 6 أشهر على الأقل عند السفر.\n• *الإقامة / الهوية الخليجية للمقيمين:* نراجع بقاء 3 أشهر على الأقل ضمن متطلبات ملفك.\n\nمنراجع تواريخ المستندات ضمن الملف قبل استكمال الطلب؛ هالإرشاد ما بيؤكد قبول التأشيرة.';
   const dates=extractMentionedExpiryDates(text),ref=readinessReferenceDate(c,this.now()),checks=[checkPassportValidityDate(dates.passportExpiry,ref),checkResidencyValidityDate(dates.residencyExpiry,ref)].filter(Boolean);
   if(checks.length)reply+='\n\n'+checks.map(x=>x.warningCopy).join('\n\n');
   return {...this.conversationReply(id,c,text,reply),intent:'visa_info',validityWarning:checks.some(x=>x.status!=='valid')};
  }
  // Only privacy-filtered conversation text enters semantic understanding.
  // Preserve a real caption/question beside an attachment, never its pixels.
  const hasAttachments=messages.some(m=>m.media),semanticText=conversationText(text,{hasAttachments});
  const previousReply=c.history.at(-1)?.role==='assistant'?c.history.at(-1).text:'';
  const detectedTopics=localVisaInformationTopics(text,{hasAttachments});
  const localTopics=detectedTopics.length>1?detectedTopics:[];
  const timingInquiry=classifyVisaTimingInquiry(text);
  const statedTravelDate=!hasAttachments?declaredVisaTravelDate(text,previousReply,this.now()):null;
  const deadlineText=timingInquiry==='travel_deadline'?visaDeadlineTarget(text):'';
  const explicitDeadline=deadlineText?oneFutureVisaDate(deadlineText,this.now()):null;
  const pendingDocuments=!hasAttachments&&/^(?:لسا |لسه |للحين |بعدني )?(?:ما (?:ارسلت|بعت|بعثت|طرشت|دزيت)|لم ارسل|ما ارسلتش|مابعتش|مبعتش) (?:الاوراق|الورق|المستندات|الصور|الجواز|الهويه)[.! ]*$/u.test(n);
  const documentChoice=!hasAttachments&&/^(?:(?:طيب|هل) )?(?:ارسل|ابعت|ابعث|اطرش|ادز) (?:الجواز|الهويه)(?: (?:ولا|او|ام) (?:الجواز|الهويه)[.!؟? ]*|[ ]*[؟?])$/u.test(n);
  const claimsDocumentsSent=!hasAttachments&&/^(?:(?:انا|اي|تمام)[،, ]+)?(?:ارسلت(?: لك|لكم)?|بعت(?:لكم|لك)?|بعثت|طرشت|دزيت) (?:الجواز|الهويه|الاوراق|الورق|المستندات|الصور)[.! ]*$/u.test(n);
  const documentAcknowledgement=pendingDocuments||documentChoice||claimsDocumentsSent;
  const adviceTopics=dailyVisaTopics(n);
  // Questions mentioning a passport/PDF are not declarations of document type.
  const adviceOnly=localTopics.length>0||timingInquiry==='travel_deadline'&&detectedTopics.length===1||documentAcknowledgement||adviceTopics.length>0&&!P.nationalities(n).length&&!countFrom(n)&&!/(?:جواز|باسبور|باسبورت) عادي|وثيقه|travel document|(?:معي|عندي) (?:جواز|باسبور|باسبورت)|(?:مسافر|رايح|رح سافر|بدي سافر|سفري).*بالسياره/.test(n)&&(adviceTopics.includes('child_passport')||!/طفل|اطفال|رضيع/.test(n));
  // An explicit person correction uses local facts, never a model's group rewrite.
  if(this.understand&&semanticText&&!adviceOnly&&explicitIdx===null){
   try{decision=await this.understand(semanticText,{caseId:c.id,revision:c.revision,lastQuestion:c.lastQuestion,awaiting:c.pendingRelative?.awaiting||c.lastQuestion,departureDate:c.departureDate,returnDate:c.returnDate,applicantCount:c.applicantCount,applicants:c.applicants.map(personFields),transport:c.transport,hasHost:c.hasHost,paymentMethod:c.paymentMethod,history:c.history.slice(-16),stage:c.stage});}catch{}
  }
  // Do not overwrite a case updated by an operator while understanding ran.
  const latest=this.getCase(id);if(latest&&latest.revision!==initialRevision)return{reply:null,superseded:true,caseId:latest.id,revision:latest.revision,service:'saudi_visa'};
  const localIntent=conversationIntent(text),intentForConversation=isComplaint(text)||decision?.intent==='complaint'?'complaint':localIntent||decision?.intent;
  const confirmNew=c.pendingNewApplication&&c.pendingNewApplication.requestedAt+15*60000>this.now()&&c.history.at(-1)?.text.endsWith('تأكدلي: بدك نفتح طلب جديد؟')&&/^(?:نعم|اي|تمام|اوافق|موافق|اكد|نعم طلب جديد|طلب جديد مستقل|yes)(?:[.! ]*)$/.test(n);
  if(c.pendingNewApplication&&/^(?:لا|الغاء|الغيه|خليك عالقديم|متابعه القديم)(?:[.! ]*)$/.test(n)){delete c.pendingNewApplication;return this.conversationReply(id,c,text,'تمام، منكمل على ملفك الحالي. شو حابب تعرف عن طلبك؟');}
  if(confirmNew){
   const jobs=Object.values(this.store.data.visaFulfilment?.jobs||{}).filter(job=>job.customer===id&&job.caseId===c.id),active=jobs.some(job=>!['saved_application','manually_completed','stale','cancelled'].includes(job.state));
   if(active||c.paymentStatus==='verified'&&!jobs.some(job=>['saved_application','manually_completed'].includes(job.state)))return this.conversationReply(id,c,text,'سجلت رغبتك بطلب جديد مستقل. طلبك الحالي ما زال قيد الإجراء؛ يلزم تنسيق فتح الملف الجديد مع الفريق حتى نحافظ على المعاملة والدفعة الحالية.');
   const facts=c.pendingNewApplication.facts;delete c.pendingNewApplication;this.store.data.visaCaseArchives||={};this.store.data.visaCaseArchives[id]||=[];this.store.data.visaCaseArchives[id].push(structuredClone(c));c=this.newCase();c.greeted=true;c.replyLanguage=replyLanguage;mergeFacts(c,facts);
  }else if(intentForConversation==='new_application'&&this.getCase(id)&&!c.pendingRelative){
   c.pendingNewApplication={requestedAt:this.now(),facts:extractLocal(text,this.newCase())};return this.conversationReply(id,c,text,'أكيد، فينا نبدأ طلب جديد مستقل مع الاحتفاظ بطلبك الحالي. تأكدلي: بدك نفتح طلب جديد؟');
  }else{
   const reply=intentForConversation==='complaint'?null:this.followupReply(id,c,text,intentForConversation);if(reply)return this.conversationReply(id,c,text,reply);
  }
  const beforeFacts=JSON.stringify({applicantCount:c.applicantCount,applicants:c.applicants,departureDate:c.departureDate,returnDate:c.returnDate,transport:c.transport,hasHost:c.hasHost,hasMinors:c.hasMinors}),beforeCase=structuredClone(c);
  const asserted=assertedVisaText(text),assertedMatchesTurn=asserted.replace(/[،,؛;.!؟?\s]+/gu,' ').trim()===n.replace(/[،,؛;.!؟?\s]+/gu,' ').trim(),hypothetical=/(?:^|\s)(?:و?لو(?!\s+سمحت)|و?اذا|افترض|لنفترض|فرضنا|مثلا|if|suppose|imagine)(?=\s)/u.test(n);
  const comparisonOnly=localConsultation==='compare_service'&&!/^(?:انا|نحن|نحنا|احنا)\s/u.test(n);
  const aiFields=structuredClone(hypothetical||comparisonOnly?{}:decision?.fields||decision?.facts||{}),localFields=adviceOnly||comparisonOnly?{}:extractLocal(text,c),awaiting=c.lastQuestion;
  if(timingInquiry==='travel_deadline'&&!statedTravelDate)for(const fields of [aiFields,localFields]){delete fields.departureDate;delete fields.returnDate;}
  if(statedTravelDate&&!hypothetical)localFields.departureDate=statedTravelDate;
  const bareAgeAnswer=agePricing&&/^age_\d+$/.test(awaiting||'')&&/^[\p{N}\s.!]+$/u.test(n);
  if(bareAgeAnswer)for(const f of [aiFields,localFields])for(const key of Object.keys(f))delete f[key];
  const paymentInformation=paymentMethodInquiry(text,decision);
  if(paymentInformation){delete aiFields.paymentMethod;delete localFields.paymentMethod;}
  if(/كشف حساب|حساب بنكي للتقديم|bank\s+statement/.test(n))delete aiFields.paymentMethod;
  if(/انا و(?:اهلي|عيلتي|عايلتي|عائلتي|عيالي|اولادي|الاهل)(?=$|[\s،,.؟?!])/.test(n)&&!countFrom(n)){delete aiFields.applicantCount;delete aiFields.applicants;}
  // Country of issue and Palestinian identity describe one traveller, even if
  // a model incorrectly splits them into two applicants.
  if(singlePalestinianDescriptor(n,P.nationalities(n))){delete aiFields.applicants;delete aiFields.applicantCount;delete aiFields.nationality;}
  if(Array.isArray(aiFields.applicants)&&aiFields.applicants.length){for(const key of ['nationality','documentType','documentIssuer','applicants'])delete localFields[key];}
  if(/ايام|اسبوع|شهر|ساعات|دقايق/.test(n)&&!/(?:نحن|نحنا|احنا|صرنا|عددنا|شخص|اشخاص|متقدم|انفار|نفر)/.test(n)){delete aiFields.applicantCount;delete localFields.applicantCount;}
  if(/انتهاء|ينتهي|تنتهي|صلاحيه|expir|validity|valid until/i.test(n)){delete aiFields.departureDate;delete aiFields.returnDate;}
  const awaitingIssuer=awaiting?.startsWith('issuer_')&&explicitIdx===null;
  if(awaitingIssuer)for(const f of [aiFields,localFields]){delete f.nationality;delete f.documentType;delete f.documentIssuer;delete f.applicants;}
  const relativeMention=/(?:^|[^\p{L}])(?:[وبل])?(?:صديق(?:ي|تي|ه|ته|ها|تها)?|رفيق(?:ي|تي|ه|ته|ها|تها)?|صاحبي|زوجتي|مرتي|مراتي|جوزي|الحرمه|والدتي|والدي|امي|ابي|اختي|اخي|اخوي|ابني|بنتي)(?=$|[^\p{L}])/u.test(n),pending=c.pendingRelative,ns=P.nationalities(n);
  const ownCorrection=decision?.correction&&decision?.target==='self'&&!pending||/جنسيتي|انا (?:مو|مش|لست)|بالنسبه الي/.test(n)||/^انا\s/.test(n)&&ns.length===1&&!relativeMention;
  const operational=/حساب|ايبان|بنك|دفع|حولت|ايصال|الغاء|كنسل|ارسل(?:ت)? الاوراق|ابعتلك الاوراق/.test(n);
  const shortRelativeAnswer=pending&&!ownCorrection&&!operational&&text.length<100&&(pending.awaiting==='nationality'&&ns.length===1||pending.awaiting==='documentType'&&/^(?:معه |معو |هو )?(?:(?:جواز(?: سفر)?|باسبور|باسبورت)(?: عادي)?|عادي|وثيقه(?: سفر)?)(?:[.!؟? ]*)$/.test(n)||pending.awaiting==='documentIssuer'&&ns.length===1);
  const relativeFollowup=pending&&!ownCorrection&&!operational&&(/كمان بدن يقدمو|كمان بدهم يقدمو|هنن.*(?:يقدمو|يقدموا)/.test(n)||/حتى|له|الو|بتطلع|بيطلع|تفاصيل/.test(n)&&(!ns.length||ns.includes(pending.facts?.nationality)));
  const explicitGroup=countFrom(n)>1&&/نحن|نحنا|احنا|صرنا|عددنا|انا و/.test(n)||decision?.target==='group'&&Number.isInteger(aiFields.applicantCount)&&aiFields.applicantCount>1;
  const relativeInquiry=explicitIdx===null&&Boolean(c.applicants[0]?.nationality)&&!adviceOnly&&!ownCorrection&&!explicitGroup&&!/(?:ضيف|اضف|اضيف).{0,15}(?:معنا|معي|المجموعه|الطلب)|ضيفها|ضيفه/.test(n)&&(relativeMention||shortRelativeAnswer||relativeFollowup||decision?.target==='other');
  if(relativeInquiry){
   const nextFacts=personFields({...aiFields,...localFields,...(Array.isArray(aiFields.applicants)&&aiFields.applicants.length===1?aiFields.applicants[0]:{})});
   if(shortRelativeAnswer&&pending.awaiting==='documentType'&&/عادي/.test(n))nextFacts.documentType='passport';
   const newPerson=relativeMention&&pending&&(/تاني|ثاني|اخر/.test(n)||nextFacts.nationality&&pending.facts?.nationality&&nextFacts.nationality!==pending.facts.nationality);
   if(newPerson){c.relativeInquiries=[...(c.relativeInquiries||[]),{facts:pending.facts,at:pending.at}].slice(-6);}
   const previous=newPerson?{}:pending?.facts||{};
   if(shortRelativeAnswer&&pending.awaiting==='documentIssuer'){nextFacts.documentIssuer=nextFacts.nationality;delete nextFacts.nationality;}
   c.pendingRelative={facts:{...previous,...nextFacts},at:this.now(),awaiting:pending?.awaiting||null};
   for(const f of [aiFields,localFields])for(const k of Object.keys(f))delete f[k];
  }
  const target=awaiting?.match(/^(nationality|documentType)_(\d+)$/);
  if(explicitIdx!==null){
   for(const f of [aiFields,localFields]){const entry=personFields(f);for(const key of Object.keys(f))delete f[key];if(Object.keys(entry).length)f.applicants=Array.from({length:explicitIdx+1},(_,j)=>j===explicitIdx?entry:{});}
  }else if(target){for(const f of [aiFields,localFields]){if(f[target[1]]){const i=Number(target[2]),entry={[target[1]]:f[target[1]]};if(target[1]==='documentType'){if(f.documentIssuer)entry.documentIssuer=f.documentIssuer;delete f.documentIssuer;delete f.nationality;}f.applicants=Array.from({length:i+1},(_,j)=>j===i?entry:{});delete f[target[1]];}}}
  if(awaiting==='applicantCount'&&/^\d{1,2}$/.test(n)&&explicitIdx===null)localFields.applicantCount=Number(n);
  if(decision?.correction&&aiFields.nationality&&explicitIdx===null){delete localFields.applicants;delete localFields.applicantCount;localFields.nationality=aiFields.nationality;}
  if(c.pendingRelative&&!relativeInquiry&&/(?:ضيف|اضف|اضيف).{0,15}(?:معنا|معي|المجموعه|الطلب)|ضيفها|ضيفه/.test(n)){
   const f=c.pendingRelative.facts,people=Array.isArray(f.applicants)&&f.applicants.length?f.applicants:[f];c.applicants.push(...people.map(personFields));c.applicantCount=(c.applicantCount||1)+people.length;delete c.pendingRelative;
  }
  let independentRelative=false;
  if(c.pendingRelative&&!relativeInquiry&&/طلب مستقل|طلب جديد|منفصل|مستقل/.test(n)){
   const relative=c.pendingRelative.facts;this.store.data.visaCaseArchives||={};this.store.data.visaCaseArchives[id]||=[];this.store.data.visaCaseArchives[id].push({...beforeCase,pendingRelative:undefined});this.store.data.visaCaseArchives[id]=this.store.data.visaCaseArchives[id].slice(-10);
   c=this.newCase();c.greeted=true;c.replyLanguage=replyLanguage;mergeFacts(c,relative);independentRelative=true;
  }
  mergeFacts(c,aiFields);mergeFacts(c,localFields);
  let explicitAge=false;
  if(agePricing&&!relativeInquiry&&!hypothetical&&!independentRelative){
   const {updates}=extractApplicantAgeUpdates(text,{awaiting,applicantCount:c.applicantCount});
   explicitAge=updates.length>0;
   for(const {applicantIndex,age} of updates){
    if(c.applicants[applicantIndex]||applicantIndex===0)c.applicants[applicantIndex]={...c.applicants[applicantIndex],age};
   }
  }
  // Short answers apply only to the field actually requested.
  if(!relativeInquiry&&!adviceOnly&&!hypothetical&&asserted&&explicitIdx===null){
   if(c.lastQuestion?.startsWith('nationality_')){const index=Number(c.lastQuestion.slice(12)),ns=P.nationalities(asserted);if(ns.length===1)c.applicants[index]={...c.applicants[index],nationality:ns[0]};}
   if(c.lastQuestion?.startsWith('documentType_')){const index=Number(c.lastQuestion.slice(13)),doc=/وثيق/.test(asserted)?'travel_document':/عادي|جواز|باسبور|باسبورت|passport/.test(asserted)?'passport':null;if(doc){c.applicants[index]={...c.applicants[index],documentType:doc};if(doc==='passport')delete c.applicants[index].documentIssuer;}}
   if(awaitingIssuer){
    const i=Number(awaiting.slice(7)),issuer=issuerAnswer(n);
    if(issuer&&c.applicants[i]?.documentType==='travel_document')c.applicants[i]={...c.applicants[i],documentIssuer:issuer};
   }
   if(c.lastQuestion==='documentType'&&/^(?:عادي|عاديه|نظامي|جواز عادي|باسبور عادي|باسبورت عادي)$/.test(n)){c.applicants[0]={...c.applicants[0],documentType:'passport'};delete c.applicants[0].documentIssuer;}
  }
  const childMention=/\b(?:child|children|kids?|infants?|baby|babies|minor)\b|طفل|اطفال|رضيع|قاصر|ولدين|ولادي الاثنين|عيالي|اولادي/.test(asserted);
  const childAgeWording=!explicitAge&&/عمره (?:سنه|سنتين|ثلاث|اربع|خمس|ست|سبع|ثمان|تسع|عشر)(?=$|[^\p{L}\p{N}])/u.test(asserted);
  if(!relativeInquiry&&!adviceOnly&&!hypothetical&&(childMention||childAgeWording))c.hasMinors=true;
  let pendingAmendment=false;
  const afterFacts=JSON.stringify({applicantCount:c.applicantCount,applicants:c.applicants,departureDate:c.departureDate,returnDate:c.returnDate,transport:c.transport,hasHost:c.hasHost,hasMinors:c.hasMinors});
  const lockedPrice=agePricing&&!independentRelative&&quoteLocked(beforeCase);
  if(!independentRelative&&(lockedPrice||beforeCase.paymentStatus==='verified'||beforeCase.submissionStatus==='submitted')&&afterFacts!==beforeFacts){
   c.pendingAmendment={facts:JSON.parse(afterFacts),requestedAt:this.now()};for(const k of ['applicantCount','applicants','departureDate','returnDate','transport','hasHost','hasMinors']){if(Object.hasOwn(beforeCase,k))c[k]=beforeCase[k];else delete c[k];}c.stage='amendment_review';pendingAmendment=true;
  }
  c.revision++;const first=!c.greeted;c.greeted=true;let reply='',complaint=false,consultationReply=false,needsUnderstandingReview=false;
  const products=c.applicants.map(P.productFor),hasUmrah=products.some(p=>p.code==='umrah');
  if(lockedPrice){c.quote=beforeCase.quote;c.paymentMethod=beforeCase.paymentMethod;}
  else c.quote=P.calculateQuote(c,{feesEnabled:true,agePricing});
  if(beforeCase.paymentStatus==='verified'&&beforeCase.quote&&(pendingAmendment||beforeFacts===afterFacts)&&c.quote?.total!==beforeCase.quote.total)c.quote=beforeCase.quote;
  const previousQuestion=c.lastQuestion,previousAsked=[...c.askedQuestions],completion=this.nextQuestion(c),nextQuestion=c.lastQuestion,nextAsked=[...c.askedQuestions];
  c.lastQuestion=previousQuestion;c.askedQuestions=previousAsked;
  const intentAliases={documents:'requirements',payment_after:'pay_after_issue',negotiation:'negotiate',bank:'bank_details',payment:'payment_options'};
  const localPrimary=intentAliases[localTopics[0]]||localTopics[0];
  const intent=localIntent||localPrimary||intentAliases[decision?.intent]||(decision?.intent&&decision.intent!=='other'?decision.intent:localConsultation||decision?.intent);
  const recognizedInfo=[...localTopics,...(Array.isArray(decision?.informationIntents)?decision.informationIntents:[])];
  const informationIntents=new Set(recognizedInfo.filter(i=>['price','documents','payment','refund','address','bank','courier','processing_time','visa_duration'].includes(i)).map(i=>intentAliases[i]||i));
  const asks=topic=>intent===topic||informationIntents.has(topic);
  // A clear semantic concern takes priority over the fallback keyword detector.
  // Ordinary questions, paid-case disputes and existing workflow actions keep
  // their established path; no model-written operational prose is rendered.
  const concern=CONSULTATION_INTENTS.includes(intent)?intent:!intent||['other','greeting'].includes(intent)?localConsultation:null;
  const cancellationDenied=/(?:^|[^\p{L}])(?:ما بدي|ما ابي|مابي|ما ابغي|مش عا(?:يز|وز)|مو|مش|لا اريد|لا|ما اشتي).{0,12}(?:الغاء|الغي|كنسل|الغ[ىي]|cancel)/u.test(n),cancellationQuestion=/(?:كم|قديش|بكم|بكام|هل|لو|اذا|شروط|رسوم).{0,25}(?:الغاء|الغي|كنسل|cancel)|(?:الغاء|cancel).{0,15}(?:كم|بكم|رسوم|مجاني)/.test(n);
  const documentStep=detectDocumentStep(n),quoteUnchanged=Boolean(beforeCase.quote&&c.quote&&JSON.stringify(beforeCase.quote)===JSON.stringify(c.quote));
  const refundRequested=asks('refund')||/مسترد|استرداد|ترجع المصاري|ترجعو الرسوم|(?:رفض|انرفض|ترفض).{0,35}(?:رجع|ترجع|يرجع|refund)|\brefund(?:ed|able)?\b|rembours/i.test(n);
  const separatePriceRequest=/(?:كم|بكم|بكام|قديش|شقد|شحال)\s+(?:السعر|سعر|التكلفه|تكلفه|الرسوم|رسوم)|\bhow much (?:does|is)\b|combien co[uû]te/i.test(n);
  const priceRequested=localTopics.length?localTopics.includes('price'):(!refundRequested||separatePriceRequest)&&(/سعر|اسعار|تكلفه|رسوم/.test(n)||/(?:^|[^\p{L}])(?:بكم|بكام|شقد|شحال)(?=$|[^\p{L}])/u.test(n)||/قديش/.test(n)&&!/قديش\s*(?:وقت|يوم|مده)/.test(n)||asks('price'));
  const substantiveCaption=hasAttachments&&semanticText&&(/[؟?]|حسابك|حسابكم|حساب بنكي|الحساب البنكي|ايبان|\bbank\b|كيف احول|بدي احول|كيف ادفع|طرق الدفع/.test(n)||['price','bank_details','payment_options','payment_receipt','pay_after_issue','refund','cancel','address','courier','processing_time','visa_duration'].includes(intent));
  const intervention=reason=>{c.operatorIntervention={reason,at:this.now(),revision:c.revision};};
  c.disclosuresShown=Array.isArray(c.disclosuresShown)?c.disclosuresShown:[];
  const refundShown=c.disclosuresShown.includes('refund');
  const renderQuote=({includeRefund=true}={})=>quoteText(c.quote,{refundShown,language:replyLanguage,includeRefund});
  const checklist=({includeNextStep=false}={})=>{
   const options={route:hasUmrah?'umrah':'tourist',language:replyLanguage,includeNextStep};
   const rows=products.slice(0,c.applicantCount||products.length).map((p,i)=>({applicant:i+1,product:p.code}));
   return visaDocumentChecklist({...options,applicantProducts:rows})||visaDocumentChecklist(options);
  };
  const deadlineConcern=timingInquiry==='travel_deadline';
  const timingDate=explicitDeadline||(!deadlineConcern||!hasVisaDateHint(deadlineText)?c.departureDate:null);
  const fit=timingDate?travelFitCopy(timingDate,this.now(),{deadline:Boolean(explicitDeadline&&!statedTravelDate),language:replyLanguage}):'';
  const processingCopy=({askTravelDate=false,includeFollowup=true}={})=>fit||visaProcessingCopy({language:replyLanguage,repeated:/6[–-]7/.test(previousReply),askTravelDate,deadlineConcern,travelDateKnown:Boolean(fit),includeFollowup});
  const paymentChoices=()=>visaPaymentChoiceCopy({language:replyLanguage,repeated:/5%/.test(previousReply)&&/9%/.test(previousReply),includeNextStep:false});
  const refundCopy=()=>visaRefundCopy({insuranceQuestion:/تامين|insurance|assurance/i.test(n)||Boolean(c.quote?.insuranceSubtotal),language:replyLanguage});
  const priceOverview=()=>touristPriceOverview({language:replyLanguage,includeNextStep:false});
  const dailyCopy=topic=>topic==='insurance'&&agePricing&&(!hasUmrah||products.some(isTourist))
   ?touristInsuranceCopy({age:c.applicantCount===1?c.applicants[0]?.age:undefined,language:replyLanguage,includeNextStep:false}):dailyVisaCopy(topic,hasUmrah);
  const applicationStart=/(?:بدي|كيف|اريد|حابب|حابه|بدنا|بدنا ن|بدي ا).{0,12}(?:ثبت|تثبيت)|^(?:ثبت|ثبتلي|تثبيت)$/.test(asserted);
  const linkRequested=!paymentInformation&&/(?:رابط|لينك|link).{0,15}(?:دفع|pay)|(?:بدي|ارسل|ابعت|اريد|عطيني|ممكن).{0,15}(?:رابط|لينك)|^(?:رابط|لينك)$/.test(asserted);
  const tabbyRequested=!paymentInformation&&/تابي|tabby/.test(asserted)&&!/طرق|خيارات|وسائل/.test(n);
  const bankRequested=(/حسابات|حسابك|حسابكم|حساب بنكي|الحساب البنكي|ايبان|iban|bank details|بدي احول|كيف احول/.test(n)||intent==='bank_details')&&!/كشف حساب|حساب بنكي للتقديم/.test(n);
  const paymentActionRequested=!refundRequested&&(applicationStart||linkRequested||tabbyRequested||bankRequested);
  const pendingPrice=agePricing&&!lockedPrice&&(!c.quote||c.quote.requiresReview||c.quote.insuranceRefundPolicy==='pending_confirmation');
  const paymentCopy=()=>pendingPrice
   ?[c.quote?.requiresReview?renderQuote():c.quote?.insuranceSubtotal?'قبل الدفع، منأكد لك شروط استرداد رسوم التأمين الصحي بشكل منفصل.':'خلّينا نأكد تكلفة ملفك أول، وبعدها منرتّب طريقة الدفع.',completion].filter(Boolean).join('\n\n')
   :SERVICE.response('bank');
  if(hasUmrah&&P.umrahQuestion(text))reply=P.umrahConsultation(c.applicants.find(p=>P.productFor(p).code==='umrah'),{objection:true});
  else if(lockedPrice&&paymentActionRequested)reply=currentVisaEvidence(c).payment?'دفعتك مؤكدة على هالطلب، ما في داعي تدفع مرة ثانية.':beforeCase.paymentStatus==='awaiting_verification'?'تحويلك قيد المراجعة. منأكد لك الاستلام بعد المطابقة.':'خلّينا نراجع حالة طلبك الحالي قبل أي دفعة إضافية.';
  else if(pendingPrice&&paymentActionRequested){
   if(c.quote?.reason==='tourist_age_53_review'||c.quote?.insuranceSubtotal)intervention('untrained_request');
   reply=paymentCopy();
  }
  else if(!refundRequested&&applicationStart)reply=SERVICE.applicationStart(hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS);
  else if(!refundRequested&&linkRequested){intervention('payment_link');reply=SERVICE.response('link')+(c.quote&&!c.quote.requiresReview?'\n\n'+renderQuote():'');}
  else if(!refundRequested&&tabbyRequested){intervention('tabby');reply=SERVICE.response('tabby')+(c.quote&&!c.quote.requiresReview?'\n\n'+renderQuote():'');}
  else if(!concern&&(intent==='negotiate'&&!hypothetical&&assertedMatchesTurn||/خصم|تخفيض|ارخص|اخر سعر/.test(asserted))){intervention('discount');reply=SERVICE.response('discount')+'\n'+P.REFUND_BENEFIT;}
  else if(isComplaint(text)||intent==='complaint'){
   complaint=true;c.stage='complaint_pending';reply='حقك علينا، ومنفهم انزعاجك 🌷 رح أرفع المحادثة لإدارة المكتب لمراجعة المعاملة والدفعات المرتبطة فيها بشكل عاجل، من دون ما تحتاج تعيد التفاصيل.';
  }else if(relativeInquiry&&!operational&&concern!=='clarify_question')reply=relativeReply(c.pendingRelative,{question:text,group:/كمان بدن يقدمو|كمان بدهم يقدمو|هنن.*(?:يقدمو|يقدموا)/.test(n)});
  else if(pendingAmendment)reply=beforeCase.paymentStatus==='awaiting_verification'?'وصل طلب التعديل. بما إن التحويل قيد المراجعة، منراجع التعديل مع القسم قبل تأكيد أي مبلغ جديد.':'وصل طلب التعديل 🌷 لأن الدفعة مؤكدة أو المعاملة مقدمة، حفظنا التعديل للمراجعة مع القسم قبل اعتماده. بيانات المعاملة والدفعة الحالية بقيت محفوظة؛ ما تم تعديل تقديم أو احتساب دفعة جديدة تلقائياً.';
  else if(concern&&!hasAttachments){
   const renderConcern=REPLY_CONCERNS[replyLanguage];
   reply=renderConcern(concern,c,{text,completion,nextQuestion,refundShown,includeNextStep:informationIntents.size===0});
  }
  else if(intent==='case_summary')reply=caseSummaryCopy(c,completion);
  else if(!first&&(/^(?:مرحبا|هلا|اهلا(?: وسهلا)?|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?|هاي|hello|hi|صباح الخير|مساء الخير)[،,!؟?. 🌷]*$/i.test(n)))reply='أهلاً فيك 🌷 أنا معك، ومنكمل على نفس طلب التأشيرة.';
  else if(intent==='address'||/عنوان|وين مكتب|مكان المكتب|موقع المكتب|location|address/.test(n))reply=SERVICE.OFFICE;
  else if(intent==='status'||/حاله الطلب|حاله المعامله|تم التقديم|تقدم الطلب|وصلت الدفعه/.test(n)){
   const verified=c.staffVerification||{},evidence=currentVisaEvidence(c);
   if(verified.decision&&verified.decision.caseSignature===evidence.signature)reply=(verified.decision.value||verified.decision)==='approved'?'بحسب تحديث القسم المسجل، صدر قرار الموافقة على طلبك. تسليم التأشيرة وتفاصيلها يكون من القسم المختص.':'بحسب تحديث القسم المسجل، صدر رفض رسمي لطلبك. تتم مراجعة الاسترداد وفق سياسة المكتب؛ لا يعني هذا أن التحويل المالي نُفّذ.';
   else if(c.submissionStatus==='submitted'&&evidence.submission)reply='بحسب تأكيد القسم المسجل، تم تقديم المعاملة فعلياً وهي بانتظار النتيجة. لا يوجد قرار مسجل حتى الآن.';
   else reply=visaFollowupCopy(c,{language:replyLanguage});
  }
  else if(/(?:دفع|بدفع|الدفع).{0,15}(?:بعد|لما|بس).{0,15}(?:اصدار|تطلع|تجهز|تصدر)|بعد الاصدار/.test(n)||intent==='pay_after_issue')reply='منفهم رغبتك 🌷 التقديم عنا بيبدأ بعد استكمال الأوراق وتسديد الرسوم، وما عنا دفع بعد الإصدار. فيك تختار التحويل البنكي دون عمولة إضافية أو تطلب تفاصيل وسائل الدفع الأخرى.';
  else if(/(?:انا|نحن|نحنا).{0,15}(?:مقدم|قدمنا|قدمت)|متابعه معامل|وين معاملتي|طلعت معاملتي|طلعت الفيزا|شو صار بالطلب/.test(n)||intent==='existing_application')reply='أهلاً فيك 🌷 لمتابعة معاملتك الحالية وحماية خصوصية ملفك، ابعتلنا رقم الطلب وتواصل من نفس الرقم اللي قدّمت منه ومع نفس رقم الشركة اللي استلم بياناتك، حتى يراجع القسم المختص ملفك والدفعات المرتبطة فيه.';
  else if(cancellationDenied){
   if(c.cancellation?.state==='awaiting_confirmation')c.cancellation.state='withdrawn';
   reply='تمام، فهمت إنك ما بدك إلغاء. منكمل على ملفك الحالي، وما سجلنا طلب إلغاء جديد.';
  }else if(cancellationQuestion){
   reply='رسوم الإلغاء المعتمدة '+MONEY(P.PRICES.cancellation)+' درهم لكل معاملة ملغاة، ونراجع حالة الطلب والدفعات قبل تحديد المبلغ القابل للاسترداد. سؤالك عن الشروط ما بيسجل طلب إلغاء.';
  }else if(/الغاء|الغي|كنسل|الغ[ىي]|بدي الغي|cancel/.test(asserted)||intent==='cancel'&&!hypothetical&&assertedMatchesTurn){
   c.cancellation={state:'awaiting_confirmation',feePerApplication:P.PRICES.cancellation,requestedAt:this.now()};
   reply='أكيد، فينا نراجع طلب الإلغاء 🌷 رسوم الإلغاء 200 درهم لكل معاملة ملغاة. قبل التأكيد منتحقق من حالة التقديم والدفعات ومنوضحلك المبلغ الصافي القابل للاسترداد. تحب نسجل طلب مراجعة الإلغاء؟ لم يتم إلغاء معاملة أو تنفيذ استرداد.';
  }else if(c.cancellation?.state==='awaiting_confirmation'&&/^(?:اي|نعم|تمام|اكد|اوافق|موافق)(?:[.! ]*)$/.test(n)&&c.history.at(-1)?.text.includes('تحب نسجل طلب مراجعة الإلغاء؟')){
   c.cancellation.state='review_requested';c.stage='cancellation_review';reply='وصل تأكيدك 🌷 سجلنا طلب مراجعة الإلغاء برسوم 200 درهم لكل معاملة ملغاة. يلزم مراجعة القسم لحالة المعاملة والمبلغ القابل للاسترداد قبل تنفيذ الإلغاء؛ لم يُنفّذ إلغاء أو تحويل مالي بعد.';
  }else if(pendingDocuments)reply='ولا يهمك. لما تجهز الأوراق، ابعتها هون ومنكمّل معك.';
  else if(documentChoice)reply=checklist({includeNextStep:true});
  else if(claimsDocumentsSent)reply=visaDocumentsSentCopy({language:replyLanguage});
  else if(hasAttachments&&!substantiveCaption){
   const sourceIds=new Set(messages.filter(m=>['image','document'].includes(m.media?.type)).map(m=>m.media.id));
   const receipts=this.store.data.visaFulfilment?.cases?.[id]?.receipts||{};
   const stored=Object.values(this.store.data.visaMedia||{}).some(r=>r.customer===id&&sourceIds.has(r.sourceId)&&r.expiresAt>this.now()&&!r.purpose&&!Object.hasOwn(receipts,r.id));
   if(stored&&!c.staffVerification?.documentsReviewed&&c.submissionStatus!=='submitted')c.stage='documents_pending_review';
   reply=stored?'وصل المرفق. منراجع إذا الصورة واضحة وإذا بقي شي ناقص.':visaDocumentsSentCopy({language:replyLanguage});
  }else if(/(?:حولت|دفعت|سددت|تم التحويل|طرشت التحويل|طرشت الايصال|دزيت التحويل|بعت الايصال)/.test(asserted)&&!/(?:هل|يعني|كيف)\s.*(?:حولت|دفعت|سددت)/.test(asserted)||intent==='payment_receipt'&&!hypothetical&&assertedMatchesTurn&&!/(?:هل|يعني|كيف)\s.*(?:حولت|دفعت|سددت)/.test(n)){
   const paymentEvidence=currentVisaEvidence(c);
   const receiptReceived=Object.values(this.store.data.visaFulfilment?.cases?.[id]?.receipts||{}).some(r=>r.caseId===c.id&&r.caseSignature===paymentEvidence.signature);
   reply=visaPaymentReceiptCopy(c,{language:replyLanguage,receiptReceived,repeated:c.paymentStatus==='awaiting_verification'});
   if(!paymentEvidence.payment&&c.submissionStatus!=='submitted'){c.paymentStatus='awaiting_verification';c.stage='payment_review';}
  }else if(refundRequested)reply=refundCopy();
  else if(bankRequested)reply=paymentCopy();
  else if(adviceTopics.length&&!products.some(p=>['suspended','unverified'].includes(p.code))){
   const insuranceOnly=agePricing&&adviceTopics.length===1&&adviceTopics[0]==='insurance';
   consultationReply=true;reply=[...adviceTopics.map(dailyCopy),!insuranceOnly&&c.quote&&(priceRequested||afterFacts!==beforeFacts)?renderQuote():null,completion].filter(Boolean).join('\n\n');
   if(adviceTopics.includes('visitor'))intervention('untrained_request');
  }
  else if(timingInquiry||asks('processing_time')||!asks('visa_duration')&&!/مده الاقامه|مده الفيزا|مده التاشيره|صلاحيه الفيزا|صلاحيه التاشيره/.test(n)&&/كم يوم|قديش وقت|مده|مدة|متي تطلع|ايمت تطلع|بسرعه|مستعجل|بكرا|اليوم/.test(n))reply=processingCopy({askTravelDate:!fit&&/بسرعه|مستعجل|بكرا|اليوم|قريب|urgent|tomorrow|demain/i.test(n)});
  else if(/زاجل|توصيل|استلام الجواز|ابعت مندوب/.test(n)||intent==='courier')reply='فينا ننسّق استلام أصل الجواز والهوية عن طريق زاجل برسوم 35 درهماً، أو بتسلمهم بالمكتب. قبل ترتيب الاستلام منأكد معك نطاق الخدمة وهل الإعادة مشمولة؛ ما حُجز مندوب بعد.';
  else if(paymentInformation||/كيف ادفع|طرق الدفع|طريقه الدفع|وسائل الدفع/.test(n)||intent==='payment_options')reply=paymentChoices();
  else if(/90|تسعين|مده الاقامه|مده الفيزا|مده التاشيره|صلاحيه الفيزا|صلاحيه التاشيره|كم شهر|كل دخول/.test(n)||asks('visa_duration'))reply='السياحية المتعددة في عرضنا صلاحيتها سنة، والإقامة تصل إلى 90 يوماً حسب شروط التأشيرة الصادرة. صلاحية السنة تختلف عن مدة الإقامة؛ ما منعتبر الـ90 يوماً تلقائياً لكل دخول. السفرة الواحدة والعمرة إلهم شروط مختلفة حسب التأشيرة الفعلية.';
  else if(documentStep==='will_send')reply='تمام، ابعتهن هون لما تجهز، ومنكمل على نفس طلبك.';
  else if(documentStep==='requirements'||documentStep==='apply'&&quoteUnchanged||/اوراق|مطلوب|مستندات|كيف اقدم|طريقه التقديم/.test(n)||intent==='requirements')reply=checklist({includeNextStep:!completion})+(completion?'\n\n'+completion:'');
  else if(/غالي|خصم|ارخص|زبط|نزل|فاصل|600|٦٠٠|650|٦٥٠/.test(n)||intent==='negotiate')reply=agePricing
   ?['منوضح لك الرسوم قبل ما تقرر. التحويل البنكي دون عمولة إضافية من المكتب.',c.quote?renderQuote():priceOverview(),completion].filter(Boolean).join('\n\n')
   :'تكرم عينك 🌷 السعر المعتمد للسياحية 640 درهم للشخص. العمرة 850 درهماً للشخص. ما في خصم إضافي غير المعتمد، والتحويل البنكي بيوفر عليك رسوم طريقة الدفع.'+(c.quote?'\n\n'+renderQuote():products.some(p=>['suspended','unverified'].includes(p.code))?'':'\n\n'+P.REFUND_BENEFIT);
  else if(/برجع|بعدين|وقت تاني|مو هلق|لاحقا|بفكر/.test(n)||intent==='goodbye')reply='أهلاً وسهلاً فيك بأي وقت 🌷 بس تكون جاهز ابعتلنا، ومنكمل من آخر نقطة وصلنالها.';
  else if(/^(?:شكرا|شكراً|يسلمو|مشكور|تسلم)[!. 🌷]*$/.test(n)||intent==='thanks')reply='أهلاً وسهلاً فيك، بالخدمة دائماً 🌷';
  else if(/منتظر|ناطر|بانتظار|جاري/.test(n)||intent==='waiting')reply='شكراً لانتظارك 🌷 تفاصيلك موجودة معنا. '+(c.stage==='documents_pending_review'?'المستندات بانتظار المراجعة، ومنأكدلك الخطوة التالية بعد التحقق.':completion||'إذا حابب نكمل، فينا نرتب مراجعة الأوراق وطريقة الدفع.');
  else if(products.some(p=>p.code==='suspended'))reply='حسب حالة التقديم الحالية لدى مكتبنا، التقديم لهذه الجنسية متوقف حالياً. ما رح نطلب منك دفع أو نعطيك وعد بموعد فتح قبل وجود تحديث معتمد.';
  else if(products.some(p=>p.code==='unverified')&&c.applicants[0]?.nationality){intervention('untrained_request');reply='حتى أعطيك مسار تقديم دقيق، رح أراجع هالجنسية أو الوثيقة مع المسؤول ونرجعلك. ما منطلب منك دفع قبل التحقق 🌷';}
  else if(statedTravelDate&&c.departureDate===statedTravelDate&&!priceRequested&&!hasAttachments&&!relativeInquiry)reply=travelFitCopy(statedTravelDate,this.now(),{language:replyLanguage});
  else if((intent==='other'||!intent)&&!informationIntents.size&&!priceRequested&&!bareAgeAnswer&&semanticText&&!documentStep&&afterFacts===beforeFacts&&!frenchVisaEntry&&!/^(?:(?:فيزا|تاشيره)(?: السعوديه)?|سلام|مرحبا|هلا|اهلا|السلام عليكم)[؟?!. ]*$/.test(n)){intervention('untrained_request');c.operatorIntervention.understandingFailed=true;needsUnderstandingReview=true;reply=SERVICE.response('unknown');}
  else if(completion){
   const price=priceRequested;
   const known=products[0];
   reply=(agePricing&&nextQuestion?.startsWith('age_')?priceOverview()+'\n\n':price?(agePricing?priceOverview():'السياحية 640 درهم للشخص، والعمرة 850 درهماً.\n\n'+P.REFUND_BENEFIT)+'\n\n':known?.code==='umrah'?P.UMRAH_ROUTE+' التكلفة 850 درهم، والتقديم بأصل الجواز وأصل الهوية. ':known?.code==='tourist_single'?EGYPT_SINGLE_COPY+' ':'')+completion;
  }else{
   if(!c.staffVerification?.decision&&c.submissionStatus!=='submitted'&&c.paymentStatus!=='verified')c.stage=c.paymentStatus==='awaiting_verification'?'payment_review':'quoted';c.lastQuestion=null;
   if(quoteUnchanged&&!priceRequested&&afterFacts===beforeFacts&&!c.quote?.requiresReview)reply=SHORT_REPLIES[replyLanguage].acknowledgement;
   else{
    reply=hasUmrah&&c.applicantCount===1?P.umrahConsultation(c.applicants.find(p=>P.productFor(p).code==='umrah')):renderQuote();
    if(c.quote?.requiresReview){c.stage='pricing_review';intervention('untrained_request');}
    else if(agePricing&&touristQuoteCopy(c.quote,{language:replyLanguage,includeNextStep:false})){
     if(!priceRequested)reply+='\n\n'+{ar:'إذا مناسبك، ابعت صور المستندات ومنراجعها سوا.',en:'If that works for you, send clear photos of the documents and we’ll review them.',fr:'Si cela vous convient, envoyez des photos lisibles des documents pour vérification.'}[replyLanguage];
    }
    else if(!(hasUmrah&&c.applicantCount===1))reply+=(c.quote.mixedGroupReview?'':'\n\n'+(hasUmrah?P.UMRAH_DOCS:P.TOURIST_DOCS))+'\n\n⏱️ المدة المعتادة 6–7 أيام عمل حسب السفارة، دون ضمان للموافقة أو موعد الصدور.'+(c.departureDate?'\n\n'+travelFitCopy(c.departureDate,this.now()):'')+'\n\n'+(c.quote.mixedGroupReview?'خلّينا نبدأ حسب مسار كل متقدم 🌷 ابعت صور مستندات السياحية هون، ومننسق استلام أصول مستندات متقدمي العمرة بعد تأكيد طريقة التسليم.':hasUmrah?'خلّينا نبدأ بالخطوة المناسبة إلك 🌷 بتفضّل تسلّم أصل الجواز والهوية بالمكتب، أو ننسّق استلامهم عبر زاجل برسوم 35 درهماً؟':'خلّينا نبدأ بخطوة بسيطة 🌷 ابعت صور المستندات المطلوبة هون، ومنراجعها معك قبل استكمال التقديم.');
    else if(c.departureDate)reply+='\n\n'+travelFitCopy(c.departureDate,this.now());
    if(hasUmrah&&c.transport==='air'&&!c.quote?.requiresReview)reply+='\n\n✈️ بما أن السفر بالطيران بمسار العمرة يتطلب تذكرة طيران مؤكدة ذهاب وعودة، يمكن لقسم الطيران في مجموعة الرمال مساعدتك بتجهيزها بالتنسيق مع موعد التأشيرة إذا رغبت.';
   }
  }
  const compoundInfo=[
   ['processing_time',timingInquiry||/كم يوم|قديش وقت|متي تطلع|ايمت تطلع|مده المعالجه/.test(n)||asks('processing_time'),processingCopy({includeFollowup:!(priceRequested&&completion)})],
   ['courier',/زاجل|توصيل|استلام الجواز|ابعت مندوب/.test(n)||asks('courier'),'فينا ننسّق استلام أصول المستندات عبر زاجل برسوم 35 درهماً بعد تأكيد نطاق الخدمة؛ لم يُحجز مندوب.'],
   ['payment_options',/كيف ادفع|طرق الدفع|وسائل الدفع/.test(n)||asks('payment_options'),paymentChoices()],
   ['bank_details',!lockedPrice&&!hasAttachments&&!refundRequested&&!/كشف حساب|حساب بنكي للتقديم|bank statement/.test(n)&&(bankRequested||informationIntents.has('bank_details')),paymentCopy()],
   ['address',/عنوان|وين مكتب|مكان المكتب|موقع المكتب|location|address/.test(n)||asks('address'),SERVICE.OFFICE],
   ['visa_duration',/مده الاقامه|مده الفيزا|كم شهر|كل دخول/.test(n)||asks('visa_duration'),'صلاحية السياحية المتعددة سنة، والإقامة تصل إلى 90 يوماً حسب التأشيرة الصادرة؛ السفرة الواحدة والعمرة تختلف شروطهما.'],
   ['requirements',!documentAcknowledgement&&(/اوراق|مطلوب|مستندات/.test(n)||asks('requirements')),checklist()],
   ['refund',refundRequested,refundCopy()]
  ].filter(([topic,yes])=>yes&&(!localTopics.length||informationIntents.has(topic)));
  const simpleRefund=refundRequested&&!concern&&!priceRequested&&compoundInfo.every(([topic])=>topic==='refund');
  const inquiryAlongsideApply=intent==='apply'&&informationIntents.size>0&&!paymentActionRequested&&!applicationStart;
  if(!simpleRefund&&!hasAttachments&&!pendingAmendment&&!relativeInquiry&&!complaint&&(compoundInfo.length||informationIntents.has('price'))&&(informationIntents.size||consultationReply||afterFacts!==beforeFacts||compoundInfo.length>1||priceRequested)&&(inquiryAlongsideApply||concern||consultationReply||!intent||['processing_time','courier','payment_options','bank_details','address','visa_duration','requirements','price','refund','other'].includes(intent))){
   const includeQuote=c.quote&&(!concern&&(priceRequested||!localTopics.length&&afterFacts!==beforeFacts)||informationIntents.has('price')&&(!refundRequested||priceRequested));
   const concernCopy=concern?(includeQuote?reply.replace(P.REFUND_BENEFIT,'').replace(REFUND_BENEFIT_EN,'').replace(REFUND_REMINDER_EN,'').trim():reply):null;
   const byTopic=new Map(compoundInfo.map(([topic,,copy])=>[topic,copy]));
   if(includeQuote)byTopic.set('price',renderQuote({includeRefund:!byTopic.has('refund')}));
   else if(priceRequested&&!c.quote&&!concern&&informationIntents.has('price'))byTopic.set('price',products.some(p=>['suspended','unverified'].includes(p.code))?'خلّينا نتأكد أولًا من مسار التقديم المتاح لحالتك حتى أعطيك سعر دقيق.':hasUmrah?`رسوم العمرة ${P.PRICES.umrah} درهم للشخص. قيد التأكيد حسب بيانات المتقدم.`:agePricing?priceOverview():`رسوم السياحية ${P.PRICES.tourist} درهم للشخص. منأكد نوع التأشيرة بعد ما نعرف بيانات المتقدم.`);
   const ordered=[...new Set([...informationIntents,...byTopic.keys()])].map(topic=>byTopic.get(topic)).filter(copy=>copy&&(!concernCopy||!concernCopy.includes(copy)));
   const followup=concern?priceRequested&&!c.quote&&!['hesitation','clarify_question'].includes(concern)?completion:null:(localTopics.length||timingInquiry)&&!priceRequested?null:completion;
   reply=[concernCopy,...(consultationReply?adviceTopics.map(dailyCopy):[]),...ordered,followup&&!ordered.some(copy=>copy.includes(followup))?followup:null].filter(Boolean).join('\n\n');
  }
  // Mark only disclosures present in the final reply, not branches overwritten above.
  if(reply.includes(P.REFUND_BENEFIT)||reply.includes(REFUND_BENEFIT_EN)||reply.includes(REFUND_REMINDER_EN)||reply.includes(REFUND_REMINDER)||reply.includes(REFUND_COPY[replyLanguage])){
   if(refundShown)reply=reply.replaceAll(P.REFUND_BENEFIT,REFUND_REMINDER);
   if(!refundShown)c.disclosuresShown.push('refund');
  }
  if(completion&&reply.includes(completion)){c.lastQuestion=nextQuestion;c.askedQuestions=nextAsked;}
  if(first)reply=REPLY_INTROS[replyLanguage]+'\n\n'+reply;
  c.history.push({role:'user',text:(hasAttachments?'[attachment received]'+(semanticText?' '+semanticText:''):redactVisaText(text)).slice(0,1500)},{role:'assistant',text:redactVisaText(reply).slice(0,2500)});c.history=c.history.slice(-16);
  this.save(id,c);if(c.stage==='quoted')rememberVisaJourney(this.store,id,c,{now:this.now()});return{reply,complaint,caseId:c.id,revision:c.revision,service:'saudi_visa',stage:c.stage,quote:c.quote,resolved:reply.includes('*عرض تأشيرات السعودية')||consultationReply||compoundInfo.length>0&&!completion,...(needsUnderstandingReview?{needsUnderstandingReview:true}:{})};
 }
}
module.exports={SaudiVisaEngine,extractLocal,mergeFacts,countFrom,isComplaint,quoteText,caseSummaryCopy,workingDaysBetween,travelFitCopy};
