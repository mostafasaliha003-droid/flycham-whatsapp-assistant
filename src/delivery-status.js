'use strict';
const crypto=require('node:crypto');
const STATES=new Set(['sent','delivered','read','failed']);
const hash=id=>crypto.createHash('sha256').update(id).digest('hex');
const list=value=>Array.isArray(value)?value:[];
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=8640000000000000;

// Persist signed webhook status events, logging only fixed labels and bounded
// numeric error codes. IDs, recipient details and supplier prose stay private.
function recordDeliveryStatuses(payload,store,{log=console}={}){
 for(const entry of list(payload?.entry))for(const change of list(entry?.changes))for(const status of list(change?.value?.statuses)){
  if(typeof status?.id!=='string'||!status.id||!STATES.has(status.status))continue;
  store.delivery(status.id,status.status);
  const codes=status.status==='failed'?[...new Set(list(status.errors).map(error=>error?.code).filter(code=>Number.isSafeInteger(code)&&code>=0&&code<10000000))].slice(0,5):[];
  log.log('WHATSAPP_DELIVERY_STATE_'+status.status.toUpperCase()+codes.map(code=>'_CODE_'+code).join(''));
 }
}

function comparisonDeliverySummary(store,{now=Date.now(),windowMs=900000}={}){
 const duration=typeof windowMs==='number'&&Number.isFinite(windowMs)&&windowMs>0?windowMs:900000;
 const result={windowMinutes:duration/60000,messages:0,states:{sent:0,delivered:0,read:0,failed:0},latest:null};
 if(!validTime(now))return result;
 const comparisonIds=new Set();
 for(const customer of Object.values(store?.data?.customers||{}))for(const id of Object.keys(customer?.offerMessages||{}))if(id)comparisonIds.add(hash(id));
 const observed=new Map(),cutoff=now-duration;
 // A callback may arrive out of order. Read/delivered are positive evidence
 // that a later sent/failed callback cannot erase. Without delivery evidence,
 // failed takes precedence over sent so a known failure remains visible.
 const priority={sent:1,failed:2,delivered:3,read:4};
 for(const event of list(store?.data?.deliveries)){
  if(!event||!comparisonIds.has(event.id)||!STATES.has(event.state)||!validTime(event.at)||event.at<cutoff||event.at>now)continue;
  const prior=observed.get(event.id);
  if(!prior||priority[event.state]>priority[prior.state]||event.state===prior.state&&event.at>prior.at)observed.set(event.id,{state:event.state,at:event.at});
 }
 for(const evidence of observed.values()){
  result.messages++;result.states[evidence.state]++;
  if(!result.latest||evidence.at>result.latest.at)result.latest=evidence;
 }
 if(result.latest)result.latest={state:result.latest.state,atISO:new Date(result.latest.at).toISOString()};
 return result;
}
module.exports={recordDeliveryStatuses,comparisonDeliverySummary};
