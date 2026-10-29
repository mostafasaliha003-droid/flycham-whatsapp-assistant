'use strict';
// Read-only main-document evidence. Never reads editable values, or returns page
// text, addresses, URLs, cookies, account identifiers or document contents.
function inspectAccountSignals(otpPresent=false){
 const result={officialHost:false,mainDocument:false,loginRoute:false,logoutPresent:false,myApplicationsPresent:false,logoutVisible:false,applicationsVisible:false,loginControlsVisible:false,otpPresent:otpPresent===true,accountUiVerified:false};
 try{
  result.officialHost=location.origin==='https://visa.mofa.gov.sa';
  result.mainDocument=window.top===window.self;
  result.loginRoute=/^\/Account\/(?:Loginindividuals|Login)(?:\/|$)/i.test(location.pathname);
  if(!result.officialHost||!result.mainDocument||result.loginRoute)return result;
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const caption=el=>String(el.tagName==='INPUT'?el.getAttribute('value')||'':el.textContent||'').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/\s+/g,' ').trim();
  const target=el=>{
   const tag=el.tagName;
   
   let raw;
   if(tag==='A'){raw=el.getAttribute('href');if(!raw)return null;}
   else if(tag==='BUTTON'||tag==='INPUT'){
    const form=el.closest('form');raw=el.getAttribute('formaction')||(form&&form.getAttribute('action'))||location.href;
   }else if(el.getAttribute('role')==='button'){raw=el.getAttribute('href')||location.href;}
   else return null;
   try{const u=new URL(raw,location.href);return u.origin===location.origin?u:null;}catch{return null;}
  };
  result.loginControlsVisible=Array.from(document.querySelectorAll('#myform #UserName,#myform #Password,#NafathID,input[type="password"]')).some(visible);
  for(const el of document.querySelectorAll('a,button,input[type="submit"],input[type="button"],[role="button"]')){
   const u=target(el);if(!u)continue;const text=caption(el);
   const isLogout=/^(?:تسجيل الخروج|تسجيل خروج|خروج|logout|log out|sign out)$/i.test(text)||/(?:^|\/)(?:logout|logoff|signout)(?:\/|$)/i.test(u.pathname);
   const isApplications=/^(?:طلباتي|my applications)$/i.test(text)||el.tagName==='A'&&/^\/SmartForm\/?$/.test(u.pathname)&&!u.search&&!u.hash;
   if(isLogout)result.logoutPresent=true;if(isApplications)result.myApplicationsPresent=true;
   const actionable=visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';
   if(actionable&&isLogout)result.logoutVisible=true;
   if(actionable&&isApplications)result.applicationsVisible=true;
  }
  result.accountUiVerified=result.officialHost&&result.mainDocument&&!result.loginRoute&&result.logoutVisible&&result.applicationsVisible&&!result.loginControlsVisible&&!result.otpPresent;
 }catch{result.accountUiVerified=false;}
 return result;
}
async function getAccountSignals(page,otpPresent=false){
 const empty={officialHost:false,mainDocument:false,loginRoute:false,logoutPresent:false,myApplicationsPresent:false,logoutVisible:false,applicationsVisible:false,loginControlsVisible:false,otpPresent:otpPresent===true,accountUiVerified:false};
 try{
  const value=await page.evaluate(inspectAccountSignals,otpPresent===true);
  if(!value||Object.keys(empty).some(key=>typeof value[key]!=='boolean'))return empty;
  const out={};for(const key of Object.keys(empty))out[key]=value[key];
  out.otpPresent=otpPresent===true||out.otpPresent;
  out.accountUiVerified=out.officialHost&&out.mainDocument&&!out.loginRoute&&out.logoutVisible&&out.applicationsVisible&&!out.loginControlsVisible&&!out.otpPresent;
  return out;
 }catch{return empty;}
}
module.exports={inspectAccountSignals,getAccountSignals};
