'use strict';
const crypto=require('node:crypto');
const legacy=require('./conversation');
const {normalize}=require('./arabic-dates');
const {understand}=require('./assistant-nlu');
const {AssistantState}=require('./assistant-state');
const {POLICY,capabilityIssue}=require('./assistant-policy');
const dateText=d=>d.split('-').reverse().join('-');
const clean=t=>String(t||'').replace(/[\u0000-\u001f]/g,' ').slice(0,3000);
function offerId(o){return crypto.createHash('sha256').update(JSON.stringify([o.request,o.timing,o.price?.weights])).digest('hex').slice(0,12);}
class AssistantEngine{
 constructor({store=new AssistantState(),nlu=understand,env=process.env}={}){this.store=store;this.nlu=nlu;this.env=env;this.locks=new Map();}
 state(id){return this.store.get(id)||{history:[],offers:[],selected:null,base:null,previous:[],comparison:null,status:'idle',coverage:[]};}
 save(id,s){s.base=legacy.exportSession(id);this.store.set(id,s);}
 async handle(id,text,{now=Date.now(),quotedMessageId=null}={}){
  const before=this.locks.get(id)||Promise.resolve();const work=before.catch(()=>{}).then(()=>this.process(id,text,{now,quotedMessageId}));this.locks.set(id,work);try{return await work;}finally{if(this.locks.get(id)===work)this.locks.delete(id);}
 }
 async process(id,text,{now,quotedMessageId}){
  const s=this.state(id);if(quotedMessageId){const quoted=s.offers.find(o=>o.messageId===quotedMessageId);if(quoted){s.selected=quoted.id;legacy.importSession(id,{request:quoted.request,submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);}}legacy.importSession(id,s.base);const t=normalize(clean(text)),say=reply=>{s.lastQuestion=/[؟?]/.test(reply)?reply:null;s.history.push({role:'assistant',text:reply});s.history=s.history.slice(-16);this.save(id,s);return{complete:false,reply};};
  if(s.humanOwned)return say('المحادثة الآن بمتابعة موظف الحجوزات.');
  const hasChange=/كيلو|كغ|\bkg\b|بدل|خلي|غير|قصدي|شخص|بالغ|طفل|رضيع|مسافر|على |الى |من |بكرا|بكره|اسبوع|شهر|الجمعة|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس/.test(t);
  if(/^(?:احذف بياناتي|امسح بياناتي)$/.test(t)){this.store.delete(id);legacy.importSession(id,null);return{complete:false,cancel:true,reply:'تم حذف بيانات محادثتك المحفوظة وإيقاف طلب البحث الحالي.'};}
  if(/^(?:الغاء|الغي|وقف البحث|اوقف البحث|الغاء الطلب|cancel|ابد[اأ] من جديد)$/.test(t)){s.status='cancelled';s.offers=[];s.selected=null;s.comparison=null;s.previous=[];legacy.importSession(id,null);return{...say('تم إيقاف بحث الأسعار. إذا قصدك إلغاء تذكرة صادرة، وضّحلي حتى نميّزها عن طلب الاستعلام.'),cancel:true};}
  if(/^(?:مرحبا|اهلا|هلا|السلام عليكم|hi|hello|ابد[اأ])$/.test(t))return say('أهلًا وسهلًا فيك 🌷 معك أحمد، مساعد مجموعة الرمال الافتراضي. كيف فيني ساعدك اليوم؟');
  if(!hasChange&&/زبط|تزبط|خصم|تخفيض|نزل.*سعر|غالي|ارخص من هيك/.test(t))return say('تكرم عيونك 🌷 السعر المعروض نهائي وشامل الرسوم وعمولة الخدمة. فينا نبحث عن خيار أوفر بتغيير اليوم أو التوقيت، إذا بيناسبك. بتفضّل نحافظ على نفس الأيام أو نوسّع الفترة؟');
  if(!hasChange&&/برجع|بعدي?ن بحكي|بدي فكر|بدي افكر|سلام$/.test(t)){s.status='paused';return{...say('أهلًا وسهلًا فيك بأي وقت، شرّفتنا 🌷 لما ترجع بأي سؤال أو استفسار، نحنا بالخدمة.'),cancel:true};}
  if(!hasChange&&/بانتظار|بالانتظار|ناطر|منتظر|شو صار|وين وصلت|لسا|اصبر/.test(t)){
   const busy=['searching','queued'].includes(s.status);return say(busy?'شكرًا لانتظارك 🌷 طلبك قيد العمل، عم نراجع الخيارات حسب تفاصيل رحلتك، وأول ما تتأكد نتيجة منرسلها.':s.status==='failed'?'لم يكتمل التحقق من الأسعار للطلب السابق. فينا نعيد المحاولة على نفس التفاصيل، أو نحدد فترة ثانية.':s.status==='done'?'نتائج البحث المؤكدة موجودة بالعرض السابق. بتحب نراجع خيار منها أو نوسّع الفترة؟':'ما في بحث جارٍ حاليًا. ابعتلي طلبك أو التعديل اللي بدك ياه ومنكمل.');
  }
  if(!hasChange&&/^(?:شكرا|شكراً|يسلمو|مشكور|يعطيك العافيه|يعطيك العافية|تمام شكرا|👍)$/.test(t))return say('أهلًا وسهلًا فيك 🌷');
  const book=/كيف.*(?:ثبت|تثبيت|حجز|ادفع)|بدي ثبت|ثبتلي|ثب[تّ]لي|احجزلي|احجز لي|رابط الدفع|بدي احكي.*موظف/.test(t);
  if(book){
   const offer=s.offers.find(o=>o.id===s.selected)||s.offers.length===1&&s.offers[0];
   if(!offer)return say(s.offers.length?'أكيد، أي خيار بدك تتابع تثبيته؟ اذكر رقم الخيار أو تاريخ الرحلة.':'التثبيت يتم مع موظف الحجوزات. خلينا نحدد الرحلة أولًا حتى تكون تفاصيل طلبك واضحة.');
   if(!s.handoffId)s.handoffId=this.store.handoff(id,{request:offer.request,offer,verificationRequired:true});s.status='handoff_pending';
   return{...say('سجّلت رغبتك بمتابعة تثبيت الخيار المحدد. التثبيت والإصدار مع موظف الحجوزات بعد إعادة التحقق من السعر والتوفر؛ لم يتم حجز أو إصدار تذكرة بعد.'),cancel:true,handoff:s.handoffId};
  }
  const selection=t.match(/(?:الخيار|العرض)\s*(\d+)|^(الاول|التاني|الثاني|الثالث)$/);
  if(selection&&!hasChange){const index=selection[1]?Number(selection[1])-1:({الاول:0,التاني:1,الثاني:1,الثالث:2})[selection[2]];const offer=s.offers.find(o=>o.reference===index+1)||s.offers[index];if(!offer)return say('أي عرض تقصد؟ اذكر تاريخ الرحلة أو رقم الخيار من آخر مقارنة.');s.selected=offer.id;return say(`تمام، اخترت الخيار ${index+1} بتاريخ ${offer.request.departureDate}، رحلة ${offer.timing.out.flight}. السعر والتوفر يحتاجان إعادة تحقق عند التثبيت. بتحب تعرف كيف نتابع التثبيت؟`);}
  if(/السعر.*(?:شخص|كلنا|اثنين|اتنين)|للشخص|للمجموع/.test(t))return say('العرض الآلي المؤكد حاليًا لشخص بالغ واحد، وليس سعر مجموعة. إذا عددكن أكثر لازم نتحقق من السعر والتوفر للعدد الصحيح، ولا نضرب سعر الشخص بالعدد كتقدير مؤكد.');
  if(/^(?:ارجع متل قبل|رجعه متل قبل|الغي اخر تعديل)$/.test(t)){
   const previous=s.previous.pop();if(!previous)return say('أي تفصيل بدك نرجعه: الوزن أو التاريخ أو المسار؟');legacy.importSession(id,previous);s.base=previous;s.status='queued';previous.submitted=false;legacy.importSession(id,previous);const result=legacy.handleMessage(id,'تابع نفس التفاصيل',{now});this.save(id,s);return result;
  }
  if(['اي','نعم','تمام'].includes(t)&&s.lastQuestion?.includes('أو'))return say('أكيد، أي خيار من المذكورين بتفضّل؟');
  let decision=null;
  try{decision=await this.nlu(clean(text),{request:s.base?.request,lastQuestion:s.lastQuestion,history:s.history.slice(-8),selectedOffer:s.offers.find(o=>o.id===s.selected),status:s.status},{env:this.env,now});if(decision)console.log('ASSISTANT_NLU_OK_'+decision.intent);}catch(error){console.log(/^NLU_[A-Z0-9_]+$/.test(error.message)?error.message:'ASSISTANT_NLU_UNAVAILABLE');}
  s.history.push({role:'user',text:clean(text)});s.history=s.history.slice(-16);
  const hasDecisionFields=decision&&Object.values(decision.fields).some(v=>Array.isArray(v)?v.length:v!==null);
  if(decision&&!hasDecisionFields&&['status','thanks','greeting','goodbye','negotiate','booking','cancel'].includes(decision.intent)){const phrase={status:'شو صار',thanks:'شكرا',greeting:'مرحبا',goodbye:'برجعلكن',negotiate:'زبطونا بالسعر',booking:'كيف بثبت',cancel:'وقف البحث'}[decision.intent];this.save(id,s);return this.process(id,phrase,{now});}
  if(decision?.intent==='clarify')return say(decision.question||'قصدك نعدّل الطلب، أو نعمل مقارنة إضافية بدون تغيير اختيارك؟');
  const hypothetical=decision?.intent==='compare'||(/لو |قديش.*(?:بيصير|بصير|بوفر|الفرق)|بس قلي|بس قولي|بكم/.test(t)&&Boolean(s.base?.submitted));
  if(/كيلو|كغ/.test(t)&&/معنا|سوا|مجموع/.test(t)&&!/(?:لكل|للشخص|اجمالي|مجموع)/.test(t))return say('الوزن المطلوب لكل شخص، أو مجموع الوزن للمسافرين سوا؟');
  if(/زيادة|اضافي|إضافي/.test(t)&&/كيلو|كغ/.test(t)&&!s.base?.request?.baggageRequest)return say('قصدك الوزن الإجمالي للشنط، أو زيادة فوق الوزن الموجود بالعرض؟');
  if(/مو هيك|ما فهمت|ما قلت|بدي اخف|غيره$|مو .*|لا تغير/.test(t)&&!decision)return say('خلينا نضبطها بدون تغيير التفاصيل الثانية: قصدك نعدّل الوزن، أو الموعد، أو نبحث عن سعر أقل؟');
  if(/الا |باستثناء|لازم.*(?:اوصل|وصول)|بدون ترانزيت|مباشر حصرا|قطعتين|قطعه|قطعة/.test(t)&&!decision)return say('فهمت إن عندك شرط إضافي على الرحلة. حتى ما نعرض خيارًا غير مناسب، حدد الشرط بدقة؛ التحقق الآلي من بعض شروط الوصول وعدد القطع غير مكتمل حاليًا.');
  const previous=legacy.exportSession(id);
  let result=legacy.handleMessage(id,clean(text),{now,patch:decision?.fields});let base;
  base=legacy.exportSession(id);
  if(base?.request?.passengers){const p=base.request.passengers;if(p.children+p.infants>(p.ages?.length||0)){result={complete:false,reply:'كم أعمار الأطفال والرضّع وقت السفر؟ اذكر عمر كل واحد حتى ما نحسب سعرًا لفئة غير صحيحة.'};}}
  if(hypothetical&&result.complete){result.comparison=true;s.comparison={request:result.request,base:previous};legacy.importSession(id,previous);}
  else if(result.complete){if(previous)s.previous.push(previous);s.previous=s.previous.slice(-5);s.offers=[];s.selected=null;s.comparison=null;}
  if(result.complete){const issue=capabilityIssue(result.request);if(issue){s.status='unsupported';result={complete:false,reply:issue==='passengers'?'فهمت عدد المسافرين. التسعير الآلي المتحقق منه حاليًا يدعم بالغًا واحدًا فقط؛ ما رح أعطيك سعر مجموعة بتخمين أو بضرب سعر الشخص.':issue==='route'?'فهمت المسار. البحث المتصل والمتَحقق منه حاليًا بين الشارقة ودمشق على العربية؛ هذا المسار لم يُربط بعد، وفلاي شام نضيفها بعد تجهيز ربطها.':'سجّلت تفاصيلك، لكن شروط القطع أو المقعد الخاص أو قيود الوصول تحتاج تحققًا لا يدعمه الربط الحالي. لن أعرض خيارًا وكأنه يحققها دون تأكيد.'};}else{s.status='queued';s.coverage=[];}}
  if(!result.complete&&s.status==='searching'&&/طلبك السابق مسجل/.test(result.reply))result.reply='طلبك قيد البحث حاليًا. إذا عندك تعديل بالوزن أو الموعد ابعته، وإذا عم تتابع النتيجة فأول ما تتأكد منرسلها.';
  s.lastQuestion=result.complete?null:result.reply;
  s.history.push({role:'assistant',text:result.reply});s.history=s.history.slice(-16);
  this.save(id,s);return result;
 }
 jobState(id,status){const s=this.state(id);s.status=status;this.store.set(id,s);}
 progress(id,data,messageId){const s=this.state(id);s.status='searching';if(data.coverage)s.coverage=data.coverage.slice(0,32);if(data.offer){const o=data.offer;if(o.request&&o.timing?.out?.flight&&/^\d+\.\d{2}$/.test(o.price?.sellingTotal||'')){const item={...o,id:offerId(o),messageId};const index=s.offers.findIndex(x=>x.id===item.id);if(index<0)s.offers.push(item);else s.offers[index]=item;s.offers=s.offers.slice(-80);}}this.store.set(id,s);}
 status(){return{policy:POLICY.version,aiConfigured:Boolean(this.env.OPENAI_API_KEY),...this.store.status(),humanRoutingConfigured:Boolean(this.env.HUMAN_HANDOFF_RECIPIENT),providers:POLICY.providers};}
}
module.exports={AssistantEngine,offerId};
