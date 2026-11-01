'use strict';
const {createSmsDestinationObserver}=require('./sms-destination-observer');
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
const empty=()=>({requestObserved:false,destinationMatch:'unknown',responseObserved:false,responseClass:'none',acceptance:'unknown'});
function cleanSmsRequestEvidence(value){
 const out=empty();if(!value||typeof value!=='object')return out;
 for(const key of ['requestObserved','responseObserved'])out[key]=value[key]===true;
 for(const [key,allowed]of Object.entries({destinationMatch:['matched','different','unknown'],responseClass:['2xx','4xx','5xx','other','none'],acceptance:['accepted','rejected','unknown']}))if(allowed.includes(value[key]))out[key]=value[key];
 if(!out.requestObserved)out.destinationMatch='unknown';
 if(!out.responseObserved){out.responseClass='none';out.acceptance='unknown';}
 if(out.acceptance==='accepted'&&(!out.requestObserved||out.destinationMatch!=='matched'||out.responseClass!=='2xx'))out.acceptance='unknown';
 return out;
}
function destinationMatch(value){
 if(!value?.observed)return 'unknown';
 if(value.phoneMatch==='different'||value.dialCodeMatch===false)return 'different';
 if(value.phoneMatch==='e164'||value.phoneMatch==='national'&&value.dialCodeMatch===true)return 'matched';
 return 'unknown';
}
function isSmsRequest(page,request){
 try{
  const current=new URL(page.url()),main=page.mainFrame(),url=new URL(request.url());
  return current.origin===ORIGIN&&current.pathname===PATH&&main&&main.url()===page.url()&&request.frame()===main&&['xhr','fetch'].includes(request.resourceType())&&['GET','POST'].includes(request.method())&&url.origin===ORIGIN&&!url.username&&!url.password&&/^\/(?:SmartForm|Base)\/(?:send|request)[a-z0-9_-]*(?:otp|verificationcode)[a-z0-9_-]*$/i.test(url.pathname);
 }catch{return false;}
}
// No portal response contract is assumed. A verifier must be supplied in code
// after the actual endpoint's success/failure semantics have been established.
// Its output is a finite enum; response bodies never enter evidence or logs.
function createSmsRequestProof(page,{verifyResponse,timeoutMs=8000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('SMS_PROOF_TIMEOUT_INVALID');
 const destination=createSmsDestinationObserver(page);
 let state=empty(),tracked=null,armed=false,used=false,done=false,timer=null,resolveWait=null,waiting=null,epoch=0,duplicate=false;
 const remove=()=>{for(const [event,handler]of [['request',request],['response',response],['requestfailed',failed]])try{page.off(event,handler);}catch{}destination.stop();};
 const snapshot=()=>cleanSmsRequestEvidence({...state,destinationMatch:destinationMatch(destination.snapshot())});
 const finish=()=>{if(done)return;done=true;armed=false;epoch++;clearTimeout(timer);remove();tracked=null;if(resolveWait)resolveWait(snapshot());};
 function request(req){
  if(!armed||!isSmsRequest(page,req))return;
  if(tracked){duplicate=true;state.acceptance='unknown';finish();return;}
  tracked=req;state.requestObserved=true;
 }
 function failed(req){if(armed&&req===tracked){state.acceptance='unknown';finish();}}
 async function response(res){
  if(!armed||!tracked)return;
  let status;try{if(res.request()!==tracked)return;status=res.status();}catch{return;}
  const version=epoch;state.responseObserved=true;
  state.responseClass=Number.isInteger(status)&&status>=200&&status<300?'2xx':Number.isInteger(status)&&status>=400&&status<500?'4xx':Number.isInteger(status)&&status>=500&&status<600?'5xx':'other';
  let verdict='unknown';
  if(state.responseClass==='4xx')verdict='rejected';
  else if(state.responseClass==='2xx'&&typeof verifyResponse==='function'){
   try{const value=await verifyResponse(res);if(['accepted','rejected'].includes(value))verdict=value;}catch{}
  }
  if(!armed||version!==epoch)return;
  state.acceptance=duplicate?'unknown':verdict;finish();
 }
 function arm(input){
  if(used||done)throw Error('APPLICATION_SMS_ALREADY_ATTEMPTED');used=true;
  if(typeof verifyResponse!=='function')throw Object.assign(Error('APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED'),{code:'APPLICATION_SMS_RESPONSE_CONTRACT_UNCONFIGURED',notDispatched:true});
  if(!page||typeof page.on!=='function'||typeof page.off!=='function')return false;
  if(!destination.arm(input))return false;
  armed=true;for(const [event,handler]of [['request',request],['response',response],['requestfailed',failed]])page.on(event,handler);
  return true;
 }
 function wait({signal}={}){
  if(done)return Promise.resolve(snapshot());
  if(waiting)return waiting;
  waiting=new Promise(resolve=>{
   let abort;resolveWait=value=>{if(signal&&abort)signal.removeEventListener('abort',abort);resolve(value);};
   abort=()=>finish();if(signal?.aborted){finish();return;}signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(finish,timeoutMs);
  });return waiting;
 }
 return {arm,wait,snapshot,stop:finish,destination};
}
function confirmSmsRequest(record,result){
 const evidence=cleanSmsRequestEvidence(result?.smsRequest);record.smsRequest=evidence;
 const fail=code=>{throw Object.assign(Error(code),{code});};
 if(result?.activationDispatched!==true)fail('APPLICATION_SMS_REQUEST_UNCONFIRMED');
 if(evidence.destinationMatch!=='matched')fail('APPLICATION_SMS_DESTINATION_UNCONFIRMED');
 if(!evidence.responseObserved)fail('APPLICATION_SMS_RESPONSE_UNCONFIRMED');
 if(evidence.acceptance==='rejected')fail('APPLICATION_SMS_REJECTED');
 if(evidence.acceptance!=='accepted')fail('APPLICATION_SMS_ACCEPTANCE_UNCONFIRMED');
 // Accepted means portal acceptance under the verified contract, never delivery.
 return true;
}
function smsFailureDetails(error,{proof,dispatchState}={}){
 let snapshot;try{snapshot=proof?.snapshot?.();}catch{}
 return {error:'APPLICATION_SMS_UNCONFIRMED',reason:typeof error?.code==='string'&&/^(?:APPLICATION_SMS_|PORTAL_SMS_|SUPERVISOR_SMS_)[A-Z_]{1,70}$/.test(error.code)?error.code:'UNCONFIRMED',smsRequest:cleanSmsRequestEvidence(error?.smsRequest||snapshot),smsDispatchState:['not_dispatched','dispatched','uncertain'].includes(dispatchState)?dispatchState:'uncertain'};
}
module.exports={createSmsRequestProof,cleanSmsRequestEvidence,confirmSmsRequest,smsFailureDetails};
