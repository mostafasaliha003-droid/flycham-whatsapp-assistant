'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const nativeSpawn=cp.spawn,read=fs.readFileSync.bind(fs),real=fs.realpathSync.bind(fs),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const cfg=JSON.parse(read(path.join(__dirname,'durable-child-config.json'),'utf8'));
require('./offline-loopback-guard.cjs');
function deny(){return require('./offline-loopback-guard.cjs').blocked('durable-child-rejected','spawn');}
if(process.env.ISOLATED_DURABLE_BUDGET_CHILD!=='1')cp.spawn=function(command,args,options){
 try{
  if(real(command)!==real(process.execPath)||!Array.isArray(args)||args.length!==4||args[0]!=='-e'||typeof args[1]!=='string'||hash(args[1])!==cfg.scriptSha256||args[2]!==cfg.module||hash(read(cfg.module))!==cfg.moduleSha256)deny();
  if(!options||Object.keys(options).join(',')!=='stdio'||JSON.stringify(options.stdio)!==JSON.stringify(['ignore','pipe','pipe','ipc']))deny();
  const c=JSON.parse(args[3]),keys=Object.keys(c).sort().join(',');
  if(keys!==['file','key','policyFingerprint','capUsd','persistentStateConfirmed'].sort().join(',')||c.key!=='synthetic-durable-budget-state-key-only'||c.policyFingerprint!==cfg.policy||c.capUsd!==2||c.persistentStateConfirmed!==true||typeof c.file!=='string'||!path.isAbsolute(c.file)||path.basename(c.file)!=='budget.enc')deny();
  const temp=real(process.env.TMPDIR),parent=real(path.dirname(c.file));if(!parent.startsWith(temp+path.sep)||!/^mrz-durable-budget-[A-Za-z0-9]+$/.test(path.basename(parent)))deny();
  if(process.env.ISOLATED_DURABLE_ALLOW_LOG)fs.appendFileSync(process.env.ISOLATED_DURABLE_ALLOW_LOG,JSON.stringify({kind:'exact-synthetic-budget-child'})+'\n');
  return nativeSpawn(command,args,{stdio:options.stdio,env:{...process.env,ISOLATED_DURABLE_BUDGET_CHILD:'1'}});
 }catch(error){if(error?.code==='ISOLATED_DURABLE_CHILD_REJECTED')throw error;return deny();}
};
