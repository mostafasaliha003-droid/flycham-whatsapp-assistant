'use strict';
// Bounded, protected support metadata only. No request/response body, headers,
// query strings, cookies, images or raw network errors are read or retained.
function createNetworkDiagnostics(page){
 const ORIGIN='https://visa.mofa.gov.sa',LIMIT=30,events=[];
 const counts={relevantResponses:0,relevantFailures:0,crossOriginNonGetAttempted:0,crossOriginNonGetFailed:0,crossOriginNonGetRouteAborted:0,crossOriginNavigationRouteAborted:0,crossOriginRouteAbortedTotal:0,crossOriginRouteAbortedOther:0};
 const available=!!page&&typeof page.on==='function'&&typeof page.off==='function';let stopped=false,totalEvents=0;
 const started=new WeakSet(),aborted=new WeakSet();
 const inc=key=>{counts[key]=Math.min(1000000,counts[key]+1);};
 const staticOrigin=u=>{
  if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
  const h=u.hostname;if(['www.google.com','www.recaptcha.net','www.gstatic.com'].includes(h))return u.origin;
  if(h==='mofa.gov.sa'||h==='ksavisa.sa')return u.origin;
  const suffix=h.endsWith('.mofa.gov.sa')?'.mofa.gov.sa':h.endsWith('.ksavisa.sa')?'.ksavisa.sa':null;
  if(!suffix)return null;const labels=h.slice(0,-suffix.length).split('.');return labels.length<=2&&labels.every(label=>/^[a-z][a-z-]{0,19}$/.test(label))?u.origin:null;
 };
 const safePath=u=>{let p;try{p=decodeURIComponent(u.pathname);}catch{p=u.pathname;}return p.split(/[?#]/,1)[0].replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]').replace(/\/(?:[A-Z]{4,12}|[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]{3,})(?=\/|$)/g,'/[id]').replace(/[0-9\u0660-\u0669\u06f0-\u06f9]+/g,'[number]').replace(/[\u0000-\u001f\u007f<>]/g,'').slice(0,180);};
 function info(request){const u=new URL(request.url()),method=request.method(),resource=request.resourceType();return {sameOrigin:u.origin===ORIGIN,origin:staticOrigin(u),path:safePath(u),method:['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(method)?method:'OTHER',resourceType:['xhr','fetch','document','image'].includes(resource)?resource:'other',navigation:typeof request.isNavigationRequest==='function'&&request.isNavigationRequest()===true};}
 const relevant=r=>r.sameOrigin&&(r.resourceType==='xhr'||r.resourceType==='fetch')||/captcha|validat|verif|check.*code|SmartForm\/TraditionalApp/i.test(r.path||'')&&(r.sameOrigin||r.origin!==null);
 const add=event=>{totalEvents++;if(events.length===LIMIT)events.shift();events.push(event);};
 const publicInfo=r=>({sameOrigin:r.sameOrigin,...(!r.sameOrigin&&r.origin?{externalOrigin:r.origin}:{}),...(r.sameOrigin||r.origin?{path:r.path}:{}),method:r.method,resourceType:r.resourceType,navigation:r.navigation});
 function requestStarted(request){try{if(stopped||!available||started.has(request))return;started.add(request);const r=info(request);if(!r.sameOrigin&&!['GET','HEAD'].includes(r.method))inc('crossOriginNonGetAttempted');}catch{}}
 function requestFailed(request){try{if(stopped||!available)return;const r=info(request);if(!r.sameOrigin&&!['GET','HEAD'].includes(r.method))inc('crossOriginNonGetFailed');if(!relevant(r))return;inc('relevantFailures');const raw=request.failure()?.errorText||'';const reason=/ERR_ABORTED/.test(raw)?'aborted':/BLOCKED/.test(raw)?'blocked':/TIMED_OUT/.test(raw)?'timeout':/CONNECTION_RESET/.test(raw)?'connection_reset':/CERT/.test(raw)?'certificate':/NAME_NOT_RESOLVED/.test(raw)?'dns':'network_other';add({event:'requestfailed',...publicInfo(r),reason});}catch{}}
 function responseReceived(response){try{if(stopped||!available)return;const r=info(response.request());if(!relevant(r))return;const status=response.status();if(!Number.isInteger(status)||status<100||status>599)return;inc('relevantResponses');add({event:'response',...publicInfo(r),status});}catch{}}
 if(available){page.on('request',requestStarted);page.on('requestfailed',requestFailed);page.on('response',responseReceived);}
 return {
  // Invoke only where the existing route handler actually calls route.abort().
  // A failed network request does not, by itself, establish a route-policy block.
  recordRouteAbort(request){try{if(stopped||!available||aborted.has(request))return;const r=info(request);if(r.sameOrigin)return;aborted.add(request);inc('crossOriginRouteAbortedTotal');if(r.navigation)inc('crossOriginNavigationRouteAborted');if(!['GET','HEAD'].includes(r.method))inc('crossOriginNonGetRouteAborted');if(!r.origin){inc('crossOriginRouteAbortedOther');return;}add({event:'routeabort',...publicInfo(r)});}catch{}},
  snapshot(){return {available,unavailable:!available,counts:{...counts},events:events.map(value=>({...value})),truncated:totalEvents>events.length};},
  stop(){if(!stopped){stopped=true;if(available){page.off('request',requestStarted);page.off('requestfailed',requestFailed);page.off('response',responseReceived);}}}
 };
}
module.exports={createNetworkDiagnostics};
