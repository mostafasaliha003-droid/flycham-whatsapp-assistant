'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {IdlePortalSession}=require('../src/idle-portal-session');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture({openGate,closeGate,ready=true,failOpen=false,closeFailures=0,idleMs=5000}={}){
 let time=1000,opens=0,closes=0,active=0,maxActive=0;const reports=[],events=[],runtimes=[];
 const make=()=>{
  const index=runtimes.length+1,adapter={index},session={adapter,pending:0,closed:false,authBlocked:false,ready,lastSuccessfulActivityAt:time},calls=[];let tail=Promise.resolve();
  session.isReady=()=>session.ready&&!session.closed&&!session.authBlocked;
  session.healthStatus=()=>({state:session.isReady()?'ready':'recovering',lastSuccessfulActivityAt:session.lastSuccessfulActivityAt,rawSecret:'MUST_NOT_ESCAPE'});
  session.run=(task,options)=>{session.pending++;const work=tail.catch(()=>{}).then(()=>{calls.push(options);return task(adapter);});tail=work.catch(()=>{}).finally(()=>{session.pending--;});return work;};
  const runtime={session,calls,async close(){closes++;events.push('close-start-'+index);if(closeGate&&index===1)await closeGate.promise;await tail;if(closeFailures-->0)throw Error('private browser URL');if(!session.closed){session.closed=true;session.ready=false;active--;}events.push('close-end-'+index);}};
  runtimes.push(runtime);active++;maxActive=Math.max(maxActive,active);return runtime;
 };
 const controller=new IdlePortalSession({idleMs,now:()=>time,report:code=>reports.push(code),open:async()=>{opens++;events.push('open-'+opens);if(openGate)await openGate.promise;if(failOpen)throw Error('private password and cookie');return make();}});
 return{controller,runtimes,reports,events,setTime:value=>{time=value;},advance:value=>{time+=value;},stats:()=>({time,opens,closes,active,maxActive})};
}
test('a new controller is dormant without opening a browser and exposes only safe health metadata',()=>{
 const f=fixture(),s=f.controller;
 assert.equal(s.dormant,true);assert.equal(s.closed,false);assert.equal(s.authBlocked,false);assert.equal(s.adapter,null);assert.equal(s.isReady(),false);assert.equal(s.healthStatus().state,'dormant');assert.equal(s.healthStatus().idleMs,5000);assert.deepEqual(f.stats(),{time:1000,opens:0,closes:0,active:0,maxActive:0});
 assert.throws(()=>new IdlePortalSession({}),/CONFIGURATION_INVALID/);assert.throws(()=>new IdlePortalSession({open:async()=>{},idleMs:-1}),/CONFIGURATION_INVALID/);assert.throws(()=>s.setBeforeClose('invalid'),/CONFIGURATION_INVALID/);
});
test('concurrent wake requests share one opening promise and expose ready only after supplier verification',async()=>{
 const gate=deferred(),f=fixture({openGate:gate}),s=f.controller;
 const first=s.ensureAwake(),second=s.ensureAwake();assert.equal(first,second);assert.equal(s.dormant,false);assert.equal(s.isReady(),false);assert.equal(s.healthStatus().state,'starting');await drain();assert.equal(f.stats().opens,1);
 gate.resolve();const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(a,f.runtimes[0].session);assert.equal(s.adapter,a.adapter);assert.equal(s.isReady(),true);assert.equal(s.healthStatus().state,'ready');assert.doesNotMatch(JSON.stringify(s.healthStatus()),/MUST_NOT_ESCAPE|rawSecret/);await s.stop();
});
test('idle closure releases the browser without closing the controller, then wakes a fresh runtime',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();const old=s.adapter;
 f.advance(4999);assert.equal(await s.closeIfIdle(),false);assert.equal(s.isReady(),true);
 f.advance(1);assert.equal(await s.closeIfIdle(),true);assert.equal(s.adapter,null);assert.equal(s.dormant,true);assert.equal(s.closed,false);assert.equal(s.authBlocked,false);assert.equal(await s.closeIfIdle(),false);assert.equal(f.stats().active,0);
 await s.ensureAwake();assert.notEqual(s.adapter,old);assert.equal(f.stats().opens,2);assert.equal(f.stats().maxActive,1);await s.stop();
});
test('health checks and redundant ensureAwake calls do not postpone the last completed work idle clock',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();assert.equal(s.lastCompletedWorkAt,1000);
 f.advance(4000);await s.ensureAwake();s.healthStatus();s.isReady();assert.equal(s.lastCompletedWorkAt,1000);
 f.advance(1000);assert.equal(await s.closeIfIdle(),true);await s.stop();
});
test('run pins the controller while opening, executing and queued; completed work starts a fresh idle interval',async()=>{
 const open=deferred(),task=deferred(),f=fixture({openGate:open}),s=f.controller;
 const work=s.run(async()=>task.promise,{recordsActivity:true});f.advance(6000);assert.equal(await s.closeIfIdle(),false);assert.equal(f.stats().closes,0);
 open.resolve();await drain();assert.equal(f.runtimes[0].session.pending,1);f.advance(1000);assert.equal(await s.closeIfIdle(),false);
 task.resolve('verified');assert.equal(await work,'verified');assert.equal(s.lastCompletedWorkAt,f.stats().time);assert.deepEqual(f.runtimes[0].calls,[{recordsActivity:true}]);assert.equal(await s.closeIfIdle(),false);
 f.advance(5000);assert.equal(await s.closeIfIdle(),true);await s.stop();
});
test('concurrent run calls retain the inner session mutex and delegate exact task options',async()=>{
 const f=fixture(),s=f.controller,gate=deferred(),order=[],options={recordsActivity:false};
 const first=s.run(async adapter=>{order.push('first-'+adapter.index);await gate.promise;order.push('first-end');return 1;},options);
 const second=s.run(async adapter=>{order.push('second-'+adapter.index);return 2;});await drain();assert.deepEqual(order,['first-1']);assert.equal(f.stats().opens,1);
 f.advance(6000);assert.equal(await s.closeIfIdle(),false);gate.resolve();assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.deepEqual(order,['first-1','first-end','second-1']);assert.equal(f.runtimes[0].calls[0],options);await s.stop();
});
test('failed quote work retains its typed error and still updates completion time without a new login',async()=>{
 const f=fixture(),s=f.controller,error=Object.assign(Error('QUOTE_SUPERSEDED'),{code:'QUOTE_SUPERSEDED'});await s.ensureAwake();f.advance(2000);
 await assert.rejects(s.run(async()=>{throw error;}),e=>e===error);assert.equal(s.lastCompletedWorkAt,3000);assert.equal(s.authBlocked,false);assert.equal(await s.run(async()=>42),42);assert.equal(f.stats().opens,1);await s.stop();
});
test('external inner-session pending work independently prevents idle browser closure',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();f.runtimes[0].session.pending=1;f.advance(5000);assert.equal(await s.closeIfIdle(),false);
 f.runtimes[0].session.pending=0;assert.equal(await s.closeIfIdle(),true);await s.stop();
});
test('a wake arriving during observer teardown and browser closure waits before opening another browser',async()=>{
 const close=deferred(),hook=deferred(),f=fixture({closeGate:close}),s=f.controller;
 s.setBeforeClose(async()=>{f.events.push('observer-stop');await hook.promise;f.events.push('observer-stopped');});await s.ensureAwake();f.advance(5000);
 const closing=s.closeIfIdle();await drain();assert.equal(s.isReady(),false);assert.equal(s.adapter,null);assert.equal(s.dormant,false);assert.equal(s.closed,false);assert.equal(s.healthStatus().state,'unavailable');assert.equal(f.stats().closes,0);
 const a=s.ensureAwake(),b=s.ensureAwake();assert.equal(a,b);await drain();assert.equal(f.stats().opens,1);hook.resolve();await drain();assert.equal(f.stats().closes,1);assert.equal(f.stats().opens,1);assert.equal(f.stats().active,1);
 close.resolve();assert.equal(await closing,true);assert.equal(await a,await b);assert.equal(f.stats().opens,2);assert.equal(f.stats().maxActive,1);assert.ok(f.events.indexOf('observer-stopped')<f.events.indexOf('close-start-1'));assert.ok(f.events.indexOf('close-end-1')<f.events.indexOf('open-2'));s.setBeforeClose(null);await s.stop();
});
test('an opening error blocks further wake attempts and reports no raw exception details',async()=>{
 const f=fixture({failOpen:true}),s=f.controller;
 await assert.rejects(s.ensureAwake(),/^Error: PORTAL_IDLE_SESSION_BLOCKED$/);assert.equal(s.authBlocked,true);assert.equal(s.healthStatus().state,'blocked');assert.equal(s.dormant,false);
 await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);await assert.rejects(s.run(async()=>1),/SESSION_BLOCKED/);assert.equal(f.stats().opens,1);assert.doesNotMatch(JSON.stringify(f.reports),/private|password|cookie/);await s.stop();assert.equal(s.healthStatus().state,'closed');
});
test('a returned unverified runtime closes once and never becomes ready or automatically logs in again',async()=>{
 const f=fixture({ready:false}),s=f.controller;
 await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.stats().closes,1);assert.equal(f.stats().active,0);assert.equal(s.isReady(),false);assert.equal(s.authBlocked,true);assert.ok(!f.reports.includes('PORTAL_IDLE_OPEN_READY'));await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.stats().opens,1);await s.stop();assert.equal(f.stats().closes,1);
});
test('a malformed returned runtime with a cleanup function is closed instead of being retained',async()=>{
 let closes=0;const s=new IdlePortalSession({open:async()=>({close:async()=>{closes++;}})});
 await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(closes,1);assert.equal(s.isReady(),false);await s.stop();assert.equal(closes,1);
});
test('stop during opening drains and closes the late browser once, never advertising authentication readiness',async()=>{
 const gate=deferred(),f=fixture({openGate:gate}),s=f.controller;
 const wake=s.ensureAwake();const rejected=assert.rejects(wake,/SESSION_CLOSED/);await drain();const stopping=s.stop();assert.equal(stopping,s.stop());assert.equal(s.closed,true);assert.equal(s.healthStatus().state,'closed');gate.resolve();await rejected;await stopping;
 assert.equal(f.stats().opens,1);assert.equal(f.stats().closes,1);assert.equal(f.stats().active,0);assert.equal(s.adapter,null);assert.ok(!f.reports.includes('PORTAL_IDLE_OPEN_READY'));await assert.rejects(s.ensureAwake(),/SESSION_CLOSED/);await assert.rejects(s.run(async()=>1),/SESSION_CLOSED/);assert.equal(f.stats().opens,1);
});
test('stop waits for active work, rejects later work and closes one runtime only',async()=>{
 const f=fixture(),s=f.controller,gate=deferred();const work=s.run(async()=>gate.promise);await drain();const stopping=s.stop();assert.equal(stopping,s.stop());await drain();assert.equal(f.stats().closes,0);await assert.rejects(s.run(async()=>2),/SESSION_CLOSED/);
 gate.resolve(1);assert.equal(await work,1);await stopping;assert.equal(f.stats().closes,1);assert.equal(f.stats().active,0);assert.equal(s.healthStatus().state,'closed');
});
test('stop during idle closure prevents a waiting wake from reopening the browser',async()=>{
 const close=deferred(),f=fixture({closeGate:close}),s=f.controller;await s.ensureAwake();f.advance(5000);const closing=s.closeIfIdle();await drain();const wake=s.ensureAwake(),rejected=assert.rejects(wake,/SESSION_CLOSED/);const stopping=s.stop();close.resolve();await closing;await rejected;await stopping;assert.equal(f.stats().opens,1);assert.equal(f.stats().closes,1);assert.equal(s.closed,true);
});
test('a failed close blocks any new runtime until explicit shutdown cleanup succeeds',async()=>{
 const f=fixture({closeFailures:1}),s=f.controller;await s.ensureAwake();f.advance(5000);await assert.rejects(s.closeIfIdle(),/SESSION_CLOSE_FAILED/);assert.equal(s.authBlocked,true);assert.equal(s.healthStatus().state,'blocked');await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.stats().opens,1);await s.stop();assert.equal(f.stats().active,0);assert.equal(f.stats().closes,2);assert.doesNotMatch(JSON.stringify(f.reports),/private browser/);
});
test('a failed observer teardown still attempts browser closure and prevents hidden reopening',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();s.setBeforeClose(async()=>{throw Error('private observer detail');});f.advance(5000);await assert.rejects(s.closeIfIdle(),/SESSION_CLOSE_FAILED/);assert.equal(f.stats().active,0);await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.stats().opens,1);s.setBeforeClose(null);await s.stop();assert.equal(s.closed,true);
});
test('terminal session failures can block synchronously without closing a running browser inside its own callback',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();s.block();assert.equal(s.authBlocked,true);assert.equal(s.isReady(),false);assert.equal(s.healthStatus().state,'blocked');assert.equal(f.stats().closes,0);await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);await s.stop();assert.equal(f.stats().closes,1);
});
test('a terminal failure while opening closes the late runtime instead of marking it ready',async()=>{
 const gate=deferred(),f=fixture({openGate:gate}),s=f.controller;const wake=s.ensureAwake();await drain();s.block();gate.resolve();await assert.rejects(wake,/SESSION_BLOCKED/);assert.equal(f.stats().closes,1);assert.equal(s.isReady(),false);assert.ok(!f.reports.includes('PORTAL_IDLE_OPEN_READY'));await s.stop();
});
test('an inner authentication block remains blocked after its idle browser has closed',async()=>{
 const f=fixture(),s=f.controller;await s.ensureAwake();f.runtimes[0].session.authBlocked=true;assert.equal(s.authBlocked,true);assert.equal(s.healthStatus().state,'blocked');f.advance(5000);assert.equal(await s.closeIfIdle(),true);assert.equal(s.dormant,false);assert.equal(s.authBlocked,true);await assert.rejects(s.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.stats().opens,1);await s.stop();
});
