'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {createExecutionPolicy}=require('./execution-policy');
const {installTestBrowserFence}=require('./test-browser-fence');
const policy=()=>createExecutionPolicy({RAAD_EXECUTION_MODE:'non_submitting_test'});
async function fixture(){let handler,websocket,blocks=0;const context={route:async(_pattern,fn)=>{handler=fn;},routeWebSocket:async(_pattern,fn)=>{websocket=fn;}};assert.equal(await installTestBrowserFence(context,policy(),{onBlocked:()=>{blocks++;}}),true);return {handler,websocket,blocks:()=>blocks};}
const request=(path='/Account/Loginindividuals',method='GET')=>({url:()=> 'https://visa.mofa.gov.sa'+path,method:()=>method,resourceType:()=> 'document',redirectedFrom:()=>null});

test('production does not install the opt-in browser fence',async()=>assert.equal(await installTestBrowserFence({},createExecutionPolicy({})),false));
test('missing route or WebSocket interception fails closed',async()=>{for(const context of [{route:async()=>{}},{routeWebSocket:async()=>{}},{}])await assert.rejects(()=>installTestBrowserFence(context,policy()),e=>e.code==='RAAD_TEST_TRANSPORT_FENCE_UNAVAILABLE');});
test('an allowed request fetches exactly one response without redirects and fulfills/disposes it; never continue()',async()=>{
 const f=await fixture();let fulfilled=0,disposed=0,aborted=0;const response={status:()=>200,dispose:async()=>{disposed++;}};
 await f.handler({request,fetch:async options=>{assert.deepEqual(options,{maxRedirects:0,maxRetries:0,timeout:10000});return response;},fulfill:async options=>{assert.equal(options.response,response);fulfilled++;},abort:async()=>{aborted++;},continue:()=>assert.fail('redirect-prone continue must never be used')});
 assert.equal(fulfilled,1);assert.equal(disposed,1);assert.equal(aborted,0);assert.equal(f.blocks(),0);
});
test('all redirect statuses are aborted before fulfill, including same-origin save/payment redirects',async()=>{
 const f=await fixture();let fulfilled=0,disposed=0,aborted=0;
 for(const status of [300,301,302,303,304,305,307,308,399])await f.handler({request,fetch:async options=>{assert.equal(options.maxRedirects,0);return {status:()=>status,dispose:async()=>{disposed++;}};},fulfill:async()=>{fulfilled++;},abort:async()=>{aborted++;},continue:()=>assert.fail('continue forbidden')});
 assert.equal(fulfilled,0);assert.equal(aborted,9);assert.equal(disposed,9);assert.equal(f.blocks(),9);
});
test('handler facing a real loopback HTTP redirect never reaches the target mutation endpoint',async t=>{
 let first=0,target=0;const server=http.createServer((req,res)=>{if(req.url==='/login'){first++;res.writeHead(302,{Location:'/unsafe-save'}).end();}else{target++;res.writeHead(200).end('must not reach');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
 const f=await fixture();let aborted=0,fulfilled=0;
 await f.handler({request,fetch:async options=>{assert.equal(options.maxRedirects,0);const r=await fetch(base+'/login',{redirect:'manual'});return {status:()=>r.status,dispose:async()=>{await r.arrayBuffer();}};},fulfill:async()=>{fulfilled++;},abort:async()=>{aborted++;},continue:()=>assert.fail('continue forbidden')});
 assert.equal(first,1);assert.equal(target,0);assert.equal(aborted,1);assert.equal(fulfilled,0);
});
test('unknown requests are rejected before fetch and fetch/capability failures have no continue fallback',async()=>{
 const f=await fixture();let fetches=0,aborted=0;
 await f.handler({request:()=>request('/SmartForm/Save','POST'),fetch:async()=>{fetches++;},fulfill:async()=>{},abort:async()=>{aborted++;}});
 await f.handler({request,abort:async()=>{aborted++;}});
 await f.handler({request,fetch:async()=>{fetches++;throw Error('synthetic transport unavailable');},fulfill:async()=>{},abort:async()=>{aborted++;}});
 assert.equal(fetches,1);assert.equal(aborted,3);assert.equal(f.blocks(),3);
});
test('WebSockets are closed without connecting to a remote endpoint',async()=>{
 const f=await fixture();let closed=0;await f.websocket({close:async options=>{assert.equal(options.code,1008);closed++;},connectToServer:()=>assert.fail('not allowed')});assert.equal(closed,1);assert.equal(f.blocks(),1);
});
