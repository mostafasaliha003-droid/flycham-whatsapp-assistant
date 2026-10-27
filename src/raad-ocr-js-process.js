'use strict';
// A killable process isolates local OCR and can be interrupted on deadline.
// The IPC protocol accepts one image and yields only a boolean, never OCR text.
const {fork}=require('node:child_process');
const path=require('node:path');
function createLocalOcrProcess({forkImpl=fork}={}){
 let child=null,sequence=0,pending=null,closed=false,reaped=Promise.resolve(true);
 function stop(){if(closed)return;closed=true;const c=child;child=null;if(c){try{c.kill('SIGKILL');}catch{}}if(pending){const p=pending;pending=null;p.cleanup();p.reject(Error('OCR_UNAVAILABLE'));}}
 function start(){
  if(child)return;child=forkImpl(path.join(__dirname,'raad-ocr-js-worker.js'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',execArgv:['--max-old-space-size=160'],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
  reaped=new Promise(resolve=>child.once('exit',()=>resolve(true)));child.on('error',()=>stop());child.on('exit',()=>stop());child.on('message',m=>{if(!pending||!m||m.id!==pending.id)return;const p=pending;pending=null;p.cleanup();m.ok===true&&typeof m.match==='boolean'?p.resolve(m.match):p.reject(Error('OCR_UNAVAILABLE'));});
 }
 function recognize(png,{signal}={}){
  if(closed||pending||!Buffer.isBuffer(png)||png.length>10*1024*1024||signal?.aborted)return Promise.reject(Error('OCR_UNAVAILABLE'));
  try{start();}catch{stop();return Promise.reject(Error('OCR_UNAVAILABLE'));}
  return new Promise((resolve,reject)=>{const id=++sequence;const abort=()=>stop();const cleanup=()=>signal?.removeEventListener('abort',abort);pending={id,resolve,reject,cleanup};signal?.addEventListener('abort',abort,{once:true});try{child.send({type:'recognize',id,png},e=>{if(e&&pending?.id===id)stop();});}catch{stop();}});
 }
 async function close(){stop();let timer;const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000);});try{return await Promise.race([reaped,expired]);}finally{clearTimeout(timer);}}
 return{recognize,close};
}
module.exports={createLocalOcrProcess};
