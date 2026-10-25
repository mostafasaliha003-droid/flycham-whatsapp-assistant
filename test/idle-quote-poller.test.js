'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startQuotePolling}=require('../src/quote-poller');
const {IdlePortalSession}=require('../src/idle-portal-session');
const env={AIR_ARABIA_QUOTE_QUEUE_URL:'https://flycham-whatsapp-assistant.onrender.com/internal/quotes',AIR_ARABIA_QUOTE_QUEUE_KEY:'synthetic-idle-queue-key-xxxxxxxxxxxxxx'};
const request={origin:'SHJ',destination:'DAM',departureDate:'2090-11-11',tripType:'one_way'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
function fixture({openGate,quoteGate,completeGate,failOpen=false,failCompletion=false,idleMs=3000}={}){
 const calls=[],events=[],runtimes=[],logs=[];let opens=0,closes=0,pending=false,jobTaken=false,pendingError=false,activeWork=false;
 const controller=new IdlePortalSession({idleMs,report:code=>logs.push(code),open:async()=>{
  opens++;events.push('open-start-'+opens);if(openGate)await openGate.promise;if(failOpen)throw Error('private login/password');
  const index=opens,adapter={index,isAuthenticated:async()=>true,report:code=>events.push('report-'+index+':'+code),runCustomerQuote:async()=>{events.push('quote-start-'+index);if(quoteGate)await quoteGate.promise;events.push('quote-end-'+index);return{reply:'verified synthetic result',outcome:'done',coverage:[{date:request.departureDate,confirmed:1,status:'confirmed'}]};}};
  const originalReport=adapter.report,session={adapter,pending:0,closed:false,authBlocked:false};session.isReady=()=>!session.closed&&!session.authBlocked;session.healthStatus=()=>({state:session.isReady()?'ready':'unavailable'});session.run=async task=>{session.pending++;try{return await task(adapter);}finally{session.pending--;}};
  const runtime={session,originalReport,close:async()=>{events.push('close-'+index);closes++;session.closed=true;}};runtimes.push(runtime);events.push('open-ready-'+index);return runtime;
 }});
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push({path,body,readyAtCall:controller.isReady()});events.push(path.split('/').at(-1));let data={};
  if(path.endsWith('/pending')){if(pendingError)throw Error('private network problem');data={pending:pending&&!jobTaken,activeWork};}
  else if(path.endsWith('/claim')){assert.equal(controller.isReady(),true,'claim requires authenticated runtime');if(pending&&!jobTaken){jobTaken=true;data={id:'synthetic-job',lease:'synthetic-lease',request};}}
  else if(path.endsWith('/current'))data={current:true};
  else if(path.endsWith('/complete')){events.push('complete-start');if(completeGate)await completeGate.promise;if(failCompletion){activeWork=true;throw Error('private ambiguous completion response');}events.push('complete-accepted');data={accepted:true};}
  else if(path.endsWith('/monitor'))data={accepted:true};
  return{ok:true,json:async()=>data};
 };
 const start=()=>startQuotePolling(controller,{env,fetchImpl,log:{log:code=>logs.push(code)}});
 return{controller,calls,events,runtimes,logs,start,stats:()=>({opens,closes}),setPending:value=>{pending=value;},setPendingError:value=>{pendingError=value;},setActiveWork:value=>{activeWork=value;},resetJob:()=>{jobTaken=false;}};
}
test('a dormant consumer polls demand without launching, claiming or advertising supplier authentication',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const f=fixture(),stop=f.start();
 try{
  await drain();assert.equal(f.controller.dormant,true);assert.deepEqual(f.stats(),{opens:0,closes:0});assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,0);assert.ok(f.calls.some(c=>c.path.endsWith('/pending')));
  const heartbeats=f.calls.filter(c=>c.path.endsWith('/heartbeat'));assert.ok(heartbeats.length);assert.ok(heartbeats.every(c=>c.body.ready===false&&c.body.status==='dormant'));
  const views=f.calls.filter(c=>c.path.endsWith('/monitor'));assert.ok(views.every(c=>c.body.ready===false&&c.body.previewWithheld===true&&c.body.activeJob===null));
  t.mock.timers.tick(3000);await drain();assert.equal(f.calls.filter(c=>c.path.endsWith('/pending')).length,2);assert.equal(f.stats().opens,0);
 }finally{await stop();await f.controller.stop();t.mock.timers.reset();}
});
test('real pending demand wakes exactly one runtime and claims only after authentication is verified',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const gate=deferred(),f=fixture({openGate:gate});f.setPending(true);const stop=f.start();let concurrent;
 try{
  await drain();assert.equal(f.stats().opens,1);assert.equal(f.controller.isReady(),false);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,0);
  concurrent=f.controller.ensureAwake();await drain();assert.equal(f.stats().opens,1);
  t.mock.timers.tick(10000);await drain();assert.ok(f.calls.filter(c=>c.path.endsWith('/heartbeat')).every(c=>c.body.ready===false));assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,0);
  gate.resolve();await concurrent;await drain();assert.equal(f.stats().opens,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.ok(f.calls.filter(c=>c.path.endsWith('/claim')).every(c=>c.readyAtCall));assert.ok(f.calls.some(c=>c.path.endsWith('/complete')&&c.body.reply==='verified synthetic result'));
 }finally{gate.resolve();await concurrent?.catch(()=>{});await stop();await f.controller.stop();t.mock.timers.reset();}
});
test('an idle warm browser closes while its consumer remains alive and later demand rebinds a fresh observer',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const f=fixture();await f.controller.ensureAwake();const first=f.runtimes[0],stop=f.start();
 try{
  await drain();assert.notEqual(first.session.adapter.report,first.originalReport);
  t.mock.timers.tick(3000);await drain();assert.equal(f.controller.dormant,true);assert.deepEqual(f.stats(),{opens:1,closes:1});assert.equal(first.session.adapter.report,first.originalReport);assert.ok(f.calls.some(c=>c.path.endsWith('/monitor')&&c.body.state==='dormant'&&c.body.ready===false));
  f.setPending(true);t.mock.timers.tick(3000);await drain();assert.deepEqual(f.stats(),{opens:2,closes:1});assert.equal(f.runtimes[1].session.adapter.index,2);assert.notEqual(f.runtimes[1].session.adapter.report,f.runtimes[1].originalReport);assert.ok(f.calls.some(c=>c.path.endsWith('/complete')));
 }finally{await stop();await f.controller.stop();t.mock.timers.reset();}
 assert.equal(f.stats().closes,2);
});
test('browser stays pinned until quote work and its durable completion response have both finished',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const quote=deferred(),completion=deferred(),f=fixture({quoteGate:quote,completeGate:completion});f.setPending(true);const stop=f.start();
 try{
  await drain();assert.ok(f.events.includes('quote-start-1'));t.mock.timers.tick(180000);await drain();assert.equal(f.stats().closes,0);assert.equal(f.calls.filter(c=>c.path.endsWith('/complete')).length,0);
  quote.resolve();await drain();assert.ok(f.events.includes('complete-start'));assert.ok(!f.events.includes('complete-accepted'));t.mock.timers.tick(180000);await drain();assert.equal(f.stats().closes,0);assert.equal(f.stats().opens,1);
  completion.resolve();await drain();assert.ok(f.events.includes('complete-accepted'));t.mock.timers.tick(3000);await drain();assert.equal(f.stats().closes,1);assert.ok(f.events.indexOf('complete-accepted')<f.events.indexOf('close-1'));assert.equal(f.controller.dormant,true);
 }finally{quote.resolve();completion.resolve();await stop();await f.controller.stop();t.mock.timers.reset();}
});
test('failed wake blocks without claiming and cannot enter an automatic login retry loop',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const f=fixture({failOpen:true});f.setPending(true);const stop=f.start();
 try{
  await drain();assert.equal(f.stats().opens,1);assert.equal(f.controller.authBlocked,true);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,0);assert.ok(f.calls.some(c=>c.path.endsWith('/monitor')&&c.body.state==='blocked'&&c.body.ready===false));
  const before=f.calls.length;t.mock.timers.tick(180000);await drain();assert.equal(f.calls.length,before);assert.equal(f.stats().opens,1);assert.doesNotMatch(JSON.stringify(f.logs),/private login|password/);
 }finally{await stop();await f.controller.stop();t.mock.timers.reset();}
});
test('a failed pending-demand probe does not close a browser or pretend that the queue is empty',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const f=fixture();await f.controller.ensureAwake();f.setPendingError(true);const stop=f.start();
 try{
  await drain();t.mock.timers.tick(6000);await drain();assert.equal(f.stats().closes,0);assert.equal(f.controller.isReady(),true);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,0);
  f.setPendingError(false);t.mock.timers.tick(3000);await drain();assert.equal(f.stats().closes,1);assert.equal(f.controller.dormant,true);
 }finally{await stop();await f.controller.stop();t.mock.timers.reset();}
});
test('an ambiguous completion response keeps a browser awake while its durable lease is still active',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:100000});const f=fixture({failCompletion:true});f.setPending(true);const stop=f.start();
 try{
  await drain();assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/complete')).length,1);assert.equal(f.events.includes('complete-accepted'),false);
  t.mock.timers.tick(180000);await drain();assert.ok(f.calls.filter(c=>c.path.endsWith('/pending')).length>=2);assert.equal(f.stats().closes,0);assert.equal(f.controller.isReady(),true);assert.equal(f.calls.filter(c=>c.path.endsWith('/claim')).length,1);assert.equal(f.calls.filter(c=>c.path.endsWith('/complete')).length,1);assert.equal(f.stats().opens,1);
  f.setActiveWork(false);t.mock.timers.tick(3000);await drain();assert.equal(f.stats().closes,1);assert.equal(f.controller.dormant,true);assert.doesNotMatch(JSON.stringify(f.logs),/private ambiguous completion/);
 }finally{await stop();await f.controller.stop();t.mock.timers.reset();}
});
