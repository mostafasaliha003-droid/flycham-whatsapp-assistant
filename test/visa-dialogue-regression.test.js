'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const sharp=require('sharp');

const CUSTOMER='15550004601',SECRET='synthetic-dialogue-webhook-secret',ADMIN='synthetic-dialogue-admin-key-xxxxxxxxxxxxxxxx',STATE_KEY='synthetic-dialogue-encrypted-state-key',GRAPH_TOKEN='synthetic-dialogue-graph-token',GEMMA_KEY='synthetic-dialogue-vision-key',BASE='https://flycham-whatsapp-assistant.onrender.com';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const field=value=>({value,confidence:0.999,visible:true});
const FACTS={passportNumber:'N12345678',passportType:'ordinary',nationalityCode:'EGY',issuingCountryCode:'EGY',birthDate:'1990-01-15',birthPlace:'Synthetic City',sex:'F',issueDate:'2025-01-01',expiryDate:'2031-01-01',latinFirstName:'SYNTHETIC',latinFamilyName:'EXAMPLE'};
function checkDigit(value){return String([...value].reduce((sum,character,index)=>sum+(character==='<'?0:/\d/.test(character)?Number(character):character.charCodeAt(0)-55)*[7,3,1][index%3],0)%10);}
function mrz(){
 const first='P<EGYEXAMPLE<<SYNTHETIC'.padEnd(44,'<'),number=FACTS.passportNumber,birth='900115',expiry='310101',optional='<'.repeat(14);
 const body=number+checkDigit(number)+'EGY'+birth+checkDigit(birth)+'F'+expiry+checkDigit(expiry)+optional+checkDigit(optional);
 return[first,body+checkDigit(body.slice(0,10)+body.slice(13,20)+body.slice(21,43))];
}
function extraction(role){
 const fields=role==='passport'?FACTS:role==='supplement'?{issueDate:'2024-01-01'}:role==='uae_id_front'?{latinFullName:'SYNTHETIC EXAMPLE',passportNumber:FACTS.passportNumber,birthDate:FACTS.birthDate,nationalityCode:'EGY',sex:'F',emiratesId:'784199000000001'}:role==='uae_id_back'?{emiratesId:'784199000000001',residenceExpiry:'2029-01-01'}:{};
 return{version:1,kind:role==='supplement'?'passport':role,readable:true,rotation:0,fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,field(value)])),mrzLines:role==='passport'?mrz():[],portraitBox:null};
}
async function syntheticPages(){
 const specs=[['741001','passport','#bed2f0',['Name: SYNTHETIC EXAMPLE','Passport: N12345678','Nationality / Issuer: EGY','Born: 1990-01-15    Place: Synthetic City','Issued: 2025-01-01    Expires: 2031-01-01','Type: ordinary    Sex: F',...mrz()]],['741002','supplement','#e6d28c',['UNANCHORED EXTRA PAGE','Issued: 2024-01-01','NO NAME OR PASSPORT NUMBER']],['741003','uae_id_front','#b4e1be',['Name: SYNTHETIC EXAMPLE','Passport: N12345678','Born: 1990-01-15    Nationality: EGY','Emirates ID: 784199000000001']],['741004','uae_id_back','#96b4dc',['Emirates ID: 784199000000001','Residence expires: 2029-01-01']],['741005','portrait','#f5c8c8',['SYNTHETIC PORTRAIT — NO REAL PERSON']]];
 const output=new Map();
 for(const[id,role,color,lines]of specs){
  const title='SYNTHETIC TEST DOCUMENT — '+role.toUpperCase();
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="${color}"/><text x="70" y="100" font-size="40" font-family="sans-serif">${title}</text>${lines.map((line,index)=>`<text x="70" y="${190+index*74}" font-size="33" font-family="monospace">${line.replaceAll('<','&lt;')}</text>`).join('')}</svg>`);
  output.set(id,{role,bytes:await sharp(svg).png().toBuffer(),rgb:color.slice(1).match(/../g).map(value=>parseInt(value,16))});
 }
 return output;
}

test('real signed operator-coordinated dialogue keeps an explicitly requested upload link and one discreet settled notice',{timeout:45000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'visa-dialogue-regression-')),file=path.join(directory,'state.enc'),previousEnv={...process.env},pages=await syntheticPages();
 Object.assign(process.env,{NODE_ENV:'test',ASSISTANT_STATE_PATH:file,ASSISTANT_STATE_KEY:STATE_KEY,WHATSAPP_APP_SECRET:SECRET,ASSISTANT_ADMIN_KEY:ADMIN,WHATSAPP_ACCESS_TOKEN:GRAPH_TOKEN,WHATSAPP_PHONE_NUMBER_ID:'123456789',WHATSAPP_GRAPH_API_VERSION:'v23.0',DRY_RUN:'false',SAUDI_VISA_ENABLED:'true',RAAD_DOCUMENT_OCR_ENABLED:'true',GEMINI_API_KEY:GEMMA_KEY,ASSISTANT_AI_PROVIDER:'disabled',CLINE_API_KEY:GEMMA_KEY,OPENAI_API_KEY:'',ASSISTANT_DEBOUNCE_MS:'50',CONSULTANT_ORCHESTRATOR_ENABLED:'false',FARE_CATALOG_ENABLED:'false',AIR_ARABIA_QUOTE_QUEUE_ENABLED:'false',FLYCHAM_PORTAL_ENABLED:'false',RAAD_VISA_AUTOMATION_ENABLED:'false',RAAD_BROWSER_WORKER_URL:'',RAAD_JOB_BRIDGE_KEY:'synthetic-dialogue-bridge-key-xxxxxxxxxxxxxxxx',SAUDI_VISA_WABA_ID:'',RAAD_OTP_REQUEST_TEMPLATE:'',RAAD_VISA_PAYMENT_TEMPLATE:'',RAAD_DOCUMENT_UPLOAD_WHATSAPP_NUMBER:'15550009999',RENDER_EXTERNAL_URL:BASE,RAAD_APPLICATION_PHONE:'+'+CUSTOMER,RAAD_CONTACT_EMAIL:'synthetic@example.test',RAAD_INSURANCE_PHONE:'+'+CUSTOMER,RAAD_POSTAL_CODE:'00000'});
 const {AssistantState}=require('../src/assistant-state'),P=require('../src/saudi-visa-policy'),{visaCaseSignature}=require('../src/visa-case-signature'),seed=new AssistantState({file,key:STATE_KEY});
 const visaCase={id:crypto.randomUUID(),service:'saudi_visa',policyVersion:P.POLICY_VERSION,revision:2,stage:'quoted',createdAt:Date.now()-10000,updatedAt:Date.now(),applicantCount:1,applicants:[{nationality:'مصر',documentType:'passport'}],askedQuestions:[],history:[{role:'assistant',text:'عرض تأشيرات السعودية — إجمالي رسوم التأشيرات: 640 درهم'}],paymentMethod:'bank',paymentStatus:'unverified',documents:[],submissionStatus:'not_submitted',greeted:true};visaCase.quote=P.calculateQuote(visaCase);
 seed.data.visaCases={[CUSTOMER]:visaCase};seed.data.serviceSessions={[CUSTOMER]:{service:'saudi_visa',revision:0,at:Date.now()}};
 // This fixture is an existing conversation with document feedback already
 // active. WhatsApp timestamps have whole-second precision: initializing the
 // activation instant during module load can place every fast inbound in the
 // preceding fraction of that second, correctly suppressing new-feature backfill.
 seed.data.visaDocumentFeedbackActivatedAt=Date.now()-60000;
 seed.set(CUSTOMER,{history:[],status:'idle',offers:[]});
 const originalQuote=structuredClone(visaCase.quote),originalSignature=visaCaseSignature(visaCase),posts=[],seenRoles=[],unexpected=[],originalFetch=global.fetch;
 global.fetch=async(url,options={})=>{
  const target=new URL(String(url));
  if(target.hostname==='graph.facebook.com'&&/^\/v23\.0\/74100[1-5]$/.test(target.pathname)){
   assert.equal(options.headers.Authorization,'Bearer '+GRAPH_TOKEN);assert.equal(options.redirect,'error');const id=target.pathname.split('/').at(-1),page=pages.get(id);
   return Response.json({id,mime_type:'image/png',file_size:page.bytes.length,sha256:sha(page.bytes),url:'https://lookaside.fbsbx.com/whatsapp_business/attachments?media_id='+id});
  }
  if(target.hostname==='lookaside.fbsbx.com'){
   assert.equal(options.headers.Authorization,'Bearer '+GRAPH_TOKEN);assert.equal(options.redirect,'error');const page=pages.get(target.searchParams.get('media_id'));assert.ok(page);
   return new Response(Buffer.from(page.bytes),{status:200,headers:{'content-type':'image/png','content-length':String(page.bytes.length)}});
  }
  if(target.hostname==='api.cline.bot'){
   assert.equal(target.pathname,'/api/v1/chat/completions');assert.equal(options.headers.Authorization,'Bearer '+GEMMA_KEY);assert.equal(options.redirect,'error');
   const body=JSON.parse(options.body),bytes=Buffer.from(body.messages[1].content[1].image_url.url.split(',')[1],'base64'),rgb=await sharp(bytes).extract({left:0,top:0,width:1,height:1}).removeAlpha().raw().toBuffer();
   const page=[...pages.values()].find(candidate=>candidate.rgb.every((channel,index)=>channel===rgb[index]));assert.ok(page,'Synthetic image must retain its known pixel marker');seenRoles.push(page.role);
   return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(extraction(page.role))}}]});
  }
  if(target.hostname==='graph.facebook.com'&&target.pathname==='/v23.0/123456789/messages'&&options.method==='POST'){
   assert.equal(options.headers.Authorization,'Bearer '+GRAPH_TOKEN);posts.push({body:JSON.parse(options.body),at:Date.now()});return Response.json({messages:[{id:'wamid.synthetic-dialogue-output-'+posts.length}]});
  }
  unexpected.push({host:target.hostname,path:target.pathname});throw Error('UNEXPECTED_SYNTHETIC_NETWORK');
 };
 const {createServer}=require('../src/server'),server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const readState=()=>new AssistantState({file,key:STATE_KEY}).data;
 const call=(route,{method='GET',data,headers={},signed=false}={})=>new Promise((resolve,reject)=>{
  const body=Buffer.from(data===undefined?'':JSON.stringify(data)),requestHeaders={'Content-Type':'application/json',...(body.length?{'Content-Length':String(body.length)}:{}),...(signed?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',SECRET).update(body).digest('hex')}:{}),...headers};
  const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:requestHeaders},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const bytes=Buffer.concat(chunks);let json;try{json=JSON.parse(bytes.toString());}catch{}resolve({status:response.statusCode,json,bytes});});});request.on('error',reject);request.end(body);
 });
 let sequence=0;
 const incoming=messages=>call('/webhooks/whatsapp',{method:'POST',signed:true,data:{entry:[{changes:[{field:'messages',value:{contacts:[{wa_id:CUSTOMER,profile:{name:'Synthetic Customer'}}],messages:messages.map(message=>({id:'synthetic-dialogue-inbound-'+(++sequence),from:CUSTOMER,timestamp:String(Math.floor(Date.now()/1000)),...message}))}}]}]}});
 const waitFor=async(condition,label,{timeout=10000}={})=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}const state=readState();assert.fail(label+': '+JSON.stringify({postCount:posts.length,seenRoles,unexpected,reading:state.visaDocumentIntake?.cases?.[CUSTOMER]?.status,issues:state.visaDocumentIntake?.cases?.[CUSTOMER]?.issues?.map(issue=>issue.code),notices:Object.values(state.visaDocumentNotifications?.items||{}).map(item=>({state:item.state,failure:item.failure}))}));};
 const texts=()=>posts.map(item=>item.body.text?.body||'');
 try{
  assert.equal((await incoming([{type:'text',text:{body:'ارسل رابط رفع المستندات'}}])).status,200);
  await waitFor(()=>posts.length===1,'First ready-to-apply turn should get one useful response');
  const first=texts()[0],link=first.match(/https:\/\/[^\s]+\/documents#[A-Za-z0-9_-]{43}/)?.[0];assert.ok(link);assert.match(first,/ارفع الجواز والهوية والصورة الشخصية/);assert.doesNotMatch(first,/700|عرض تأشيرات|إجمالي رسوم/);
  const token=new URL(link).hash.slice(1),auth={Authorization:'Bearer '+token,Origin:BASE};assert.equal((await call('/api/visa-upload/session',{headers:auth})).status,200);
  const initialSession=Object.values(readState().visaUpload.sessions)[0];assert.equal(initialSession.tokenHash,sha(token));
  assert.equal((await incoming([{type:'text',text:{body:'كيف بقدم شو ابعتلك'}}])).status,200);await waitFor(()=>posts.length===2,'How-to turn should retain context');
  assert.match(texts()[1],/صفحة بيانات الجواز كاملة/);assert.match(texts()[1],/رابط الرفع اللي أرسلته قبل شوي/);assert.doesNotMatch(texts()[1],/OCR|مطابقة|قراءة|تعذر|غير واضح|رقم الطلب/);assert.doesNotMatch(texts()[1],/700|إجمالي رسوم|https:/);assert.equal((await call('/api/visa-upload/session',{headers:auth})).status,200);assert.equal(Object.values(readState().visaUpload.sessions)[0].tokenHash,initialSession.tokenHash);
  assert.equal((await incoming([{type:'text',text:{body:'طيب رح ابعتلك'}}])).status,200);await waitFor(()=>posts.length===3,'Will-send turn should receive a short acknowledgement');
  assert.match(texts()[2],/^تمام، ابعتهن هون/);assert.ok(texts()[2].length<160);assert.doesNotMatch(texts()[2],/700|https:|جواز|إجمالي رسوم/);assert.equal(Object.values(readState().visaUpload.sessions)[0].tokenHash,initialSession.tokenHash);
  const cohortStart=Date.now();assert.equal((await incoming([...pages.keys()].map(id=>({type:'image',image:{id,mime_type:'image/png'}})))).status,200);
  await waitFor(()=>posts.length>=4,'Five image cohort should receive its receipt acknowledgement');const receipt=posts[3];assert.match(receipt.body.text.body,/وصل/);assert.doesNotMatch(receipt.body.text.body,/إجمالي رسوم|700/);
  const settled=await waitFor(()=>{const state=readState(),review=state.visaDocumentIntake?.cases?.[CUSTOMER],jobs=Object.values(state.visaDocumentIntake?.jobs||{}).filter(job=>job.customer===CUSTOMER);return review?.status==='needs_review'&&jobs.length===5&&jobs.every(job=>job.status==='ready')?state:null;},'All five synthetic pages should settle without erasing main passport evidence');
  assert.equal(settled.visaDocumentIntake.cases[CUSTOMER].applicants[0].fields.passportNumber,FACTS.passportNumber);assert.equal(settled.visaDocumentIntake.cases[CUSTOMER].applicants[0].fields.issueDate,FACTS.issueDate);assert.equal(settled.visaDocumentIntake.cases[CUSTOMER].applicants[0].evidence.passportMrzChecked,true);assert.equal(settled.visaDocumentIntake.cases[CUSTOMER].applicants[0].evidence.matchedResidence,true);
  const notice=await waitFor(()=>posts.find(item=>/^وصلت أوراقك، شكرًا إلك/.test(item.body.text?.body||'')),'Only settled cohort should produce a document-review notice',{timeout:30000});
  assert.ok(notice.at>receipt.at);assert.ok(notice.at-cohortStart>=12000,'Feedback must wait for the production cohort quiet period');assert.match(notice.body.text.body,/عم نجهّز ملفك/);assert.doesNotMatch(notice.body.text.body,/ربط|مطابقة|مطابقتها|تعذر|غير واضح/);assert.doesNotMatch(notice.body.text.body,/يرجى إرسال صفحة بيانات الجواز|يرجى إرسال صور الهوية|يرجى إرسال صورة شخصية/);
  // One full sweep later must not replay the same semantic notice.
  await new Promise(resolve=>setTimeout(resolve,5200));
  assert.equal(posts.length,5);assert.equal(posts.filter(item=>/^وصلت أوراقك، شكرًا إلك/.test(item.body.text?.body||'')).length,1);assert.equal(texts().filter(text=>text.includes('/documents#')).length,1);assert.equal(seenRoles.length,5);assert.deepEqual(new Set(seenRoles),new Set([...pages.values()].map(page=>page.role)));
  const final=readState();assert.equal(visaCaseSignature(final.visaCases[CUSTOMER]),originalSignature);assert.deepEqual(final.visaCases[CUSTOMER].quote,originalQuote);assert.deepEqual(final.visaCases[CUSTOMER].documents,[]);assert.equal(final.visaCases[CUSTOMER].paymentStatus,'unverified');assert.equal(final.visaCases[CUSTOMER].submissionStatus,'not_submitted');assert.notEqual(final.visaCases[CUSTOMER].staffVerification?.documentsReviewed,true);assert.equal(final.raadApplications?.[CUSTOMER],undefined);assert.equal(Object.keys(final.visaFulfilment.jobs).length,0);assert.equal(Object.keys(final.visaFulfilment.challenges).length,0);assert.equal(Object.values(final.visaFulfilment.cases).some(item=>item.approval),false);
  const originals=Object.values(final.visaMedia).filter(item=>!item.purpose);assert.equal(originals.length,5);for(const original of originals){assert.equal(original.customer,CUSTOMER);assert.equal(original.checksum,sha(pages.get(original.sourceId).bytes));const encrypted=fs.readFileSync(path.join(directory,'visa-media',original.id+'.enc'));assert.notDeepEqual(encrypted.subarray(0,8),pages.get(original.sourceId).bytes.subarray(0,8));}
  assert.equal(fs.readFileSync(file).includes(Buffer.from(FACTS.passportNumber)),false);assert.equal(JSON.stringify(final).includes(token),false);assert.ok(posts.every(item=>item.body.to===CUSTOMER&&item.body.type==='text'));assert.doesNotMatch(JSON.stringify(posts),/N12345678|784199000000001|تم تأكيد استلام دفعتك|تم تقديم الطلب/);assert.deepEqual(unexpected,[]);
 }finally{
  process.env.RAAD_DOCUMENT_OCR_ENABLED='false';process.env.SAUDI_VISA_ENABLED='false';process.env.RAAD_VISA_AUTOMATION_ENABLED='false';await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setTimeout(resolve,30));global.fetch=originalFetch;fs.rmSync(directory,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!Object.hasOwn(previousEnv,key))delete process.env[key];Object.assign(process.env,previousEnv);
 }
});
