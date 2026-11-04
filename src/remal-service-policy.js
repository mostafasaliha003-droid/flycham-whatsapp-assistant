'use strict';
// Approved by the business owner, 2026-11-03. Never obtain bank destinations
// or commission rates from a model, customer message or untrusted attachment.
const OWNER='971507993145';
const BANKS=Object.freeze([
 Object.freeze({bank:'أبوظبي الإسلامي — ADIB',iban:'AE800500000000019198423',account:'19198423',name:'Remal Tourism LLC FZ'}),
 Object.freeze({bank:'أبوظبي التجاري — ADCB',iban:'AE830030014364424920001',account:'14364424920001',name:'REMAL TOURISM LLC FZ'})
]);
const PAYMENT='خيارات الدفع:\n• تحويل بنكي على حسابات الشركة: دون عمولة إضافية.\n• رابط دفع: عمولة 5%.\n• تابي: عمولة 9%.\nإذا بتفضّل الرابط أو تابي، خبرنا لننسّق معك وسيلة الدفع والإجمالي قبل الدفع.';
const BANK_COPY=BANKS.map(b=>`🏦 ${b.bank}\nاسم الحساب: ${b.name}\nرقم الحساب: ${b.account}\nIBAN: ${b.iban}`).join('\n\n');
const OFFICE='📍 دائرة السياحة والاقتصاد، نفس البناء الحكومي\nBlock B\nمكتب رقم 610\nميناء سعيد، دبي\nالمكتب إداري ولا يستقبل العملاء؛ تقديم الطلبات والمتابعة عبر واتساب.';
const BODIES=Object.freeze({
 received:'وصلت أوراقك، شكرًا إلك. عم نجهّز ملفك، ومنخبرك بأول تحديث.',
 processing:'طلبك معنا، وعم نتابعه. منرسل لك رقم الطلب بعد إتمام التقديم.',
 receipt:'وصل إيصال التحويل، شكرًا إلك. منأكد لك استلام الدفعة بعد المراجعة.',
 paid:'تم تأكيد استلام دفعتك، وعم نجهّز طلبك. منرسل لك رقم الطلب بعد إتمام التقديم.',
 link:'أكيد، رح ننسّق لك رابط الدفع مع المسؤول. عمولة الرابط 5%، ومنوضح لك الإجمالي قبل الدفع.',
 tabby:'أكيد، رح ننسّق لك الدفع عبر تابي مع المسؤول. عمولة تابي 9%، ومنوضح لك الإجمالي قبل الدفع.',
 discount:'منقدّر طلبك، وبدنا نعطيك أفضل سعر متاح 🌷 رح نراجع إمكانية الخصم مع المسؤول ونرجع لك بالسعر المعتمد قبل الدفع.',
 unknown:'حتى أعطيك جواب دقيق، رح أراجع هالنقطة مع المسؤول ونرجعلك بالتفاصيل 🌷',
 office:OFFICE,
 bank:'التفاصيل البنكية المعتمدة لشركة الرمال للسياحة:\n\n'+BANK_COPY+'\n\n'+PAYMENT,
 payment:PAYMENT,
 document_followup:'أوراقك محفوظة معنا، وما في داعي تعيد إرسالها. منخبرك إذا احتجنا أي مستند إضافي.',
 thanks:'أهلًا وسهلًا، نحنا معك 🌷',
 wait:'أكيد، خذ راحتك. منكمل على نفس الملف لما تكون جاهز.',
 update:'عم نتابع ملفك، ومنبلغك أول ما يتوفر تحديث على طلبك.',
 issued:'منتابع نتيجة الطلب، وأول ما تصدر التأشيرة منبعتها لك.'
});
// 16 intents × 16 introductions × 16 closings = 4096 bounded response
// compositions. Facts remain immutable; no variant invents a status or a fee.
const OPENINGS=Object.freeze(['','أهلًا فيك. ','أكيد. ','تمام. ','نحنا معك. ','شكرًا لتواصلك. ','حاضر. ','يا أهلًا. ','من عيونا. ','وصلت رسالتك. ','شكرًا إلك. ','أهلًا وسهلًا. ','يسعد وقتك. ','حياك الله. ','نورتنا. ','بكل سرور. ']);
const CLOSINGS=Object.freeze(['','\nنحنا معك.','\nشكرًا لثقتك.','\nحاضرين لخدمتك.','\nإذا عندك سؤال عن الخدمة، نحنا معك.','\nيسعدنا نساعدك.','\nشكرًا لتواصلك معنا.','\nأهلًا فيك دائمًا.','\nمعك خطوة بخطوة.','\nحاضرين لأي استفسار عن الخدمة.','\nيهمنا تكون الخطوة واضحة إلك.','\nنحنا بالخدمة.','\nأهلًا وسهلًا فيك.','\nشكرًا لاختيارك الرمال.','\nنتمنى لك يومًا طيبًا.','\nمنسعد بخدمتك.']);
function response(intent,{variant=0}={}){if(!Object.hasOwn(BODIES,intent))throw Error('UNTRAINED_SERVICE_INTENT');if(!Number.isInteger(variant)||variant<0||variant>=256)throw Error('SERVICE_VARIANT_INVALID');return OPENINGS[Math.floor(variant/16)]+BODIES[intent]+CLOSINGS[variant%16];}
function applicationStart(docs){return 'أكيد، لتثبيت طلبك ابعت المستندات المطلوبة هون:\n\n'+docs+'\n\nحسابات شركتنا:\n\n'+BANK_COPY+'\n\n'+PAYMENT+'\n\nبعد التحويل ابعت الإيصال هون، ومنأكد لك استلام الدفعة بعد المراجعة.';}
module.exports={OWNER,BANKS,PAYMENT,BANK_COPY,OFFICE,response,applicationStart,INTENTS:Object.keys(BODIES),VARIANT_COUNT:Object.keys(BODIES).length*OPENINGS.length*CLOSINGS.length};
