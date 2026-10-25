'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolveMonthScope}=require('../src/month-scope');
const legacy=require('../src/conversation');
const {knownTripFollowup}=require('../src/travel-followups');
const NOW=Date.parse('2026-10-24T23:00:00Z');
const complete=()=>({origin:'دبي',destination:'دمشق',departureDate:null,departureRange:null,returnDate:null,tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30,source:'default30',requestedByCustomer:false}});
function seed(id,extra={}){legacy.importSession(id,{request:{...complete(),...extra},submitted:false,awaiting:null,at:NOW});}
test('vague next month asks for a bounded part even if a model supplies full-month dates',()=>{
 seed('vague');const r=legacy.handleMessage('vague','بدي ارخص سعر الشهر القادم',{now:NOW,patch:{rangeStart:'2026-11-01',rangeEnd:'2026-11-30'}});
 assert.equal(r.complete,false);assert.equal(r.clarification,'month_scope');assert.match(r.reply,/بأي جزء/);assert.match(r.reply,/2026-11-22 إلى 2026-11-30/);const s=legacy.exportSession('vague');assert.equal(s.awaiting,'monthScope');assert.deepEqual(s.monthScope,{year:2026,month:11});assert.equal(s.request.departureRange,null);assert.equal(s.submitted,false);
});
for(const [text,start,end]of [['أول أسبوع من الشهر القادم','2026-11-01','2026-11-07'],['ثاني اسبوع من الشهر القادم','2026-11-08','2026-11-14'],['الاسبوع الثالث بالشهر الجاي','2026-11-15','2026-11-21'],['رابع اسبوع بالشهر القادم','2026-11-22','2026-11-30'],['نص الشهر الجاي','2026-11-11','2026-11-20'],['بداية الشهر القادم','2026-11-01','2026-11-07'],['آخر الشهر الجاي','2026-11-22','2026-11-30']])test('explicit part is resolved inside the intended month: '+text,()=>{
 const r=resolveMonthScope(text,{now:NOW});assert.equal(r.kind,'chosen');assert.equal(r.range.start,start);assert.equal(r.range.end,end);
 seed(text);const result=legacy.handleMessage(text,text,{now:NOW,patch:{rangeStart:'2026-10-26',rangeEnd:'2026-11-01'}});assert.equal(result.complete,true);assert.equal(result.request.departureRange.start,start);assert.equal(result.request.departureRange.end,end);assert.equal(result.request.origin,'دبي');assert.equal(result.request.passengers.adults,1);assert.equal(result.request.baggageRequest.checkedWeightKg,30);
});
test('short answer resolves the saved month without reasking or losing the trip',()=>{
 seed('short');legacy.handleMessage('short','بدي بالشهر القادم',{now:NOW});const r=legacy.handleMessage('short','الثاني',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.departureRange.start,'2026-11-08');assert.equal(r.request.departureRange.end,'2026-11-14');assert.equal(legacy.exportSession('short').monthScope,undefined);assert.equal(r.request.origin,'دبي');assert.equal(r.request.tripType,'one_way');
});
test('explicit whole-month consent searches the whole month and does not ask again after another supplied fact',()=>{
 seed('whole',{passengers:null});let r=legacy.handleMessage('whole','الشهر القادم كامل',{now:NOW});assert.equal(r.complete,false);assert.match(r.reply,/عدد المسافرين/);assert.equal(legacy.exportSession('whole').request.departureRange.start,'2026-11-01');r=legacy.handleMessage('whole','شخص واحد',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.departureRange.end,'2026-11-30');assert.doesNotMatch(r.reply,/بأي جزء/);
});
test('explicit date ranges bypass month clarification',()=>{
 seed('dates');const r=legacy.handleMessage('dates','بدي الشهر القادم',{now:NOW,patch:{}});assert.equal(r.complete,false);const chosen=legacy.handleMessage('dates','من 10-11-2026 إلى 15-11-2026',{now:NOW,patch:{rangeStart:'2026-11-10',rangeEnd:'2026-11-15',tripType:'one_way'}});assert.equal(chosen.complete,true);assert.equal(chosen.request.departureRange.start,'2026-11-10');assert.equal(chosen.request.departureRange.end,'2026-11-15');assert.equal(legacy.exportSession('dates').monthScope,undefined);
});
test('a missing passenger answer preserves a selected month part instead of reopening the month question',()=>{
 seed('party',{passengers:null});legacy.handleMessage('party','الشهر القادم',{now:NOW});const selected=legacy.handleMessage('party','آخره',{now:NOW});assert.equal(selected.complete,false);assert.match(selected.reply,/عدد المسافرين/);const r=legacy.handleMessage('party','شخص بالغ واحد',{now:NOW});assert.equal(r.complete,true);assert.equal(r.request.departureRange.start,'2026-11-22');assert.equal(r.request.departureRange.end,'2026-11-30');
});
test('current month choices omit past days and never turn a passed week into a search',()=>{
 const ask=resolveMonthScope('بدي ارخص سعر هالشهر',{now:NOW});assert.equal(ask.kind,'ask');assert.match(ask.question,/2026-10-25/);assert.doesNotMatch(ask.question,/2026-10-01/);const r=resolveMonthScope('اول اسبوع',{now:NOW,pending:ask.pending});assert.equal(r.kind,'ask');assert.match(r.question,/تواريخ مضت/);
});
test('month/year rollover and final days remain included',()=>{
 const r=resolveMonthScope('آخر الشهر القادم',{now:Date.parse('2026-12-30T23:00:00Z')});assert.equal(r.range.start,'2027-01-22');assert.equal(r.range.end,'2027-01-31');
});
test('the known trip fastpath resolves a pending short month choice into the same bounded dates',()=>{
 const r=knownTripFollowup('الأسبوع الثالث',complete(),NOW,{monthScope:{year:2026,month:11}});assert.deepEqual(r.fields,{rangeStart:'2026-11-15',rangeEnd:'2026-11-21',departureDate:null});assert.equal(r.monthScope,true);
});
test('exact relative days override an abandoned monthly discussion',()=>{
 const r=resolveMonthScope('لا الشهر الجاي ما بدي، بدي بعد بكرا',{now:NOW,pending:{year:2026,month:11}});assert.equal(r.kind,'bypass');
});
test('negated month and month-part references are not selected',()=>{
 const current=resolveMonthScope('مو الشهر الجاي، هالشهر',{now:NOW});assert.equal(current.kind,'ask');assert.equal(current.pending.month,10);
 const last=resolveMonthScope('مو أوله، آخره',{now:NOW,pending:{year:2026,month:11}});assert.equal(last.kind,'chosen');assert.equal(last.range.start,'2026-11-22');
});
test('an invented past model range cannot defeat the saved customer month choice',()=>{
 seed('model-past');legacy.handleMessage('model-past','الشهر القادم',{now:NOW});const r=legacy.handleMessage('model-past','الثاني',{now:NOW,patch:{rangeStart:'2000-01-01',rangeEnd:'2000-01-07'}});assert.equal(r.complete,true);assert.equal(r.request.departureRange.start,'2026-11-08');assert.equal(r.request.departureRange.end,'2026-11-14');
});
