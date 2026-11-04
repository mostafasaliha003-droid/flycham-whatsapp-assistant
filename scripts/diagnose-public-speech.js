'use strict';
// Supplemental human-speech diagnostic. Google FLEURS ar_eg/test rows 0–2,
// CC BY 4.0: https://huggingface.co/datasets/google/fleurs . Never customer audio.
// Does not replace the owner's specified Levantine travel-phrase acceptance test.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {CLINEPASS_MODELS}=require('../src/cline-pass-models');
const {probeCline,wordErrorRate}=require('./probe-voice-models');
const {callGemini,transcribeVoice,DEFAULT_GEMINI_VOICE_MODEL}=require('../src/voice-transcription');
const SOURCE='https://datasets-server.huggingface.co/rows?dataset=google%2Ffleurs&config=ar_eg&split=test&offset=0&length=3';
const HASHES=['40d979a6239fc08951f387c671fb5fc46fffdc5df823ed1dbdb809bc75e26620','318e95704f15e5050d5f3703172415c5e9d7f83495c3589590e8c4ca8b2628f6','cca59df14be2fc8fd0f064dd7ad524878db5e976b03634db7833f0268e18a058'];
const REPORT=path.join(__dirname,'../docs/public-speech-diagnostic-2026-11.json');
async function bounded(url,max){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('SAMPLE_HTTP_'+r.status);let size=0,parts=[];for await(const p of r.body){size+=p.length;if(size>max)throw Error('SAMPLE_TOO_LARGE');parts.push(Buffer.from(p));}return Buffer.concat(parts);}
function encode(wav,format){const r=spawnSync('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-max_alloc','33554432','-protocol_whitelist','pipe','-threads','1','-f','wav','-i','pipe:0','-map','0:a:0','-vn','-sn','-dn','-ac','1','-ar','16000','-c:a',format==='ogg'?'libopus':'libmp3lame','-b:a',format==='ogg'?'24k':'48k','-threads','1','-f',format,'pipe:1'],{input:wav,timeout:8000,maxBuffer:3*1024*1024,windowsHide:true});if(r.status!==0)throw Error('SAMPLE_CONVERSION_FAILED');return r.stdout;}
async function run(){
 if(!process.env.CLINE_API_KEY||!process.env.GEMINI_API_KEY)throw Error('MISSING_CREDENTIALS');
 const env={CLINE_API_KEY:process.env.CLINE_API_KEY,GEMINI_API_KEY:process.env.GEMINI_API_KEY},samples=[],result={state:'preparing',source:'https://huggingface.co/datasets/google/fleurs',license:'CC-BY-4.0',config:'ar_eg',split:'test',hashes:HASHES,rows:[],qualified:[]};
 const save=()=>fs.writeFileSync(REPORT,JSON.stringify(result,null,2));
 try{
  const data=JSON.parse((await bounded(SOURCE,131072)).toString());if(data.rows?.length!==3)throw Error('SAMPLE_COUNT');
  for(const item of data.rows){
   const index=item.row_idx,row=item.row,u=new URL(row.audio?.[0]?.src);if(index!==samples.length||u.origin!=='https://datasets-server.huggingface.co'||!u.pathname.startsWith('/cached-assets/google/fleurs/')||row.language!=='Arabic'||typeof row.raw_transcription!=='string'||row.raw_transcription.length>1500)throw Error('SAMPLE_SOURCE');
   const wav=await bounded(u,3*1024*1024);try{if(createHash('sha256').update(wav).digest('hex')!==HASHES[index])throw Error('SAMPLE_HASH');const sample={index,reference:row.raw_transcription,formats:[]};samples.push(sample);for(const format of ['mp3','ogg'])sample.formats.push({format,mimeType:format==='mp3'?'audio/mpeg':'audio/ogg',bytes:encode(wav,format)});}finally{wav.fill(0);}
  }
  result.state='running';save();
  async function evaluate(model,sample,format,pipeline=false){
   const provider=model.startsWith('cline-pass/')?'cline':'gemini',start=Date.now();let wer=null,error=null;
   try{
    const opts={...format,env:{...env,...(provider==='cline'?{CLINE_AUDIO_MODEL:model,VOICE_TRANSCRIPTION_PROVIDERS:'cline'}:{VOICE_GEMINI_MODEL:model,VOICE_TRANSCRIPTION_PROVIDERS:'gemini'})},fetchImpl:fetch,timeoutMs:25000};
    const value=pipeline?await transcribeVoice(opts):await(provider==='cline'?probeCline(model,opts):callGemini(opts));
    if(pipeline&&!value.ok){error=value.errors?.find(e=>/VOICE_HTTP_(401|402|429)/.test(e))?.split(':').at(-1)||'VOICE_PIPELINE_'+String(value.reason).toUpperCase();}else wer=(pipeline?value.ok:value.clear)?wordErrorRate(sample.reference,value.transcript):1;
   }catch(e){error=/^(?:VOICE|SAMPLE)_[A-Z0-9_]+$/.test(e.message)?e.message:['TimeoutError','AbortError'].includes(e.name)?'VOICE_TIMEOUT':'VOICE_REQUEST_FAILED';}
   const row={model,provider,sample:sample.index,format:format.format,pipeline,wer,error,latencyMs:Date.now()-start};result.rows.push(row);console.log(JSON.stringify(row));save();if(/^VOICE_HTTP_(401|402|429)$/.test(error||'')){result.state='blocked_auth_or_quota';save();throw Error('STOP_AUTH_OR_QUOTA');}return row;
  }
  for(const model of [...CLINEPASS_MODELS,DEFAULT_GEMINI_VOICE_MODEL])for(const format of samples[0].formats)await evaluate(model,samples[0],format);
  const candidates=[...new Set(result.rows.filter(r=>r.format==='mp3'&&r.wer!==null&&r.wer<=.15&&!r.error).map(r=>r.model))];
  for(const model of candidates)for(const sample of samples)for(const format of sample.formats)await evaluate(model,sample,format,true);
  result.qualified=candidates.filter(model=>{const rows=result.rows.filter(r=>r.model===model&&r.pipeline);return rows.length===6&&rows.every(r=>r.wer!==null&&r.wer<=.15&&!r.error);});result.state='completed';save();console.log(JSON.stringify({state:result.state,qualified:result.qualified,requests:result.rows.length}));return result;
 }finally{for(const sample of samples)for(const format of sample.formats)format.bytes.fill(0);}
}
if(require.main===module)run().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'PUBLIC_SPEECH_DIAGNOSTIC_FAILED');process.exitCode=1;});
module.exports={HASHES,encode,run};
