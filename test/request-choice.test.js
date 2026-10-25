'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {shouldOfferRequestChoice,createRequestChoice,readRequestChoice,CHOICE_TTL_MS,CHOICES}=require('../src/request-choice');
const NOW=Date.parse('2026-10-25T00:00:00Z');
function state(extra={}){return {tripId:'saved-trip',status:'done',history:[{role:'assistant',text:'عرض محفوظ'}],offers:[{reference:1}],selected:null,pendingRequests:[],base:{request:{origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-11',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30}},submitted:true,awaiting:null},...extra};}
const gate=(text,extra={})=>shouldOfferRequestChoice({state:state(),text,decision:{intent:'request'},now:NOW,...extra});

for(const text of ['بدي تذكرة من دبي للشام الأسبوع القادم','بدي حجز من دمشق إلى الشارقة','عندي طلب سفر','عندي طلب','شو عندكن رحلات على سوريا','ممكن تشوفلي تذكرة لمرتي','بدي تيكت على سوريا'])test('an ambiguous requested journey offers current/new choices: '+text,()=>{
 assert.equal(gate(text),true);
});
for(const text of ['بدي 30 كيلو','بدي عشرين كيلو','شخص واحد','بكرا','بدي ارخص سعر الشهر القادم','من دبي','من الشام للشارقة','بدي حجز نفس الرحلة','عدل الحجز من دبي','قصدي من دبي','عندي طلب جديد','بدي رحلة تانية','وكمان بدي رحلة من دبي','بدي ثبت','احجزلي هالخيار','عندي حجز وبدي أعدله','المزيد','باقي الخيارات','الخيار 2','شو صار','مرحبا','احذف بياناتي','وقف البحث'])test('clear operations and scoped follow-ups never open this menu: '+text,()=>{
 assert.equal(gate(text),false);
});
test('no current trip, staff ownership, active clarification or quoted offers cannot open a menu',()=>{
 const text='بدي تذكرة من دبي للشام';
 for(const s of [state({base:null}),state({base:{request:{tripType:'one_way'}}}),state({humanOwned:true}),state({status:'cancelled'}),state({status:'handoff_pending'}),state({pendingQuotedOffer:{references:[1,2]}})])assert.equal(gate(text,{state:s}),false);
 const collecting=state();collecting.base.awaiting='departureDate';assert.equal(gate(text,{state:collecting}),false);
 assert.equal(gate(text,{quotedOfferReferences:[1]}),false);
 assert.equal(gate(text,{followup:{fields:{origin:'دبي'},sameDates:true}}),false);
 for(const intent of ['booking','select','status','thanks','greeting','goodbye','cancel','explain','compare','negotiate','knowledge'])assert.equal(gate(text,{decision:{intent}}),false,intent);
});
test('a model-proposed additional request still needs customer scope when their words are ambiguous',()=>{
 assert.equal(gate('بدي تذكرة على سوريا',{decision:{intent:'additional_request'}}),true);
 assert.equal(gate('بدي طلب تاني على سوريا',{decision:{intent:'additional_request'}}),false);
});
test('creation only adds a bounded durable pending choice and keeps all current work untouched',()=>{
 const s=state({status:'searching'}),before=structuredClone(s),p=createRequestChoice(s,'بدي تذكرة من دبي للشام',{now:NOW});
 assert.match(p.id,/^[a-f0-9-]{36}$/);assert.equal(p.expiresAt,NOW+CHOICE_TTL_MS);assert.equal(p.text,'بدي تذكرة من دبي للشام');assert.equal(p.tripId,'saved-trip');assert.equal(s.requestChoice.id,p.id);
 assert.deepEqual(p.choices,CHOICES);assert.ok(p.reply.length<1024);assert.match(p.reply,/1️⃣/);assert.match(p.reply,/2️⃣/);
 delete s.requestChoice;assert.deepEqual(s,before);
});
test('an unexpired existing choice is reused without a new nonce or losing the original proposed request',()=>{
 const s=state(),first=createRequestChoice(s,'بدي تذكرة على سوريا',{now:NOW}),before=structuredClone(s);
 const next=createRequestChoice(s,'بدي تذكرة جديدة بتاريخ تاني',{now:NOW+1000});assert.equal(next.id,first.id);assert.equal(next.text,first.text);assert.deepEqual(s,before);
 assert.equal(gate('بدي تذكرة',{state:s}),false);
});
test('payload and pending text are bounded and no stored request is echoed by the menu',()=>{
 const s=state(),p=createRequestChoice(s,'x'.repeat(5000)+'\u0000',{now:NOW});assert.equal(p.text.length,3000);assert.doesNotMatch(p.reply,/xxxx/);assert.ok(!p.text.includes('\u0000'));
 for(const bad of [null,{},state({base:null}),state({humanOwned:true})])assert.throws(()=>createRequestChoice(bad,'بدي تذكرة',{now:NOW}),/INVALID_STATE/);
 assert.throws(()=>createRequestChoice(state(),'   ',{now:NOW}),/INVALID_TEXT/);
});
for(const [text,action]of [['1','continue'],['١','continue'],['۱','continue'],['الأول','continue'],['الأولى','continue'],['متابعة طلبي الحالي','continue'],['تابع طلبي الحالي','continue'],['نكمل على طلبي الحالي','continue'],['نفس الطلب','continue'],['بدي أتابع طلبي الحالي','continue'],['بدي تابع بطلبي الحالي','continue'],['2','new'],['٢','new'],['۲','new'],['الثاني','new'],['التاني','new'],['طلب جديد مختلف','new'],['طلب جديد','new'],['بدي ابدا طلب جديد','new'],['رحلة جديدة','new'],['بدي طلب جديد','new'],['ابدأ من جديد','new'],['بدي ابدا من جديد','new']])test('pending numbered and semantic reply resolves deterministically: '+text,()=>{
 const s=state();createRequestChoice(s,'بدي تذكرة',{now:NOW});const before=structuredClone(s),r=readRequestChoice(s,text,{now:NOW+1000});assert.equal(r.action,action);assert.equal(r.pending.text,'بدي تذكرة');assert.deepEqual(s,before);
});
test('numbers have no request-scope meaning when no choice is pending',()=>{
 for(const text of ['1','2','١','٢','الأول','الثاني','الخيار 2'])assert.deepEqual(readRequestChoice(state(),text,{now:NOW}),{action:'none'});
});
test('signed interactive replies require the current nonce, allowed action and trip identity',()=>{
 const s=state(),p=createRequestChoice(s,'بدي تذكرة',{now:NOW});
 assert.equal(readRequestChoice(s,'untrusted title',{now:NOW,buttonChoice:{id:p.id,action:'continue'}}).action,'continue');
 assert.equal(readRequestChoice(s,'untrusted title',{now:NOW,buttonChoice:{id:p.id,action:'new'}}).action,'new');
 for(const buttonChoice of [{id:'other',action:'new'},{id:p.id,action:'delete'},{}])assert.equal(readRequestChoice(s,'2',{now:NOW,buttonChoice}).action,'stale');
 assert.equal(readRequestChoice(state(),'2',{now:NOW,buttonChoice:{id:p.id,action:'new'}}).action,'stale');
 s.tripId='changed-trip';assert.equal(readRequestChoice(s,'2',{now:NOW,buttonChoice:{id:p.id,action:'new'}}).action,'stale');
});
test('expired or future pending choices cannot change the active request',()=>{
 const s=state(),p=createRequestChoice(s,'بدي تذكرة',{now:NOW});
 assert.equal(readRequestChoice(s,'2',{now:NOW+CHOICE_TTL_MS-1}).action,'new');
 for(const now of [NOW-1,NOW+CHOICE_TTL_MS,NOW+CHOICE_TTL_MS+1])assert.equal(readRequestChoice(s,'2',{now}).action,'stale');
 const fresh=createRequestChoice(s,'بدي تذكرة تانية',{now:NOW+CHOICE_TTL_MS+1});assert.notEqual(fresh.id,p.id);
});
test('a pending menu does not intercept a clear current-trip operation or an actual offer reference',()=>{
 const s=state();createRequestChoice(s,'بدي تذكرة',{now:NOW});
 for(const text of ['بدي 30 كيلو','30 كيلو','بدنا عشرين كيلو','وزن 40 كغ','الخيار 2','العرض 1','شو صار','شكرا','شكرا ناطرك','بانتظار الأسعار','المزيد','وقف البحث','احذف بياناتي','قصدي من دبي','بدي الثلاثاء','بكرا','11-11-2026','2026-11-11','اول اسبوع من الشهر الجاي'])assert.equal(readRequestChoice(s,text,{now:NOW}).action,'none',text);
 for(const text of ['بدي 30 كيلو','قصدي من دبي','11-11-2026','الخيار 2'])assert.equal(readRequestChoice(s,text,{now:NOW}).resolvedCurrent,true,text);
 for(const text of ['شو صار','شكرا','المزيد','احذف بياناتي'])assert.equal(readRequestChoice(s,text,{now:NOW}).resolvedCurrent,undefined,text);
});
test('unclear replies receive a narrow reminder retaining the existing nonce and request facts',()=>{
 const s=state(),p=createRequestChoice(s,'بدي تذكرة من دبي',{now:NOW}),before=structuredClone(s);
 const r=readRequestChoice(s,'شو قصدك بالفرق',{now:NOW+1000});assert.equal(r.action,'repeat');assert.equal(r.pending.id,p.id);assert.match(r.reply,/اختار 1 أو 2/);assert.deepEqual(s,before);
 for(const text of ['نعم','اي','تمام','اوكي','حاضر','yes']){const answer=readRequestChoice(s,text,{now:NOW+1000});assert.equal(answer.action,'repeat',text);assert.equal(answer.pending.id,p.id);assert.deepEqual(s,before);}
});
test('staff-owned conversations do not resolve a pending menu or interrupt the employee',()=>{
 const s=state();const p=createRequestChoice(s,'بدي تذكرة',{now:NOW});s.humanOwned=true;const before=structuredClone(s);
 assert.deepEqual(readRequestChoice(s,'2',{now:NOW,buttonChoice:{id:p.id,action:'new'}}),{action:'none'});assert.deepEqual(s,before);
});
