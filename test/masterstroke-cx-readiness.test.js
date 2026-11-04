'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {detectSentiment,withEmpathy}=require('../src/customer-sentiment');
const {staffAvailable,staffExpectation,withStaffExpectation}=require('../src/staff-availability');
const {requestRating,readRating,parseScore,ratingSummary}=require('../src/service-rating');
const {transcribeVoice,voiceLead,voiceFallback,voiceProviders}=require('../src/voice-transcription');
const {AssistantEngine}=require('../src/assistant-engine');const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const memoryStore=()=>({data:{},saves:0,save(){this.saves++;}});
const dubai=(h,m=0)=>Date.UTC(2026,10,4,h-4,m);

test('Package 12 sentiment detects frustration, urgency and anxiety without touching neutral turns',()=>{
 for(const text of ['صرلي ساعة ناطر','ليش ما حدا رد علي؟','زهقت من الانتظار','عم تعيدولي نفس السؤال','وين الرد يا جماعة'])assert.equal(detectSentiment(text).frustrated,true,text);
 for(const text of ['سفري بكرا الصبح','ضروري لو سمحت','حالة وفاة وبدي سافر','رحلتي اليوم'])assert.equal(detectSentiment(text).urgent,true,text);
 for(const text of ['خايف تنرفض الفيزا','هل الموافقة مضمونة؟'])assert.equal(detectSentiment(text).anxious,true,text);
 for(const text of ['من الشارقة للشام الجمعة','سوري جواز عادي لحالي','شكراً','بكرا بحكيك'])assert.deepEqual(detectSentiment(text),{frustrated:false,urgent:false,anxious:false,priority:'normal'},text);
 assert.equal(detectSentiment('صرلي ساعة وسفري بكرا').priority,'urgent');
});
test('Package 12 empathy lead is added once and never to complaint copy',()=>{
 const s=detectSentiment('صرلي ساعة ناطر');const once=withEmpathy('البحث مستمر على نفس تفاصيل رحلتك.',s);
 assert.match(once,/^حقك علينا/);assert.equal(withEmpathy(once,s),once);
 assert.equal(withEmpathy('منفهم انزعاجك، وبدنا نراجع الموضوع.',s,{complaint:true}),'منفهم انزعاجك، وبدنا نراجع الموضوع.');
 assert.equal(withEmpathy('تمام',detectSentiment('تمام')),'تمام');
 assert.match(withEmpathy('تمام',detectSentiment('صرلي يوم وسفري بكرا')),/الوقت ضيق/);
});
test('Package 14 staff availability follows 10:00–22:00 Dubai and promises an honest next window',()=>{
 assert.equal(staffAvailable(dubai(10)),true);assert.equal(staffAvailable(dubai(21,59)),true);
 assert.equal(staffAvailable(dubai(22)),false);assert.equal(staffAvailable(dubai(3)),false);assert.equal(staffAvailable(dubai(9,59)),false);
 assert.match(staffExpectation(dubai(15)),/متواجد الآن/);
 assert.match(staffExpectation(dubai(23)),/بكرا من الساعة 10 الصبح/);assert.match(staffExpectation(dubai(23)),/ملفك محفوظ كامل/);
 assert.match(staffExpectation(dubai(4)),/اليوم من الساعة 10 الصبح/);
 assert.match(staffExpectation(dubai(23)),/من 10 الصبح لـ 10 المسا/);
 const once=withStaffExpectation('وصل طلبك لموظف الحجوزات.',dubai(23));assert.equal(withStaffExpectation(once,dubai(23)),once);
 assert.match(staffExpectation(dubai(8),{STAFF_HOURS_START:'9',STAFF_HOURS_END:'21'}),/9 الصبح لـ 9 المسا/);
});
test('Package 15 rating is offered once for Ahmed and Ismail, never for Raad, and low scores escalate',()=>{
 const store=memoryStore(),now=Date.parse('2026-11-04T10:00:00Z');
 assert.equal(requestRating(store,'971500000001',{service:'raad',now}),null);
 const prompt=requestRating(store,'971500000001',{service:'flight',reference:'H-1',now});assert.match(prompt,/أحمد/);assert.match(prompt,/1 لـ 5/);
 assert.equal(requestRating(store,'971500000001',{service:'flight',now}),null);
 const good=readRating(store,'971500000001','5',{now});assert.equal(good.handled,true);assert.equal(good.score,5);assert.equal(good.lowScore,false);
 assert.equal(requestRating(store,'971500000001',{service:'flight',now:now+86400000}),null);
 assert.match(requestRating(store,'971500000001',{service:'saudi_visa',now:now+86400000}),/إسماعيل/);
 const low=readRating(store,'971500000001','⭐⭐',{now:now+86400000});assert.equal(low.lowScore,true);assert.match(low.reply,/للمسؤول/);
 requestRating(store,'971500000003',{service:'saudi_visa',now});assert.deepEqual(readRating(store,'971500000003','بدي فيزا لأخي',{now}),{handled:false});
 assert.deepEqual(readRating(store,'971500000003','2',{now}),{handled:false});assert.equal(requestRating(store,'971500000003',{service:'saudi_visa',now:now+3600000}),null);
 requestRating(store,'971500000002',{service:'saudi_visa',now});assert.deepEqual(readRating(store,'971500000002','4',{now:now+49*3600000}),{handled:false});
 for(const [text,score]of [['٥',5],['4/5',4],['3 من 5',3],['⭐⭐⭐⭐⭐',5],['تقييمي 2',2],['6',null],['10',null],['5 اشخاص',null]])assert.equal(parseScore(text),score,text);
 assert.deepEqual(ratingSummary(store),{flight:{count:1,average:5},saudi_visa:{count:1,average:2}});
});
test('Package 14 voice transcription prefers configured Cline audio model, falls back to Gemini, redacts identifiers and stays honest',async()=>{
 const bytes=Buffer.from('OggS-synthetic-audio'),calls=[];
 const gemini=async(url,init)=>{calls.push(url);const body=JSON.parse(init.body);assert.equal(body.contents[0].parts[0].inline_data.mime_type,'audio/ogg');return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({clear:true,transcript:'بدي من الشارقة للشام الجمعة أنا ومرتي ورقمي 0501234567'})}]}}]})};};
 const ok=await transcribeVoice({bytes,mimeType:'audio/ogg',env:{CLINE_API_KEY:'k',CLINE_AUDIO_MODEL:'cline-pass/qwen3.8-max',GEMINI_API_KEY:'g'},fetchImpl:gemini});
 assert.equal(ok.ok,true);assert.equal(ok.provider,'gemini');assert.match(ok.transcript,/الشارقة للشام/);assert.doesNotMatch(ok.transcript,/0501234567/);assert.equal(calls.length,1);
 const cline=async(url,init)=>{const body=JSON.parse(init.body);assert.equal(body.model,'cline-pass/qwen3.8-max');assert.equal(body.messages[1].content[0].input_audio.format,'mp3');return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"clear":true,"transcript":"سوري جواز عادي لحالي"}'}}]})};};
 const viaCline=await transcribeVoice({bytes:Buffer.from('ID3-synthetic'),mimeType:'audio/mpeg',env:{CLINE_API_KEY:'k',CLINE_AUDIO_MODEL:'cline-pass/qwen3.8-max'},fetchImpl:cline});assert.equal(viaCline.provider,'cline');assert.equal(viaCline.transcript,'سوري جواز عادي لحالي');
 const unclear=await transcribeVoice({bytes,mimeType:'audio/ogg',env:{GEMINI_API_KEY:'g'},fetchImpl:async()=>({ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"clear":false,"transcript":""}'}]}}]})})});assert.deepEqual(unclear,{ok:false,reason:'unclear',provider:'gemini'});
 const down=await transcribeVoice({bytes,mimeType:'audio/ogg',env:{GEMINI_API_KEY:'g'},fetchImpl:async()=>({ok:false,status:503})});assert.equal(down.ok,false);assert.equal(down.reason,'unavailable');assert.deepEqual(down.errors,['gemini:VOICE_HTTP_503']);
 assert.equal((await transcribeVoice({bytes:Buffer.alloc(3*1024*1024+1),mimeType:'audio/ogg',env:{GEMINI_API_KEY:'g'}})).reason,'too_long');
 assert.equal((await transcribeVoice({bytes,mimeType:'audio/ogg',env:{VOICE_TRANSCRIPTION:'off'}})).reason,'disabled');
 assert.deepEqual(voiceProviders({VOICE_TRANSCRIPTION_PROVIDERS:'gemini,evil,cline'}),['gemini','cline']);
 assert.match(voiceLead('بدي من الشارقة للشام'),/سمعت رسالتك الصوتية/);for(const r of ['too_long','unclear','unavailable'])assert.match(voiceFallback(r),/وصلتني رسالتك الصوتية/);assert.doesNotMatch(voiceFallback('unclear'),/سمعت|فهمت منها/);
});
test('Package 13 family flight request gets a full saved card with two clear paths and keeps the handoff path',async()=>{
 const now=Date.parse('2026-10-23T08:00:00Z'),e=new AssistantEngine({store:new AssistantState({now:()=>now}),nlu:async()=>null,env:{}});
 const r=await e.handle('family','من الشارقة الى دمشق 15/11/2026 ذهاب فقط 2 بالغين',{now});
 assert.equal(r.complete,false);assert.match(r.reply,/\*طلب سفر عائلي ✈️\*/);assert.match(r.reply,/من الشارقة إلى دمشق/);assert.match(r.reply,/2 بالغ/);assert.match(r.reply,/شوف سعر شخص واحد/);assert.match(r.reply,/حوّلني للموظف/);assert.doesNotMatch(r.reply,/undefined|null|NaN/);
 const h=await e.handle('family','حوّلني للموظف',{now});assert.ok(h.handoff);
});
test('Package 15 reply quality gate: customer copy never leaks internals and stays concise',async()=>{
 const now=Date.parse('2026-10-23T08:00:00Z'),ahmed=new AssistantEngine({store:new AssistantState({now:()=>now}),nlu:async()=>null,env:{}});
 const ismail=new SaudiVisaEngine({store:new AssistantState({file:null}),env:{},privateConfig:{banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}]}});
 const replies=[];
 for(const text of ['مرحبا','من الشارقة على الشام بدي ارخص سعر بهل اسبوع، ذهاب فقط','شخص واحد','طرق الدفع','وين مكتبكم','كم ساعة مدة الرحلة؟','غالي'])replies.push((await ahmed.handle('gate-a',text,{now})).reply);
 for(const text of ['مرحبا','سوري','عادي','لحالي','شو الأوراق المطلوبة؟','التأمين مشمول؟','بدي حساباتكم','خصم؟'])replies.push((await ismail.handle('gate-i',text)).reply);
 for(const reply of replies){
  assert.equal(typeof reply,'string');assert.ok(reply.trim().length>0);
  assert.doesNotMatch(reply,/undefined|null|NaN|\[object|PRIVATE|JSON|schema|NLU_|lastQuestion|awaiting|provider[A-Z]|TODO|رعد/,reply);
  assert.ok(reply.length<=1800,'reply too long: '+reply.slice(0,80));
  assert.ok((reply.match(/[؟?]/g)||[]).length<=2,'too many questions: '+reply.slice(0,120));
 }
});

