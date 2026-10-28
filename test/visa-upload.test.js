'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream'),sharp=require('sharp');
const {VisaUploadService,UPLOAD_TTL_MS}=require('../src/visa-upload');
const {VisaMediaStore,MAX_BYTES}=require('../src/visa-media');
const customer='971500000001',other='971500000002',base='https://upload.example.test';
const c=()=>({id:crypto.randomUUID(),createdAt:1000000,policyVersion:'test',applicantCount:1,applicants:[{nationality:'test'}],documents:[],submissionStatus:'not_submitted',revision:0});
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'visa-upload-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000001,owned=false;const completed=[];
 const store={data:{visaCases:{[customer]:c(),[other]:c()}},file:path.join(dir,'state.enc'),key:crypto.randomBytes(32),save(){this.saves=(this.saves||0)+1;}};
 const env={NODE_ENV:'test',RENDER_EXTERNAL_URL:base,RAAD_DOCUMENT_UPLOAD_WHATSAPP_NUMBER:'971500000003'};
 const media=new VisaMediaStore({store,env,now:()=>now}),inbox={isHumanOwned:()=>owned};
 const service=new VisaUploadService({store,mediaStore:media,inbox,env,now:()=>now,onComplete:input=>completed.push(input)});
 return{dir,store,media,service,completed,inbox,setNow(value){now=value;},setOwned(value){owned=value;}};
}
function token(link){return new URL(link.url).hash.slice(1);}
async function request(service,credential,{route='/session',method='GET',bytes,role='passport',key='upload_test_1',mime='image/png',headers={},body}={}){
 const req=body||Readable.from(bytes?[Buffer.from(bytes)]:[]);req.method=method;req.headers={authorization:'Bearer '+credential,...(bytes?{'content-type':mime,'content-length':String(bytes.length),'x-upload-role':role,'x-idempotency-key':key}:{}),...headers};let status,result,responseHeaders;
 const response={writeHead(s,h){status=s;responseHeaders=h;return this;},end(value){result=JSON.parse(value);}};
 assert.equal(await service.handleRequest(req,response,new URL(base+'/api/visa-upload'+route)),true);return{status,body:result,headers:responseHeaders};
}
async function image(){return sharp({create:{width:1200,height:800,channels:3,background:'#abcded'}}).png().toBuffer();}

