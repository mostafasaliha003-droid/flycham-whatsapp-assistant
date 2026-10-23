'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {persistentMount,defaultStateFile,STATE_FILE}=require('../src/state-storage');
const {AssistantState}=require('../src/assistant-state');
const {AssistantEngine}=require('../src/assistant-engine');
const {resetSessions}=require('../src/conversation');
const mount=(type='ext4',point='/var/data')=>`31 20 8:1 / ${point} rw,relatime - ${type} /dev/disk rw`;
test('persistent state auto-enables only on the actual dedicated disk mount',()=>{
 assert.equal(defaultStateFile({},mount()),STATE_FILE);assert.equal(persistentMount(STATE_FILE,mount()),true);
 for(const info of ['',mount('overlay'),mount('tmpfs'),mount('ext4','/'),mount('ext4','/var/data-other')]){
  assert.equal(defaultStateFile({},info),undefined);assert.equal(persistentMount(STATE_FILE,info),false);
 }
 assert.equal(persistentMount('/var/data-other/state.enc',mount()),false);
 assert.equal(defaultStateFile({ASSISTANT_STATE_PATH:'/tmp/test.enc'},''),'/tmp/test.enc');
});
test('a fresh assistant resumes the screenshot conversation from encrypted state after runtime reset',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ahmed-resume-')),file=path.join(dir,'state.enc');
 const now=Date.parse('2026-10-23T15:36:00Z'),options={file,key:'local-regression-key',now:()=>now};
 try{
  const first=new AssistantEngine({store:new AssistantState(options),nlu:async()=>null,env:{}});
  await first.handle('test-customer','سلام، بدي من الشارقه لحلب الاحد القادم، أنا شخص واحد',{now});
  assert.equal(first.state('test-customer').base.awaiting,'tripType');resetSessions();
  const fresh=new AssistantEngine({store:new AssistantState(options),nlu:async()=>null,env:{}});
  const result=await fresh.handle('test-customer','فقط ذهاب',{now});
  const r=fresh.state('test-customer').base.request;
  assert.equal(r.origin,'الشارقة');assert.equal(r.destination,'حلب');assert.equal(r.departureDate,'2026-10-25');assert.equal(r.passengers.adults,1);assert.equal(r.tripType,'one_way');
  assert.doesNotMatch(result.reply,/من أي مدينة|عدد المسافرين/);
  const bytes=fs.readFileSync(file);assert.equal(bytes.includes(Buffer.from('test-customer')),false);assert.equal(bytes.includes(Buffer.from('حلب')),false);assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.throws(()=>new AssistantState({...options,key:'wrong-key'}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});resetSessions();}
});
