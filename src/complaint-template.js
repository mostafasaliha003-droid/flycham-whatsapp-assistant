'use strict';
// Approval is external state, not implied by a configured template name.
function createComplaintTemplateGate({env=process.env,fetchImpl=(...a)=>fetch(...a),now=Date.now}={}){
 let until=0,ready=false,pending=null,state='not_configured';
 async function check(){
  const name=env.SAUDI_VISA_COMPLAINT_TEMPLATE,waba=env.SAUDI_VISA_WABA_ID,token=env.WHATSAPP_ACCESS_TOKEN,language=env.SAUDI_VISA_COMPLAINT_TEMPLATE_LANGUAGE||'ar',version=env.WHATSAPP_GRAPH_API_VERSION||'v23.0';
  if(!/^[a-z0-9_]{1,100}$/.test(name||'')||!/^\d{5,30}$/.test(waba||'')||!token)return false;
  try{
   const response=await fetchImpl('https://graph.facebook.com/'+version+'/'+waba+'/message_templates?name='+encodeURIComponent(name)+'&fields=name,status,language,category,components',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
   if(!response.ok){state='unverified';return false;}const data=await response.json(),t=data.data?.find(t=>t.name===name&&t.language===language);
   if(!t){state='missing';return false;}state=String(t.status||'unverified').toLowerCase();if(t.status!=='APPROVED'||t.category!=='UTILITY')return false;
   const button=t.components?.find(x=>x.type==='BUTTONS')?.buttons?.[0],body=t.components?.find(x=>x.type==='BODY');
   const base=env.RENDER_EXTERNAL_URL||'https://flycham-whatsapp-assistant.onrender.com';
   if(button?.type!=='URL'||button.url!==new URL('/operations?customer={{1}}',base).href||typeof body?.text!=='string'||!body.text.includes('{{1}}')||!body.text.includes('{{2}}')||body.text.includes('{{3}}')){state='schema_mismatch';return false;}
   return true;
  }catch{state='unverified';return false;}
 }
 const gate=async()=>{if(now()<until)return ready;if(pending)return pending;pending=check().then(ok=>{ready=ok;until=now()+60000;return ok;}).finally(()=>{pending=null;});return pending;};
 gate.status=()=>({state,approved:ready,checked:until>0});return gate;
}
module.exports={createComplaintTemplateGate};
