'use strict';
const {spawn}=require('node:child_process');
const MAX_BYTES=3*1024*1024;
// Fixed executable and pipe-only protocol: neither filenames nor URLs from the
// customer enter ffmpeg. One audio stream, one thread, bounded input/output/time.
function oggToMp3(bytes,{spawnImpl=spawn,timeoutMs=8000}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>MAX_BYTES||bytes.subarray(0,4).toString()!=='OggS')return Promise.reject(Error('VOICE_AUDIO_CONVERSION_FAILED'));
 return new Promise((resolve,reject)=>{
  let child,timer,settled=false,size=0;const parts=[];
  const fail=()=>{if(settled)return;settled=true;clearTimeout(timer);for(const b of parts)b.fill(0);try{child?.kill('SIGKILL');}catch{}reject(Error('VOICE_AUDIO_CONVERSION_FAILED'));};
  try{child=spawnImpl('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-max_alloc','33554432','-protocol_whitelist','pipe','-threads','1','-f','ogg','-i','pipe:0','-map','0:a:0','-vn','-sn','-dn','-ac','1','-ar','16000','-c:a','libmp3lame','-b:a','48k','-threads','1','-f','mp3','pipe:1'],{stdio:['pipe','pipe','ignore'],windowsHide:true});}catch{return fail();}
  timer=setTimeout(fail,Math.min(8000,Math.max(1,Number(timeoutMs)||8000)));timer.unref?.();
  child.once('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
  child.stdout.on('data',part=>{if(settled)return;size+=part.length;if(size>MAX_BYTES)return fail();parts.push(Buffer.from(part));});
  child.once('close',code=>{if(settled)return;if(code!==0||!size)return fail();const out=Buffer.concat(parts,size);for(const b of parts)b.fill(0);if(!(out.subarray(0,3).toString()==='ID3'||out[0]===255&&(out[1]&224)===224)){out.fill(0);return fail();}settled=true;clearTimeout(timer);resolve(out);});
  child.stdin.end(bytes);
 });
}
module.exports={oggToMp3};
