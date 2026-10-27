'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mofa-server-test-'));
const admin='mofa-pilot-admin-key-'.padEnd(40,'x');
Object.assign(process.env,{ASSISTANT_STATE_PATH:path.join(tmp,'state.enc'),ASSISTANT_STATE_KEY:'synthetic-only',ASSISTANT_ADMIN_KEY:admin,RAAD_MOFA_LOGIN_PILOT_ENABLED:'false',BROWSERLESS_API_TOKEN:'synthetic-browserless-token',DRY_RUN:'true',ASSISTANT_AI_PROVIDER:'none',CONSULTANT_ORCHESTRATOR_ENABLED:'false'});
const {createServer}=require('../src/server');
const get=(port,method,path,auth)=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port,path,method,headers:auth?{Authorization:'Bearer '+auth}:{}},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body}));});q.on('error',reject);q.end();});
test('real server keeps MOFA pilot disabled by default behind existing admin authentication',async()=>{
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
 try{
  assert.equal((await get(port,'GET','/internal/assistant/mofa-login-pilot')).status,401);
  const config=await get(port,'GET','/internal/assistant/mofa-login-pilot',admin);assert.equal(config.status,200);assert.deepEqual(JSON.parse(config.body),{enabled:false,configured:true});
  assert.match(config.headers['cache-control'],/no-store/);assert.doesNotMatch(config.body,/synthetic-browserless-token/);
  assert.equal((await get(port,'POST','/internal/assistant/mofa-login-pilot',admin)).status,404);
  const html=await get(port,'GET','/operations');assert.equal(html.status,200);assert.match(html.body,/id="mofa-start"[^>]*disabled/);assert.match(html.body,/تجربة دخول فقط دون مستندات أو تقديم طلب/);
  assert.match(html.headers['content-security-policy'],/connect-src 'self'/);assert.match(html.headers['content-security-policy'],/frame-ancestors 'none'/);assert.doesNotMatch(html.headers['content-security-policy'],/script-src[^;]*unsafe-inline/);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});}
});
