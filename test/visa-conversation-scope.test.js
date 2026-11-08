'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SaudiVisaEngine}=require('../src/saudi-visa-engine');
const {VisaConversationScope}=require('../src/visa-conversation-scope');
const {visaCaseSignature}=require('../src/visa-case-signature');
const {extractIncomingMessages}=require('../src/whatsapp');
function setup(){let now=1800000000000;const store={data:{},save(){}},engine=new SaudiVisaEngine({store,now:()=>now,env:{},privateConfig:{banks:[]},understand:async()=>({intent:'status',fields:{},target:null})});const c=engine.newCase();c.applicants=[{nationality:'سوريا',documentType:'passport'}];c.applicantCount=1;c.paymentStatus='verified';engine.save('971500000001',c);store.data.visaFulfilment={jobs:{job:{id:'job',customer:'971500000001',caseId:c.id,caseSignature:visaCaseSignature(c),state:'manually_completed',applicationReference:'828601588'}}};const scope=new VisaConversationScope({store,engine,now:()=>now});return{store,engine,c,scope,id:'971500000001',tick:ms=>{now+=ms;}};}
async function select(f,action,question='سلام'){const menu=await f.scope.handle(f.id,question);f.scope.bind(f.id,menu.scopeMenu.token,'sent-menu');return f.scope.handle(f.id,'اختيار',{messages:[{visaScopeChoice:{token:menu.scopeMenu.token,action},contextId:'sent-menu'}]});}
test('greeting on an existing application offers new inquiry or reference followup without changing its case',async()=>{const f=setup(),before=JSON.stringify(f.c);const r=await f.scope.handle(f.id,'سلام');assert.ok(r.scopeMenu);assert.match(r.reply,/استفسار جديد/);assert.match(r.reply,/رقم الطلب/);assert.equal(JSON.stringify(f.c),before);});
test('Palestinian Syrian question is isolated from the old application even if the model calls it status',async()=>{const f=setup(),signature=visaCaseSignature(f.c),r=await select(f,'new','بالنسبه للفلسطيني السوري شو الوضع');assert.match(r.reply,/جواز سفر سوري/);assert.doesNotMatch(r.reply,/828601588/);const next=await f.scope.handle(f.id,'فلسطيني معه وثيقة سفر سورية');assert.doesNotMatch(next.reply,/828601588|محفوظ معنا/);assert.equal(visaCaseSignature(f.c),signature);assert.equal(f.c.applicants[0].nationality,'سوريا');assert.equal(f.c.paymentStatus,'verified');});
test('followup asks for the reference and never reveals another customer application',async()=>{const f=setup(),r=await select(f,'followup');assert.match(r.reply,/ابعت رقم الطلب/);assert.doesNotMatch(r.reply,/828601588/);const unknown=await f.scope.handle(f.id,'999999999');assert.match(unknown.reply,/نفس الرقم/);const actual=await f.scope.handle(f.id,'رقم الطلب 828601588');assert.match(actual.reply,/828601588/);});
test('old, expired, other-recipient or incorrectly quoted buttons cannot select inquiry mode',async()=>{for(const wrong of ['token','context','expiry','sender']){const f=setup(),m=await f.scope.handle(f.id,'سلام');f.scope.bind(f.id,m.scopeMenu.token,'sent');if(wrong==='expiry')f.tick(31*60000);const r=await f.scope.handle(wrong==='sender'?'971500000002':f.id,'اختيار',{messages:[{visaScopeChoice:{token:wrong==='token'?'wrong':m.scopeMenu.token,action:'new'},contextId:wrong==='context'?'other':'sent'}]});assert.notEqual(f.scope.current(f.id)?.mode,'inquiry');assert.equal(f.engine.getCase(f.id).id,f.c.id);}});
test('complaints and privacy requests bypass the scope gate; thanks does not open a new case',async()=>{const f=setup();for(const t of ['بدي استرداد فلوسي','احذف بياناتي','شكرا'])assert.equal((await f.scope.handle(f.id,t)).handled,false);});
test('explicit new inquiry works after selecting reference followup',async()=>{const f=setup();await select(f,'followup');assert.ok((await f.scope.handle(f.id,'استفسار جديد')).scopeMenu);});
test('media for a new inquiry is held separately instead of being attached to the old case',async()=>{const f=setup();await select(f,'new');const r=await f.scope.handle(f.id,'صورة',{messages:[{id:'media-message',media:{id:'new-media',type:'image'}}]});assert.match(r.reply,/نفتح طلب جديد/);assert.equal(f.store.data.pendingNewVisaMedia[f.id].messages[0].media.id,'new-media');assert.deepEqual(f.c.documents,[]);});
test('WhatsApp parses scope buttons as a dedicated action while retaining source context',()=>{const token='10000000-0000-4000-8000-000000000001';const m=extractIncomingMessages({entry:[{changes:[{field:'messages',value:{messages:[{from:'971500000001',id:'msg',context:{id:'menu'},type:'interactive',interactive:{type:'button_reply',button_reply:{id:'visa_scope:new:'+token,title:'طلب / استفسار جديد'}}}]}}]}]});assert.equal(m.length,1);assert.deepEqual(m[0].visaScopeChoice,{action:'new',token});assert.equal(m[0].contextId,'menu');});
test('scope menu sends two real WhatsApp reply buttons with bounded labels and exact action tokens',async()=>{const {sendVisaScopeMenu}=require('../src/graph-api'),original=global.fetch;let body;global.fetch=async(url,options)=>{body=JSON.parse(options.body);return{ok:true,json:async()=>({messages:[{id:'menu'}]})};};try{const token='10000000-0000-4000-8000-000000000001';await sendVisaScopeMenu('971500000001',{text:'كيف نساعدك؟',token},{DRY_RUN:'false',WHATSAPP_ACCESS_TOKEN:'synthetic-token',WHATSAPP_PHONE_NUMBER_ID:'synthetic-phone'});assert.equal(body.type,'interactive');const rows=body.interactive.action.buttons;assert.equal(rows.length,2);assert.equal(rows[0].reply.id,'visa_scope:new:'+token);assert.equal(rows[1].reply.id,'visa_scope:followup:'+token);assert.ok(rows.every(b=>b.reply.title.length<=20));}finally{global.fetch=original;}});
test('a new inquiry only becomes a separate case after explicit creation confirmation; completed manual case remains archived',async()=>{const f=setup(),oldId=f.c.id;await select(f,'new','مصري جواز عادي شخص واحد');const prompt=await f.scope.handle(f.id,'بدي اقدم');assert.match(prompt.reply,/تأكدلي/);assert.equal(f.engine.getCase(f.id).id,oldId);assert.equal((await f.scope.handle(f.id,'نعم')).handled,false);await f.engine.handle(f.id,'نعم');const next=f.engine.getCase(f.id);assert.notEqual(next.id,oldId);assert.equal(next.paymentStatus,'unverified');assert.deepEqual(next.documents,[]);assert.equal(f.store.data.visaCaseArchives[f.id][0].id,oldId);assert.equal(f.store.data.visaFulfilment.jobs.job.applicationReference,'828601588');});

