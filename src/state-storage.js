'use strict';
const fs=require('node:fs'),path=require('node:path');
const STATE_MOUNT='/var/data';
const STATE_FILE=STATE_MOUNT+'/assistant-state.enc';
function mountInfo(){try{return fs.readFileSync('/proc/self/mountinfo','utf8');}catch{return '';}}
function persistentMount(file,info=mountInfo()){
 if(!file)return false;
 const resolved=path.resolve(file);
 return info.split('\n').some(line=>{
  const [left,right]=line.split(' - ');if(!right)return false;
  const mount=left.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,v)=>String.fromCharCode(parseInt(v,8)));
  const type=right.split(' ')[0];
  return mount===STATE_MOUNT&&['ext4','xfs','btrfs'].includes(type)&&resolved.startsWith(mount+'/');
 });
}
// Only opt in automatically when the documented disk mount actually exists.
// Creating an ordinary /var/data directory is not evidence of persistent storage.
function defaultStateFile(env=process.env,info=mountInfo()){
 if(env===process.env&&process.env.NODE_TEST_CONTEXT){
  const file=env.ASSISTANT_STATE_PATH;
  assertTestStatePath(file);
  return file||undefined;
 }
 return env.ASSISTANT_STATE_PATH||(persistentMount(STATE_FILE,info)?STATE_FILE:undefined);
}
function assertTestStatePath(file){
 if(!process.env.NODE_TEST_CONTEXT||!file)return;
 const root=process.env.REMAL_TEST_ROOT;
 const relative=root&&path.isAbsolute(root)?path.relative(root,path.resolve(file)):null;
 if(relative===null||!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){
  throw Error('TEST_STATE_ISOLATION_REQUIRED: use npm test with temporary storage');
 }
}
module.exports={STATE_MOUNT,STATE_FILE,persistentMount,defaultStateFile,assertTestStatePath};
