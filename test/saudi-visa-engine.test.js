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
