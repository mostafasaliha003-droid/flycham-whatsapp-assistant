'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {changeWhatsAppBlock,sendComplaintNotification}=require('../src/graph-api');
const env={DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-secret',WHATSAPP_PHONE_NUMBER_ID:'1345816781956603',WHATSAPP_GRAPH_API_VERSION:'v23.0'};
const owner='971500000005',customer='971500000001';
const input={caseId:'test-case-123',customer,text:'شكوى جديدة تحتاج استلام المحادثة من اللوحة.',url:'https://flycham-whatsapp-assistant.onrender.com/operations?customer='+customer};
test('block and unblock dispatch only requested user and require target-specific applied result',async()=>{
 for(const blocked of [true,false]){
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({messaging_product:'whatsapp',block_users:{[blocked?'added_users':'removed_users']:[{input:'+'+customer,wa_id:customer}]}})};};
  assert.deepEqual(await changeWhatsAppBlock('+'+customer,{blocked},env,fetchImpl),{ok:true,blocked,scope:'whatsapp'});
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,blocked?'POST':'DELETE');
  assert.equal(calls[0].url,'https://graph.facebook.com/v23.0/1345816781956603/block_users');
  assert.deepEqual(JSON.parse(calls[0].options.body),{messaging_product:'whatsapp',block_users:[{user:customer}]});
 }
});
test('HTTP200 partial failure, wrong user, and generic success never assert block success',async()=>{
 for(const data of [
  {messaging_product:'whatsapp',block_users:{added_users:[],failed_users:[{input:customer,errors:[{message:'private text'}]}]}},
  {messaging_product:'whatsapp',block_users:{added_users:[{wa_id:owner}]}},
  {messaging_product:'whatsapp',block_users:{added_users:[{wa_id:owner,input:customer}]}},
  {success:true},
  {messaging_product:'whatsapp',block_users:{added_users:[{wa_id:customer}],failed_users:[{input:customer}]}},
 ])await assert.rejects(changeWhatsAppBlock(customer,{blocked:true},env,async()=>({ok:true,json:async()=>data})),/WHATSAPP_BLOCK_(?:UNCONFIRMED|REJECTED)/);
});
test('block errors are sanitized and ambiguous transport is not retried',async()=>{
 let calls=0;await assert.rejects(changeWhatsAppBlock(customer,{blocked:true},env,async()=>{calls++;throw Error('token private');}),/^Error: WHATSAPP_BLOCK_OUTCOME_UNCERTAIN$/);assert.equal(calls,1);
 await assert.rejects(changeWhatsAppBlock(customer,{blocked:true},env,async()=>({ok:false,status:403,json:async()=>({error:{code:10,message:'token private'}})})),/^Error: WHATSAPP_GRAPH_HTTP_403_CODE_10_SUBCODE_0$/);
});
test('dry-run block never dispatches and cannot be treated as applied',async()=>{
 assert.deepEqual(await changeWhatsAppBlock(customer,{blocked:true},{},async()=>assert.fail('no request')),{ok:false,dryRun:true,scope:'whatsapp'});
});
test('invalid block targets, options or Graph address fail closed',async()=>{
 for(const to of ['',customer+'?token=x','https://example.test','+000000000',123])await assert.rejects(changeWhatsAppBlock(to,{blocked:true},env,async()=>assert.fail('no request')),/WHATSAPP_RECIPIENT_INVALID/);
 await assert.rejects(changeWhatsAppBlock(customer,{blocked:'true'},env),/WHATSAPP_BLOCK_INVALID/);
 await assert.rejects(changeWhatsAppBlock(customer,{blocked:true},{...env,WHATSAPP_PHONE_NUMBER_ID:'../../other'}),/WHATSAPP_GRAPH_CONFIG_MISSING/);
});
test('in-window complaint notification links to protected dashboard without credentials',async()=>{
 let sent;const response=await sendComplaintNotification(owner,input,env,async(url,options)=>{sent=JSON.parse(options.body);return{ok:true,json:async()=>({messages:[{id:'wamid.synthetic'}]})};});
 assert.equal(response.messages[0].id,'wamid.synthetic');assert.equal(sent.type,'text');assert.equal(sent.to,owner);assert.equal(sent.text.body,input.text+'\n\n'+input.url);assert.equal(sent.text.preview_url,false);
});
test('outside-window notification uses explicit approved template contract',async()=>{
 let sent;
 await sendComplaintNotification(owner,{...input,useTemplate:true},{...env,SAUDI_VISA_COMPLAINT_TEMPLATE:'remal_visa_complaint',SAUDI_VISA_COMPLAINT_TEMPLATE_LANGUAGE:'ar'},async(url,options)=>{sent=JSON.parse(options.body);return{ok:true,json:async()=>({messages:[{id:'wamid.template'}]})};});
 assert.equal(sent.type,'template');assert.deepEqual(sent.template,{name:'remal_visa_complaint',language:{code:'ar'},components:[{type:'body',parameters:[{type:'text',text:input.caseId},{type:'text',text:customer}]},{type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:customer}]}]});
 await assert.rejects(sendComplaintNotification(owner,{...input,useTemplate:true},env,async()=>assert.fail('template missing')),/WHATSAPP_COMPLAINT_TEMPLATE_REQUIRED/);
});
test('notification validates protected link, uses actual message acceptance, and no dry-run success',async()=>{
 for(const url of ['http://example.test/operations?customer='+customer,'https://example.test/operations?customer='+owner,input.url+'&key=secret',input.url+'#secret','https://u:p@example.test/operations?customer='+customer])await assert.rejects(sendComplaintNotification(owner,{...input,url},env,async()=>assert.fail('invalid link')),/WHATSAPP_COMPLAINT_URL_INVALID/);
 assert.deepEqual(await sendComplaintNotification(owner,input,{},async()=>assert.fail('dry run')),{dryRun:true});
 let calls=0;await assert.rejects(sendComplaintNotification(owner,input,env,async()=>{calls++;return{ok:true,json:async()=>({success:true})};}),/WHATSAPP_COMPLAINT_OUTCOME_UNCERTAIN/);assert.equal(calls,1);
});
