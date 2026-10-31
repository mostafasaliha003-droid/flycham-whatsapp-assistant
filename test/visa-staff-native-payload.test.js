'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),sourcePath=require.resolve('../src/visa-whatsapp'),sourceRequire=createRequire(sourcePath);
const m={exports:{}};vm.runInNewContext(fs.readFileSync(sourcePath,'utf8'),{module:m,exports:m.exports,process,AbortSignal,Buffer,URL,require:n=>n==='sharp'?(()=>{throw Error('unused');}):n==='./graph-api'?{safeGraphFailure:()=> 'FAKE_ERROR'}:sourceRequire(n)});
const {questionFor}=require('../src/visa-client-questions');
test('real WhatsApp adapter renders button, list and text through a fake transport only',async()=>{
 let calls=0;const token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',customer='15550001001';
 for(const [field,expected]of [['transport','button'],['previousNationality','button'],['maritalStatus','list'],['entryDate','text']]){
 const q=questionFor(field,{applicantIndex:0});
 const adapter=m.exports.createVisaWhatsAppAdapter({env:{DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-test-token',WHATSAPP_PHONE_NUMBER_ID:'123456'},journal:{summary:()=>({serviceWindowOpen:true})},fetchImpl:async(url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.to,customer);assert.equal(body.interactive?.type||body.type,expected);return {ok:true,json:async()=>({messages:[{id:'synthetic-'+calls}]})};}});
 await adapter.send(customer,{type:'question',text:q.prompt,field,applicantIndex:0,token,options:q.options||[]},()=>true,{customer,kind:'staff_applicant_question'});
 }assert.equal(calls,4);
});
