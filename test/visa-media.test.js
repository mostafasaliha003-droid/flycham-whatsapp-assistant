'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {VisaMediaStore,handleVisaMediaRequest,mediaURL,MAX_BYTES}=require('../src/visa-media');
const {extractIncomingMessages}=require('../src/whatsapp');
const customer='971500000001',other='971500000002';
const pdf=Buffer.from('%PDF-1.7\nSynthetic confidential passport-document bytes\n%%EOF');
const message={media:{id:'123456789',type:'document',mimeType:'application/pdf',filename:'UNTRUSTED-name.pdf'}};
function setup(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'visa-media-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store={data:{},file:path.join(dir,'state.enc'),key:crypto.randomBytes(32),save(){this.saves=(this.saves||0)+1;}};let calls=[];let count=0;
 const fetchImpl=async(url,args)=>{calls.push({url,args});if(count++%2===0)return Response.json({id:'123456789',file_size:pdf.length,mime_type:'application/pdf',url:'https://lookaside.fbsbx.com/whatsapp_business/attachments/test',sha256:crypto.createHash('sha256').update(pdf).digest('hex'),...options.info});return new Response(options.bytes||pdf,{headers:{'content-type':'application/pdf'}});};
 return{store,calls,dir,media:new VisaMediaStore({store,env:{NODE_ENV:'test',WHATSAPP_ACCESS_TOKEN:'synthetic-token'},fetchImpl,now:()=>1000000})};}
test('extracts media metadata and captions without interpreting filenames as instructions',()=>{
 const messages=extractIncomingMessages({entry:[{changes:[{field:'messages',value:{messages:[{id:'m',from:customer,type:'document',document:{id:'123456789',mime_type:'application/pdf',filename:'passport.pdf',caption:'فيزا السعودية'}},{id:'a',from:customer,type:'audio',audio:{id:'234567891',mime_type:'audio/ogg; codecs=opus'}}]}}]}]});
 assert.equal(messages[0].media.id,'123456789');assert.equal(messages[0].text,'فيزا السعودية');assert.equal(messages[1].media.type,'audio');assert.match(messages[1].text,/يحتاج تفريغ/);
});
test('stores encrypted media with pending review and requires customer ownership to retrieve',async t=>{
 const{media,dir,calls}=setup(t);const result=await media.receive(customer,message);assert.equal(result.ok,true);assert.equal(result.media.status,'pending_review');assert.equal(result.media.filename,'visa-document.pdf');assert.match(result.reply,/لم يتم تأكيد/);
 const encrypted=fs.readFileSync(path.join(dir,'visa-media',result.media.id+'.enc'));assert.equal(encrypted.includes(pdf),false);assert.equal(fs.statSync(path.join(dir,'visa-media',result.media.id+'.enc')).mode&0o777,0o600);
 assert.deepEqual(media.read(result.media.id,{customer}).bytes,pdf);assert.throws(()=>media.read(result.media.id,{customer:other}),/MEDIA_NOT_FOUND/);assert.throws(()=>media.read(result.media.id),/MEDIA_NOT_FOUND/);
 assert.equal(calls.length,2);assert.equal(calls[0].args.redirect,'error');assert.equal(calls[1].args.redirect,'error');assert.equal(JSON.stringify(media.list(customer)).includes('sourceId'),false);
 const duplicate=await media.receive(customer,message);assert.equal(duplicate.duplicate,true);assert.equal(calls.length,2);
});
test('rejects untrusted download hosts before sending credentials',async t=>{
 for(const url of ['http://lookaside.fbsbx.com/a','https://lookaside.fbsbx.com.evil.test/a','https://evil.test/a','https://token@lookaside.fbsbx.com/a','https://lookaside.fbsbx.com:444/a'])assert.throws(()=>mediaURL(url),/MEDIA_SOURCE_REJECTED/);
 const{media,calls}=setup(t,{info:{url:'https://evil.test/passport'}});const result=await media.receive(customer,message);assert.equal(result.ok,false);assert.equal(result.error,'MEDIA_SOURCE_REJECTED');assert.equal(calls.length,1);
});
test('rejects oversize, unsupported and inconsistent content without persisting it',async t=>{
 for(const info of [{file_size:MAX_BYTES+1},{mime_type:'text/html'},{sha256:'0'.repeat(64)},{file_size:pdf.length-1}]){const{media,store}=setup(t,{info});const r=await media.receive(customer,message);assert.equal(r.ok,false);assert.equal(Object.keys(store.data.visaMedia).length,0);}
 const{media}=setup(t,{bytes:Buffer.from('not actually a PDF'),info:{file_size:18}});assert.equal((await media.receive(customer,message)).ok,false);
});
test('does not fetch documents when safe persistent storage is unavailable',async()=>{
 let fetched=false;const media=new VisaMediaStore({store:{data:{},save(){}},env:{NODE_ENV:'production',WHATSAPP_ACCESS_TOKEN:'synthetic'},fetchImpl:async()=>{fetched=true;}});
 const result=await media.receive(customer,message);assert.equal(result.error,'MEDIA_STORAGE_UNAVAILABLE');assert.equal(fetched,false);assert.match(result.reply,/تعذر حفظه/);
});
test('admin media route enforces ownership and attachment/no-store headers',async t=>{
 const{media}=setup(t),r=await media.receive(customer,message);let status,headers,body;const response={writeHead(s,h){status=s;headers=h;return this;},end(b){body=b;}};
 await handleVisaMediaRequest({method:'GET'},response,new URL('https://test/internal/assistant/visa-media/'+r.media.id+'?customer='+other),media);assert.equal(status,404);
 await handleVisaMediaRequest({method:'GET'},response,new URL('https://test/internal/assistant/visa-media/'+r.media.id+'?customer='+customer),media);assert.equal(status,200);assert.match(headers['Content-Disposition'],/^attachment/);assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.deepEqual(body,pdf);
});
test('erasure removes encrypted media and index records',async t=>{
 const{media,dir}=setup(t),r=await media.receive(customer,message);media.deleteCustomer(customer);assert.equal(media.list(customer).length,0);assert.equal(fs.existsSync(path.join(dir,'visa-media',r.media.id+'.enc')),false);
});
test('restart reads durable encrypted media; expired records cannot be read',async t=>{
 const{media,store}=setup(t),r=await media.receive(customer,message);const restarted=new VisaMediaStore({store,env:{NODE_ENV:'test'},now:()=>1000001});assert.deepEqual(restarted.read(r.media.id,{customer}).bytes,pdf);
 const expired=new VisaMediaStore({store,env:{NODE_ENV:'test'},now:()=>r.media.expiresAt+1});assert.throws(()=>expired.read(r.media.id,{customer}),/MEDIA_NOT_FOUND/);expired.prune();assert.equal(Object.keys(store.data.visaMedia).length,0);
});

