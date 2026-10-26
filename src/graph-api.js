'use strict';

function safeGraphFailure(status,payload){
 const number=n=>Number.isSafeInteger(n)&&n>=0&&n<10000000?n:0;
 return `WHATSAPP_GRAPH_HTTP_${number(status)}_CODE_${number(payload?.error?.code)}_SUBCODE_${number(payload?.error?.error_subcode)}`;
}
async function checkWhatsAppConnection(env=process.env){
 if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return 'WHATSAPP_CONNECTION_DRY_RUN';
 if(!env.WHATSAPP_ACCESS_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID)return 'WHATSAPP_CONNECTION_CONFIG_MISSING';
 try{
  const r=await fetch(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION||'v23.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=id`,{headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`},signal:AbortSignal.timeout(15000)});
  if(r.ok)return 'WHATSAPP_CONNECTION_READ_OK';
  let data;try{data=await r.json();}catch{}
  return safeGraphFailure(r.status,data);
 }catch{return 'WHATSAPP_CONNECTION_NETWORK_FAILED';}
}
async function sendTextMessage(to, body, env = process.env) {
  const dryRun = String(env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  if (dryRun) {
    console.log(`[DRY_RUN] Suppressed WhatsApp reply for recipient ending in ${String(to).slice(-4)} (${body.length} characters)`);
    return { dryRun: true };
  }

  return sendGraphMessage({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } },env);
}

async function sendGraphMessage(message,env,fetchImpl=fetch){
  const { WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneId } = env;
  const version = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  if (!token || !phoneId) throw new Error('WhatsApp Graph API credentials are missing');

  const response = await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    let payload;try{payload=await response.json();}catch{}
    const code=safeGraphFailure(response.status,payload);console.error(code);throw new Error(code);
  }
  return response.json();
}

async function sendRequestChoiceMessage(to,{text,choiceId}={},env=process.env){
 if(typeof text!=='string'||!text.trim()||text.length>1024||typeof choiceId!=='string'||!/^[a-f0-9-]{36}$/.test(choiceId))throw Error('WHATSAPP_REQUEST_CHOICE_INVALID');
 if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return {dryRun:true};
 return sendGraphMessage({messaging_product:'whatsapp',recipient_type:'individual',to,type:'interactive',interactive:{type:'button',body:{text},action:{buttons:[
  {type:'reply',reply:{id:'request_continue:'+choiceId,title:'متابعة طلبي الحالي'}},
  {type:'reply',reply:{id:'request_new:'+choiceId,title:'طلب جديد مختلف'}}
 ]}}},env);
}

