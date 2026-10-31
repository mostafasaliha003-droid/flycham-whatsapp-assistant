'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {routeService:routeServiceImpl,noteIncoming,activeService,isComplaint}=require('../src/service-routing');
// Pure routing fixture: explicit service availability, independent of runtime execution flags.
const routeService=(store,id,text,options={})=>routeServiceImpl(store,id,text,{...options,env:options.env||{SAUDI_VISA_ENABLED:'true'}});
const make=()=>({data:{},save(){}});
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

test('explicitly disabled visa routing remains flight-only without changing runtime flags',()=>{const s=make(),before=process.env.SAUDI_VISA_ENABLED;assert.deepEqual(routeService(s,'a','بدي فيزا السعودية',{env:{SAUDI_VISA_ENABLED:'false'}}),{service:'flight'});assert.equal(s.data.serviceSessions,undefined);assert.equal(process.env.SAUDI_VISA_ENABLED,before);});
