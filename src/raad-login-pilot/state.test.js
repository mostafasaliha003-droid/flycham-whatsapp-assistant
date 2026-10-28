'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPilot}=require('./server');
const key='z'.repeat(43),origin='https://state-test.example';
async function setup(){
 let launches=0,closes=0;
 const pilot=createPilot({env:{RAAD_PILOT_KEY:key,RAAD_PILOT_ORIGIN:origin,RAAD_DIRECT_LOGIN_ENABLED:'true'},launch:async()=>{
  launches++;
  const page={url:()=> 'https://visa.mofa.gov.sa/Account/Loginindividuals',isClosed:()=>false,goto:async()=>{},locator:()=>({count:async()=>1,isVisible:async()=>true,screenshot:async()=>Buffer.from('fake-challenge'),fill:async()=>{},click:async()=>{}})};
  return {newContext:async()=>({route:async()=>{},newPage:async()=>page}),isConnected:()=>true,close:async()=>{closes++;}};
 }});
 await new Promise(resolve=>pilot.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+pilot.server.address().port;
 async function call(path,data={},headers={}){return fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});}
 return {pilot,call,launches:()=>launches,closes:()=>closes};
}
function assertPublicState(data){
 const {captchaAutomationAvailable,...state}=data;
 if(captchaAutomationAvailable!==undefined)assert.equal(typeof captchaAutomationAvailable,'boolean');
 const serialized=JSON.stringify(state);
 for(const secret of [key,'password','captcha','fake-challenge','Bearer','UserName'])assert.equal(serialized.includes(secret),false,`state exposed ${secret}`);
}
test('current state is admin and origin protected without creating a browser',async()=>{
 const t=await setup();try{
  assert.equal((await t.call('/api/current',{}, {Authorization:'wrong'})).status,401);
  assert.equal((await t.call('/api/current',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal(t.launches(),0);
 }finally{await t.pilot.shutdown();}
});
test('current state returns no_session when no browser is active',async()=>{
 const t=await setup();try{
  const response=await t.call('/api/current');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.stage,'no_session');assertPublicState(data);assert.equal(t.launches(),0);
 }finally{await t.pilot.shutdown();}
});
test('current state recovers opaque active session and stage without credentials',async()=>{
 const t=await setup();try{
  const started=await(await t.call('/api/start')).json();
  const response=await t.call('/api/current');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.sessionId,started.sessionId);assert.equal(data.stage,'awaiting_input');assert.equal(data.expiresAt,started.expiresAt);assertPublicState(data);
  assert.equal(t.launches(),1);assert.equal(t.closes(),0);
 }finally{await t.pilot.shutdown();}
});
test('second start rejects with SESSION_EXISTS and preserves original browser',async()=>{
 const t=await setup();try{
  const started=await(await t.call('/api/start')).json();
  const second=await t.call('/api/start');assert.equal(second.status,409);assert.equal((await second.json()).error,'SESSION_EXISTS');
  const current=await(await t.call('/api/current')).json();assert.equal(current.sessionId,started.sessionId);assert.equal(current.stage,'awaiting_input');
  assert.equal(t.launches(),1);assert.equal(t.closes(),0);
 }finally{await t.pilot.shutdown();}
});
test('explicit close releases existing session and allows a deliberate new start',async()=>{
 const t=await setup();try{
  const first=await(await t.call('/api/start')).json();
  assert.equal((await(await t.call('/api/close',{sessionId:first.sessionId})).json()).closed,true);
  assert.equal(t.closes(),1);
  const after=await(await t.call('/api/current')).json();assert.equal(after.sessionId,undefined);assertPublicState(after);
  assert.ok(after.stage==='no_session'||after.lastOutcome,'inactive state must be explicit');
  const next=await t.call('/api/start');assert.equal(next.status,200);assert.notEqual((await next.json()).sessionId,first.sessionId);assert.equal(t.launches(),2);
 }finally{await t.pilot.shutdown();}
});