async function sendImageMessage(to,png,caption,env=process.env){
 if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return {dryRun:true};
 if(!env.WHATSAPP_ACCESS_TOKEN||!env.WHATSAPP_PHONE_NUMBER_ID)throw Error('VOUCHER_DELIVERY_UNAVAILABLE');
 const base='https://graph.facebook.com/'+(env.WHATSAPP_GRAPH_API_VERSION||'v23.0')+'/'+env.WHATSAPP_PHONE_NUMBER_ID;
 const headers={Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN},body=new FormData();body.set('messaging_product','whatsapp');body.set('type','image/png');body.set('file',new Blob([png],{type:'image/png'}),'remal-voucher.png');
 const upload=await fetch(base+'/media',{method:'POST',headers,body,signal:AbortSignal.timeout(30000)});if(!upload.ok)throw Error('VOUCHER_DELIVERY_UNAVAILABLE');const media=await upload.json();if(typeof media.id!=='string')throw Error('VOUCHER_DELIVERY_UNAVAILABLE');
 const response=await fetch(base+'/messages',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,type:'image',image:{id:media.id,caption}}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('VOUCHER_DELIVERY_UNAVAILABLE');return response.json();
}
function whatsappNumber(value){
 if(typeof value!=='string'||!/^\+?[1-9]\d{7,14}$/.test(value))throw Error('WHATSAPP_RECIPIENT_INVALID');
 return value.replace(/^\+/,'');
}
function graphCredentials(env){
 const token=env.WHATSAPP_ACCESS_TOKEN,phoneId=env.WHATSAPP_PHONE_NUMBER_ID,version=env.WHATSAPP_GRAPH_API_VERSION||'v23.0';
 if(!token||typeof phoneId!=='string'||!/^\d{5,30}$/.test(phoneId)||!/^v\d{1,3}\.\d{1,2}$/.test(version))throw Error('WHATSAPP_GRAPH_CONFIG_MISSING');
 return{token,phoneId,version};
}
// Meta reports each requested target independently, including partial failures
// in HTTP 200 responses. Never equate transport success with an applied block.
async function changeWhatsAppBlock(to,{blocked}={},env=process.env,fetchImpl=fetch){
 const recipient=whatsappNumber(to);if(typeof blocked!=='boolean')throw Error('WHATSAPP_BLOCK_INVALID');
 if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return{ok:false,dryRun:true,scope:'whatsapp'};
 const{token,phoneId,version}=graphCredentials(env);
 let response;try{response=await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/block_users`,{
  method:blocked?'POST':'DELETE',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({messaging_product:'whatsapp',block_users:[{user:recipient}]}),signal:AbortSignal.timeout(15000)
 });}catch{throw Error('WHATSAPP_BLOCK_OUTCOME_UNCERTAIN');}
 let data;try{data=await response.json();}catch{throw Error('WHATSAPP_BLOCK_OUTCOME_UNCERTAIN');}
 if(!response.ok)throw Error(safeGraphFailure(response.status,data));
 const matches=u=>u&&[u.wa_id,u.input].some(v=>typeof v==='string'&&v.replace(/^\+/,'')===recipient);
 const result=data?.block_users,success=result?.[blocked?'added_users':'removed_users'];
 if(data?.error||data?.errors||Array.isArray(result?.failed_users)&&result.failed_users.some(matches))throw Error('WHATSAPP_BLOCK_REJECTED');
 if(data?.messaging_product!=='whatsapp'||!Array.isArray(success)||!success.some(u=>typeof u?.wa_id==='string'&&u.wa_id.replace(/^\+/,'')===recipient&&(!u.input||typeof u.input==='string'&&u.input.replace(/^\+/,'')===recipient)))throw Error('WHATSAPP_BLOCK_UNCONFIRMED');
 return{ok:true,blocked,scope:'whatsapp'};
}
// Outside the owner's service window this requires an approved utility
// template: body {{1}}=case ID, {{2}}=customer number; URL button index 0 has
// https://<our-host>/operations?customer={{1}}, with customer as its parameter.
// This function never creates templates, guesses their approval, or retries an
// ambiguous send. The complaint outbox records actual delivery acceptance.
async function sendComplaintNotification(to,{text,url,caseId,customer,useTemplate=false,templateName,language}={},env=process.env,fetchImpl=fetch){
 const recipient=whatsappNumber(to),customerNumber=whatsappNumber(customer);
 if(typeof caseId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(caseId))throw Error('WHATSAPP_COMPLAINT_INVALID');
 let target;try{target=new URL(url);}catch{throw Error('WHATSAPP_COMPLAINT_URL_INVALID');}
 if(target.protocol!=='https:'||target.username||target.password||target.pathname!=='/operations'||target.searchParams.get('customer')!==customerNumber||[...target.searchParams.keys()].some(k=>k!=='customer')||target.hash)throw Error('WHATSAPP_COMPLAINT_URL_INVALID');
 let message;
 if(useTemplate){
  const name=templateName||env.SAUDI_VISA_COMPLAINT_TEMPLATE,code=language||env.SAUDI_VISA_COMPLAINT_TEMPLATE_LANGUAGE||'ar';
  if(typeof name!=='string'||!/^[a-z0-9_]{1,100}$/.test(name))throw Error('WHATSAPP_COMPLAINT_TEMPLATE_REQUIRED');
  if(typeof code!=='string'||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(code))throw Error('WHATSAPP_COMPLAINT_INVALID');
  message={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'template',template:{name,language:{code},components:[
   {type:'body',parameters:[{type:'text',text:caseId},{type:'text',text:customerNumber}]},
   {type:'button',sub_type:'url',index:'0',parameters:[{type:'text',text:customerNumber}]}
  ]}};
 }else{
  if(typeof text!=='string'||!text.trim()||text.length>3000)throw Error('WHATSAPP_COMPLAINT_INVALID');
  message={messaging_product:'whatsapp',recipient_type:'individual',to:recipient,type:'text',text:{preview_url:false,body:text.trim()+'\n\n'+target.toString()}};
 }
 if(String(env.DRY_RUN??'true').toLowerCase()!=='false')return{dryRun:true};
 graphCredentials(env);
 let data;try{data=await sendGraphMessage(message,env,fetchImpl);}catch(error){
  if(/^WHATSAPP_GRAPH_HTTP_\d+_CODE_\d+_SUBCODE_\d+$/.test(error?.message||''))throw error;
  throw Error('WHATSAPP_COMPLAINT_OUTCOME_UNCERTAIN');
 }
 if(typeof data?.messages?.[0]?.id!=='string'||!data.messages[0].id||data.messages[0].id.length>500)throw Error('WHATSAPP_COMPLAINT_OUTCOME_UNCERTAIN');
 return data;
}
module.exports = {sendImageMessage, sendTextMessage,sendRequestChoiceMessage,checkWhatsAppConnection,safeGraphFailure,changeWhatsAppBlock,sendComplaintNotification };
