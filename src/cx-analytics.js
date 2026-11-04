'use strict';
const MAX_EVENTS=1500;
const RETENTION_MS=30*86400000;
const ALLOWED_REASONS=new Set(['staff_handoff','complaint','payment_link','tabby','discount','pricing_review','payment_review','untrained_request']);
function validEvent(e,now){return e&&ALLOWED_SERVICES.has(e.service)&&ALLOWED_CATEGORIES.has(e.category)&&Number.isFinite(e.at)&&e.at<=now&&now-e.at<=RETENTION_MS;}
function cleanEvent(e){return {service:e.service,category:e.category,reason:ALLOWED_REASONS.has(e.reason)?e.reason:null,sentiment:['urgent','frustrated','confused','neutral'].includes(e.sentiment)?e.sentiment:'neutral',language:['ar','en','mixed'].includes(e.language)?e.language:'ar',at:e.at};}
function pruneCxAnalytics(store,now=Date.now()){const state=store?.data?.cxAnalytics;if(state)state.events=(Array.isArray(state.events)?state.events:[]).filter(e=>validEvent(e,now)).map(cleanEvent).slice(-MAX_EVENTS);}
const ALLOWED_SERVICES=new Set(['flight','saudi_visa']);
const ALLOWED_CATEGORIES=new Set(['resolved','escalated','voice_transcribed','voice_fallback','cross_service_switch','validity_warning']);

function ensureAnalytics(store){
 if(!store?.data)return null;
 store.data.cxAnalytics||={events:[]};
 if(!Array.isArray(store.data.cxAnalytics.events))store.data.cxAnalytics.events=[];
 return store.data.cxAnalytics;
}

function recordCxEvent(store,{service,category,reason=null,sentiment='neutral',language='ar',now=Date.now()}={}){
 const state=ensureAnalytics(store);
 if(!state||!Number.isFinite(now)||!ALLOWED_SERVICES.has(service)||!ALLOWED_CATEGORIES.has(category))return false;
 pruneCxAnalytics(store,now);
 state.events.push({
  service,
  category,
  reason:ALLOWED_REASONS.has(reason)?reason:null,
  sentiment:['urgent','frustrated','confused','neutral'].includes(sentiment)?sentiment:'neutral',
  language:['ar','en','mixed'].includes(language)?language:'ar',
  at:now
 });
 if(state.events.length>MAX_EVENTS)state.events=state.events.slice(-MAX_EVENTS);
 store.save?.();
 return true;
}

function cxAnalyticsSummary(store,{now=Date.now(),windowHours=168}={}){
 windowHours=Number.isFinite(windowHours)&&windowHours>0?Math.min(windowHours,720):168;
 const events=(Array.isArray(store?.data?.cxAnalytics?.events)?store.data.cxAnalytics.events:[]).filter(e=>validEvent(e,now)&&now-e.at<=windowHours*3600000).slice(-MAX_EVENTS).map(cleanEvent);
 const summary={
  windowHours,
  totalEvents:events.length,
  byService:{flight:{resolved:0,escalated:0},saudi_visa:{resolved:0,escalated:0}},
  escalationReasons:{},
  sentimentCounts:{neutral:0,confused:0,frustrated:0,urgent:0},
  languageCounts:{ar:0,en:0,mixed:0},
  voice:{transcribed:0,fallback:0},
  selfServiceRate:null
 };
 let resolvedTotal=0,escalatedTotal=0;
 for(const e of events){
  if(summary.byService[e.service]){
   if(e.category==='resolved'){summary.byService[e.service].resolved++;resolvedTotal++;}
   else if(e.category==='escalated'){summary.byService[e.service].escalated++;escalatedTotal++;}
  }
  if(e.category==='escalated'&&e.reason){
   summary.escalationReasons[e.reason]=(summary.escalationReasons[e.reason]||0)+1;
  }
  if(e.category==='voice_transcribed')summary.voice.transcribed++;
  if(e.category==='voice_fallback')summary.voice.fallback++;
  if(summary.sentimentCounts[e.sentiment]!==undefined)summary.sentimentCounts[e.sentiment]++;
  if(summary.languageCounts[e.language]!==undefined)summary.languageCounts[e.language]++;
 }
 const turns=resolvedTotal+escalatedTotal;
 if(turns>0)summary.selfServiceRate=Number(((resolvedTotal/turns)*100).toFixed(1));
 return summary;
}

module.exports={recordCxEvent,cxAnalyticsSummary,pruneCxAnalytics};
