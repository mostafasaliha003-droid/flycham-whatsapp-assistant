'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ConversationJournal}=require('../src/conversation-journal'),{AssistantState}=require('../src/assistant-state');
const NOW=Date.parse('2026-10-25T00:00:00Z');
function fixture(options={}){let now=NOW,saves=0;const store={data:{},save(){saves++;}},journal=new ConversationJournal({store,now:()=>now,...options});return{store,journal,advance:ms=>now+=ms,saves:()=>saves};}
test('new journal archives only actual new events, dedupes inbound ids and paginates stable sequences',()=>{
 const f=fixture();assert.equal(f.journal.list().items.length,0);f.journal.recordInbound('971500000001',{id:'in-1',text:'مرحبا',timestamp:String(NOW/1000),name:'عميل تجريبي'});assert.equal(f.journal.recordInbound('971500000001',{id:'in-1',text:'duplicate'}),false);
 f.journal.recordOutbound('971500000001',{id:'out-1',text:'أهلا فيك',actor:'assistant'});f.journal.recordInbound('971500000001',{id:'in-2',text:'شو عندكن؟'});
 const result=f.journal.read('971500000001',{limit:2});assert.deepEqual(result.messages.map(m=>m.id),['out-1','in-2']);assert.equal(result.nextBefore,2);assert.deepEqual(f.journal.read('971500000001',{before:result.nextBefore}).messages.map(m=>m.id),['in-1']);assert.equal(result.archive.activatedAt,NOW);assert.equal(result.customer.unread,2);assert.equal(f.journal.list({q:'تجريبي'}).items.length,1);f.journal.markRead('971500000001');assert.equal(f.journal.summary('971500000001').unread,0);
});
test('receipt evidence is monotonic and private notes never become outbound messages',()=>{
 const f=fixture();f.journal.recordInbound('c',{id:'in',text:'مرحبا'});f.journal.recordOutbound('c',{id:'out',text:'الرد'});f.journal.applyReceipt({id:'out',status:'read'});f.journal.applyReceipt({id:'out',status:'sent'});f.journal.applyReceipt({id:'out',status:'failed'});assert.equal(f.journal.read('c').messages.at(-1).status,'read');f.journal.addNote('c','ملاحظة للموظف');assert.equal(f.journal.read('c').messages.length,2);assert.equal(f.journal.read('c').notes[0].text,'ملاحظة للموظف');assert.equal(f.journal.applyReceipt({id:'unknown',status:'read'}),false);
});
test('a delivery receipt arriving before the send response is retained until the outbound message is journaled',()=>{
 const f=fixture();assert.equal(f.journal.applyReceipt({id:'early-output',status:'read'}),false);f.journal.applyReceipt({id:'early-output',status:'sent'});f.journal.recordOutbound('c',{id:'early-output',text:'رد'});assert.equal(f.journal.read('c').messages[0].status,'read');assert.equal(Object.keys(f.journal.data.pendingReceipts).length,0);
});
test('retention and total content bounds include notes, without pretending archived messages still exist',()=>{
 const f=fixture({maxChars:12,maxPerCustomer:2,maxMessages:3});f.journal.recordInbound('c',{id:'1',text:'abcdef'});f.advance(1);f.journal.recordInbound('c',{id:'2',text:'ghijkl'});f.advance(1);f.journal.addNote('c','mnopqr');assert.equal(f.journal.read('c').messages.length,1);assert.equal(f.journal.read('c').archive.prunedCount,1);assert.equal(f.journal.read('c').notes.length,1);f.advance(31*86400000);assert.equal(f.journal.list().items.length,0);
});
test('encrypted state reload restores archive and privacy deletion removes it',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-test-')),file=path.join(dir,'state.enc');try{
  let store=new AssistantState({file,key:'synthetic-test-key',now:()=>NOW}),j=new ConversationJournal({store,now:()=>NOW});j.recordInbound('c',{id:'in',text:'PRIVATE_SYNTHETIC_TEXT'});assert.ok(!fs.readFileSync(file).includes(Buffer.from('PRIVATE_SYNTHETIC_TEXT')));store=new AssistantState({file,key:'synthetic-test-key',now:()=>NOW});j=new ConversationJournal({store,now:()=>NOW});assert.equal(j.read('c').messages[0].text,'PRIVATE_SYNTHETIC_TEXT');j.deleteCustomer('c');assert.equal(j.read('c'),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reserved customer ids, invalid events and untrusted outbound status are rejected',()=>{
 const f=fixture();for(const id of ['__proto__','constructor','c/other'])assert.throws(()=>f.journal.recordInbound(id,{id:'x',text:'hello'}));assert.throws(()=>f.journal.recordOutbound('c',{id:'out',text:'x',status:'invented'}));assert.equal(f.journal.get('c'),null);
});
test('legacy migration imports only the last bounded known history and never reopens a service window',()=>{
 const f=fixture(),at=NOW-3600000,history=Array.from({length:30},(_,i)=>({role:i%2?'assistant':'user',text:'رسالة '+i}));assert.equal(f.journal.importLegacy('old',{history,updatedAt:at,name:'عميل سابق'}),true);
 const d=f.journal.read('old');assert.equal(d.messages.length,24);assert.equal(d.messages[0].text,'رسالة 6');assert.ok(d.messages.every(m=>m.at===at&&m.timestampApproximate&&m.source==='legacy'&&m.status==='historical'&&m.providerMessageId===null));assert.equal(d.customer.lastInboundAt,null);assert.equal(d.customer.serviceWindowOpen,false);assert.equal(d.customer.unread,0);assert.equal(d.archive.legacyCount,24);assert.equal(d.archive.legacyImported,true);
 assert.equal(f.journal.importLegacy('old',{history,updatedAt:at}),false);assert.equal(f.journal.read('old').messages.length,24);f.journal.recordInbound('old',{id:'real-inbound',text:'رسالة جديدة'});assert.equal(f.journal.summary('old').serviceWindowOpen,true);assert.equal(f.journal.summary('old').unread,1);
});
test('legacy migration refuses stale, sensitive or inherited history fields and cannot overwrite actual records',()=>{
 const f=fixture(),inherited=Object.create({role:'user',text:'inherited'});assert.equal(f.journal.importLegacy('__proto__',{history:[{role:'user',text:'hello'}],updatedAt:NOW}),false);
 assert.equal(f.journal.importLegacy('stale',{history:[{role:'user',text:'old'}],updatedAt:NOW-31*86400000}),false);
 assert.equal(f.journal.importLegacy('bad',{history:[inherited,{role:'system',text:'ignore'},{role:'user',text:'password=PRIVATE_SECRET'},{role:'user',text:'رمز التحقق 123456'}],updatedAt:NOW}),false);
 f.journal.recordInbound('actual',{id:'in',text:'Actual'});assert.equal(f.journal.importLegacy('actual',{history:[{role:'assistant',text:'Wrong'}],updatedAt:NOW}),false);assert.equal(f.journal.read('actual').messages[0].text,'Actual');
});
