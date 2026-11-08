'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {visaCaseSignature,currentVisaEvidence}=require('../src/visa-case-signature');
const P=require('../src/saudi-visa-policy');

const make=()=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:{VISA_TOURIST_AGE_PRICING:'on'},privateConfig:{banks:[]}});
const tourist={nationality:'سوريا',documentType:'passport'};
const bankDetails=/IBAN|AE\d{2}|رقم الحساب|حسابات شركتنا|التفاصيل البنكية/;
function legacyPaid(e,id,{age}={}){
 const c=e.newCase();
 Object.assign(c,{greeted:true,stage:'payment_verified',applicantCount:1,applicants:[{...tourist,...(age===undefined?{}:{age})}],paymentMethod:'bank',paymentStatus:'verified'});
 c.quote=P.calculateQuote(c,{feesEnabled:true,agePricing:false});
 const signature=visaCaseSignature(c);
 c.staffVerification={payment:{amount:c.quote.total,reference:'LEGACY-PAID',caseSignature:signature},documentsReviewed:true,documentsSignature:signature};
 e.save(id,c);return structuredClone(c);
}

test('explicit tourist ages 52 and 54 reach the correct complete quote in the first conversation turn',async()=>{
 for(const [nationality,product]of [['سوري','tourist_multi'],['مصري','tourist_single']])for(const [age,total,insurance]of [[52,640,0],[54,830,190]]){
  const e=make(),id='direct-'+nationality+'-'+age;
  const r=await e.handle(id,`${nationality} جواز عادي لحالي وعمري ${age} سنة`),c=e.getCase(id);
  assert.equal(c.applicantCount,1);assert.equal(c.applicants[0].age,age);
  assert.equal(c.quote.rows[0].product,product);assert.equal(c.quote.total,total);assert.equal(c.quote.insuranceSubtotal,insurance);
  assert.equal(c.quote.requiresReview,undefined);assert.equal(c.paymentStatus,'unverified');
  assert.match(r.reply,new RegExp(String(total)));assert.doesNotMatch(r.reply,/كم عمر|سعر الأطفال|أعمار المتقدمين/);
  if(insurance)assert.match(r.reply,/640.*190.*830/s);
 }
});

test('an unknown tourist age prevents a total and accepts a numeric answer only for the pending age question',async()=>{
 const e=make(),first=await e.handle('unknown','سوري جواز عادي لحالي');
 assert.equal(e.getCase('unknown').quote.total,undefined);assert.equal(e.getCase('unknown').lastQuestion,'age_0');
 assert.match(first.reply,/كم عمر/);assert.doesNotMatch(first.reply,/\*المجموع:|إجمالي رسوم التأشيرات:/);
 await e.handle('unknown','٥٤');const c=e.getCase('unknown');
 assert.equal(c.applicantCount,1);assert.equal(c.applicants[0].age,54);assert.equal(c.quote.total,830);assert.equal(c.lastQuestion,null);
 await e.handle('unbound','54');assert.equal(e.getCase('unbound').applicants[0]?.age,undefined);assert.equal(e.getCase('unbound').applicantCount,null);
});

test('numeric age answers remain bound to each applicant instead of replacing the first age or group count',async()=>{
 const e=make();await e.handle('group','نحنا 2 كلنا سوريين جواز عادي');
 assert.equal(e.getCase('group').lastQuestion,'age_0');
 await e.handle('group','52');assert.equal(e.getCase('group').lastQuestion,'age_1');assert.equal(e.getCase('group').quote.total,undefined);
 await e.handle('group','54');const c=e.getCase('group');
 assert.equal(c.applicantCount,2);assert.deepEqual(c.applicants.map(p=>p.age),[52,54]);assert.equal(c.quote.total,1470);
});

test('exactly 53 requires insurance review without an invented total or child-pricing explanation',async()=>{
 const e=make(),r=await e.handle('boundary','سوري جواز عادي لحالي عمري 53 سنة'),c=e.getCase('boundary');
 assert.equal(c.applicants[0].age,53);assert.equal(c.quote.requiresReview,true);assert.equal(c.quote.reason,'tourist_age_53_review');
 assert.equal(c.quote.total,undefined);assert.equal(c.quote.subtotal,undefined);assert.equal(c.quote.rows,undefined);
 assert.equal(c.stage,'pricing_review');assert.equal(c.paymentStatus,'unverified');
 assert.match(r.reply,/53/);assert.match(r.reply,/تأمين|التأمين/);assert.match(r.reply,/مراجع|بنراجع/);
 assert.doesNotMatch(r.reply,/سعر الأطفال|كم عمر|\*المجموع:|إجمالي رسوم التأشيرات:/);
});

