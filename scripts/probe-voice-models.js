'use strict';
// Usage: node scripts/probe-voice-models.js synthetic.mp3 synthetic.ogg
// The two files must contain only the fixed synthetic reference below.
const fs=require('node:fs'),path=require('node:path');
const {CLINEPASS_MODELS}=require('../src/cline-pass-models');
const {INSTRUCTIONS,parse,callGemini}=require('../src/voice-transcription');
const {normalize}=require('../src/saudi-visa-policy');
const REFERENCE='بدي من الشارقة للشام الجمعة الجاية أنا ومرتي بدون عفش';
const REPORT=path.join(__dirname,'../docs/voice-model-probe-2026-11.md');
function words(s){return normalize(s).replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean);}
function wordErrorRate(reference,transcript){const a=words(reference),b=words(transcript);if(!a.length)throw Error('VOICE_REFERENCE_EMPTY');let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+Number(a[i-1]!==b[j-1]));row=next;}return row[b.length]/a.length;}
async function boundedJson(response){let size=0,parts=[];if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')throw Error('VOICE_RESPONSE_STREAM_REQUIRED');for await(const part of response.body){size+=part.length;if(size>65536)throw Error('VOICE_RESPONSE_TOO_LARGE');parts.push(Buffer.from(part));}return JSON.parse(Buffer.concat(parts).toString());}
async function probeCline(model,{bytes,format,env,fetchImpl=fetch}){
 const response=await fetchImpl('https://api.cline.bot/api/v1/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers:{Authorization:'Bearer '+env.CLINE_API_KEY,'Content-Type':'application/json','X-Response-Format':'openai'},body:JSON.stringify({model,stream:false,temperature:0,max_tokens:1200,messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:[{type:'input_audio',input_audio:{data:bytes.toString('base64'),format}}]}]})});
 if(!response.ok)throw Error('VOICE_HTTP_'+response.status);const data=await boundedJson(response),c=(data.choices?data:data.data)?.choices?.[0];if(c?.finish_reason!=='stop')throw Error('VOICE_INCOMPLETE');return parse(c.message?.content);
}
function report({state,rows,recommendation}){
 return '# Voice model probe — November 2026\n\nStatus: **'+state+'**.\n\nSynthetic reference: '+REFERENCE+'\n\n| Provider/model | Format | WER | Latency ms | Supports sample | Error |\n|---|---|---:|---:|---|---|\n'+rows.map(r=>`| ${r.model} | ${r.format} | ${r.wer===null?'Not measured':(r.wer*100).toFixed(1)+'%'} | ${r.latencyMs??'Not measured'} | ${r.supported?'Yes':'No'} | ${r.error||'—'} |`).join('\n')+'\n\nRecommendation: **'+(recommendation||'none — no verified audio result')+'**.\n\nA model qualifies only with WER <= 15%. The runner tests both MP3 and OGG, stops on HTTP 401/402/429, and writes no audio bytes, credentials or returned transcripts. A single sample measures only this phrase. No production settings are changed.\n\nRun with the existing credentials: `node scripts/probe-voice-models.js /path/synthetic.mp3 /path/synthetic.ogg`. Both samples must be the owner-recorded 10-second synthetic phrase above, without customer data.\n\nProduction OGG routes to Gemini unless a later approved change adds verified OGG support or a bounded conversion. Cline audio requires an approved CLINE_AUDIO_MODEL. No server-side ffmpeg availability or Cline OGG support has been verified in this run.\n\nProtocol references: [Cline Chat Completions](https://github.com/cline/cline/blob/main/docs/api/chat-completions.mdx), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio). Documentation does not establish support by any particular Cline subscription model.\n';
}
async function runProbe({mp3,ogg,env=process.env,fetchImpl=fetch,now=Date.now,write=text=>fs.writeFileSync(REPORT,text)}={}){
 let state='running',rows=[];
 const finish=()=>{const supported=rows.filter(r=>r.supported),cline=supported.filter(r=>r.provider==='cline'&&r.format==='mp3').sort((a,b)=>a.wer-b.wer||a.latencyMs-b.latencyMs)[0],gemini=supported.find(r=>r.provider==='gemini'&&r.format==='ogg');
  const recommendation=state==='completed'?(cline?'CLINE_AUDIO_MODEL='+cline.model+(gemini?'; OGG fallback: Gemini':''):gemini?'VOICE_TRANSCRIPTION_PROVIDERS=gemini':null):null;
  const result={state,rows,recommendation};write(report(result));return result;};
 if(!mp3||!ogg){state='blocked_missing_synthetic_mp3_and_ogg';return finish();}
 if(!env.CLINE_API_KEY||!env.GEMINI_API_KEY){state='blocked_missing_runtime_credentials';return finish();}
 const samples=[{format:'mp3',mimeType:'audio/mpeg',bytes:fs.readFileSync(mp3)},{format:'ogg',mimeType:'audio/ogg',bytes:fs.readFileSync(ogg)}];
 try{
  for(const s of samples)if(!s.bytes.length||s.bytes.length>3*1024*1024||s.format==='ogg'&&s.bytes.subarray(0,4).toString()!=='OggS'||s.format==='mp3'&&!(s.bytes.subarray(0,3).toString()==='ID3'||s.bytes[0]===255&&(s.bytes[1]&224)===224))throw Error('VOICE_SAMPLE_INVALID');
  for(const provider of ['cline','gemini'])for(const model of provider==='cline'?CLINEPASS_MODELS:[env.VOICE_GEMINI_MODEL||'gemini-2.5-flash'])for(const sample of samples){
   const started=now();let result,wer=null,error=null;
   try{result=await (provider==='cline'?probeCline(model,{...sample,env,fetchImpl}):callGemini({...sample,env,fetchImpl,timeoutMs:25000}));wer=result.clear?wordErrorRate(REFERENCE,result.transcript):1;}catch(e){error=/^VOICE_[A-Z0-9_]+$/.test(e?.message||'')?e.message:'VOICE_REQUEST_FAILED';}
   rows.push({provider,model,format:sample.format,wer,latencyMs:now()-started,supported:wer!==null&&wer<=.15,error});
   if(/^VOICE_HTTP_(401|402|429)$/.test(error||'')){state='blocked_auth_or_quota';return finish();}finish();
  }state='completed';return finish();
 }finally{for(const s of samples)s.bytes.fill(0);}
}
if(require.main===module)runProbe({mp3:process.argv[2],ogg:process.argv[3]}).then(r=>{console.log(JSON.stringify({state:r.state,recommendation:r.recommendation,report:'docs/voice-model-probe-2026-11.md'}));if(r.state!=='completed')process.exitCode=2;}).catch(()=>{console.error('VOICE_PROBE_FAILED');process.exitCode=1;});
module.exports={REFERENCE,words,wordErrorRate,probeCline,report,runProbe};
