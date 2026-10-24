'use strict';
function startQuotePolling(session,{env=process.env,fetchImpl=fetch,log=console,provider='airarabia'}={}){
  const url=env.AIR_ARABIA_QUOTE_QUEUE_URL,secret=env.AIR_ARABIA_QUOTE_QUEUE_KEY;
  if(!url || !secret || secret.length<32 || new URL(url).origin!=='https://flycham-whatsapp-assistant.onrender.com')throw Error('QUEUE_CONFIG_INVALID');
  let stopped=false,timer,inFlight=Promise.resolve();
  async function call(path,body){const r=await fetchImpl(url+path,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('QUEUE_HTTP_ERROR');return r.json();}
  const ready=()=>!session.closed&&!session.authBlocked&&(typeof session.isReady!=='function'||session.isReady());
  const health=()=>typeof session.healthStatus==='function'?session.healthStatus().state:session.authBlocked?'authentication_required':session.closed?'closed':'unverified';
  const publishHealth=()=>call('/heartbeat',{provider,ready:ready(),status:health()});
  const heartbeat=setInterval(()=>{if(!stopped)publishHealth().catch(()=>{});},10000);
  async function poll(){
    let nextPollMs=3000;
    try{
      if(session.authBlocked||session.closed){await publishHealth().catch(()=>{});stopped=true;clearInterval(heartbeat);log.log('PORTAL_QUOTE_AUTHENTICATION_REQUIRED_'+provider.toUpperCase());return;}
      if(!ready()){await publishHealth().catch(()=>{});return;}
      const job=await call('/claim',provider==='airarabia'?{}:{provider});
      if(job?.id){
        log.log(job.catalog?'PORTAL_CATALOG_SEARCH_STARTED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_STARTED');
        let reply,outcome='done',coverage=[],status=null,availabilityEvidence=null;
        let seq=0;
        try{reply=await session.run(p=>p.runCustomerQuote(job.request,(reply,metadata)=>call('/progress',{id:job.id,lease:job.lease,seq:++seq,reply,metadata}),async()=>{const state=await call('/current',{id:job.id,lease:job.lease});if(!state.current)throw Error('QUOTE_SUPERSEDED');}));if(reply&&typeof reply==='object'){outcome=reply.outcome;coverage=reply.coverage||[];status=reply.status||null;availabilityEvidence=reply.availabilityEvidence||null;reply=reply.reply;}log.log(coverage.some(day=>day.confirmed>0)?'PORTAL_CUSTOMER_QUOTE_PRICED':'PORTAL_CUSTOMER_QUOTE_WITHOUT_VERIFIED_OFFER');}
        catch(error){outcome='failed';status=session.authBlocked||/AUTHENTICATION|MANUAL_VERIFICATION|SESSION_UNAVAILABLE|VERIFICATION_REQUIRED/.test(error?.message||'')?'authentication_required':'unverified';reply='تفاصيل طلبك محفوظة، لكن لم يكتمل التحقق من السعر لدى شركة الطيران. لم يتم إجراء حجز، ولا يعني ذلك أن الرحلة ممتلئة.';log.log(job.catalog?'PORTAL_CATALOG_SEARCH_UNCONFIRMED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_UNCONFIRMED');}
        // One completion attempt: never duplicate a WhatsApp reply after an
        // ambiguous network failure. The server consumes each lease once.
        const current=await call('/current',{id:job.id,lease:job.lease});
        if(!current.current){log.log('PORTAL_CUSTOMER_QUOTE_SUPERSEDED');return;}
        await call('/complete',{id:job.id,lease:job.lease,reply,outcome,coverage,status,availabilityEvidence});
        if(job.catalog&&outcome==='failed')nextPollMs=60000;
        log.log(job.catalog?'PORTAL_CATALOG_SEARCH_COMPLETED_'+provider.toUpperCase():'PORTAL_CUSTOMER_QUOTE_REPLY_SUBMITTED');
      }
    }catch{log.log('PORTAL_QUOTE_QUEUE_UNAVAILABLE');}
    finally{if(!stopped)timer=setTimeout(tick,nextPollMs);}
  }
  const tick=()=>{if(!stopped)inFlight=poll();};tick();
  return async()=>{stopped=true;clearTimeout(timer);clearInterval(heartbeat);await inFlight;};
}
module.exports={startQuotePolling};
