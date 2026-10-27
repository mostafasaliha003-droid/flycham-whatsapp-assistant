'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname,'..');
const copy=value=>JSON.parse(JSON.stringify(value));
const descendants=node=>[node,...(node?.children||[]).flatMap(descendants)];
const mappingPreview=(id,summary)=>({mode:'preview_only',canExecute:false,draftRevision:summary.revision,caseId:'visa-'+id,fields:[{sourceField:'fields.passportNumber',portalLabel:'رقم جواز السفر في البوابة',controlId:'ContentPlaceHolder1_txtPassportNo',kind:'text',value:summary.fields.passportNumber,status:'mapped'},{sourceField:'fields.visitPurpose',portalLabel:'نوع التأشيرة',controlName:'VisaKind',kind:'select',value:'19',displayValue:'زيارة سياحية',status:'reviewed_option'},{sourceField:'fields.mission',portalLabel:'أقرب ممثلية سعودية',controlName:'EmbassyCode',kind:'select',value:'214',displayValue:'أبوظبي',status:'reviewed_option'},{sourceField:'fields.birthDate',portalLabel:'تاريخ الميلاد في البوابة',controlId:'ContentPlaceHolder1_BirthDate',kind:'date',value:'1990-02-03',displayValue:{label:'عرض غير صالح'},status:'mapped'}],unresolved:['يلزم مطابقة مكان الميلاد.'],notices:['ملاحظة محلية للمراجعة فقط.']});
function setup({owned=true,fields={passportNumber:'A1234567'},documents={passport:'passport-own-12345'},summaryState='draft',issues=[],previewResponse=null,extraMedia=[],reviewRequiredFields=['fields.passportNumber','documents.passport']}={}){
 const nodes=new Map(),requests=[],customers=[{id:'971500000001',name:'العميل الأول',service:'saudi_visa',staffClaimed:owned,humanOwned:true,serviceWindowOpen:true,status:'idle'},{id:'971500000002',name:'العميل الثاني',service:'saudi_visa',staffClaimed:owned,humanOwned:true,serviceWindowOpen:true,status:'idle'}],summaries=new Map(),derivedByCustomer=new Map();
 for(const customer of customers)for(let index=0;index<2;index++)summaries.set(customer.id+':'+index,{applicantIndex:index,jobId:'raad-'+customer.id+'-'+index,revision:4,state:summaryState,fields:index===0?copy(fields):{passportNumber:'B7654321'},defaults:{mission:'Abu Dhabi',residenceCountryCode:'ARE',entries:'multiple',visaValidityDays:365,applicationPhone:'971500001111'},documents:copy(documents),issues:copy(issues),missing:[],reviewRequiredFields:[...reviewRequiredFields],review:{confirmedFields:[],requiredFields:[...reviewRequiredFields],complete:false},portal:{connected:false,mode:'preparation'}});
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this._text='';this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.dataset={};this.attributes={};this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;this.isConnected=true;this.classList={toggle(){},add(){},remove(){},contains(){return false;}};}
  set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(child=>child?.textContent||'').join('');}
  append(...children){this.children.push(...children.map(child=>typeof child==='string'?Object.assign(new Element(),{textContent:child}):child));}
  replaceChildren(...children){this._text='';this.children=[];this.append(...children);}
  replaceWith(next){for(const [id,node]of nodes)if(node===this)nodes.set(id,next);}
  setAttribute(key,value){this.attributes[key]=String(value);}removeAttribute(key){delete this.attributes[key];}addEventListener(name,handler){this['on'+name]=handler;}remove(){}focus(){}click(){if(!this.disabled)return this.onclick?.({preventDefault(){},target:this});}
  querySelectorAll(){return descendants(this).slice(1);}
 }
 const html=fs.readFileSync(root+'/src/operations.html','utf8');for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set(match[1],new Element());
 const document={getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element(),{textContent:text}),createDocumentFragment:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},body:new Element(),hidden:false};
 const media=id=>[{id:'passport-own-12345',customer:id,filename:'passport-own.pdf',status:'stored'},{id:'residence-own-1234',customer:id,filename:'residence-own.pdf',status:'stored'},{id:'foreign-file-12345',customer:id===customers[0].id?customers[1].id:customers[0].id,filename:'foreign.pdf',status:'stored'},...extraMedia.map(item=>({...item,customer:id})),...(derivedByCustomer.get(id)||[])];
 const detail=customer=>({customer:copy(customer),visaCase:{id:'visa-'+customer.id,stage:'quoted',applicantCount:2,applicants:[{nationality:'سوريا',documentType:'passport'},{nationality:'مصر',documentType:'passport'}]},messages:[],notes:[],media:media(customer.id),sendAttempts:[]});
 const context={document,location:{search:'?customer='+customers[0].id,origin:'https://example.test'},URL,URLSearchParams,Intl,Date,Map,Set,Number,String,Array,Object,JSON,AbortController,AbortSignal,crypto:require('node:crypto').webcrypto,structuredClone,confirm:()=>true,prompt:()=>null,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},window:{addEventListener(){}},console,fetch:async(path,options={})=>{
  requests.push({path:String(path),options});const url=new URL(path,'https://example.test');let data={};
  if(url.pathname==='/internal/assistant/status')data={};
  else if(url.pathname==='/internal/assistant/conversations')data={items:copy(customers)};
  else if(url.pathname.startsWith('/internal/assistant/raad/')){
   const id=decodeURIComponent(url.pathname.split('/').at(-1)),body=options.body?JSON.parse(options.body):null,index=Number(body?.applicantIndex??url.searchParams.get('applicantIndex')??0),key=id+':'+index,summary=summaries.get(key);
   if(body?.action==='parse_mrz')data={ok:true,fields:{passportNumber:'N1234567',nationalityCode:'EGY',issuingCountryCode:'EGY',birthDate:'1990-02-03',expiryDate:'2030-04-05',sex:'M',latinNames:{family:'HASSAN',givenNames:'OMAR AHMED'}},issues:[{field:'latinNames.givenNames',code:'MANUAL_NAME_MAPPING',message:'راجع توزيع الأسماء يدوياً'}]};
   else if(body?.action==='preview_mapping')data=previewResponse?await previewResponse({id,index,summary,body}):mappingPreview(id,summary);
   else if(body?.action==='prepare_image'){const derived={id:'prepared-image-12345',customer:id,filename:'derived-'+body.kind+'.jpg',status:'stored'};derivedByCustomer.set(id,[derived]);data={ok:true,media:derived};}
   else if(body?.action==='prepare'){summary.fields=copy(body.fields);summary.documents=copy(body.documents);summary.revision++;summary.state='draft';summary.review={confirmedFields:[],requiredFields:[...summary.reviewRequiredFields],complete:false};data=copy(summary);}
   else if(body?.action==='review'){summary.revision++;summary.state='ready_for_portal_review';summary.review={confirmedFields:copy(body.confirmedFields),requiredFields:[...summary.reviewRequiredFields],complete:true};data=copy(summary);}
   else data=copy(summary);
  }else{
   const customer=customers.find(item=>url.pathname.includes('/conversations/'+item.id));
   if(customer&&url.pathname.endsWith('/claim')){customer.staffClaimed=true;data={ok:true,customer:copy(customer)};}
   else if(customer)data=detail(customer);
  }
  return{ok:true,status:200,json:async()=>data};
 }};
 vm.runInNewContext(fs.readFileSync(root+'/src/operations.js','utf8'),context,{filename:'operations.js'});
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 const panel=()=>nodes.get('raad-details');
 const find=(attribute,value)=>descendants(panel()).find(node=>node?.dataset?.[attribute]===value);
 const action=name=>find('raadAction',name),input=path=>find('raadField',path),role=name=>find('raadRole',name);
 const edit=async(node,value)=>{assert.ok(node,'editable control exists');node.value=value;await (node.oninput||node.onchange)?.({target:node});await settle();};
 const invoke=async node=>{assert.ok(node,'action exists');await node.onclick?.({target:node,preventDefault(){}});await settle();};
 return{nodes,requests,summaries,customers,panel,find,action,input,role,edit,invoke,settle,login:async()=>{nodes.get('key').value='test-admin-key';await nodes.get('login-form').onsubmit({preventDefault(){}});await settle();},select:async id=>{await invoke(descendants(nodes.get('conversation-list')).find(node=>node.dataset.customer===id));},refresh:async()=>{await nodes.get('refresh').onclick();await settle();}};
}
const raadPosts=ui=>ui.requests.filter(request=>request.path.includes('/internal/assistant/raad/')&&request.options.method==='POST');

