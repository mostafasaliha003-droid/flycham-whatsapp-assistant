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

  const { WHATSAPP_ACCESS_TOKEN: token, WHATSAPP_PHONE_NUMBER_ID: phoneId } = env;
  const version = env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  if (!token || !phoneId) throw new Error('WhatsApp Graph API credentials are missing');

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } })
  });
  if (!response.ok) {
    let payload;try{payload=await response.json();}catch{}
    const code=safeGraphFailure(response.status,payload);console.error(code);throw new Error(code);
  }
  return response.json();
}

module.exports = { sendTextMessage,checkWhatsAppConnection,safeGraphFailure };
