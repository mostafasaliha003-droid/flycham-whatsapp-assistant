'use strict';
const { randomUUID, timingSafeEqual } = require('node:crypto');

// Bounded pilot queue. Jobs intentionally do not survive a web-process restart.
// The worker only receives trip details, never the WhatsApp recipient number.
class QuoteJobs {
  constructor({now=Date.now,ttl=10*60*1000}={}) {this.now=now;this.ttl=ttl;this.jobs=new Map();this.seen=new Map();this.workerAt=0;}
  prune(){for(const [id,j] of this.jobs)if(j.expires<=this.now())this.jobs.delete(id);for(const [id,t]of this.seen)if(t<=this.now())this.seen.delete(id);}
  ready(){return this.workerAt>0 && this.now()-this.workerAt<20000;}
  acceptMessage(id){this.prune();if(!id || this.seen.has(id))return false;this.seen.set(id,this.now()+this.ttl);return true;}
  enqueue(recipient,request){this.prune();if(!this.ready() || this.jobs.size>=100)throw Error('QUEUE_UNAVAILABLE');const id=randomUUID();this.jobs.set(id,{recipient,request:structuredClone(request),expires:this.now()+this.ttl,state:'pending'});return id;}
  claim(){this.prune();this.workerAt=this.now();for(const [id,j]of this.jobs)if(j.state==='pending'){j.state='claimed';j.lease=randomUUID();return{id,lease:j.lease,request:j.request};}return null;}
  takeResult(id,lease){this.prune();const j=this.jobs.get(id);if(!j || j.state!=='claimed' || lease!==j.lease)return null;j.state='sending';return {recipient:j.recipient};}
  finish(id){this.jobs.delete(id);}
}
function validQueueKey(header,secret){if(!secret || secret.length<32 || typeof header!=='string')return false;const a=Buffer.from(header),b=Buffer.from('Bearer '+secret);return a.length===b.length && timingSafeEqual(a,b);}
module.exports={QuoteJobs,validQueueKey};
