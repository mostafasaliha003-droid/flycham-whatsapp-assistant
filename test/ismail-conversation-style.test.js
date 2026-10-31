'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AssistantState}=require('../src/assistant-state');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {visaCaseSignature,currentVisaEvidence}=require('../src/visa-case-signature');
const {styleReply,defaultPlan,PLAN_TIMEOUT_MS}=require('../src/ismail-conversation-style');
const FLAG={ISMAIL_CONVERSATION_STYLE_ENABLED:'true'};
const privateConfig={banks:[{bank:'Synthetic Bank',name:'Synthetic Company',account:'00000001',iban:'AE000000000000000000000'}]};
const make=options=>new SaudiVisaEngine({store:new AssistantState({file:null}),env:FLAG,privateConfig,...options});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const direct=(reply,extra={})=>({reply,caseState:{applicants:[]},...extra});

test('feature is off by default, with byte-identical replies and zero planner calls',async()=>{
 let calls=0;
 const plain=make({env:{}}),off=make({env:{ISMAIL_CONVERSATION_STYLE_ENABLED:'false'},conversationPlanner:()=>{calls++;throw Error('must not call');}});
 for(const text of ['مرحبا','سوري','جواز عادي','لحالي','شكرا','حالة الطلب','شو حسابكم','حولت','بفكر وبرجع']){
  assert.equal((await plain.handle('fixture',text)).reply,(await off.handle('fixture',text)).reply);
 }
 assert.equal(calls,0);assert.equal(off.getCase('fixture').conversationStyle,undefined);
});

test('explicitly enabled local style keeps intake to one narrow question and remembers short answers',async()=>{
 const e=make();const first=await e.handle('fixture','هلا');
 assert.match(first.reply,/شو جنسية الشخص اللي حابب يقدّم؟/);
 assert.equal((first.reply.match(/[؟?]/g)||[]).length,1);
 const nationality=await e.handle('fixture','سوري');
 assert.match(nationality.reply,/جواز سفر عادي أو وثيقة سفر؟/);assert.doesNotMatch(nationality.reply,/شو جنسية/);
 const document=await e.handle('fixture','عادي');
 assert.match(document.reply,/التقديم لشخص واحد أو لأكثر من شخص؟/);assert.doesNotMatch(document.reply,/جواز سفر عادي أو/);
 const done=await e.handle('fixture','لحالي');
 assert.equal(e.getCase('fixture').applicantCount,1);assert.equal(e.getCase('fixture').applicants[0].nationality,'سوريا');
 assert.equal(e.getCase('fixture').applicants[0].documentType,'passport');assert.equal(done.quote.total,700);
});

test('unanswered repeated clarification varies only the same engine question',async()=>{
 const e=make();await e.handle('fixture','مرحبا');
 const second=await e.handle('fixture','شو قصدك؟');assert.match(second.reply,/شو جنسية المتقدم؟/);
 assert.doesNotMatch(second.reply,/حتى نكمل من نفس النقطة/);assert.equal(e.getCase('fixture').lastQuestion,'nationality');
 assert.deepEqual(e.getCase('fixture').askedQuestions,['nationality']);
});

test('social replies are short without reintroducing Ismail or restarting the known application',async()=>{
 const e=make();await e.handle('fixture','سوري جواز عادي لحالي');const id=e.getCase('fixture').id;
 const thanks=await e.handle('fixture','يسلمو');assert.ok(thanks.reply.length<60);assert.doesNotMatch(thanks.reply,/أنا إسماعيل|700|شو جنسيتك/);
 const returning=await e.handle('fixture','مرحبا');assert.match(returning.reply,/نفس تفاصيل طلبك|آخر نقطة/);assert.equal(e.getCase('fixture').id,id);
});

test('business facts, prices and quote formatting remain exactly application rendered',async()=>{
 const enabled=make(),baseline=make({env:{}});
 for(const text of ['سوري جواز عادي لحالي','حالة الطلب','شو حسابكم','كيف ادفع','هل الرسوم مستردة عند الرفض','حولت','متى تطلع','شو مدة الفيزا']){
  const a=await baseline.handle('fixture',text),b=await enabled.handle('fixture',text);
  assert.equal(b.reply,a.reply,text);assert.deepEqual(b.quote,a.quote);
 }
 assert.equal(enabled.getCase('fixture').paymentStatus,'awaiting_verification');
 assert.equal(enabled.getCase('fixture').submissionStatus,'not_submitted');
});

