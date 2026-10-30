'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createSmsRequestProof,cleanSmsRequestEvidence,confirmSmsRequest}=require('./sms-request-proof');
function fixture({verifyResponse=async()=> 'accepted',timeoutMs=15,query='mobile=0500000123&prefix=00971'}={}){
 const page=new EventEmitter(),frame={url:()=> 'https://visa.mofa.gov.sa/SmartForm/TraditionalApp'};
 page.url=frame.url;page.mainFrame=()=>frame;
 let bodies=0;
 const request={url:()=> 'https://visa.mofa.gov.sa/SmartForm/SendOtp?'+query,frame:()=>frame,resourceType:()=> 'xhr',method:()=> 'GET'};
 const response=(status=200,req=request)=>({request:()=>req,status:()=>status,text:async()=>{bodies++;return 'PRIVATE_PHONE PRIVATE_OTP PRIVATE_TOKEN';}});
 const proof=createSmsRequestProof(page,{verifyResponse,timeoutMs});proof.arm({expectedPhone:'500000123',expectedDialCode:'971'});
 return {page,request,response,proof,bodies:()=>bodies,send:()=>page.emit('request',request)};
}
const result=e=>({activationDispatched:true,smsRequest:e});
test('verified synthetic response and matched international destination allow waiting, never claim delivery',async()=>{
 const f=fixture();f.send();f.page.emit('response',f.response());const evidence=await f.proof.wait();
 assert.equal(evidence.acceptance,'accepted');assert.equal(evidence.destinationMatch,'matched');assert.equal(confirmSmsRequest({},result(evidence)),true);
 assert.equal(f.bodies(),0);assert(!Object.hasOwn(evidence,'delivered'));assert.equal(f.page.listenerCount('response'),0);
});
test('2xx alone or unknown response contract never establishes acceptance',async()=>{
 const f=fixture({verifyResponse:async()=> 'unknown'});f.send();f.page.emit('response',f.response());const e=await f.proof.wait();
 assert.equal(e.acceptance,'unknown');assert.throws(()=>confirmSmsRequest({},result(e)),/ACCEPTANCE_UNCONFIRMED/);assert.equal(f.bodies(),0);
});
test('HTTP refusal and explicit synthetic refusal stop before a user-code challenge',async()=>{
 for(const options of [{status:403},{status:200,verifyResponse:async()=> 'rejected'}]){
  const f=fixture(options);f.send();f.page.emit('response',f.response(options.status));const e=await f.proof.wait();
  assert.equal(e.acceptance,'rejected');assert.throws(()=>confirmSmsRequest({},result(e)),/SMS_REJECTED/);
 }
});
test('server failure, malformed contract and classifier exceptions remain unknown',async()=>{
 for(const options of [{status:500},{status:302},{status:200,verifyResponse:async()=>({accepted:true,secret:'PRIVATE'})},{status:200,verifyResponse:async()=>{throw Error('PRIVATE_TOKEN');}}]){
  const f=fixture(options);f.send();f.page.emit('response',f.response(options.status));const e=await f.proof.wait();
  assert.equal(e.acceptance,'unknown');assert.throws(()=>confirmSmsRequest({},result(e)),/ACCEPTANCE_UNCONFIRMED/);assert(!JSON.stringify(e).includes('PRIVATE'));
 }
});
test('missing, conflicting and trunk-zero destinations cannot become an accepted request',async()=>{
 for(const query of ['mobile=0500000123','mobile=0500000123&prefix=00966','mobile=0599999999&prefix=00971','mobile=009710500000123','mobile=0500000123&mobile=0599999999&prefix=00971']){
  const f=fixture({query});f.send();f.page.emit('response',f.response());const e=await f.proof.wait();
  assert.notEqual(e.destinationMatch,'matched');assert.notEqual(e.acceptance,'accepted');assert.throws(()=>confirmSmsRequest({},result(e)),/DESTINATION_UNCONFIRMED/);
 }
});
test('full international destination includes country proof without duplicating the prefix',async()=>{
 const f=fixture({query:'mobile=%2B971500000123'});f.send();f.page.emit('response',f.response());assert.equal((await f.proof.wait()).destinationMatch,'matched');
});
test('wrong origin, child frame, endpoint and resource type are ignored without sending anything',async()=>{
 for(const override of [{url:()=> 'https://other.test/SmartForm/SendOtp?mobile=0500000123&prefix=00971'},{frame:()=>({})},{url:()=> 'https://visa.mofa.gov.sa/SmartForm/Save'},{resourceType:()=> 'document'}]){
  const f=fixture();const req={...f.request,...override};f.page.emit('request',req);f.page.emit('response',f.response(200,req));const e=await f.proof.wait();
  assert.equal(e.requestObserved,false);assert.notEqual(e.acceptance,'accepted');
 }
});
test('unrelated response cannot prove acceptance for the tracked request',async()=>{
 const f=fixture();f.send();f.page.emit('response',f.response(200,{...f.request}));const e=await f.proof.wait();assert.equal(e.responseObserved,false);
});
test('network failure and no response stop without retries or leaking raw request data',async()=>{
 for(const failure of [false,true]){
  const f=fixture();let count=0;f.page.on('request',()=>count++);f.send();if(failure)f.page.emit('requestfailed',f.request);
  const e=await f.proof.wait();assert.equal(e.responseObserved,false);assert.throws(()=>confirmSmsRequest({},result(e)),/RESPONSE_UNCONFIRMED/);
  assert.equal(count,1);assert.equal(f.page.listenerCount('response'),0);
  assert(!JSON.stringify(e).includes('500000123'));assert(!JSON.stringify(e).includes('971'));
 }
});
test('duplicate requests remain unknown and the observer cannot be armed again',async()=>{
 const f=fixture();f.send();f.send();f.page.emit('response',f.response());const e=await f.proof.wait();
 assert.equal(e.acceptance,'unknown');assert.throws(()=>f.proof.arm({expectedPhone:'500000123',expectedDialCode:'971'}),/ALREADY_ATTEMPTED/);
});
test('bounded timeout ignores late classifier completion',async()=>{
 let release;const f=fixture({timeoutMs:5,verifyResponse:()=>new Promise(resolve=>{release=resolve;})});
 f.send();f.page.emit('response',f.response());const e=await f.proof.wait();assert.equal(e.acceptance,'unknown');release('accepted');await new Promise(r=>setImmediate(r));assert.equal(f.proof.snapshot().acceptance,'unknown');
});
test('cancellation removes listeners and never creates acceptance',async()=>{
 const f=fixture(),controller=new AbortController();f.send();const pending=f.proof.wait({signal:controller.signal});controller.abort();
 assert.equal((await pending).acceptance,'unknown');assert.equal(f.page.listenerCount('response'),0);assert.equal(f.page.listenerCount('requestfailed'),0);
});
test('sanitizer strips phone, OTP, tokens, URLs and inconsistent acceptance claims',()=>{
 const evidence=cleanSmsRequestEvidence({requestObserved:true,responseObserved:true,destinationMatch:'matched',responseClass:'4xx',acceptance:'accepted',phone:'PRIVATE_PHONE',otp:'PRIVATE_OTP',token:'PRIVATE_TOKEN',url:'https://private.test'});
 assert.equal(evidence.acceptance,'unknown');assert(!JSON.stringify(evidence).includes('PRIVATE'));assert.equal(Object.keys(evidence).length,5);
 assert.equal(cleanSmsRequestEvidence({acceptance:'accepted'}).acceptance,'unknown');
});
test('false or absent activation cannot be promoted by synthetic accepted evidence',async()=>{
 const f=fixture();f.send();f.page.emit('response',f.response());const evidence=await f.proof.wait();
 assert.throws(()=>confirmSmsRequest({}, {activationDispatched:false,smsRequest:evidence}),/REQUEST_UNCONFIRMED/);
});

test('missing response contract blocks before observers or an SMS action can start',()=>{
 const page=new EventEmitter(),proof=createSmsRequestProof(page);
 assert.throws(()=>proof.arm({expectedPhone:'500000123',expectedDialCode:'971'}),/RESPONSE_CONTRACT_UNCONFIGURED/);
 assert.equal(page.eventNames().length,0);assert.equal(proof.snapshot().requestObserved,false);
});

test('a stopped proof cannot be armed or reopen listeners',()=>{
 const f=fixture();f.proof.stop();assert.throws(()=>f.proof.arm({expectedPhone:'500000123',expectedDialCode:'971'}),/ALREADY_ATTEMPTED/);assert.equal(f.page.listenerCount('response'),0);
});