test('link credential lives only in fragment and hash at rest; public session reveals no case/customer identity',async t=>{
 const{store,service}=setup(t),link=service.createLink(customer),credential=token(link),serialized=JSON.stringify(store.data.visaUpload);
 assert.match(credential,/^[A-Za-z0-9_-]{43}$/);assert.equal(new URL(link.url).pathname,'/documents');assert.equal(serialized.includes(credential),false);assert.match(Object.values(store.data.visaUpload.sessions)[0].tokenHash,/^[a-f0-9]{64}$/);
 const r=await request(service,credential);assert.equal(r.status,200);assert.equal(r.body.state,'open');assert.equal(r.body.maxBytes,MAX_BYTES);assert.deepEqual(r.body.limits,{passport:2,residence:2,photo:1});assert.equal(r.body.whatsappUrl,'https://wa.me/971500000003');assert.match(r.headers['Cache-Control'],/no-store/);
 assert.equal(JSON.stringify(r.body).includes(customer),false);assert.equal(JSON.stringify(r.body).includes(store.data.visaCases[customer].id),false);assert.equal((await request(service,'x'.repeat(43))).status,401);
});
test('encrypted staging excludes files from originals until explicit completion; complete callback only receives exact owned files',async t=>{
 const{media,service,store,dir,completed}=setup(t),credential=token(service.createLink(customer)),bytes=await image(),r=await request(service,credential,{route:'/files',method:'POST',bytes});
 assert.equal(r.status,200);assert.equal(r.body.file.role,'passport');assert.equal(r.body.file.clientKey,'upload_test_1');const id=r.body.file.id,raw=store.data.visaMedia[id];assert.equal(raw.purpose,'visa_upload_staged');assert.equal(raw.status,'upload_staged');
 const enc=fs.readFileSync(path.join(dir,'visa-media',id+'.enc'));assert.equal(enc.includes(bytes),false);assert.equal(fs.statSync(path.join(dir,'visa-media',id+'.enc')).mode&0o777,0o600);assert.deepEqual(media.read(id,{customer}).bytes,bytes);assert.throws(()=>media.read(id,{customer:other}),/MEDIA_NOT_FOUND/);assert.equal(completed.length,0);
 const before=structuredClone(store.data.visaCases[customer]);const done=await request(service,credential,{route:'/complete',method:'POST'});assert.equal(done.status,200);assert.equal(done.body.state,'completed');assert.equal(raw.purpose,undefined);assert.equal(raw.status,'pending_review');assert.equal(completed.length,1);assert.deepEqual(completed[0].mediaIds,[id]);assert.equal(completed[0].customer,customer);assert.deepEqual(store.data.visaCases[customer],before);
 const duplicate=await request(service,credential,{route:'/complete',method:'POST'});assert.equal(duplicate.status,200);assert.equal(completed.length,1);assert.equal((await request(service,credential,{route:'/files',method:'POST',bytes})).body.error,'UPLOAD_SEALED');
});
test('idempotent replay recovers accepted file and rejects changed bytes or role; session credential rotation preserves selected files',async t=>{
 const{service,store}=setup(t),credential=token(service.createLink(customer)),bytes=await image(),args={route:'/files',method:'POST',bytes};
 const first=await request(service,credential,args),again=await request(service,credential,args);assert.equal(first.body.file.id,again.body.file.id);assert.equal(Object.keys(store.data.visaMedia).length,1);
 const changed=await request(service,credential,{...args,role:'photo'});assert.equal(changed.body.error,'UPLOAD_CONFLICT');
 const nextCredential=token(service.createLink(customer));assert.notEqual(nextCredential,credential);assert.equal((await request(service,credential)).status,401);const resumed=await request(service,nextCredential);assert.equal(resumed.body.files.length,1);assert.equal(resumed.body.files[0].id,first.body.file.id);
});
test('delete withdraws only own staged selection; active or foreign files cannot be removed',async t=>{
 const{service,media,store}=setup(t),one=token(service.createLink(customer)),two=token(service.createLink(other)),bytes=await image();
 const own=await request(service,one,{route:'/files',method:'POST',bytes}),foreign=await request(service,two,{route:'/files',method:'POST',bytes});
 assert.equal((await request(service,one,{route:'/files/'+foreign.body.file.id,method:'DELETE'})).status,404);
 assert.equal((await request(service,one,{route:'/files/'+own.body.file.id,method:'DELETE'})).status,200);assert.equal(store.data.visaMedia[own.body.file.id].purpose,'visa_upload_withdrawn');assert.deepEqual(media.read(own.body.file.id,{customer}).bytes,bytes);
 assert.equal((await request(service,one,{route:'/complete',method:'POST'})).body.error,'UPLOAD_EMPTY');assert.equal((await request(service,one,{route:'/files',method:'POST',bytes})).body.error,'UPLOAD_CONFLICT');
 const replacement=await request(service,one,{route:'/files',method:'POST',bytes,key:'replacement_1'});assert.equal(replacement.status,200);assert.notEqual(replacement.body.file.id,own.body.file.id);
 await request(service,one,{route:'/complete',method:'POST'});assert.equal((await request(service,one,{route:'/files/'+replacement.body.file.id,method:'DELETE'})).body.error,'UPLOAD_SEALED');
});
test('case binding ignores harmless revision but rejects changed material facts, replacement, expiry and staff ownership',async t=>{
 const fixture=setup(t),{service,store}=fixture,credential=token(service.createLink(customer));store.data.visaCases[customer].revision++;assert.equal((await request(service,credential)).status,200);
 fixture.setOwned(true);assert.equal((await request(service,credential)).body.error,'UPLOAD_PAUSED');fixture.setOwned(false);store.data.visaCases[customer].applicantCount=2;assert.equal((await request(service,credential)).body.error,'UPLOAD_STALE');store.data.visaCases[customer].applicantCount=1;
 store.data.visaCases[customer].id=crypto.randomUUID();assert.equal((await request(service,credential)).body.error,'UPLOAD_STALE');const fresh=token(service.createLink(customer));fixture.setNow(1000001+UPLOAD_TTL_MS);assert.equal((await request(service,fresh)).status,410);service.prune();assert.equal(Object.keys(store.data.visaUpload.sessions).length,0);
});
test('strict binary validation rejects content type spoofing, corrupt bytes, oversized and animated images; originals unchanged',async t=>{
 const{service,store}=setup(t),credential=token(service.createLink(customer)),bytes=await image();
 for(const options of [{mime:'text/html',bytes},{mime:'image/jpeg',bytes},{bytes:Buffer.from('not-an-image')},{mime:'application/pdf',bytes:Buffer.from('not-a-pdf')},{mime:'image/png',bytes:bytes.subarray(0,bytes.length-20)}]){
  const r=await request(service,credential,{route:'/files',method:'POST',...options});assert.equal(r.status,400);assert.equal(r.body.ok,false);
 }
 const oversized=await request(service,credential,{route:'/files',method:'POST',bytes,headers:{'content-length':String(MAX_BYTES+1)}});assert.equal(oversized.status,413);assert.equal(Object.keys(store.data.visaMedia).length,0);
 const firstFrame=await sharp({create:{width:10,height:10,channels:3,background:'red'}}).png().toBuffer(),secondFrame=await sharp({create:{width:10,height:10,channels:3,background:'blue'}}).png().toBuffer(),animation=await sharp([firstFrame,secondFrame],{join:{animated:true}}).webp({loop:0,delay:[100,100]}).toBuffer();
 assert.equal((await request(service,credential,{route:'/files',method:'POST',mime:'image/webp',bytes:animation})).body.error,'UPLOAD_CONTENT_INVALID');
 const pdf=Buffer.from('%PDF-1.7\nSynthetic test only\n%%EOF');assert.equal((await request(service,credential,{route:'/files',method:'POST',mime:'application/pdf',bytes:pdf})).status,200);
});
test('role limits, origin, unsafe method and unknown route fail closed without leaking errors',async t=>{
 const{service}=setup(t),credential=token(service.createLink(customer)),bytes=await image();
 assert.equal((await request(service,credential,{headers:{origin:'https://attacker.test'}})).status,403);assert.equal((await request(service,credential,{headers:{'sec-fetch-site':'cross-site'}})).status,403);assert.equal((await request(service,credential,{route:'/file-not-found'})).status,405);
 assert.equal((await request(service,credential,{route:'/files',method:'POST',bytes,role:'photo'})).status,200);const excess=await request(service,credential,{route:'/files',method:'POST',bytes,role:'photo',key:'another_image'});assert.equal(excess.body.error,'UPLOAD_LIMIT');
 assert.equal((await request(service,credential,{route:'/files',method:'POST',bytes,role:'__proto__'})).status,400);
});
test('post-await guard rejects case changes and ownership changes while upload bytes arrive',async t=>{
 for(const change of ['case','owner']){
  const fixture=setup(t),credential=token(fixture.service.createLink(customer)),bytes=await image();
  async function* slowBody(){yield bytes.subarray(0,20);if(change==='case')fixture.store.data.visaCases[customer].applicantCount=3;else fixture.setOwned(true);yield bytes.subarray(20);}
  const body=Readable.from(slowBody()),r=await request(fixture.service,credential,{route:'/files',method:'POST',body,headers:{'content-type':'image/png','content-length':String(bytes.length),'x-upload-role':'passport','x-idempotency-key':'slow_image_1'}});
  assert.equal(r.status,409);assert.equal(Object.keys(fixture.store.data.visaMedia).length,0);assert.equal(fixture.completed.length,0);
 }
});
test('concurrent session mutations never race role limits and return retryable busy',async t=>{
 const{service,media}=setup(t),credential=token(service.createLink(customer)),bytes=await image();let release,entered;const wait=new Promise(r=>release=r),start=new Promise(r=>entered=r),original=media.storeUpload.bind(media);media.storeUpload=async(...args)=>{entered();await wait;return original(...args);};
 const first=request(service,credential,{route:'/files',method:'POST',bytes});await start;assert.throws(()=>service.createLink(customer),/UPLOAD_BUSY/);const second=await request(service,credential,{route:'/files',method:'POST',bytes,key:'concurrent_2'});assert.equal(second.status,429);release();assert.equal((await first).status,200);
});
test('failed file persistence remains staged and cannot commit phantom files; completion persistence restores originals',async t=>{
 const{service,store}=setup(t),credential=token(service.createLink(customer)),bytes=await image();const r=await request(service,credential,{route:'/files',method:'POST',bytes}),id=r.body.file.id;
 const save=store.save;store.save=()=>{throw Error('SECRET_PRIVATE_PATH');};const done=await request(service,credential,{route:'/complete',method:'POST'});assert.equal(done.body.error,'UPLOAD_STORAGE_UNAVAILABLE');assert.equal(JSON.stringify(done).includes('SECRET'),false);assert.equal(store.data.visaMedia[id].purpose,'visa_upload_staged');assert.equal((await request(service,credential)).body.state,'open');store.save=save;
 assert.equal((await request(service,credential,{route:'/complete',method:'POST'})).status,200);
});
test('restart preserves authentication and idempotent committed response; deletion revokes only same customer session',async t=>{
 const{service,store,media,inbox}=setup(t),credential=token(service.createLink(customer)),foreign=token(service.createLink(other)),bytes=await image();await request(service,credential,{route:'/files',method:'POST',bytes});await request(service,credential,{route:'/complete',method:'POST'});
 const restart=new VisaUploadService({store,mediaStore:media,inbox,env:{RENDER_EXTERNAL_URL:base},now:()=>1000002});assert.equal((await request(restart,credential)).body.state,'completed');restart.deleteCustomer(customer);assert.equal((await request(restart,credential)).status,401);assert.equal((await request(restart,foreign)).status,200);
});