test('neutral PDF previews never appear in document or residence-source selectors',async()=>{
 const ui=setup({extraMedia:[{id:'preview-neutral',filename:'neutral-page.png',status:'pending_review',purpose:'raad_pdf_preview'},{id:'pdf-source',filename:'document.pdf',status:'pending_review',pdfPreparation:{status:'done'}}]});await ui.login();
 for(const path of ['documents.passport','documents.residence','documents.photo'])assert.doesNotMatch(ui.input(path).textContent,/neutral-page/);
 assert.doesNotMatch(ui.role('residence_back').textContent,/neutral-page/);
 assert.match(ui.input('documents.passport').textContent,/passport-own/);
 assert.match(ui.panel().textContent,/معاينة الصفحات جاهزة للتنزيل والمراجعة/);
});

test('Raad exposes preparation and manual portal checkpoints while requiring a staff claim for mutation',async()=>{
 const ui=setup({owned:false});await ui.login();assert.equal(ui.panel().hidden,false);assert.match(ui.panel().textContent,/رعد/);assert.match(ui.panel().textContent,/تجهيز ومراجعة — البوابة غير متصلة بعد/);assert.match(ui.panel().textContent,/CAPTCHA/);assert.match(ui.panel().textContent,/يدوي/);assert.ok(ui.requests.some(request=>request.path==='/internal/assistant/raad/971500000001?applicantIndex=0'));
 const before=raadPosts(ui).length;assert.equal(ui.action('prepare').disabled,true);await ui.invoke(ui.action('prepare'));assert.equal(raadPosts(ui).length,before);
 await ui.nodes.get('ownership-action').onclick();await ui.settle();assert.equal(ui.action('prepare').disabled,false);
 for(const request of ui.requests){assert.doesNotMatch(request.path,/test-admin-key/);assert.equal(request.options.headers.Authorization,'Bearer test-admin-key');}
});