test('explicit followup without a reference asks for it instead of guessing the old request',async()=>{const f=setup(),r=await f.scope.handle(f.id,'شو صار بطلبي');assert.match(r.reply,/ابعت رقم الطلب/);assert.doesNotMatch(r.reply,/828601588/);});
test('isolated unknown inquiry returns an owner intervention without changing the paid case',async()=>{const f=setup();f.engine.understand=async()=>({intent:'other',fields:{}});await select(f,'new');const before=JSON.stringify(f.c);const r=await f.scope.handle(f.id,'شو نظام أولوية التأشيرة الاستثنائي؟');assert.equal(r.intervention.reason,'untrained_request');assert.match(r.intervention.question,/أولوية/);assert.ok(r.scopeToken);assert.equal(JSON.stringify(f.c),before);});
test('ambiguous Syrian travel wording cannot silently replace Palestinian document classification',async()=>{const f=setup();await select(f,'new','بالنسبه للفلسطيني السوري شو الوضع');const r=await f.scope.handle(f.id,'سفر سوري');assert.match(r.reply,/وثيقة سفر فلسطينية/);assert.match(r.reply,/جواز سفر سوري/);assert.equal(f.scope.current(f.id).inquiry.applicants.length,0);});

test('new selection preserves the customer request arriving in the same batch',async()=>{const f=setup(),m=await f.scope.handle(f.id,'سلام');f.scope.bind(f.id,m.scopeMenu.token,'sent');const r=await f.scope.handle(f.id,'طلب / استفسار جديد، بدي قدم على فيزا السعودية',{messages:[{text:'طلب / استفسار جديد',visaScopeChoice:{token:m.scopeMenu.token,action:'new'},contextId:'sent'},{text:'بدي قدم على فيزا السعودية'}]});assert.match(r.reply,/نفتح طلب جديد/);assert.ok(f.c.pendingNewApplication);assert.equal(f.scope.current(f.id).mode,'inquiry');});