test('known departure date removes only the exact already answered engine question',async()=>{
 const a=make({env:{}}),b=make();
 for(const e of [a,b]){await e.handle('fixture','سوري جواز عادي لحالي');e.getCase('fixture').departureDate='2026-12-10';}
 const original=await a.handle('fixture','كم يوم؟'),styled=await b.handle('fixture','كم يوم؟');
 assert.equal(styled.reply,original.reply.replace('إذا سفرك قريب، شو تاريخ السفر؟','').trimEnd());
 assert.match(styled.reply,/6–7 أيام عمل/);assert.equal(b.getCase('fixture').departureDate,'2026-12-10');
});

test('unknown travel date keeps its exact engine question and does not invent a date',async()=>{
 const e=make();await e.handle('fixture','سوري جواز عادي لحالي');
 const r=await e.handle('fixture','مستعجل');assert.match(r.reply,/إذا سفرك قريب، شو تاريخ السفر؟/);
 assert.equal(e.getCase('fixture').departureDate,undefined);
});

test('invalid stored departure date cannot suppress the still-unanswered travel date question',async()=>{
 const original='الموعد غير مضمون. إذا سفرك قريب، شو تاريخ السفر؟';
 for(const departureDate of ['not-a-date','2026-02-31','',null]){
  const r=await styleReply(direct(original,{caseState:{applicants:[],departureDate}}),{env:FLAG});assert.equal(r.reply,original);
 }
});

test('synthetic dialect/correction decision keeps new nationality and exact official body',async()=>{
 const understanding=async text=>text.includes('مو سوري')?{intent:'price',correction:true,target:'self',fields:{nationality:'مصر',documentType:'passport',applicantCount:1}}:null;
 const baseline=make({env:{},understand:understanding}),e=make({understand:understanding});
 for(const engine of [baseline,e])await engine.handle('fixture','سوري جواز عادي لحالي');
 const core=await baseline.handle('fixture','لا مو سوري، أنا مصري زي ما قلت'),r=await e.handle('fixture','لا مو سوري، أنا مصري زي ما قلت');
 assert.equal(r.reply,'تمام، منكمّل على التوضيح الجديد.\n\n'+core.reply);
 assert.equal(e.getCase('fixture').applicants[0].nationality,'مصر');assert.equal(r.quote.rows[0].product,'tourist_single');
});

test('paid-case amendment is never advertised as an applied correction',async()=>{
 const e=make({understand:async text=>text==='عدّل الجنسية'?{intent:'apply',correction:true,target:'self',fields:{nationality:'مصر'}}:null});
 await e.handle('fixture','سوري جواز عادي لحالي');e.getCase('fixture').paymentStatus='verified';
 const r=await e.handle('fixture','عدّل الجنسية');assert.match(r.reply,/حفظنا التعديل للمراجعة/);assert.doesNotMatch(r.reply,/منكمّل على التوضيح الجديد/);
 assert.equal(e.getCase('fixture').applicants[0].nationality,'سوريا');
});

test('harmless style memory preserves case-bound accountant and submission evidence',async()=>{
 const e=make();await e.handle('fixture','سوري جواز عادي لحالي');const c=e.getCase('fixture'),signature=visaCaseSignature(c);
 c.paymentStatus='verified';c.submissionStatus='submitted';c.stage='submitted';c.staffVerification={payment:{amount:700,reference:'synthetic-payment',caseSignature:signature},submission:{reference:'synthetic-submission',caseSignature:signature}};
 await e.handle('fixture','شكرا');assert.equal(visaCaseSignature(e.getCase('fixture')),signature);
 assert.equal(currentVisaEvidence(e.getCase('fixture')).payment,true);assert.equal(currentVisaEvidence(e.getCase('fixture')).submission,true);
 const status=await e.handle('fixture','حالة الطلب');assert.match(status.reply,/تم تقديم المعاملة فعلياً/);
});

