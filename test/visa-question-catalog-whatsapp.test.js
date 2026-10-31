'use strict';
// Exercises the actual wire renderer for every catalog question, including
// unselected options: Meta rejects invalid button titles before any answer.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {QUESTION_CATALOG,questionFor}=require('../src/visa-client-questions');
const {createVisaWhatsAppAdapter}=require('../src/visa-whatsapp');
const CUSTOMER='971500000001';

test('every applicant question renders and dispatches through the real WhatsApp adapter using a synthetic transport',async t=>{
 for(const field of Object.keys(QUESTION_CATALOG))await t.test(field,async()=>{
  const question=questionFor(field,{applicantIndex:0}),captured=[];
  const adapter=createVisaWhatsAppAdapter({
   env:{DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic_local_access_not_a_real_key',WHATSAPP_PHONE_NUMBER_ID:'1234567890'},
   journal:{summary:()=>({serviceWindowOpen:true})},
   fetchImpl:async(url,request)=>{
    assert.equal(url,'https://graph.facebook.com/v23.0/1234567890/messages');assert.equal(request.method,'POST');
    captured.push(JSON.parse(request.body));return {ok:true,status:200,json:async()=>({messages:[{id:'synthetic_catalog_acceptance'}]})};
   }
  });
  const result=await adapter.send(CUSTOMER,{type:'question',text:question.prompt,token:'10000000-0000-4000-8000-000000000001',field,applicantIndex:0,options:question.options||[]},()=>true,{customer:CUSTOMER,kind:'applicant_question'});
  assert.equal(result.messages[0].id,'synthetic_catalog_acceptance');assert.equal(captured.length,1);assert.equal(captured[0].to,CUSTOMER);
  const payload=captured[0];
  if(question.options?.length){
   const rows=payload.interactive.type==='button'?payload.interactive.action.buttons.map(x=>x.reply):payload.interactive.action.sections[0].rows;
   assert.equal(rows.length,question.options.length);
   assert.deepEqual(rows.map(x=>x.id.split(':').at(-1)),question.options.map(x=>x.id));
   assert.deepEqual(rows.map(x=>x.title),question.options.map(x=>x.label));
  }else assert.equal(payload.text.body,question.prompt);
 });
});

test('passport sex options preserve the original option identities and answer meanings',()=>{
 assert.deepEqual(QUESTION_CATALOG.sex.options.map(({id,value})=>({id,value})),[{id:'male',value:'M'},{id:'female',value:'F'},{id:'unspecified',value:'X'}]);
});
