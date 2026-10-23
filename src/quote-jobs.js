'use strict';
const { randomUUID, timingSafeEqual } = require('node:crypto');

// Bounded pilot queue. Jobs intentionally do not survive a web-process restart.
// The worker only receives trip details, never the WhatsApp recipient number.
class QuoteJobs {
  constructor({now=Date.now,ttl=60*60*1000,store=null}={}) {this.now=now;this.ttl=ttl;this.store=store;this.jobs=new Map(store?.data?.quoteQueue?.jobs||[]);this.seen=new Map(store?.data?.quoteQueue?.seen||[]);this.workerAt=0;this.providerAt=new Map();for(const j of this.jobs.values()){j.state='pending';delete j.lease;delete j.progress;}this.prune();}
  save(){if(this.store){this.store.data.quoteQueue={jobs:[...this.jobs],seen:[...this.seen].slice(-3000)};this.store.save();}}
  prune(){for(const [id,j] of this.jobs)if(j.expires<=this.now())this.jobs.delete(id);for(const [id,t]of this.seen)if(t<=this.now())this.seen.delete(id);}
  ready(provider='airarabia'){const at=provider==='airarabia'?this.workerAt:this.providerAt.get(provider)||0;const age=this.now()-at;return at>0&&(age<20000||(age<120000&&[...this.jobs.values()].some(j=>j.state==='claimed'&&(j.request.provider||'airarabia')===provider)));}
  acceptMessage(id){this.prune();if(!id || this.seen.has(id))return false;this.seen.set(id,this.now()+this.ttl);return true;}
  enqueue(recipient,request){
    this.prune();
    const previous=[...this.jobs.entries()].filter(([,j])=>j.recipient===recipient&&['pending','claimed'].includes(j.state));
    if(!['airarabia','flycham'].includes(request.provider||'airarabia'))throw Error('QUEUE_PROVIDER_INVALID');
    if((!this.ready(request.provider||'airarabia')&&!previous.some(([,j])=>(j.request.provider||'airarabia')===(request.provider||'airarabia')))||this.jobs.size>=100)throw Error('QUEUE_UNAVAILABLE');
    for(const [id]of previous)this.jobs.delete(id);
    const id=randomUUID();this.jobs.set(id,{recipient,request:structuredClone(request),expires:this.now()+this.ttl,state:'pending'});this.save();return id;
  }
  cancel(recipient){for(const [id,j]of this.jobs)if(j.recipient===recipient)this.jobs.delete(id);this.save();}
  current(id,lease){this.prune();const j=this.jobs.get(id);const valid=Boolean(j&&j.state==='claimed'&&j.lease===lease);if(valid){const provider=j.request.provider||'airarabia';this.providerAt.set(provider,this.now());if(provider==='airarabia')this.workerAt=this.now();}return valid;}
  claim(provider='airarabia'){if(!['airarabia','flycham'].includes(provider))throw Error('QUEUE_PROVIDER_INVALID');this.prune();this.providerAt.set(provider,this.now());if(provider==='airarabia')this.workerAt=this.now();for(const [id,j]of this.jobs)if(j.state==='pending'&&(j.request.provider||'airarabia')===provider){j.state='claimed';j.lease=randomUUID();this.save();return{id,lease:j.lease,request:j.request};}return null;}
  takeResult(id,lease){this.prune();const j=this.jobs.get(id);if(!j || j.state!=='claimed' || lease!==j.lease)return null;j.state='sending';return {recipient:j.recipient};}
  takeProgress(id,lease,seq){this.prune();const j=this.jobs.get(id);if(!j||j.state!=='claimed'||lease!==j.lease||!Number.isInteger(seq)||seq!==(j.progress||0)+1)return null;j.progress=seq;return{recipient:j.recipient};}
  finish(id){this.jobs.delete(id);this.save();}
}
function validQueueKey(header,secret){if(!secret || secret.length<32 || typeof header!=='string')return false;const a=Buffer.from(header),b=Buffer.from('Bearer '+secret);return a.length===b.length && timingSafeEqual(a,b);}
module.exports={QuoteJobs,validQueueKey};
