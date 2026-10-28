'use strict';
const ORIGIN='https://visa.mofa.gov.sa';
// Keep this sanitizer aligned with the read-only inspection representation.
function safeObservedLabel(text){return String(text||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[0-9\u0660-\u0669\u06f0-\u06f9]{6,}/g,'[number]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);}
function inspectObservedNavigation({path,label}){
 try{
  if(location.origin!=='https://visa.mofa.gov.sa'||window.top!==window.self)return null;
  const safe=text=>String(text||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[0-9\u0660-\u0669\u06f0-\u06f9]{6,}/g,'[number]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  const visible=el=>{if(el.hidden||el.getAttribute('aria-hidden')==='true'||el.closest('[hidden],[aria-hidden="true"]'))return false;const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&el.getClientRects().length>0;};
  const blocked=/(?:delete|logout|logoff|signout|payment|pay|cancel|remove|support|privacy|terms|contact|register|forgotpassword|حذف|خروج|إلغاء|الغاء|دفع|سداد|تسديد|شراء|الدعم|الخصوصية)/i;
  const actionPath=/(?:^|\/)(?:(?:save|submit|confirm|accept|approve|pay|cancel|delete)[^/]*|agree)(?:\/|$)/i;
  const actionLabel=/^(?:save|submit|confirm|accept|approve|agree|حفظ|إرسال|ارسال|تأكيد|تاكيد|موافق|اعتماد)(?:\s|$)/i;
  const service=/(?:service|apply|application|visa|request|tourism|new|back|خدم|تقديم|طلب|تأشير|تاشير|سياح|جديد|عودة|رجوع)/i;
  const matches=[];
  for(const el of document.querySelectorAll('a[href]')){
   if(!visible(el)||el.getAttribute('aria-disabled')==='true'||el.hasAttribute('onclick')||el.hasAttribute('download'))continue;
   const raw=(el.getAttribute('href')||'').trim();if(!raw||raw.startsWith('#')||/^(?:javascript|data):/i.test(raw))continue;
   const u=new URL(raw,location.href),copy=el.cloneNode(true);for(const node of copy.querySelectorAll('input,textarea,select,button,script,style'))node.remove();const caption=safe(copy.textContent||el.getAttribute('aria-label'));
   if(u.origin!==location.origin||u.protocol!=='https:'||u.username||u.password||u.pathname!==path||caption!==label)continue;
   const unsafeQuery=Array.from(u.searchParams.keys()).some(key=>/^(?:action|operation|command|delete|pay|cancel|logout|submit|save)$/i.test(key))||Array.from(u.searchParams.values()).some(value=>/delete|logout|logoff|signout|payment|pay|cancel|remove|submit|save|confirm|accept|approve|حذف|خروج|إلغاء|الغاء|دفع|سداد|تسديد|حفظ|إرسال|ارسال|تأكيد|تاكيد/i.test(value));
   const relevant=(u.pathname+' '+caption).normalize('NFKC');
   if(unsafeQuery||blocked.test(relevant)||actionPath.test(u.pathname)||actionLabel.test(caption.normalize('NFKC'))||!service.test(relevant))continue;
   matches.push(u.href);
  }
  const targets=[...new Set(matches)];return targets.length===1?{href:targets[0]}:null;
 }catch{return null;}
}
async function navigateObservedLink(page,{path,label}={}){
 if(typeof path!=='string'||path.length<2||path.length>240||!/^\/[A-Za-z0-9/_-]+$/.test(path)||path.startsWith('//')||typeof label!=='string'||!label||label.length>120||safeObservedLabel(label)!==label)throw Error('NAVIGATION_INPUT_INVALID');
 try{
  const main=page.mainFrame(),before=new URL(page.url());if(!main||main.url()!==page.url()||before.origin!==ORIGIN||before.username||before.password)throw Error('UNTRUSTED_PAGE');
  const selected=await page.evaluate(inspectObservedNavigation,{path,label});
  if(!selected||typeof selected.href!=='string'||selected.href.length>8192)throw Error('LINK_UNAVAILABLE');
  const target=new URL(selected.href);if(target.origin!==ORIGIN||target.pathname!==path||target.username||target.password)throw Error('LINK_UNAVAILABLE');
  await page.goto(selected.href,{waitUntil:'domcontentloaded',timeout:30000});
  const after=new URL(page.url());if(after.origin!==ORIGIN||after.username||after.password)throw Error('UNTRUSTED_PAGE');
  return {opened:true,path:after.pathname};
 }catch{throw Error('PORTAL_NAVIGATION_UNAVAILABLE');}
}
module.exports={safeObservedLabel,inspectObservedNavigation,navigateObservedLink};
