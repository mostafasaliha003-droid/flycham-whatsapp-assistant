'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {run}=require('../src/airarabia-worker');
const {IdlePortalSession}=require('../src/idle-portal-session');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const drain=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function flags(t,values={}){
 const names=['AIR_ARABIA_KEEPALIVE_ENABLED','AIR_ARABIA_QUOTE_QUEUE_ENABLED','GMAIL_OTP_ENABLED','AIR_ARABIA_IDLE_BROWSER_ENABLED'],old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 for(const k of names)delete process.env[k];Object.assign(process.env,{AIR_ARABIA_KEEPALIVE_ENABLED:'true',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'true',GMAIL_OTP_ENABLED:'true',...values});
 t.after(()=>{for(const k of names)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
}
function fixture(){
 const park=deferred(),events=[],runtimes=[];let polled,terminal,stops=0;
 const openRuntime=async options=>{terminal=options.onSessionError;const index=runtimes.length+1,session={adapter:{index},closed:false,authBlocked:false,pending:0};session.isReady=()=>!session.closed&&!session.authBlocked;session.run=async task=>task(session.adapter);session.healthStatus=()=>({state:session.isReady()?'ready':'unavailable'});const runtime={session,closed:0,close:async()=>{runtime.closed++;session.closed=true;events.push('close-'+index);}};runtimes.push(runtime);events.push('open-'+index);return runtime;};
 return{park,events,runtimes,openRuntime,poll(session){polled=session;events.push('poll');return async()=>{stops++;events.push('poll-stopped');};},get polled(){return polled;},get terminal(){return terminal;},get stops(){return stops;}};
}
test('AA worker verifies one initial runtime, then uses an idle controller that can close and reopen it',async t=>{
 flags(t);t.mock.timers.enable({apis:['Date'],now:100000});const f=fixture(),logs=[];
 const work=run({openRuntime:f.openRuntime,poll:f.poll,park:()=>f.park.promise,log:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 try{
  await drain();assert.equal(f.runtimes.length,1);assert.ok(f.polled instanceof IdlePortalSession);assert.equal(f.polled.idleMs,180000);assert.equal(f.polled.isReady(),true);assert.deepEqual(f.events,['open-1','poll']);
  t.mock.timers.tick(180000);assert.equal(await f.polled.closeIfIdle(),true);assert.equal(f.runtimes[0].closed,1);assert.equal(f.polled.dormant,true);assert.equal(f.polled.closed,false);
  await f.polled.ensureAwake();assert.equal(f.runtimes.length,2);assert.equal(f.runtimes[1].closed,0);assert.equal(f.polled.adapter.index,2);
 }finally{f.park.resolve();await work;t.mock.timers.reset();}
 assert.equal(f.stops,1);assert.equal(f.runtimes[0].closed,1);assert.equal(f.runtimes[1].closed,1);assert.ok(f.events.indexOf('poll-stopped')<f.events.indexOf('close-2'));
});
for(const [name,override]of [['without Gmail automation',{GMAIL_OTP_ENABLED:'false'}],['with explicit idle opt-out',{AIR_ARABIA_IDLE_BROWSER_ENABLED:'false'}]])test('AA preserves the legacy warm session '+name,async t=>{
 flags(t,override);const f=fixture();const work=run({openRuntime:f.openRuntime,poll:f.poll,park:()=>f.park.promise,log:{log(){},error(){}}});
 try{await drain();assert.equal(f.runtimes.length,1);assert.equal(f.polled,f.runtimes[0].session);assert.ok(!(f.polled instanceof IdlePortalSession));}
 finally{f.park.resolve();await work;}
 assert.equal(f.stops,1);assert.equal(f.runtimes[0].closed,1);
});
test('AA disabled flag parks without a browser or queue consumer',async t=>{
 flags(t,{AIR_ARABIA_KEEPALIVE_ENABLED:'false'});let opens=0,polls=0,parks=0;
 await run({openRuntime:async()=>{opens++;},poll:()=>{polls++;},park:async()=>{parks++;},log:{log(){},error(){}}});
 assert.equal(opens,0);assert.equal(polls,0);assert.equal(parks,1);
});
test('queue-disabled AA retains the legacy runtime without starting polling',async t=>{
 flags(t,{AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false'});const f=fixture();const work=run({openRuntime:f.openRuntime,poll:f.poll,park:()=>f.park.promise,log:{log(){},error(){}}});
 try{await drain();assert.equal(f.runtimes.length,1);assert.equal(f.polled,undefined);}
 finally{f.park.resolve();await work;}
 assert.equal(f.stops,0);assert.equal(f.runtimes[0].closed,1);
});
test('an idle-mode startup error parks once without repeatedly opening or starting polling',async t=>{
 flags(t);let opens=0,polls=0,parks=0;const logs=[];
 await run({openRuntime:async()=>{opens++;throw Error('private credentials and URL');},poll:()=>{polls++;},park:async()=>{parks++;},log:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 assert.equal(opens,1);assert.equal(polls,0);assert.equal(parks,1);assert.ok(logs.includes('PORTAL_BLOCKED_OPERATOR_REVIEW_NO_AUTOMATIC_RETRY'));assert.doesNotMatch(JSON.stringify(logs),/private credentials|URL/);
});
test('terminal runtime failure blocks later wake attempts and drains only on worker shutdown',async t=>{
 flags(t);const f=fixture();const work=run({openRuntime:f.openRuntime,poll:f.poll,park:()=>f.park.promise,log:{log(){},error(){}}});
 try{await drain();assert.equal(f.runtimes.length,1);f.terminal('PORTAL_SESSION_UNAVAILABLE');assert.equal(f.polled.authBlocked,true);assert.equal(f.runtimes[0].closed,0);await assert.rejects(f.polled.ensureAwake(),/SESSION_BLOCKED/);assert.equal(f.runtimes.length,1);}
 finally{f.park.resolve();await work;}
 assert.equal(f.runtimes[0].closed,1);assert.equal(f.stops,1);
});
