'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderComparison,offerKey}=require('../src/quote-comparison');
const request=(origin='دبي',destination='دمشق')=>({origin,destination,departureDate:'2090-11-11',tripType:'one_way',passengers:{adults:1,children:0,infants:0},baggageRequest:{checkedWeightKg:30}});
const child=(provider,origin,status='unverified',phase='airports')=>({provider,request:request(origin),status,phase,offers:[]});
function parent(){return {request:request(),providers:['flycham','airarabia'],airportRouting:{flycham:{airportSide:'origin',requestedAirport:'دبي',excludedRequested:false,airports:['دبي','الشارقة']},airarabia:{airportSide:'origin',requestedAirport:'دبي',excludedRequested:true,reason:'configured_airport',airports:['الشارقة','أبوظبي']}},children:[child('flycham','دبي','unverified','exact'),child('flycham','الشارقة'),child('airarabia','الشارقة'),child('airarabia','أبوظبي','no_flights')]};}
function offer(c,reference,total){return {provider:c.provider,reference,request:c.request,checkedAt:Date.parse('2090-11-01T10:00:00Z'),timing:{out:{flight:c.provider==='flycham'?'XH123':'G9123',departure:'10:00',arrival:'12:00'}},price:{sellingTotal:total,weights:[{kg:30}],voucherValue:'10.00'}};}
const questionCount=text=>(text.match(/[؟?]/g)||[]).length;
test('Dubai comparison labels each actual airline/airport and finishes with one actionable question',()=>{
 const p=parent(),before=structuredClone(p),text=renderComparison(p);
 assert.match(text,/من دبي إلى دمشق/);assert.match(text,/من مطار دبي إلى مطار دمشق على فلاي شام/);
 assert.match(text,/المغادرة من مطار الشارقة — العربية للطيران/);assert.match(text,/المغادرة من مطار أبوظبي — العربية للطيران/);
 assert.match(text,/لم يتأكد سعر جاهز للإرسال من مطار الشارقة إلى مطار دمشق على العربية/);
 assert.match(text,/من مطار أبوظبي إلى مطار دمشق على العربية للطيران؛ ما في رحلات متاحة/);
 assert.doesNotMatch(text,/راجعت الفترة المطلوبة من مطار دبي إلى مطار دمشق على العربية/);
 assert.match(text,/هالنتيجة ما تعني أن الرحلات غير موجودة أو المقاعد ممتلئة/);
 assert.equal(questionCount(text),1);assert.match(text,/سبعة أيام بعد آخر تاريخ طلبته/);assert.deepEqual(p,before);
});
test('single-airline restriction never claims the other airline was checked',()=>{
 const p=parent();p.providers=['airarabia'];p.children=p.children.filter(c=>c.provider==='airarabia');
 const text=renderComparison(p);assert.doesNotMatch(text,/فلاي شام/);assert.equal(questionCount(text),1);assert.match(text,/العربية للطيران — مقارنة مطارات المغادرة/);
});
test('pending searches remain pending without a terminal invitation or unsupported completion claim',()=>{
 const p=parent();p.children[0].status='pending';const text=renderComparison(p);
 assert.match(text,/بقية الخيارات لسه قيد التحقق/);assert.doesNotMatch(text,/سبعة أيام بعد آخر تاريخ/);assert.equal(questionCount(text),0);
});
test('verified cards retain exact facts and references while airport alternatives stay separate',()=>{
 const p=parent();p.children[0].offers=[offer(p.children[0],3,'650.00')];p.children[0].status='available';p.children[2].offers=[offer(p.children[2],8,'600.00')];p.children[2].status='available';
 const text=renderComparison(p);assert.match(text,/الخيار 3 — فلاي شام/);assert.match(text,/الخيار 8 — العربية للطيران/);assert.match(text,/الإجمالي: 650.00 درهم/);assert.match(text,/الإجمالي: 600.00 درهم/);assert.match(text,/الإقلاع: 10:00/);assert.match(text,/30 كيلو مسجل/);assert.ok(text.indexOf('650.00')<text.indexOf('600.00'));
 assert.equal(questionCount(text),1);assert.doesNotMatch(text,/سبعة أيام بعد آخر تاريخ/);
 const delivered=renderComparison(p,{excludeOfferKeys:[offerKey(p.children[0].offers[0])]});assert.doesNotMatch(delivered,/الخيار 3 —/);assert.match(delivered,/الخيار 8 —/);assert.match(delivered,/سبق إرسالها/);
});
test('reverse Syria itinerary labels alternative arrival airport, not departure',()=>{
 const p=parent();p.request=request('دمشق','دبي');p.providers=['airarabia'];p.airportRouting.airarabia.airportSide='destination';p.children=[{...child('airarabia','دمشق'),request:request('دمشق','الشارقة')}];
 const text=renderComparison(p);assert.match(text,/الوصول إلى مطار الشارقة — العربية للطيران/);assert.match(text,/من مطار دمشق إلى مطار الشارقة/);assert.doesNotMatch(text,/المغادرة من مطار الشارقة/);assert.match(text,/من دمشق إلى دبي/);
});
test('a company absent from the plan is never described as searched or sold out',()=>{
 const p=parent();p.children=p.children.filter(c=>c.provider!=='airarabia');delete p.airportRouting.airarabia;
 const text=renderComparison(p);assert.match(text,/لم يبدأ فحص خيارات هذه الشركة لهذا المطار/);assert.doesNotMatch(text,/راجعت الفترة المطلوبة.*على العربية/);assert.equal(questionCount(text),1);
});
