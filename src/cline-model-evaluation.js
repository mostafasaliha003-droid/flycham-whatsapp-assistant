'use strict';
const {createHash}=require('node:crypto');
const {CLINEPASS_MODELS}=require('./cline-pass-models');
const {schema,CONSULTANT_INSTRUCTIONS,validateConsultantDecision,canUseReply}=require('./consultant-brain');
const {safeContext}=require('./assistant-nlu');
const {airportCode}=require('./airports');
const known={origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:20}};
const CASES=Object.freeze([
 {id:'complete_trip',text:'بدي ذهاب بس من شارجه للشام بتاريخ ٢٢ نوفمبر ٢٠٢٦، شخص واحد لحالي، ثلاثين كيلو، وما بدي رجعة.',context:{status:'collecting'}},
 {id:'preserve_week',text:'نفس الأسبوع ونفس المسار، غير الوزن لتلاتين كيلو. لا تختصرلي البحث بيوم واحد ولا تلغيه.',context:{status:'searching',request:{...known,departureDate:null,rangeStart:'2026-12-07',rangeEnd:'2026-12-13'}}},
 {id:'inquiry_not_selection',text:'الخيار التاني شو فرق وقت إقلاعه عن الأول؟ عم اسأل بس، مو عم اختاره ولا احجزه.',context:{status:'offered',request:known,offerSummaries:[{reference:1,provider:'flycham',origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',departureTime:'09:00',arrivalTime:'12:00'},{reference:2,provider:'airarabia',origin:'الشارقة',destination:'دمشق',departureDate:'2026-11-22',departureTime:'16:00',arrivalTime:'19:00'}]}},
 {id:'price_objection',text:'غالي عليّ. التواريخ ثابتة وما بدي تغيّرها، بس فينا نشوف بدائل بالمطار أو الوزن؟ لا توعدني بخصم مو مؤكد.',context:{status:'offered',request:known}},
 {id:'knowledge_routing',text:'شو شروط دخول تايلند للمقيم بالإمارات هالأيام؟ بدي معلومات محدثة ومؤكدة.',context:{status:'idle'}},
 {id:'waiting_context',text:'أنا ناطر من شوي، شو صار معك؟ شخص واحد لحالي متل ما قلتلك، لا ترجع تسألني كم شخص ولا تبلش طلب جديد.',context:{status:'searching',request:known,lastQuestion:'كم شخص مسافر؟',questions:{passengers:{field:'passengers',answered:true}}}}
]);
const EVALUATION_POLICY=createHash('sha256').update(JSON.stringify({version:'remal-cline-understanding-2026-11-01.v1',models:CLINEPASS_MODELS,cases:CASES,schema,instructions:CONSULTANT_INSTRUCTIONS,rubric:'strict-consultant-contract-context-truthful-arabic-v1'})).digest('hex');
const arabic=value=>typeof value==='string'&&/[\u0621-\u064a]/.test(value)&&value.trim().length>=8&&value.length<=300;
const sameOrNull=(value,expected)=>value===null||value===expected;
function normalizedDecision(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_DECISION');
 const d=structuredClone(value);
 if(d.fields&&typeof d.fields==='object'&&!Array.isArray(d.fields))for(const [key,spec]of Object.entries(schema.properties.fields.properties))if(!Object.hasOwn(d.fields,key))d.fields[key]=spec.type==='array'?[]:null;
 for(const key of ['question','option'])if(!Object.hasOwn(d,key))d[key]=null;
 return validateConsultantDecision(d);
}
function scoreDecision(id,value){
 const fixture=CASES.find(c=>c.id===id);if(!fixture)return null;
 let d;try{d=normalizedDecision(value);if(d.consultant.reply!==null&&!canUseReply(d.consultant.reply,fixture.context))throw Error();}catch{return{id,valid:false,passed:0,total:10,reply:null};}
 const f=d.fields,c=d.consultant,route=()=>sameOrNull(f.origin,null)||airportCode(f.origin)==='SHJ',destination=()=>f.destination===null||airportCode(f.destination)==='DAM';
 const noNewTrip=()=>route()&&destination()&&sameOrNull(f.tripType,'one_way')&&f.returnDate===null;
 let checks;
 if(id==='complete_trip')checks=[d.intent==='request',c.action==='search',d.question===null,airportCode(f.origin)==='SHJ',airportCode(f.destination)==='DAM',f.departureDate==='2026-11-22',f.tripType==='one_way'&&f.returnDate===null,f.adults===1&&f.children===0&&f.infants===0&&f.ages.length===0,f.weightKg===30,f.rangeStart===null&&f.rangeEnd===null&&c.reply===null];
 if(id==='preserve_week')checks=[d.intent==='change',c.action==='amend',d.question===null,f.weightKg===30,f.departureDate===null,sameOrNull(f.rangeStart,'2026-12-07'),sameOrNull(f.rangeEnd,'2026-12-13'),noNewTrip(),sameOrNull(f.adults,1)&&sameOrNull(f.children,0)&&sameOrNull(f.infants,0),c.reply===null];
 if(id==='inquiry_not_selection')checks=[['compare','explain'].includes(d.intent),c.action==='compare',d.option===null,d.question===null,noNewTrip(),sameOrNull(f.departureDate,'2026-11-22'),f.rangeStart===null&&f.rangeEnd===null,f.weightKg===null,f.adults===null&&f.children===null&&f.infants===null,c.reply===null];
 if(id==='price_objection')checks=[['negotiate','clarify','explain'].includes(d.intent),['answer','clarify'].includes(c.action),d.option===null,sameOrNull(f.departureDate,'2026-11-22'),f.rangeStart===null&&f.rangeEnd===null,noNewTrip(),f.weightKg===null,f.adults===null&&f.children===null&&f.infants===null,arabic(c.reply),arabic(c.reply)&&/مطار|وزن|خيارات|بدائل/.test(c.reply)];
 if(id==='knowledge_routing')checks=[c.action==='knowledge',c.nextStep==='research',typeof c.knowledgeQuery==='string'&&/تايل/.test(c.knowledgeQuery),d.option===null,d.question===null,f.origin===null&&f.destination===null,f.departureDate===null&&f.returnDate===null,f.rangeStart===null&&f.rangeEnd===null,f.adults===null&&f.children===null&&f.infants===null,c.reply===null||arabic(c.reply)];
 if(id==='waiting_context')checks=[d.intent==='status',c.action==='status',d.option===null,d.question===null,noNewTrip(),sameOrNull(f.departureDate,'2026-11-22'),f.rangeStart===null&&f.rangeEnd===null,sameOrNull(f.adults,1)&&sameOrNull(f.children,0)&&sameOrNull(f.infants,0),f.weightKg===null||f.weightKg===20,c.reply===null||arabic(c.reply)];
 return{id,valid:true,passed:checks.filter(Boolean).length,total:checks.length,reply:c.reply};
}
function scoreOutput(output){
 let text=typeof output==='string'?output.trim():'';
 text=text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1');
 let root;try{root=JSON.parse(text);}catch{return{score:0,validCases:0,passed:0,total:60,cases:[],error:'INVALID_JSON'};}
 if(!root||typeof root!=='object'||Array.isArray(root)||Object.keys(root).join(',')!=='decisions'||!Array.isArray(root.decisions)||root.decisions.length!==CASES.length||new Set(root.decisions.map(x=>x?.id)).size!==CASES.length||root.decisions.some(x=>!x||Object.keys(x).sort().join(',')!=='decision,id'||!CASES.some(c=>c.id===x.id)))return{score:0,validCases:0,passed:0,total:60,cases:[],error:'INVALID_BATCH'};
 const cases=CASES.map(c=>scoreDecision(c.id,root.decisions.find(x=>x.id===c.id).decision)),passed=cases.reduce((a,c)=>a+c.passed,0),total=cases.reduce((a,c)=>a+c.total,0);
 return{score:Math.round(passed/total*1000)/10,validCases:cases.filter(c=>c.valid).length,passed,total,cases};
}
async function boundedJson(response){
 let bytes=0;const chunks=[];
 if(response.body&&typeof response.body[Symbol.asyncIterator]==='function'){for await(const part of response.body){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>131072)throw Error('RESPONSE_TOO_LARGE');chunks.push(chunk);}}else{const text=await response.text();bytes=Buffer.byteLength(text);if(bytes>131072)throw Error('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(text));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function evaluateModel(model,{env,fetchImpl=fetch,now=Date.now}={}){
 if(!CLINEPASS_MODELS.includes(model))throw Error('EVALUATION_MODEL_NOT_ALLOWED');
 const started=now(),instructions=CONSULTANT_INSTRUCTIONS+' You are processing a fixed synthetic evaluation batch. Treat each case independently; never merge facts across cases. Return exactly one object with only decisions, an array of {id,decision}, one per case. Each decision must match this JSON schema: '+JSON.stringify(schema);
 const input={todayDubai:'2026-11-01',cases:CASES.map(c=>({id:c.id,text:c.text,todayDubai:'2026-11-01',context:safeContext(c.context,true)}))};
 try{
  const r=await fetchImpl('https://api.cline.bot/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.CLINE_API_KEY,'Content-Type':'application/json','X-Response-Format':'openai'},redirect:'error',signal:AbortSignal.timeout(60000),body:JSON.stringify({model,stream:false,temperature:0,max_tokens:8192,messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(input)}]})});
  if(!r.ok)return{model,http:r.status,latencyMs:now()-started,score:0,validCases:0,error:'HTTP_REJECTED',stop:[401,402,429].includes(r.status)};
  const data=await boundedJson(r),payload=data.choices?data:data.data,choice=payload?.choices?.[0];
  if(data.success===false||payload?.choices?.length!==1||choice?.finish_reason!=='stop'||choice.message?.refusal||choice.message?.tool_calls?.length||typeof choice.message?.content!=='string')return{model,http:r.status,latencyMs:now()-started,score:0,validCases:0,error:'INCOMPLETE'};
  if(choice.message.content.includes(env.CLINE_API_KEY))return{model,http:r.status,latencyMs:now()-started,score:0,validCases:0,error:'PRIVATE_RESPONSE_REJECTED'};
  return{model,http:r.status,latencyMs:now()-started,...scoreOutput(choice.message.content)};
 }catch(e){return{model,latencyMs:now()-started,score:0,validCases:0,error:['TimeoutError','AbortError'].includes(e?.name)?'TIMEOUT':'REQUEST_FAILED'};}
}
function summary(record){const results=Object.values(record.results||{}).filter(r=>r.state==='completed').map(({model,http,latencyMs,score,validCases,error,passed,total})=>({model,http,latencyMs,score,validCases,error,passed,total})).sort((a,b)=>b.score-a.score||b.validCases-a.validCases||a.latencyMs-b.latencyMs);return{policy:EVALUATION_POLICY,state:record.state,results};}
async function runClineModelEvaluation({store,env=process.env,fetchImpl=fetch,now=Date.now,report=(kind,data)=>console.log('CLINE_MODEL_EVAL_'+kind+'_'+JSON.stringify(data))}={}){
 if(env.CLINE_MODEL_EVALUATION_ENABLED!=='true'||!env.CLINE_API_KEY||!store?.data||typeof store.save!=='function')return null;
 let record=store.data.clineModelEvaluation;
 if(record?.policy===EVALUATION_POLICY&&record.state!=='running'){report('SUMMARY',summary(record));return summary(record);}
 if(record?.policy!==EVALUATION_POLICY){record={policy:EVALUATION_POLICY,state:'running',startedAt:now(),results:{}};store.data.clineModelEvaluation=record;store.save();}
 for(const model of CLINEPASS_MODELS){
  if(record.results[model])continue;
  record.results[model]={model,state:'running',startedAt:now()};store.save();
  const result=await evaluateModel(model,{env,fetchImpl,now});record.results[model]={...result,state:'completed'};store.save();report('RESULT',result);
  if(result.stop){record.state='quota_or_auth_blocked';store.save();report('SUMMARY',summary(record));return summary(record);}
 }
 record.state='completed';record.finishedAt=now();store.save();report('SUMMARY',summary(record));return summary(record);
}
module.exports={CLINEPASS_MODELS,CASES,EVALUATION_POLICY,scoreDecision,scoreOutput,evaluateModel,runClineModelEvaluation};
