'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadSupervisorSmsContract}=require('../src/raad-login-pilot/supervisor-contact-runtime');
const {supervisorSmsRoute,supervisorWhatsAppRecipient}=require('../src/visa-supervisor-route');
const NOW=Date.parse('2026-10-30T14:00:00Z');
const env={RAAD_SUPERVISOR_SMS_CONTACT_PROFILE:'office-saudi-2026-10-30'};
test('missing profile is disabled, not implicitly authorized',()=>{
 assert.equal(loadSupervisorSmsContract({},NOW),null);assert.equal(loadSupervisorSmsContract({RAAD_SUPERVISOR_SMS_CONTACT_PROFILE:''},NOW),null);
});
test('unknown, injected path, whitespace and nonstring profile are rejected',()=>{
 for(const selected of ['../profile','office-saudi-2026-10-30 ','true',true,{},null])assert.throws(()=>loadSupervisorSmsContract({RAAD_SUPERVISOR_SMS_CONTACT_PROFILE:selected},NOW),{code:'SUPERVISOR_SMS_PROFILE_INVALID'});
});
test('selected profile is bound to observed UI and approved Saudi number, not representative status',()=>{
 const c=loadSupervisorSmsContract(env,NOW),r=supervisorSmsRoute(c,NOW);
 assert.equal(r.number,'966591182035');assert.equal(r.officeContactLabel,'رقم الجوال');assert.equal(r.officialRepresentativeStatus,'not_established');
 assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.authorization));assert.ok(Object.isFrozen(c.observation));
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:'971507993145'}),'971507993145');
 assert.equal(supervisorWhatsAppRecipient({RAAD_OTP_OWNER_WHATSAPP:r.number}),null);
});
test('future or expired evidence fails closed and startup never refreshes timestamps',()=>{
 const c=loadSupervisorSmsContract(env,NOW);
 for(const now of [c.verifiedAt-1,c.expiresAt,c.expiresAt+1,NaN])assert.throws(()=>loadSupervisorSmsContract(env,now),{code:'SUPERVISOR_SMS_FIELD_UNVERIFIED'});
 assert.equal(loadSupervisorSmsContract(env,NOW+1000).expiresAt,c.expiresAt);
});
test('real pilot default path forwards runtime profile to worker without explicit contract injection',async()=>{
 const workerPath=require.resolve('../src/raad-login-pilot/production-worker'),serverPath=require.resolve('../src/raad-login-pilot/server');
 const worker=require(workerPath),original=worker.createProductionWorker;let captured,launches=0;
 worker.createProductionWorker=options=>{captured=options;return original(options);};delete require.cache[serverPath];
 try{
  const {createPilot}=require(serverPath);
  const p=createPilot({env:{...env,RAAD_PILOT_KEY:'synthetic'.repeat(6),RAAD_PILOT_ORIGIN:'https://test.example'},now:()=>NOW,launch:()=>{launches++;throw Error('NO_BROWSER_EXPECTED');}});
  assert.equal(supervisorSmsRoute(captured.supervisorSmsContract,NOW).number,'966591182035');assert.equal(launches,0);await p.shutdown();
  assert.throws(()=>createPilot({env:{...env,RAAD_SUPERVISOR_SMS_CONTACT_PROFILE:'wrong'},now:()=>NOW,launch:()=>{launches++;}}),{code:'SUPERVISOR_SMS_PROFILE_INVALID'});assert.equal(launches,0);
 }finally{worker.createProductionWorker=original;delete require.cache[serverPath];}
});
test('missing or altered evidence bundle cannot silently produce authorization',()=>{
 const fs=require('node:fs'),read=fs.readFileSync;
 try{
  fs.readFileSync=(file,...args)=>String(file).endsWith('office-saudi-2026-10-30.json')?Buffer.from('{}'):read(file,...args);
  assert.throws(()=>loadSupervisorSmsContract(env,NOW),{code:'SUPERVISOR_SMS_PROFILE_INVALID'});
  fs.readFileSync=(file,...args)=>{if(String(file).endsWith('office-saudi-2026-10-30.json'))throw Error('not available');return read(file,...args);};
  assert.throws(()=>loadSupervisorSmsContract(env,NOW),{code:'SUPERVISOR_SMS_PROFILE_INVALID'});
 }finally{fs.readFileSync=read;}
});
