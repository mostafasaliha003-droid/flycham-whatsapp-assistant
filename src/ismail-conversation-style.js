'use strict';

// Opt-in application-owned wording only. This module has no provider, network,
// credentials or action tools. A future model may propose this bounded plan,
// but never supply prose, prices, links, statuses or applicant declarations.
const FEATURE='ISMAIL_CONVERSATION_STYLE_ENABLED';
const PLAN_TIMEOUT_MS=100;
const KEYS=['version','bodyRef','questionRef','socialRef','style','opening'];
const STYLES=new Set(['warm','direct']);
const SOCIAL=Object.freeze({
 greeting:Object.freeze({source:'أهلاً فيك 🌷 أنا معك، ومنكمل على نفس طلب التأشيرة.',warm:'أهلاً بعودتك 🌷 منكمل من آخر نقطة وقفنا عندها.',direct:'أهلاً فيك، منكمل على نفس تفاصيل طلبك.'}),
 thanks:Object.freeze({source:'أهلاً وسهلاً فيك، بالخدمة دائماً 🌷',warm:'العفو، بالخدمة 🌷',direct:'أهلاً فيك، بالخدمة.'}),
 goodbye:Object.freeze({source:'أهلاً وسهلاً فيك بأي وقت 🌷 بس تكون جاهز ابعتلنا، ومنكمل من آخر نقطة وصلنالها.',warm:'أكيد، خذ راحتك. لما تحب تكمّل، منرجع لنفس التفاصيل.',direct:'أهلاً فيك بأي وقت، ومنكمل على نفس طلبك لما تكون جاهز.'})
});
const DATE_QUESTION='إذا سفرك قريب، شو تاريخ السفر؟';