test('planner receives only enums and booleans, never OTP, identifiers, history or document bytes',async()=>{
 const inputs=[];const e=make({conversationPlanner:context=>{inputs.push(context);return defaultPlan(context);}});
 await e.handle('fixture','سوري جواز عادي لحالي');
 e.getCase('fixture').history.push({role:'user',text:'PRIVATE_CUSTOMER_NAME PRIVATE_HISTORY'});
 e.getCase('fixture').documents=[{bytes:'PRIVATE_BYTES',passportNumber:'N12345678'}];
 await e.handle('fixture','رمز التحقق 654321 بريدي private@example.test رقم الجواز N12345678',{messages:[{media:{id:'PRIVATE_MEDIA_ID'}}]});
 assert.equal(inputs.length,2);const payload=JSON.stringify(inputs);
 assert.doesNotMatch(payload,/654321|PRIVATE_|N12345678|private@example|fixture|سوري|سوريا/);
 assert.deepEqual(Object.keys(inputs[1]).sort(),['version','role','bodyRef','questionRef','socialRef','questionKind','questionAlreadyAnswered','socialKind','correctionConfirmed','previousStyle'].sort());
 assert.equal(Object.isFrozen(inputs[1]),true);
});

test('arbitrary generated prose and extra fact fields are rejected, falling back verbatim',async()=>{
 for(const malicious of [
  c=>({...defaultPlan(c),reply:'تم الدفع والموافقة مجاناً'}),
  c=>({...defaultPlan(c),price:0}),
  c=>({...defaultPlan(c),bodyRef:'payment.verified'}),
  c=>({...defaultPlan(c),questionRef:'health.answer_no'}),
  c=>({...defaultPlan(c),socialRef:'upload.private_link'}),
  c=>({...defaultPlan(c),opening:'clarification_ack'}),
  c=>({...defaultPlan(c),style:'أي كلام غير مقيد'})
 ]){
  const reply='السعر غير متحقق. حالة الدفع بانتظار التحقق.';
  const r=await styleReply(direct(reply),{env:FLAG,planner:malicious});assert.equal(r.reply,reply);assert.equal(r.memory,null);
 }
});

test('unknown price and legal/health answers cannot be created by the style layer',async()=>{
 const original='نوع التأشيرة يحتاج مراجعة قبل تأكيد السعر. لم يتم تقديم الطلب.';
 const r=await styleReply(direct(original,{caseState:{applicants:[{nationality:'غير معروفة'}],quote:null}}),{env:FLAG});
 assert.equal(r.reply,original);assert.doesNotMatch(r.reply,/700|نعم|الإجابة لا|تم الدفع/);
});

test('only exact known engine-created question span can be replaced',async()=>{
 const original='نص مقتبس: شو جنسية المتقدم؟ السعر 700 درهم.';
 const r=await styleReply(direct(original,{caseState:{applicants:[]},completion:'سؤال غير موجود؟',questionKey:'nationality'}),{env:FLAG});
 assert.equal(r.reply,original);
 const answered=await styleReply(direct('شو جنسية الشخص اللي بدنا نقدّم له؟',{caseState:{applicants:[{nationality:'سوريا'}]},completion:'شو جنسية الشخص اللي بدنا نقدّم له؟',questionKey:'nationality'}),{env:FLAG});
 assert.equal(answered.reply,'شو جنسية الشخص اللي بدنا نقدّم له؟');
});

test('earlier identical quoted question remains immutable while only final appended clarification changes',async()=>{
 const question='شو جنسية الشخص اللي بدنا نقدّم له؟';
 const business='نص مرجعي محفوظ: «'+question+'»\nالسعر 700 درهم\nhttps://example.test/info?x=1\n\n';
 const original=business+question;
 const r=await styleReply(direct(original,{caseState:{applicants:[]},completion:question,questionKey:'nationality'}),{env:FLAG});
 assert.equal(r.reply,business+'شو جنسية الشخص اللي حابب يقدّم؟');
 assert.equal(r.reply.slice(0,business.length),business);
});

