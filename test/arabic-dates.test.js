'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {naturalDate}=require('../src/arabic-dates');
const {handleMessage,resetSessions}=require('../src/conversation');
const now=Date.parse('2026-10-22T21:30:00Z'); // Dubai: Friday 23 October.
test('relative dates use Dubai midnight, next weekdays and valid month/week boundaries',()=>{
 assert.deepEqual(naturalDate('بدي بكرا',now).dates,['2026-10-24']);
 assert.deepEqual(naturalDate('بعد بكرى',now).dates,['2026-10-25']);
 assert.deepEqual(naturalDate('الاثنين القادم',now).dates,['2026-10-26']);
 assert.deepEqual(naturalDate('الجمعة القادم',now).dates,['2026-10-30']);
 assert.deepEqual(naturalDate('أرخص سعر بهل شهر',now).range,{start:'2026-10-23',end:'2026-10-31',kind:'this_month'});
 assert.deepEqual(naturalDate('هالاسبوع',now).range,{start:'2026-10-23',end:'2026-10-25',kind:'this_week'});
 assert.equal(naturalDate('الشهر الجاي',now).range.start,'2026-11-01');
});
test('conversational slots retain route and ask only for missing trip type and passengers',()=>{
 resetSessions();const h=t=>handleMessage('natural-user',t,{now});
 assert.match(h('شوفي طيران على سوريا').reply,/من أي/);
 assert.match(h('من الشارقة').reply,/مدينة بسوريا/);
 assert.match(h('دمشق').reply,/تاريخ/);
 assert.match(h('بكرا').reply,/2026-10-24/);
 assert.match(h('روحة ورجعة').reply,/تاريخ العودة/);
 assert.match(h('بعد أسبوع').reply,/عدد المسافرين|كم عدد/);
 const r=h('لحالي');assert.equal(r.complete,true);assert.equal(r.request.departureDate,'2026-10-24');assert.equal(r.request.returnDate,'2026-10-31');
 assert.equal(h('شكرا').complete,false);
});
test('a return-date reply never overwrites the departure date',()=>{
 resetSessions();const h=t=>handleMessage('return-user',t,{now});
 h('من الشارقة إلى دمشق، 25-10-2026، ذهاب وعودة، 1 بالغ');
 const r=h('30-10-2026');assert.equal(r.request.departureDate,'2026-10-25');assert.equal(r.request.returnDate,'2026-10-30');
});
test('cheapest month intent stays a range and asks stay length instead of inventing dates or passenger count',()=>{
 resetSessions();const h=t=>handleMessage('range-user',t,{now});
 h('من الشارقة إلى دمشق، أرخص سعر بهل شهر');h('ذهاب وعودة');h('لمدة 7 أيام');
 const r=h('1');assert.equal(r.complete,true);assert.equal(r.request.departureDate,null);assert.equal(r.request.departureRange.start,'2026-10-23');assert.equal(r.request.stayNights,7);
});