test('polling preserves edits and drafts stay isolated by customer and applicant',async()=>{
 const ui=setup();await ui.login();await ui.edit(ui.input('passportNumber'),'LOCAL-EDIT');await ui.refresh();assert.equal(ui.input('passportNumber').value,'LOCAL-EDIT');
 let applicant=ui.role('applicant');applicant.value='1';await applicant.onchange({target:applicant});await ui.settle();assert.equal(ui.input('passportNumber').value,'B7654321');await ui.edit(ui.input('passportNumber'),'SECOND-EDIT');
 applicant=ui.role('applicant');applicant.value='0';await applicant.onchange({target:applicant});await ui.settle();assert.equal(ui.input('passportNumber').value,'LOCAL-EDIT');
 await ui.select(ui.customers[1].id);assert.equal(ui.input('passportNumber').value,'A1234567');await ui.select(ui.customers[0].id);assert.equal(ui.input('passportNumber').value,'LOCAL-EDIT');
 await ui.nodes.get('logout').onclick();await ui.login();assert.equal(ui.input('passportNumber').value,'A1234567');
});

test('save and review bind to the saved revision and exact server review fields',async()=>{
 const ui=setup();await ui.login();await ui.edit(ui.input('passportNumber'),'SAVED-EDIT');assert.equal(ui.action('review').disabled,true);await ui.invoke(ui.action('prepare'));
 const saved=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(saved.action,'prepare');assert.equal(saved.confirm,true);assert.equal(saved.applicantIndex,0);assert.equal(saved.expectedRevision,4);assert.equal(saved.fields.passportNumber,'SAVED-EDIT');assert.equal(saved.documents.passport,'passport-own-12345');assert.equal('mrz'in saved,false);
 const checkbox=ui.role('review');assert.equal(checkbox.checked,false);checkbox.checked=true;await checkbox.onchange?.({target:checkbox});await ui.settle();await ui.invoke(ui.action('review'));
 const reviewed=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(reviewed.action,'review');assert.equal(reviewed.expectedRevision,5);assert.equal(reviewed.confirm,true);assert.deepEqual(reviewed.confirmedFields,['fields.passportNumber','documents.passport']);
 await ui.edit(ui.input('passportNumber'),'CHANGED-AGAIN');assert.equal(ui.role('review').checked,false);assert.equal(ui.action('review').disabled,true);const count=raadPosts(ui).length;await ui.invoke(ui.action('review'));assert.equal(raadPosts(ui).length,count);
});

