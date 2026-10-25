'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {understandConsultant,schema}=require('../src/consultant-brain');
const {AssistantEngine}=require('../src/assistant-engine');
const {AssistantState}=require('../src/assistant-state');
const now=Date.parse('2026-10-25T08:00:00Z');
const initial='من الشارقة للشام 11-11-2090 ذهاب بس شخص واحد';
const trip={origin:'الشارقة',destination:'دمشق',departureDate:'2090-11-11',tripType:'one_way',passengers:{adults:1,children:0,infants:0,ages:[]},baggageRequest:{checkedWeightKg:30}};
function decision(intent='greeting',action='answer',reply=null){return{intent,fields:Object.fromEntries(Object.entries(schema.properties.fields.properties).map(([k,v])=>[k,v.type==='array'?[]:null])),question:null,option:null,consultant:{action,reply,preferences:{priority:null,airportFlexibility:null},nextStep:'none',knowledgeQuery:null}};}
function make(nlu){return new AssistantEngine({store:new AssistantState({file:null,now:()=>now}),env:{CONSULTANT_ORCHESTRATOR_ENABLED:'true'},nlu});}
test('primary and quota fallback receive only a few bounded curated situations, never private guide content',async()=>{
 const seen=[],env={ASSISTANT_AI_PROVIDER:'cline',CLINE_API_KEY:'synthetic-guide-'+Math.random(),GEMINI_API_KEY:'synthetic-gemma-'+Math.random()};
 const context={status:'searching',request:{...trip,password:'PRIVATE_PASSWORD'},history:[{role:'user',text:'اسمي PRIVATE_NAME، إيميلي user@example.com'},{role:'assistant',text:'PRIVATE_ASSISTANT'}],consultantMemory:{preferences:{priority:'cheapest'},secret:'PRIVATE_MEMORY'},secret:'PRIVATE_CONTEXT'};
 await understandConsultant('بدي ثلاثين كيلو على نفس الرحلة',context,{env,now,fetchImpl:async(url,opt)=>{
  const body=JSON.parse(opt.body),input=JSON.parse(body.messages?.[1]?.content||body.contents[0].parts[0].text);seen.push({url,body,input});
  if(seen.length===1)return{ok:false,status:429,json:async()=>({error:{code:'quota_exhausted'}})};
  return{ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(decision('change','amend'))}]}}]})};
 }});
 assert.equal(seen.length,2);assert.match(seen[1].url,/generativelanguage/);
 for(const {input}of seen){const guide=input.context.conversationGuide,encoded=JSON.stringify(guide);assert.ok(encoded.length<=2500);assert.ok(guide.situations.length>=1&&guide.situations.length<=3);assert.ok(guide.situations.some(s=>s.id==='weight_amendment'));assert.doesNotMatch(encoded,/PRIVATE_|user@example.com|2090|sellingTotal|password/);assert.ok(!guide.situations.some(s=>/_missing$/.test(s.id)));}
 assert.deepEqual(seen[0].input.context.conversationGuide,seen[1].input.context.conversationGuide);assert.deepEqual(seen[1].input.context.history,[]);assert.match(seen[0].body.messages[0].content,/guide example/);
});
test('active wait replies vary despite repeated model boilerplate and preserve the actual search version',async()=>{
 const e=make(async text=>text===initial?decision('request','search'):decision('status','status','معك، عم نراجع طلبك 🌷'));
 assert.equal((await e.handle('wait-library',initial,{now})).complete,true);e.jobState('wait-library','searching');
 const before=structuredClone(e.state('wait-library').base.request),version=e.state('wait-library').consultant.requestVersion,replies=[];
 for(let i=0;i<7;i++){const r=await e.handle('wait-library','طمني عن طلبي',{now:now+i+1});assert.equal(r.complete,false);assert.doesNotMatch(r.reply,/عم نراجع طلبك/);assert.match(r.reply,/قيد البحث|البحث مستمر|التحقق/);if(replies.length)assert.notEqual(r.reply,replies.at(-1));replies.push(r.reply);}
 assert.equal(new Set(replies).size,3);assert.deepEqual(e.state('wait-library').base.request,before);assert.equal(e.state('wait-library').consultant.requestVersion,version);assert.ok(e.state('wait-library').responseLibraryRecent.length<=12);
});
test('nonactive status cannot be replaced by model progress and preserves an unanswered question',async()=>{
 const e=make(async text=>text==='طمني عن طلبي'?decision('status','status','عم نكمّل التحقق من الخيارات 🌷'):decision('request','search'));
 await e.handle('wait-missing','من الشارقة للشام 11-11-2090 ذهاب بس',{now});
 const before=structuredClone(e.state('wait-missing').base.request),question=e.state('wait-missing').lastQuestion;
 const r=await e.handle('wait-missing','طمني عن طلبي',{now:now+1});assert.match(r.reply,/بانتظار جوابك/);assert.doesNotMatch(r.reply,/قيد البحث|البحث مستمر|عم نكمّل/);assert.equal(e.state('wait-missing').lastQuestion,question);assert.deepEqual(e.state('wait-missing').base.request,before);
 const idle=make(async()=>decision('status','status','عم نكمّل التحقق من الخيارات 🌷'));const empty=await idle.handle('idle-wait','طمني عن طلبي',{now});assert.match(empty.reply,/ما في بحث جارٍ/);assert.doesNotMatch(empty.reply,/عم نكمّل/);
});
test('fresh safe greeting remains personal while repeated wording uses variations without duplicate identity',async()=>{
 const modelGreeting='أهلًا فيك، بساعدك تختار الرحلة المناسبة إلك 🌷',e=make(async()=>decision('greeting','answer',modelGreeting));
 const first=await e.handle('greet-library','مرحبا',{now}),second=await e.handle('greet-library','مرحبا',{now:now+1}),third=await e.handle('greet-library','مرحبا',{now:now+2});
 assert.match(first.reply,/بساعدك تختار/);assert.equal((first.reply.match(/أحمد/g)||[]).length,1);assert.doesNotMatch(second.reply,/بساعدك تختار|أحمد/);assert.notEqual(second.reply,third.reply);assert.equal(e.state('greet-library').status,'idle');
});
test('thanks and negotiation variants retain facts, one real expansion question and fixed commissions',async()=>{
 let intent='request';const e=make(async()=>intent==='request'?decision('request','search'):decision(intent,'answer','تكرم عيونك، نحنا بالخدمة 🌷'));
 await e.handle('social-library',initial,{now});e.jobState('social-library','done');const before=structuredClone(e.state('social-library').base.request);
 intent='thanks';const a=await e.handle('social-library','ألف شكر',{now:now+1}),b=await e.handle('social-library','ألف شكر',{now:now+2});assert.notEqual(a.reply,b.reply);assert.equal(a.complete,false);assert.equal(b.complete,false);
 intent='negotiate';const c=await e.handle('social-library','غالي',{now:now+3}),d=await e.handle('social-library','غالي',{now:now+4});assert.notEqual(c.reply,d.reply);
 for(const r of [c,d]){assert.match(r.reply,/عمولة الخدمة ثابتة/);assert.match(r.reply,/نهائي/);assert.match(r.reply,/سبعة أيام/);assert.equal((r.reply.match(/[؟?]/g)||[]).length,1);assert.equal(r.complete,false);assert.doesNotMatch(r.reply,/خصم|بننزلك|آخر مقعد/);}
 assert.deepEqual(e.state('social-library').base.request,before);assert.equal(e.state('social-library').base.proposal.choiceCount,1);
 intent='goodbye';const leave=await e.handle('social-library','برجعلكن',{now:now+5});assert.equal(leave.cancel,true);assert.equal(e.state('social-library').status,'paused');assert.doesNotMatch(leave.reply,/حجزت|تم الحجز|جاري البحث/);
});
