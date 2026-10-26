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