function enabled(env){return env?.[FEATURE]==='true';}
function validDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function questionKind(key){
 if(['nationality','documentType','applicantCount'].includes(key))return key;
 const match=/^(nationality|documentType|issuer)_(\d{1,2})$/.exec(String(key));
 return match&&Number(match[2])<30?match[1]:null;
}
function questionUnanswered(c,key){
 if(key==='nationality')return !c.applicants?.[0]?.nationality;
 if(key==='documentType')return !c.applicants?.[0]?.documentType;
 if(key==='applicantCount')return !c.applicantCount;
 const match=/^(nationality|documentType|issuer)_(\d{1,2})$/.exec(String(key));
 if(!match||Number(match[2])>=30)return false;
 const person=c.applicants?.[Number(match[2])]||{};
 return match[1]==='issuer'?person.documentType==='travel_document'&&!person.documentIssuer:!person[match[1]];
}
function questionWording(key,style){
 const match=/^(nationality|documentType|issuer)_(\d{1,2})$/.exec(String(key));
 if(match){
  const person=Number(match[2])+1;
  if(match[1]==='nationality')return style==='warm'?`شو جنسية الشخص رقم ${person} اللي بدنا نضيفه؟`:`شو جنسية المتقدم ${person}؟`;
  if(match[1]==='documentType')return style==='warm'?`المتقدم ${person} معه جواز سفر عادي أو وثيقة سفر؟`:`المستند للمتقدم ${person} جواز عادي أو وثيقة سفر؟`;
  return style==='warm'?`وثيقة المتقدم ${person} صادرة من أي بلد؟`:`شو بلد إصدار وثيقة المتقدم ${person}؟`;
 }
 if(key==='nationality')return style==='warm'?'شو جنسية الشخص اللي حابب يقدّم؟':'شو جنسية المتقدم؟';
 if(key==='documentType')return style==='warm'?'المستند جواز سفر عادي أو وثيقة سفر؟':'جواز سفر عادي أو وثيقة سفر؟';
 if(key==='applicantCount')return style==='warm'?'التقديم لشخص واحد أو لأكثر من شخص؟':'كم شخص حابب يقدّم؟';
 return null;
}
function sourcesFor({reply,caseState,completion,questionKey}){
 const social=Object.entries(SOCIAL).find(([,entry])=>entry.source===reply)?.[0]||null;
 let question=null;
 if(typeof completion==='string'&&completion&&reply.endsWith(completion)&&
   (reply.length===completion.length||/\s/.test(reply[reply.length-completion.length-1]))&&
   questionKind(questionKey)&&questionUnanswered(caseState,questionKey)){
  question={ref:'engine.question',text:completion,kind:questionKind(questionKey),key:questionKey,answered:false};
 }else if(reply.endsWith(DATE_QUESTION)&&(reply.length===DATE_QUESTION.length||/\s/.test(reply[reply.length-DATE_QUESTION.length-1]))){
  question={ref:'engine.question',text:DATE_QUESTION,kind:'departureDate',key:'departureDate',answered:validDate(caseState.departureDate)};
 }
 return {reply,social,question};
}
function planContext(sources,{correctionConfirmed,previousStyle}){
 // Only enums/booleans leave the engine boundary. No customer message,
 // applicant values, identifiers, history, attachment bytes, OCR or OTP.
 return Object.freeze({
  version:1,role:'ismail',bodyRef:'engine.reply',questionRef:sources.question?.ref||null,
  socialRef:sources.social?'engine.social':null,questionKind:sources.question?.kind||null,
  questionAlreadyAnswered:sources.question?.answered===true,socialKind:sources.social,
  correctionConfirmed:correctionConfirmed===true,previousStyle:STYLES.has(previousStyle)?previousStyle:null,
 });
}
function defaultPlan(context){return {version:1,bodyRef:'engine.reply',questionRef:context.questionRef,socialRef:context.socialRef,style:context.previousStyle==='warm'?'direct':'warm',opening:context.correctionConfirmed?'clarification_ack':'none'};}
function validPlan(plan,context){
 return Boolean(plan&&typeof plan==='object'&&!Array.isArray(plan)&&Object.keys(plan).length===KEYS.length&&KEYS.every(key=>Object.hasOwn(plan,key))&&
  plan.version===1&&plan.bodyRef==='engine.reply'&&plan.questionRef===context.questionRef&&plan.socialRef===context.socialRef&&STYLES.has(plan.style)&&
  (plan.opening==='none'||plan.opening==='clarification_ack'&&context.correctionConfirmed));
}
async function resolvePlan(planner,context){
 let timer;
 try{
  // Promise.race installs rejection handlers on the losing planner promise;
  // a late rejection cannot become an unhandled rejection after the timeout.
  return await Promise.race([
   Promise.resolve().then(()=>planner(context)),
   new Promise(resolve=>{timer=setTimeout(()=>resolve(null),PLAN_TIMEOUT_MS);})
  ]);
 }catch{return null;}
 finally{clearTimeout(timer);}
}
async function styleReply(input,{env,planner=defaultPlan}={}){
 const original=input.reply;
 if(!enabled(env)||typeof original!=='string'||!original)return {reply:original,memory:null};
 const sources=sourcesFor(input),context=planContext(sources,input),plan=await resolvePlan(planner,context);
 if(!validPlan(plan,context))return {reply:original,memory:null};
 let reply=original;
 if(sources.social)reply=SOCIAL[sources.social][plan.style];
 else if(sources.question){
  const q=sources.question;
  const replacement=q.answered?'':q.kind==='departureDate'?q.text:questionWording(q.key,plan.style);
  if(typeof replacement!=='string')return {reply:original,memory:null};
  // Exact application-created span only. The surrounding business body is
  // untouched, including prices, policy terms, links and verified statuses.
  if(!reply.endsWith(q.text)||(replacement.match(/[؟?]/g)||[]).length>1)return {reply:original,memory:null};
  reply=(reply.slice(0,-q.text.length)+replacement).trimEnd();
 }
 if(plan.opening==='clarification_ack'&&!sources.social)reply='تمام، منكمّل على التوضيح الجديد.\n\n'+reply;
 // Question marks inside immutable quoted business text or URLs are data,
 // not new questions from this layer. Editable variants above contain at most
 // one question; never strip/rewrite protected content to meet punctuation counts.
 return {reply,memory:{version:1,lastStyle:plan.style}};
}

module.exports={enabled,styleReply,defaultPlan,validPlan,PLAN_TIMEOUT_MS};
