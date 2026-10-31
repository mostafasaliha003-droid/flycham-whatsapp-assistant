'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),fs=require('node:fs');
const {verifySignature,extractIncomingMessages}=require('../src/whatsapp');
const {VisaFulfilment}=require('../src/visa-fulfilment');
const OWNER='971507993145',CODE='654321',SECRET='synthetic-only-webhook-secret';
const source=fs.readFileSync(require.resolve('../src/server'),'utf8'),start=source.indexOf('async function handleWebhookPost('),end=source.indexOf('\nfunction customerSearchActive',start);assert.ok(start>0&&end>start);
function payload({sender=OWNER,id='inbound-1',contextId='prompt-1',text=CODE}={}){return {entry:[{changes:[{field:'messages',value:{contacts:[{wa_id:sender,profile:{name:CODE}}],messages:[{from:sender,id,type:'text',context:{id:contextId},text:{body:text},timestamp:'1793354400'}]}}]}]};}
async function run({body=payload(),signed=true,secret=SECRET,production=false,throws=false,handled=true}={}){
 const raw=Buffer.from(JSON.stringify(body)),signature='sha256='+crypto.createHmac('sha256',SECRET).update(raw).digest('hex'),records=[],sent=[],diagnostics=[],inputs=[],seen=new Set();let consumes=0,models=0,status;
 const fulfilment={data:()=>({challenges:{old:{messageId:'prompt-1',noticeMessageId:'notice-1'}}}),otpOwner:()=>OWNER,isOtpMessage(input){return VisaFulfilment.prototype.isOtpMessage.call(this,input);},async consumeOtp(input){consumes++;inputs.push(input);if(throws)throw Error('private '+CODE);return {handled,ok:input.sender===OWNER};}};
 const journal={recordInbound:(to,data)=>records.push({to,...structuredClone(data)}),applyReceipt(){}};
 const context={Buffer,process:{env:{WHATSAPP_APP_SECRET:secret,...(production?{NODE_ENV:'production'}:{})}},readBody:async()=>raw,verifySignature,extractIncomingMessages,recordDeliveryStatuses(){},assistant:{store:{}},quoteJobs:{acceptMessage:id=>{if(seen.has(id))return false;seen.add(id);return true;},save(){}},noteIncoming(){},journal,complaints:{handleReceipt(){}},visaFulfilment:fulfilment,rawSendTextMessage:async(to,text)=>{sent.push({to,text});},wakeVisa(){},journalSafeText:text=>text,documentFeedbackAllowed:()=>{models++;throw Error('OTP_FELL_THROUGH');},console:{log:(...a)=>diagnostics.push(a),error:(...a)=>diagnostics.push(a)}};
 const handler=vm.runInNewContext('('+source.slice(start,end)+')',context);
 await handler({headers:{'x-hub-signature-256':signed?signature:'sha256='+'0'.repeat(64)}},{writeHead(code){status=code;return this;},end(){return this;}});
 return {records,sent,diagnostics,inputs,consumes,models,status,raw};
}
test('signed exact-owner OTP is intercepted before ordinary journal/model and incoming text/name are not retained',async()=>{
 const r=await run();assert.equal(r.status,200);assert.equal(r.consumes,1);assert.equal(r.models,0);assert.equal(r.records[0].text,'[رمز تحقق محجوب]');assert.equal(r.records[0].name,undefined);assert.equal(r.inputs[0].messageId,'inbound-1');assert.equal(r.inputs[0].text,'');assert.equal(r.raw.some(x=>x!==0),false);assert.equal(JSON.stringify([r.records,r.sent,r.diagnostics]).includes(CODE),false);
});
test('wrong-sender known replies are redacted and receive no secret-bearing or automatic owner response',async()=>{
 const r=await run({body:payload({sender:'971500000001'})});assert.equal(r.consumes,1);assert.equal(r.models,0);assert.equal(r.sent.length,0);assert.equal(r.records[0].name,undefined);assert.equal(JSON.stringify(r.records).includes(CODE),false);
});
test('invalid signatures and missing signing configuration cannot authorize OTP even in nonproduction',async()=>{
 for(const settings of [{signed:false},{secret:''},{secret:'',production:true}]){const r=await run(settings);assert.equal(r.consumes,0);assert.equal(r.models,0);assert.equal(r.sent.length,0);assert.equal(r.records.length,0);}
});
test('consume exceptions or handled-false never leak or fall through to models',async()=>{
 for(const settings of [{throws:true},{handled:false}]){const r=await run(settings);assert.equal(r.inputs[0].text,'');assert.equal(r.models,0);assert.equal(JSON.stringify([r.records,r.sent,r.diagnostics]).includes(CODE),false);}
});
test('duplicate signed provider messages invoke consume once',async()=>{
 const b=payload();b.entry[0].changes[0].value.messages.push(structuredClone(b.entry[0].changes[0].value.messages[0]));const r=await run({body:b});assert.equal(r.consumes,1);assert.equal(r.sent.length,1);assert.equal(r.models,0);
});
