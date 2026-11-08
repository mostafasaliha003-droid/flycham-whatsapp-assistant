'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extractApplicantAgeUpdates:extract,parseCompletedAge}=require('../src/visa-applicant-age');
const one=age=>[{applicantIndex:0,age}];

test('explicit completed ages preserve 52 53 and 54 across Arabic dialect and digit sets',()=>{
 for(const [text,age]of [['عمري 52',52],['عمري ٥٣ سنة',53],['عمري ۵۴ سنة',54],['عمري اتنين وخمسين',52],['عمري تلاتة وخمسين سنة',53],['عمري ثلاثة وخمسون عاما',53],['عمري اربعة و خمسين',54],['سني اربع وخمسين',54],['أنا 54 سنة',54]])assert.deepEqual(extract(text).updates,one(age),text);
});

test('an attached Arabic conjunction preserves explicit age assertions and existing uncertainty guards',()=>{
 for(const text of ['سوري جواز عادي لحالي وعمري 52 سنة','سوري جواز عادي وعمري اتنين وخمسين','وسني ٥٢'])assert.deepEqual(extract(text).updates,one(52),text);
 assert.deepEqual(extract('المتقدم الثاني وعمره 54 سنة',{applicantCount:2}).updates,[{applicantIndex:1,age:54}]);
 for(const text of ['لو كنت سوري وعمري 52 سنة كم السعر؟','سوري جواز عادي وعمري 52 سنة؟','سوري وعمري مش 52'])assert.deepEqual(extract(text,{awaiting:'age_0',applicantCount:1}).updates,[],text);
});

test('English and French explicit ages require age context rather than an arbitrary quantity',()=>{
 for(const text of ['I am 54','I’m 54 years old','My age is 54','J’ai 54 ans','Mon âge est 54'])assert.deepEqual(extract(text).updates,one(54),text);
 for(const text of ['J’ai 54 euros','I am 54 days late','Age 54 AED','السعر 54 درهم','سفري بعد 54 يوم','صلاحية الجواز 54 شهر','passport expires in 54 days','my passport age 54','جوازي عمره 54 سنة','بدي عمرة 54','فيزا عمرة 54'])assert.deepEqual(extract(text,{applicantCount:1}).updates,[],text);
});

test('standalone values only answer the exact age slot and never another intake field',()=>{
 for(const text of ['54','٥٤','۵۴','اربعة وخمسين','54 ans'])assert.deepEqual(extract(text,{awaiting:'age_1',applicantCount:2}).updates,[{applicantIndex:1,age:54}],text);
 for(const awaiting of [null,'nationality','applicantCount','age_30','age_-1'])assert.deepEqual(extract('54',{awaiting,applicantCount:2}).updates,[],String(awaiting));
 assert.deepEqual(extract('54',{awaiting:'age_2',applicantCount:2}).updates,[]);
 assert.deepEqual(extract('54',{awaiting:'age',applicantCount:1}).updates,one(54));
});

test('explicit ordinal applicant ages remain bound and ordered without guessing relatives',()=>{
 for(const text of ['المتقدم الأول عمره 52 والثاني عمره 54','عمر المتقدم الأول 52 والثاني 54','اعمار المتقدمين الأول 52 والثاني 54','Applicant 2 age 54, applicant 1 age 52','Le deuxième demandeur age 54, le premier demandeur age 52'])assert.deepEqual(extract(text,{applicantCount:2}).updates,[{applicantIndex:0,age:52},{applicantIndex:1,age:54}],text);
 assert.deepEqual(extract('الأول 52 والثاني 54').updates,[]);
 assert.deepEqual(extract('الثاني 54',{awaiting:'age_0',applicantCount:2}).updates,[{applicantIndex:1,age:54}]);
 assert.deepEqual(extract('زوجتي عمرها 54',{applicantCount:2}),{updates:[],needsClarification:true});
 assert.deepEqual(extract('My wife age 54',{applicantCount:2}),{updates:[],needsClarification:true});
 assert.deepEqual(extract('المتقدم الثالث عمره 54',{applicantCount:2}),{updates:[],needsClarification:true});
});

test('questions hypotheses and negations never overwrite an age while clear corrections retain latest value',()=>{
 for(const text of ['هل عمري 54؟','عمري 54؟','لو عمري 54 كم السعر؟','إذا عمره 54 شو الرسوم؟','عمري مش 54','أنا مو 54 سنة','If I am 54 what is the fee?','Si j’ai 54 ans quel est le prix ?','I am not 54'])assert.deepEqual(extract(text,{awaiting:'age_0',applicantCount:1}).updates,[],text);
 assert.deepEqual(extract('عمري 53، قصدي 54').updates,one(54));
 assert.deepEqual(extract('عمري 53، لا 54').updates,one(54));
 assert.deepEqual(extract('عمري 53 لا 54').updates,one(54));
 assert.deepEqual(extract('I am 53. Actually 54').updates,one(54));
 assert.deepEqual(extract('عمري 54، كم السعر؟').updates,one(54));
 assert.deepEqual(extract('عمري 54 سنة لو سمحت كم السعر؟').updates,one(54));
});

test('bounded integers reject estimates ranges decimals dates and implausible ages without mutating context',()=>{
 for(const text of ['-1','120','999','53.5','53/54','حوالي 54','54 أو 55','2026-11-08'])assert.equal(parseCompletedAge(text),null,text);
 for(const text of ['عمري 53.5','عمري 53,5','عمري ٥٣٫٥','عمري 54 أو 55','عمري 53 ونص','عمري 53 ولا 54','عمري 120','عمري 999'])assert.deepEqual(extract(text,{applicantCount:1}).updates,[],text);
 for(const [text,age]of [['صفر',0],['عشره',10],['اثنا عشر',12],['تسعة وخمسين',59],['مية وتسعة عشر',119]])assert.equal(parseCompletedAge(text),age,text);
 const context={awaiting:'age_1',applicantCount:2},before=structuredClone(context);extract('54',context);assert.deepEqual(context,before);
 assert.deepEqual(extract('عمري 53 '+'.'.repeat(4000)+' قصدي 54'),{updates:[],needsClarification:true});
});
