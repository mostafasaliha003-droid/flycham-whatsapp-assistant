'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine,isComplaint}=require('../src/saudi-visa-engine');
const P=require('../src/saudi-visa-policy');
const {visaCaseSignature}=require('../src/visa-case-signature');
const make=options=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}]},...options});
const tourist={nationality:'سوريا',documentType:'passport'};
test('office policy exact nationality and document classification does not guess every Asian country',()=>{
 for(const n of ['سوريا','الأردن','لبنان','جزر القمر','اليمن','السودان','ماليزيا','إندونيسيا','الهند','باكستان','بنغلاديش','فرنسا','دومينيكا'])assert.equal(P.productFor({nationality:n,documentType:'passport'}).code,'tourist_multi',n);
 assert.equal(P.productFor({nationality:'مصر',documentType:'passport'}).code,'tourist_single');
 for(const n of ['فلسطين','ليبيا','العراق'])assert.equal(P.productFor({nationality:n,documentType:'passport'}).code,'umrah');
 assert.equal(P.productFor({nationality:'لبنان',documentType:'travel_document'}).code,'umrah');
 for(const n of ['أفغانستان','إيران','تشاد'])assert.equal(P.productFor({nationality:n}).code,'suspended');
 assert.equal(P.productFor({nationality:'فيتنام'}).code,'unverified');
});
test('fixed quote maths validates actual group type, minors and explicit payment fee activation',()=>{
 const c={applicantCount:3,applicants:[tourist,tourist,tourist],paymentMethod:'link'};
 assert.equal(P.calculateQuote(c).subtotal,1950);assert.equal(P.calculateQuote(c).total,1950);assert.equal(P.calculateQuote(c).feePending,true);
 assert.equal(P.calculateQuote(c,{feesEnabled:true}).total,2047.5);
 assert.equal(P.calculateQuote({...c,paymentMethod:'tabby'},{feesEnabled:true}).total,2125.5);
 assert.equal(P.calculateQuote({...c,applicants:[tourist,tourist,{nationality:'العراق',documentType:'passport'}]}).total,2250);
 assert.equal(P.calculateQuote({...c,hasMinors:true}).requiresReview,true);
 assert.equal(P.calculateQuote({...c,applicantCount:null}),null);
});
test('Ismail greets once and keeps flight state fully independent',async()=>{
 const e=make();e.store.set('a',{flight:'untouched'});const r=await e.handle('a','سوري جواز عادي لحالي');assert.match(r.reply,/إسماعيل.*الافتراضي/);assert.equal(r.quote.total,700);
 assert.deepEqual(e.store.get('a'),{flight:'untouched',at:e.store.get('a').at});assert.doesNotMatch((await e.handle('a','شكرا')).reply,/أنا إسماعيل/);
});
test('missing count is asked, then numeric shorthand completes without repeating nationality',async()=>{
 const e=make();assert.match((await e.handle('a','أنا سوري جواز عادي')).reply,/كم شخص/);
 const r=await e.handle('a','1');assert.equal(r.quote.total,700);assert.doesNotMatch(r.reply,/شو جنسية|معه جواز/);
});
test('second applicant answer never overwrites primary nationality',async()=>{
 const e=make();await e.handle('a','نحنا شخصين انا سوري جواز عادي');assert.equal(e.getCase('a').lastQuestion,'nationality_1');
 await e.handle('a','مصرية');assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').applicants[1].nationality,'مصر');
 await e.handle('a','جواز عادي');assert.equal(e.getCase('a').quote.total,1400);assert.equal(e.getCase('a').quote.rows[1].product,'tourist_single');
});
test('a bank information answer does not invent an unsent outstanding question',async()=>{
 const e=make();const r=await e.handle('a','بدي حساباتكم');assert.match(r.reply,/AE000000000000000000000/);assert.equal(e.getCase('a').lastQuestion,undefined);assert.deepEqual(e.getCase('a').askedQuestions,[]);
});
test('same-nationality explicit group gets 650 each without invented discounts',async()=>{
 const e=make();const r=await e.handle('a','نحنا 3 كلنا سوريين جواز عادي');assert.equal(r.quote.total,1950);assert.match((await e.handle('a','زبطنا ب600')).reply,/ما في خصم إضافي/);assert.equal(e.getCase('a').quote.total,1950);
});
test('each actionable visa quote includes its price, official-refusal refund and next step together',async()=>{
 for(const {text,total,price,product,cta}of [
  {text:'سوري جواز عادي لحالي',total:700,price:/700 درهم/,product:'tourist_multi',cta:/ابعت صور المستندات المطلوبة هون/},
  {text:'مصري جواز عادي لحالي',total:700,price:/700 درهم/,product:'tourist_single',cta:/ابعت صور المستندات المطلوبة هون/},
  {text:'عراقي جواز عادي لحالي',total:850,price:/850 درهم/,product:'umrah',cta:/المكتب، أو ننسّق استلامهم عبر زاجل برسوم 35 درهماً/},
  {text:'نحنا 3 كلنا سوريين جواز عادي',total:1950,price:/1,950 درهم/,product:'tourist_multi',cta:/ابعت صور المستندات المطلوبة هون/}
 ]){
  const e=make(),r=await e.handle('a',text);assert.equal(r.quote.total,total);assert.equal(r.quote.rows[0].product,product);
  assert.match(r.reply,price);assert.match(r.reply,/رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي/);assert.equal((r.reply.match(/مستردة بالكامل/g)||[]).length,1);
  assert.match(r.reply,/التزام من مكتبنا/);assert.match(r.reply,/شروط الخدمة الموضحة قبل الدفع/);assert.match(r.reply,cta);assert.match(r.reply,/دون ضمان للموافقة أو موعد الصدور/);
  assert.equal(e.getCase('a').paymentStatus,'unverified');assert.equal(e.getCase('a').submissionStatus,'not_submitted');
 }
});
test('incomplete price inquiry and negotiations include the refund benefit exactly once',async()=>{
 const e=make(),price=await e.handle('price','بكم فيزا السعودية');
 assert.equal(price.quote,null);assert.match(price.reply,/700.*650.*850/);assert.match(price.reply,/شو جنسية/);
 const unknown=await e.handle('unknown','في خصم؟');assert.equal(unknown.quote,null);assert.match(unknown.reply,/700.*650/);
 await e.handle('known','سوري جواز عادي لحالي');const known=await e.handle('known','في خصم؟');assert.equal(known.quote.total,700);
 for(const r of [price,unknown,known]){assert.match(r.reply,/مستردة بالكامل في حال الرفض الرسمي/);assert.equal((r.reply.match(/مستردة بالكامل/g)||[]).length,1);}
});
test('refund covers visa fees while payment method totals and separate fee disclosure remain intact',async()=>{
 for(const {method,enabled,fee,total}of [
  {method:'رابط الدفع',enabled:true,fee:35,total:735},
  {method:'تابي',enabled:true,fee:63,total:763},
  {method:'رابط الدفع',enabled:false,fee:0,total:700}
 ]){
  const e=make({env:{SAUDI_VISA_PAYMENT_FEES_ENABLED:String(enabled)}}),r=await e.handle('a','سوري جواز عادي لحالي '+method);
  assert.equal(r.quote.subtotal,700);assert.equal(r.quote.paymentFee,fee);assert.equal(r.quote.total,total);assert.equal(r.quote.feePending,!enabled);
  assert.match(r.reply,/إجمالي رسوم التأشيرات: 700 درهم/);assert.match(r.reply,/رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي/);
  assert.match(r.reply,/رسوم وسيلة الدفع وأي خدمات إضافية تُوضح منفصلة قبل الاتفاق/);
  if(enabled)assert.match(r.reply,new RegExp('المجموع بهذه الطريقة: '+total+' درهم'));else assert.doesNotMatch(r.reply,/735|763/);
 }
});
test('refund promotion stays out of suspended intake, child pricing review, complaints and cancellation',async()=>{
 for(const text of ['افغاني جواز عادي لحالي','سوري جواز عادي شخص واحد طفل','قدمت عندكن وما رجعتوا فلوسي','بدي الغي']){
  const r=await make().handle('a',text);assert.doesNotMatch(r.reply,/مستردة بالكامل|ميزة خاصة لعملائنا/,text);
 }
});
test('suspended intake does not ask payment or promise an opening date',async()=>{
 const e=make();const r=await e.handle('a','افغاني جواز عادي لحالي');assert.equal(r.quote,null);assert.match(r.reply,/متوقف/);assert.doesNotMatch(r.reply,/700|850|ابعث.*دفع/);
});
test('travel document issuer is not inferred nationality; missing issuer needs an actual answer',async()=>{
 const e=make();await e.handle('a','معي وثيقة لبنانية لحالي');assert.equal(e.getCase('a').applicants[0].nationality,undefined);assert.equal(e.getCase('a').applicants[0].documentIssuer,'لبنان');
 const r=await e.handle('a','فلسطيني');assert.equal(r.quote.total,850);assert.match(r.reply,/أصل الجواز وأصل الهوية/);
});
test('ordinary Egyptian passport is single tourism, not a Palestinian Egyptian document',async()=>{
 const e=make();const r=await e.handle('a','مصري جواز عادي لحالي');assert.equal(r.quote.rows[0].product,'tourist_single');assert.equal(r.quote.total,700);assert.match(r.reply,/حسب سياسة منصة التقديم الحالية/);assert.match(r.reply,/للجنسية المصرية خلال هذا الموسم/);assert.match(r.reply,/متعددة الدخول غير متاحة حاليًا/);
});
test('refund, cancellation and payment after issuance are distinct actions',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');assert.match((await e.handle('a','الدفع بعد الاصدار')).reply,/ما عنا دفع بعد الإصدار/);
 assert.match((await e.handle('a','هل الرسوم مستردة عند الرفض')).reply,/التزام من مكتبنا/);
 const r=await e.handle('a','بدي الغي');assert.match(r.reply,/200/);assert.equal(e.getCase('a').cancellation.state,'awaiting_confirmation');
 await e.handle('a','نعم');assert.equal(e.getCase('a').cancellation.state,'review_requested');assert.notEqual(e.getCase('a').stage,'cancelled');
});
test('payment receipt does not prove payment and repeated receipt cannot downgrade staff confirmation',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');await e.handle('a','حولت');assert.equal(e.getCase('a').paymentStatus,'awaiting_verification');
 const sig=visaCaseSignature(e.getCase('a'));Object.assign(e.getCase('a'),{paymentStatus:'verified',submissionStatus:'submitted',stage:'submitted',staffVerification:{payment:{amount:700,reference:'ref',caseSignature:sig},submission:{reference:'submitted-ref',caseSignature:sig}}});
 await e.handle('a','دفعت');assert.equal(e.getCase('a').paymentStatus,'verified');assert.equal(e.getCase('a').stage,'submitted');
 await e.handle('a','شكرا');assert.equal(e.getCase('a').stage,'submitted');
 assert.match((await e.handle('a','حالة الطلب')).reply,/تم تقديم المعاملة فعلياً/);
});
test('recorded decision object is rendered from staff evidence only',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');e.getCase('a').staffVerification={decision:{value:'approved',reference:'staff-ref',caseSignature:visaCaseSignature(e.getCase('a'))}};
 assert.match((await e.handle('a','حالة الطلب')).reply,/قرار الموافقة/);
});
test('complaint bypass is not confused with quoting an accusation about reputation',async()=>{
 assert.equal(isComplaint('أنا دفعت عندكن وما طلعت الفيزا ونصبتوا علي'),true);assert.equal(isComplaint('قالوا انكم نصابين صحيح؟'),false);
 const e=make();const r=await e.handle('a','قدمت عندكن وما رجعتوا فلوسي');assert.equal(r.complaint,true);assert.equal(r.stage,'complaint_pending');assert.doesNotMatch(r.reply,/تم تحويل|تم استرداد/);
});
test('model cannot inject money, official eligibility or payment status',async()=>{
 const e=make({understand:async()=>({intent:'price',fields:{nationality:'سوريا',documentType:'passport',applicantCount:1,total:1,paymentStatus:'verified'},reply:'تم التقديم والموافقة بسعر1'})});
 const r=await e.handle('a','سعر الفيزا');assert.equal(r.quote.total,700);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.doesNotMatch(r.reply,/تم التقديم والموافقة/);
});
test('model correction overrides stale multi-nationality extraction',async()=>{
 const e=make({understand:async()=>({intent:'price',correction:true,fields:{nationality:'مصر',documentType:'passport',applicantCount:1}})});
 const r=await e.handle('a','مو سوري انا مصري');assert.equal(r.quote.rows[0].product,'tourist_single');assert.equal(e.getCase('a').applicantCount,1);
});
test('staff revision cancels stale understanding output',async()=>{
 let finish;const e=make({understand:()=>new Promise(resolve=>finish=resolve)});e.save('a',e.newCase());const pending=e.handle('a','مرحبا');e.getCase('a').revision++;finish({intent:'price',fields:{nationality:'سوريا',documentType:'passport',applicantCount:1}});assert.equal((await pending).superseded,true);assert.equal(e.getCase('a').quote,undefined);
});
test('attachments bypass external understanding and cannot claim quality review',async()=>{
 let called=false;const e=make({understand:async()=>{called=true;return null;}});const r=await e.handle('a','[ملف جواز]',{messages:[{media:{id:'test'}}]});assert.equal(called,false);assert.match(r.reply,/لا يعني اعتماد جودته/);assert.equal(e.getCase('a').stage,'documents_pending_review');
});
test('sensitive history is redacted and deleting visa data does not delete flight state',async()=>{
 const e=make();e.store.set('a',{status:'flight_active'});await e.handle('a','رقم الجواز N016671869 ورقم الهوية 784-1990-4260790-5');assert.doesNotMatch(JSON.stringify(e.getCase('a').history),/N016671869|784-1990/);
 await e.handle('a','احذف بياناتي');assert.equal(e.getCase('a'),null);assert.equal(e.store.get('a').status,'flight_active');
});
test('unknown children price is not silently quoted as adults',async()=>{
 const e=make();const r=await e.handle('a','سوري جواز عادي شخص واحد طفل');assert.equal(r.quote.requiresReview,true);assert.match(r.reply,/تسعير الحالة/);
});
test('amendments after verified payment preserve original paid case and record a review proposal',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');const c=e.getCase('a');c.paymentStatus='verified';c.stage='payment_verified';c.staffVerification={payment:{amount:700,reference:'confirmed',caseSignature:visaCaseSignature(c)}};
 const r=await e.handle('a','صاروا 3 اشخاص');assert.match(r.reply,/حفظنا التعديل للمراجعة/);assert.equal(e.getCase('a').applicantCount,1);assert.equal(e.getCase('a').quote.total,700);assert.equal(e.getCase('a').paymentStatus,'verified');assert.equal(e.getCase('a').pendingAmendment.facts.applicantCount,3);
});
test('attachment captions reach understanding as redacted text and remain in conversation history',async()=>{
 const calls=[],e=make({understand:async(text,context)=>{calls.push({text,context});return null;}});
 await e.handle('a','سوري جواز عادي لحالي');calls.length=0;
 await e.handle('a','هاي صورتين للهوية، ادمجهم. رقم الجواز N016671869 وهويتي 784-1990-4260790-5',{messages:[{media:{id:'1'}}]});
 assert.equal(calls.length,1);assert.match(calls[0].text,/صورتين للهوية، ادمجهم/);assert.doesNotMatch(calls[0].text,/N016671869|784-1990/);
 const user=e.getCase('a').history.at(-2).text;assert.match(user,/\[attachment received\].*ادمجهم/);assert.doesNotMatch(user,/N016671869|784-1990/);
 await e.handle('a','هل قرأت الصور؟');assert.match(calls.at(-1).context.history.at(-2).text,/ادمجهم/);
});
test('bare document identifiers and attachment placeholders never enter semantic understanding',async()=>{
 let calls=0;const e=make({understand:async()=>{calls++;return null;}});
 for(const text of ['N016671869','784-1990-4260790-5','P<SYR<<SYNTHETIC_PERSON','data:image/png;base64,SYNTHETIC_BYTES','[صورة مرفقة تحتاج مراجعة]'])await e.handle('a',text,{messages:[{media:{id:'1'}}]});
 assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(e.getCase('a').history),/N016671869|784-1990|SYNTHETIC_PERSON|SYNTHETIC_BYTES/);
});
test('friend nationality fragments and questions preserve the primary applicant and give the relevant conditional route',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');const original=structuredClone(e.getCase('a').applicants),signature=visaCaseSignature(e.getCase('a'));
 assert.match((await e.handle('a','وعندي صديقي')).reply,/شو جنسيته/);
 const egyptian=await e.handle('a','مصري');assert.match(egyptian.reply,/جواز مصري عادي.*سفرة واحدة/);assert.match(egyptian.reply,/جواز سفر عادي أو وثيقة سفر/);
 assert.match((await e.handle('a','وعندي صديق تاني فلسطيني')).reply,/الفلسطينية.*العمرة/);
 assert.match((await e.handle('a','كمان بدن يقدمو')).reply,/نفس المجموعة.*ملف مستقل/);
 const details=await e.handle('a','شو التفاصيل بعد اذنك');assert.match(details.reply,/الفلسطينية.*العمرة/);assert.doesNotMatch(details.reply,/700|إجمالي رسوم/);
 const question=await e.handle('a','حتى الفلسطيني بتطلع لو؟');assert.match(question.reply,/العمرة/);assert.match(question.reply,/ما في ضمان للموافقة/);assert.doesNotMatch(question.reply,/إجمالي رسوم|700|أكيد بتطلع/);
 assert.deepEqual(e.getCase('a').applicants,original);assert.equal(e.getCase('a').applicantCount,1);assert.equal(e.getCase('a').quote.total,700);assert.equal(visaCaseSignature(e.getCase('a')),signature);
});
test('a friend is added only by explicit same-group instruction after own document answer',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');await e.handle('a','عندي صديق مصري');await e.handle('a','جواز عادي');
 assert.equal(e.getCase('a').applicantCount,1);assert.equal(e.getCase('a').pendingRelative.facts.documentType,'passport');
 await e.handle('a','ضيفه معنا');assert.equal(e.getCase('a').applicantCount,2);assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').applicants[1].nationality,'مصر');
});
test('a model self-correction guess cannot reassign a short answer about a pending friend',async()=>{
 let scripted=null;const e=make({understand:async()=>scripted});await e.handle('a','سوري جواز عادي لحالي');await e.handle('a','عندي صديقي');
 scripted={intent:'apply',target:'self',correction:true,fields:{nationality:'مصر'}};
 const r=await e.handle('a','مصري');assert.match(r.reply,/جواز مصري عادي/);assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').pendingRelative.facts.nationality,'مصر');
 await e.handle('a','انا مصري');assert.equal(e.getCase('a').applicants[0].nationality,'مصر');
});
test('an attachment plus bank request answers bank details without repeating the quote',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');await e.handle('a','عندي صديق فلسطيني');
 const r=await e.handle('a','تمام بدي قدم، ابعتلك الاوراق، وبعتلي حسابك البنكي',{messages:[{media:{id:'1'}}]});
 assert.match(r.reply,/التفاصيل البنكية المعتمدة/);assert.match(r.reply,/AE000000000000000000000/);assert.doesNotMatch(r.reply,/إجمالي رسوم|وصلتنا رسالتك المتعلقة بالمستندات/);
 assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').paymentStatus,'unverified');
});
test('returning visa greetings keep the current question without repeating a price or checklist',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي');assert.equal(e.getCase('a').lastQuestion,'applicantCount');
 const r=await e.handle('a','مرحبا');assert.match(r.reply,/نفس طلب التأشيرة/);assert.doesNotMatch(r.reply,/700|نسخة جواز|إجمالي رسوم/);assert.equal(e.getCase('a').lastQuestion,'applicantCount');
});
test('visa erasure clears upload capabilities and prepared-delivery records for this customer only',async()=>{
 const e=make({store:{data:{},save(){}}});await e.handle('a','سوري جواز عادي لحالي');e.store.data.visaUpload={sessions:{one:{customer:'a'},two:{customer:'b'}}};e.store.data.visaPreparedDeliveries={items:{one:{customer:'a'},two:{customer:'b'}}};
 e.delete('a');assert.deepEqual(e.store.data.visaUpload.sessions,{two:{customer:'b'}});assert.deepEqual(e.store.data.visaPreparedDeliveries.items,{two:{customer:'b'}});
});
test('known quote is not repeated for actual apply/how-to/will-send followups while direct price remains available',async()=>{
 const e=make(),initial=await e.handle('a','سوري جواز عادي لحالي');assert.match(initial.reply,/700/);const signature=visaCaseSignature(e.getCase('a'));
 const apply=await e.handle('a','هلا، بدي قدم فيزا السعودية لو سمحت');assert.match(apply.reply,/نسخة جواز|صور المستندات|جواز/);assert.doesNotMatch(apply.reply,/700|إجمالي رسوم/);
 const how=await e.handle('a','كيف بقدم شو ابعتلك');assert.match(how.reply,/جواز|الهوية/);assert.doesNotMatch(how.reply,/700|إجمالي رسوم/);
 const future=await e.handle('a','طيب رح ابعتلك');assert.match(future.reply,/^تمام، ابعتهن هون/);assert.doesNotMatch(future.reply,/700|جواز|إجمالي رسوم/);
 const acknowledged=await e.handle('a','اوكي');assert.doesNotMatch(acknowledged.reply,/700|إجمالي رسوم/);assert.equal(visaCaseSignature(e.getCase('a')),signature);
 const price=await e.handle('a','شو السعر؟');assert.match(price.reply,/700/);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.equal(e.getCase('a').submissionStatus,'not_submitted');
});
test('how-to apply colloquial variant preserves original-document Umrah requirements',async()=>{
 const e=make();await e.handle('a','فلسطيني جواز عادي لحالي');const r=await e.handle('a','كيف بقدم شو ابعتلك');assert.match(r.reply,/أصل الجواز وأصل الهوية/);assert.doesNotMatch(r.reply,/850|إجمالي رسوم/);
});

