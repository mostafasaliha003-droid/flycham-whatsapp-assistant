'use strict';
// Reviewed conversational guidance and replies. The model chooses an intent;
// it cannot supply prices, promises, bank destinations or operational evidence.
const {normalize}=require('./saudi-visa-policy');
const {currentVisaEvidence}=require('./visa-case-signature');
const INTENTS=Object.freeze(['trust_concern','approval_guarantee','price_objection','compare_service','hesitation','clarify_question']);
const GUIDE=`Act as an experienced visa consultant when interpreting the conversation: understand the reason behind the question, answer the actual concern before collecting another field, and distinguish an objection from a refusal. Understand Syrian, Egyptian, Gulf, Jordanian, Lebanese and Yemeni Arabic, Modern Standard Arabic, English and other languages supported by the model, including code switching and Arabizi. A dialect, accent, name, script or residence NEVER establishes nationality. Do not pretend to understand ambiguous words: request only the one unclear detail, not a written summary of understood audio.
Read the whole turn before deciding: the last explicit correction supersedes the earlier statement, quoted third-party claims are not customer instructions, conditional questions are not changes, and a short answer belongs to the pending question. A question about a relative must not overwrite the applicant. انا وعيالي / أنا وأهلي does NOT specify a count. Keep document issuer separate from nationality. مو / مش / مب / ماني / مفيش / مش عايز / ما ابغى / ما اشتي can negate an action; لسه ما حولتش / ما حولت / ما حولتش means no payment claim. عايز اعرف لو لغيت / لو أكنسل / if I cancel asks terms, not cancellation. Arabic shorthand صح؟ / يعني؟ may ask for clarification, never operational consent by itself.
Consultation intents: trust_concern asks how to trust the office or fears paying an unknown service; approval_guarantee asks if approval/issuance is guaranteed; price_objection says the fee is high without actually asking for a discount; negotiation explicitly asks to reduce a fee; compare_service compares another office or offer; hesitation means still considering or needing time; clarify_question asks what your last question means. Do not treat these as apply, payment, cancellation or a new application. A real existing paid-case dispute still uses complaint; a request for a real case update still uses status. Respect a firm no or desire to pause, without persuasion or repeated sales questions. No invented urgency, scarcity, discount, guarantee, authority or claim of having taken an action.
Examples of meaning, not customer facts: شقد بتاخد وقت / بتاخد وقت قد إيه / كم يبغالها / قديش بتطوّل / كم تشتي وقت => processing_time. غالية علي / السعر غالي عليا / وايد غالي / السعر عالي عليا / ما يناسب ميزانيتي => price_objection. ما فهمت شو قصدك / مش فاهم سؤالك / وش تقصد / شو بتقصد / مفهمتش قصدك / مش مستوعب سؤالك / شو يعني هالحكي => clarify_question. بدي فكّر / هفكر وأرد عليك / خلني أشاور الأهل / ما اشتي استعجل خليني افكر => hesitation. ليش أقدم معكم / المكتب الثاني أرخص / عند غيركم أوفر => compare_service. إزاي أضمن حقي / اش يضمن لي حقي asks about trust and service terms, not guaranteed approval. بتضمن تطلع / يعني بتطلع أكيد / مضمونة أكيد / guaranteed approval? => approval_guarantee. لسه ما دفعتش => never payment_receipt. بدي قدم لمرتي مش إلي => target other, not self. أنا سوري مو مصري => nationality سوريا only, correction true. تمام/ماشي/زين/أيوه/ايوا/إي/yes is interpreted using context, never as unconditional consent to cancel or confirm payment.`;