const flightConversations=[
 ['مرحبا','من الشارقة للشام 15/11/2026 ذهاب فقط','لحالي'],
 ['ابي رحلة من الشارقة لحلب انا والحرمه','15/11/2026 ذهاب فقط','حوّلني للموظف'],
 ['عايز اسافر الشام بكره لوحدي من غير شنط','من الشارقة','ذهاب بس'],
 ['اريد اروح دمشق آني وأخوي','من الشارقة 15/11/2026 ذهاب فقط'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط 2 بالغين','شوف سعر شخص واحد','لخصلي طلبي'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد','نفس الشي بس خليها ذهاب وعودة','العودة 25/11/2026'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد','كم ساعة مدة الرحلة؟','لخصلي طلبي'],
 ['صرلي ساعة ناطر','بدي من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد'],
 ['سفري بكرا ضروري','من الشارقة للشام لحالي ذهاب فقط'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد','يا سلام على هالأسعار لا تحجز شي'],
 ['من الشارقة لدمشق ١٥/١١/٢٠٢٦ ذهاب فقط ٣ بالغين','لخصلي طلبي'],
 ['من الشارقة للشام أول جمعة بالشهر الجاي ذهاب فقط لحالي','نفس الشي بس 30 كيلو'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط أنا وطفلي عمره 7 سنين','حوّلني للموظف'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد','لا ما بدي دبي خليها الشارقة'],
 ['مرحبا','طرق الدفع','وين مكتبكم'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط شخص واحد','غالي','التاريخ ثابت'],
 ['من الشارقة للشام أرخص سعر هالأسبوع ذهاب فقط لحالي','لخصلي طلبي'],
 ['من الشارقة للشام 15/11/2026 ذهاب فقط لحالي','شنطة يد بس'],
 ['من الشارقة للشام 15/11/2026 ذهاب فقط لحالي','هل الجواز السوري مقبول للسفر؟'],
 ['من الشارقة للشام 15/11/2026 ذهاب فقط لحالي','شو شروط الدخول؟'],
 ['من الشارقة للشام 15/11/2026 ذهاب فقط لحالي','ممكن آخد أدوية وباوربانك؟'],
 ['من الشارقة للشام 15/11/2026 ذهاب فقط لحالي','شكراً','وين صار البحث؟'],
 ['بدي طيران','من الشارقة','إلى حلب','15/11/2026','ذهاب فقط','لحالي'],
 ['من دمشق إلى الشارقة 15/11/2026 ذهاب فقط لحالي','لخصلي طلبي'],
 ['من الشارقة لدمشق 15/11/2026 ذهاب فقط 2 بالغين','شوف سعر شخص واحد','حوّلني للموظف']
];
const visaConversations=[
 ['مرحبا','سوري','عادي','لحالي'],
 ['سوري جواز عادي لحالي','شو الأوراق المطلوبة؟'],
 ['سوري جواز عادي لحالي','التأمين مشمول؟'],
 ['سوري جواز عادي لحالي','بدي حساباتكم'],
 ['سوري جواز عادي لحالي','خصم؟'],
 ['نحنا شخصين انا سوري جواز عادي','لبنانية','وثيقة سفر من لبنان'],
 ['نحنا شخصين انا سوري جواز عادي','لبنانية','وثيقة سفر من لبنان','عفواً المتقدم الثاني معه جواز عادي'],
 ['نحنا شخصين انا سوري جواز عادي','الشخص الثاني جنسيته مصري وجواز عادي'],
 ['سوري جواز عادي لحالي','الشخص الثالث مصري'],
 ['سوري جواز عادي لحالي','خايف تنرفض الفيزا'],
 ['سوري جواز عادي لحالي','الموافقة مضمونة؟'],
 ['سوري جواز عادي لحالي','سفري بكرا ضروري'],
 ['سوري جواز عادي لحالي','صرلي ساعة ناطر'],
 ['سوري جواز عادي لحالي','كم يوم بتاخد؟'],
 ['سوري جواز عادي لحالي','وين المكتب؟'],
 ['سوري جواز عادي لحالي','كيف بقدم؟'],
 ['سوري جواز عادي لحالي','في رابط دفع؟'],
 ['سوري جواز عادي لحالي','بدفع بعد ما تصدر؟'],
 ['سوري جواز عادي لحالي','بدي عدل طلبي'],
 ['سوري جواز عادي لحالي','بدي ألغي'],
 ['سوري جواز عادي لحالي','شكراً'],
 ['مصري جواز عادي لحالي','بدي سياحة'],
 ['لبناني جواز عادي لحالي','شو المطلوب؟'],
 ['سوري جواز عادي لحالي','بدي طلب جديد لأخي'],
 ['سوري جواز عادي لحالي','ما بدي قدم هلق، عم اسأل بس']
];
for(const [service,conversations]of [['flight',flightConversations],['visa',visaConversations]]){
 assert.equal(conversations.length,25);
 for(const [index,turns]of conversations.entries())test(`Package 15 golden ${service} conversation ${index+1}`,async()=>{
  const now=Date.parse('2026-10-23T08:00:00Z'),store=new AssistantState({file:null,now:()=>now});
  const e=service==='flight'?new AssistantEngine({store,nlu:async()=>null,env:{}}):new SaudiVisaEngine({store,env:{},privateConfig:{banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}]}});
  for(const text of turns){const r=await e.handle('15550001234',text,{now}),reply=r.reply;
   assert.equal(typeof reply,'string');assert.ok(reply.trim());assert.doesNotMatch(reply,/undefined|null|NaN|\[object|PRIVATE|JSON|schema|NLU_|lastQuestion|awaiting|provider[A-Z]|TODO|رعد/);
   assert.ok(reply.length<=1800,'reply too long');assert.ok((reply.match(/[؟?]/g)||[]).length<=2,'too many questions: '+reply);
  }
 });
}

test('transient voice fetch validates source and bytes without durable media or records',async()=>{
 const {VisaMediaStore}=require('../src/visa-media'),bytes=Buffer.from('OggS-synthetic'),store=memoryStore();let calls=0;
 const media=new VisaMediaStore({store,env:{WHATSAPP_ACCESS_TOKEN:'synthetic'},fetchImpl:async()=>++calls===1?Response.json({id:'123',mime_type:'audio/ogg',file_size:bytes.length,url:'https://lookaside.fbsbx.com/synthetic'}):new Response(bytes,{headers:{'content-type':'audio/ogg'}})});
 const before=JSON.stringify(store.data),result=await media.fetchTransient({id:'123',type:'audio',mimeType:'audio/ogg'});assert.deepEqual(result.bytes,bytes);assert.equal(JSON.stringify(store.data),before);assert.equal(store.saves,0);
 const rejected=new VisaMediaStore({store,env:{WHATSAPP_ACCESS_TOKEN:'synthetic'},fetchImpl:async()=>Response.json({mime_type:'audio/ogg',file_size:bytes.length,url:'https://evil.invalid/audio'})});await assert.rejects(rejected.fetchTransient({id:'123',type:'audio'}),/MEDIA_SOURCE_REJECTED/);
});
test('ratings and priority are isolated and erased with the customer',()=>{
 const store=new AssistantState({file:null});requestRating(store,'15550001111',{service:'flight'});requestRating(store,'15550002222',{service:'flight'});readRating(store,'15550001111','5');
 store.data.customerPriority={'15550001111':{priority:'urgent'},'15550002222':{priority:'urgent'}};store.delete('15550001111');
 assert.equal(store.data.serviceRatings.history.length,0);assert.ok(store.data.serviceRatings.pending['15550002222']);assert.equal(store.data.customerPriority['15550001111'],undefined);assert.ok(store.data.customerPriority['15550002222']);
});

test('visa rating requires current staff approval, never prepared documents, saved applications or stale decisions',()=>{
 const {approvedVisaRating}=require('../src/service-rating'),{visaCaseSignature}=require('../src/visa-case-signature'),store=memoryStore(),customer='15550003333';
 const c={id:'synthetic-case',applicants:[{nationality:'سوريا',passportType:'regular'}],applicantCount:1,quote:{total:640},stage:'prepared',submissionStatus:'not_submitted'};store.data.visaCases={[customer]:c};
 assert.equal(approvedVisaRating(store,customer),null);
 c.submissionStatus='submitted';const signature=visaCaseSignature(c);c.staffVerification={submission:{caseSignature:signature},decision:{value:'refused',actor:'staff',caseSignature:signature,reference:'synthetic-approval'}};assert.equal(approvedVisaRating(store,customer),null);
 c.staffVerification.decision.value='approved';c.applicants[0].nationality='لبنان';assert.equal(approvedVisaRating(store,customer),null);c.applicants[0].nationality='سوريا';
 const prompt=approvedVisaRating(store,customer);assert.match(prompt,/إسماعيل/);assert.equal(approvedVisaRating(store,customer),null);assert.equal(store.data.serviceRatings.pending[customer].reference,'synthetic-approval');
});
test('voice rejects malformed, oversized provider output and redirects without leaking provider errors',async()=>{
 const options={bytes:Buffer.from('ID3-synthetic'),mimeType:'audio/mpeg',env:{CLINE_API_KEY:'synthetic-secret',CLINE_AUDIO_MODEL:'cline-pass/qwen3.8-max',VOICE_TRANSCRIPTION_PROVIDERS:'cline'}};
 for(const body of [{choices:[{finish_reason:'length',message:{content:'{}'}}]},{choices:[{finish_reason:'stop',message:{content:'{"clear":"true","transcript":"anything"}'}}]}]){
  const r=await transcribeVoice({...options,fetchImpl:async(url,init)=>{assert.equal(init.redirect,'error');return Response.json(body);}});assert.equal(r.ok,false);assert.doesNotMatch(JSON.stringify(r),/synthetic-secret|anything/);
 }
 const large=await transcribeVoice({...options,fetchImpl:async()=>new Response('x'.repeat(65537))});assert.equal(large.ok,false);assert.deepEqual(large.errors,['cline:VOICE_RESPONSE_TOO_LARGE']);
});

test('failed rating delivery dismisses numeric capture and respects the cooldown',async()=>{
 const {sendRating}=require('../src/service-rating'),store=memoryStore(),id='15550004444';let calls=0;
 assert.equal(await sendRating(store,id,{service:'flight',guard:()=>false,send:async()=>calls++}),false);assert.equal(calls,0);
 assert.equal(await sendRating(store,id,{service:'flight',send:async()=>{calls++;throw Error('synthetic failure');}}),false);
 assert.equal(calls,1);assert.equal(readRating(store,id,'2').handled,false);assert.equal(requestRating(store,id,{service:'flight'}),null);assert.equal(store.data.serviceRatings.history[0].deliveryUnconfirmed,true);
});
