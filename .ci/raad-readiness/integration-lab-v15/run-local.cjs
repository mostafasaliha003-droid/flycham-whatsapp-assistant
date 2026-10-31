'use strict';
// Portable, opt-in LOCAL synthetic lab. No source copy, credential loader or deploy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {verifyApprovedSource}=require('./lab-boundary.cjs');
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
function fail(code){throw Error(code);}
function durable(file,raw){fs.writeFileSync(file,raw,{mode:0o600});const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(!fs.readFileSync(file).equals(Buffer.from(raw)))fail('LAB_EVIDENCE_READBACK_FAILED');}
function main(){
 const arguments_=process.argv.slice(2),options={};
 for(let i=0;i<arguments_.length;i++){const arg=arguments_[i];if(arg==='--run-local-synthetic')options.run=true;else if(['--source','--freeze'].includes(arg)){if(options[arg]||!arguments_[i+1]||arguments_[i+1].startsWith('--'))fail('LAB_ARGUMENT_INVALID');options[arg]=arguments_[++i];}else fail('LAB_ARGUMENT_INVALID');}
 if(options.run!==true||process.env.INTEGRATION_LAB_LOCAL_ENABLED!=='true'){process.stdout.write(JSON.stringify({status:'disabled',realMetaWired:false,governmentWired:false,publicServer:false,sourceCommit:'2167d5f87fce8f2cf05de1c96e367a8a57ce7402'})+'\n');return;}
 const approved=verifyApprovedSource({source:options['--source'],freeze:options['--freeze']}),APP=approved.source;
 const directory=fs.mkdtempSync(path.join(__dirname,'router-gated-run-'));fs.mkdirSync(path.join(directory,'tmp'));
 const guard=path.join(APP,'.ci/raad-readiness/test-tools/offline-loopback-guard.cjs');
 const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',TMPDIR:path.join(directory,'tmp'),LANG:'C.UTF-8',TZ:'UTC',NODE_ENV:'test',NODE_OPTIONS:'--require '+guard,OFFLINE_GUARD_LOG:path.join(directory,'blocked-attempts.jsonl'),INTEGRATION_LAB_SOURCE:approved.source,INTEGRATION_LAB_FREEZE:approved.freeze};
 const command=['--test','--test-reporter=tap','--test-isolation=none',path.join(__dirname,'router-gated.test.cjs')];
 const result=cp.spawnSync(process.execPath,command,{cwd:APP,env,encoding:'utf8',timeout:35000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
 const raw=Buffer.from((result.stdout||'')+(result.stderr||''));durable(path.join(directory,'router-gated.tap'),raw);verifyApprovedSource(approved);
 const text=raw.toString(),counts={};for(const key of ['tests','pass','fail','cancelled','skipped','todo']){const matches=[...text.matchAll(new RegExp('^# '+key+' (\\d+)$','gm'))];counts[key]=matches.length?Number(matches.at(-1)[1]):null;}
 const blockedFile=path.join(directory,'blocked-attempts.jsonl'),blocked=fs.existsSync(blockedFile)?fs.readFileSync(blockedFile,'utf8').trim().split('\n').filter(Boolean).length:0;
 const success=result.status===0&&!result.error&&counts.tests===1&&counts.pass===1&&['fail','cancelled','skipped','todo'].every(k=>counts[k]===0)&&blocked===0;
 const meta={kind:'new_gate_transport_actual_router_synthetic_scenario',success,exitCode:result.status,timedOut:result.error?.code==='ETIMEDOUT',counts,blockedAttempts:blocked,stdoutEof:true,logBytes:raw.length,logSha256:sha(raw),sourceCommit:'2167d5f87fce8f2cf05de1c96e367a8a57ce7402',sourceTree:approved.manifest.candidateTree,sourceFilesVerifiedBeforeAfter:445,applicationFingerprintSha256:approved.manifest.applicationFingerprintSha256,nodeVersion:process.version,realMetaWired:false,governmentWired:false,gateAndTransportWiredToActualLoopbackRouters:true,browserLaunchesExpected:0,providerAndCustomerCalls:0,productionMutations:0,scope:'New gate+transport scenario with actual main/worker HTTP routers; fake Graph and injected synthetic portal; no real government integration.',fullSuiteRerun:false,output:directory};
 durable(path.join(directory,'result.json'),JSON.stringify(meta,null,2)+'\n');process.stdout.write(JSON.stringify(meta)+'\n');if(!success)process.exitCode=1;
}
try{main();}catch(error){process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(error?.message||'')?error.message:'LAB_RUN_FAILED')+'\n');process.exitCode=1;}
