'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine,isComplaint,extractLocal}=require('../src/saudi-visa-engine');
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
 const e=make();const r=await e.handle('a','مصري جواز عادي لحالي');assert.equal(r.quote.rows[0].product,'tourist_single');assert.equal(r.quote.total,700);
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

// Exercise the real validated NLU adapter with synthetic responses, never a model call.
function familyUnderstanding(fields,{target='group'}={}){
 const {createSaudiVisaUnderstanding,schema}=require('../src/saudi-visa-nlu');
 const blanks=Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([key,value])=>[key,value.type==='array'?[]:null]));
 const decision={intent:'apply',fields:{...blanks,...fields},target,correction:false,question:null,option:null},requests=[];
 const understand=createSaudiVisaUnderstanding({env:{ASSISTANT_AI_PROVIDER:'openai',OPENAI_MODEL:'gpt-6.1-sol',OPENAI_API_KEY:'synthetic-family-test-not-a-credential',ASSISTANT_AI_FALLBACK:'none'},fetchImpl:async(url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.method,'POST');const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);requests.push(JSON.parse(body.input));
  return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(decision)}]}]})};
 }});
 return {understand,requests};
}
const mixedFamilyText='أنا سوري ورفيقتي وزوجها بدنا نقدم وهي جنسيتها مصر وزوجها متلي';
const familyPerson=nationality=>({nationality,documentType:'passport',documentIssuer:null});
test('family extraction retains three people including repeated nationality through the validated NLU adapter',async()=>{
 const people=['سوريا','مصر','سوريا'].map(familyPerson),nlu=familyUnderstanding({applicantCount:3,applicants:people}),e=make({understand:nlu.understand});
 const r=await e.handle('mixed-family',mixedFamilyText),c=e.getCase('mixed-family');
 assert.equal(nlu.requests.length,1);assert.equal(nlu.requests[0].text,mixedFamilyText);assert.equal(c.applicantCount,3);assert.deepEqual(c.applicants.map(p=>p.nationality),['سوريا','مصر','سوريا']);
 assert.equal(r.quote.total,P.calculateQuote({...c,applicantCount:3,applicants:people}).total);assert.equal(r.quote.total,1950);assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');
});
test('distinct nationality mentions do not supply a local headcount or applicant order',async()=>{
 const fields=extractLocal(mixedFamilyText,{applicantCount:null});assert.equal(fields.applicantCount,undefined);assert.equal(fields.applicants,undefined);
 const e=make(),r=await e.handle('unknown-family',mixedFamilyText),c=e.getCase('unknown-family');assert.equal(c.applicantCount,null);assert.deepEqual(c.applicants,[]);assert.equal(r.quote,null);assert.ok(c.lastQuestion);
});
test('explicit count with mixed nationality mentions keeps unknown applicant identities unknown',async()=>{
 const text='نحنا 3 أنا سوري ورفيقتي مصرية وزوجها معنا',fields=extractLocal(text,{applicantCount:null});assert.equal(fields.applicantCount,3);assert.equal(fields.applicants,undefined);
 const e=make(),r=await e.handle('explicit-family',text),c=e.getCase('explicit-family');assert.equal(c.applicantCount,3);assert.deepEqual(c.applicants,[]);assert.equal(r.quote,null);assert.equal(c.lastQuestion,'nationality');
});
test('nationality mentions do not expand a previously confirmed count or reorder its applicants',async()=>{
 const e=make();await e.handle('confirmed-family','نحنا 3 كلنا سوريين جواز عادي');const before=structuredClone(e.getCase('confirmed-family').applicants);
 await e.handle('confirmed-family','أنا سوري، معنا مصري ولبناني وأردني وسوداني');const c=e.getCase('confirmed-family');assert.equal(c.applicantCount,3);assert.deepEqual(c.applicants,before);
});
test('explicit user count wins over a conflicting semantic count without inventing a missing third person',async()=>{
 const nlu=familyUnderstanding({applicantCount:2,applicants:['سوريا','مصر'].map(familyPerson)}),e=make({understand:nlu.understand}),r=await e.handle('count-priority','نحنا 3 أنا سوري والباقي مصريين'),c=e.getCase('count-priority');
 assert.equal(nlu.requests.length,1);assert.equal(c.applicantCount,3);assert.deepEqual(c.applicants.map(p=>p.nationality),['سوريا','مصر']);assert.equal(c.lastQuestion,'nationality_2');assert.equal(r.quote,null);
});
test('same-nationality family preserves three applicants without deduplicating people',async()=>{
 const nlu=familyUnderstanding({applicantCount:3,applicants:Array.from({length:3},()=>familyPerson('سوريا'))}),e=make({understand:nlu.understand}),r=await e.handle('same-family','نحنا 3 كلنا سوريين جواز عادي'),c=e.getCase('same-family');
 assert.equal(nlu.requests.length,1);assert.equal(c.applicantCount,3);assert.deepEqual(c.applicants.map(p=>p.nationality),['سوريا','سوريا','سوريا']);assert.equal(r.quote.total,1950);
});
test('family visa understanding leaves the flight itinerary and baggage memory intact',async()=>{
 const {AssistantEngine}=require('../src/assistant-engine'),now=Date.parse('2026-11-01T08:00:00Z'),store=new AssistantState({file:null,now:()=>now}),flight=new AssistantEngine({store,env:{},nlu:async()=>null});
 const initial=await flight.handle('shared-customer','من الشارقة للشام 11-11-2026 ذهاب بس شخص واحد',{now});assert.equal(initial.complete,true);
 const amended=await flight.handle('shared-customer','بدي 40 كيلو',{now:now+1});assert.equal(amended.complete,true);assert.equal(amended.request.baggageRequest.checkedWeightKg,40);const before=structuredClone(store.get('shared-customer'));
 const nlu=familyUnderstanding({applicantCount:3,applicants:['سوريا','مصر','سوريا'].map(familyPerson)}),visa=make({store,understand:nlu.understand});await visa.handle('shared-customer',mixedFamilyText);
 assert.equal(visa.getCase('shared-customer').applicantCount,3);assert.deepEqual(store.get('shared-customer'),before);assert.equal(flight.state('shared-customer').base.request.departureDate,'2026-11-11');assert.equal(flight.state('shared-customer').base.request.baggageRequest.checkedWeightKg,40);
});