test('MRZ remains ephemeral and ambiguous given names require manual mapping',async()=>{
 const ui=setup({fields:{}});await ui.login();await ui.edit(ui.role('mrz'),'P<EGYHASSAN<<OMAR<AHMED<<<<<<<<<<<<<<<<<<<<<<\nN1234567<0EGY9002030M3004050<<<<<<<<<<<<<<00');await ui.invoke(ui.action('parse_mrz'));
 const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.action,'parse_mrz');assert.match(body.mrz,/OMAR/);assert.equal(ui.input('passportNumber').value,'N1234567');assert.equal(ui.input('latinFamilyName').value,'HASSAN');assert.equal(ui.input('latinFirstName').value,'');assert.equal(ui.input('latinFatherName').value,'');assert.equal(ui.input('latinGrandfatherName').value,'');assert.match(ui.panel().textContent,/يدوياً|يدوي/);assert.equal(ui.role('review').checked,false);
 const applicant=ui.role('applicant');applicant.value='1';await applicant.onchange({target:applicant});await ui.settle();assert.equal(ui.role('mrz').value,'');const back=ui.role('applicant');back.value='0';await back.onchange({target:back});await ui.settle();assert.equal(ui.role('mrz').value,'');
 await ui.invoke(ui.action('prepare'));const prepared=JSON.parse(raadPosts(ui).at(-1).options.body);assert.doesNotMatch(JSON.stringify(prepared),/P<EGYHASSAN|OMAR<AHMED/);
});

test('document selectors only offer available media belonging to the active customer',async()=>{
 const ui=setup();await ui.login();const passport=ui.input('documents.passport');assert.ok(passport);assert.match(passport.textContent,/passport-own/);assert.doesNotMatch(passport.textContent,/foreign/);assert.equal(passport.value,'passport-own-12345');
 const phone=ui.input('applicationPhone');assert.equal(phone.value,'');assert.match(ui.panel().textContent,/971500001111/);await ui.invoke(ui.action('use_defaults'));assert.equal(ui.input('applicationPhone').value,'971500001111');assert.equal(ui.role('review').checked,false);
});


