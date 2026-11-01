'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const nativeFork=cp.fork,hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'optical-child-config.json'),'utf8'));
const {blocked}=require('./offline-loopback-guard.cjs');
const exact=(actual,expected)=>JSON.stringify(actual)===JSON.stringify(expected);
cp.fork=function(module,args,options){
 const expected={execArgv:[],env:{NODE_ENV:'production',LANG:'C',TZ:'UTC'},stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'};
 if(process.env.ISOLATED_OPTICAL_SCOPE!==cfg.testSha256||hash(fs.readFileSync(cfg.test))!==cfg.testSha256||module!==cfg.worker||hash(fs.readFileSync(cfg.worker))!==cfg.workerSha256||hash(fs.readFileSync(cfg.tesseractWorker))!==cfg.tesseractWorkerSha256||!exact(args,[])||!exact(options,expected))return blocked('optical-fork-rejected','fork');
 const fence=path.join(__dirname,'offline-optical-child-guard.cjs');
 if(process.env.ISOLATED_OPTICAL_ALLOW_LOG)fs.appendFileSync(process.env.ISOLATED_OPTICAL_ALLOW_LOG,JSON.stringify({kind:'exact-optical-worker-fork',worker:cfg.worker,workerSha256:cfg.workerSha256,childFenceSha256:hash(fs.readFileSync(fence)),originalProductionOptionsValidated:true,testInstrumentation:'required child network/process fence; safe evidence log paths only added to child env'})+'\n');
 return nativeFork(module,args,{...options,execArgv:['--require',fence],env:{...options.env,OFFLINE_GUARD_LOG:process.env.OFFLINE_GUARD_LOG,ISOLATED_OPTICAL_BOOT_LOG:process.env.ISOLATED_OPTICAL_BOOT_LOG}});
};
