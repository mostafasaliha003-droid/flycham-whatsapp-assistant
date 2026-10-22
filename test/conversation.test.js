'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage, resetSessions, parseDate, parsePassengerCount } = require('../src/conversation');

function futureDate(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

test('validates calendar dates and parses passenger counts', () => {
  assert.equal(parseDate('11-11-2026'), '2026-11-11');
  assert.equal(parseDate('١١-١١-٢٠٢٦'), '2026-11-11');
  assert.equal(parseDate('31-02-2026'), null);
  assert.deepEqual(parsePassengerCount('بالغين 2 وأطفال 1 أعمار 8'), { adults: 2, children: 1, infants: 0, ages: [8] });
  assert.deepEqual(parsePassengerCount('بالغين ٢'), { adults: 2, children: 0, infants: 0, ages: [] });
  assert.equal(parsePassengerCount('طفل واحد'), null);
});

test('greets new customers and supports cancelling an unfinished request', () => {
  resetSessions();
  assert.match(handleMessage('customer-3', 'مرحبا').reply, /خدمة طلبات الطيران من مجموعة الرمال/);
  handleMessage('customer-3', `من دبي إلى دمشق، ${futureDate(20)} ذهاب فقط`);
  assert.match(handleMessage('customer-3', 'إلغاء').reply, /تم إلغاء طلب التسعير/);
  assert.match(handleMessage('customer-3', '2 بالغين').reply, /من أي مدينة أو مطار/);
});

test('rejects dates in the past and return dates before departure', () => {
  resetSessions();
  const past = new Date(Date.now() - 86400000);
  const pastText = `${String(past.getUTCDate()).padStart(2, '0')}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${past.getUTCFullYear()}`;
  assert.match(handleMessage('customer-4', `من دبي إلى دمشق، ${pastText} ذهاب فقط`).reply, /التاريخ غير صالح أو مضى/);
  assert.match(handleMessage('customer-5', `من دبي إلى دمشق، ${futureDate(10)} وعودة ${futureDate(4)} ذهاب وعودة`).reply, /العودة تسبق الذهاب/);
});

test('collects required details over turns and never claims a fare was checked', () => {
  resetSessions();
  const first = handleMessage('customer-1', `من دبي إلى دمشق، ${futureDate(20)} ذهاب فقط`);
  assert.equal(first.complete, false);
  assert.match(first.reply, /بالغين والأطفال/);
  const second = handleMessage('customer-1', '2 بالغين');
  assert.equal(second.complete, true);
  assert.match(second.reply, /طلب الاستعلام/);
  assert.match(second.reply, /لا يتم حجز أو إصدار تذكرة تلقائيًا/);
  assert.match(second.reply, /التحقق من السعر غير متاح تلقائيًا/);
  assert.doesNotMatch(second.reply, /سأتحقق من السعر المتاح/);
});

test('round trip requires a return date', () => {
  resetSessions();
  const result = handleMessage('customer-2', `من دبي إلى دمشق، ${futureDate(20)} ذهاب وعودة، بالغين 1`);
  assert.equal(result.complete, false);
  assert.match(result.reply, /تاريخ العودة/);
});

test('explicit WhatsApp pricing test is labeled synthetic and uses extra-weight margin',()=>{
  const result=handleMessage('operator','اختبار التسعير');
  assert.equal(result.complete,false);
  assert.match(result.reply,/افتراضي فقط/);
  assert.match(result.reply,/1070.00/);
  assert.match(result.reply,/عمولة الوزن الإضافي: 10.00/);
});
test('records requested weight without prompting for special services',()=>{
  resetSessions();
  const result=handleMessage('weight-user',`من الشارقة إلى دمشق، ${futureDate(30)}، ذهاب فقط، 1 بالغ، بدي ٣٠ كيلو`);
  assert.equal(result.complete,true);
  assert.equal(result.request.baggageRequest.checkedWeightKg,30);
  assert.match(result.reply,/الوزن المطلوب: 30/);
});

test('airport replies with airport prefix, fillers and IATA codes advance instead of repeating',()=>{
 for(const answer of ['مطار الشارقة','الشارقه الدولي','من مطار الشارقة','بدي من الشارقة','SHJ','Sharjah airport']){
  resetSessions();handleMessage('airport-user','بدي ارخص تاريخ بهل اسبوع');
  const next=handleMessage('airport-user',answer);assert.match(next.reply,/إلى أي مدينة/);
  const done=handleMessage('airport-user','مطار دمشق الدولي');assert.equal(done.complete,true);assert.equal(done.request.origin,'الشارقة');assert.equal(done.request.destination,'دمشق');
 }
});
test('bare ambiguous multiple cities do not silently choose an airport',()=>{
 resetSessions();handleMessage('ambiguous-user','بدي ارخص تاريخ بهل اسبوع');
 assert.match(handleMessage('ambiguous-user','الشارقة او دبي').reply,/من أي مدينة أو مطار/);
});

test('colloquial airport aliases preserve route direction',()=>{
 for(const city of ['شارق','شارقه','شارجه','الشارقه','الشارقة','شارقة','شارجة']){
  resetSessions();const r=handleMessage('alias','من '+city+' على الشام، بدي ارخص تاريخ بهل اسبوع');
  assert.equal(r.complete,true);assert.equal(r.request.origin,'الشارقة');assert.equal(r.request.destination,'دمشق');
 }
 for(const [name,expected]of [['الشام','دمشق'],['شام','دمشق'],['دمشق','دمشق'],['حلب','حلب'],['حلاب','حلب']]){
  resetSessions();handleMessage('alias-d','من الشارقة بدي ارخص تاريخ بهل اسبوع');
  const r=handleMessage('alias-d',name);assert.equal(r.complete,true);assert.equal(r.request.destination,expected);
 }
});
test('any UAE airport intent discloses limited coverage instead of asking the same airport question',()=>{
 resetSessions();const r=handleMessage('any-uae','اي مطار بالامارات ما بتفرق بدي الارخص على الشام بهل اسبوع');
 assert.equal(r.complete,true);assert.equal(r.request.originScope,'any_uae');assert.equal(r.request.origin,'الشارقة');assert.equal(r.request.destination,'دمشق');
});

test('repeating the departure airport while asked for destination never creates a same-airport route',()=>{
 resetSessions();const h=t=>handleMessage('screenshot-repro',t);
 h('مرحبا');h('لا لا بدي بهل اسبوع ماكسيموم');
 assert.match(h('من الشارجه').reply,/مطار المغادرة الشارقة واضح/);
 for(const name of ['شارقه','الشارقة','SHJ']){const r=h(name);assert.equal(r.complete,false);assert.match(r.reply,/إلى أي مدينة/);}
 const done=h('الشام');assert.equal(done.complete,true);assert.equal(done.request.origin,'الشارقة');assert.equal(done.request.destination,'دمشق');
});
test('vague Syria request still asks destination city after origin is repeated',()=>{
 resetSessions();const h=t=>handleMessage('country-repro',t);
 h('خيو بدي انزل على سوريا بهل اسبوع شوفي اسعار');h('من الشارجه');
 const r=h('شارقه');assert.equal(r.complete,false);assert.match(r.reply,/إلى أي مدينة بسوريا/);
});

test('a baggage follow-up amends the same weekly request after submission',()=>{
 for(const weight of ['30 كيلو','بدي 30 كيلو','٣٠ كيلو','30kg']){
  resetSessions();handleMessage('amend-user','من الشارقة على الشام بدي ارخص سعر بهل اسبوع');
  const r=handleMessage('amend-user',weight);assert.equal(r.complete,true);assert.equal(r.amendment,true);assert.equal(r.request.baggageRequest.checkedWeightKg,30);assert.equal(r.request.destination,'دمشق');assert.ok(r.request.departureRange);
 }
});
