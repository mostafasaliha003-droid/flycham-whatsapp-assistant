'use strict';
const {getAccountSignals}=require('./account-signals');
const attemptedPages=new WeakSet();
// Structural main-document discovery only: no text, href, identity or values returned.
function findAccountMenuToggle(){
 try{
  if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return null;
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const enabled=el=>!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  const text=el=>String(el.textContent||'').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/\s+/g,' ').trim();
  const isLogout=el=>{try{const raw=el.getAttribute('href');if(!raw)return false;const u=new URL(raw,location.href);return u.origin===location.origin&&(/^(?:تسجيل الخروج|تسجيل خروج|خروج|logout|log out|sign out)$/i.test(text(el))||/(?:^|\/)(?:logout|logoff|signout)(?:\/|$)/i.test(u.pathname));}catch{return false;}};
  const logouts=Array.from(document.querySelectorAll('a[href]')).filter(isLogout);if(logouts.length!==1)return null;
  let scope=logouts[0].parentElement;
  while(scope&&scope!==document.documentElement){
   if(scope.matches('.dropdown')){
    const toggles=Array.from(scope.querySelectorAll('button,a')).filter(el=>{
     if(!['BUTTON','A'].includes(el.tagName)||!visible(el)||!enabled(el)||isLogout(el)||!el.matches('[data-toggle="dropdown"],[aria-haspopup="true"],.dropdown-toggle'))return false;
     if(el.getAttribute('onclick')||el.getAttribute('formaction')||el.form||el.closest('form'))return false;
     if(el.tagName==='BUTTON')return el.type==='button';
     const href=(el.getAttribute('href')||'').trim();return href==='#'||/^javascript:\s*;$/i.test(href);
    });
    if(toggles.length!==1)return null;
    const toggle=toggles[0],parts=[];for(let n=toggle;n&&n.nodeType===1;n=n.parentElement){let index=1;for(let s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===n.tagName)index++;parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+index+')');}
    const selector=parts.join(' > ')+':visible';if(selector.length>2048)return null;
    return {selector,alreadyExpanded:toggle.getAttribute('aria-expanded')==='true'};
   }
   scope=scope.parentElement;
  }
 }catch{}
 return null;
}
async function activateAccountMenu(page){
 const result={attempted:false,opened:false,reason:'UNAVAILABLE'};
 try{
  if(new URL(page.url()).origin!=='https://visa.mofa.gov.sa')return {...result,reason:'UNTRUSTED_PAGE'};
  if(attemptedPages.has(page))return {...result,reason:'ALREADY_ATTEMPTED'};
  const found=await page.evaluate(findAccountMenuToggle);if(!found||typeof found.selector!=='string'||found.selector.length>2048)return {...result,reason:'TOGGLE_UNAVAILABLE'};
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
