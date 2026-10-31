'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createRequire}=require('node:module');
const path=require('node:path');
const vm=require('node:vm');
const {SUPERVISOR_WHATSAPP_NUMBER:OWNER}=require('../src/visa-supervisor-route');
const HEALTH='/internal/assistant/visa-portal/health';
// Keep the real handler and all its other imports. Only its own PDF-tool probe
// is synthetic; no child process or global monkey patch escapes this fixture.
const setupFile=require.resolve('../src/visa-setup-http');
const setupRequire=createRequire(setupFile),setupModule={exports:{}};
const loadSetup=vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+readFileSync(setupFile,'utf8')+'\n})',{filename:setupFile});
loadSetup(id=>id==='node:child_process'?{spawnSync(command,args){assert.ok(['pdfinfo','pdftoppm'].includes(command));assert.deepEqual(args,['-v']);return {status:0};}}:setupRequire(id),setupModule,setupModule.exports,setupFile,path.dirname(setupFile));
const {createVisaSetup}=setupModule.exports;

async function health(env){
 let status,headers,body,fetches=0;
 const handle=createVisaSetup({env,fetchImpl:async()=>{fetches++;assert.fail('configuration-only health must not make an external request');}});
 const handled=await handle({method:'GET',headers:{}},{writeHead(code,value){status=code;headers=value;return this;},end(value){body=JSON.parse(value);}},new URL('http://127.0.0.1'+HEALTH));
 assert.equal(handled,true);assert.equal(status,200);assert.equal(headers['Cache-Control'],'no-store');assert.equal(fetches,0);
 return body;
}

test('setup health recognizes canonical, normalized and compatible owner aliases using the delivery validator',async()=>{
 for(const env of [
  {RAAD_OTP_OWNER_WHATSAPP:OWNER},
  {RAAD_OTP_OWNER_WHATSAPP:'+'+OWNER},
  {RAAD_OTP_OWNER_RECIPIENT:OWNER},
  {RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_OTP_OWNER_RECIPIENT:'+'+OWNER}
 ])assert.equal((await health(env)).otpOwnerConfigured,true);
});

test('setup health rejects missing, malformed and conflicting owner settings rather than reporting a false ready state',async()=>{
 for(const env of [
  {},
  {RAAD_OTP_OWNER_WHATSAPP:''},
  {RAAD_OTP_OWNER_WHATSAPP:'not-a-phone'},
  {RAAD_OTP_OWNER_WHATSAPP:'15550009002'},
  {RAAD_OTP_OWNER_WHATSAPP:123},
  {RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_OTP_OWNER_RECIPIENT:'15550009002'},
  {RAAD_OTP_OWNER_WHATSAPP:'invalid',RAAD_OTP_OWNER_RECIPIENT:OWNER}
 ])assert.equal((await health(env)).otpOwnerConfigured,false);
});

test('setup health preserves its finite response and does not expose configured owner identities',async()=>{
 const result=await health({RAAD_OTP_OWNER_WHATSAPP:OWNER,RAAD_OTP_OWNER_RECIPIENT:OWNER});
 assert.deepEqual(Object.keys(result).sort(),['workflowEnabled','workerConfigured','accountantConfigured','otpOwnerConfigured','pdfToolsReady','template','paymentTemplate','documentOcr','documentQueue'].sort());
 for(const key of ['workflowEnabled','workerConfigured','accountantConfigured','otpOwnerConfigured','pdfToolsReady'])assert.equal(typeof result[key],'boolean');
 assert.equal(JSON.stringify(result).includes(OWNER),false);
});

test('diagnostic correction leaves setup mutation authorization unchanged',async()=>{
 const handle=createVisaSetup({env:{RAAD_OTP_OWNER_WHATSAPP:OWNER},fetchImpl:async()=>assert.fail('unauthorized setup must not make an external request')});
 let status,body;
 const handled=await handle({method:'POST',headers:{}},{writeHead(code){status=code;return this;},end(value){body=JSON.parse(value);}},new URL('http://127.0.0.1/internal/assistant/visa-portal/otp-template'));
 assert.equal(handled,true);assert.equal(status,403);assert.deepEqual(body,{error:'SETUP_AUTHORITY_REQUIRED'});
});