test('nonterminal completion and suffix without a boundary cannot authorize editing a business span',async()=>{
 const question='شو جنسية الشخص اللي بدنا نقدّم له؟';
 for(const reply of [question+'\nالسعر 700 درهم','نصمتصل'+question]){
  let seen;const r=await styleReply(direct(reply,{caseState:{applicants:[]},completion:question,questionKey:'nationality'}),{env:FLAG,planner:context=>{seen=context;return {...defaultPlan(context),questionRef:'engine.question'};}});
  assert.equal(seen.questionRef,null);assert.equal(r.reply,reply);assert.equal(r.memory,null);
 }
});

test('new immutable business segments may contain links, numbers and punctuation without being rewritten',async()=>{
 const core='السعر 700 درهم\nhttps://example.test/documents?x=1\nالدفع غير مؤكد. رقم الحساب: 00000001';
 assert.equal((await styleReply(direct(core),{env:FLAG})).reply,core);
});

test('planner error returns original reply without exposing internal failure',async()=>{
 const e=make({conversationPlanner:()=>{throw Error('INTERNAL_PRIVATE_ERROR');}}),baseline=make({env:{}});
 assert.equal((await e.handle('fixture','مرحبا')).reply,(await baseline.handle('fixture','مرحبا')).reply);
 assert.doesNotMatch(JSON.stringify(e.getCase('fixture')),/INTERNAL_PRIVATE_ERROR/);
});

test('timeout falls back and a late planner rejection is handled',async()=>{
 const unhandled=[];const listener=error=>unhandled.push(error);process.on('unhandledRejection',listener);
 try{
  const reply='حالة المعاملة تحتاج مراجعة.';
  const r=await styleReply(direct(reply),{env:FLAG,planner:()=>new Promise((resolve,reject)=>setTimeout(()=>reject(Error('late')),PLAN_TIMEOUT_MS+20))});
  assert.equal(r.reply,reply);assert.equal(r.memory,null);
  await new Promise(resolve=>setTimeout(resolve,45));assert.deepEqual(unhandled,[]);
 }finally{process.removeListener('unhandledRejection',listener);}
});

test('concurrent staff correction supersedes pending style and preserves current case',async()=>{
 let resolve,seen;const e=make({conversationPlanner:c=>{seen=c;return new Promise(done=>resolve=done);}});
 const initial=e.newCase();initial.greeted=true;e.save('fixture',initial);
 const pending=e.handle('fixture','مرحبا');await tick();assert.ok(resolve);
 const current=e.getCase('fixture');current.applicants=[{nationality:'مصر'}];current.revision++;current.lastQuestion='documentType';
 resolve(defaultPlan(seen));const r=await pending;
 assert.equal(r.superseded,true);assert.equal(r.reply,null);assert.equal(e.getCase('fixture'),current);assert.equal(current.applicants[0].nationality,'مصر');assert.equal(current.conversationStyle,undefined);
});

test('concurrent awaiting change is detected even if caller omitted revision update',async()=>{
 let resolve,seen;const e=make({conversationPlanner:c=>{seen=c;return new Promise(done=>resolve=done);}});
 e.save('fixture',e.newCase());const pending=e.handle('fixture','مرحبا');await tick();
 e.getCase('fixture').lastQuestion='applicantCount';resolve(defaultPlan(seen));
 assert.equal((await pending).superseded,true);assert.equal(e.getCase('fixture').lastQuestion,'applicantCount');
});

test('concurrent case deletion cannot be resurrected by pending style',async()=>{
 let resolve,seen;const e=make({conversationPlanner:c=>{seen=c;return new Promise(done=>resolve=done);}});
 e.save('fixture',e.newCase());const pending=e.handle('fixture','مرحبا');await tick();
 e.delete('fixture');resolve(defaultPlan(seen));assert.equal((await pending).superseded,true);assert.equal(e.getCase('fixture'),null);
});

test('two-question planner output cannot bypass exact plan schema',async()=>{
 const reply='المراجعة بانتظار القسم.';
 const r=await styleReply(direct(reply),{env:FLAG,planner:c=>({...defaultPlan(c),question:'شو اسمك؟ شو رقمك؟'})});assert.equal(r.reply,reply);assert.equal(r.memory,null);
});
