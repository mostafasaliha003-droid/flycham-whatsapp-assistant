'use strict';
const {accountantAccess}=require('./visa-fulfilment-http');
const {createVisaTemplateGate,visaTemplateConfig,visaTemplateRequest}=require('./visa-whatsapp');
const {spawnSync}=require('node:child_process');
function createVisaSetup({env=process.env,fetchImpl=fetch,workerConfigured=()=>false}){
 const gate=createVisaTemplateGate({env,fetchImpl});
 return async(request,response,url)=>{
  if(!['/internal/assistant/visa-portal/health','/internal/assistant/visa-portal/otp-template'].includes(url.pathname))return false;
  const reply=(code,value)=>response.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value));
  if(url.pathname.endsWith('/health')&&request.method==='GET'){await gate();const pdfToolsReady=['pdfinfo','pdftoppm'].every(command=>{const result=spawnSync(command,['-v'],{timeout:2000,stdio:'pipe',maxBuffer:4096});return result.status===0;});reply(200,{workflowEnabled:env.RAAD_VISA_AUTOMATION_ENABLED==='true',workerConfigured:workerConfigured(),accountantConfigured:Boolean(env.RAAD_ACCOUNTANT_KEY?.length>=32),otpOwnerConfigured:Boolean(env.RAAD_OTP_OWNER_WHATSAPP),pdfToolsReady,template:gate.status()});return true;}
  if(request.method!=='POST'||!accountantAccess(request,env)){reply(403,{error:'SETUP_AUTHORITY_REQUIRED'});return true;}
  const config=visaTemplateConfig(env);await gate();const status=gate.status();
  if(status.state!=='missing'){reply(200,{created:false,template:status});return true;}
  if(!/^\d{5,30}$/.test(config.wabaId)||!env.WHATSAPP_ACCESS_TOKEN){reply(503,{error:'TEMPLATE_CONFIG_REQUIRED'});return true;}
  try{const result=await fetchImpl('https://graph.facebook.com/'+config.version+'/'+config.wabaId+'/message_templates',{method:'POST',headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(visaTemplateRequest(config)),signal:AbortSignal.timeout(15000)});let body;try{body=await result.json();}catch{}if(!result.ok){reply(502,{error:'TEMPLATE_REQUEST_REJECTED',providerCode:Number.isSafeInteger(body?.error?.code)?body.error.code:null});return true;}reply(200,{created:true,template:{state:String(body?.status||'PENDING').toLowerCase(),approved:body?.status==='APPROVED'}});}catch{reply(503,{error:'TEMPLATE_REQUEST_UNCERTAIN'});}return true;
 };
}
module.exports={createVisaSetup};
