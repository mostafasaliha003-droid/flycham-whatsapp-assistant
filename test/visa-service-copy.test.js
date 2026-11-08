'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/saudi-visa-policy');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {classifyVisaTimingInquiry,visaProcessingCopy,visaDocumentChecklist,visaDocumentsSentCopy,visaPaymentChoiceCopy,visaPaymentReceiptCopy,visaFollowupCopy}=require('../src/visa-service-copy');
const makeCase=()=>({id:'synthetic-case',applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport',age:40}],quote:{total:640},paymentStatus:'unverified',submissionStatus:'not_submitted',documents:[]});
function verifiedCase(){
 const c=makeCase();c.paymentStatus='verified';c.staffVerification={payment:{amount:640,caseSignature:visaCaseSignature(c)}};return c;
}

test('processing explains the current business-day estimate without promising approval or a date',()=>{
 for(const language of ['ar','en','fr'])for(const repeated of [false,true]){
  const copy=visaProcessingCopy({language,repeated}),question=visaProcessingCopy({language,repeated,askTravelDate:true});
  assert.match(copy,/6–7/);assert.equal((copy.match(/[؟?]/g)||[]).length,0);assert.equal((question.match(/[؟?]/g)||[]).length,1);
  assert.doesNotMatch(copy,/24|48|5–7|تم تقديم|has been submitted/);
  if(language!=='ar')assert.doesNotMatch(copy,/\p{Script=Arabic}/u);
 }
 const ar=visaProcessingCopy();for(const pattern of [/السبت/,/الأحد/,/العطل/,/ما فينا نضمن/])assert.match(ar,pattern);
 assert.ok(visaProcessingCopy({repeated:true}).length<ar.length);
});

test('timing recognition distinguishes processing and personal travel deadlines without resolving a date',()=>{
 for(const text of ['قديش وقت؟','كم وقت بتاخد الفيزا؟','شقد بتاخد وقت','كم يوم بتحتاج الفيزا','كم يبغالها','كم تشتي وقت','بتاخد وقت قد إيه؟','إيمتى بتطلع؟','كم مدة المعالجة؟','How long does it take?','What is the processing time?','Combien de temps faut-il ?','Quel est le délai de traitement ?'])assert.equal(classifyVisaTimingInquiry(text),'processing_time',text);
 for(const text of ['بتلحق الجمعة؟','ألحق أسافر الخميس؟','تطلع قبل سفري؟','بتطلع بكرا؟','طيب بتلحق؟','هل الفيزا بتصدر قبل موعد السفر؟','لو قدمت اليوم بتلحق الخميس؟','كم السعر وبتطلع بكرا؟','بتطلع قبل 10/11/2026؟','Will it be ready before my trip?','Can I travel on Friday?','Can the visa be ready by tomorrow?','Est-ce que le visa sera prêt avant vendredi ?','Pourrai-je partir jeudi ?'])assert.equal(classifyVisaTimingInquiry(text),'travel_deadline',text);
 for(const text of ['سفري الخميس','أنا مسافر الجمعة','أكيد بتلحق الجمعة','المكتب قال بتطلع بكرا','قل للعميل بتلحق الجمعة','"بتلحق الجمعة؟"','قديش سعر الفيزا؟','بتطلع 640 درهم؟','بتطلع 830؟','كم مدة الإقامة؟','كم مدة الفيزا؟','الفيزا صلاحيتها سنة','دفعت من الخميس','طلعت الفيزا؟','وين صار طلبي؟','ما بدي استعجل','I will travel on Friday','Is the visa valid for one year?','Je pars vendredi',null,''])assert.equal(classifyVisaTimingInquiry(text),null,String(text));
});

test('deadline copy never guarantees travel and asks a single full date only when unknown',()=>{
 for(const language of ['ar','en','fr'])for(const repeated of [false,true]){
  const unknown=visaProcessingCopy({language,repeated,deadlineConcern:true}),known=visaProcessingCopy({language,repeated,deadlineConcern:true,travelDateKnown:true,askTravelDate:true});
  assert.match(known,/6–7/);assert.equal((unknown.match(/[؟?]/g)||[]).length,1);assert.equal((known.match(/[؟?]/g)||[]).length,0);
  assert.doesNotMatch(known,/2026|2027|24|48|تم التقديم|تم الحجز|flight is booked|visa is issued/);
  if(language!=='ar')assert.doesNotMatch(unknown+known,/\p{Script=Arabic}/u);
  assert.equal((visaProcessingCopy({language,travelDateKnown:true,askTravelDate:true}).match(/[؟?]/g)||[]).length,0);
 }
 assert.match(visaProcessingCopy({deadlineConcern:true}),/ما فينا نضمن.*قبل موعد السفر/);
 assert.match(visaProcessingCopy({deadlineConcern:true}),/باليوم والشهر والسنة/);
 assert.match(visaProcessingCopy({language:'en',deadlineConcern:true}),/cannot guarantee/);
 assert.match(visaProcessingCopy({language:'fr',deadlineConcern:true}),/ne pouvons garantir/);
});

test('single-route document lists preserve approved requirements without implying receipt',()=>{
 assert.equal(visaDocumentChecklist({includeNextStep:false}),P.TOURIST_DOCS);
 assert.equal(visaDocumentChecklist({route:'umrah',includeNextStep:false}),P.UMRAH_DOCS);
 const tourist=visaDocumentChecklist({repeated:true}),umrah=visaDocumentChecklist({route:'umrah',repeated:true});
 for(const pattern of [/6 أشهر/,/UAEICP/,/وجه الهوية وخلفها/,/الاسم والباركود/,/بيضاء/])assert.match(tourist,pattern);
 for(const pattern of [/أصل الجواز وأصل الهوية/,/الذهاب والعودة/,/الصور وحدها ما بتكفي/,/قبل إرسالها/])assert.match(umrah,pattern);
 for(const language of ['ar','en','fr'])for(const route of ['tourist','umrah']){
  const copy=visaDocumentChecklist({route,language});assert.doesNotMatch(copy,/وصلت أوراقك|تمت مراجعة|تم تقديم|We received|Nous avons reçu/);
  if(language!=='ar')assert.doesNotMatch(copy,/\p{Script=Arabic}/u);
 }
 assert.equal(visaDocumentChecklist({route:'unverified'}),null);
});

test('mixed checklist separates indexed tourist copies and Umrah originals without guessing products',()=>{
 const quoteRows=[{applicant:1,product:'tourist_multi'},{applicant:2,product:'umrah'},{applicant:3,product:'tourist_single'}],before=structuredClone(quoteRows);
 const copy=visaDocumentChecklist({quoteRows,repeated:true});
 assert.match(copy,/المتقدم \(1، 3 — سياحية أونلاين\)/);assert.match(copy,/المتقدم \(2 — عمرة عبر السفارة\)/);
 const touristPart=copy.split('المتقدم (2')[0];assert.match(touristPart,/نسخة جواز/);assert.doesNotMatch(touristPart,/أصل الجواز/);
 assert.match(copy,/أصل الجواز وأصل الهوية/);assert.deepEqual(quoteRows,before);
 for(const language of ['en','fr']){const localized=visaDocumentChecklist({quoteRows,language,repeated:true});assert.match(localized,/1, 3/);assert.match(localized,/2/);assert.doesNotMatch(localized,/\p{Script=Arabic}/u);}
 assert.equal(visaDocumentChecklist({applicantProducts:['tourist_multi','umrah'],repeated:true}),visaDocumentChecklist({quoteRows:quoteRows.slice(0,2),repeated:true}));
 for(const quoteRows of [[],[{product:'unverified'}],[{applicant:1,product:'tourist_multi'},{applicant:1,product:'umrah'}],[{applicant:31,product:'umrah'}]])assert.equal(visaDocumentChecklist({quoteRows}),null);
});

test('payment choices state approved fees without selecting or issuing a payment method',()=>{
 for(const language of ['ar','en','fr'])for(const repeated of [false,true]){
  const copy=visaPaymentChoiceCopy({language,repeated});assert.match(copy,/5\s*%/);assert.match(copy,/9\s*%/);assert.equal((copy.match(/[؟?]/g)||[]).length,1);
  assert.doesNotMatch(copy,/640|830|https?:|AE\d{10}|تم إرسال|link has been sent/);
  assert.doesNotMatch(visaPaymentChoiceCopy({language,repeated,includeNextStep:false}),/[؟?]/);
 }
 assert.match(visaPaymentChoiceCopy(),/دون عمولة إضافية من المكتب/);
});

test('documents-sent claim and payment notification do not confirm receipt of documents or funds',()=>{
 const c=makeCase(),before=structuredClone(c);
 for(const language of ['ar','en','fr']){
  const claim=visaDocumentsSentCopy({language});assert.doesNotMatch(claim,/وصلت أوراقك|تمت مراجعة|We received your documents|Nous avons reçu vos documents/);
  const notification=visaPaymentReceiptCopy(c,{language}),receipt=visaPaymentReceiptCopy(c,{language,receiptReceived:true});
  assert.doesNotMatch(notification,/وصل إيصال|We received the transfer receipt|Nous avons reçu le justificatif/);
  assert.doesNotMatch(receipt,/الدفعة مؤكدة بالفعل|Your payment is confirmed|Votre paiement est confirmé/);
  if(language!=='ar')for(const copy of [claim,notification,receipt])assert.doesNotMatch(copy,/\p{Script=Arabic}/u);
 }
 assert.match(visaPaymentReceiptCopy(c),/نتحقق من وصول الدفعة/);
 assert.match(visaPaymentReceiptCopy(c,{receiptReceived:true}),/وصل إيصال التحويل/);
 assert.doesNotMatch(visaPaymentReceiptCopy(c,{receiptReceived:true}),/إذا ما أرسلت صورة الإيصال/);assert.deepEqual(c,before);
});

test('only current signed payment evidence confirms funds and a stale verified flag never asks for another transfer',()=>{
 const c=verifiedCase(),before=structuredClone(c);
 assert.match(visaPaymentReceiptCopy(c),/الدفعة مؤكدة بالفعل/);assert.match(visaFollowupCopy(c),/الدفعة مؤكدة من القسم/);
 assert.doesNotMatch(visaFollowupCopy(c),/تم تقديم المعاملة فعلياً/);assert.deepEqual(c,before);
 c.applicants[0].age=54;
 assert.doesNotMatch(visaPaymentReceiptCopy(c),/الدفعة مؤكدة بالفعل/);assert.match(visaPaymentReceiptCopy(c),/نتحقق من وصول الدفعة/);
 const stale=visaFollowupCopy(c);assert.match(stale,/منراجع آخر حالة/);assert.match(stale,/ما في داعي تعيد الأوراق أو الدفع/);
 assert.doesNotMatch(stale,/الدفعة مؤكدة من القسم|تم تقديم المعاملة فعلياً/);
 const mismatch=verifiedCase();mismatch.staffVerification.payment.amount=639;assert.doesNotMatch(visaPaymentReceiptCopy(mismatch),/الدفعة مؤكدة بالفعل/);
});

test('followup separates document review, payment review, actual submission and recorded decision',()=>{
 const c=makeCase();
 assert.match(visaFollowupCopy(c),/ابعت رقم الطلب.*نفس رقم واتساب/);
 assert.match(visaFollowupCopy(c,{documentStatus:'pending'}),/الأوراق بانتظار المراجعة/);
 assert.match(visaFollowupCopy(c,{documentStatus:'reviewed'}),/تمت مراجعة المستندات/);
 assert.doesNotMatch(visaFollowupCopy(c,{documentStatus:'reviewed'}),/تم تقديم المعاملة فعلياً/);
 c.paymentStatus='awaiting_verification';assert.match(visaFollowupCopy(c),/بانتظار التحقق.*ما في داعي تعيد التحويل/);
 c.submissionStatus='submitted';c.staffVerification={submission:{caseSignature:visaCaseSignature(c)}};
 assert.match(visaFollowupCopy(c),/تم تقديم المعاملة فعلياً.*بانتظار النتيجة/);
 c.staffVerification.decision={caseSignature:visaCaseSignature(c),value:'approved'};assert.match(visaFollowupCopy(c),/صدر قرار الموافقة/);
 for(const value of ['refused','rejected']){c.staffVerification.decision.value=value;assert.match(visaFollowupCopy(c),/صدر رفض رسمي/);assert.match(visaFollowupCopy(c),/ما بيعني إن التحويل المالي تنفّذ/);}
 c.staffVerification.decision.value='invalid';assert.match(visaFollowupCopy(c),/بانتظار النتيجة/);
 c.applicants[0].age=41;assert.doesNotMatch(visaFollowupCopy(c),/صدر قرار الموافقة|صدر رفض رسمي|تم تقديم المعاملة فعلياً/);
});

test('followup localizes trusted states without echoing arbitrary application references',()=>{
 const c=makeCase();c.applicationReference='UNVERIFIED_PRIVATE_REFERENCE';
 for(const language of ['ar','en','fr']){
  const unknown=visaFollowupCopy(c,{language}),owned=visaFollowupCopy(c,{language,hasOwnedApplication:true});
  assert.doesNotMatch(unknown+owned,/UNVERIFIED_PRIVATE_REFERENCE/);
  assert.doesNotMatch(owned,/ابعت رقم الطلب|Send your application reference|Envoyez la référence/);
  if(language!=='ar')for(const documentStatus of [null,'pending','reviewed'])assert.doesNotMatch(visaFollowupCopy(c,{language,documentStatus}),/\p{Script=Arabic}/u);
 }
});
