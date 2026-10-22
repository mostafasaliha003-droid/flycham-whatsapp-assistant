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
