'use strict';
const {timingSafeEqual}=require('node:crypto');
const {validCustomer}=require('./conversation-journal');
const {validQueueKey}=require('./quote-jobs');
function accountantAccess(request,env){const expected=env.RAAD_ACCOUNTANT_KEY,supplied=request.headers['x-accountant-key'];if(typeof expected!=='string'||expected.length<32||typeof supplied!=='string')return false;const a=Buffer.from(expected),b=Buffer.from(supplied);return a.length===b.length&&timingSafeEqual(a,b);}
function createVisaFulfilmentHttp({fulfilment,inbox,journal,mediaStore,store,documentIntake,env=process.env,wake=()=>{}}){
 const locks=new Map();
 const capabilities=request=>({accountantConfigured:typeof env.RAAD_ACCOUNTANT_KEY==='string'&&env.RAAD_ACCOUNTANT_KEY.length>=32,accountantReview:accountantAccess(request,env),governmentPayment:false});
 const detail=customer=>{const item=fulfilment.get(customer),c=store.data.visaCases[customer],summary=journal.summary(customer);return {...item,jobs:item.jobs.map(job=>({...job,operatorRestartAvailable:env.RAAD_OPERATOR_CAPTCHA_ENABLED==='true'&&job.state==='portal_review_required'&&((['LOGIN_CAPTCHA_TIMEOUT','OPERATOR_CHALLENGE_EXPIRED','LOGIN_REJECTED','PILOT_UNAVAILABLE'].includes(job.blockedReason)&&store.data.visaPortalRuns?.[job.id]?.lastStage==='login')||(job.blockedReason==='PORTAL_START_UNCERTAIN'&&store.data.visaPortalRuns?.[job.id]?.phase==='cancelled'&&store.data.visaPortalRuns?.[job.id]?.lastStage==='preflight'))&&!job.portalSaved&&!job.applicationReference&&(job.diagnosticOnly===true?(job.diagnosticLoginRestarts||0)<5:(job.operatorManualStarts||0)<2),operatorAvailable:store.data.visaPortalRuns?.[job.id]?.phase==='waiting_operator'&&store.data.visaPortalRuns[job.id].operatorChallenge?.expiresAt>Date.now()})),name:summary?.name||'',applicantCount:c.applicantCount,quote:c.quote,visaCase:c,staffClaimed:inbox.isOperatorOwned(customer),governmentFees:{status:'unpaid'},media:mediaStore.list(customer),...(documentIntake?{documentReview:documentIntake.summary(customer)}:{})};};
 return async function handle(request,response,url,readBody){
  const base='/internal/assistant/visa-workflow';if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false;
  const reply=(status,data)=>response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));
  try{
   if(url.pathname===base&&request.method==='GET'){const items=Object.keys(store.data.visaCases||{}).slice(-200).map(detail);reply(200,{items,capabilities:capabilities(request)});return true;}
   const match=url.pathname.slice(base.length).match(/^\/([^/]+)(?:\/(confirm-payment|reread-document))?$/);if(!match){reply(404,{error:'NOT_FOUND'});return true;}
   const customer=decodeURIComponent(match[1]);if(!validCustomer(customer))throw Object.assign(Error('INVALID_CUSTOMER'),{statusCode:400});inbox.requireCustomer(customer);
   if(!match[2]&&request.method==='GET'){reply(200,{item:detail(customer),capabilities:capabilities(request)});return true;}
   if(match[2]==='reread-document'){
    if(request.method!=='POST'){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
    if(!validQueueKey(request.headers.authorization,env.ASSISTANT_ADMIN_KEY)){reply(403,{error:'EMPLOYEE_REQUIRED'});return true;}
    if(typeof documentIntake?.rereadSource!=='function'){reply(503,{error:'DOCUMENT_REREAD_UNAVAILABLE'});return true;}
    const bytes=await readBody(request);if(bytes.length>1000)throw Object.assign(Error('INVALID_BODY'),{statusCode:400});let body;try{body=JSON.parse(bytes);}catch{throw Object.assign(Error('INVALID_BODY'),{statusCode:400});}
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==4||!['caseId','mediaId','sourceSha256','generation'].every(key=>Object.hasOwn(body,key)))throw Object.assign(Error('INVALID_BODY'),{statusCode:400});
    if(locks.has(customer)){reply(409,{error:'DOCUMENT_REREAD_BUSY'});return true;}
    locks.set(customer,true);try{const result=await documentIntake.rereadSource(customer,body);reply(200,{...result,item:detail(customer),capabilities:capabilities(request)});wake();}finally{locks.delete(customer);}return true;
   }
   if(match[2]!=='confirm-payment'||request.method!=='POST'){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
   if(!accountantAccess(request,env)){reply(403,{error:'ACCOUNTANT_REQUIRED'});return true;}
   const bytes=await readBody(request);if(bytes.length>20000)throw Object.assign(Error('INVALID_BODY'),{statusCode:400});let body;try{body=JSON.parse(bytes);}catch{throw Object.assign(Error('INVALID_BODY'),{statusCode:400});}
   if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(Error('INVALID_BODY'),{statusCode:400});
   if(locks.has(customer)){reply(409,{error:'VISA_PAYMENT_REVIEW_BUSY'});return true;}
   locks.set(customer,true);const wasClaimed=inbox.isOperatorOwned(customer);let approved=false;
   try{
    if(inbox.isBlocked(customer)||inbox.complaints?.active(customer))throw Object.assign(Error('AUTOMATION_PAUSED'),{statusCode:409});
    fulfilment.receiveReceipt(customer,{receiptId:body.receiptMediaId});
    if(!wasClaimed)await inbox.claim(customer);
    const result=fulfilment.confirmPayment(customer,{receiptId:body.receiptMediaId,amount:body.amount,reference:body.reference,actualReceived:body.actualReceived,confirm:body.confirm,expectedCaseSignature:body.expectedCaseSignature,expectedRevision:body.expectedRevision,idempotencyKey:body.idempotencyKey,actor:{id:env.RAAD_ACCOUNTANT_ID||'accountant',role:'accountant'}});approved=true;
    if(!inbox.isBlocked(customer)&&!inbox.complaints?.active(customer))inbox.release(customer);
    reply(200,{...result,item:detail(customer),capabilities:capabilities(request)});wake();
   }finally{if(!approved&&!wasClaimed&&inbox.isOperatorOwned(customer)&&!inbox.complaints?.active(customer))inbox.release(customer);locks.delete(customer);}
  }catch(error){const status=Number(error.statusCode)||409,code=error.code||error.message;reply([400,403,404,409,422,503].includes(status)?status:503,{ok:false,error:/^[A-Z][A-Z0-9_]{2,80}$/.test(code||'')?code:'VISA_WORKFLOW_UNAVAILABLE'});}return true;
 };
}
module.exports={createVisaFulfilmentHttp,accountantAccess};
