'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse,transcribeVoice,voiceLead,voiceFallback}=require('../src/voice-transcription');

// These are transcript/provider-contract regressions, not an ASR benchmark.
// Real audio acceptance remains independently gated in voiceEnabled.
const samples=[
 ['Syrian','بدي إلي ولمرتي، لا مو إلي، لمرتي لحالها'],
 ['Egyptian','أنا مش عايز ألغي، بس عايز أعرف الطلب وصل لفين'],
 ['Gulf','أبغي أعرف السعر، لا تقدم لين أأكد لك'],
 ['Jordanian','بدي أستفسر عن طلب أخوي، مش عن طلبي'],
 ['Lebanese','بدي إسأل عن الفيزا، بعدني ما حوّلت المصاري'],
 ['Yemeni','أشتي أعرف كم بتكلف، ما قد دفعت'],
 ['code switching','بدي tourist visa بس مش multiple entry'],
 ['Russian','Хочу узнать статус заявления'],
 ['Hindi','मुझे वीज़ा की जानकारी चाहिए'],
 ['Urdu','مجھے ویزا کی معلومات چاہیے'],
 ['Chinese','我想查询申请状态'],
 ['Thai','ขอสอบถามสถานะวีซ่า'],
 ['single Chinese word','好'],
 ['Arabic count','٤'],
 ['Latin count','2'],
 ['Persian count','۳']
];
test('clear transcript preserves dialect, script, code switching, negation and brief numeric replies',()=>{
 for(const [language,transcript] of samples)assert.deepEqual(parse(JSON.stringify({clear:true,transcript})),{clear:true,transcript},language);
});
test('missing speech never becomes a fact merely because a provider marked it clear',()=>{
 for(const transcript of ['', '  \n ', '… ؟ !', '🎵🎶', '\u0301'])assert.deepEqual(parse(JSON.stringify({clear:true,transcript})),{clear:false,transcript:''});
 assert.deepEqual(parse(JSON.stringify({clear:false,transcript:'قدّم الطلب'})),{clear:false,transcript:''});
});
test('complete longer notes retain final corrections; oversized notes are rejected rather than cut',()=>{
 const transcript='أريد الاستفسار عن إجراءات السفر. '.repeat(55)+'لا تقدم أي طلب قبل موافقتي';
 assert.ok(transcript.length>1500&&transcript.length<4000);
 assert.equal(parse(JSON.stringify({clear:true,transcript})).transcript,transcript);
 assert.throws(()=>parse(JSON.stringify({clear:true,transcript:'ك'.repeat(4001)})),/VOICE_TRANSCRIPT_TOO_LONG/);
});
test('multilingual provider output reaches the conversation intact with document identifiers redacted',async()=>{
 const env={CLINE_API_KEY:'synthetic-key',CLINE_AUDIO_MODEL:'cline-pass/qwen3.8-max',VOICE_TRANSCRIPTION_PROVIDERS:'cline'};
 for(const [,transcript] of samples){
  const bytes=Buffer.from('synthetic-audio'),original=Buffer.from(bytes);
  const result=await transcribeVoice({bytes,mimeType:'audio/mpeg',env,inspectImpl:async()=>({silent:false}),fetchImpl:async(url,options)=>{
   assert.equal(url,'https://api.cline.bot/api/v1/chat/completions');
   const request=JSON.parse(options.body);
   assert.equal(request.messages[1].content[0].input_audio.data,bytes.toString('base64'));
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({clear:true,transcript})}}]});
  }});
  assert.deepEqual(result,{ok:true,provider:'cline',transcript});assert.deepEqual(bytes,original);
 }
 const result=await transcribeVoice({bytes:Buffer.from('synthetic-audio'),mimeType:'audio/mpeg',env,inspectImpl:async()=>({silent:false}),fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({clear:true,transcript:'My passport number N01234567. لا تقدم الطلب'})}}]})});
 assert.equal(result.ok,true);assert.doesNotMatch(result.transcript,/N01234567/);assert.match(result.transcript,/لا تقدم الطلب/);
});
test('overlong provider transcripts never route partial facts or trigger a second transcription',async()=>{
 let calls=0;
 const result=await transcribeVoice({bytes:Buffer.from('synthetic-audio'),mimeType:'audio/mpeg',env:{CLINE_API_KEY:'synthetic-key',CLINE_AUDIO_MODEL:'cline-pass/qwen3.8-max',GEMINI_API_KEY:'synthetic-key'},inspectImpl:async()=>({silent:false}),fetchImpl:async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({clear:true,transcript:'أريد السؤال '.repeat(400)+'لا تقدم'})}}]});}});
 assert.deepEqual(result,{ok:false,reason:'too_long',provider:'cline'});assert.equal(calls,1);
});
test('understood voice does not echo private speech or make the customer confirm it again',()=>{
 const lead=voiceLead('اسمي فلان ورقم جوازي N01234567');
 assert.match(lead,/سمعت رسالتك الصوتية/);
 assert.doesNotMatch(lead,/فلان|N01234567|فهمت منها|صحّح|أكد|اكتب|ملخص/);
 for(const reason of ['unclear','unavailable','too_long'])assert.doesNotMatch(voiceFallback(reason),/تفريغ|حفظ|API|نموذج/);
});