const syntheticPNG = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('Synthetic derived image fixture')]);

test('derived portal media is encrypted, private, pending visual review and never alters original bytes',async t=>{
 const{media,store,dir}=setup(t),source=(await media.receive(customer,message)).media;
 const originalRecord=structuredClone(store.data.visaMedia[source.id]),originalFile=fs.readFileSync(path.join(dir,'visa-media',source.id+'.enc'));
 const derived=media.storeDerived(customer,{sourceIds:[source.id],bytes:syntheticPNG,mimeType:'image/png',kind:'passport'});
 assert.equal(derived.customer,customer);assert.equal(derived.filename,'raad-passport.png');assert.equal(derived.type,'image');assert.equal(derived.mimeType,'image/png');assert.equal(derived.status,'pending_review');assert.equal(derived.purpose,'raad_portal_upload');assert.equal(derived.needsVisualReview,true);
 assert.equal(derived.size,syntheticPNG.length);assert.equal(derived.expiresAt,source.expiresAt);
 assert.equal(Object.hasOwn(derived,'sourceIds'),false);assert.equal(Object.hasOwn(derived,'checksum'),false);
 const target=path.join(dir,'visa-media',derived.id+'.enc'),encrypted=fs.readFileSync(target);
 assert.equal(encrypted.includes(syntheticPNG),false);assert.equal(fs.statSync(target).mode&0o777,0o600);
 assert.deepEqual(media.read(derived.id,{customer}).bytes,syntheticPNG);assert.throws(()=>media.read(derived.id,{customer:other}),/MEDIA_NOT_FOUND/);
 const restarted=new VisaMediaStore({store,env:{NODE_ENV:'test'},now:()=>1000001});assert.deepEqual(restarted.read(derived.id,{customer}).bytes,syntheticPNG);
 assert.deepEqual(store.data.visaMedia[source.id],originalRecord);assert.deepEqual(fs.readFileSync(path.join(dir,'visa-media',source.id+'.enc')),originalFile);assert.deepEqual(media.read(source.id,{customer}).bytes,pdf);
});

