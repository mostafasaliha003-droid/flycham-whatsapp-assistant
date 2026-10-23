'use strict';
const {aiConfigured,aiProvider}=require('./assistant-nlu');

const crypto=require('node:crypto');
const legacy=require('./conversation');
const {normalize,naturalDate}=require('./arabic-dates');
const {understand}=require('./assistant-nlu');
const {AssistantState}=require('./assistant-state');
const {POLICY,capabilityIssue}=require('./assistant-policy');
const {formatOffer,verifiedOffer}=require('./quote-comparison');
const dateText=d=>d.split('-').reverse().join('-');
const clean=t=>String(t||'').replace(/[\u0000-\u001f]/g,' ').slice(0,9000);
function offerId(o){return crypto.createHash('sha256').update(JSON.stringify([o.request,o.timing,o.price?.weights])).digest('hex').slice(0,12);}
// Model context contains identification and deterministic price ordering, never money or raw supplier payloads.
function offerSummaries(offers=[]){
 const verified=offers.slice(-80).filter(o=>o.request&&o.timing?.out?.flight&&/^\d+\.\d{2}$/.test(o.price?.sellingTotal||''));
 const amount=o=>BigInt(o.price.sellingTotal.replace('.',''));
 const amounts=[...new Set(verified.map(o=>amount(o).toString()))].map(v=>BigInt(v)).sort((a,b)=>a<b?-1:a>b?1:0);
 const bounded=v=>typeof v==='string'?v.slice(0,80):null;
 return verified.map(o=>({provider:['airarabia','flycham'].includes(o.provider||o.request.provider||'airarabia')?(o.provider||o.request.provider||'airarabia'):null,reference:Number.isInteger(o.reference)&&o.reference>=1&&o.reference<=80?o.reference:offers.indexOf(o)+1,
  origin:bounded(o.request.origin),destination:bounded(o.request.destination),departureDate:bounded(o.request.departureDate),returnDate:bounded(o.request.returnDate),
  flight:bounded(o.timing.out.flight),departureTime:bounded(o.timing.out.departure),arrivalTime:bounded(o.timing.out.arrival),
  returnFlight:bounded(o.timing.back?.flight),returnDepartureTime:bounded(o.timing.back?.departure),returnArrivalTime:bounded(o.timing.back?.arrival),
  cheapestRank:amounts.findIndex(v=>v===amount(o))+1}));
}
function questionField(question){
 const t=normalize(question||'');
 if(/اعمار|عمر.*(?:طفل|رضيع|ابن)/.test(t))return 'childrenAges';
 if(/(?:موعد|تاريخ|ايمت|متي|وقت).*(?:عود[هة]|رجع[هة])/.test(t))return 'returnDate';
 if(/عدد|كم.*(?:شخص|مسافر|بالغ)/.test(t))return 'passengers';
 if(/من اي|مغادر|من وين/.test(t))return 'origin';
 if(/الى اي|وجه[هة]|(?:وين|لوين).*(?:رايح|مسافر|توصل)|لوين/.test(t))return 'destination';
 if(/تاريخ.*(?:ذهاب|سفر)|ايمت|متي.*(?:سفر|ذهاب)/.test(t))return 'departureDate';
 if(/ذهاب|عود[هة]|رجع[هة]|نوع الرحل/.test(t))return 'tripType';
 return null;
}
function answeredField(field,r={}){
 if(field==='passengers')return Number.isInteger(r?.passengers?.adults);
 if(field==='childrenAges')return Boolean(r?.passengers&&(r.passengers.children||0)+(r.passengers.infants||0)<=(r.passengers.ages?.length||0));
 if(field==='departureDate')return Boolean(r?.departureDate||r?.departureRange);
 if(field==='returnDate')return Boolean(r?.returnDate||r?.stayNights);
 return Boolean(r?.[field]);
}
function knownQuestion(question,r={}){return answeredField(questionField(question),r);}
function explainService(t,request={},status){
 if(/(?:فرق|مقارنه|احسن|افضل).*(?:فلاي|العربي)|(?:فلاي|العربي).*(?:فرق|احسن|افضل)/.test(t))return 'فلاي شام بتشمل حسب سياسة خدمتنا المعتادة ثلاثين كيلو وزن مسجّل وعشرة كيلو يد. العربية منراجع وزنها وتكلفتها حسب الخيار الفعلي. المقارنة الأنسب بتكون على نفس المسار والأيام والوزن، ومنعرضلك التواقيت والسعر المتحقق لكل خيار.';
 if(/وزن|شنط|امتعه|كيلو/.test(t))return request.provider==='flycham'?'فلاي شام بتشمل ثلاثين كيلو وزن مسجّل وعشرة كيلو يد بالعرض المعتاد. إذا صار عرض وزن إضافي منحدّثه حسب الإعلان المعتمد. أي طلب مختلف لازم نتحقق من توفره قبل تأكيده.':'البحث المعتاد بيكون على ثلاثين كيلو وزن مسجّل. إذا بتفضّل أقل وزن لحتى نقارن بسعر أوفر على العربية، منحافظ على باقي تفاصيل رحلتك ومنتحقق من التكلفة الفعلية.';
 if(/دفع|تثبيت|حجز|اصدار/.test(t))return 'منرتّبلك الخيارات المتحققة أولًا، وبتختار الأنسب. لما تطلب متابعة التثبيت، بيتابع معك موظف الحجوزات بعد مراجعة السعر والتوفر؛ الاستعلام بحد ذاته ما بيحجز ولا بيصدر تذكرة.';
 if(/تعديل|الغاء|استرجاع/.test(t))return 'شروط التعديل والإلغاء بتختلف حسب التذكرة والخيار المحدد. ما منأكد مرونة أو رسوم قبل مراجعة شروط العرض نفسه؛ فينا نحافظ على هالنقطة ضمن طلبك.';
 if(/طول|تأخير|تاخير|تعب|مستعجل/.test(t))return ['searching','queued'].includes(status)?'معك، وبقدّر وقتك. طلبك قيد التحقق على نفس التفاصيل؛ ما رح أغيّر المسار أو الوزن من عندي، ومنبعتلك النتيجة بعد تأكدها.':'معك، وبقدّر وقتك. التفاصيل اللي ذكرتها محفوظة؛ منكمل من آخر نقطة واضحة حتى ما تعيد طلبك.';
 return null;
}
class AssistantEngine{
 constructor({store=new AssistantState(),nlu=understand,env=process.env}={}){this.store=store;this.nlu=nlu;this.env=env;this.locks=new Map();this.prepared=new Map();}
 state(id){return {history:[],offers:[],selected:null,base:null,previous:[],comparison:null,status:'idle',coverage:[],...this.store.get(id)};}
 save(id,s){s.base=legacy.exportSession(id);this.store.set(id,s);}
 preparationKey(s,text,turnMessages){return JSON.stringify([clean(text),s.base,s.history,s.questions,s.lastQuestion,s.offers,s.selected,s.status,turnMessages]);}
 async prepare(id,text,{turnMessages=[],quotedMessageId=null,now=Date.now()}={}){
  if(quotedMessageId||turnMessages.some(m=>m.quotedOfferReference||m.quotedOfferReferences?.length))return;
  const s=this.state(id),key=this.preparationKey(s,text,turnMessages);
  if(this.prepared.get(id)?.key===key)return;
  const snapshot=structuredClone(s);
  const promise=Promise.resolve().then(()=>this.nlu(clean(text),{request:snapshot.base?.request,lastQuestion:snapshot.lastQuestion,history:[...snapshot.history,{role:'user',text:clean(text)}].slice(-12),questions:snapshot.questions||{},proposal:snapshot.base?.proposal,quotedOfferReferences:[],turnMessages,awaiting:snapshot.base?.awaiting,selectedOffer:snapshot.offers.find(o=>o.id===snapshot.selected),offerSummaries:offerSummaries(snapshot.offers),status:snapshot.status},{env:this.env,now})).then(decision=>({decision}),error=>({error}));
  if(this.prepared.size>=100)this.prepared.delete(this.prepared.keys().next().value);
  this.prepared.set(id,{key,promise,at:now});
 }
 async handle(id,text,{now=Date.now(),quotedMessageId=null,turnMessages=[]}={}){
  const before=this.locks.get(id)||Promise.resolve();const work=before.catch(()=>{}).then(()=>this.process(id,text,{now,quotedMessageId,turnMessages}));this.locks.set(id,work);try{const result=await work;const s=this.state(id);if(!s.introduced&&!result.cancel){const introduction='أهلًا وسهلًا فيك 🌷 معك أحمد، مساعد مجموعة الرمال الافتراضي.';s.introduced=true;if(!result.reply.includes('معك أحمد')){result.reply=introduction+'\n\n'+result.reply;result.introduction=introduction;const last=s.history[s.history.length-1];if(last?.role==='assistant')last.text=result.reply;}this.store.set(id,s);}return result;}finally{if(this.locks.get(id)===work)this.locks.delete(id);}
 }
 async process(id,text,{now,quotedMessageId,turnMessages=[]}){
  const s=this.state(id),priorSelection=s.selected,priorBase=s.base;
  const prepared=this.prepared.get(id),preparedKey=this.preparationKey(s,text,turnMessages);
  const usePrepared=!quotedMessageId&&prepared?.key===preparedKey&&now-prepared.at<120000;
  if(prepared)this.prepared.delete(id);
  const availableReferences=new Set(s.offers.map((o,i)=>o.reference||i+1));
  const mapped=quotedMessageId?s.offerMessages?.[quotedMessageId]:undefined;
  const direct=mapped===undefined&&quotedMessageId?s.offers.flatMap((o,i)=>o.messageId===quotedMessageId?[o.reference||i+1]:[]):[];
  const quotedOfferReferences=[...new Set([...(Array.isArray(mapped)?mapped:direct),...turnMessages.flatMap(m=>Array.isArray(m.quotedOfferReferences)?m.quotedOfferReferences:Number.isInteger(m.quotedOfferReference)?[m.quotedOfferReference]:[])])].filter(r=>Number.isInteger(r)&&availableReferences.has(r)).slice(0,80);
  if(quotedOfferReferences.length===1){const quoted=s.offers.find((o,i)=>(o.reference||i+1)===quotedOfferReferences[0]);if(quoted){s.selected=quoted.id;legacy.importSession(id,{request:{...quoted.request,providerExclusive:true},submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);}}
  const recoveredRoute=s.status==='unsupported'&&s.base?.request&&!capabilityIssue(s.base.request);
  if(recoveredRoute){s.base.submitted=false;s.base.awaiting=null;s.status='collecting';}
  legacy.importSession(id,s.base);
  s.questions ||= {};s.tripId ||= crypto.randomUUID();s.history.push({role:'user',text:clean(text)});s.history=s.history.slice(-24);
  const t=normalize(clean(text)),say=reply=>{
   if(/[؟?]/.test(reply))s.lastQuestion=reply;
   s.history.push({role:'assistant',text:reply});s.history=s.history.slice(-24);this.save(id,s);return{complete:false,reply};
  };
  if(s.humanOwned)return say('المحادثة الآن بمتابعة موظف الحجوزات.');
  let hasChange=/كيلو|كغ|\bkg\b|بدل|خلي|غير|قصدي|شخص|بالغ|طفل|رضيع|مسافر|على |الى |من |بكرا|بكره|اسبوع|شهر|الجمعة|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|\d|مطار|دمشق|الشام|حلب|الشارق|شارق|دبي|ذهاب|عوده|رجعه|وزن|شنط|رحله|توقيت/.test(t);
  if(/^(?:احذف بياناتي|امسح بياناتي)$/.test(t)){this.store.delete(id);legacy.importSession(id,null);return{complete:false,cancel:true,reply:'تم حذف بيانات محادثتك المحفوظة وإيقاف طلب البحث الحالي.'};}
  if(/^(?:الغاء|الغي|وقف البحث|اوقف البحث|الغاء الطلب|cancel|ابد[اأ] من جديد)$/.test(t)){s.status='cancelled';s.pendingRequests=[];s.offers=[];s.selected=null;s.comparison=null;s.previous=[];s.questions={};delete s.pendingQuotedOffer;s.lastQuestion=null;s.tripId=crypto.randomUUID();legacy.importSession(id,null);return{...say('تم إيقاف بحث الأسعار. إذا قصدك إلغاء تذكرة صادرة، وضّحلي حتى نميّزها عن طلب الاستعلام.'),cancel:true};}
  let decision=null;
  try{if(usePrepared){const value=await prepared.promise;if(value.error)throw value.error;decision=value.decision;}else decision=await this.nlu(clean(text),{request:s.base?.request,lastQuestion:s.lastQuestion,history:s.history.slice(-12),questions:s.questions,proposal:s.base?.proposal,quotedOfferReferences,turnMessages,awaiting:s.base?.awaiting,selectedOffer:s.offers.find(o=>o.id===s.selected),offerSummaries:offerSummaries(s.offers),status:s.status},{env:this.env,now});if(decision)console.log('ASSISTANT_NLU_OK_'+decision.intent);}catch(error){console.log(/^NLU_[A-Z0-9_]+$/.test(error.message)?error.message:'ASSISTANT_NLU_UNAVAILABLE');}
  const directedRoute=require('./travel-language').languagePatch(clean(text));
  if(directedRoute.origin||directedRoute.destination){
   decision={...(decision||{}),intent:decision?.intent==='additional_request'?'additional_request':'change',fields:{...(decision?.fields||{}),...(directedRoute.origin?{origin:directedRoute.origin}:{}),...(directedRoute.destination?{destination:directedRoute.destination}:{})},question:null,option:null};
  }
  // Explicit requests to change/expand dates take precedence over model explanations
  // of already displayed fares. Preserve every other trip fact.
  const dateAmendment=/(?:تواريخ|تاريخ|موعد|ايام|شهر|اسبوع)/.test(t)&&/(?:غير|تاني|ثاني|ارخص|اقل سعر|ابحث|دور|شوف|شفلي|عطيني|اعطيني|اريد|بدي)/.test(t);
  if(dateAmendment){
   const parsed=naturalDate(t,now);
   const fields={...(decision?.fields||{})};
   if(parsed.range){fields.rangeStart=parsed.range.start;fields.rangeEnd=parsed.range.end;fields.departureDate=null;}
   else if(parsed.dates?.[0]&&!parsed.invalid)fields.departureDate=parsed.dates[0];
   if(fields.rangeStart&&fields.rangeEnd||fields.departureDate)decision={...(decision||{}),intent:'change',fields,question:null,option:null};
   else return say('أكيد 🌷 منبحث عن تواريخ تانية على نفس المسار وعدد المسافرين والوزن. أي فترة بتناسبك: هالشهر، الشهر الجاي، أو الاتنين؟');
  }
  const additional=decision?.intent==='additional_request'||/(?:طلب|رحل[هة]|سفر[هة])\s*(?:تاني|ثاني|تاني[هة]|ثاني[هة])|(?:وكمان|وكمان بدي)\s+(?:بدي\s+)?(?:رحل[هة]|من\s)/.test(t);
  if(additional&&['queued','searching'].includes(s.status)){
   s.pendingRequests ||= [];
   if(s.pendingRequests.some(r=>normalize(r.text)===t))return say('طلبك التاني بانتظار نتيجة الأول، وبس أرسلك الأسعار ببدأ فيه.');
   if(s.pendingRequests.length>=5)return say('عندي خمس طلبات إلك بانتظار البحث. خلّيني أخلصها بالترتيب، وبعدها منكمل باقي الرحلات.');
   s.pendingRequests.push({text:clean(text),at:now});
   return say('عم اشتغل حاليًا على طلبك الأول، وبس أرسلك الأسعار ببدأ بطلبك التاني.');
  }
  const pendingQuote=s.pendingQuotedOffer?.expiresAt>=now?s.pendingQuotedOffer:null;
  const scopedReferences=quotedOfferReferences.length>1?quotedOfferReferences:pendingQuote?.references||[];
  if(scopedReferences.length>1){
   const number=t.match(/(?:الخيار|العرض)\s*(\d+)|^(\d{1,2})$|(?:^|\s)(الاول|التاني|الثاني|الثالث)(?:\s|$)/);
   const numberRef=number?Number(number[1]||number[2]||({الاول:1,التاني:2,الثاني:2,الثالث:3})[number[3]]):null;
   const explicit=scopedReferences.filter(ref=>{const o=s.offers.find((o,i)=>(o.reference||i+1)===ref);return numberRef===ref||o&&[o.timing?.out?.flight,o.timing?.back?.flight,o.request.departureDate,o.request.departureDate?dateText(o.request.departureDate):null,o.request.returnDate,o.request.returnDate?dateText(o.request.returnDate):null].some(value=>value&&t.replace(/\s/g,'').toLowerCase().includes(String(value).replace(/\s/g,'').toLowerCase()));});
   if(explicit.length===1){
    const previousFields=pendingQuote?.fields||{},currentFields=decision?.fields||{};
    const merged=Object.fromEntries([...new Set([...Object.keys(previousFields),...Object.keys(currentFields)])].map(k=>[k,currentFields[k]!=null&&(!Array.isArray(currentFields[k])||currentFields[k].length)?currentFields[k]:previousFields[k]??currentFields[k]??null]));
    const ref=explicit[0],o=s.offers.find((o,i)=>(o.reference||i+1)===ref);
    decision={...(decision||{}),intent:decision?.intent==='booking'?'booking':decision?.intent==='explain'?'explain':'select',option:ref,fields:merged,question:null};
    if(decision.intent==='booking'){s.selected=o.id;legacy.importSession(id,{request:{...o.request,providerExclusive:true},submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);}
    if(s.questions.offerChoice){s.questions.offerChoice.answered=true;s.questions.offerChoice.status='answered';s.questions.offerChoice.answeredAt=now;}
    delete s.pendingQuotedOffer;
   }else if(['select','booking'].includes(decision?.intent)||/(?:هاد|هدا|هذا|هداك|نفسه|نفسها|هالرحل[هة]|ثبتلي|احجزلي|هالخيار)/.test(t)){
    const prior=s.questions.offerChoice;
    const oldFields=pendingQuote?.fields||{},newFields=decision?.fields||{};
    const pendingFields=Object.fromEntries([...new Set([...Object.keys(oldFields),...Object.keys(newFields)])].map(k=>[k,newFields[k]!=null&&(!Array.isArray(newFields[k])||newFields[k].length)?newFields[k]:oldFields[k]??newFields[k]??null]));
    s.pendingQuotedOffer={references:scopedReferences,fields:pendingFields,expiresAt:now+30*60000};
    s.questions.offerChoice={field:'offerChoice',tripId:s.tripId,askedAt:prior?.askedAt||now,answered:false,status:'asked',reason:'quoted_multiple_offers',options:scopedReferences};
    return say(prior&&!prior.answered?'المسار والتفاصيل محفوظة؛ الرسالة فيها أكتر من عرض، ورقم الخيار بيميّز الرحلة اللي قصدتها.':'الرسالة فيها أكتر من عرض. أي خيار تقصد؟ اذكر رقم الخيار أو رقم الرحلة حتى نكمل على العرض الصحيح.');
   }
  }
  const hasDecisionFields=Boolean(decision&&Object.values(decision.fields||{}).some(v=>Array.isArray(v)?v.length:v!==null));
  if(hasDecisionFields&&s.questions.clarification){s.questions.clarification.answered=true;s.questions.clarification.status='answered';s.questions.clarification.answeredAt=now;}
  const socialIntent=!hasDecisionFields?decision?.intent:null;
  const asksShownOffer=decision?.intent==='explain'&&(decision.option!==null||/سعر|قديش|بكم|افضل|احسن|ارخص|بتنصح|تنصحني|العرض|الخيار/.test(t)&&!hasDecisionFields);
  if(asksShownOffer){
   // An inquiry reads existing verified data; it never selects, changes or books.
   s.selected=priorSelection;legacy.importSession(id,priorBase);s.base=priorBase;
   const offered=s.offers.map((o,i)=>{
    const provider=o.provider||o.request?.provider||'airarabia',verified=verifiedOffer(o,o.request,provider);
    return verified?{...verified,reference:Number.isInteger(o.reference)?o.reference:i+1}:null;
   }).filter(Boolean);
   const option=decision.option;
   let matches=Number.isInteger(option)?offered.filter(o=>o.reference===option):offered;
   if(!Number.isInteger(option)){
    if(/فلاي\s*شام|fly\s*cham/i.test(t)&&!/العربي[هة]|air\s*arabia/i.test(t))matches=matches.filter(o=>o.provider==='flycham');
    else if(/العربي[هة]|air\s*arabia/i.test(t)&&!/فلاي\s*شام|fly\s*cham/i.test(t))matches=matches.filter(o=>o.provider==='airarabia');
   }
   if(!matches.length)return say('ما عندي عرض متحقق لهالخيار ضمن النتائج الحالية. تفاصيل طلبك محفوظة؛ ما رح أعطيك سعر بتخمين أو أغيّر اختيارك.');
   const recommendation=!Number.isInteger(option)&&/افضل|احسن|ارخص|بتنصح|تنصحني/.test(t);
   if(recommendation){matches.sort((a,b)=>{const x=BigInt(a.price.sellingTotal.replace('.','')),y=BigInt(b.price.sellingTotal.replace('.',''));return x<y?-1:x>y?1:0;});matches=matches.filter(o=>o.price.sellingTotal===matches[0].price.sellingTotal);}
   const heading=recommendation?'من ناحية السعر، هاد الأوفر بين العروض المتحققة المعروضة إلك، حسب تواريخ ووزن كل عرض:':'أكيد، هاي تفاصيل العرض المتحقق اللي سألت عنه:';
   return say(heading+'\n\n'+matches.slice(0,6).map(formatOffer).join('\n\n')+'\n\nالسعر والتوفر قابلان للتغير حتى الإصدار. هاد توضيح للعرض؛ ما تغيّر اختيارك وما تم حجز تذكرة.');
  }

  hasChange ||= hasDecisionFields;
  if(!hasDecisionFields&&(socialIntent==='greeting'||/^(?:مرحبا|اهلا|هلا|السلام عليكم|hi|hello|ابد[اأ])$/.test(t))){const greeted=s.greeted;s.greeted=true;return say(greeted?'أهلًا فيك من جديد 🌷 منكمّل على تفاصيلك المحفوظة.':'أهلًا وسهلًا فيك 🌷 معك أحمد، مساعد مجموعة الرمال الافتراضي. كيف فيني ساعدك اليوم؟');}
  if(!hasChange&&(socialIntent==='negotiate'||/زبط|تزبط|خصم|تخفيض|نزل.*سعر|غالي|ارخص من هيك/.test(t))){
   const proposal=legacy.proposeExpansion(id,{now});
   return say((s.offers.length||['searching','queued','done'].includes(s.status)?'تكرم عيونك، عمولة الخدمة ثابتة والسعر المعروض بعد التحقق بيكون نهائي. ':'تكرم عيونك، رح نراجع الخيارات حسب طلبك ونرتّبلك الأسعار المتحققة بوضوح. ')+(proposal?'فينا نقارن سبعة أيام بعد آخر موعد مع الحفاظ على المسار والوزن. بتناسبك نوسّع البحث لهالفترة؟':'فينا نقارن أيام أو تواقيت أوسع إذا بتناسبك، بدون تغيير تفاصيلك من عندنا.'));
  }
  if(!hasChange&&(socialIntent==='goodbye'||/برجع|بعدي?ن بحكي|بدي فكر|بدي افكر|سلام$/.test(t))){s.status='paused';return{...say('أهلًا وسهلًا فيك بأي وقت، شرّفتنا 🌷 لما ترجع بأي سؤال أو استفسار، نحنا بالخدمة.'),cancel:true};}
  if(!recoveredRoute&&!hasChange&&(socialIntent==='status'||/بانتظار|بالانتظار|ناطر|منتظر|شو صار|وين وصلت|لسا|اصبر/.test(t))){
   const busy=['searching','queued'].includes(s.status);const waiting=['شكرًا لانتظارك 🌷 طلبك قيد العمل، عم نراجع الخيارات حسب تفاصيل رحلتك، وأول ما تتأكد نتيجة منرسلها.','مقدّرين انتظارك 🌷 البحث مستمر على نفس طلبك، ومنبعتلك الأسعار والتواقيت بعد التحقق.','معك 🌷 طلبك محفوظ والبحث مستمر؛ أول ما يجهز عرض متحقق منبعته إلك.'];s.waitingCount=(s.waitingCount||0)+1;return say(busy?waiting[(s.waitingCount-1)%waiting.length]:s.status==='failed'?'لم يكتمل التحقق من الأسعار للطلب السابق. فينا نعيد المحاولة على نفس التفاصيل، أو نحدد فترة ثانية.':s.status==='done'?'نتائج البحث المتحققة موجودة بالعرض السابق. فينا نراجع الخيار اللي بناسبك أو نوسّع الفترة إذا حبيت.':s.status==='unsupported'?'تفاصيل رحلتك موجودة، لكن ما تأكّد سعر لهالمسار بعد. بتحب نقارن من الشارقة إلى دمشق أو حلب، أو بالعكس؟':s.base?.awaiting?'تفاصيلك محفوظة، وبانتظار جوابك على النقطة اللي سألتك عنها حتى أكمل على نفس الطلب.':'معك، ما في بحث جارٍ حاليًا. ابعتلي تفاصيل رحلتك ومنرتّب الخيارات المناسبة.');
  }
  if(!recoveredRoute&&!hasChange&&(socialIntent==='thanks'||/^(?:شكرا|شكراً|يسلمو|مشكور|يعطيك العافيه|يعطيك العافية|تمام شكرا|👍)$/.test(t)))return say('أهلًا وسهلًا فيك 🌷');
  if(socialIntent==='cancel'){s.status='cancelled';s.pendingRequests=[];s.questions={};s.lastQuestion=null;legacy.importSession(id,null);return{...say('تم إيقاف بحث الأسعار الحالي. إذا قصدك تذكرة صادرة، وضّحلي حتى نميّزها عن الاستعلام.'),cancel:true};}
  const selectOffer=(index,{announce=true}={})=>{
   const offer=s.offers.find(o=>o.reference===index+1)||s.offers[index];
   if(!offer)return say('أي عرض تقصد؟ اذكر تاريخ الرحلة أو رقم الخيار من آخر مقارنة.');
   s.selected=offer.id;
   // Subsequent amendments apply to the selected flight, not the whole earlier comparison.
   legacy.importSession(id,{request:{...offer.request,providerExclusive:true},submitted:true,awaiting:null,at:now});s.base=legacy.exportSession(id);
   if(!announce)return null;
   return say(`تمام، اخترت الخيار ${index+1} بتاريخ ${offer.request.departureDate}، رحلة ${offer.timing.out.flight}. السعر والتوفر يحتاجان إعادة تحقق عند التثبيت. بتحب تعرف كيف نتابع التثبيت؟`);
  };
  const selection=t.match(/(?:الخيار|العرض)\s*(\d+)|^(الاول|التاني|الثاني|الثالث)$/);
  if(selection&&!hasDecisionFields&&!/كيلو|كغ|\bkg\b|بدل|خلي|غير|قصدي|ذهاب|عوده|رجعه/.test(t))return selectOffer(selection[1]?Number(selection[1])-1:({الاول:0,التاني:1,الثاني:1,الثالث:2})[selection[2]]);
  if(!hasDecisionFields&&/السعر.*(?:شخص|كلنا|اثنين|اتنين)|للشخص|للمجموع/.test(t))return say('العرض الآلي المؤكد حاليًا لشخص بالغ واحد، وليس سعر مجموعة. إذا عددكن أكثر لازم نتحقق من السعر والتوفر للعدد الصحيح، ولا نضرب سعر الشخص بالعدد كتقدير مؤكد.');
  if(/^(?:ارجع متل قبل|رجعه متل قبل|الغي اخر تعديل)$/.test(t)){
   const previous=s.previous.pop();if(!previous)return say('أي تفصيل بدك نرجعه: الوزن أو التاريخ أو المسار؟');legacy.importSession(id,previous);s.base=previous;s.status='queued';previous.submitted=false;legacy.importSession(id,previous);const result=legacy.handleMessage(id,'تابع نفس التفاصيل',{now});this.save(id,s);return result;
  }
  if(['اي','نعم','تمام','اوكي','حاضر','ok'].includes(t)&&['searching','queued'].includes(s.status)&&!s.lastQuestion)return say('تمام 🌷 البحث مستمر على نفس تفاصيل طلبك، وأول ما تتأكد الأسعار والتواقيت منرسلها إلك.');
  if(!recoveredRoute&&['اي','نعم','تمام'].includes(t)&&s.lastQuestion?.includes('أو'))return say('أكيد، أي خيار من المذكورين بتفضّل؟');
  if(decision?.intent==='select'&&decision.option!==null){const selected=selectOffer(decision.option-1,{announce:!hasDecisionFields});if(selected)return selected;}
  const book=decision?.intent==='booking'||(!hasDecisionFields&&/كيف.*(?:ثبت|تثبيت|حجز|ادفع)|بدي ثبت|ثبتلي|ثب[تّ]لي|احجزلي|احجز لي|رابط الدفع|بدي احكي.*موظف/.test(t));
  if(book){
   const offer=s.offers.find(o=>o.id===s.selected)||s.offers.length===1&&s.offers[0];
   if(!offer)return say(s.offers.length?'أكيد، أي خيار بدك تتابع تثبيته؟ اذكر رقم الخيار أو تاريخ الرحلة.':'التثبيت يتم مع موظف الحجوزات. خلينا نحدد الرحلة أولًا حتى تكون تفاصيل طلبك واضحة.');
   if(!s.handoffId)s.handoffId=this.store.handoff(id,{request:offer.request,offer,verificationRequired:true});s.status='handoff_pending';
   return{...say('سجّلت رغبتك بمتابعة تثبيت الخيار المحدد. التثبيت والإصدار مع موظف الحجوزات بعد إعادة التحقق من السعر والتوفر؛ لم يتم حجز أو إصدار تذكرة بعد.'),cancel:true,handoff:s.handoffId};
  }
  const knownTripType=decision?.fields?.tripType||legacy.parseTripType(clean(text))||s.base?.request?.tripType;
  const repeatsKnownTrip=Boolean(knownTripType&&/ذهاب|عود[هة]|رجع[هة]|نوع الرحل/.test(normalize(decision?.question||'')));
  const hypothetical=decision?.intent==='compare'||(/لو |قديش.*(?:بيصير|بصير|بوفر|الفرق)|بس قلي|بس قولي|بكم/.test(t)&&Boolean(s.base?.submitted));
  if(/كيلو|كغ/.test(t)&&/معنا|سوا|مجموع/.test(t)&&!/(?:لكل|للشخص|اجمالي|مجموع)/.test(t))return say('الوزن المطلوب لكل شخص، أو مجموع الوزن للمسافرين سوا؟');
  if(/زيادة|اضافي|إضافي/.test(t)&&/كيلو|كغ/.test(t)&&!s.base?.request?.baggageRequest)return say('قصدك الوزن الإجمالي للشنط، أو زيادة فوق الوزن الموجود بالعرض؟');
  if(/مو هيك|ما فهمت|ما قلت|بدي اخف|غيره$|مو .*|لا تغير/.test(t)&&!decision)return say('خلينا نضبطها بدون تغيير التفاصيل الثانية: قصدك نعدّل الوزن، أو الموعد، أو نبحث عن سعر أقل؟');
  if(/الا |باستثناء|لازم.*(?:اوصل|وصول)|بدون ترانزيت|مباشر حصرا|قطعتين|قطعه|قطعة/.test(t)&&!decision)return say('فهمت إن عندك شرط إضافي على الرحلة. حتى ما نعرض خيارًا غير مناسب، حدد الشرط بدقة؛ التحقق الآلي من بعض شروط الوصول وعدد القطع غير مكتمل حاليًا.');
  if(!hasDecisionFields&&decision?.intent==='explain'){
   const facts=explainService(t,s.base?.request,s.status);
   if(facts)return say(facts);
  }
  if(!recoveredRoute&&!hasDecisionFields&&['uncertain','other','explain'].includes(decision?.intent)&&decision?.question&&!knownQuestion(decision.question,s.base?.request)){
   const key='clarification',fingerprint=normalize(decision.question);const prior=s.questions[key];
   if(prior?.fingerprint===fingerprint&&!prior.answered)return say('أنا معك، والتفاصيل اللي اتفقنا عليها محفوظة. وضّحلي النقطة اللي قصدتها بكلمتين حتى أعطيك جواب مناسب.');
   s.questions[key]={field:key,tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:decision.intent,fingerprint};return say(decision.question);
  }
  const previous=legacy.exportSession(id);
  let result=legacy.handleMessage(id,clean(text),{now,patch:decision?.fields});let base;
  base=legacy.exportSession(id);
  const changed=JSON.stringify(previous?.request||{})!==JSON.stringify(base?.request||{});
  for(const [field,q]of Object.entries(s.questions)){
   const r=base?.request;const answered=answeredField(field,r);
   if(answered){q.answered=true;q.answeredAt ||= now;q.status='answered';}
  }
  if(!result.clarification&&decision?.intent==='clarify'&&!hasDecisionFields&&!changed&&!knownQuestion(decision.question,base?.request)&&decision.question)result.reply=decision.question;

  if(!result.complete&&base?.awaiting){
   const field=base.awaiting,prior=s.questions[field];
   if(prior&&!prior.answered&&(!result.clarification||prior.reason===result.clarification)){
    prior.reminderCount=(prior.reminderCount||0)+1;
    const r=base.request;
    const reminders={origin:r.destination?`الوجهة ${r.destination} واضحة؛ ناقصني مدينة الانطلاق فقط.`:'ناقصني مدينة الانطلاق حتى أحدد المسار.',destination:r.origin?`المغادرة من ${r.origin} واضحة؛ ناقصني المدينة اللي بدك توصل إلها فقط.`:'ناقصني المدينة اللي بدك توصل إلها.',departureDate:'تفاصيل المسار محفوظة؛ ناقصني يوم السفر أو فترة مناسبة مثل هالأسبوع.',tripType:'المسار والموعد محفوظين؛ ناقصني إذا بدك ذهاب بس أو مع رجعة.',returnDate:'تفاصيل الذهاب محفوظة؛ ناقصني موعد الرجعة أو مدة الإقامة.',passengers:'تفاصيل الرحلة محفوظة؛ ناقصني عدد المسافرين فقط، مثل «شخص واحد». إذا معك أطفال اذكر أعمارهن.'};
    result.reply=reminders[field]||result.reply;
   }
   else{s.questions[field]={field,tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:result.clarification||'missing_fact',reminderCount:0};s.lastQuestion=result.reply;}
  }
  if(result.complete){s.lastQuestion=null;s.revision=(s.revision||0)+1;}
  if(changed&&previous?.submitted&&!result.complete){result.cancel=true;s.status='collecting';}
  if(base?.request?.passengers){const p=base.request.passengers;if(p.children+p.infants>(p.ages?.length||0)){result={complete:false,reply:s.questions.childrenAges&&!s.questions.childrenAges.answered?'عدد المسافرين محفوظ؛ باقي أعمار الأطفال والرضّع وقت السفر حتى نميّز الفئة الصحيحة.':'كم أعمار الأطفال والرضّع وقت السفر؟ اذكر عمر كل واحد حتى ما نحسب سعرًا لفئة غير صحيحة.'};s.questions.childrenAges ||= {field:'childrenAges',tripId:s.tripId,askedAt:now,answered:false,status:'asked',reason:'passenger_category'};}}
  if(hypothetical&&result.complete){result.comparison=true;s.comparison={request:result.request,base:previous};legacy.importSession(id,previous);}
  else if(result.complete){delete s.pendingQuotedOffer;if(previous)s.previous.push(previous);s.previous=s.previous.slice(-5);s.offers=[];s.selected=null;s.comparison=null;}
  if(result.complete){const issue=capabilityIssue(result.request.provider==='flycham'&&!result.request.providerExclusive?{...result.request,provider:'airarabia'}:result.request);if(issue){s.status='unsupported';const blocked=legacy.exportSession(id);if(blocked){blocked.submitted=false;legacy.importSession(id,blocked);}result={complete:false,reply:issue==='passengers'?'فهمت عدد المسافرين. التسعير الآلي المتحقق منه حاليًا يدعم بالغًا واحدًا فقط؛ ما رح أعطيك سعر مجموعة بتخمين أو بضرب سعر الشخص.':issue==='route'?'ما عندي سعر مؤكّد لهالمسار حاليًا. بتحب نقارن من الشارقة إلى دمشق أو حلب، أو بالعكس؟':'سجّلت تفاصيلك، لكن شروط القطع أو المقعد الخاص أو قيود الوصول تحتاج تحققًا لا يدعمه الربط الحالي. لن أعرض خيارًا وكأنه يحققها دون تأكيد.'};}else{s.status='queued';s.coverage=[];}}
  if(!result.complete&&!['searching','queued'].includes(s.status)&&/طلبك السابق مسجل/.test(result.reply))result.reply='أكيد 🌷 فينا نراجع نفس الرحلة أو نبحث بتواريخ تانية. أي فترة بتناسبك للبحث؟';
  if(!result.complete&&['searching','queued'].includes(s.status)&&/طلبك السابق مسجل/.test(result.reply))result.reply='شكرًا لمتابعتك 🌷 البحث مستمر على نفس تفاصيل رحلتك، وأول ما تتأكد الأسعار والتواقيت منرسلها إلك. أي تعديل تبعته منضيفه على نفس الطلب.';
  if(result.complete)s.lastQuestion=null;else if(/[؟?]/.test(result.reply))s.lastQuestion=result.reply;
  if(/^(?:يسلمو|شكرا|شكراً|مشكور)/.test(t)&&result.complete)result.reply='تكرم عيونك. '+result.reply;
  s.history.push({role:'assistant',text:result.reply});s.history=s.history.slice(-24);
  this.save(id,s);return result;
 }
 beginNextRequest(id){const s=this.state(id);if(!s.queueReady||!['done','failed'].includes(s.status)||!s.pendingRequests?.length)return null;const next=s.pendingRequests.shift();s.queueReady=false;s.previous ||= [];if(s.base)s.previous.push(s.base);s.previous=s.previous.slice(-5);s.base=null;s.lastQuestion=null;s.questions={};s.selected=null;s.offers=[];s.comparison=null;s.activeComparisonId=null;s.status='collecting';s.tripId=crypto.randomUUID();legacy.importSession(id,null);this.store.set(id,s);return next;}
 jobState(id,status){const s=this.state(id);s.status=status;this.store.set(id,s);}
 progress(id,data,messageId){const s=this.state(id);s.status='searching';if(data.coverage)s.coverage=data.coverage.slice(0,32);if(data.offer){const o=data.offer;if(o.request&&o.timing?.out?.flight&&/^\d+\.\d{2}$/.test(o.price?.sellingTotal||'')){const item={...o,id:offerId(o),messageId};const index=s.offers.findIndex(x=>x.id===item.id);if(index<0)s.offers.push(item);else s.offers[index]=item;s.offers=s.offers.slice(-80);}}this.store.set(id,s);}
 status(){return{policy:POLICY.version,aiConfigured:aiConfigured(this.env),aiProvider:aiProvider(this.env),...this.store.status(),humanRoutingConfigured:Boolean(this.env.HUMAN_HANDOFF_RECIPIENT),providers:POLICY.providers};}
}
module.exports={AssistantEngine,offerId};