test('hotel remains informational and copying suggestions never supplies an address or health response',async()=>{
 const ui=setup({fields:{}}),summary=ui.summaries.get(ui.customers[0].id+':0');summary.officeHotelSuggestion='Hilton Al Riyadh';summary.defaults.proposedEntryDate='2026-11-11';
 await ui.login();assert.match(ui.panel().textContent,/Hilton Al Riyadh/);assert.match(ui.panel().textContent,/لا يؤكد الحجز أو عنوان الإقامة/);assert.match(ui.panel().textContent,/١٥ يومًا من تاريخ المعاينة/);
 assert.equal(ui.input('health.hospitalizedOrEmergency').attributes['aria-label'],'هل هناك حالة تنويم في المستشفى حاليًا أو تتلقى علاج الطوارئ؟');
 assert.equal(ui.input('health.accidentDisability').attributes['aria-label'],'هل تعرضت لحادث أدى إلى إصابتك بعلة أو إعاقة؟');assert.equal(ui.input('health.congenitalCondition').attributes['aria-label'],'هل لديك حالات ضعف أو تشوه خلقي؟');
 await ui.invoke(ui.action('use_defaults'));assert.equal(ui.input('saudiAddress').value,'');assert.equal(ui.input('health.hospitalizedOrEmergency').value,'');
 await ui.invoke(ui.action('prepare'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(Object.hasOwn(body.fields,'saudiAddress'),false);assert.equal(Object.hasOwn(body.fields,'health'),false);assert.equal(body.fields.entryDate,'2026-11-11');
});

test('copying suggestions preserves an entry date already supplied',async()=>{
 const ui=setup({fields:{entryDate:'2026-12-05'}}),summary=ui.summaries.get(ui.customers[0].id+':0');summary.defaults.proposedEntryDate='2026-11-11';
 await ui.login();await ui.invoke(ui.action('use_defaults'));assert.equal(ui.input('entryDate').value,'2026-12-05');
});

test('a newer saved revision preserves local edits and requires an explicit reload before review',async()=>{
 const ui=setup();await ui.login();await ui.edit(ui.input('passportNumber'),'UNSAVED-LOCAL');const summary=ui.summaries.get(ui.customers[0].id+':0');summary.revision=8;summary.fields.passportNumber='REMOTE-SAVED';await ui.refresh();assert.equal(ui.input('passportNumber').value,'UNSAVED-LOCAL');assert.equal(ui.action('review').disabled,true);assert.equal(ui.role('review').checked,false);
 await ui.invoke(ui.action('reload'));assert.equal(ui.input('passportNumber').value,'REMOTE-SAVED');await ui.edit(ui.input('passportNumber'),'FINAL-DRAFT');await ui.invoke(ui.action('prepare'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.expectedRevision,8);assert.equal(body.fields.passportNumber,'FINAL-DRAFT');
});


test('document snapshots select their media IDs and explicit clears survive the merge-patch payload',async()=>{
 const ui=setup({documents:{passport:{mediaId:'passport-own-12345',sha256:'saved-snapshot'}}});await ui.login();assert.equal(ui.input('documents.passport').value,'passport-own-12345');
 await ui.edit(ui.input('documents.passport'),'');await ui.edit(ui.input('passportNumber'),'');await ui.invoke(ui.action('prepare'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.action,'prepare');assert.equal(body.documents.passport,null);assert.equal(body.fields.passportNumber,null);assert.equal(body.expectedRevision,4);
});

test('image preparation requires selected sources and leaves binding and visual review to the operator',async()=>{
 const ui=setup({documents:{passport:'passport-own-12345',residence:'residence-own-1234'}});await ui.login();await ui.edit(ui.input('documents.passport'),'');const count=raadPosts(ui).length;assert.equal(ui.action('prepare_image').disabled,true);await ui.invoke(ui.action('prepare_image'));assert.equal(raadPosts(ui).length,count);
 const kind=ui.role('image_kind');await ui.edit(kind,'residence');const second=ui.role('residence_back');assert.doesNotMatch(second.textContent,/foreign/);await ui.edit(second,'residence-own-1234');await ui.invoke(ui.action('prepare_image'));assert.equal(raadPosts(ui).length,count);
 await ui.edit(second,'passport-own-12345');await ui.invoke(ui.action('prepare_image'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.deepEqual(body,{action:'prepare_image',applicantIndex:0,kind:'residence',sourceIds:['residence-own-1234','passport-own-12345'],confirm:true});assert.equal(ui.input('documents.residence').value,'residence-own-1234');assert.equal(ui.input('documents.passport').value,'');assert.equal(ui.role('review').checked,false);assert.equal(raadPosts(ui).length,count+1);assert.match(ui.panel().textContent,/فحصاً بصرياً|الفحص البصري/);assert.doesNotMatch(ui.panel().textContent,/تمت المراجعة البصرية/);
 await ui.invoke(ui.action('prepare'));const saved=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(saved.documents.residence,'residence-own-1234');assert.equal(saved.documents.passport,null);assert.doesNotMatch(JSON.stringify(saved.documents),/prepared-image-12345/);
});

test('PDF page and orientation are sent only when explicitly chosen',async()=>{
 const ui=setup();await ui.login();await ui.edit(ui.role('pdf_page'),'2');await ui.edit(ui.role('pdf_rotation'),'90');await ui.invoke(ui.action('prepare_image'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.pdfPage,2);assert.equal(body.pdfRotation,90);assert.equal(body.kind,'passport');
});

test('a server-stale case permits a fresh preparation and blocks review until that preparation is saved',async()=>{
 const ui=setup({summaryState:'stale'});await ui.login();assert.equal(ui.action('prepare').disabled,false);assert.equal(ui.action('review').disabled,true);const checkbox=ui.role('review');checkbox.checked=true;await checkbox.onchange({target:checkbox});const before=raadPosts(ui).length;await ui.invoke(ui.action('review'));assert.equal(raadPosts(ui).length,before);
 await ui.invoke(ui.action('prepare'));const prepared=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(prepared.action,'prepare');assert.equal(prepared.expectedRevision,4);assert.equal(ui.role('review').disabled,false);assert.equal(ui.role('review').checked,false);assert.equal(ui.action('review').disabled,true);
});


test('applicant declarations remain uninferred until explicit answers and positive answers request review',async()=>{
 const ui=setup({issues:[{field:'priorGccRuleViolation',code:'APPLICANT_PLEDGE_REQUIRES_REVIEW'}]});await ui.login();assert.equal(ui.input('priorGccDeportation').value,'');assert.equal(ui.input('priorGccRuleViolation').value,'');assert.equal(ui.input('priorGccDeportation').attributes['aria-label'],'هل سبق الترحيل من السعودية أو إحدى دول الخليج؟');assert.equal(ui.input('priorGccRuleViolation').attributes['aria-label'],'هل توجد مخالفات سابقة للأنظمة في السعودية أو دول الخليج؟');
 await ui.invoke(ui.action('prepare'));let body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(Object.hasOwn(body.fields,'priorGccDeportation'),false);assert.equal(Object.hasOwn(body.fields,'priorGccRuleViolation'),false);assert.match(ui.panel().textContent,/إجابة نعم تحتاج مراجعة/);assert.match(ui.panel().textContent,/لا تعني رفض التأشيرة تلقائياً/);assert.doesNotMatch(ui.panel().textContent,/APPLICANT_PLEDGE_REQUIRES_REVIEW/);
 await ui.edit(ui.input('priorGccDeportation'),'false');await ui.edit(ui.input('priorGccRuleViolation'),'true');await ui.invoke(ui.action('prepare'));body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.fields.priorGccDeportation,false);assert.equal(body.fields.priorGccRuleViolation,true);await ui.refresh();assert.equal(ui.input('priorGccDeportation').value,'false');assert.equal(ui.input('priorGccRuleViolation').value,'true');
});


test('mapping preview uses the saved revision without confirmation or portal execution',async()=>{
 const ui=setup({owned:false});await ui.login();assert.equal(ui.action('preview_mapping').disabled,true);await ui.invoke(ui.action('preview_mapping'));assert.equal(raadPosts(ui).length,0);await ui.nodes.get('ownership-action').onclick();await ui.settle();assert.equal(ui.role('review').checked,false);assert.equal(ui.action('preview_mapping').disabled,false);
 await ui.invoke(ui.action('preview_mapping'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.deepEqual(body,{action:'preview_mapping',applicantIndex:0,expectedRevision:4});assert.equal(raadPosts(ui).length,1);assert.equal(ui.summaries.get(ui.customers[0].id+':0').revision,4);assert.equal(ui.role('review').checked,false);assert.match(ui.role('mapping_preview').textContent,/معاينة محلية — لم تُرسل البيانات للوزارة/);assert.match(ui.role('mapping_preview').textContent,/رقم جواز السفر في البوابة/);assert.match(ui.role('mapping_preview').textContent,/A1234567/);assert.match(ui.role('mapping_preview').textContent,/يلزم مطابقة مكان الميلاد/);assert.doesNotMatch(ui.role('mapping_preview').textContent,/ContentPlaceHolder1_txtPassportNo/);assert.ok(ui.requests.every(request=>request.path.startsWith('/internal/assistant/')));
});

test('mapping preview is cleared by edits and stays bound to the selected customer and applicant',async()=>{
 const ui=setup();await ui.login();await ui.invoke(ui.action('preview_mapping'));assert.match(ui.role('mapping_preview').textContent,/A1234567/);await ui.edit(ui.input('passportNumber'),'LOCAL-CHANGE');assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/A1234567/);assert.equal(ui.action('preview_mapping').disabled,true);const before=raadPosts(ui).length;await ui.invoke(ui.action('preview_mapping'));assert.equal(raadPosts(ui).length,before);
 await ui.invoke(ui.action('prepare'));await ui.invoke(ui.action('preview_mapping'));assert.match(ui.role('mapping_preview').textContent,/LOCAL-CHANGE/);await ui.select(ui.customers[1].id);assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/LOCAL-CHANGE/);await ui.select(ui.customers[0].id);assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/LOCAL-CHANGE/);
 await ui.invoke(ui.action('preview_mapping'));const applicant=ui.role('applicant');applicant.value='1';await applicant.onchange({target:applicant});await ui.settle();assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/LOCAL-CHANGE/);const back=ui.role('applicant');back.value='0';await back.onchange({target:back});await ui.settle();assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/LOCAL-CHANGE/);
});

test('a delayed mapping response for another customer cannot appear after selection changes',async()=>{
 let release;const ui=setup({previewResponse:({id,summary})=>new Promise(resolve=>{release=()=>resolve(mappingPreview(id,summary));})});await ui.login();assert.ok(ui.action('preview_mapping'),'preview action exists');const pending=ui.invoke(ui.action('preview_mapping'));await ui.settle();assert.equal(typeof release,'function');await ui.select(ui.customers[1].id);release();await pending;assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/A1234567/);await ui.select(ui.customers[0].id);assert.doesNotMatch(ui.role('mapping_preview')?.textContent||'',/A1234567/);
});

test('optional Arabic father and grandfather names round-trip with the saved draft',async()=>{
 const ui=setup();await ui.login();assert.equal(ui.input('arabicFatherName').value,'');assert.equal(ui.input('arabicGrandfatherName').value,'');await ui.edit(ui.input('arabicFatherName'),'أحمد');await ui.edit(ui.input('arabicGrandfatherName'),'محمود');await ui.invoke(ui.action('prepare'));const body=JSON.parse(raadPosts(ui).at(-1).options.body);assert.equal(body.fields.arabicFatherName,'أحمد');assert.equal(body.fields.arabicGrandfatherName,'محمود');await ui.refresh();assert.equal(ui.input('arabicFatherName').value,'أحمد');assert.equal(ui.input('arabicGrandfatherName').value,'محمود');
});


test('mapping preview shows Arabic option names and falls back to raw passport and date values',async()=>{
 const ui=setup();await ui.login();await ui.invoke(ui.action('preview_mapping'));const preview=ui.role('mapping_preview'),valueFor=label=>preview.children.find(row=>row.children?.[0]?.textContent===label)?.children?.[1]?.textContent;assert.equal(valueFor('نوع التأشيرة'),'زيارة سياحية');assert.equal(valueFor('أقرب ممثلية سعودية'),'أبوظبي');assert.equal(valueFor('رقم جواز السفر في البوابة'),'A1234567');assert.equal(valueFor('تاريخ الميلاد في البوابة'),'1990-02-03');assert.doesNotMatch(preview.textContent,/\b(?:19|214)\b|VisaKind|EmbassyCode|ContentPlaceHolder1_|عرض غير صالح/);
});