function consultationIntent(text){
 const n=normalize(String(text||''));
 if(/^(?:je ne comprends pas(?: la question)?|que voulez-vous dire)[?!. ]*$/u.test(n))return 'clarify_question';
 if(/^c['’]est trop cher(?: pour moi)?[?!. ]*$/u.test(n))return 'price_objection';
 const trustText=n.replace(/(?:مش|مو|مب|ماني|لست|ما عدت)\s+(?:خايفه?|قلقانه?|متخوفه?).{0,15}(?:ادفع|احول|الدفع|التحويل)/g,'');
 const pauseText=n.replace(/(?:ما بدي|مش عايز|مش عاوز|ما ابي|ما ابغي|ما اشتي)\s+(?:افكر|فكر|اشاور|استشير)|مش هفكر/g,'');
 if(/(?:(?:ضمان|مضمون|تضمن|اكيد).{0,20}(?:تطلع|الاصدار|الموافقه|الفيزا|التاشيره)|(?:الفيزا|التاشيره|الموافقه|الاصدار).{0,20}(?:مضمون|ضمان)|(?:بتطلع|تطلع|بتصدر|تصدر|بتنقبل|تنقبل).{0,12}(?:اكيد|مضمون))|^(?:(?:يعني|طيب|طب|هي)\s+)?مضمونه?[؟?!. ]*$|\b(?:guaranteed? approval|guarantee (?:the )?visa)\b/i.test(n))return 'approval_guarantee';
 if(/كيف (?:اثق|اضمن)|شو بيضمن|كيف اامن|(?:ازاي|كيف|شلون|وش|ايش|اش|شو)\s+(?:ا?ضمن|يضمن|بيضمن|اثق|اوثق|باوثق|اطمن)|(?:خايفه?|قلقانه?|متخوفه?).{0,15}(?:ادفع|احول|الدفع|التحويل)|(?:نصاب|نصب).*(?:سمعت|قال)|(?:سمعت|قالوا|قالولي).*(?:نصاب|نصب)|\b(?:how (?:can|do) i trust|can i trust|scam)\b|^trust[?! .]*$/i.test(trustText))return 'trust_concern';
 if(/(?:مكتب|مكاتب|شركه).{0,30}(?:ثاني|تاني|غير|ارخص)|(?:ليش|ليه) (?:معكم|اقدم معكم|اقدم معاكم|اختاركم)|(?:شو|وش|ايش|اش) (?:بيميزكم|بميزكم|يميزكم|ميزتكم)|(?:عند\s+)?غيركم\s+(?:اوفر|ارخص)|لقيت عرض\s+(?:اوفر|ارخص)|\b(?:other (?:office|agency)|why (?:choose|use) you)\b/i.test(n))return 'compare_service';
 if(/ما فهمت|مفهمتش|مافهمتش|مش فاهم|مو فاهم|مب فاهم|ماني فاهم|مش مستوعب|ما استوعبت|مش واضح|مو واضح|ما وصلتني الفكره|شو (?:قصدك|بتقصد|يعني هالحكي|يعني كلامك)|(?:وش|ايش|اش) تقصد|يعني ايه|(?:وضحلي|وضح لي|فسرلي|فسر لي)\s+(?:سؤالك|سوالك|قصدك)|^(?:يعني|كيف يعني|شو يعني|صح|وضحلي|وضح لي|فسرلي|فسر لي)[؟?!. ]*$|\b(?:what do you mean|don.?t understand)\b/i.test(n))return 'clarify_question';
 if(/بفكر|بدي فكر|بدي افكر|هفكر|هافكر|حفكر|(?:خلني|خليني|خلينا) (?:افكر|فكر|اتروي|اشاور|شاور|استشير)|بشاور|اشاور الاهل|\b(?:think about it|need (?:some )?time|discuss with my family)\b/i.test(pauseText)||/^(?:ما بدي|مش عايز|مش عاوز|ما ابي|ما ابغي|ما اشتي)\s+(?:اكمل|اقدم)(?:\s+(?:هلق|دلوقتي|الحين|حاليا))?[.!؟? ]*$/.test(n))return 'hesitation';
 const asserted=n.split(/[،,؛;.!?؟]|\s+(?:بس|لكن)\s+/).filter(part=>!/(?:^|\s)(?:مو|مش|مب|ليس|ما|not|isn't)(?=\s)/.test(part)).join(' ');
 const budgetConcern=/(?:^|[،,؛;.!؟?]\s*)(?:(?:السعر|المبلغ)\s+)?(?:ما يناسب ميزانيتي|مش مناسب لميزانيتي|ما بقدر ادفع هالمبلغ|مش قادر ادفع المبلغ)(?=$|[،,؛;.!؟?])/u.test(n);
 if((budgetConcern||/غالي|غاليه|وايد غال|السعر (?:عالي|مرتفع|نار)|(?:فوق|خارج) ميزانيتي|\b(?:expensive|costs? too much|over my budget)\b/i.test(asserted))&&!/خصم|تخفيض|نزل|اقل سعر|discount|reduce/i.test(asserted))return 'price_objection';
 return null;
}

function lastAssistantReply(c){
 const turn=(Array.isArray(c.history)?c.history:[]).findLast(item=>item?.role==='assistant'&&typeof (item.text||item.content)==='string');
 return String(turn?.text||turn?.content||'').slice(0,3000);
}
function clarificationReply(c){
 const previous=lastAssistantReply(c);
 // Explain the question actually sent, including a concern that interrupted
 // intake. Match known topics only; never echo arbitrary history or identifiers.
 if(/ابعت تفاصيل العرض الثاني|العرض الثاني لنفس نوع التأشيرة|العرض الثاني سياحية أو عمرة/.test(previous))return 'قصدي نقارن عرضين لنفس نوع التأشيرة وبنفس الخدمات، حتى يكون فرق السعر واضح. العرض الثاني سياحية أو عمرة؟';
 if(/نراجع شروط الخدمة قبل الدفع|نبدأ ببيانات الشركة|قلقك من نتيجة التأشيرة/.test(previous))return 'قصدي نوضح شو تشمل الخدمة، وشروطها قبل الاتفاق. أكثر شي مقلقك نتيجة التأشيرة أو استرداد الرسوم؟';
 if(/نراجع بند التأمين|نبدأ بشروط التأمين/.test(previous))return 'قصدي إن رسوم التأشيرة والتأمين بندين منفصلين، ولازم يكون شرط استرداد كل بند واضح. بتحب أوضح شروط التأمين؟';
 const key=c.pendingRelative?.awaiting||c.lastQuestion||'';
 if(/^nationality(?:_\d+)?$/.test(key))return 'قصدي جنسية المتقدم المكتوبة بجوازه أو وثيقته، حتى نحدد مسار التقديم المناسب. بلد الإقامة ممكن يكون مختلف. شو الجنسية المكتوبة بالمستند؟';
 if(/^documentType(?:_\d+)?$/.test(key))return 'قصدي نوع مستند السفر نفسه: جواز سفر عادي، أو وثيقة سفر. هالفرق بيأثر على طريقة التقديم. شو مكتوب على غلاف المستند؟';
 if(/^issuer_\d+$/.test(key)||key==='documentIssuer')return 'قصدي البلد اللي أصدر وثيقة السفر، وهو ممكن يختلف عن الجنسية أو بلد الإقامة. أي بلد مكتوب كجهة إصدار؟';
 if(key==='scope')return 'قصدي كيف بتحب نرتّب طلب قريبك أو صديقك: نضيفه معك بنفس مجموعة المتقدمين، أو نفتح له ملفًا مستقلًا. أي خيار بتفضّل؟';
 if(key==='applicantCount')return 'قصدي عدد الأشخاص اللي بدنا نقدّم لهم بهالطلب، مع احتساب الأطفال إذا مسافرين معكم. كم شخص بالمجموع؟';
 if(/^age_\d+$/.test(key))return 'قصدي عمر المسافر بالسنوات المكتملة. منحتاجه حتى نعرف إذا في رسوم تأمين إضافية. كم عمره؟';
 return 'أكيد، منوضحها خطوة خطوة. أي نقطة بدك أوضحها: نوع التأشيرة، المستندات، الرسوم أو متابعة الطلب؟';
}

function consultationReply(intent,c={}, {completion=null,includeNextStep=true}={}){
 if(!INTENTS.includes(intent))return null;
 const previous=lastAssistantReply(c),next=(body,step)=>body+(includeNextStep&&step?' '+step:'');
 const evidence=currentVisaEvidence(c),progress=evidence.submission?'submitted':evidence.payment?'paid':null;
 if(intent==='hesitation')return 'أكيد، خذ راحتك. لما تقرر منكمل من نفس النقطة.';
 if(intent==='clarify_question')return clarificationReply(c);
 if(intent==='approval_guarantee'){
  if(progress==='submitted')return next('حتى بعد التقديم، ما فينا نضمن الإصدار؛ القرار للجهة المختصة. شروط استرداد الرسوم منفصلة عن نتيجة الطلب.','حابب نراجع آخر تحديث على طلبك؟');
  if(/ما فينا نضمن الإصدار/.test(previous))return next('الموافقة ما بتنعرف مسبقًا. إذا السفر مرتبط بموعد، لازم نراعيه قبل التقديم.',c.departureDate?'حابب نراجع المدة المتوقعة بالنسبة لموعد سفرك؟':'عندك موعد سفر محدد لازم نراعيه؟');
  return next('ما فينا نضمن الإصدار أو موعده؛ القرار للجهة المختصة. دورنا نراجع المستندات ونوضح الخطوات. شروط استرداد الرسوم منفصلة عن ضمان الموافقة.','بتحب أوضح لك شروط استرداد الرسوم؟');
 }
 if(intent==='trust_concern'){
  if(progress)return next('من حقك تطمّن على ملفك. خلّينا نراجع '+(progress==='submitted'?'آخر تحديث على الطلب والخطوة التالية.':'الخطوة التالية بالمعاملة بعد تأكيد الدفعة.'),'حابب نبدأ بمتابعة ملفك؟');
  if(c.paymentStatus==='awaiting_verification')return next('إذا قلقك على التحويل، تأكيد وصوله بيكون بعد مراجعته مع الحساب البنكي.','حابب نوضح لك كيف يتم تأكيد الدفعة؟');
  if(c.quote?.insuranceRefundPolicy==='pending_confirmation')return next('من حقك تتأكد. شروط استرداد التأمين ضمن عرضك بحاجة لتأكيد منفصل قبل الدفع.','حابب نبدأ بشروط التأمين؟');
  if(/نراجع شروط الخدمة قبل الدفع|بيانات الشركة وشروط الخدمة|من حقك تتأكد/.test(previous))return next('خلّينا نحدّد النقطة اللي بدك تطمّن عليها، حتى أجاوبك بشكل مباشر.','قلقك من نتيجة التأشيرة أو من استرداد الرسوم؟');
  return next('من حقك تتأكد من تفاصيل الخدمة. فيك تراجع بيانات الشركة وشروط الخدمة، والدفع بيكون عبر وسائل الشركة المعتمدة.','بتحب نراجع شروط الخدمة قبل الدفع؟');
 }
 if(intent==='compare_service'){
  if(/ابعت تفاصيل العرض الثاني|نفس نوع التأشيرة|من حقك تقارن/.test(previous))return next('خلّينا نثبت أول نقطة بالمقارنة: نوع التأشيرة، وبعدها منراجع الخدمات المشمولة.','العرض الثاني سياحية أو عمرة؟');
  return next('أكيد، من حقك تقارن. الفرق ممكن يكون بنوع التأشيرة أو بما يشمله العرض؛ تفاصيل العرض هي اللي بتوضح.','إذا حابب، ابعت تفاصيل العرض الثاني حتى نقارن نفس الخدمة.');
 }
 const quote=c.quote;
 if(quote?.requiresReview){
  if(quote.reason==='tourist_age_required')return next('بفهم إن التكلفة مهمة إلك. قبل تأكيد الإجمالي، منحتاج العمر لأنه بيأثر على بند التأمين.',completion||'كم عمر المتقدم بالسنوات المكتملة؟');
  if(quote.reason==='tourist_age_53_review')return 'لهالعمر، قيمة التأمين بحاجة لتأكيد قبل تحديد المجموع. الخطوة التالية مراجعة هالبند قبل الدفع.';
  if(quote.reason==='child_pricing')return 'تسعير الأطفال بحاجة لمراجعة منفصلة. منراجع تكلفة كل متقدم قبل ما نعطيك إجمالي توافق عليه.';
  return 'بفهم إن التكلفة مهمة إلك. نراجع بند التسعير المعلّق قبل تأكيد الإجمالي أو الاتفاق على الدفع.';
 }
 if(quote&&Number.isFinite(quote.total)){
  if(Number.isFinite(quote.insuranceSubtotal)&&quote.insuranceSubtotal>0)return next('بفهم إن السعر عامل مهم إلك. بعرضك في بند للتأمين الطبي منفصل عن رسوم التأشيرة.'+(quote.insuranceRefundPolicy==='pending_confirmation'?' شروط استرداد التأمين بدها تأكيد قبل الدفع.':''),'حابب نراجع بند التأمين؟');
  if(Number.isFinite(quote.paymentFee)&&quote.paymentFee>0)return next('بفهم إن السعر عامل مهم إلك. ضمن الإجمالي في رسوم لوسيلة الدفع المختارة؛ التحويل البنكي لحساب الشركة دون عمولة إضافية من المكتب.','حابب نقارن الإجمالي حسب وسيلة الدفع؟');
  if(/نراجع شو مشمول بعرضك|السعر عامل مهم/.test(previous))return next('خلّينا نحدد فرق السعر اللي حابب نراجعه.','عندك عرض أقل لنفس نوع التأشيرة نقدر نقارن بنوده؟');
  return next('بفهم إن السعر عامل مهم إلك. منقدر نفصّل عرضك لرسوم التأشيرة وأي بند إضافي مذكور فيه.','حابب نراجع شو مشمول بعرضك؟');
 }
 return next('بفهم إنك بدك تكلفة واضحة. خلّينا نكمل المعلومة الناقصة حتى تكون المقارنة على أساس صحيح.',completion||'شو نوع التأشيرة اللي عم تقارن سعرها؟');
}
module.exports={CONSULTATION_INTENTS:INTENTS,CONSULTATION_GUIDE:GUIDE,consultationIntent,consultationReply};
