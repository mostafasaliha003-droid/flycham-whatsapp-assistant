'use strict';
// Read-only main-document evidence. Never reads editable values, or returns page
// text, addresses, URLs, cookies, account identifiers or document contents.
function inspectAccountSignals(otpPresent=false){
 const result={officialHost:false,mainDocument:false,loginRoute:false,applicationsRoute:false,logoutPresent:false,myApplicationsPresent:false,logoutVisible:false,applicationsVisible:false,protectedApplicationsVisible:false,loginControlsVisible:false,otpPresent:otpPresent===true,accountUiVerified:false};
 try{
  result.officialHost=location.origin==='https://visa.mofa.gov.sa';
  result.mainDocument=window.top===window.self;
  result.loginRoute=/^\/Account\/(?:Loginindividuals|Login)(?:\/|$)/i.test(location.pathname);
  result.applicationsRoute=location.pathname==='/SmartForm'&&!location.search&&!location.hash;
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
  // An anonymous SmartForm GET redirects home. A protected list therefore needs
  // its exact route AND its observed public controls and table headings. Never
  // read case rows, editable values or account text to establish this proof.
  if(result.applicationsRoute&&result.logoutPresent&&result.applicationsVisible&&!result.loginControlsVisible&&!result.otpPresent){
   const proofVisible=el=>{const s=getComputedStyle(el);return visible(el)&&s.visibility!=='collapse'&&s.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
   const newLinks=Array.from(document.querySelectorAll('a[href]')).filter(el=>{
    const u=target(el);return el.tagName==='A'&&u&&!u.username&&!u.password&&u.pathname==='/SmartForm/Agreement'&&!u.search&&!u.hash&&proofVisible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&el.getAttribute('onclick')===null&&el.getAttribute('download')===null&&/^(?:إضافة طلب جديد|اضافة طلب جديد)$/i.test(caption(el));
   });
   if(newLinks.length){
    const header=value=>String(value||'').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
    const passportHeader=value=>/^(?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no)))(?: (?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no))))?$/.test(header(value));
    const referenceHeader=value=>/^(?:(?:رقم الطلب)|(?:application (?:number|no)))(?: (?:(?:رقم الطلب)|(?:application (?:number|no))))?$/.test(header(value));
    const tables=Array.from(document.querySelectorAll('table')).filter(proofVisible);let matchingTables=0,ambiguous=false;
    if(tables.length<=10)for(const table of tables){
     const rows=Array.from(table.rows||[]);if(rows.length>300){ambiguous=true;break;}let matchingHeaders=0;
     for(const row of rows){
      if(row.closest('table')!==table||!proofVisible(row))continue;const cells=Array.from(row.cells||[]);
      if(!cells.length||cells.length>40||!cells.every(cell=>cell.tagName==='TH'||row.parentElement?.tagName==='THEAD'))continue;
      if(cells.some(cell=>!proofVisible(cell)||(cell.colSpan||1)!==1||(cell.rowSpan||1)!==1))continue;
      const captions=cells.map(cell=>cell.textContent),passports=captions.flatMap((text,index)=>passportHeader(text)?[index]:[]),references=captions.flatMap((text,index)=>referenceHeader(text)?[index]:[]);
      if(passports.length===1&&references.length===1&&passports[0]!==references[0])matchingHeaders++;
     }
     if(matchingHeaders>1){ambiguous=true;break;}if(matchingHeaders===1)matchingTables++;
    }
    result.protectedApplicationsVisible=tables.length<=10&&!ambiguous&&matchingTables===1;
   }
  }
  result.accountUiVerified=result.officialHost&&result.mainDocument&&!result.loginRoute&&result.applicationsVisible&&(result.logoutVisible||result.logoutPresent&&result.applicationsRoute&&result.protectedApplicationsVisible)&&!result.loginControlsVisible&&!result.otpPresent;
 }catch{result.accountUiVerified=false;}
 return result;
}
async function getAccountSignals(page,otpPresent=false){
 const empty={officialHost:false,mainDocument:false,loginRoute:false,applicationsRoute:false,logoutPresent:false,myApplicationsPresent:false,logoutVisible:false,applicationsVisible:false,protectedApplicationsVisible:false,loginControlsVisible:false,otpPresent:otpPresent===true,accountUiVerified:false};
 try{
  const value=await page.evaluate(inspectAccountSignals,otpPresent===true);
  const added=new Set(['applicationsRoute','protectedApplicationsVisible']);
  if(!value||Object.keys(empty).some(key=>!added.has(key)&&typeof value[key]!=='boolean'))return empty;
  const out={};for(const key of Object.keys(empty))out[key]=typeof value[key]==='boolean'?value[key]:false;
  out.otpPresent=otpPresent===true||out.otpPresent;
  out.accountUiVerified=out.officialHost&&out.mainDocument&&!out.loginRoute&&out.applicationsVisible&&(out.logoutVisible||out.logoutPresent&&out.applicationsRoute&&out.protectedApplicationsVisible)&&!out.loginControlsVisible&&!out.otpPresent;
  return out;
 }catch{return empty;}
}
module.exports={inspectAccountSignals,getAccountSignals};
