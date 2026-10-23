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
 return env.ASSISTANT_STATE_PATH||(persistentMount(STATE_FILE,info)?STATE_FILE:undefined);
}
module.exports={STATE_MOUNT,STATE_FILE,persistentMount,defaultStateFile};
