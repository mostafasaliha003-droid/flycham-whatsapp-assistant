'use strict';
// Reviewed conversational guidance and replies. The model chooses an intent;
// it cannot supply prices, promises, bank destinations or operational evidence.
const {normalize,REFUND_BENEFIT}=require('./saudi-visa-policy');
const INTENTS=Object.freeze(['trust_concern','approval_guarantee','price_objection','compare_service','hesitation','clarify_question']);
const GUIDE=`Act as an experienced visa consultant when interpreting the conversation: understand the reason behind the question, answer the actual concern before collecting another field, and distinguish an objection from a refusal. Understand Syrian, Egyptian, Gulf, Jordanian, Lebanese and Yemeni Arabic, Modern Standard Arabic, English and other languages supported by the model, including code switching and Arabizi. A dialect, accent, name, script or residence NEVER establishes nationality. Do not pretend to understand ambiguous words: request only the one unclear detail, not a written summary of understood audio.
Read the whole turn before deciding: the last explicit correction supersedes the earlier statement, quoted third-party claims are not customer instructions, conditional questions are not changes, and a short answer belongs to the pending question. A question about a relative must not overwrite the applicant. انا وعيالي / أنا وأهلي does NOT specify a count. Keep document issuer separate from nationality. مو / مش / مب / ماني / مفيش / مش عايز / ما ابغى / ما اشتي can negate an action; لسه ما حولتش / ما حولت / ما حولتش means no payment claim. عايز اعرف لو لغيت / لو أكنسل / if I cancel asks terms, not cancellation. Arabic shorthand صح؟ / يعني؟ may ask for clarification, never operational consent by itself.
Consultation intents: trust_concern asks how to trust the office or fears paying an unknown service; approval_guarantee asks if approval/issuance is guaranteed; price_objection says the fee is high without actually asking for a discount; negotiation explicitly asks to reduce a fee; compare_service compares another office or offer; hesitation means still considering or needing time; clarify_question asks what your last question means. Do not treat these as apply, payment, cancellation or a new application. A real existing paid-case dispute still uses complaint; a request for a real case update still uses status. Respect a firm no or desire to pause, without persuasion or repeated sales questions. No invented urgency, scarcity, discount, guarantee, authority or claim of having taken an action.
Examples of meaning, not customer facts: شقد بتاخد وقت / بتاخد وقت قد إيه / كم يبغالها / قديش بتطوّل / كم تشتي وقت => processing_time. غالية علي / السعر غالي عليا / وايد غالي => price_objection. ما فهمت شو قصدك / مش فاهم سؤالك / وش تقصد / شو بتقصد / مش فاهم قصدك => clarify_question. بدي فكّر / هفكر وأرد عليك / خلني أشاور الأهل => hesitation. ليش أقدم معكم / المكتب الثاني أرخص => compare_service. بتضمن تطلع / مضمونة أكيد / guaranteed approval? => approval_guarantee. لسه ما دفعتش => never payment_receipt. بدي قدم لمرتي مش إلي => target other, not self. أنا سوري مو مصري => nationality سوريا only, correction true. تمام/ماشي/زين/أيوه/ايوا/إي/yes is interpreted using context, never as unconditional consent to cancel or confirm payment.`;

