'use strict';
const {getAccountSignals}=require('./account-signals');
const attemptedPages=new WeakSet();
// Structural main-document discovery only: no text, href, identity or values returned.
function findAccountMenuToggle(withCensus=false){
 const census={observed:false,logoutControls:0,observedToggles:0,associatedVisibleSafeToggles:0,ambiguous:false,legacyAssociations:0,bs5Associations:0,ariaAssociations:0};
 const finish=toggle=>withCensus?{toggle,census}:toggle;
 try{
  if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return finish(null);
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const enabled=el=>!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  const text=el=>String(el.textContent||'').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/\s+/g,' ').trim();
  const isLogout=el=>{try{let raw;if(el.tagName==='A')raw=el.getAttribute('href');else if(['BUTTON','INPUT'].includes(el.tagName)){const form=el.closest('form');raw=el.getAttribute('formaction')||(form&&form.getAttribute('action'))||location.href;}else if(el.getAttribute('role')==='button')raw=el.getAttribute('href')||location.href;if(!raw)return false;const u=new URL(raw,location.href);return u.origin===location.origin&&(/^(?:تسجيل الخروج|تسجيل خروج|خروج|logout|log out|sign out)$/i.test(text(el))||/(?:^|\/)(?:logout|logoff|signout)(?:\/|$)/i.test(u.pathname));}catch{return false;}};
  const marker=el=>el.getAttribute('data-toggle')==='dropdown'||el.getAttribute('data-bs-toggle')==='dropdown'||/^(?:true|menu)$/i.test(el.getAttribute('aria-haspopup')||'')||Boolean(el.getAttribute('aria-controls'))||['data-bs-target','data-target'].some(key=>/^#[A-Za-z0-9_:.-]{1,128}$/.test(el.getAttribute(key)||''))||el.matches('.dropdown-toggle');
  const safe=el=>{
   if(!['BUTTON','A'].includes(el.tagName)||!visible(el)||!enabled(el)||isLogout(el)||!marker(el))return false;
   if(el.getAttribute('onclick')||el.getAttribute('formaction')||el.form||el.closest('form'))return false;
   if(el.tagName==='BUTTON')return el.type==='button';
   const href=(el.getAttribute('href')||'').trim();return href==='#'||/^javascript:\s*(?:;|void\s*\(\s*0\s*\)\s*;?)$/i.test(href);
  };
  const logouts=Array.from(document.querySelectorAll('a,button,input[type="submit"],input[type="button"],[role="button"]')).filter(isLogout);
  const observed=new Set(Array.from(document.querySelectorAll('button,a')).filter(marker)),candidates=new Set();
  const add=el=>{observed.add(el);if(safe(el))candidates.add(el);};
  for(const logout of logouts){
   let scope=logout.parentElement;
   while(scope&&scope!==document.documentElement){
    if(scope.matches('.dropdown')){for(const el of scope.querySelectorAll('button,a'))if(marker(el))add(el);break;}
    scope=scope.parentElement;
   }
  }
  for(const el of observed){
   if(!safe(el))continue;
   const ids=String(el.getAttribute('aria-controls')||'').trim().split(/\s+/).filter(Boolean).slice(0,8);
   for(const attribute of ['data-bs-target','data-target']){const value=el.getAttribute(attribute)||'';if(/^#[A-Za-z0-9_:.-]{1,128}$/.test(value))ids.push(value.slice(1));}
   if(ids.some(id=>{if(id.length>128)return false;const target=document.getElementById(id);return target&&logouts.some(logout=>target.contains(logout));}))candidates.add(el);
  }
  census.observed=true;census.logoutControls=Math.min(logouts.length,16);census.observedToggles=Math.min(observed.size,32);census.associatedVisibleSafeToggles=Math.min(candidates.size,32);census.ambiguous=candidates.size>1;
  for(const el of candidates){if(el.getAttribute('data-toggle')==='dropdown')census.legacyAssociations=Math.min(census.legacyAssociations+1,32);if(el.getAttribute('data-bs-toggle')==='dropdown')census.bs5Associations=Math.min(census.bs5Associations+1,32);if(el.getAttribute('aria-controls')||/^(?:true|menu)$/i.test(el.getAttribute('aria-haspopup')||''))census.ariaAssociations=Math.min(census.ariaAssociations+1,32);}
  if(candidates.size!==1)return finish(null);
  const toggle=[...candidates][0],parts=[];for(let n=toggle;n&&n.nodeType===1;n=n.parentElement){let index=1;for(let s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===n.tagName)index++;parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+index+')');}
  const selector=parts.join(' > ')+':visible';if(selector.length>2048)return finish(null);
  return finish({selector,alreadyExpanded:toggle.getAttribute('aria-expanded')==='true'});
 }catch{return finish(null);}
}
async function activateAccountMenu(page){
 const result={attempted:false,opened:false,reason:'UNAVAILABLE',census:{observed:false,logoutControls:0,observedToggles:0,associatedVisibleSafeToggles:0,ambiguous:false,legacyAssociations:0,bs5Associations:0,ariaAssociations:0}};
 try{
  if(new URL(page.url()).origin!=='https://visa.mofa.gov.sa')return {...result,reason:'UNTRUSTED_PAGE'};
  if(attemptedPages.has(page))return {...result,reason:'ALREADY_ATTEMPTED'};
  const observation=await page.evaluate(findAccountMenuToggle,true),found=observation&&Object.hasOwn(observation,'toggle')?observation.toggle:observation;
  if(observation?.census){for(const key of ['observed','ambiguous'])result.census[key]=observation.census[key]===true;for(const key of ['logoutControls','observedToggles','associatedVisibleSafeToggles','legacyAssociations','bs5Associations','ariaAssociations']){const value=observation.census[key];result.census[key]=Number.isInteger(value)&&value>=0?Math.min(value,key==='logoutControls'?16:32):0;}}
  if(!found||typeof found.selector!=='string'||found.selector.length>2048)return {...result,reason:'TOGGLE_UNAVAILABLE'};
  if(found.alreadyExpanded===true)return {...result,opened:true,reason:'ALREADY_EXPANDED'};
  const locator=page.locator(found.selector);if(await locator.count()!==1||!await locator.isVisible()||!await locator.isEnabled())return {...result,reason:'TOGGLE_UNAVAILABLE'};
  const handle=await locator.elementHandle();if(!handle)return {...result,reason:'TOGGLE_UNAVAILABLE'};
  try{
   await handle.focus();
   const safe=await handle.evaluate(el=>el.isConnected&&document.activeElement===el&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&location.origin==='https://visa.mofa.gov.sa');
   if(!safe)return {...result,reason:'FOCUS_UNCONFIRMED'};
   result.attempted=true;attemptedPages.add(page);
   await handle.press('Enter',{noWaitAfter:true,timeout:3000});
   result.opened=await handle.evaluate(el=>el.isConnected&&el.getAttribute('aria-expanded')==='true').catch(()=>false);
   return {...result,reason:result.opened?'EXPANDED':'ACTIVATION_DISPATCHED'};
  }finally{await handle.dispose().catch(()=>{});}
 }catch{return {...result,reason:'INTERACTION_UNCONFIRMED'};}
}
async function openAccountMenu(page){
 const out=await activateAccountMenu(page);let trusted=false;try{trusted=new URL(page.url()).origin==='https://visa.mofa.gov.sa';}catch{}
 const signals=trusted?await getAccountSignals(page,false):{officialHost:false,mainDocument:false,loginRoute:false,logoutPresent:false,myApplicationsPresent:false,logoutVisible:false,applicationsVisible:false,loginControlsVisible:false,otpPresent:false,accountUiVerified:false};
 return {...out,signals};
}
module.exports={findAccountMenuToggle,openAccountMenu};
