'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine,isComplaint}=require('../src/saudi-visa-engine');
const P=require('../src/saudi-visa-policy');
const {visaCaseSignature}=require('../src/visa-case-signature');
const make=options=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}]},...options});
const tourist={nationality:'سوريا',documentType:'passport'};
test('payment fee questions and comparisons preserve the chosen method without requesting coordination',async()=>{
 for(const text of ['كم رسوم تابي؟','أدفع بتحويل بنكي ولا تابي؟','بدي أعرف الفرق بين التحويل البنكي وتابي','كيف الدفع برابط؟'])for(const model of [false,true]){
  const e=make();await e.handle('payment-info','سوري جواز عادي لحالي');await e.handle('payment-info','بدي دفع تابي');const before=structuredClone(e.getCase('payment-info'));
  if(model)e.understand=async()=>({intent:'payment',fields:{paymentMethod:'bank'},informationIntents:['payment']});
  const r=await e.handle('payment-info',text),after=e.getCase('payment-info');
  assert.equal(after.paymentMethod,before.paymentMethod,text);assert.deepEqual(after.quote,before.quote,text);
  assert.deepEqual(after.operatorIntervention,before.operatorIntervention,text);
  assert.equal(after.paymentStatus,'unverified');assert.match(r.reply,/خيارات الدفع/);assert.doesNotMatch(r.reply,/رح ننسّق لك/);
 }
 const e=make();await e.handle('payment-choice','سوري جواز عادي لحالي');await e.handle('payment-choice','بدي أدفع تابي، كم العمولة؟');
 assert.equal(e.getCase('payment-choice').paymentMethod,'tabby');assert.equal(e.getCase('payment-choice').quote.total,697.6);assert.equal(e.getCase('payment-choice').operatorIntervention.reason,'tabby');
 await e.handle('payment-choice','أرسل رابط دفع');assert.equal(e.getCase('payment-choice').operatorIntervention.reason,'payment_link');
});
test('Package 5 family counts understand spoken groups without counting a separate friend inquiry',async()=>{
 const {countFrom}=require('../src/saudi-visa-engine');
 for(const [text,count]of [['عيلتي 4',4],['عايلتي ٣',3],['عائلة من 5',5],['أنا وأمي',2],['أنا ووالدي',2],['أنا وأختي',2],['أنا والمدام وطفلين',4],['أنا وزوجتي وولدين',4],['أنا وزوجي وبنتي',3],['فردين',2],['أنا لحالي',1]])assert.equal(countFrom(text),count,text);
 for(const text of ['صديقي مصري','أنا ورفيقي','صلاحية 6 أشهر','عمري 40'])assert.equal(countFrom(text),null,text);
 const e=make();await e.handle('family','سوري باسبور عادي لحالي');await e.handle('family','أنا والمدام وطفلين');assert.equal(e.getCase('family').applicantCount,4);assert.equal(e.getCase('family').hasMinors,true);assert.equal(e.getCase('family').pendingRelative,undefined);assert.equal(e.getCase('family').quote?.total,undefined);
 await e.handle('friend','سوري جواز عادي لحالي');await e.handle('friend','صديقي مصري');await e.handle('friend','معه باسبورت عادي');assert.equal(e.getCase('friend').applicantCount,1);assert.equal(e.getCase('friend').applicants[0].nationality,'سوريا');assert.equal(e.getCase('friend').pendingRelative.facts.nationality,'مصر');assert.equal(e.getCase('friend').pendingRelative.facts.documentType,'passport');
});
test('Package 5 colloquial passports and issuer cities preserve nationality and the requested applicant',async()=>{
 const {extractLocal}=require('../src/saudi-visa-engine');
 for(const word of ['باسبور','باسبورت'])assert.equal(extractLocal('سوري '+word,{ }).documentType,'passport');
 const cities={'سوريا':['الشام','دمشق','حلب','حمص','حماة','اللاذقية','سورية'],'لبنان':['بيروت','صيدا','طرابلس','لبنانية'],'مصر':['القاهرة','الإسكندرية','مصرية'],'الأردن':['الأردن','عمان','إربد','الزرقاء','أردنية'],'العراق':['بغداد','البصرة','أربيل','عراقية']};
 for(const [country,aliases]of Object.entries(cities))for(const city of aliases){
  const f=extractLocal('فلسطيني وثيقة من '+city,{});assert.equal(f.documentIssuer,country,city);assert.equal(f.nationality,'فلسطين',city);
  const e=make();await e.handle('issuer','فلسطيني وثيقة لحالي');await e.handle('issuer',city);assert.equal(e.getCase('issuer').applicants[0].documentIssuer,country,city);assert.equal(e.getCase('issuer').applicants[0].nationality,'فلسطين');assert.equal(e.getCase('issuer').applicantCount,1);
 }
 for(const text of ['وثيقة من دمشق أو بيروت','وثيقة من طرابلس ليبيا','وثيقة من سلطنة عمان'])assert.equal(extractLocal(text,{}).documentIssuer,undefined,text);
 const e=make(),c=e.newCase();Object.assign(c,{applicantCount:2,applicants:[tourist,{nationality:'فلسطين',documentType:'travel_document'}],lastQuestion:'issuer_1'});e.save('group',c);await e.handle('group','بيروت');assert.deepEqual(e.getCase('group').applicants[0],tourist);assert.equal(e.getCase('group').applicants[1].documentIssuer,'لبنان');
});
test('an issuer prompt accepts a place, not a greeting, question, or ambiguous answer',async()=>{
 const e=make(),c=e.newCase();
 Object.assign(c,{applicantCount:2,applicants:[tourist,{nationality:'فلسطين',documentType:'travel_document'}],lastQuestion:'issuer_1',greeted:true});
 e.save('issuer',c);
 for(const text of ['مرحبا','شكراً','كم رسوم الوثيقة اللبنانية؟','سوريا أو لبنان','مش لبنان']){
  await e.handle('issuer',text);
  assert.deepEqual(e.getCase('issuer').applicants,c.applicants,text);
  assert.equal(e.getCase('issuer').lastQuestion,'issuer_1',text);
 }
 await e.handle('issuer','الوثيقة صادرة من بيروت');
 assert.deepEqual(e.getCase('issuer').applicants,[tourist,{nationality:'فلسطين',documentType:'travel_document',documentIssuer:'لبنان'}]);
});
test('Package 5 financial-document advice never switches payment method or sends company bank details',async()=>{
 const e=make();await e.handle('bank-question','سوري جواز عادي لحالي');e.getCase('bank-question').paymentMethod='tabby';let calls=0;e.understand=async()=>{calls++;return {intent:'bank_details',fields:{paymentMethod:'bank'}};};
 for(const text of ['هل مطلوب كشف حساب بنكي؟','شهادة راتب مطلوبة؟','بدنا رسالة لا مانع NOC؟','حساب بنكي للتقديم ضروري؟']){
  const r=await e.handle('bank-question',text);assert.match(r.reply,/ما منطلب كشف حساب/);assert.doesNotMatch(r.reply,/AE800500|AE830030|19198423/);assert.equal(e.getCase('bank-question').paymentMethod,'tabby');assert.equal(e.getCase('bank-question').paymentStatus,'unverified');
 }assert.equal(calls,0);
 const fresh=await e.handle('fresh-financial','أنا سوري باسبور عادي لحالي هل مطلوب كشف حساب بنكي؟');assert.doesNotMatch(fresh.reply,/AE800500|AE830030/);assert.equal(e.getCase('fresh-financial').paymentMethod,undefined);
 const bank=await e.handle('bank-question','بعتلي حسابكم البنكي',{messages:[{media:{id:'synthetic'}}]});assert.match(bank.reply,/AE800500/);assert.doesNotMatch(bank.reply,/إجمالي رسوم/);
});
test('Package 5 new advisory topics preserve qualified and paid cases without a new relative or minors flag',async()=>{
 for(const paid of [false,true]){
  const e=make();await e.handle('faq5','سوري جواز عادي لحالي');if(paid)e.getCase('faq5').paymentStatus='verified';const before=structuredClone(e.getCase('faq5'));let calls=0;e.understand=async()=>{calls++;return {target:'other',fields:{applicantCount:2,nationality:'مصر'}};};
  for(const [text,pattern]of [['هل في بصمة أو مقابلة؟',/عن بُعد.*البصمة/],['مقيم بقطر فيني قدم؟',/قطر.*ثلاثة أشهر.*ستة أشهر/],['معي إقامة كويتية',/الكويت/],['مقيم بالخليج',/دول الخليج/],['ابني مضاف على الجواز بيحتاج فيزا؟',/جواز سفر مستقل.*تأشيرة مستقلة/],['الأطفال مضافين عالجواز',/جواز سفر مستقل/],['جواز مستقل للطفل ضروري؟',/تسعير الأطفال/]]){
   const r=await e.handle('faq5',text);assert.match(r.reply,pattern,text);const c=e.getCase('faq5');assert.deepEqual(c.applicants,before.applicants);assert.equal(c.applicantCount,before.applicantCount);assert.equal(c.hasMinors,before.hasMinors);assert.equal(c.pendingRelative,undefined);assert.equal(c.pendingAmendment,undefined);assert.equal(c.paymentStatus,before.paymentStatus);assert.equal(c.submissionStatus,before.submissionStatus);assert.deepEqual(c.quote,before.quote);
   if(/مضاف|للطفل/.test(text))assert.doesNotMatch(r.reply,/PDF|ملصق/);
  }assert.equal(calls,0);
 }
});
test('Package 5 Umrah biometrics and compound financial questions remain conditional and use the current route',async()=>{
 const e=make();await e.handle('umrah','فلسطيني وثيقة مصرية لحالي');
 const r=await e.handle('umrah','هل لازم حضور شخصي وبصمة وكشف حساب؟');assert.match(r.reply,/أصل الجواز وأصل الهوية/);assert.match(r.reply,/إذا طُلب تسجيل بصمة/);assert.match(r.reply,/ما منطلب كشف حساب/);assert.doesNotMatch(r.reply,/فقط عند منفذ|من دون مقابلة.*وتُؤخذ/);
 await e.handle('held','إيراني جواز عادي لحالي');assert.doesNotMatch((await e.handle('held','مقيم بقطر')).reply,/مسار السياحية الإلكترونية يشمل/);
});
test('Package 5 inline reference extraction needs a known reference or an awaited contextual answer',()=>{
 const {applicationReference}=require('../src/visa-conversation-intent');
 for(const text of ['شو صار بخصوص E828000077 لو سمحت','بخصوص ٨٢٨٠٠٠٠٧٧، لو سمحت'])assert.equal(applicationReference(text,{known:['828000077']}),'828000077');
 assert.equal(applicationReference('تفضل هاد رقمي 828000077',{awaiting:true}),'828000077');
 for(const text of ['تفضل هاد رقمي 828000077','وصل مبلغ 828000077','رقمي 82800007777777','بخصوص A828000077'])assert.equal(applicationReference(text),null,text);
 assert.equal(applicationReference('المبلغ 828000077 درهم',{awaiting:true}),null);
 assert.equal(applicationReference('بخصوص E828000099 لو سمحت',{known:['828000077']}),null);
});
test('Package 5 natural reference followups select only the owned signed application',async()=>{
 const e=make();savedConversation(e,'inline','828000077');savedConversation(e,'other','828000099');const before=structuredClone(e.getCase('inline'));
 assert.match((await e.handle('inline','شو صار بخصوص E828000077 لو سمحت')).reply,/828000077 محفوظ معنا/);
 assert.deepEqual(e.getCase('inline').applicants,before.applicants);assert.equal(e.getCase('inline').paymentStatus,before.paymentStatus);
 await e.handle('unknown','بدي تابع طلب');const r=await e.handle('unknown','تفضل هاد رقمي 828000099');assert.match(r.reply,/ما قدرت أربط/);assert.doesNotMatch(r.reply,/828000099|محفوظ معنا|موافقة/);assert.equal(e.getCase('unknown').applicantCount,null);
});
test('Package 4 Palestinian travel document issuer never becomes a second traveller, including a bad model split',async()=>{
 const {extractLocal}=require('../src/saudi-visa-engine');
 for(const text of ['أنا فلسطيني سوري','فلسطيني وثيقة سورية','فلسطيني وثيقة مصرية','فلسطيني وثيقة لبنانية']){
  const fields=extractLocal(text,{applicantCount:null});assert.equal(fields.nationality,'فلسطين',text);assert.equal(fields.applicants,undefined,text);assert.equal(fields.applicantCount,undefined,text);
  const e=make({understand:async()=>({fields:{applicants:[{nationality:'فلسطين'},{nationality:'سوريا'}],applicantCount:2}})});await e.handle('doc',text);assert.equal(e.getCase('doc').applicants.length,1);assert.equal(e.getCase('doc').applicants[0].nationality,'فلسطين');assert.equal(e.getCase('doc').applicantCount,null);
 }
 const group=extractLocal('أنا فلسطيني وزوجتي سورية',{applicantCount:null});assert.equal(group.applicants.length,2);assert.equal(group.applicantCount,2);
 assert.equal(extractLocal('وثيقة سورية',{applicantCount:null}).nationality,undefined);
 assert.equal(extractLocal('أنا فلسطيني ومعي جواز فرنسي',{applicantCount:null}).nationality,undefined);
});
test('Package 4 qualification mentions the known nationality without repeating the nationality question',async()=>{
 const e=make();const r=await e.handle('warm','مغربي');assert.match(r.reply,/تمام \(المغرب\) 🌷/);assert.match(r.reply,/جواز سفر عادي أو وثيقة سفر/);assert.doesNotMatch(r.reply,/شو جنسية/);
 const next=await e.handle('warm','عادي');assert.match(next.reply,/كم شخص حابب يقدّم بالطلب/);
});
test('Package 4 daily visa questions answer all six topics without mutating applicants or payment evidence',async()=>{
 const e=make();await e.handle('faq','سوري جواز عادي لحالي');const original=structuredClone(e.getCase('faq'));let calls=0;e.understand=async()=>{calls++;return {fields:{nationality:'مصر',applicantCount:2}};};
 for(const [text,pattern]of [['التأمين الطبي مشمول؟',/640.*850.*التأمين الطبي/],['فيني اعتمر بالسياحية؟',/خارج موسم الحج.*نسك/],['بقدر ادخل من منفذ البطحاء بالسيارة؟',/المنافذ البرية.*البطحاء/],['بتطلع إلكترونية PDF أو ملصق على الجواز؟',/PDF.*واتساب/],['ما عندي إقامة أنا زائر بالإمارات',/منراجع مع المسؤول.*قبل أي التزام أو دفع/],['هل المهنة بالهوية بتفرق؟',/المسمى الوظيفي/]]){
  const r=await e.handle('faq',text);assert.match(r.reply,pattern,text);assert.deepEqual(e.getCase('faq').applicants,original.applicants,text);assert.equal(e.getCase('faq').applicantCount,original.applicantCount,text);assert.equal(e.getCase('faq').paymentStatus,original.paymentStatus);assert.equal(e.getCase('faq').submissionStatus,'not_submitted');
 }
 assert.equal(calls,0);assert.equal(e.getCase('faq').operatorIntervention.reason,'untrained_request');
});
test('Package 4 visa delivery explains Umrah originals and preserves a travel document while awaiting its issuer',async()=>{
 const e=make();await e.handle('travel-doc','فلسطيني وثيقة سفر لحالي');const before=structuredClone(e.getCase('travel-doc').applicants);assert.equal(e.getCase('travel-doc').lastQuestion,'issuer_0');
 const r=await e.handle('travel-doc','كيف بستلم الفيزا، PDF أو على الجواز؟');assert.match(r.reply,/أصل الجواز وأصل الهوية/);assert.doesNotMatch(r.reply,/بدون الحاجة لملصق/);assert.deepEqual(e.getCase('travel-doc').applicants,before);assert.match(r.reply,/صادرة من أي بلد/);
});
test('Package 4 FAQ guard preserves new qualification facts and does not bypass untrained nationalities',async()=>{
 const e=make();await e.handle('new-facts','أنا مصري جواز عادي لحالي والتأمين مشمول؟');assert.equal(e.getCase('new-facts').applicants[0].nationality,'مصر');assert.equal(e.getCase('new-facts').quote.total,640);
 e.understand=async()=>({fields:{nationality:'فيتنام',documentType:'passport',applicantCount:1}});await e.handle('untrained','فيتنام جواز عادي لحالي');const r=await e.handle('untrained','التأمين مشمول؟');assert.match(r.reply,/رح أراجع هالجنسية/);assert.doesNotMatch(r.reply,/ما في مبلغ إضافي/);
});
test('Package 4 consultation can accompany requirements and preserves actual travel-mode declarations',async()=>{
 const e=make();await e.handle('faq-compound','سوري جواز عادي لحالي');
 const r=await e.handle('faq-compound','التأمين مشمول وشو الأوراق المطلوبة؟');assert.match(r.reply,/التأمين الطبي/);assert.match(r.reply,/نسخة جواز/);
 await e.handle('faq-compound','أنا مسافر بالسيارة');assert.equal(e.getCase('faq-compound').transport,'car');
});
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
 assert.equal(P.calculateQuote(c).subtotal,1920);assert.equal(P.calculateQuote(c).total,1920);assert.equal(P.calculateQuote(c).feePending,true);
 assert.equal(P.calculateQuote(c,{feesEnabled:true}).total,2016);
 assert.equal(P.calculateQuote({...c,paymentMethod:'tabby'},{feesEnabled:true}).total,2092.8);
 assert.equal(P.calculateQuote({...c,applicants:[tourist,tourist,{nationality:'العراق',documentType:'passport'}]}).total,2130);
 assert.equal(P.calculateQuote({...c,hasMinors:true}).requiresReview,true);
 assert.equal(P.calculateQuote({...c,applicantCount:null}),null);
});
test('Ismail greets once and keeps flight state fully independent',async()=>{
 const e=make();e.store.set('a',{flight:'untouched'});const r=await e.handle('a','سوري جواز عادي لحالي');assert.match(r.reply,/إسماعيل.*الافتراضي/);assert.equal(r.quote.total,640);
 assert.deepEqual(e.store.get('a'),{flight:'untouched',at:e.store.get('a').at});assert.doesNotMatch((await e.handle('a','شكرا')).reply,/أنا إسماعيل/);
});
test('missing count is asked, then numeric shorthand completes without repeating nationality',async()=>{
 const e=make();assert.match((await e.handle('a','أنا سوري جواز عادي')).reply,/كم شخص/);
 const r=await e.handle('a','1');assert.equal(r.quote.total,640);assert.doesNotMatch(r.reply,/شو جنسية|معه جواز/);
});
test('second applicant answer never overwrites primary nationality',async()=>{
 const e=make();await e.handle('a','نحنا شخصين انا سوري جواز عادي');assert.equal(e.getCase('a').lastQuestion,'nationality_1');
 await e.handle('a','مصرية');assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').applicants[1].nationality,'مصر');
 await e.handle('a','جواز عادي');assert.equal(e.getCase('a').quote.total,1280);assert.equal(e.getCase('a').quote.rows[1].product,'tourist_single');
});
test('a bank information answer does not invent an unsent outstanding question',async()=>{
 const e=make();const r=await e.handle('a','بدي حساباتكم');assert.match(r.reply,/AE800500000000019198423/);assert.equal(e.getCase('a').lastQuestion,undefined);assert.deepEqual(e.getCase('a').askedQuestions,[]);
});
test('same-nationality explicit group gets 640 each without invented discounts',async()=>{
 const e=make();const r=await e.handle('a','نحنا 3 كلنا سوريين جواز عادي');assert.equal(r.quote.total,1920);assert.match((await e.handle('a','زبطنا ب600')).reply,/ما في خصم إضافي/);assert.equal(e.getCase('a').quote.total,1920);
});
test('each actionable visa quote includes its price, official-refusal refund and next step together',async()=>{
 for(const {text,total,price,product,cta}of [
  {text:'سوري جواز عادي لحالي',total:640,price:/640 درهم/,product:'tourist_multi',cta:/ابعت صور المستندات المطلوبة هون/},
  {text:'مصري جواز عادي لحالي',total:640,price:/640 درهم/,product:'tourist_single',cta:/ابعت صور المستندات المطلوبة هون/},
  {text:'عراقي جواز عادي لحالي',total:850,price:/850 درهم/,product:'umrah',cta:/شو تاريخ السفر/},
  {text:'نحنا 3 كلنا سوريين جواز عادي',total:1920,price:/1,920 درهم/,product:'tourist_multi',cta:/ابعت صور المستندات المطلوبة هون/}
 ]){
  const e=make(),r=await e.handle('a',text);assert.equal(r.quote.total,total);assert.equal(r.quote.rows[0].product,product);
  assert.match(r.reply,price);assert.match(r.reply,/رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي/);assert.equal((r.reply.match(/مستردة بالكامل/g)||[]).length,1);
  assert.match(r.reply,/التزام من مكتبنا/);assert.match(r.reply,/شروط الخدمة الموضحة قبل الدفع/);assert.match(r.reply,cta);assert.match(r.reply,/دون ضمان للموافقة أو موعد الصدور/);
  assert.equal(e.getCase('a').paymentStatus,'unverified');assert.equal(e.getCase('a').submissionStatus,'not_submitted');
 }
});
test('incomplete price inquiry and negotiations include the refund benefit exactly once',async()=>{
 const e=make(),price=await e.handle('price','بكم فيزا السعودية');
 assert.equal(price.quote,null);assert.match(price.reply,/640.*850/);assert.match(price.reply,/شو جنسية/);
 const unknown=await e.handle('unknown','في خصم؟');assert.equal(unknown.quote,null);assert.match(unknown.reply,/نراجع إمكانية الخصم/);assert.equal(e.getCase('unknown').operatorIntervention.reason,'discount');
 await e.handle('known','سوري جواز عادي لحالي');const known=await e.handle('known','في خصم؟');assert.equal(known.quote.total,640);
 for(const r of [price,unknown,known]){assert.match(r.reply,/مستردة بالكامل في حال الرفض الرسمي/);assert.equal((r.reply.match(/مستردة بالكامل/g)||[]).length,1);}
});
test('refund covers visa fees while payment method totals and separate fee disclosure remain intact',async()=>{
 for(const {method,enabled,fee,total}of [
  {method:'رابط الدفع',enabled:true,fee:32,total:672},
  {method:'تابي',enabled:true,fee:57.6,total:697.6},
  {method:'رابط الدفع',enabled:false,fee:32,total:672}
 ]){
  const e=make({env:{SAUDI_VISA_PAYMENT_FEES_ENABLED:String(enabled)}}),r=await e.handle('a','سوري جواز عادي لحالي '+method);
  assert.equal(r.quote.subtotal,640);assert.equal(r.quote.paymentFee,fee);assert.equal(r.quote.total,total);assert.equal(r.quote.feePending,false);
  assert.match(r.reply,/إجمالي رسوم التأشيرات: 640 درهم/);assert.match(r.reply,/رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي/);
  assert.match(r.reply,/رسوم وسيلة الدفع وأي خدمات إضافية تُوضح منفصلة قبل الاتفاق/);
  assert.match(r.reply,new RegExp('المجموع بهذه الطريقة: '+total+' درهم'));
 }
});
test('refund promotion stays out of suspended intake, child pricing review, complaints and cancellation',async()=>{
 for(const text of ['افغاني جواز عادي لحالي','سوري جواز عادي شخص واحد طفل','قدمت عندكن وما رجعتوا فلوسي','بدي الغي']){
  const r=await make().handle('a',text);assert.doesNotMatch(r.reply,/مستردة بالكامل|ميزة خاصة لعملائنا/,text);
 }
});
test('suspended intake does not ask payment or promise an opening date',async()=>{
 const e=make();const r=await e.handle('a','افغاني جواز عادي لحالي');assert.equal(r.quote,null);assert.match(r.reply,/متوقف/);assert.doesNotMatch(r.reply,/640|850|ابعث.*دفع/);
});
test('travel document issuer is not inferred nationality; missing issuer needs an actual answer',async()=>{
 const e=make();await e.handle('a','معي وثيقة لبنانية لحالي');assert.equal(e.getCase('a').applicants[0].nationality,undefined);assert.equal(e.getCase('a').applicants[0].documentIssuer,'لبنان');
 const r=await e.handle('a','فلسطيني');assert.equal(r.quote.total,850);assert.match(r.reply,/أصل الجواز وأصل الهوية/);
});
test('ordinary Egyptian passport is single tourism, not a Palestinian Egyptian document',async()=>{
 const e=make();const r=await e.handle('a','مصري جواز عادي لحالي');assert.equal(r.quote.rows[0].product,'tourist_single');assert.equal(r.quote.total,640);assert.match(r.reply,/حسب سياسة منصة التقديم الحالية/);assert.match(r.reply,/للجنسية المصرية خلال هذا الموسم/);assert.match(r.reply,/متعددة الدخول غير متاحة حاليًا/);
});
test('refund, cancellation and payment after issuance are distinct actions',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');assert.match((await e.handle('a','الدفع بعد الاصدار')).reply,/ما عنا دفع بعد الإصدار/);
 assert.match((await e.handle('a','هل الرسوم مستردة عند الرفض')).reply,/التزام من مكتبنا/);
 const r=await e.handle('a','بدي الغي');assert.match(r.reply,/200/);assert.equal(e.getCase('a').cancellation.state,'awaiting_confirmation');
 await e.handle('a','نعم');assert.equal(e.getCase('a').cancellation.state,'review_requested');assert.notEqual(e.getCase('a').stage,'cancelled');
});
test('payment receipt does not prove payment and repeated receipt cannot downgrade staff confirmation',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');await e.handle('a','حولت');assert.equal(e.getCase('a').paymentStatus,'awaiting_verification');
 const sig=visaCaseSignature(e.getCase('a'));Object.assign(e.getCase('a'),{paymentStatus:'verified',submissionStatus:'submitted',stage:'submitted',staffVerification:{payment:{amount:640,reference:'ref',caseSignature:sig},submission:{reference:'submitted-ref',caseSignature:sig}}});
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
 const r=await e.handle('a','سعر الفيزا');assert.equal(r.quote.total,640);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.doesNotMatch(r.reply,/تم التقديم والموافقة/);
});
test('model correction overrides stale multi-nationality extraction',async()=>{
 const e=make({understand:async()=>({intent:'price',correction:true,fields:{nationality:'مصر',documentType:'passport',applicantCount:1}})});
 const r=await e.handle('a','مو سوري انا مصري');assert.equal(r.quote.rows[0].product,'tourist_single');assert.equal(e.getCase('a').applicantCount,1);
});
test('staff revision cancels stale understanding output',async()=>{
 let finish;const e=make({understand:()=>new Promise(resolve=>finish=resolve)});e.save('a',e.newCase());const pending=e.handle('a','مرحبا');e.getCase('a').revision++;finish({intent:'price',fields:{nationality:'سوريا',documentType:'passport',applicantCount:1}});assert.equal((await pending).superseded,true);assert.equal(e.getCase('a').quote,undefined);
});
test('attachments bypass external understanding and cannot claim quality review',async()=>{
 let called=false;const e=make({understand:async()=>{called=true;return null;}});const r=await e.handle('a','[ملف جواز]',{messages:[{media:{id:'test'}}]});assert.equal(called,false);assert.match(r.reply,/وصلت أوراقك/);assert.equal(e.getCase('a').stage,'documents_pending_review');
});
test('sensitive history is redacted and deleting visa data does not delete flight state',async()=>{
 const e=make();e.store.set('a',{status:'flight_active'});await e.handle('a','رقم الجواز N016671869 ورقم الهوية 784-1990-4260790-5');assert.doesNotMatch(JSON.stringify(e.getCase('a').history),/N016671869|784-1990/);
 await e.handle('a','احذف بياناتي');assert.equal(e.getCase('a'),null);assert.equal(e.store.get('a').status,'flight_active');
});
test('unknown children price is not silently quoted as adults',async()=>{
 const e=make();const r=await e.handle('a','سوري جواز عادي شخص واحد طفل');assert.equal(r.quote.requiresReview,true);assert.match(r.reply,/تسعير الحالة/);
});
test('amendments after verified payment preserve original paid case and record a review proposal',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي لحالي');const c=e.getCase('a');c.paymentStatus='verified';c.stage='payment_verified';c.staffVerification={payment:{amount:640,reference:'confirmed',caseSignature:visaCaseSignature(c)}};
 const r=await e.handle('a','صاروا 3 اشخاص');assert.match(r.reply,/حفظنا التعديل للمراجعة/);assert.equal(e.getCase('a').applicantCount,1);assert.equal(e.getCase('a').quote.total,640);assert.equal(e.getCase('a').paymentStatus,'verified');assert.equal(e.getCase('a').pendingAmendment.facts.applicantCount,3);
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
 const details=await e.handle('a','شو التفاصيل بعد اذنك');assert.match(details.reply,/الفلسطينية.*العمرة/);assert.doesNotMatch(details.reply,/640|إجمالي رسوم/);
 const question=await e.handle('a','حتى الفلسطيني بتطلع لو؟');assert.match(question.reply,/العمرة/);assert.match(question.reply,/ما في ضمان للموافقة/);assert.doesNotMatch(question.reply,/إجمالي رسوم|640|أكيد بتطلع/);
 assert.deepEqual(e.getCase('a').applicants,original);assert.equal(e.getCase('a').applicantCount,1);assert.equal(e.getCase('a').quote.total,640);assert.equal(visaCaseSignature(e.getCase('a')),signature);
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
 assert.match(r.reply,/التفاصيل البنكية المعتمدة/);assert.match(r.reply,/AE800500000000019198423/);assert.doesNotMatch(r.reply,/إجمالي رسوم|وصلتنا رسالتك المتعلقة بالمستندات/);
 assert.equal(e.getCase('a').applicants[0].nationality,'سوريا');assert.equal(e.getCase('a').paymentStatus,'unverified');
});
test('returning visa greetings keep the current question without repeating a price or checklist',async()=>{
 const e=make();await e.handle('a','سوري جواز عادي');assert.equal(e.getCase('a').lastQuestion,'applicantCount');
 const r=await e.handle('a','مرحبا');assert.match(r.reply,/نفس طلب التأشيرة/);assert.doesNotMatch(r.reply,/640|نسخة جواز|إجمالي رسوم/);assert.equal(e.getCase('a').lastQuestion,'applicantCount');
});
test('visa erasure clears upload capabilities and prepared-delivery records for this customer only',async()=>{
 const e=make({store:{data:{},save(){}}});await e.handle('a','سوري جواز عادي لحالي');e.store.data.visaUpload={sessions:{one:{customer:'a'},two:{customer:'b'}}};e.store.data.visaPreparedDeliveries={items:{one:{customer:'a'},two:{customer:'b'}}};
 e.delete('a');assert.deepEqual(e.store.data.visaUpload.sessions,{two:{customer:'b'}});assert.deepEqual(e.store.data.visaPreparedDeliveries.items,{two:{customer:'b'}});
});
test('known quote is not repeated for actual apply/how-to/will-send followups while direct price remains available',async()=>{
 const e=make(),initial=await e.handle('a','سوري جواز عادي لحالي');assert.match(initial.reply,/640/);const signature=visaCaseSignature(e.getCase('a'));
 const apply=await e.handle('a','هلا، بدي قدم فيزا السعودية لو سمحت');assert.match(apply.reply,/نسخة جواز|صور المستندات|جواز/);assert.doesNotMatch(apply.reply,/640|إجمالي رسوم/);
 const how=await e.handle('a','كيف بقدم شو ابعتلك');assert.match(how.reply,/جواز|الهوية/);assert.doesNotMatch(how.reply,/640|إجمالي رسوم/);
 const future=await e.handle('a','طيب رح ابعتلك');assert.match(future.reply,/^تمام، ابعتهن هون/);assert.doesNotMatch(future.reply,/640|جواز|إجمالي رسوم/);
 const acknowledged=await e.handle('a','اوكي');assert.doesNotMatch(acknowledged.reply,/640|إجمالي رسوم/);assert.equal(visaCaseSignature(e.getCase('a')),signature);
 const price=await e.handle('a','شو السعر؟');assert.match(price.reply,/640/);assert.equal(e.getCase('a').paymentStatus,'unverified');assert.equal(e.getCase('a').submissionStatus,'not_submitted');
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
test('current document conflict is not answered with an archived application reference and never silently changes nationality',async()=>{const e=make(),old=savedConversation(e,'a');e.store.data.visaCaseArchives={a:[structuredClone(old)]};const current=e.newCase();current.applicantCount=1;current.applicants=[{nationality:'مصر',documentType:'passport'}];current.documents=[{id:'synthetic-new-passport'}];e.save('a',current);e.store.data.visaDocumentIntake={cases:{a:{caseId:current.id,caseSignature:visaCaseSignature(current),status:'needs_review',applicants:[{issues:[{code:'CASE_DATA_MISMATCH',field:'nationalityCode'}]}]}}};const reply=await e.handle('a','شو صار بطلبي');assert.match(reply.reply,/طلبك معنا/);assert.doesNotMatch(reply.reply,/لنفس الشخص|شخص تاني|CASE_DATA/);assert.doesNotMatch(reply.reply,/828000001/);assert.equal(e.getCase('a').applicants[0].nationality,'مصر');assert.match((await e.handle('a','رقم الطلب 828000001')).reply,/828000001 محفوظ معنا/);});

test('Palestinian tourism objections get a trained original-document Umrah explanation instead of unknown escalation or guaranteed refusal',async()=>{
 const e=make();await e.handle('consult','فلسطيني وثيقة سفر سورية لحالي');
 for(const text of ['ليش عمره','مافينا نقدمه سياحيه','فينا نحاول سياحية؟']){
  const r=await e.handle('consult',text);assert.match(r.reply,/850/);assert.match(r.reply,/أصل الجواز وأصل الهوية/);assert.match(r.reply,/خسارة/);assert.match(r.reply,/مستردة بالكامل/);assert.doesNotMatch(r.reply,/رح تنرفض|حسب الخارجية|يراجعه المسؤول|التقديم عنا أونلاين/);assert.equal(e.getCase('consult').operatorIntervention,undefined);
 }
});
test('current price is 640 tourist and 850 Umrah while an already paid 700 quote remains unchanged',async()=>{
 const e=make(),r=await e.handle('legacy','سوري جواز عادي لحالي');assert.equal(r.quote.total,640);assert.equal(P.PRICES.umrah,850);
 const c=e.getCase('legacy');c.quote.total=700;c.quote.subtotal=700;c.quote.rows[0].amount=700;c.paymentStatus='verified';c.staffVerification={payment:{amount:700,reference:'old-price',caseSignature:visaCaseSignature(c)}};
 await e.handle('legacy','شو السعر؟');assert.equal(e.getCase('legacy').quote.total,700);assert.equal(e.getCase('legacy').paymentStatus,'verified');
});
test('untrained questions including visa terminology are escalated even without model understanding',async()=>{
 const e=make();await e.handle('unknown','سوري جواز عادي لحالي');const r=await e.handle('unknown','شو نظام أولوية التأشيرة الاستثنائي؟');assert.equal(e.getCase('unknown').operatorIntervention.reason,'untrained_request');assert.match(r.reply,/جواب دقيق/);assert.doesNotMatch(r.reply,/تم التقديم|700/);
});

test('model greeting classification cannot hide a substantive visa address question',async()=>{const e=make({understand:async()=>({intent:'greeting',fields:{},target:null})});await e.handle('a','سوري جواز عادي لحالي');const r=await e.handle('a','وين مكتبكم؟');assert.match(r.reply,/لا يستقبل العملاء/);assert.doesNotMatch(r.reply,/ومنكمل على نفس/);});
test('compound qualified visa inquiry retains quote and answers payment and timing',async()=>{const e=make();const r=await e.handle('ux','سوري جواز عادي لحالي كم يوم وطرق الدفع وشو الاوراق');assert.match(r.reply,/640/);assert.match(r.reply,/6–7/);assert.match(r.reply,/5%/);assert.match(r.reply,/جواز/);});

test('additional trained nationalities accept Arabic and English aliases without guessing Vietnam',async()=>{
 const aliases={
  'المغرب':['المغرب','مغربي','مغربيه','morocco','moroccan'],
  'تونس':['تونس','تونسي','تونسيه','tunisia','tunisian'],
  'الجزائر':['الجزائر','جزائري','جزائريه','algeria','algerian'],
  'موريتانيا':['موريتانيا','موريتاني','موريتانيه','mauritania','mauritanian'],
  'تركيا':['تركيا','تركي','تركيه','turkey','turkish'],
  'روسيا':['روسيا','روسي','روسيه','russia','russian'],
  'أستراليا':['استراليا','استرالي','استراليه','australia','australian'],
  'نيوزيلندا':['نيوزيلندا','نيوزيلندي','new zealand']
 };
 for(const [country,words]of Object.entries(aliases))for(const word of words){
  assert.equal(P.canonicalNationality(word),country);assert.deepEqual(P.nationalities('انا '+word+' جواز عادي'),[country]);
  const e=make(),r=await e.handle('a',word+' جواز عادي لحالي');assert.equal(e.getCase('a').applicants[0].nationality,country);assert.equal(r.quote.total,640);assert.equal(r.quote.rows[0].product,'tourist_multi');
 }
 assert.deepEqual(P.nationalities('فيتنام vietnam'),[]);assert.equal(P.productFor({nationality:'فيتنام',documentType:'passport'}).code,'unverified');
});
test('child pricing gives only adult guidance for a group and never quotes a child total or refund',()=>{
 const {quoteText}=require('../src/saudi-visa-engine');
 for(const [person,expected]of [[tourist,640],[{nationality:'العراق',documentType:'passport'},850]]){
  for(const extra of [{hasMinors:true},{applicants:[person,{...person,age:7}]}]){
   const q=P.calculateQuote({applicantCount:2,applicants:[person,person],...extra});
   assert.equal(q.requiresReview,true);assert.equal(q.reason,'child_pricing');assert.equal(q.adultReferenceAmount,expected);assert.equal(q.adultLabel,P.productFor(person).label);assert.equal(q.total,undefined);assert.equal(q.rows,undefined);
   const reply=quoteText(q);assert.match(reply,new RegExp('رسوم الشخص البالغ.*'+expected));assert.match(reply,/يُؤكد الإجمالي بعد مراجعة تسعير الطفل مع المسؤول/);assert.doesNotMatch(reply,/مسترد|استرداد|إجمالي رسوم التأشيرات/);
  }
 }
 const single=P.calculateQuote({applicantCount:1,applicants:[{...tourist,age:6}]});assert.equal(single.adultReferenceAmount,undefined);assert.doesNotMatch(quoteText(single),/للإرشاد|640|مسترد/);
 const adults=P.calculateQuote({applicantCount:2,applicants:[{...tourist,age:18},tourist]});assert.equal(adults.total,1280);
});
test('qualified family with a child receives adult reference while remaining pending review',async()=>{
 const e=make();await e.handle('a','نحنا 2 كلنا سوريين جواز عادي');const r=await e.handle('a','معي طفل');
 assert.equal(r.quote.requiresReview,true);assert.equal(r.stage,'pricing_review');assert.match(r.reply,/للإرشاد.*640/);assert.doesNotMatch(r.reply,/مسترد|تم التقديم/);assert.equal(e.getCase('a').paymentStatus,'unverified');
});
test('mentioning a child after verified payment proposes review without changing the paid quote',async()=>{
 const e=make();await e.handle('a','نحنا 2 كلنا سوريين جواز عادي');const c=e.getCase('a');c.paymentStatus='verified';c.quote.rows.forEach(row=>row.amount=700);c.quote.subtotal=1400;c.quote.total=1400;e.save('a',c);const paid=structuredClone(c.quote);
 await e.handle('a','معي طفل');const after=e.getCase('a');assert.equal(after.stage,'amendment_review');assert.equal(after.pendingAmendment.facts.hasMinors,true);assert.equal(after.hasMinors,undefined);assert.deepEqual(after.quote,paid);assert.equal(after.paymentStatus,'verified');
});


test('document validity questions answer directly without inventing facts or escalating',async()=>{
 const e=make({understand:async()=>{throw Error('Guidance should not need a model');}});
 for(const text of ['كم لازم تكون صلاحية الجواز لتأشيرة السعودية؟','الجواز لازم تكون صلاحيته كم شهر؟','الإقامة كم باقي بصلاحيتها؟','متى انتهاء الهوية؟']){
  const r=await e.handle('validity',text);assert.equal(r.intent,'visa_info');assert.match(r.reply,/6 أشهر.*عند السفر/);assert.match(r.reply,/3 أشهر/);assert.match(r.reply,/مجموعة الرمال/);assert.equal(e.getCase('validity').operatorIntervention,undefined);assert.equal(e.getCase('validity').applicants[0]?.documentType,undefined);assert.doesNotMatch(r.reply,/فوراً|الصحراء/);
 }
 await e.handle('paid-validity','سوري جواز عادي لحالي');const c=e.getCase('paid-validity');c.paymentStatus='verified';const before=structuredClone(c);
 const r=await e.handle('paid-validity','كم صلاحية الجواز المطلوبة؟');assert.equal(r.intent,'visa_info');assert.deepEqual(e.getCase('paid-validity').applicants,before.applicants);assert.deepEqual(e.getCase('paid-validity').quote,before.quote);assert.equal(e.getCase('paid-validity').pendingAmendment,undefined);
});
test('multi-entry quote adds actual product validity without changing single-entry child or payment rules',()=>{
 const {quoteText}=require('../src/saudi-visa-engine');
 const multi=P.calculateQuote({applicantCount:1,applicants:[tourist],paymentMethod:'link'},{feesEnabled:true});
 assert.match(quoteText(multi),/صلاحية سنة.*90 يوماً.*شروط التأشيرة الصادرة/);assert.match(quoteText(multi),/640 درهم/);assert.match(quoteText(multi),/672 درهم/);
 const single=P.calculateQuote({applicantCount:1,applicants:[{nationality:'مصر',documentType:'passport'}]});assert.doesNotMatch(quoteText(single),/صلاحية سنة/);
 const child=P.calculateQuote({applicantCount:2,applicants:[tourist,{...tourist,age:10}]});assert.doesNotMatch(quoteText(child),/صلاحية سنة|مستردة/);
});

test('Package 6 family language counts explicit companions without absorbing an independent inquiry',async()=>{
 const {countFrom}=require('../src/saudi-visa-engine');
 for(const [text,count]of [['انا واهلي',null],['انا وامي وابوي',3],['انا ووالدي ووالدتي',3],['انا واخوي',2],['انا وابوي',2],['انا وزوجتي وطفلين',4],['عيلتي 5',5]])assert.equal(countFrom(text),count,text);
 const e=make();await e.handle('family6','سوري باسبور عادي لحالي');await e.handle('family6','أنا وأخوي');assert.equal(e.getCase('family6').applicantCount,2);assert.equal(e.getCase('family6').applicants[1]?.nationality,undefined);
 const other=make();await other.handle('friend6','سوري باسبور عادي لحالي');await other.handle('friend6','صديقي مصري');assert.equal(other.getCase('friend6').applicantCount,1);assert.equal(other.getCase('friend6').pendingRelative.facts.nationality,'مصر');
});
test('Package 6 shared issuer canonicalization preserves conflicts and handles additional cities',()=>{
 for(const [value,country]of [['من الشام','سوريا'],['من طرطوس','سوريا'],['من بيروت','لبنان'],['من صور','لبنان'],['من القاهرة','مصر'],['من اسكندرية','مصر'],['من الجيزة','مصر'],['أردنية','الأردن'],['من بغداد','العراق']])assert.equal(P.canonicalIssuer(value),country,value);
 for(const value of ['دمشق أو بيروت','طرابلس ليبيا','سلطنة عمان'])assert.equal(P.canonicalIssuer(value),value);
 assert.equal(P.canonicalIssuer(''),null);
});
test('Package 6 travel dates retain written order, validate calendar days and exclude document expiry',()=>{
 const {extractLocal}=require('../src/saudi-visa-engine');
 for(const date of ['15/11/2026','15.11.2026','15-11-2026','١٥/١١/٢٠٢٦'])assert.equal(extractLocal('سفري '+date,{}).departureDate,'2026-11-15');
 const mixed=extractLocal('الذهاب 15/11/2026 والعودة 2026-11-25',{});assert.equal(mixed.departureDate,'2026-11-15');assert.equal(mixed.returnDate,'2026-11-25');
 assert.equal(extractLocal('العودة 25/11/2026',{departureDate:'2026-11-15'}).returnDate,'2026-11-25');
 for(const date of ['31/02/2026','2026-02-31','29/02/2025','15/13/2026'])assert.equal(extractLocal('سفري '+date,{}).departureDate,undefined);
 assert.equal(extractLocal('سفري 29/02/2028',{}).departureDate,'2028-02-29');assert.equal(extractLocal('جواز السفر ينتهي 15/11/2026',{}).departureDate,undefined);
});
test('Package 6 business-day estimates skip weekends and never promise an issuance date',async()=>{
 const {workingDaysBetween,travelFitCopy}=require('../src/saudi-visa-engine'),now=Date.parse('2026-11-04T12:00:00Z');
 assert.equal(workingDaysBetween(Date.parse('2026-11-06T12:00Z'),Date.parse('2026-11-10T23:00Z')),2);
 assert.equal(workingDaysBetween(Date.parse('2026-11-06'),Date.parse('2026-11-08')),0);
 assert.equal(workingDaysBetween(now,now+14*86400000),10);for(const value of [NaN,Infinity,now-1])assert.equal(workingDaysBetween(now,value),0);
 assert.match(travelFitCopy('2026-11-06',now),/2 أيام عمل.*الوقت ضيق.*ما فينا نضمن/);
 assert.match(travelFitCopy('2026-11-18',now),/10 أيام عمل.*العطل الرسمية.*ما بيضمن/);
 for(const date of ['2026-02-31','2026-11-03','bad'])assert.equal(travelFitCopy(date,now),'');
 const e=make({now:()=>now});const r=await e.handle('travel6','سوري جواز عادي لحالي سفري 06/11/2026');assert.match(r.reply,/640/);assert.match(r.reply,/الوقت ضيق/);
 const follow=await e.handle('travel6','كم يوم بتاخد؟');assert.match(follow.reply,/2026-11-06/);assert.doesNotMatch(follow.reply,/شو تاريخ السفر/);
});
test('Package 6 followup timeline uses saved evidence and preserves approved and private states',async()=>{
 const now=Date.parse('2026-11-10T12:00Z'),e=make({now:()=>now}),c=savedConversation(e,'timeline6','828999111');const job=Object.values(e.store.data.visaFulfilment.jobs)[0];
 job.createdAt=Date.parse('2026-10-01');job.savedAt=Date.parse('2026-11-06T10:00Z');assert.match((await e.handle('timeline6','شو صار بطلبي')).reply,/مرّ 2 من أصل 6–7 أيام عمل/);
 delete job.savedAt;job.manualCompletion={at:Date.parse('2026-11-06T10:00Z')};assert.match(e.applicationUpdate(job),/مرّ 2/);
 delete job.manualCompletion;job.state='portal_review_required';assert.doesNotMatch(e.applicationUpdate(job),/مرّ|تم تقديم/);
 c.staffVerification={decision:{caseSignature:visaCaseSignature(c),value:'approved'}};e.save('timeline6',c);assert.match(e.applicationUpdate(job),/قرار موافقة/);assert.doesNotMatch(e.applicationUpdate(job),/مرّ/);
 const wrong=await e.handle('outsider6','رقم الطلب 828999111');assert.match(wrong.reply,/لخصوصية ملفك/);assert.doesNotMatch(wrong.reply,/قرار موافقة|مرّ|828999111/);
});
test('Package 6 refund disclosure is recorded only when shown, survives restart and resets per case',async()=>{
 const e=make(),first=await e.handle('refund6','سوري جواز عادي لحالي');assert.ok(first.reply.includes(P.REFUND_BENEFIT));assert.deepEqual(e.getCase('refund6').disclosuresShown,['refund']);
 const restarted=make({store:e.store});for(const text of ['كم السعر؟','بدي رابط دفع','غالي','شو السعر؟']){const r=await restarted.handle('refund6',text);assert.doesNotMatch(r.reply,/ميزة خاصة لعملائنا/);assert.match(r.reply,/مستردة بالكامل.*الرفض الرسمي/);}
 assert.deepEqual(restarted.getCase('refund6').disclosuresShown,['refund']);assert.deepEqual(restarted.newCase().disclosuresShown,[]);
 const unseen=make();await unseen.handle('unseen6','سوري جواز عادي لحالي كم يوم وطرق الدفع');assert.deepEqual(unseen.getCase('unseen6').disclosuresShown,['refund']);
 const bank=make();await bank.handle('bank6','سوري جواز عادي لحالي حسابكم البنكي',{messages:[{media:{id:'synthetic'}}]});assert.deepEqual(bank.getCase('bank6').disclosuresShown,[]);const quoted=await bank.handle('bank6','كم السعر؟');assert.ok(quoted.reply.includes(P.REFUND_BENEFIT));
 const umrah=make();assert.ok((await umrah.handle('umrah6','فلسطيني جواز عادي لحالي')).reply.includes(P.REFUND_BENEFIT));assert.doesNotMatch((await umrah.handle('umrah6','ليش عمرة ما فينا سياحية؟')).reply,/ميزة خاصة لعملائنا/);
});
test('Package 6 multi-intent answers cover timing address bank and eligibility without losing financial guards',async()=>{
 const e=make(),r=await e.handle('compound6','سوري جواز عادي لحالي كم يوم وبدّي عنوان المكتب وحسابكم البنكي');
 for(const pattern of [/6–7/,/610/,/AE800500/,/إجمالي رسوم التأشيرات: 640/])assert.match(r.reply,pattern);
 const before=structuredClone(e.getCase('compound6'));const follow=await e.handle('compound6','كم يوم ووين مكتبكم وحسابكم البنكي؟');for(const pattern of [/6–7/,/610/,/AE800500/])assert.match(follow.reply,pattern);assert.doesNotMatch(follow.reply,/إجمالي رسوم/);assert.equal(visaCaseSignature(e.getCase('compound6')),visaCaseSignature(before));
 const bank=await e.handle('compound6','كم يوم وحسابكم البنكي',{messages:[{media:{id:'synthetic'}}]});assert.match(bank.reply,/AE800500/);assert.doesNotMatch(bank.reply,/إجمالي رسوم/);
 const mixed=await e.handle('newadvice6','سوري باسبور عادي لحالي لازم تبصيم وشهادة راتب وكم يوم؟');assert.match(mixed.reply,/البصمة/);assert.match(mixed.reply,/ما منطلب كشف حساب/);assert.match(mixed.reply,/6–7/);assert.match(mixed.reply,/640/);assert.doesNotMatch(mixed.reply,/AE800500/);
 e.getCase('compound6').paymentStatus='verified';const amendment=await e.handle('compound6','نحنا 3 وكم يوم وحسابكم البنكي');assert.match(amendment.reply,/التعديل/);assert.doesNotMatch(amendment.reply,/إجمالي رسوم/);assert.equal(e.getCase('compound6').applicantCount,1);
});
test('Package 6 expanded advisory synonyms do not create a child or alter payment',async()=>{
 const e=make();await e.handle('faq6','سوري جواز عادي لحالي');const before=structuredClone(e.getCase('faq6'));
 for(const [text,pattern]of [['تبصيم ضروري؟',/البصمة/],['تعريف بالراتب لازم؟',/ما منطلب كشف حساب/],['مقيم بسلطنة عمان',/عُمان/],['إقامة خليجية',/الخليج/],['بنتي على جواز الأم',/جواز سفر مستقل/],['مضافة على جواز',/جواز سفر مستقل/],['طفل على جواز الأب',/جواز سفر مستقل/]]){const r=await e.handle('faq6',text);assert.match(r.reply,pattern,text);assert.equal(visaCaseSignature(e.getCase('faq6')),visaCaseSignature(before));assert.equal(e.getCase('faq6').hasMinors,undefined);assert.equal(e.getCase('faq6').pendingRelative,undefined);}
});
test('Package 6 payment acknowledgement cannot confirm a stale or forged verified flag',async()=>{
 const e=make();await e.handle('payment6','سوري جواز عادي لحالي');e.getCase('payment6').paymentStatus='verified';
 const r=await e.handle('payment6','حولت وأرسلت الإيصال');assert.match(r.reply,/نتحقق من وصول الدفعة/);assert.doesNotMatch(r.reply,/الدفعة مؤكدة بالفعل|تم تقديم/);assert.equal(e.getCase('payment6').paymentStatus,'awaiting_verification');assert.equal(e.getCase('payment6').submissionStatus,'not_submitted');
});


test('Package 7 dialect counts preserve family membership and separate friends',async()=>{
 const {countFrom,extractLocal}=require('../src/saudi-visa-engine');
 for(const [text,count]of [['أنا لوحدي',1],['بطولي',1],['بس انا',1],['أنا ومراتي',2],['أنا وجوزي',2],['أنا والحرمة',2],['نفرين',2],['احنا اتنين',2],['أنا وعيالي',null],['احنا 4 انفار',4],['أنا ومراتي وطفلين',4],['أنا وأمي وأبوي',3]])assert.equal(countFrom(text),count,text);
 for(const text of ['أنا وصديقي','أنا ورفيقي','صديقي مصري','جوازه صالح 6 أشهر'])assert.equal(countFrom(text),null,text);
 assert.equal(extractLocal('مسافر بالعربية',{}).transport,'car');assert.equal(extractLocal('مسافر بالعربية للطيران',{}).transport,'air');assert.equal(extractLocal('احنا 4 كلنا سوريين جواز عادي',{}).applicants.length,4);
 const e=make();await e.handle('dialect7','سوري جواز عادي لحالي');await e.handle('dialect7','أنا وصديقي');assert.equal(e.getCase('dialect7').applicantCount,1);assert.ok(e.getCase('dialect7').pendingRelative);
});
test('Package 7 case summary reads only this customer without model extraction or changing evidence',async()=>{
 const e=make();const empty=await e.handle('summary7','لخصلي طلبي');assert.match(empty.reply,/لسا ما سجلنا بيانات/);
 await e.handle('summary7','سوري جواز عادي لحالي سفري 20/12/2026 بالسيارة');const c=e.getCase('summary7');c.applicants[0].passportNumber='PRIVATE-PASSPORT';c.applicants[0].name='PRIVATE-NAME';c.paymentStatus='verified';e.save('summary7',c);
 const before=visaCaseSignature(c);let calls=0;e.understand=async()=>{calls++;return {fields:{applicantCount:20,nationality:'مصر'}};};
 for(const text of ['لخصلي طلبي','شو سجلتوا عندي بملفي؟','ايش تفاصيل طلبي']){const answer=await e.handle('summary7',text);for(const pattern of [/ملخص طلب/,/عدد المتقدمين: 1/,/سوريا/,/2026-12-20/,/برًا بالسيارة/,/640 درهم/])assert.match(answer.reply,pattern);assert.doesNotMatch(answer.reply,/PRIVATE|الدفعة مؤكدة|تم تقديم/);assert.equal(visaCaseSignature(e.getCase('summary7')),before);}
 assert.equal(calls,0);assert.match((await e.handle('stranger7','ملخص ملفي')).reply,/لسا ما سجلنا بيانات/);
 e.getCase('summary7').staffVerification={payment:{caseSignature:before,amount:640}};assert.match((await e.handle('summary7','ملخص طلبي')).reply,/الدفعة مؤكدة من القسم/);
});
test('Package 7 mixed family links issuer to second applicant and distinguishes document paths',async()=>{
 const e=make();await e.handle('mixed7','أنا سوري ومراتي فلسطينية');assert.equal(e.getCase('mixed7').applicantCount,2);assert.equal(e.getCase('mixed7').lastQuestion,'documentType');
 await e.handle('mixed7','جواز عادي');assert.equal(e.getCase('mixed7').lastQuestion,'documentType_1');
 const result=await e.handle('mixed7','وثيقة سفر من مصر');const c=e.getCase('mixed7');assert.equal(c.applicants[0].nationality,'سوريا');assert.equal(c.applicants[0].documentType,'passport');assert.equal(c.applicants[0].documentIssuer,undefined);assert.equal(c.applicants[1].nationality,'فلسطين');assert.equal(c.applicants[1].documentIssuer,'مصر');assert.equal(c.applicants[1].documentType,'travel_document');assert.equal(c.quote.total,1490);
 for(const pattern of [/توضيح مسار المستندات للمجموعة المختلطة/,/المتقدم \(1 — سياحية أونلاين\)/,/المتقدم \(2 — عمرة عبر السفارة\)/,/35 درهماً/])assert.match(result.reply,pattern);
 assert.doesNotMatch(result.reply,/بتفضّل تسلّم أصل/);assert.match(result.reply,/حسب مسار كل متقدم/);
 const flight=await e.handle('mixed7','رح نسافر بالطيران');assert.match(flight.reply,/قسم الطيران.*تجهيزها/);assert.equal(e.getCase('mixed7').transport,'air');assert.equal(e.getCase('mixed7').submissionStatus,'not_submitted');
});
test('Package 7 targeted issuer ignores a model nationality for the issuing country',async()=>{
 const e=make();await e.handle('target7','أنا سوري ومراتي فلسطينية');await e.handle('target7','جواز عادي');
 e.understand=async()=>({fields:{documentType:'travel_document',documentIssuer:'مصر',nationality:'مصر'}});
 await e.handle('target7','وثيقة سفر من مصر');assert.equal(e.getCase('target7').applicants[0].nationality,'سوريا');assert.equal(e.getCase('target7').applicants[1].nationality,'فلسطين');assert.equal(e.getCase('target7').applicants[1].documentIssuer,'مصر');
});
test('Package 7 dialect receipt and paperwork acknowledgements never verify payment or submit',async()=>{
 for(const text of ['طرشت الاوراق','دزيت الورق','بعت الورق']){const e=make();await e.handle('papers7','سوري جواز عادي لحالي');const reply=await e.handle('papers7',text);assert.match(reply.reply,/وصلت أوراقك/);assert.equal(e.getCase('papers7').stage,'documents_pending_review');assert.equal(e.getCase('papers7').paymentStatus,'unverified');}
 for(const text of ['طرشت التحويل','دزيت التحويل','طرشت الايصال']){const e=make();await e.handle('receipt7','سوري جواز عادي لحالي');const reply=await e.handle('receipt7',text);assert.match(reply.reply,/نتحقق من وصول الدفعة/);assert.equal(e.getCase('receipt7').paymentStatus,'awaiting_verification');assert.equal(e.getCase('receipt7').submissionStatus,'not_submitted');assert.match((await e.handle('receipt7','لخصلي طلبي')).reply,/إشعار التحويل بانتظار التحقق/);}
});
test('Package 7 dialect price questions retain quote and office wording is not a price request',async()=>{
 const e=make();await e.handle('price7','سوري جواز عادي لحالي');for(const text of ['بكام؟','جم السعر؟','شقد؟','شحال؟'])assert.match((await e.handle('price7',text)).reply,/إجمالي رسوم التأشيرات: 640/);
 assert.doesNotMatch((await e.handle('price7','وين مكتبكم وكم يوم؟')).reply,/إجمالي رسوم/);
});

test('Package 7 children dialect keeps pricing in review and summary cannot invent an adult total',async()=>{
 const e=make();await e.handle('children7','نحنا 3 انا وعيالي كلنا سوريين جواز عادي');assert.equal(e.getCase('children7').hasMinors,true);assert.equal(e.getCase('children7').quote.requiresReview,true);const r=await e.handle('children7','لخصلي طلبي');assert.match(r.reply,/مراجعة تسعير الأطفال/);assert.doesNotMatch(r.reply,/إجمالي الرسوم المعتمدة|1920/);
});

async function family11(id='family11'){
 const e=make();await e.handle(id,'نحنا شخصين انا سوري جواز عادي');await e.handle(id,'لبنانية');await e.handle(id,'وثيقة سفر من لبنان');assert.equal(e.getCase(id).quote.total,1490);return e;
}
test('Package 11 named applicant correction changes only the second person, clears issuer and reprices immediately',async()=>{
 const e=await family11(),first=structuredClone(e.getCase('family11').applicants[0]);let calls=0;e.understand=async()=>{calls++;return{target:'group',correction:true,fields:{applicantCount:1,nationality:'مصر'}};};
 const r=await e.handle('family11','عفواً المتقدم الثاني معه جواز عادي'),c=e.getCase('family11');
 assert.deepEqual(c.applicants[0],first);assert.deepEqual(c.applicants[1],{nationality:'لبنان',documentType:'passport'});assert.equal(c.applicantCount,2);assert.equal(c.quote.total,1280);assert.match(r.reply,/1,280/);assert.equal(c.paymentStatus,'unverified');assert.equal(c.submissionStatus,'not_submitted');
 await e.handle('family11','الشخص الثاني جنسيته مصري وجواز عادي');assert.deepEqual(e.getCase('family11').applicants[0],first);assert.deepEqual(e.getCase('family11').applicants[1],{nationality:'مصر',documentType:'passport'});assert.equal(e.getCase('family11').quote.rows[1].product,'tourist_single');assert.equal(calls,0);
});
test('Package 11 explicit person overrides a different pending field, including issuer questions',async()=>{
 for(const awaiting of ['nationality_0','documentType_0','issuer_0','applicantCount']){
  const e=await family11(awaiting),c=e.getCase(awaiting),first=structuredClone(c.applicants[0]);c.lastQuestion=awaiting;e.save(awaiting,c);
  await e.handle(awaiting,'المسافر رقم ٢ معه جواز عادي');assert.deepEqual(e.getCase(awaiting).applicants[0],first);assert.equal(e.getCase(awaiting).applicants[1].documentType,'passport');assert.equal(e.getCase(awaiting).applicants[1].documentIssuer,undefined);assert.equal(e.getCase(awaiting).applicantCount,2);
 }
});
test('Package 11 invalid, unknown and ambiguous applicant references never fall back to the first person',async()=>{
 const e=await family11('invalid11'),before=structuredClone(e.getCase('invalid11'));let calls=0;e.understand=async()=>{calls++;return{fields:{nationality:'مصر'}};};
 for(const text of ['المتقدم 0 جواز عادي','المتقدم ٣ جواز عادي','المتقدم 31 جواز عادي','المتقدم 100 جواز عادي','المتقدم السادس جواز عادي','المتقدم الثلاثين جواز عادي','المتقدم الأول والمتقدم الثاني جواز عادي']){
  const r=await e.handle('invalid11',text);assert.match(r.reply,/حدد رقم متقدم واحد/);assert.deepEqual(e.getCase('invalid11').applicants,before.applicants);assert.deepEqual(e.getCase('invalid11').quote,before.quote);assert.equal(e.getCase('invalid11').applicantCount,2);
 }assert.equal(calls,0);
});
test('Package 11 paid family corrections remain pending review and preserve the approved amount and evidence',async()=>{
 const e=await family11('paid11'),c=e.getCase('paid11');c.paymentStatus='verified';c.staffVerification={payment:{amount:1490,caseSignature:visaCaseSignature(c),reference:'synthetic-payment'}};e.save('paid11',c);const before=structuredClone(c);
 await e.handle('paid11','الفرد الثاني معه جواز عادي');const after=e.getCase('paid11');assert.deepEqual(after.applicants,before.applicants);assert.equal(after.quote.total,1490);assert.deepEqual(after.staffVerification,before.staffVerification);assert.equal(after.stage,'amendment_review');assert.equal(after.pendingAmendment.facts.applicants[1].documentType,'passport');assert.equal(after.pendingAmendment.facts.applicants[1].documentIssuer,undefined);
});
test('Package 11 possessive document wording binds issuing country only to the named traveller',async()=>{
 const e=await family11('document11'),first=structuredClone(e.getCase('document11').applicants[0]);
 for(const word of ['وثيقته','وثيقتها']){await e.handle('document11','الشخص الثاني '+word+' من مصر');assert.deepEqual(e.getCase('document11').applicants[0],first);assert.equal(e.getCase('document11').applicants[1].nationality,'لبنان');assert.equal(e.getCase('document11').applicants[1].documentType,'travel_document');assert.equal(e.getCase('document11').applicants[1].documentIssuer,'مصر');}
});
