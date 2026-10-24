'use strict';
const {createHash}=require('node:crypto');
const EVENTS=new Set(['qualified','search_queued','first_offer','search_completed','search_failed','selected','handoff','claimed','released','issued','reply_sent','delivery_uncertain']);
function recordMetric(store,{customer,journey,event,now=Date.now()}={}){
 if(!store?.data||!EVENTS.has(event)||typeof customer!=='string'||!customer||typeof journey!=='string'||!journey)return false;
 const subject=createHash('sha256').update(customer+'\0'+journey).digest('hex'),rows=store.data.consultantMetrics||=[];
 if(rows.some(r=>r.subject===subject&&r.event===event))return false;
 rows.push({subject,event,at:now});store.data.consultantMetrics=rows.filter(r=>r.at>=now-30*86400000).slice(-10000);store.save();return true;
}
function metricsSummary(store,{now=Date.now()}={}){
 const rows=(store?.data?.consultantMetrics||[]).filter(r=>r.at>=now-30*86400000),counts=Object.fromEntries([...EVENTS].map(e=>[e,rows.filter(r=>r.event===e).length]));
 const starts=new Map(rows.filter(r=>r.event==='search_queued').map(r=>[r.subject,r.at]));
 const timings=rows.filter(r=>r.event==='first_offer'&&starts.has(r.subject)&&r.at>=starts.get(r.subject)).map(r=>r.at-starts.get(r.subject)).sort((a,b)=>a-b);
 const issued=new Set(rows.filter(r=>r.event==='issued').map(r=>r.subject)),searched=new Set(starts.keys()),converted=[...issued].filter(x=>searched.has(x)).length;
 return {windowDays:30,counts,firstVerifiedOfferMs:{samples:timings.length,p50:timings.length?timings[Math.floor((timings.length-1)*.5)]:null,p95:timings.length?timings[Math.ceil((timings.length-1)*.95)]:null},issuedFromSearched:converted,searchToIssuedRate:searched.size?converted/searched.size:null};
}
module.exports={recordMetric,metricsSummary};