test('document utility turns record the actual answer without replacing the subject, quote or document stage',async()=>{
 const engine=make();await engine.handle('document-customer','انا سوري ومعي جواز عادي شخص واحد');const c=engine.getCase('document-customer');c.stage='documents_pending_review';const before=structuredClone(c),reply='عم جهّز صور الهوية ضمن نفس ملفك.';
 const r=engine.recordDocumentTurn('document-customer','ادمجهم',reply,{caseId:c.id,expectedRevision:c.revision});assert.equal(r.reply,reply);const after=engine.getCase('document-customer');assert.equal(after.stage,before.stage);assert.equal(visaCaseSignature(after),visaCaseSignature(before));assert.equal(after.history.at(-1).text,reply);assert.equal(after.history.at(-2).text,'ادمجهم');assert.equal(after.revision,before.revision+1);
 assert.equal(engine.recordDocumentTurn('document-customer','الهوية','answer',{caseId:c.id,expectedRevision:before.revision}).superseded,true);
});

function savedConversation(e,id,reference='828000001'){
 const c=e.newCase();c.greeted=true;c.applicantCount=1;c.applicants=[{nationality:'سوريا',documentType:'passport'}];c.paymentStatus='verified';e.save(id,c);e.store.data.visaFulfilment||={jobs:{}};e.store.data.visaFulfilment.jobs['job-'+id+'-'+reference]={id:'job-'+id+'-'+reference,customer:id,caseId:c.id,caseSignature:visaCaseSignature(c),createdAt:Date.now(),state:'saved_application',applicationReference:reference};return c;
}
test('returning customer references select only their own saved application, including Arabic digits and E prefix',async()=>{
 const e=make(),c=savedConversation(e,'a');savedConversation(e,'b','828000002');
 for(const text of ['شو صار بطلبي','رقم الطلب E٨٢٨٠٠٠٠٠١','828000001']){const r=await e.handle('a',text);assert.match(r.reply,/828000001/);assert.doesNotMatch(r.reply,/أوراق|الدفعة|نفس رقم الشركة/);assert.equal(e.getCase('a').id,c.id);}
 const wrong=await e.handle('a','رقم الطلب 828000002');assert.doesNotMatch(wrong.reply,/828000002|موافقة|محفوظ معنا/);assert.match(wrong.reply,/نفس الرقم/);
});
test('unknown followup requests the reference rather than starting nationality questions',async()=>{
 const e=make();assert.match((await e.handle('new','بدي تابع طلب')).reply,/ابعت رقم الطلب/);assert.equal(e.getCase('new').lastQuestion,undefined);
 assert.match((await e.handle('new','٨٢٨٠٠٠٠٠٣')).reply,/ما قدرت أربط/);assert.equal(e.getCase('new').applicantCount,null);
});
test('multiple owned applications require exact choice, never leak another customer or guess latest',async()=>{
 const e=make(),c=savedConversation(e,'a');e.store.data.visaFulfilment.jobs.second={customer:'a',caseId:c.id,caseSignature:visaCaseSignature(c),createdAt:Date.now(),state:'saved_application',applicationReference:'828000009'};
 assert.match((await e.handle('a','حالة الطلب')).reply,/أكثر من طلب/);assert.match((await e.handle('a','E828000009')).reply,/828000009 محفوظ معنا/);
});
test('separate new application confirms and archives completed case without reusing payment, documents or nationality',async()=>{
 const e=make(),c=savedConversation(e,'a');assert.match((await e.handle('a','بدي قدم طلب جديد')).reply,/طلب جديد مستقل/);assert.equal(e.getCase('a').id,c.id);
 await e.handle('a','نعم');const next=e.getCase('a');assert.notEqual(next.id,c.id);assert.equal(next.paymentStatus,'unverified');assert.equal(next.applicantCount,null);assert.deepEqual(next.documents,[]);assert.equal(e.store.data.visaCaseArchives.a[0].id,c.id);
 assert.match((await e.handle('a','رقم الطلب 828000001')).reply,/828000001 محفوظ معنا/);assert.equal(e.getCase('a').id,next.id);
});
test('new request while current execution is active stays staged and cannot replace a paid application',async()=>{
 const e=make(),c=savedConversation(e,'a');e.store.data.visaFulfilment.jobs[Object.keys(e.store.data.visaFulfilment.jobs)[0]].state='running';await e.handle('a','بدي طلب تاني');await e.handle('a','نعم');assert.equal(e.getCase('a').id,c.id);assert.ok(e.getCase('a').pendingNewApplication);assert.equal(e.getCase('a').paymentStatus,'verified');
 assert.equal((await e.handle('a','شكوى بخصوص رقم الطلب 828000001 وما رجعتوا فلوسي')).complaint,true);
});
test('a status interruption cannot turn a later unrelated yes into a new application',async()=>{const e=make(),c=savedConversation(e,'a');await e.handle('a','بدي طلب جديد');await e.handle('a','شو صار بطلبي');await e.handle('a','نعم');assert.equal(e.getCase('a').id,c.id);assert.equal(e.store.data.visaCaseArchives?.a,undefined);});
test('pending new request attachments expire independently and are removed on privacy deletion',()=>{const now=Date.now(),store=new AssistantState({file:null,now:()=>now}),e=make({store});store.data.pendingNewVisaMedia={a:{createdAt:now,messages:[{id:'synthetic'}]},old:{createdAt:now-86400001,messages:[]}};store.prune();assert.ok(store.data.pendingNewVisaMedia.a);assert.equal(store.data.pendingNewVisaMedia.old,undefined);e.delete('a');assert.equal(store.data.pendingNewVisaMedia.a,undefined);});
