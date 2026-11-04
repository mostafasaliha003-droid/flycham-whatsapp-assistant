'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {inspectAudio}=require('../src/voice-audio-conversion');
const {transcribeVoice,callGemini,DEFAULT_GEMINI_VOICE_MODEL}=require('../src/voice-transcription');
const {wav,encoded}=require('./helpers/voice-fixtures');
const env={GEMINI_API_KEY:'synthetic',VOICE_TRANSCRIPTION_PROVIDERS:'gemini'};
test('real MP3 and OGG silence is blocked before any provider; non-silent signals still require model interpretation',async()=>{
 for(const format of ['mp3','ogg']){
  const mimeType=format==='ogg'?'audio/ogg':'audio/mpeg';let calls=0;
  for(const silent of [true,false]){
   const bytes=encoded(format,{silent}),original=Buffer.from(bytes);
   const r=await transcribeVoice({bytes,mimeType,env,fetchImpl:async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"clear":false,"transcript":""}'}]}}]});}});
   assert.equal(r.reason,'unclear');assert.equal(calls,silent?0:1);assert.deepEqual(bytes,original);bytes.fill(0);original.fill(0);
  }
 }
});
test('invalid, empty, overlong decoded audio and inspection failures fail closed without network calls',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('UNEXPECTED_PROVIDER_CALL');};
 const invalid=await transcribeVoice({bytes:Buffer.from('ID3-invalid'),mimeType:'audio/mpeg',env,fetchImpl});assert.equal(invalid.reason,'unavailable');
 const tooLong=await transcribeVoice({bytes:wav({seconds:121}),mimeType:'audio/wav',env,fetchImpl});assert.equal(tooLong.reason,'too_long');
 for(const inspectImpl of [async()=>null,async()=>{throw Error('PRIVATE_DETAIL');}]){
  const r=await transcribeVoice({bytes:wav(),mimeType:'audio/wav',env,fetchImpl,inspectImpl});assert.deepEqual(r,{ok:false,reason:'unavailable',errors:['audio:VOICE_AUDIO_INSPECTION_FAILED']});
 }
 assert.equal(calls,0);
});
test('audio inspection bounds subprocess time and output, wipes decoded buffers and uses pipe-only fixed demuxers',async()=>{
 let killed=false,emitted,argv,opts;const input=wav();
 function fake(mode){return (exe,args,options)=>{
  assert.equal(exe,'/usr/bin/ffmpeg');argv=args;opts=options;const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.kill=()=>{killed=true;};
  c.stdin.on('finish',()=>{if(mode==='wait')return;emitted=Buffer.alloc(mode==='large'?120*8000*2+2:16,0);if(mode==='tone')emitted.writeInt16LE(1000);c.stdout.write(emitted);if(mode!=='large')c.emit('close',0);});return c;
 };}
 assert.deepEqual(await inspectAudio(input,{mimeType:'audio/wav',spawnImpl:fake('tone')}),{silent:false});assert.ok(emitted.every(x=>x===0));assert.equal(argv[argv.indexOf('-protocol_whitelist')+1],'pipe');assert.equal(argv[argv.indexOf('-f')+1],'wav');assert.equal(argv[argv.indexOf('-t')+1],'121');assert.deepEqual(opts.stdio,['pipe','pipe','ignore']);
 await assert.rejects(inspectAudio(input,{mimeType:'audio/wav',spawnImpl:fake('large')}),/VOICE_AUDIO_TOO_LONG/);assert.equal(killed,true);assert.ok(emitted.every(x=>x===0));
 const keepAlive=setInterval(()=>{},10);try{await assert.rejects(inspectAudio(input,{mimeType:'audio/wav',spawnImpl:fake('wait'),timeoutMs:10}),/VOICE_AUDIO_INSPECTION_FAILED/);}finally{clearInterval(keepAlive);}
 await assert.rejects(inspectAudio(input,{mimeType:'audio/evil'}),/VOICE_AUDIO_INSPECTION_FAILED/);
});
test('Gemini voice default uses verified current model while preserving explicit configuration',async()=>{
 for(const model of [undefined,'gemini-3.8-flash']){
  let url;await callGemini({bytes:wav(),mimeType:'audio/wav',env:{...env,...(model?{VOICE_GEMINI_MODEL:model}:{})},timeoutMs:500,fetchImpl:async u=>{url=u;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"clear":false,"transcript":""}'}]}}]});}});assert.ok(url.endsWith('/'+(model||DEFAULT_GEMINI_VOICE_MODEL)+':generateContent'));
 }
});
