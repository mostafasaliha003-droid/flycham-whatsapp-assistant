'use strict';
const {spawnSync}=require('node:child_process');
// Generated signals only: these exercise decoding, never speech accuracy.
function wav({silent=false,seconds=1}={}){
 const samples=Math.round(8000*seconds),b=Buffer.alloc(44+samples*2);
 b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);
 if(!silent)for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(5000*Math.sin(i*2*Math.PI*440/8000)),44+i*2);
 return b;
}
function encoded(format,options={}){
 const input=wav(options),r=spawnSync('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','wav','-i','pipe:0','-ac','1','-ar','16000','-c:a',format==='ogg'?'libopus':'libmp3lame','-b:a',format==='ogg'?'24k':'48k','-f',format,'pipe:1'],{input,timeout:8000,maxBuffer:3*1024*1024,windowsHide:true});input.fill(0);
 if(r.status!==0)throw Error('VOICE_FIXTURE_ENCODING_FAILED');return r.stdout;
}
module.exports={wav,encoded};