test('derived media requires owned live sources and rejects duplicate or malformed parent sets before saving',async t=>{
 const{media,store,dir}=setup(t,{info:{id:null}}),source=(await media.receive(customer,message)).media;
 const foreign=(await media.receive(other,{media:{...message.media,id:'987654321'}})).media;
 const options={sourceIds:[source.id],bytes:syntheticPNG,mimeType:'image/png',kind:'residence'},before=JSON.stringify(store.data.visaMedia),files=fs.readdirSync(path.join(dir,'visa-media')).sort(),saves=store.saves;
 for(const sourceIds of [[foreign.id],[source.id,foreign.id],['00000000-0000-0000-0000-000000000000']])assert.throws(()=>media.storeDerived(customer,{...options,sourceIds}),/MEDIA_NOT_FOUND/);
 for(const sourceIds of [undefined,[],[source.id,source.id],[source.id,foreign.id,'third'],'not-an-array'])assert.throws(()=>media.storeDerived(customer,{...options,sourceIds}),/MEDIA_INVALID/);
 assert.throws(()=>media.storeDerived(customer,{...options,kind:'audio'}),/MEDIA_INVALID/);
 assert.equal(JSON.stringify(store.data.visaMedia),before);assert.equal(store.saves,saves);assert.deepEqual(fs.readdirSync(path.join(dir,'visa-media')).sort(),files);
 const expired=new VisaMediaStore({store,env:{NODE_ENV:'test'},now:()=>source.expiresAt});assert.throws(()=>expired.storeDerived(customer,options),/MEDIA_NOT_FOUND/);
});

test('derived media deduplicates identical inputs and expires at the earliest parent expiry',async t=>{
 const{media,store,dir}=setup(t,{info:{id:null}}),first=(await media.receive(customer,message)).media,second=(await media.receive(customer,{media:{...message.media,id:'234567890'}})).media;
 store.data.visaMedia[first.id].expiresAt=1200000;store.data.visaMedia[second.id].expiresAt=1100000;
 const options={sourceIds:[first.id,second.id],bytes:syntheticPNG,mimeType:'image/png',kind:'residence'},derived=media.storeDerived(customer,options),saves=store.saves,files=fs.readdirSync(path.join(dir,'visa-media')).sort();
 assert.equal(derived.expiresAt,1100000);assert.deepEqual(media.storeDerived(customer,options),derived);assert.equal(store.saves,saves);assert.deepEqual(fs.readdirSync(path.join(dir,'visa-media')).sort(),files);
 const separateSource=media.storeDerived(customer,{...options,sourceIds:[first.id]}),separateKind=media.storeDerived(customer,{...options,sourceIds:[first.id],kind:'passport'});assert.notEqual(separateSource.id,derived.id,'different source sets have distinct derived identities');assert.notEqual(separateKind.id,separateSource.id,'document kinds have distinct derived identities');
 const expired=new VisaMediaStore({store,env:{NODE_ENV:'test'},now:()=>1100000});assert.throws(()=>expired.read(derived.id,{customer}),/MEDIA_NOT_FOUND/);assert.deepEqual(expired.read(first.id,{customer}).bytes,pdf);
});

test('derived portal uploads enforce the exact 1,000,000-byte limit and JPEG/PNG content types',async t=>{
 const{media,store}=setup(t),source=(await media.receive(customer,message)).media;
 const options={sourceIds:[source.id],bytes:syntheticPNG,mimeType:'image/png',kind:'photo'},saves=store.saves;
 for(const mimeType of ['image/webp','application/pdf','text/html',undefined,'IMAGE/PNG'])assert.throws(()=>media.storeDerived(customer,{...options,mimeType}),/MEDIA_CONTENT_INVALID/);
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(1000001),'not-a-buffer',Buffer.from('not a PNG')])assert.throws(()=>media.storeDerived(customer,{...options,bytes}),/MEDIA_(?:SIZE|CONTENT)_INVALID/);
 assert.throws(()=>media.storeDerived(customer,{...options,mimeType:'image/jpeg'}),/MEDIA_CONTENT_INVALID/);
 assert.equal(store.saves,saves);assert.equal(media.list(customer).length,1);
 const maximum=Buffer.alloc(1000000);syntheticPNG.copy(maximum);
 const derived=media.storeDerived(customer,{...options,bytes:maximum});assert.equal(derived.size,1000000);assert.deepEqual(media.read(derived.id,{customer}).bytes,maximum);
});

test('failed derived index persistence rolls back its encrypted file and record while preserving sources',async t=>{
 const{media,store,dir}=setup(t),source=(await media.receive(customer,message)).media,before=structuredClone(store.data.visaMedia),files=fs.readdirSync(path.join(dir,'visa-media')).sort(),sourceFile=fs.readFileSync(path.join(dir,'visa-media',source.id+'.enc'));
 store.save=()=>{throw Error('PRIVATE_STORAGE_PATH_AND_SECRET');};
 assert.throws(()=>media.storeDerived(customer,{sourceIds:[source.id],bytes:syntheticPNG,mimeType:'image/png',kind:'passport'}),{message:'MEDIA_STORAGE_UNAVAILABLE'});
 assert.deepEqual(store.data.visaMedia,before);assert.deepEqual(fs.readdirSync(path.join(dir,'visa-media')).sort(),files);assert.deepEqual(fs.readFileSync(path.join(dir,'visa-media',source.id+'.enc')),sourceFile);assert.deepEqual(media.read(source.id,{customer}).bytes,pdf);
});
