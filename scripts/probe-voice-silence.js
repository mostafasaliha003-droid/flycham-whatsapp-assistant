'use strict';
// Negative transport probe only. Inputs must be locally generated ten-second
// silence, never customer audio. This cannot measure speech accuracy or WER.
const fs=require('node:fs'),path=require('node:path');
const {CLINEPASS_MODELS}=require('../src/cline-pass-models');
const {probeCline}=require('./probe-voice-models');
const {callGemini,DEFAULT_GEMINI_VOICE_MODEL}=require('../src/voice-transcription');
const REPORT=path.join(__dirname,'../docs/voice-silence-probe-2026-11.md');
function loadSample(file,format){
 const size=fs.statSync(file).size;if(!size||size>3*1024*1024)throw Error('VOICE_SAMPLE_INVALID');
 const bytes=fs.readFileSync(file);
 if(bytes.length!==size||format==='ogg'&&bytes.subarray(0,4).toString()!=='OggS'||format==='mp3'&&!(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)){bytes.fill(0);throw Error('VOICE_SAMPLE_INVALID');}
 return {bytes,format,mimeType:format==='mp3'?'audio/mpeg':'audio/ogg'};
}
function render(result){return '# Voice silence probe — November 2026\n\nStatus: **'+result.state+'**.\n\nInput: ten seconds of generated silence in MP3 and OGG. This probes provider transport and the negative requirement to reject missing speech. It does not measure dialect recognition, WER or owner-sample acceptance, and cannot select an audio model.\n\n| Provider/model | Format | Rejected silence correctly | Latency ms | Error |\n|---|---|---|---:|---|\n'+result.rows.map(r=>`| ${r.model} | ${r.format} | ${r.rejectedSilence===null?'Not measured':r.rejectedSilence?'Yes':'No'} | ${r.latencyMs} | ${r.error||'—'} |`).join('\n')+'\n\nNo audio, transcripts, keys or customer records are included in this report. HTTP 401/402/429 stops all remaining requests. No production model or provider settings are changed. The owner-recorded speech probe remains required.\n';}
async function runSilenceProbe({mp3,ogg,env=process.env,fetchImpl=fetch,now=Date.now,write=text=>fs.writeFileSync(REPORT,text),progress=()=>{}}={}){
 const result={state:'running',rows:[]};const save=()=>{write(render(result));return result;};
 if(!mp3||!ogg){result.state='blocked_missing_generated_silence';return save();}
 if(!env.CLINE_API_KEY||!env.GEMINI_API_KEY){result.state='blocked_missing_credentials';return save();}
 const samples=[];
 try{
  samples.push(loadSample(mp3,'mp3'));samples.push(loadSample(ogg,'ogg'));
  for(const provider of ['cline','gemini'])for(const model of provider==='cline'?CLINEPASS_MODELS:[env.VOICE_GEMINI_MODEL||DEFAULT_GEMINI_VOICE_MODEL])for(const sample of samples){
   const started=now();let rejectedSilence=null,error=null;
   try{const value=await(provider==='cline'?probeCline(model,{...sample,env,fetchImpl}):callGemini({...sample,env,fetchImpl,timeoutMs:25000}));rejectedSilence=value.clear===false&&value.transcript==='';}
   catch(e){error=/^VOICE_[A-Z0-9_]{1,80}$/.test(e?.message||'')?e.message:['TimeoutError','AbortError'].includes(e?.name)?'VOICE_TIMEOUT':'VOICE_REQUEST_FAILED';}
   const row={provider,model,format:sample.format,rejectedSilence,latencyMs:now()-started,error};result.rows.push(row);progress(row);
   if(/^VOICE_HTTP_(401|402|429)$/.test(error||'')){result.state='blocked_auth_or_quota';return save();}save();
  }result.state='completed';return save();
 }finally{for(const sample of samples)sample.bytes.fill(0);}
}
if(require.main===module)runSilenceProbe({mp3:process.argv[2],ogg:process.argv[3],progress:r=>console.log(JSON.stringify(r))}).then(r=>{console.log(JSON.stringify({state:r.state,requests:r.rows.length}));if(r.state!=='completed')process.exitCode=2;}).catch(()=>{console.error('VOICE_SILENCE_PROBE_FAILED');process.exitCode=1;});
module.exports={runSilenceProbe,loadSample,render};
