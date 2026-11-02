'use strict';
const {validQueueKey}=require('./quote-jobs');
function createVisaOperatorHttp({dispatcher,env=process.env,wake=()=>{}}){
 return async(request,response,url,readBody)=>{
  if(!url.pathname.startsWith('/internal/assistant/visa-operator/'))return false;
  const send=(status,value)=>response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(value));
  if(!validQueueKey(request.headers.authorization,env.ASSISTANT_ADMIN_KEY)){send(401,{error:'EMPLOYEE_REQUIRED'});return true;}
  const match=url.pathname.match(/^\/internal\/assistant\/visa-operator\/([a-f0-9-]{36})$/);
  if(!match||url.search){send(404,{error:'NOT_FOUND'});return true;}
  let input;
  try{
   if(request.method==='GET')send(200,await dispatcher.operatorChallenge(match[1]));
   else if(request.method==='POST'){
    const bytes=await readBody(request);if(bytes.length>1000)throw Error('OPERATOR_INPUT_INVALID');
    try{input=JSON.parse(bytes);}catch{throw Error('OPERATOR_INPUT_INVALID');}
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('OPERATOR_INPUT_INVALID');
    if(Object.keys(input).join(',')==='recoverExistingApplication'&&typeof input.recoverExistingApplication==='string'){send(200,await dispatcher.recoverExistingApplication(match[1],input.recoverExistingApplication));wake();}
    else if(Object.keys(input).join(',')==='resumeAfterDiagnostic'&&input.resumeAfterDiagnostic===true){send(200,await dispatcher.resumeAfterSaveDiagnostic(match[1]));wake();}
    else if(Object.keys(input).join(',')==='diagnostic'&&input.diagnostic===true){send(200,await dispatcher.startSaveDiagnostic(match[1]));wake();}
    else if(Object.keys(input).join(',')==='restart'&&input.restart===true){send(200,await dispatcher.restartOperatorLogin(match[1]));wake();}
    else send(200,await dispatcher.operatorChallenge(match[1],input));
   }else send(405,{error:'METHOD_NOT_ALLOWED'});
  }catch{send(409,{error:'OPERATOR_ACTION_UNCONFIRMED'});}
  finally{if(input&&typeof input==='object')input.value='';}
  return true;
 };
}
module.exports={createVisaOperatorHttp};
