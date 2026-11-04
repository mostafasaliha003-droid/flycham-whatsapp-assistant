'use strict';
// Voice-note transcription. Audio bytes are sent only to the configured
// provider, never stored in conversation state; the transcript is redacted
// before it reaches Ahmed or Ismail. Failure always yields an honest fallback.
const {oggToMp3}=require('./voice-audio-conversion');
const {CLINEPASS_MODELS}=require('./cline-pass-models');
const {redactVisaText}=require('./saudi-visa-nlu');
const MAX_BYTES=3*1024*1024,MAX_TRANSCRIPT=1500;
const INSTRUCTIONS='Transcribe this WhatsApp customer voice note verbatim in its original language and dialect (usually Levantine, Gulf, Egyptian or Iraqi Arabic). Do not translate, summarise, correct, answer or add any words. Return one JSON object only: {"transcript":string,"clear":boolean}. Set clear=false and transcript="" when speech is missing, music only, or unintelligible.';
const CLINE_FORMATS=new Map([['audio/mpeg','mp3'],['audio/wav','wav'],['audio/x-wav','wav']]);
function parse(output){
 if(typeof output!=='string')throw Error('VOICE_INVALID_OUTPUT');
 let d;try{d=JSON.parse(output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw Error('VOICE_INVALID_JSON');}
 if(!d||typeof d!=='object'||typeof d.clear!=='boolean'||typeof d.transcript!=='string')throw Error('VOICE_INVALID_SCHEMA');
 const transcript=d.transcript.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_TRANSCRIPT);
 if(!d.clear||!/[\u0621-\u064aA-Za-z]{2}/.test(transcript))return {clear:false,transcript:''};
 return {clear:true,transcript};
}
async function responseJson(response){
 if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')return response.json();
 let size=0;const parts=[];for await(const part of response.body){size+=part.length;if(size>65536)throw Error('VOICE_RESPONSE_TOO_LARGE');parts.push(Buffer.from(part));}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
async function callCline({bytes,mimeType,env,fetchImpl,timeoutMs}){
 const format=CLINE_FORMATS.get(mimeType);if(!format||!env.CLINE_API_KEY||!CLINEPASS_MODELS.includes(env.CLINE_AUDIO_MODEL))throw Error('VOICE_PROVIDER_UNSUPPORTED');
 const response=await fetchImpl('https://api.cline.bot/api/v1/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:'Bearer '+env.CLINE_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.CLINE_AUDIO_MODEL,stream:false,temperature:0,max_tokens:1200,messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:[{type:'input_audio',input_audio:{data:bytes.toString('base64'),format}}]}]})});
 if(!response.ok)throw Error('VOICE_HTTP_'+response.status);
 const data=await responseJson(response),choice=(data.choices?data:data.data)?.choices?.[0];
 if(!choice||choice.finish_reason!=='stop')throw Error('VOICE_INCOMPLETE');
 return parse(choice.message?.content);
}
async function callGemini({bytes,mimeType,env,fetchImpl,timeoutMs}){
 if(!env.GEMINI_API_KEY)throw Error('VOICE_PROVIDER_UNSUPPORTED');
 const model=env.VOICE_GEMINI_MODEL||'gemini-2.5-flash';
 if(!/^gemini-[a-z0-9.\-]{1,60}$/.test(model))throw Error('VOICE_MODEL_NOT_ALLOWED');
 const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:INSTRUCTIONS}]},contents:[{role:'user',parts:[{inline_data:{mime_type:mimeType,data:bytes.toString('base64')}}]}],generationConfig:{temperature:0,maxOutputTokens:1200,responseMimeType:'application/json'}})});
 if(!response.ok)throw Error('VOICE_HTTP_'+response.status);
 const data=await responseJson(response),candidate=data.candidates?.[0];
 if(data.promptFeedback?.blockReason||candidate?.finishReason!=='STOP')throw Error('VOICE_INCOMPLETE');
 return parse((candidate.content?.parts||[]).filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join(''));
}
function voiceProviders(env=process.env){
 const order=String(env.VOICE_TRANSCRIPTION_PROVIDERS||'cline,gemini').split(',').map(s=>s.trim()).filter(p=>['cline','gemini'].includes(p));
 return [...new Set(order)];
}
async function transcribeVoice({bytes,mimeType,env=process.env,fetchImpl=fetch,timeoutMs=25000,convertImpl=oggToMp3}={}){
 if(env.VOICE_TRANSCRIPTION==='off')return {ok:false,reason:'disabled'};
 if(!Buffer.isBuffer(bytes)||!bytes.length)return {ok:false,reason:'empty'};
 if(bytes.length>MAX_BYTES)return {ok:false,reason:'too_long'};
 if(!['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav'].includes(mimeType))return {ok:false,reason:'unsupported'};
 const errors=[];
 for(const provider of voiceProviders(env)){
  try{
   let converted,result;
   try{
    if(provider==='cline'&&mimeType==='audio/ogg'&&env.CLINE_API_KEY&&CLINEPASS_MODELS.includes(env.CLINE_AUDIO_MODEL))converted=await convertImpl(bytes,{timeoutMs:Math.min(timeoutMs,8000)});
    result=await (provider==='cline'?callCline:callGemini)({bytes:converted||bytes,mimeType:converted?'audio/mpeg':mimeType,env,fetchImpl,timeoutMs});
   }finally{converted?.fill(0);}
   if(!result.clear)return {ok:false,reason:'unclear',provider};
   return {ok:true,provider,transcript:redactVisaText(result.transcript).slice(0,MAX_TRANSCRIPT)};
  }catch(error){if(error?.message==='VOICE_PROVIDER_UNSUPPORTED')continue;errors.push(provider+':'+(/^VOICE_[A-Z0-9_]+$/.test(error?.message||'')?error.message:['TimeoutError','AbortError'].includes(error?.name)?'VOICE_TIMEOUT':'VOICE_NETWORK'));}
 }
 return {ok:false,reason:'unavailable',errors};
}
function voiceLead(transcript){
 const shown=redactVisaText(String(transcript||'')).replace(/رعد/g,'القسم المختص').slice(0,160);
 return `سمعت رسالتك الصوتية 🌷 فهمت منها: «${shown}${String(transcript||'').length>160?'…':''}». إذا في شي ما فهمته صح، صحّحلي بكلمة.`;
}
function voiceFallback(reason){
 if(reason==='too_long')return 'وصلتني رسالتك الصوتية 🌷 لأنها طويلة شوي، ممكن تلخصلي المطلوب برسالة صوتية أقصر (أقل من دقيقتين) أو بكم كلمة مكتوبة؟ ومنكمل فوراً من نفس النقطة.';
 if(reason==='unclear')return 'وصلتني رسالتك الصوتية 🌷 بس الصوت ما كان واضح كفاية لأفهمه بدقة. ممكن تعيدها بمكان أهدى أو تكتبلي المطلوب بكلمتين؟';
 return 'وصلتني رسالتك الصوتية 🌷 حالياً ما قدرت أفرّغها، فممكن تكتبلي المطلوب بكلمتين ومنكمل فوراً من نفس النقطة؟';
}
module.exports={callCline,callGemini,transcribeVoice,voiceProviders,voiceLead,voiceFallback,parse,INSTRUCTIONS};
