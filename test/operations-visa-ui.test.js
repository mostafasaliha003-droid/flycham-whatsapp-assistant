'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../src/operations.js'),'utf8'),html=fs.readFileSync(require.resolve('../src/operations.html'),'utf8');
function setup(customer,visaCase){
 const nodes=new Map(),requests=[];
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this._text='';this.value='';this.hidden=false;this.disabled=false;this.dataset={};this.attributes={};this.classList={toggle:()=>{},add:()=>{},remove:()=>{}};this.scrollHeight=0;this.scrollTop=0;this.clientHeight=0;this.isConnected=true;}
  set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(x=>x?.textContent||'').join('');}
  append(...args){this.children.push(...args.map(x=>typeof x==='string'?Object.assign(new Element(),{textContent:x}):x));}
  replaceChildren(...args){this._text='';this.children=[];this.append(...args);}
  replaceWith(e){for(const [id,node]of nodes)if(node===this)nodes.set(id,e);}
  setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}addEventListener(){}remove(){}click(){this.onclick?.();}
 }
 for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set(match[1],new Element());
 const document={getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element(),{textContent:text}),querySelectorAll:()=>[],addEventListener:()=>{},body:new Element(),hidden:false};
 const detail=()=>({customer:{...customer},visaCase:visaCase?structuredClone(visaCase):undefined,messages:[],notes:[],media:[],sendAttempts:[]});
 const context={document,location:{search:'?customer='+customer.id,origin:'https://example.test'},URL,URLSearchParams,Intl,Date,Map,Set,Number,String,Array,Object,JSON,AbortController,AbortSignal,crypto:require('node:crypto').webcrypto,confirm:()=>true,prompt:()=> 'staff reason',setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{},window:{addEventListener:()=>{}},console,fetch:async(path,options={})=>{
  requests.push({path,options});let data={};
  if(path==='/internal/assistant/status')data={};
  else if(path.startsWith('/internal/assistant/conversations?'))data={items:[{...customer}]};
  else if(path.includes('/conversations/'+customer.id+'/block')){const body=JSON.parse(options.body);if(body.scope==='whatsapp')customer.whatsappBlocked=true;else customer.assistantBlocked=true;customer.blocked=true;data={ok:true,customer:{...customer}};}
  else if(path.includes('/conversations/'+customer.id+'/claim')){customer.staffClaimed=true;data={ok:true,customer:{...customer}};}
  else if(path.includes('/conversations/'+customer.id+'?'))data=detail();
  else if(path.includes('/conversations/'+customer.id+'/visa'))data={ok:true};
  return{ok:true,status:200,json:async()=>data};
 }};
 vm.runInNewContext(source,context,{filename:'operations.js'});
 return{nodes,requests,context,login:async()=>{nodes.get('key').value='test-admin-key';await nodes.get('login-form').onsubmit({preventDefault(){}});}};
}
const base=()=>({id:'971500000001',name:'عميل تجريبي',service:'saudi_visa',humanOwned:true,staffClaimed:false,automationPaused:true,serviceWindowOpen:true,status:'idle',complaint:{id:'complaint-1',state:'pending',notificationState:'pending'},blocked:false,assistantBlocked:false});
test('pending complaint opens from an authenticated deep link without granting staff send or exposing key in URL',async()=>{
 const ui=setup(base(),{id:'visa-1',stage:'quoted',policyVersion:'2026-10',applicantCount:1,applicants:[{nationality:'سوريا',documentType:'passport'}],quote:{subtotal:700,paymentFee:0,total:700,rows:[]},paymentStatus:'unverified'});await ui.login();
 assert.equal(ui.nodes.get('ownership-action').textContent,'استلام المحادثة');assert.equal(ui.nodes.get('message-text').disabled,true);assert.equal(ui.nodes.get('complaint-banner').hidden,false);assert.match(ui.nodes.get('visa-details').textContent,/700\.00/);assert.match(ui.nodes.get('visa-details').textContent,/سوريا/);assert.ok(ui.requests.some(x=>x.path.includes('/conversations/971500000001?')));for(const request of ui.requests){assert.doesNotMatch(request.path,/test-admin-key/);assert.equal(request.options.headers.Authorization,'Bearer test-admin-key');}
});
test('service filter is sent to backend and local/native block actions are explicitly distinct',async()=>{
 const customer=base();customer.complaint=null;const ui=setup(customer);await ui.login();ui.nodes.get('service-filter').value='saudi_visa';await ui.nodes.get('service-filter').onchange();assert.ok(ui.requests.some(x=>x.path.includes('service=saudi_visa')));
 await ui.nodes.get('block-action').onclick();const local=ui.requests.find(x=>x.path.endsWith('/block'));assert.deepEqual(JSON.parse(local.options.body),{confirm:true,reason:'staff reason',scope:'assistant'});
 await ui.nodes.get('whatsapp-block-action').onclick();const native=ui.requests.filter(x=>x.path.endsWith('/block')).at(-1);assert.equal(JSON.parse(native.options.body).scope,'whatsapp');
});
test('claim is required before staff visa verification controls are enabled',async()=>{
 const customer=base();const ui=setup(customer,{id:'visa-1',stage:'quoted',applicants:[],quote:{subtotal:700,total:700},paymentStatus:'unverified'});await ui.login();const actions=ui.nodes.get('visa-details').children.find(x=>x.className==='visa-actions');assert.ok(actions.children.every(x=>x.disabled));await ui.nodes.get('ownership-action').onclick();assert.equal(customer.staffClaimed,true);assert.equal(ui.nodes.get('message-text').disabled,false);
});
