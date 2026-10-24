'use strict';
const {canUseReply}=require('./consultant-brain');
const {updateConsultantMemory,updateConsultantStage,recommendVerifiedOffers}=require('./consultant-memory');
const {searchKnowledge}=require('./consultant-tools');
const {recordMetric}=require('./consultant-metrics');
function enabled(env){return env?.CONSULTANT_ORCHESTRATOR_ENABLED==='true';}
async function finishConsultantTurn(engine,id,text,result,{now}){
 if(!enabled(engine.env))return result;
 const s=engine.state(id),c=updateConsultantMemory(s,text,{now}),decision=s.consultantDecision?.at===now?s.consultantDecision:null;
 if(result.complete&&decision&&!['search','amend','compare'].includes(decision.action)){
  result.complete=false;result.request=undefined;s.status='collecting';
  if(s.base){s.base.submitted=false;require('./conversation').importSession(id,s.base);}
  result.reply=canUseReply(decision.reply,{status:s.status})?decision.reply:'تفاصيل رحلتك واضحة 🌷 إذا حابب نبدأ مقارنة الخيارات على هالتفاصيل خبرني.';
 }
 c.requestVersion=Number.isSafeInteger(c.requestVersion)?c.requestVersion:0;
 if(result.complete){c.requestVersion++;updateConsultantStage(s,'qualified',{now});recordMetric(engine.store,{customer:id,journey:s.tripId,event:'qualified',now});}
 if(s.selected)recordMetric(engine.store,{customer:id,journey:s.tripId,event:'selected',now});
 if(result.handoff){updateConsultantStage(s,'handoff_accepted',{now});recordMetric(engine.store,{customer:id,journey:s.tripId,event:'handoff',now});}
 if(decision){
  c.lastNextStep=decision.nextStep;
  // Application outcomes and exact cards take precedence over proposed wording.
  const conversational=!result.complete&&!result.cancel&&!result.handoff&&!['unsupported','failed','cancelled'].includes(s.status)&&!/[\d٠-٩]/.test(result.reply||'')&&!s.pendingQuotedOffer;
  if(decision.action==='knowledge'&&conversational){
   const evidence=await searchKnowledge(decision.knowledgeQuery,{env:engine.env,now});
   c.knowledge={status:evidence.status,checkedAt:now,sources:evidence.sources.map(x=>({title:x.title,url:x.url,checkedAt:x.checkedAt})),requiresVerification:true};
   result.reply=evidence.status==='available'?'هالمعلومة بتحتاج مراجعة الشروط الرسمية حسب حالتك 🌷 لقيت هالمصادر الرسمية للمراجعة:\n'+evidence.sources.map(x=>x.title+'\n'+x.url).join('\n\n')+'\n\nهذه روابط للمراجعة، وليست تأكيدًا لأهليتك أو شروط دخولك.':'حتى أعطيك معلومة دقيقة، لازم أراجع مصدر رسمي محدث. البحث الخارجي غير متاح عندي حاليًا، لذلك ما رح أعطيك شروط سفر أو أهلية تأشيرة من دون تحقق.';
  }else if(conversational&&['answer','status','clarify'].includes(decision.action)&&canUseReply(decision.reply,{status:s.status})){
   // Do not replace a genuine missing-field question with unrelated prose.
   const pending=s.base?.awaiting;
   if(!pending||decision.action==='clarify'&&decision.question&&result.reply.includes(decision.question)&&decision.reply.includes(decision.question))result.reply=decision.reply;
  }
 }
 const last=s.history.at(-1);if(last?.role==='assistant')last.text=result.reply;
 engine.store.set(id,s);return result;
}
function recommendationFor(offers,state,request,{now=Date.now()}={}){
 const rec=recommendVerifiedOffers(offers,request,state?.consultant?.preferences||{},{now});
 if(!rec.primary)return null;
 const why={matches_requested_airport:'يحافظ على مطار المغادرة اللي طلبته',lowest_verified_price:'الأقل سعرًا ضمن العروض المتأكدة حسب أولويتك',matches_requested_time:'يناسب توقيت السفر اللي فضّلته',requested_time_not_found:'خيار متأكد للمقارنة؛ التوقيت المفضل لم يتأكد',verified_alternative_airport:'بديل من مطار مختلف، إذا بناسبك'}[rec.reason];
 return '*اقتراح أحمد حسب طلبك*\nالخيار '+rec.primary.reference+': '+why+'.'+(rec.comparisonText?'\n'+rec.comparisonText:'')+'\nتفاصيل الخيارات المتأكدة أدناه؛ اختيار المطار والموعد إلك.';
}
module.exports={enabled,finishConsultantTurn,recommendationFor};