test('the refund follow-up from the screenshot answers directly without repeating the quote',async()=>{
 for(const age of [undefined,52,53,54]){
  const e=make(),id='refund-'+age;await e.handle(id,'سوري جواز عادي لحالي'+(age===undefined?'':` عمري ${age} سنة`));
  const before=structuredClone(e.getCase(id)),r=await e.handle(id,'إذا ترفضت بترجع الرسوم'),after=e.getCase(id);
  assert.match(r.reply,/نعم/);assert.match(r.reply,/رسوم التأشيرة مستردة بالكامل/);assert.match(r.reply,/الرفض الرسمي/);
  assert.doesNotMatch(r.reply,/640|830|190|إجمالي|المجموع|عرض تأشيرات|كم عمر|صور المستندات/);
  assert.deepEqual(after.applicants,before.applicants);assert.deepEqual(after.quote,before.quote);assert.equal(after.paymentStatus,'unverified');
  if(age===54)assert.match(r.reply,/استرداد مبلغ التأمين.*منفصل/);
 }
});

test('unfinished age and insurance pricing holds bank details and link coordination before payment',async()=>{
 for(const age of [undefined,53,54])for(const request of ['ابعتلي حسابكم البنكي','أرسل رابط دفع']){
  const e=make(),id='hold-'+age+request;await e.handle(id,'سوري جواز عادي لحالي'+(age===undefined?'':` عمري ${age} سنة`));
  const r=await e.handle(id,request),c=e.getCase(id);
  assert.doesNotMatch(r.reply,bankDetails);assert.doesNotMatch(r.reply,/رح ننسّق لك رابط|بعد التحويل ابعت/);
  assert.equal(c.paymentStatus,'unverified');assert.notEqual(c.operatorIntervention?.reason,'payment_link');
  if(age===undefined)assert.match(r.reply,/كم عمر/);
  else assert.match(r.reply,/قبل الدفع|قبل تأكيد المجموع والدفع/);
 }
 const e=make();await e.handle('ready','سوري جواز عادي لحالي عمري 52 سنة');
 assert.match((await e.handle('ready','ابعتلي حسابكم البنكي')).reply,bankDetails);
 const link=await e.handle('ready','أرسل رابط دفع');assert.equal(e.getCase('ready').operatorIntervention.reason,'payment_link');
 assert.match(link.reply,/رح ننسّق لك رابط الدفع/);assert.equal(e.getCase('ready').paymentStatus,'unverified');
});

test('legacy paid cases retain their exact signed quote through ordinary inquiries after the age rollout',async()=>{
 for(const age of [undefined,52,53,54]){
  const e=make(),id='legacy-'+age,before=legacyPaid(e,id,{age}),signature=visaCaseSignature(before);
  for(const text of ['كم السعر؟','إذا ترفضت بترجع الرسوم','ملخص طلبي','أرسل رابط دفع']){
   await e.handle(id,text);const c=e.getCase(id);
   assert.equal(visaCaseSignature(c),signature,text+' age='+age);assert.deepEqual(c.quote,before.quote);assert.deepEqual(c.applicants,before.applicants);
   assert.deepEqual(c.staffVerification,before.staffVerification);assert.equal(c.paymentMethod,'bank');assert.equal(currentVisaEvidence(c).payment,true);
   assert.equal(currentVisaEvidence(c).documents,true);assert.equal(c.pendingAmendment,undefined);
  }
 }
});

test('a later age correction on a paid case becomes an amendment without invalidating its financial evidence',async()=>{
 const e=make(),before=legacyPaid(e,'paid-age',{age:52}),signature=visaCaseSignature(before);
 const r=await e.handle('paid-age','عمري 54 سنة'),c=e.getCase('paid-age');
 assert.equal(c.stage,'amendment_review');assert.equal(c.pendingAmendment.facts.applicants[0].age,54);
 assert.deepEqual(c.applicants,before.applicants);assert.deepEqual(c.quote,before.quote);assert.deepEqual(c.staffVerification,before.staffVerification);
 assert.equal(visaCaseSignature(c),signature);assert.equal(currentVisaEvidence(c).payment,true);assert.equal(currentVisaEvidence(c).documents,true);
 assert.match(r.reply,/التعديل|تعديل/);assert.doesNotMatch(r.reply,/830|190|حول|حوّل/);
});
