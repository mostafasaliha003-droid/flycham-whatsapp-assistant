'use strict';
const { buildAirArabiaQuote } = require('./selection');

// Explicit operator-triggered arithmetic test. No supplier or customer data.
function pricingDemo() {
  const option=(id,cost,extra)=>({id,cost,available:true,eligible:true,includedInBase:false,...extra});
  const q={currency:'AED',baseTotal:'1000.00',passengerCount:1,segmentIds:['demo'],
    allChargesChecked:true,finalPortalTotal:'1035.00',
    baggageRequests:[{passengerIndex:1,segmentId:'demo',requestedByCustomer:true,checkedWeightKg:30}],
    catalogs:[
      {type:'seat',passengerIndex:1,segmentId:'demo',allOptionsChecked:true,options:[option('demo-seat','0',{seatNumber:'10A'})]},
      {type:'meal',passengerIndex:1,segmentId:'demo',allOptionsChecked:true,options:[option('demo-food','0',{providesService:true})]},
      {type:'baggage',passengerIndex:1,segmentId:'demo',allOptionsChecked:true,options:[
        option('20kg','0',{checkedWeightKg:20,handWeightKg:0}),
        option('30kg','35',{checkedWeightKg:30,handWeightKg:0})]},
    ]};
  const p=buildAirArabiaQuote(q,{});
  return `اختبار حسابي افتراضي فقط — ليس عرض سعر رحلة ولا نتيجة بحث في البوابة.\nسعر افتراضي شامل الرسوم: 1000 درهم\nترقية وزن افتراضية: 35 درهم\nعمولة التذكرة: 25 درهم\nعمولة الوزن الإضافي: ${p.baggageMargin} درهم\nالإجمالي التجريبي: ${p.sellingTotal} درهم\nالمقعد والوجبة مجانيان في هذا المثال. لم يُنفّذ أي حجز.`;
}
module.exports={pricingDemo};