function consultationIntent(text){
 const n=normalize(String(text||''));
 if(/(?:(?:ضمان|مضمون|تضمن|اكيد).{0,20}(?:تطلع|الاصدار|الموافقه|الفيزا|التاشيره)|(?:الفيزا|التاشيره|الموافقه|الاصدار).{0,20}(?:مضمون|ضمان))|\b(?:guaranteed? approval|guarantee (?:the )?visa)\b/i.test(n))return 'approval_guarantee';
 if(/كيف (?:اثق|اضمن)|شو بيضمن|كيف اامن|خايف (?:ادفع|احول)|(?:نصاب|نصب).*(?:سمعت|قال)|(?:سمعت|قالوا|قالولي).*(?:نصاب|نصب)|\b(?:trust|scam)\b/i.test(n))return 'trust_concern';
 if(/(?:مكتب|مكاتب|شركه).{0,30}(?:ثاني|تاني|غير|ارخص)|ليش (?:معكم|اقدم معكم)|شو (?:بيميزكم|بميزكم)|\b(?:other (?:office|agency)|why (?:choose|use) you)\b/i.test(n))return 'compare_service';
 if(/ما فهمت|مش فاهم|مو فاهم|ماني فاهم|مش واضح|مو واضح|شو (?:قصدك|بتقصد)|وش تقصد|ايش تقصد|يعني ايه|\b(?:what do you mean|don.?t understand)\b/i.test(n))return 'clarify_question';
 if(/بفكر|بدي فكر|بدي افكر|هفكر|حفكر|خلني (?:افكر|اشاور)|بشاور|اشاور الاهل|\b(?:think about it|need (?:some )?time|discuss with my family)\b/i.test(n))return 'hesitation';
 const asserted=n.split(/[،,؛;.!?؟]|\s+(?:بس|لكن)\s+/).filter(part=>!/(?:^|\s)(?:مو|مش|مب|ليس|ما|not|isn't)(?=\s)/.test(part)).join(' ');
 if(/غالي|غاليه|وايد غال|\b(?:expensive|costs? too much|over my budget)\b/i.test(asserted)&&!/خصم|تخفيض|نزل|اقل سعر|discount|reduce/i.test(asserted))return 'price_objection';
 return null;
}

function clarificationReply(c){
 const key=c.lastQuestion||'';
 if(/^nationality(?:_\d+)?$/.test(key))return 'قصدي جنسية المتقدم المكتوبة بجوازه أو وثيقته، حتى نحدد مسار التقديم المناسب. بلد الإقامة ممكن يكون مختلف. شو الجنسية المكتوبة بالمستند؟';
 if(/^documentType(?:_\d+)?$/.test(key))return 'قصدي نوع مستند السفر نفسه: جواز سفر عادي، أو وثيقة سفر. هالفرق بيأثر على طريقة التقديم. شو مكتوب على غلاف المستند؟';
 if(/^issuer_\d+$/.test(key))return 'قصدي البلد اللي أصدر وثيقة السفر، وهو ممكن يختلف عن الجنسية أو بلد الإقامة. أي بلد مكتوب كجهة إصدار؟';
 if(key==='applicantCount')return 'قصدي عدد الأشخاص اللي بدنا نقدّم لهم بهالطلب، مع احتساب الأطفال إذا مسافرين معكم. كم شخص بالمجموع؟';
 return 'أكيد، منوضحها خطوة خطوة. أي نقطة بدك أوضحها: نوع التأشيرة، المستندات، الرسوم أو متابعة الطلب؟';
}

function consultationReply(intent,c,{completion=null,includeNextStep=true}={}){
 if(!INTENTS.includes(intent))return null;
 if(intent==='hesitation')return 'أكيد، خذ راحتك وراجع التفاصيل على مهلك. لما تكون جاهز منكمل من نفس النقطة، وإذا في أمر محيّرك فيك تسألني عنه.';
 if(intent==='clarify_question')return clarificationReply(c);
 if(intent==='approval_guarantee')return 'قرار الموافقة أو الرفض للجهة المختصة، وما فينا نضمن الإصدار أو موعده. دورنا نراجع مستنداتك ونوضح المسار والمتطلبات ونتابع المعاملة حسب حالتها. ضمان الموافقة مختلف عن شروط استرداد الرسوم عند الرفض.';
 if(intent==='trust_concern')return 'من حقك تتأكد قبل أي دفع. فيك تراجع بيانات الشركة وشروط الخدمة، ومنوضح لك الرسوم ومسار التقديم قبل الاتفاق. الدفع يكون عبر وسائل الشركة المعتمدة، وأي تأكيد لاستلامه بيصدر بعد التحقق.'+(includeNextStep?' شو النقطة اللي حابب تتأكد منها أولًا؟':'');
 if(intent==='compare_service')return 'أكيد، من حقك تقارن. حتى تكون المقارنة دقيقة، خلّينا نراجع نوع التأشيرة وما يشمله السعر ورسوم الدفع وشروط الاسترداد، من دون افتراض تفاصيل عرض المكتب الثاني.'+(includeNextStep?' شو نوع التأشيرة والخدمات المذكورة بالعرض الثاني؟':'');
 const quote=c.quote;
 if(quote?.requiresReview)return 'بفهم إن التكلفة مهمة إلك. تسعير هالحالة يحتاج مراجعة قبل تأكيد الإجمالي، حتى ما نعطيك مبلغ غير دقيق. منوضح السعر المعتمد قبل الدفع.';
 if(quote&&Number.isFinite(quote.total))return 'بفهم إن السعر عامل مهم إلك. خلّينا نقارن نفس نوع التأشيرة والخدمات المشمولة بالعرض، ومنوضح رسوم وسيلة الدفع قبل ما تقرر. التحويل البنكي لحساب الشركة دون عمولة إضافية من المكتب.\n\n'+REFUND_BENEFIT+(includeNextStep?'\n\nحابب أوضح تفصيل الرسوم، أو نراجع عرض ثاني عندك؟':'');
 return 'بفهم إنك بدك تكلفة مناسبة وواضحة. خلّينا نحدد المسار المناسب أولًا حتى نقارن على أساس صحيح.'+(includeNextStep?(completion?'\n\n'+completion:' شو نوع التأشيرة اللي عم تقارن سعرها؟'):'');
}
module.exports={CONSULTATION_INTENTS:INTENTS,CONSULTATION_GUIDE:GUIDE,consultationIntent,consultationReply};
