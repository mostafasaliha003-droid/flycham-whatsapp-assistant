'use strict';
function startQuotePolling(session,{env=process.env,fetchImpl=fetch,log=console}={}){
  const url=env.AIR_ARABIA_QUOTE_QUEUE_URL,secret=env.AIR_ARABIA_QUOTE_QUEUE_KEY;
  if(!url || !secret || secret.length<32 || new URL(url).origin!=='https://flycham-whatsapp-assistant.onrender.com')throw Error('QUEUE_CONFIG_INVALID');
  let stopped=false,timer,inFlight=Promise.resolve();
  async function call(path,body){const r=await fetchImpl(url+path,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('QUEUE_HTTP_ERROR');return r.json();}
  async function poll(){
    try{
      const job=await call('/claim',{});
      if(job?.id){
        log.log('PORTAL_CUSTOMER_QUOTE_STARTED');
        let reply;
        let seq=0;
        try{reply=await session.run(p=>p.runCustomerQuote(job.request,reply=>call('/progress',{id:job.id,lease:job.lease,seq:++seq,reply})));log.log('PORTAL_CUSTOMER_QUOTE_PRICED');}
        catch{reply='تعذر التحقق من السعر لهذا الطلب حاليًا. يرجى مراجعة موظف المبيعات؛ لم يتم إجراء أي حجز.';log.log('PORTAL_CUSTOMER_QUOTE_UNCONFIRMED');}
        // One completion attempt: never duplicate a WhatsApp reply after an
        // ambiguous network failure. The server consumes each lease once.
        await call('/complete',{id:job.id,lease:job.lease,reply});
        log.log('PORTAL_CUSTOMER_QUOTE_REPLY_SUBMITTED');
      }
    }catch{log.log('PORTAL_QUOTE_QUEUE_UNAVAILABLE');}
    finally{if(!stopped)timer=setTimeout(tick,3000);}
  }
  const tick=()=>{if(!stopped)inFlight=poll();};tick();
  return async()=>{stopped=true;clearTimeout(timer);await inFlight;};
}
module.exports={startQuotePolling};
