'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {routeService,noteIncoming,activeService,isComplaint}=require('../src/service-routing');
const make=()=>({data:{},save(){}});
test('Package 5 Saudi application and paperwork phrases route directly without biasing a bare destination',()=>{
 for(const text of ['بدي أقدم على السعودية','كيف نقدم للسعودية','تقديم للسعودية','الأوراق المطلوبة للسعودية','شو المطلوب للسعودية','معاملة السعودية','منفذ البطحاء','بدي أحكي مع رعد','raad'])assert.equal(routeService(make(),'a',text).service,'saudi_visa',text);
 assert.equal(routeService(make(),'a','بدي السعودية').service,'choose');
 assert.equal(routeService(make(),'a','أوراق للسعودية وتذاكر طيران').service,'choose');
 assert.equal(routeService(make(),'a','بدي أقدم على السعودية',{env:{SAUDI_VISA_ENABLED:'false'}}).service,'flight');
});
test('Package 5 inline known references route within customer scope and preserve an explicit flight session',()=>{
 const s=make();s.data.visaFulfilment={jobs:{a:{customer:'a',applicationReference:'828000077'}}};
 assert.equal(routeService(s,'b','بخصوص E828000077 لو سمحت').service,'choose');
 assert.equal(routeService(s,'a','بخصوص E828000077 لو سمحت').service,'saudi_visa');
 routeService(s,'a','بدي طيران');assert.equal(routeService(s,'a','بخصوص E828000077 لو سمحت',{hasFlight:true}).service,'flight');
});
test('services retain isolated context and switch only on relevant explicit request',()=>{const s=make();assert.equal(routeService(s,'a','مرحبا').service,'choose');assert.equal(routeService(s,'a','بدي فيزا السعودية').service,'saudi_visa');assert.equal(routeService(s,'a','انا سوري').service,'saudi_visa');assert.equal(routeService(s,'a','بدي طيران للشام').service,'flight');assert.equal(activeService(s,'a'),'flight');assert.equal(routeService(s,'b','انا سوري').service,'choose');});
test('ambiguous and existing flight requests preserve scope and ordered revisions',()=>{const s=make();assert.equal(routeService(s,'a','بدي السعودية').service,'choose');assert.equal(routeService(s,'b','مرحبا',{hasFlight:true,hasActiveRequest:true}).service,'flight');assert.equal(noteIncoming(s,'a'),1);assert.equal(noteIncoming(s,'a'),2);assert.equal(routeService(s,'a','بدي فيزا وطيران').service,'choose');});
test('real complaints pause but quoting an accusation is not auto-blocking',()=>{assert.ok(isComplaint('انا قدمت عندكن وماطلعت الفيزا ومارجعتولي فلوسي'));assert.ok(isComplaint('انتو نصابين'));assert.equal(isComplaint('قالولي انكم نصابين صحيح؟'),false);assert.equal(isComplaint('متى تطلع الفيزا لو قدمت؟'),false);});
test('a returning visa greeting preserves service and real menu or flight choice still works',()=>{
 const s=make();routeService(s,'a','بدي فيزا السعودية');
 for(const text of ['مرحبا','السلام عليكم','ممكن استفسار'])assert.equal(routeService(s,'a',text).service,'saudi_visa');
 assert.equal(activeService(s,'a'),'saudi_visa');assert.equal(routeService(s,'a','القائمة').service,'choose');
 assert.equal(routeService(s,'a','فيزا السعودية').service,'saudi_visa');
 assert.equal(routeService(s,'a','بدي طيران للشام').service,'flight');
});
test('followup without a service keyword routes to visa only with compatible customer context',()=>{
 const s=make();assert.equal(routeService(s,'a','بدي تابع طلب').service,'saudi_visa');s.data.serviceSessions.b={service:'flight'};assert.equal(routeService(s,'b','شو صار بالطلب',{hasFlight:true}).service,'flight');
});
test('other service inquiry and its price followup remain separate from an active Saudi case',()=>{
 const s=make();routeService(s,'a','فيزا السعودية');s.data.visaCases={a:{id:'original'}};
 assert.equal(routeService(s,'a','بدي اسال عن فيزا تركيا').service,'service_inquiry');assert.equal(activeService(s,'a'),'saudi_visa');assert.equal(routeService(s,'a','قديش تكلفتها').service,'service_inquiry');assert.equal(s.data.visaCases.a.id,'original');assert.equal(routeService(s,'a','شو صار بطلبي').service,'saudi_visa');assert.equal(routeService(s,'a','فيزا السعودية').service,'saudi_visa');assert.equal(s.data.serviceSessions.a.serviceInquiry,undefined);
});
test('family visits and plural flight requests route without guessing Saudi intent',()=>{for(const t of ['زيارة عائلية للسعودية','زيارة شخصية'])assert.equal(routeService(make(),t,t).service,'saudi_visa');for(const t of ['تذاكر اللاذقية','تيكتات أجنحة الشام','العربية للطيران'])assert.equal(routeService(make(),t,t).service,'flight');assert.equal(routeService(make(),'x','بدي السعودية').service,'choose');});
