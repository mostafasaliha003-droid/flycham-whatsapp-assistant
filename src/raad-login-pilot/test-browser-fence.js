'use strict';
// Do not use route.continue in test mode: Playwright may follow a redirect
// without re-entering its route handler. Fetch exactly one response, reject all
// redirects, then fulfill that same response. This can deliberately block a
// legitimate login redirect until an isolated portal contract is reviewed.
async function installTestBrowserFence(context,policy,{onBlocked=()=>{}}={}){
 if(!policy.isTest)return false;
 if(typeof context.route!=='function'||typeof context.routeWebSocket!=='function')throw Object.assign(Error('RAAD_TEST_TRANSPORT_FENCE_UNAVAILABLE'),{code:'RAAD_TEST_TRANSPORT_FENCE_UNAVAILABLE',notDispatched:true});
 const stop=()=>{onBlocked();};
 const abort=async route=>{stop();try{await route.abort();}catch{}};
 await context.routeWebSocket('**/*',async socket=>{stop();await socket.close({code:1008,reason:'Non-submitting test'});});
 await context.route('**/*',async route=>{
  if(!policy.requestAllowed(route.request()))return abort(route);
  let response;
  try{
   // The installed Playwright version supports maxRedirects=0. Unknown route
   // implementations/capabilities fail closed; no fallback to continue().
   if(typeof route.fetch!=='function'||typeof route.fulfill!=='function')return abort(route);
   response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:10000});
   const status=response.status();
   if(!Number.isInteger(status)||status<200||status>=600||status>=300&&status<400)return abort(route);
   await route.fulfill({response});
  }catch{return abort(route);}
  finally{if(response&&typeof response.dispose==='function')try{await response.dispose();}catch{}}
 });
 return true;
}
module.exports={installTestBrowserFence};
