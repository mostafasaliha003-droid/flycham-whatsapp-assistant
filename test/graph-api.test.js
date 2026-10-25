'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {safeGraphFailure,checkWhatsAppConnection,sendTextMessage,sendRequestChoiceMessage}=require('../src/graph-api');
test('Graph diagnostics expose only bounded numeric status and codes',()=>{
 assert.equal(safeGraphFailure(401,{error:{code:190,error_subcode:463,message:'private secret',fbtrace_id:'private'}}),'WHATSAPP_GRAPH_HTTP_401_CODE_190_SUBCODE_463');
 assert.equal(safeGraphFailure('private',{error:{code:'private',error_subcode:-1}}),'WHATSAPP_GRAPH_HTTP_0_CODE_0_SUBCODE_0');
});

const choiceId='12345678-1234-4321-abcd-123456789abc';
const choiceText='أهلًا فيك 🌷 بتحب نكمل على طلبك الحالي، أو نبدأ طلب جديد مستقل؟';
const sendEnv={DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-test-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone-id',WHATSAPP_GRAPH_API_VERSION:'v23.0'};
test('request choice sends exactly the two approved actionable reply buttons in one Graph message',async()=>{
 const original=global.fetch,calls=[];try{
  global.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({messages:[{id:'synthetic-choice-message'}]})};};
  const result=await sendRequestChoiceMessage('971500000001',{text:choiceText,choiceId},sendEnv);
  assert.equal(calls.length,1);assert.equal(result.messages[0].id,'synthetic-choice-message');
  assert.equal(calls[0].url,'https://graph.facebook.com/v23.0/synthetic-phone-id/messages');assert.equal(calls[0].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body),{messaging_product:'whatsapp',recipient_type:'individual',to:'971500000001',type:'interactive',interactive:{type:'button',body:{text:choiceText},action:{buttons:[{type:'reply',reply:{id:'request_continue:'+choiceId,title:'متابعة طلبي الحالي'}},{type:'reply',reply:{id:'request_new:'+choiceId,title:'طلب جديد مختلف'}}]}}});
  assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-test-token');assert.ok(calls[0].options.signal instanceof AbortSignal);
 }finally{global.fetch=original;}
});
test('request choice dry run never calls Graph and does not require credentials',async()=>{
 const original=global.fetch;try{global.fetch=async()=>assert.fail('dry run must not dispatch');assert.deepEqual(await sendRequestChoiceMessage('synthetic-customer',{text:choiceText,choiceId},{}),{dryRun:true});}finally{global.fetch=original;}
});
test('request choice rejects invalid bodies and unbounded or malformed nonces before any Graph call',async()=>{
 const original=global.fetch;try{
  global.fetch=async()=>assert.fail('invalid choice must not dispatch');
  for(const value of [{text:'',choiceId},{text:'   ',choiceId},{text:'x'.repeat(1025),choiceId},{text:123,choiceId},{text:choiceText,choiceId:'request_new:'+choiceId},{text:choiceText,choiceId:choiceId+'a'},{text:choiceText,choiceId:'a'.repeat(35)+'X'},{text:choiceText,choiceId:42}])await assert.rejects(sendRequestChoiceMessage('synthetic-customer',value,sendEnv),/WHATSAPP_REQUEST_CHOICE_INVALID/);
 }finally{global.fetch=original;}
});
test('request choice Graph failures are sanitized and never retried or resent as text',async()=>{
 const original=global.fetch,originalError=console.error,logged=[];try{
  console.error=value=>logged.push(value);
  for(const status of [401,429,500]){let calls=0;global.fetch=async()=>{calls++;return{ok:false,status,json:async()=>({error:{code:190,error_subcode:463,message:'PRIVATE_PROVIDER_TEXT',access_token:'PRIVATE_TOKEN'}})};};await assert.rejects(sendRequestChoiceMessage('synthetic-customer',{text:choiceText,choiceId},sendEnv),new RegExp(`^Error: WHATSAPP_GRAPH_HTTP_${status}_CODE_190_SUBCODE_463$`));assert.equal(calls,1);}
  assert.doesNotMatch(JSON.stringify(logged),/PRIVATE_PROVIDER_TEXT|PRIVATE_TOKEN|synthetic-test-token|synthetic-customer/);
  let calls=0;const interrupted=Error('synthetic transport interruption');global.fetch=async()=>{calls++;throw interrupted;};await assert.rejects(sendRequestChoiceMessage('synthetic-customer',{text:choiceText,choiceId},sendEnv),error=>error===interrupted);assert.equal(calls,1);
 }finally{global.fetch=original;console.error=originalError;}
});
test('shared Graph transport leaves ordinary text message payload unchanged',async()=>{
 const original=global.fetch;try{global.fetch=async(url,options)=>{assert.deepEqual(JSON.parse(options.body),{messaging_product:'whatsapp',recipient_type:'individual',to:'synthetic-customer',type:'text',text:{preview_url:false,body:'النص الأصلي'}});return{ok:true,json:async()=>({messages:[{id:'synthetic-text-message'}]})};};assert.equal((await sendTextMessage('synthetic-customer','النص الأصلي',sendEnv)).messages[0].id,'synthetic-text-message');}finally{global.fetch=original;}
});
test('connection probe is read-only and never returns credentials or response content',async()=>{
 const original=global.fetch;try{
 global.fetch=async(url,options)=>{assert.equal(options.method,undefined);assert.ok(url.endsWith('?fields=id'));assert.equal(options.body,undefined);return{ok:false,status:401,json:async()=>({error:{code:190,error_subcode:463,message:'secret'}})};};
 assert.equal(await checkWhatsAppConnection({DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'test',WHATSAPP_PHONE_NUMBER_ID:'test'}),'WHATSAPP_GRAPH_HTTP_401_CODE_190_SUBCODE_463');
 }finally{global.fetch=original;}
});
