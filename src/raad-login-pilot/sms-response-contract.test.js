'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {verifyOfficialSmsResponse}=require('./sms-response-contract');
const {createSmsRequestProof,confirmSmsRequest}=require('./sms-request-proof');
const URL='https://visa.mofa.gov.sa/SmartForm/SendOtpSms';
function fixture({body={success:true,otpToken:'SYNTHETIC_TOKEN'},raw,status=200,method='POST',url=URL,responseUrl=url,redirect=null}={}){
 let reads=0;const request={method:()=>method,url:()=>url,redirectedFrom:()=>redirect};
 const response={request:()=>request,url:()=>responseUrl,status:()=>status,text:async()=>{reads++;return raw===undefined?JSON.stringify(body):raw;}};
 return {request,response,reads:()=>reads};
}
test('official UI success requires strict true and a nonempty token; result exposes only an enum',async()=>{
 const f=fixture();assert.equal(await verifyOfficialSmsResponse(f.response),'accepted');assert.equal(f.reads(),1);
});
test('explicit false without token is refusal; server text is never returned',async()=>{
 assert.equal(await verifyOfficialSmsResponse(fixture({body:{success:false,message:'PRIVATE_MESSAGE'}}).response),'rejected');
});
test('missing, truthy, contradictory, malformed and oversized payloads stay unknown',async()=>{
 for(const body of [null,[],{},true,{success:'true',otpToken:'x'},{success:1,otpToken:'x'},{success:true},{success:true,otpToken:'  '},{success:true,otpToken:7},{success:false,otpToken:'x'}])assert.equal(await verifyOfficialSmsResponse(fixture({body}).response),'unknown');
 for(const raw of ['<html>private</html>','{broken','x'.repeat(16385),'{"success":false,"success":true,"otpToken":"x"}','{"success":true,"otpToken":"a","otpToken":"b"}'])assert.equal(await verifyOfficialSmsResponse(fixture({raw}).response),'unknown');
});
test('only exact unredirected official POST response is parsed',async()=>{
 for(const options of [{method:'GET'},{url:URL+'?mobile=123'},{url:URL.replace('SendOtpSms','SendOtp')},{url:URL.replace('visa.mofa.gov.sa','other.test')},{responseUrl:URL+'/other'},{redirect:{}},{status:302},{status:403},{status:500}]){const f=fixture(options);assert.equal(await verifyOfficialSmsResponse(f.response),'unknown');assert.equal(f.reads(),0);}
});
test('body read failure stays unknown without forwarding exception text',async()=>{
 const f=fixture();f.response.text=async()=>{throw Error('PRIVATE_TOKEN');};assert.equal(await verifyOfficialSmsResponse(f.response),'unknown');
});
test('real proof and official classifier accept only matching synthetic destination and retain no body',async()=>{
 for(const phone of ['971500000123','971500000999']){
  const page=new EventEmitter(),frame={url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp'};page.url=frame.url;page.mainFrame=()=>frame;
  const f=fixture();Object.assign(f.request,{frame:()=>frame,resourceType:()=> 'xhr',postData:()=> 'mobile='+phone});
  const proof=createSmsRequestProof(page,{verifyResponse:verifyOfficialSmsResponse,timeoutMs:20});proof.arm({expectedPhone:'500000123',expectedDialCode:'971'});
  page.emit('request',f.request);page.emit('response',f.response);const evidence=await proof.wait();
  if(phone==='971500000123'){assert.equal(evidence.acceptance,'accepted');assert.equal(confirmSmsRequest({}, {activationDispatched:true,smsRequest:evidence}),true);}else assert.notEqual(evidence.acceptance,'accepted');
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_TOKEN'),false);assert.equal(Object.hasOwn(evidence,'delivered'),false);
 }
});
