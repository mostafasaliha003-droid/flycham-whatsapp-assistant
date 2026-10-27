'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {runSyntheticPersistenceProbe,isProviderURL,bounded,ORIGIN,TTL_MS}=require('../persist-probe');

const TOKEN='SYNTHETIC_TOKEN';
function mock({restore=true,createFail=false,invalidConnect=false,invalidStop=false,deleteFail=false,failGoto=false,failCloseFirst=false}={}){
  let stored={},cookies=[],requests=[],connections=0,closures=0,network='none';
  const ok=(data)=>({ok:true,json:async()=>data});
  const fetcher=async(url,options)=>{
    const u=new URL(url); requests.push({host:u.hostname,path:u.pathname,method:options.method,body:options.body,redirect:options.redirect,signal:Boolean(options.signal)});
    if(options.method==='POST')return createFail?{ok:false}:ok({id:'synthetic-id',connect:invalidConnect?'wss://attacker.test/c?token='+TOKEN:'wss://production-lon.browserless.io/session/connect/synthetic-id?token='+TOKEN,stop:invalidStop?'https://attacker.test/delete?token='+TOKEN:'https://production-lon.browserless.io/session/synthetic-id?token='+TOKEN});
    if(options.method==='DELETE')return {ok:!deleteFail};
    throw Error('unexpected method');
  };
  const connect=async()=>{
    const n=++connections;let local=n===1?{}:(restore?{...stored}:{ });let ownCookies=n===1?[]:(restore?[...cookies]:[]);
    const page={
      route:async(_pattern,fn)=>{const route={request:()=>({url:()=>ORIGIN+'/'}),fulfill:async()=>{network='fulfilled'},abort:async()=>{throw Error('unexpected abort')}};await fn(route)},
      goto:async()=>{if(failGoto)throw Error('https://secret.example/?token='+TOKEN)},
      url:()=>ORIGIN+'/',
      evaluate:async(_fn,value)=>{if(value!==undefined){local.synthetic_state=value;return}return local.synthetic_state},
    };
    const context={newPage:async()=>page,addCookies:async x=>{ownCookies=x},cookies:async()=>ownCookies};
    return {contexts:()=>[context],close:async()=>{closures++;if(failCloseFirst && n===1)throw Error('bad');stored=local;cookies=ownCookies}};
  };
  return {fetcher,connect,getStats:()=>({requests,connections,closures,network})};
}
test('disabled by default, no external calls',async()=>{const m=mock();const out=await runSyntheticPersistenceProbe({token:TOKEN,...m});assert.equal(out.reason,'DISABLED');assert.equal(m.getStats().requests.length,0)});
test('synthetic cookie and storage verified across two new browser connections; session deleted',async()=>{const m=mock();const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.deepEqual(out,{enabled:true,createAttempted:true,created:true,firstWrite:true,firstClosed:true,secondRead:true,secondClosed:true,deleted:true,reason:'SYNTHETIC_STATE_RESTORED'});const s=m.getStats();assert.equal(s.connections,2);assert.equal(s.closures,2);assert.equal(s.network,'fulfilled');assert.equal(s.requests.length,2);assert.deepEqual(JSON.parse(s.requests[0].body),{ttl:TTL_MS,processKeepAlive:0,replay:false});assert.equal(s.requests[1].method,'DELETE');assert.ok(s.requests.every(x=>x.redirect==='manual'&&x.signal));});
test('non-restored state is not success but is still cleaned up',async()=>{const m=mock({restore:false});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.secondRead,false);assert.equal(out.deleted,true);assert.equal(out.reason,'STATE_NOT_RESTORED')});
test('refuses malformed provider connect URL yet deletes using valid stop URL',async()=>{const m=mock({invalidConnect:true});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.reason,'CONNECT_URL_INVALID');assert.equal(out.deleted,true);assert.equal(m.getStats().connections,0)});
test('never calls untrusted stop URL and reports cleanup unconfirmed',async()=>{const m=mock({invalidStop:true});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.reason,'CLEANUP_UNCONFIRMED');assert.equal(out.created,true);assert.equal(out.deleted,false);assert.equal(m.getStats().requests.length,1)});
test('failed delete prevents claiming cleanup',async()=>{const m=mock({deleteFail:true});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.secondRead,true);assert.equal(out.deleted,false);assert.equal(out.reason,'CLEANUP_UNCONFIRMED')});
test('navigation error closes browser and deletes session without exposing errors',async()=>{const m=mock({failGoto:true});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.reason,'PROBE_FAILED');assert.equal(out.deleted,true);assert.equal(m.getStats().closures,1);assert.equal(JSON.stringify(out).includes(TOKEN),false)});
test('close failure prevents reconnect and success, while cleanup is still attempted',async()=>{const m=mock({failCloseFirst:true});const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,...m});assert.equal(out.firstClosed,false);assert.equal(out.secondRead,false);assert.equal(out.deleted,true);assert.equal(m.getStats().connections,1)});
test('provider credentials limited to exact host, protocol and one matching token',()=>{assert.ok(isProviderURL('wss://production-lon.browserless.io/x?token='+TOKEN,'wss:','production-lon.browserless.io',TOKEN));for(const url of ['wss://evil.example/x?token='+TOKEN,'ws://production-lon.browserless.io/x?token='+TOKEN,'wss://production-lon.browserless.io/x?token='+TOKEN+'&token=other','wss://production-lon.browserless.io/x?token=bad'])assert.equal(isProviderURL(url,'wss:','production-lon.browserless.io',TOKEN),false)});
test('unknown outcome of session creation never claims safe cleanup',async()=>{const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,fetcher:async()=>{throw Error('network failure')},connect:async()=>{throw Error('should not run')}});assert.equal(out.createAttempted,true);assert.equal(out.reason,'CLEANUP_UNCONFIRMED');assert.equal(out.deleted,false)});
test('stop path for another session is never called',async()=>{let deletes=0;const out=await runSyntheticPersistenceProbe({enabled:true,token:TOKEN,fetcher:async(_url,o)=>{if(o.method==='DELETE')deletes++;return {ok:true,json:async()=>({id:'one',stop:'https://production-lon.browserless.io/session/two?token='+TOKEN,connect:'wss://production-lon.browserless.io/session/connect/one?token='+TOKEN})}}});assert.equal(deletes,0);assert.equal(out.reason,'CLEANUP_UNCONFIRMED')});
test('bounded operation times out even if the pending task ignores cancellation',async()=>{await assert.rejects(bounded(new Promise(()=>{}),10),/TIMEOUT/)});
test('late connection is cleaned up when it resolves after timeout',async()=>{let closeCount=0;const late=new Promise(resolve=>setTimeout(()=>resolve({close:()=>closeCount++}),30));await assert.rejects(bounded(late,5,b=>b.close()),/TIMEOUT/);await new Promise(resolve=>setTimeout(resolve,45));assert.equal(closeCount,1)});
test('late cleanup failure does not cause an unhandled rejection',async()=>{let called=false;const late=new Promise(resolve=>setTimeout(()=>resolve({}),15));await assert.rejects(bounded(late,3,()=>{called=true;throw Error('cleanup failed')}),/TIMEOUT/);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(called,true)});
