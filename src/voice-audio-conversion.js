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
// Decode locally before contacting any model. This rejects digital/near silence;
// it is deliberately not a claim that every non-silent signal is human speech.
const DEMUXERS=Object.freeze({'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'mov','audio/wav':'wav','audio/x-wav':'wav'});
const MAX_PCM_BYTES=120*8000*2;
function inspectAudio(bytes,{mimeType,spawnImpl=spawn,timeoutMs=8000}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES||!DEMUXERS[mimeType])return Promise.reject(Error('VOICE_AUDIO_INSPECTION_FAILED'));
 return new Promise((resolve,reject)=>{
  let child,timer,settled=false,size=0;const parts=[];
  const wipe=()=>{for(const b of parts)b.fill(0);parts.length=0;};
  const fail=(reason='VOICE_AUDIO_INSPECTION_FAILED')=>{if(settled)return;settled=true;clearTimeout(timer);wipe();try{child?.kill('SIGKILL');}catch{}reject(Error(reason));};
  try{child=spawnImpl('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-max_alloc','33554432','-protocol_whitelist','pipe','-threads','1','-f',DEMUXERS[mimeType],'-i','pipe:0','-map','0:a:0','-vn','-sn','-dn','-t','121','-ac','1','-ar','8000','-c:a','pcm_s16le','-threads','1','-f','s16le','pipe:1'],{stdio:['pipe','pipe','ignore'],windowsHide:true});}catch{return fail();}
  timer=setTimeout(()=>fail(),Math.min(8000,Math.max(1,Number(timeoutMs)||8000)));timer.unref?.();
  child.once('error',()=>fail());child.stdin.on('error',()=>fail());child.stdout.on('error',()=>fail());
  child.stdout.on('data',part=>{if(settled){part.fill(0);return;}size+=part.length;if(size>MAX_PCM_BYTES){part.fill(0);return fail('VOICE_AUDIO_TOO_LONG');}parts.push(Buffer.from(part));part.fill(0);});
  child.once('close',code=>{
   if(settled)return;if(code!==0||!size||size%2)return fail();
   const pcm=Buffer.concat(parts,size);wipe();let peak=0;
   for(let i=0;i<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)));
   pcm.fill(0);settled=true;clearTimeout(timer);resolve({silent:peak<=32});
  });
  child.stdin.end(bytes);
 });
}
module.exports={oggToMp3,inspectAudio};
