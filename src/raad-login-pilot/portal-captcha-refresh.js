'use strict';
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
const CODES=new Set(['PORTAL_CAPTCHA_REFRESH_INPUT_INVALID','PORTAL_CAPTCHA_REFRESH_UNAVAILABLE','PORTAL_CAPTCHA_REFRESH_AMBIGUOUS','PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE','PORTAL_CAPTCHA_REFRESH_ACTIVATION_UNCONFIRMED','PORTAL_CAPTCHA_REFRESH_TIMEOUT','PORTAL_CAPTCHA_REFRESH_CANCELLED']);
const failure=code=>Object.assign(new Error(CODES.has(code)?code:'PORTAL_CAPTCHA_REFRESH_UNAVAILABLE'),{code:CODES.has(code)?code:'PORTAL_CAPTCHA_REFRESH_UNAVAILABLE',refreshedCount:0});
function inspectRefreshControl(args={}){
 const fail=code=>{throw Error(code);};
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm/TraditionalApp'||window.top!==window.self)fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return el.isConnected&&el.ownerDocument===document&&r.width>0&&r.height>0&&s.display!=='none'&&!['hidden','collapse'].includes(s.visibility)&&s.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
 const forms=Array.from(document.querySelectorAll('#myform'));if(forms.length!==1||forms[0].tagName!=='FORM')fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');
 const form=forms[0];let action;try{action=new URL(form.getAttribute('action')||location.href,document.baseURI||location.href);}catch{fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');}
 if(action.origin!==location.origin||action.pathname!=='/SmartForm/TraditionalApp'||action.username||action.password||action.search||action.hash||String(form.method).toLowerCase()!=='post')fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');
 const images=Array.from(form.querySelectorAll('#imgCaptcha'));if(images.length!==1)fail('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');
 const image=images[0];if(!visible(image)||image.tagName!=='IMG'||image.closest('form')!==form||args.form&&args.form!==form||args.image&&args.image!==image)fail('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');
 const literalCall=raw=>{
  const text=String(raw||'').replace(/^\s*javascript:\s*/i,'');
  const match=text.match(/^\s*(?:return\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(?:(?:this|event)|["']imgCaptcha["'])?\s*\)\s*;?\s*(?:return\s+false\s*;?)?\s*$/);
  if(!match)return null;const name=match[1].split('.').pop();return /captcha/i.test(name)&&/(?:refresh|reload|update|change|renew|regenerate)/i.test(name)?match[1]:null;
 };
 const refreshLabel=el=>{
  const publicText=el.tagName==='INPUT'?el.getAttribute('value'):el.tagName==='IMG'?el.getAttribute('alt'):['SPAN','I'].includes(el.tagName)&&el.children.length>0&&el.getAttribute('role')!=='button'?null:el.textContent;
  const text=[publicText,el.getAttribute('aria-label'),el.getAttribute('title')].filter(Boolean).join(' ');
  return /refresh|reload|regenerate|renew|تحديث|تجديد|(?:تغيير|تبديل)\s*(?:الصورة|الرمز)|(?:إعادة|اعادة)\s*(?:تحميل|توليد)/i.test(text);
 };
 const refreshIcon=el=>{
  const nodes=['SPAN','I'].includes(el.tagName)?[el]:[el,...Array.from(el.querySelectorAll('i,span,svg'))];
  return nodes.some(node=>Array.from(node.classList||[]).some(name=>/^(?:fa-refresh|fa-sync|fa-sync-alt|fa-redo|fa-redo-alt|glyphicon-refresh|icon-refresh|icon-reload|mdi-refresh|bi-arrow-clockwise|bi-arrow-repeat)$/.test(name)));
 };
 const safeControl=el=>{
  if(!el||!visible(el)||el.disabled||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true'||el.closest('form')!==form)return false;
  const tag=el.tagName,type=String(el.type||'').toLowerCase(),onclick=el.getAttribute('onclick')||'',href=el.getAttribute('href')||'';
  if(/(?:submit|save|payment|delete|logout|logoff|signout|cancel)/i.test(onclick+' '+href))return false;
  const explicit=refreshLabel(el)||Boolean(literalCall(onclick)),icon=refreshIcon(el);
  if(tag==='IMG')return el===image&&explicit;
  if(tag==='BUTTON'||tag==='INPUT')return type==='button'&&el.form===form&&(explicit||icon);
  if(tag==='A'){
   const safeHref=href.trim()==='#'||Boolean(literalCall(href))||/^javascript:\s*(?:void\s*\(\s*0\s*\)|;)?\s*;?$/i.test(href);
   return safeHref&&(explicit||icon||Boolean(literalCall(href)));
  }
  return ['SPAN','I'].includes(tag)&&(explicit||icon);
 };
 const scopes=[];for(let node=image.parentElement,depth=0;node&&node!==form&&depth<3;node=node.parentElement,depth++){if(node.closest('form')!==form)break;scopes.push(node);}
 const found=new Set();
 const consider=node=>{
  let target=node;if(['SPAN','I'].includes(node.tagName)){const wrapper=node.closest('button,input[type="button"],a,[role="button"]');if(wrapper&&wrapper.closest('form')===form)target=wrapper;}
  if(safeControl(target))found.add(target);
 };
 consider(image);
 for(const scope of scopes){const nodes=Array.from(scope.querySelectorAll('button,a,span,i,input,img'));if(nodes.length>200)fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');for(const node of nodes)consider(node);}
 if(found.size===0)fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');if(found.size!==1)fail('PORTAL_CAPTCHA_REFRESH_AMBIGUOUS');
 const control=Array.from(found)[0];if(args.control&&args.control!==control)fail('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');
 return args.control?true:{control,image,form,keyboard:['BUTTON','INPUT','A'].includes(control.tagName)};
}
async function hashOriginalImage(el,{form}){
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm/TraditionalApp'||window.top!==window.self||!el.isConnected||el.ownerDocument!==document||el.closest('form')!==form)throw Error('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');
 const u=new URL(el.currentSrc||el.src,location.href);
 if(u.origin!==location.origin||u.pathname!=='/Base/GetRandomCaptchaImage'||u.username||u.password||!el.complete||!el.naturalWidth||!el.naturalHeight||el.naturalWidth>2048||el.naturalHeight>2048||el.naturalWidth*el.naturalHeight>1000000)throw Error('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');
 const canvas=document.createElement('canvas');canvas.width=el.naturalWidth;canvas.height=el.naturalHeight;const context=canvas.getContext('2d');if(!context)throw Error('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');context.drawImage(el,0,0);
 const png=canvas.toDataURL('image/png');if(typeof png!=='string'||png.length>280000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(png))throw Error('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');
 const bytes=Uint8Array.from(atob(png.slice(22)),char=>char.charCodeAt(0));
 try{if(bytes.length<8||bytes.length>200000||![137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))throw Error('PORTAL_CAPTCHA_REFRESH_IMAGE_UNAVAILABLE');const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');}finally{bytes.fill(0);}
}
async function refreshPortalCaptcha(page,{signal,guard,timeoutMs=10000}={}){
 if(signal!==undefined&&typeof signal?.addEventListener!=='function'||guard!==undefined&&typeof guard!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw failure('PORTAL_CAPTCHA_REFRESH_INPUT_INVALID');
 let raw,control,image,form,started=false;
 const active=async()=>{if(signal?.aborted)throw failure('PORTAL_CAPTCHA_REFRESH_CANCELLED');let valid=false;try{const u=new URL(page.url());valid=u.origin===ORIGIN&&u.pathname===PATH&&!u.username&&!u.password;}catch{}if(!valid)throw failure('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');if(guard)await guard();if(signal?.aborted)throw failure('PORTAL_CAPTCHA_REFRESH_CANCELLED');};
 try{
  await active();raw=await page.evaluateHandle(inspectRefreshControl,{});
  control=(await raw.getProperty('control')).asElement();image=(await raw.getProperty('image')).asElement();form=await raw.getProperty('form');const keyboard=await raw.evaluate(record=>record.keyboard===true);
  if(!control||!image)throw failure('PORTAL_CAPTCHA_REFRESH_UNAVAILABLE');
  await active();await page.evaluate(inspectRefreshControl,{control,image,form});const previous=await image.evaluate(hashOriginalImage,{form});
  await active();await page.evaluate(inspectRefreshControl,{control,image,form});
  if(keyboard){await control.focus();if(await control.evaluate(el=>el.isConnected&&document.activeElement===el&&!el.disabled)!==true)throw failure('PORTAL_CAPTCHA_REFRESH_ACTIVATION_UNCONFIRMED');await active();await page.evaluate(inspectRefreshControl,{control,image,form});started=true;await control.press('Enter',{timeout:3000,noWaitAfter:true});}
  else {started=true;await control.click({timeout:3000,noWaitAfter:true});}
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<=deadline){
   await active();await page.evaluate(inspectRefreshControl,{control,image,form});
   let imageId=null;try{imageId=await image.evaluate(hashOriginalImage,{form});}catch{}
   if(Date.now()>deadline)break;
   if(typeof imageId==='string'&&/^[a-f0-9]{64}$/.test(imageId)&&imageId!==previous){await active();return {refreshed:true,imageId};}
   await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));
  }
  throw failure('PORTAL_CAPTCHA_REFRESH_TIMEOUT');
 }catch(error){if(signal?.aborted)throw failure('PORTAL_CAPTCHA_REFRESH_CANCELLED');const code=error?.code||Array.from(CODES).find(code=>String(error?.message||'').includes(code));throw failure(code||(started?'PORTAL_CAPTCHA_REFRESH_ACTIVATION_UNCONFIRMED':'PORTAL_CAPTCHA_REFRESH_UNAVAILABLE'));}
 finally{for(const handle of [control,image,form,raw])if(handle)await handle.dispose().catch(()=>{});}
}
module.exports={refreshPortalCaptcha,PORTAL_CAPTCHA_REFRESH_CODES:Object.freeze(Array.from(CODES))};
