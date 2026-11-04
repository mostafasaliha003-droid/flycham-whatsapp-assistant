'use strict';
const {airportSearchPlan}=require('./airport-comparison');
const { randomUUID, timingSafeEqual,createHash } = require('node:crypto');
const {expandLiveRequests}=require('./live-quote');
const {PROVIDERS,NEGATIVE,offerKey,verifiedOffer,nearbyRequests,completionStatus,renderComparison}=require('./quote-comparison');

const sameRoute=(a,b)=>a.origin===b.origin&&a.destination===b.destination;
// Bounded pilot queue, persisted through the encrypted state store when configured.
// The worker only receives trip details, never the WhatsApp recipient number.
class QuoteJobs {
  constructor({now=()=>Date.now(),ttl=60*60*1000,store=null,comparisonTimeoutMs=8*60*1000}={}) {this.now=now;this.ttl=ttl;this.store=store;this.comparisonTimeoutMs=comparisonTimeoutMs;this.jobs=new Map(store?.data?.quoteQueue?.jobs||[]);this.seen=new Map(store?.data?.quoteQueue?.seen||[]);this.comparisons=new Map(store?.data?.quoteQueue?.comparisons||[]);this.revisions=new Map(store?.data?.quoteQueue?.revisions||[]);this.workerAt=0;this.providerAt=new Map();for(const j of this.jobs.values()){j.state='pending';delete j.lease;delete j.progress;}this.prune();}
  save(){if(this.store){this.store.data.quoteQueue={jobs:[...this.jobs],seen:[...this.seen].slice(-3000),comparisons:[...this.comparisons],revisions:[...this.revisions].slice(-3000)};this.store.save();}}
  prune(){for(const [id,j] of this.jobs)if(j.expires<=this.now())this.jobs.delete(id);for(const [id,t]of this.seen)if(t<=this.now())this.seen.delete(id);for(const [id,c]of this.comparisons)if(c.expires<=this.now())this.comparisons.delete(id);}
  ready(provider='airarabia'){const at=provider==='airarabia'?this.workerAt:this.providerAt.get(provider)||0;const age=this.now()-at;return at>0&&(age<20000||(age<120000&&[...this.jobs.values()].some(j=>j.state==='claimed'&&(j.request.provider||'airarabia')===provider)));}
  acceptMessage(id){this.prune();if(!id || this.seen.has(id))return false;this.seen.set(id,this.now()+this.ttl);return true;}
  enqueue(recipient,request){
    this.prune();
    const previous=[...this.jobs.entries()].filter(([,j])=>j.recipient===recipient&&['pending','claimed'].includes(j.state));
    if(!['airarabia','flycham'].includes(request.provider||'airarabia'))throw Error('QUEUE_PROVIDER_INVALID');
    if((!this.ready(request.provider||'airarabia')&&!previous.some(([,j])=>(j.request.provider||'airarabia')===(request.provider||'airarabia')))||this.jobs.size>=300)throw Error('QUEUE_UNAVAILABLE');
    this.cancel(recipient);
    const id=randomUUID();this.jobs.set(id,{recipient,request:structuredClone(request),expires:this.now()+this.ttl,state:'pending'});this.save();return id;
  }
  cancel(recipient){for(const [id,j]of this.jobs)if(j.recipient===recipient)this.jobs.delete(id);for(const [id,c]of this.comparisons)if(c.recipient===recipient)this.comparisons.delete(id);this.revisions.set(recipient,(this.revisions.get(recipient)||0)+1);this.save();}
  enqueueComparison(recipient,request,{providers=PROVIDERS,seedOffers=[],allowAlternatives=true,compareFlyChamAirports=false,waitForProviders=false}={}){
    this.prune();providers=[...new Set(providers)];if(!providers.length||providers.some(p=>!PROVIDERS.includes(p)))throw Error('QUEUE_PROVIDER_INVALID');
    const plan=compareFlyChamAirports?airportSearchPlan(request,providers):{requests:providers.map(provider=>({provider,request:{...structuredClone(request),provider},phase:'exact'})),routing:{}};
    const needed=plan.requests.reduce((n,r)=>n+expandLiveRequests(r.request,this.now()).length,0);
    if(compareFlyChamAirports)providers.sort((a,b)=>Number(b==='flycham')-Number(a==='flycham'));
    const own=[...this.jobs.values()].filter(j=>j.recipient===recipient).length;
    const ownComparisons=[...this.comparisons.values()].filter(c=>c.recipient===recipient).length;
    if(this.jobs.size-own+needed>300||this.comparisons.size-ownComparisons>=100)throw Error('QUEUE_UNAVAILABLE');
    this.cancel(recipient);
    const id=randomUUID(),revision=this.revisions.get(recipient),parent={id,recipient,revision,request:structuredClone(request),providers,children:[],phase:'exact',createdAt:this.now(),deadline:this.now()+this.comparisonTimeoutMs,expires:this.now()+this.ttl,allowAlternatives,compareFlyChamAirports,waitForProviders,version:0,nextReference:1,deliveredVersion:-1,delivered:false};
    this.comparisons.set(id,parent);
    parent.airportRouting=plan.routing;
    if(plan.requests.some(r=>r.phase==='airports'))parent.deadline=this.now()+Math.max(this.comparisonTimeoutMs,20*60*1000);
    // Interleave dates across airports: a monthly scan must not finish every
    // day at one airport before it checks the next airport's first day.
    const routes=plan.requests.sort((a,b)=>Number(b.provider==='flycham')-Number(a.provider==='flycham')).map(item=>({...item,dates:expandLiveRequests(item.request,this.now())}));
    for(let day=0;day<Math.max(...routes.map(r=>r.dates.length));day++)for(const route of routes){
      const date=route.dates[day];if(!date)continue;
      const provider=route.provider,r={...structuredClone(date),provider},seeds=seedOffers.filter(o=>Number.isFinite(o.checkedAt)&&o.checkedAt<=this.now()&&this.now()-o.checkedAt<=15*60*1000).map(o=>verifiedOffer(o,r,provider)).filter(Boolean);
      this.addComparisonChild(parent,r,route.phase,0,seeds);
    }
    this.advanceComparison(parent);this.save();return this.comparisonResult(id);
  }
  addComparisonChild(parent,request,phase,delta=0,seeds=[]){
    const id=randomUUID(),provider=request.provider,child={id,provider,phase,delta,request,status:'pending',offers:[]};parent.children.push(child);
    if(seeds.length){for(const o of new Map(seeds.map(o=>[offerKey(o),o])).values())if(this.canAddComparisonOffer(parent,provider))child.offers.push({...o,reference:parent.nextReference++});child.status=child.offers.length?'partial':'unverified';return child;}
    if((!parent.waitForProviders&&!this.ready(provider))||this.jobs.size>=300){child.status='unverified';return child;}
    this.jobs.set(id,{recipient:parent.recipient,request:structuredClone(request),expires:parent.expires,state:'pending',comparisonId:parent.id,revision:parent.revision,comparisonPhase:phase});return child;
  }
  canAddComparisonOffer(parent,provider){const all=parent.children.flatMap(c=>c.offers);return all.length<80&&all.filter(o=>o.provider===provider).length<(parent.providers.length>1?40:80);}
  comparisonProgress(id,lease,metadata={}){
    const j=this.jobs.get(id);if(!j?.comparisonId||!this.current(id,lease))return false;
    const parent=this.comparisons.get(j.comparisonId);if(!parent||!this.isComparisonCurrent(parent.id))return false;
    parent.lastProgressAt=this.now();const child=parent.children.find(c=>c.id===id),offer=verifiedOffer(metadata.offer,j.request,j.request.provider);
    if(offer&&!child.offers.some(o=>offerKey(o)===offerKey(offer))&&this.canAddComparisonOffer(parent,j.request.provider)){child.offers.push({...offer,reference:parent.nextReference++});parent.version++;}
    if(Array.isArray(metadata.coverage))child.coverage=metadata.coverage.map(c=>({date:c.date,status:c.status})).slice(0,32);
    this.save();return true;
  }
  completeComparisonChild(id,lease,data={}){
    const j=this.jobs.get(id);if(!j?.comparisonId||!this.current(id,lease))return {accepted:false};
    const parent=this.comparisons.get(j.comparisonId);if(!parent||!this.isComparisonCurrent(parent.id))return {accepted:false};
    parent.lastProgressAt=this.now();const child=parent.children.find(c=>c.id===id);child.status=completionStatus(data,child.offers,child.request);child.coverage=Array.isArray(data.coverage)?data.coverage.map(c=>({date:c.date,status:c.status})).slice(0,32):[];
    // Airport selection happens before date search. One failed route lookup must
    // not be repeated for every day in the same monthly comparison.
    if(data.status==='airport_unconfirmed'&&!child.offers.length){
      child.failureReason='airport_selection_unconfirmed';
      for(const sibling of parent.children){
        if(sibling.provider===child.provider&&sameRoute(sibling.request,child.request)&&sibling.status==='pending'&&!sibling.offers.length){
          sibling.status='unverified';sibling.failureReason='airport_selection_unconfirmed';this.jobs.delete(sibling.id);
        }
      }
    }
    this.jobs.delete(id);this.advanceComparison(parent);this.save();return {accepted:true,...this.comparisonResult(parent.id)};
  }
  advanceComparison(parent){
    if(parent.allowAlternatives&&!parent.request.departureRange){
      for(const provider of parent.providers){
        const exact=parent.children.filter(c=>c.provider===provider&&['exact','airports'].includes(c.phase));
        // Each supplier progresses independently. Search both adjacent days
        // first, then widen only when that supplier has no verified alternative.
        if(exact.some(c=>c.status==='pending')||!exact.some(c=>NEGATIVE.has(c.status)))continue;
        const alternatives=parent.children.filter(c=>c.provider===provider&&c.phase==='alternatives');
        if(alternatives.some(c=>c.status==='pending'||c.offers.length||c.status==='auth_required'||c.failureReason==='airport_selection_unconfirmed'))continue;
        const tried=new Set(alternatives.map(c=>c.request.departureDate));
        const remaining=nearbyRequests(exact.find(c=>NEGATIVE.has(c.status)).request,this.now()).filter(n=>!tried.has(n.request.departureDate));
        const distance=remaining.length?Math.min(...remaining.map(n=>Math.abs(n.delta))):null;
        for(const near of remaining.filter(n=>Math.abs(n.delta)===distance))this.addComparisonChild(parent,near.request,'alternatives',near.delta);
      }
    }
    parent.phase=parent.children.some(c=>c.phase==='alternatives'&&c.status==='pending')?'alternatives':parent.children.some(c=>c.status==='pending')?'exact':'done';
    parent.version++;
  }
  isComparisonCurrent(id,version){const c=this.comparisons.get(id);return Boolean(c&&c.expires>this.now()&&this.revisions.get(c.recipient)===c.revision&&!c.delivered&&(version===undefined||version===c.version));}
  comparisonResult(id){
    const c=this.comparisons.get(id);if(!c||!this.isComparisonCurrent(id))return null;
    const pending=c.children.filter(x=>x.status==='pending').map(x=>({provider:x.provider,phase:x.phase,date:x.request.departureDate}));
    const offers=c.children.flatMap(x=>x.offers).map(o=>structuredClone(o));const fingerprint=createHash('sha256').update(JSON.stringify(offers.map(o=>[offerKey(o),o.price.sellingTotal]))).digest('hex');
    return {id:c.id,comparisonId:c.id,revision:c.revision,version:c.version,recipient:c.recipient,request:structuredClone(c.request),ready:!pending.length,phase:c.phase,pending,reply:renderComparison(c,{excludeOfferKeys:c.deliveredOfferKeys||[]}),offers,hasVerifiedOffers:offers.length>0,deliveryFingerprint:fingerprint,partialAlreadyDelivered:c.lastPartialFingerprint===fingerprint,statuses:c.children.map(x=>({provider:x.provider,date:x.request.departureDate,phase:x.phase,status:x.status}))};
  }
  acknowledgeDelivery(id,{final=false,offerKeys=[],fingerprint}={}){
    const c=this.comparisons.get(id);if(!c)return false;
    c.deliveredOfferKeys=[...new Set([...(c.deliveredOfferKeys||[]),...offerKeys])];
    if(!final){c.lastPartialAt=this.now();c.lastPartialFingerprint=fingerprint;this.save();return true;}
    if(c.children.some(x=>x.status==='pending')){this.save();return false;}
    c.delivered=true;this.comparisons.delete(id);this.save();return true;
  }
  markComparisonDelivered(id,options={}){
    if(typeof options==='number')options={version:options};
    const c=this.comparisons.get(id);if(!c||!this.isComparisonCurrent(id,options.version))return false;
    if(options.final===false){const snapshot=this.comparisonResult(id),fingerprint=options.fingerprint||snapshot.deliveryFingerprint;if(!snapshot.hasVerifiedOffers||c.lastPartialFingerprint||fingerprint!==snapshot.deliveryFingerprint)return false;c.lastPartialFingerprint=fingerprint;c.deliveredOfferKeys=snapshot.offers.map(offerKey);this.save();return true;}
    if(c.children.some(x=>x.status==='pending'))return false;c.delivered=true;c.deliveredVersion=c.version;this.comparisons.delete(id);this.save();return true;
  }
  dueComparisons(){
    const due=[];
    for(const c of this.comparisons.values()){
      if(!this.isComparisonCurrent(c.id)||c.deadline>this.now()||c.timeoutReported)continue;
      for(const child of c.children)if(child.status==='pending'){child.status=child.offers.length?'partial':'unverified';this.jobs.delete(child.id);}
      c.phase='done';c.timeoutReported=true;c.version++;const result=this.comparisonResult(c.id);if(result)due.push(result);
    }
    if(due.length)this.save();return due;
  }
  current(id,lease){this.prune();const j=this.jobs.get(id);const valid=Boolean(j&&j.state==='claimed'&&j.lease===lease);if(valid){const provider=j.request.provider||'airarabia';this.providerAt.set(provider,this.now());if(provider==='airarabia')this.workerAt=this.now();}return valid;}
  claim(provider='airarabia'){if(!['airarabia','flycham'].includes(provider))throw Error('QUEUE_PROVIDER_INVALID');this.prune();this.providerAt.set(provider,this.now());if(provider==='airarabia')this.workerAt=this.now();for(const [id,j]of this.jobs)if(j.state==='pending'&&(j.request.provider||'airarabia')===provider){const parent=this.comparisons.get(j.comparisonId);if(provider==='airarabia'&&parent?.compareFlyChamAirports&&this.now()-parent.createdAt<15000){const fly=parent.children.filter(c=>c.provider==='flycham');if(fly.length&&fly.every(c=>c.status==='pending'))continue;}j.state='claimed';j.lease=randomUUID();this.save();return{id,lease:j.lease,request:j.request};}return null;}
  takeResult(id,lease){this.prune();const j=this.jobs.get(id);if(!j || j.state!=='claimed' || lease!==j.lease)return null;j.state='sending';return {recipient:j.recipient};}
  takeProgress(id,lease,seq){this.prune();const j=this.jobs.get(id);if(!j||j.state!=='claimed'||lease!==j.lease||!Number.isInteger(seq)||seq!==(j.progress||0)+1)return null;j.progress=seq;return{recipient:j.recipient};}
  finish(id){this.jobs.delete(id);this.save();}
}
function validQueueKey(header,secret){if(!secret || secret.length<32 || typeof header!=='string')return false;const a=Buffer.from(header),b=Buffer.from('Bearer '+secret);return a.length===b.length && timingSafeEqual(a,b);}
module.exports={QuoteJobs,validQueueKey};