test('spoken new-inquiry labels select the delivered menu and replay the original question in isolation',async()=>{
 for(const text of ['استفسار جديد','طلب جديد','طلب أو استفسار جديد','بدي استفسار جديد','عايز استفسار جديد','أبي استفسار جديد']){
  const f=setup(),signature=visaCaseSignature(f.c),m=await f.scope.handle(f.id,'مصري جواز عادي شخص واحد');f.scope.bind(f.id,m.scopeMenu.token,'sent-menu');
  const r=await f.scope.handle(f.id,text,{messages:[{text,voiceTranscript:true}]});
  assert.equal(f.scope.current(f.id).mode,'inquiry',text);assert.equal(f.scope.current(f.id).inquiry.applicants[0].nationality,'مصر',text);
  assert.equal(f.scope.current(f.id).pendingText,undefined);assert.equal(r.scopeMenu,undefined);assert.doesNotMatch(r.reply,/828601588/);
  assert.equal(visaCaseSignature(f.engine.getCase(f.id)),signature);assert.equal(f.c.paymentStatus,'verified');assert.equal(f.c.pendingNewApplication,undefined);
 }
});

test('spoken followup labels ask for the reference while preserving reference ownership checks',async()=>{
 for(const text of ['متابعة طلب حالي','بدي أتابع طلبي','عايز متابعة الطلب الحالي','أبي أتابع طلبي']){
  const f=setup(),signature=visaCaseSignature(f.c),m=await f.scope.handle(f.id,'سلام');f.scope.bind(f.id,m.scopeMenu.token,'sent-menu');
  const r=await f.scope.handle(f.id,text,{messages:[{text,voiceTranscript:true,contextId:'sent-menu'}]});
  assert.equal(f.scope.current(f.id).mode,'followup',text);assert.match(r.reply,/ابعت رقم الطلب/);assert.doesNotMatch(r.reply,/828601588/);
  assert.match((await f.scope.handle(f.id,'999999999')).reply,/نفس الرقم/);assert.match((await f.scope.handle(f.id,'رقم الطلب 828601588')).reply,/828601588/);
  assert.equal(visaCaseSignature(f.engine.getCase(f.id)),signature);
 }
});

test('spoken options require a delivered active menu and cannot select another conversation',async()=>{
 for(const wrong of ['unbound','expiry','case','sender','context']){
  const f=setup(),m=await f.scope.handle(f.id,'سلام');if(wrong!=='unbound')f.scope.bind(f.id,m.scopeMenu.token,'sent-menu');
  if(wrong==='expiry')f.tick(31*60000);if(wrong==='case')f.c.id='replacement-case';
  const id=wrong==='sender'?'971500000002':f.id,text='استفسار جديد';
  await f.scope.handle(id,text,{messages:[{text,voiceTranscript:true,...(wrong==='context'?{contextId:'unrelated-message'}:{})}]});
  assert.notEqual(f.scope.current(id)?.mode,'inquiry',wrong);assert.equal(f.c.pendingNewApplication,undefined);
 }
});

test('spoken options do not consume mixed actions, numbers, attachments or case references',async()=>{
 for(const text of ['استفسار جديد وحول المصاري','متابعة طلب حالي وكم السعر','نعم','1','2']){
  const f=setup(),signature=visaCaseSignature(f.c),m=await f.scope.handle(f.id,'سلام');f.scope.bind(f.id,m.scopeMenu.token,'sent-menu');
  const r=await f.scope.handle(f.id,text,{messages:[{text,voiceTranscript:true}]});assert.ok(r.scopeMenu,text);assert.equal(f.scope.current(f.id).mode,'choice');assert.equal(visaCaseSignature(f.c),signature);
 }
 const f=setup(),m=await f.scope.handle(f.id,'سلام');f.scope.bind(f.id,m.scopeMenu.token,'sent-menu');
 assert.ok((await f.scope.handle(f.id,'استفسار جديد',{messages:[{text:'استفسار جديد',media:{type:'image',id:'synthetic-media'}}]})).scopeMenu);
 const reference=await f.scope.handle(f.id,'رقم الطلب 828601588');assert.match(reference.reply,/828601588/);assert.equal(f.scope.current(f.id),null);
});

test('Package 7 summary bypasses saved-case menus but stays inside a separate inquiry',async()=>{
 const f=setup(),before=visaCaseSignature(f.c);const direct=await f.scope.handle(f.id,'لخصلي طلبي');assert.equal(direct.handled,false);assert.match((await f.engine.handle(f.id,'لخصلي طلبي')).reply,/ملخص طلب/);assert.equal(visaCaseSignature(f.engine.getCase(f.id)),before);
 await select(f,'new','مصري جواز عادي شخص واحد');const isolated=await f.scope.handle(f.id,'لخصلي طلبي');assert.equal(isolated.handled,true);assert.match(isolated.reply,/مصر/);assert.doesNotMatch(isolated.reply,/سوريا|828601588/);assert.equal(visaCaseSignature(f.engine.getCase(f.id)),before);
});
