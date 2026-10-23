'use strict';
function startQuotePolling(session,{env=process.env,fetchImpl=fetch,log=console,provider='airarabia'}={}){
  const url=env.AIR_ARABIA_QUOTE_QUEUE_URL,secret=env.AIR_ARABIA_QUOTE_QUEUE_KEY;
  if(!url || !secret || secret.length<32 || new URL(url).origin!=='https://flycham-whatsapp-assistant.onrender.com')throw Error('QUEUE_CONFIG_INVALID');
  let stopped=false,timer,inFlight=Promise.resolve();
  async function call(path,body){const r=await fetchImpl(url+path,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('QUEUE_HTTP_ERROR');return r.json();}
  const heartbeat=setInterval(()=>{if(!stopped&&!session.authBlocked)call('/heartbeat',{provider}).catch(()=>{});},10000);
  async function poll(){
    try{
      if(session.authBlocked){stopped=true;clearInterval(heartbeat);log.log('PORTAL_QUOTE_AUTHENTICATION_REQUIRED_'+provider.toUpperCase());return;}
      const job=await call('/claim',provider==='airarabia'?{}:{provider});
      if(job?.id){
        log.log(job.catalog?'PORTAL_CATALOG_SEARCH_STARTED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_STARTED');
        let reply,outcome='done',coverage=[];
        let seq=0;
        try{reply=await session.run(p=>p.runCustomerQuote(job.request,(reply,metadata)=>call('/progress',{id:job.id,lease:job.lease,seq:++seq,reply,metadata}),async()=>{const state=await call('/current',{id:job.id,lease:job.lease});if(!state.current)throw Error('QUOTE_SUPERSEDED');}));if(reply&&typeof reply==='object'){outcome=reply.outcome;coverage=reply.coverage||[];reply=reply.reply;}log.log('PORTAL_CUSTOMER_QUOTE_PRICED');}
        catch{outcome='failed';reply='تعذر التحقق من السعر لهذا الطلب حاليًا. يرجى مراجعة موظف المبيعات؛ لم يتم إجراء أي حجز.';log.log(job.catalog?'PORTAL_CATALOG_SEARCH_UNCONFIRMED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_UNCONFIRMED');}
        // One completion attempt: never duplicate a WhatsApp reply after an
        // ambiguous network failure. The server consumes each lease once.
        const current=await call('/current',{id:job.id,lease:job.lease});
        if(!current.current){log.log('PORTAL_CUSTOMER_QUOTE_SUPERSEDED');return;}
        await call('/complete',{id:job.id,lease:job.lease,reply,outcome,coverage});
        log.log(job.catalog?'PORTAL_CATALOG_SEARCH_COMPLETED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_REPLY_SUBMITTED');
      }
    }catch{log.log('PORTAL_QUOTE_QUEUE_UNAVAILABLE');}
    finally{if(!stopped)timer=setTimeout(tick,3000);}
  }
  const tick=()=>{if(!stopped)inFlight=poll();};tick();
  return async()=>{stopped=true;clearTimeout(timer);clearInterval(heartbeat);await inFlight;};
}
module.exports={startQuotePolling};
