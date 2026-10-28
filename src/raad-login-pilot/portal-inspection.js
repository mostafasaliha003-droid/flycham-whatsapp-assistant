'use strict';
// Read-only, top-document metadata only. Never returns field values, HTML,
// screenshots, frame contents, cookies, or credential/challenge information.
const ORIGIN='https://visa.mofa.gov.sa';
function official(value){try{const u=new URL(value);return u.origin===ORIGIN&&!u.username&&!u.password;}catch{return false;}}
async function inspectPortalPage(page){
 if(!page||typeof page.url!=='function'||typeof page.mainFrame!=='function'||typeof page.evaluate!=='function')throw Error('PORTAL_PAGE_UNAVAILABLE');
 const frame=page.mainFrame();if(!frame||typeof frame.url!=='function'||!official(page.url())||!official(frame.url()))throw Error('PORTAL_ORIGIN_INVALID');
 const result=await page.evaluate(()=>{
  if(location.origin!=='https://visa.mofa.gov.sa')throw Error('PORTAL_ORIGIN_INVALID');
  const text=(value,max=120)=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/[0-9٠-٩۰-۹]{6,}/g,'[number]').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'[id]').replace(/[A-Za-z0-9_-]{40,}/g,'[id]').replace(/[<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
  const safeAttr=value=>text(value,120);
  const safePath=value=>{try{const u=new URL(value,location.href);if(u.origin!==location.origin||u.username||u.password)return null;return text(u.pathname,240);}catch{return null;}};
  const visible=el=>{if(el.hidden||el.getAttribute('aria-hidden')==='true'||el.closest('[hidden],[aria-hidden="true"]'))return false;const style=getComputedStyle(el);return style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&el.getClientRects().length>0;};
  const caption=el=>{const copy=el.cloneNode(true);for(const child of Array.from(copy.querySelectorAll('input,textarea,select,button,script,style')))child.remove();return copy.textContent;};
  const visibleControl=el=>{if(visible(el))return true;if(el.tagName.toLowerCase()!=='select'||!/(?:^|\s)select2-hidden-accessible(?:\s|$)/.test(el.getAttribute('class')||''))return false;const id=el.getAttribute('id');if(!id)return false;const container=document.getElementById('select2-'+id+'-container');return Boolean(container&&visible(container));};
  const label=el=>{const associated=el.labels?Array.from(el.labels).map(caption).join(' '):'';return text(associated||el.getAttribute('aria-label')||'');};
  const selector=el=>{const id=el.getAttribute('id')||'';if(!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(id)||text(id)!==id)return null;const value='#'+CSS.escape(id);return document.querySelectorAll(value).length===1?value:null;};
  const sensitive=el=>{const type=(el.getAttribute('type')||'').toLowerCase(),meta=[el.getAttribute('id'),el.getAttribute('name'),el.getAttribute('autocomplete'),label(el)].filter(Boolean).join(' ');return ['hidden','password'].includes(type)||/password|passwd|captcha|recaptcha|verification|one.?time|otp|totp|two.?factor|security.?code|validation.?code|token|secret|csrf|nonce|authenticat|رمز\s*(?:التحقق|التأكيد|التفعيل|الصورة)|كلمة\s*(?:السر|المرور)/i.test(meta)||/^(?:txt)?(?:code|pwd)$/i.test(el.getAttribute('id')||'')||/^(?:txt)?(?:code|pwd)$/i.test(el.getAttribute('name')||'');};
  const publicSelect=el=>{const identity=el.getAttribute('id')||el.getAttribute('name')||'';return /^(?:VisaKind|EmbassyCode|PASSPORType|(?:ddl)?(?:Nationality|NationalityCode|Country|CountryCode|IssuingCountry|IssuingCountryCode|ResidenceCountry|ResidenceCountryCode|GccCountry|GccCountryCode|GccResidenceCountry|GccResidenceCountryCode|Sex|Gender|MaritalStatus|SocialStatus|Transport|ArrivalPort|VisitTimes|VisitDuration|VisaValid|Period|Occupation))$/i.test(identity)||/^(?:(?:health|insurance)[._])?(?:hospitalizedOrEmergency|accidentDisability|congenitalCondition)$/i.test(identity)||/(?:health|insurance|hospital|accident|disabil|congenital|medical)/i.test(identity)&&/(?:yes.?no|^(?:has|is|was)[_.]?|(?:condition|history|emergency)$)/i.test(identity);};
  const formMetadata=el=>{const form=el.form;if(!form)return {hasForm:false,formMethod:null,formActionPath:null};const method=String(form.method||form.getAttribute('method')||'get').toLowerCase();const action=typeof form.action==='string'?form.action:form.getAttribute('action')||location.href;return {hasForm:true,formMethod:['get','post'].includes(method)?method:null,formActionPath:safePath(action)};};
  const controls=[],buttons=[],links=[],headings=[],alerts=[];let optionBudget=500;
  for(const el of Array.from(document.querySelectorAll('input,select,textarea,button')).slice(0,1000)){
   if(controls.length>=100)break;if(!visibleControl(el)||sensitive(el))continue;
   const tag=el.tagName.toLowerCase(),rawType=String(el.getAttribute('type')||'').toLowerCase();
   const type=tag==='button'?(['button','submit','reset'].includes(rawType)?rawType:'submit'):tag==='input'?(['text','email','tel','number','date','datetime-local','month','week','time','url','file','checkbox','radio','range','color','button','submit','reset','search','image'].includes(rawType)?rawType:'text'):tag;
   const length=el.getAttribute('maxlength');const maxLength=length!==null&&/^\d{1,5}$/.test(length)&&Number(length)<=10000?Number(length):null;
   const item={tag,type,id:safeAttr(el.getAttribute('id')),name:safeAttr(el.getAttribute('name')),label:tag==='button'?text(caption(el)):tag==='input'&&['submit','button','reset'].includes(type)?text(el.getAttribute('value')):label(el),required:el.hasAttribute('required')||el.hasAttribute('data-val-required')||el.getAttribute('aria-required')==='true',disabled:Boolean(el.disabled),maxLength,accept:tag==='input'&&type==='file'?text(el.getAttribute('accept')):'',selector:selector(el),...formMetadata(el)};
   if(tag==='input'&&type==='file')item.multiple=Boolean(el.multiple);
   if(tag==='input'&&type==='radio'){const choice=el.getAttribute('value');if(/^(?:true|false|yes|no|0|1|M|F)$/.test(choice||''))item.publicChoice=choice;}
   if(tag==='select'&&publicSelect(el)&&optionBudget>0){item.options=[];for(const option of Array.from(el.options||[]).slice(0,300)){if(optionBudget<=0)break;const raw=option.getAttribute('value');if(raw!==null&&!/^(?:[0-9]{1,5}|[A-Za-z]{2,3}|true|false|)$/.test(raw))continue;const caption=text(option.textContent);if(!caption)continue;item.options.push({label:caption,...(raw!==null?{value:raw}:{})});optionBudget--;}}
   controls.push(item);if(tag==='button'||tag==='input'&&['submit','button','reset'].includes(type))buttons.push({tag,type,label:item.label,selector:item.selector,hasForm:item.hasForm,formMethod:item.formMethod,formActionPath:item.formActionPath});
  }
  for(const el of Array.from(document.querySelectorAll('a[href]')).slice(0,1000)){if(links.length>=80)break;if(!visible(el))continue;const path=safePath(el.getAttribute('href'));if(path===null)continue;links.push({path,label:text(caption(el)||el.getAttribute('aria-label')),selector:selector(el)});}
  for(const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0,100)){if(headings.length>=16)break;if(visible(el)){const value=text(caption(el));if(value)headings.push(value);}}
  for(const el of Array.from(document.querySelectorAll('.validation-summary-errors,.field-validation-error,.alert-danger,[role="alert"]')).slice(0,100)){if(alerts.length>=12)break;if(visible(el)){const value=text(caption(el));if(value)alerts.push(value);}}
  const result={path:safePath(location.href),headings,alerts,links,buttons,controls};
  if(['/SmartForm/Agreement','/SmartForm/ElectronicAgreement'].includes(location.pathname)){
   const root=document.querySelector('main')||document.body,parts=[];let visited=0,characters=0;
   const excluded=new Set(['HEADER','NAV','FOOTER','INPUT','SELECT','TEXTAREA','BUTTON','SCRIPT','STYLE','NOSCRIPT']);
   const blocks=new Set(['P','DIV','LI','UL','OL','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6','BR']);
   const visit=node=>{if(!node||++visited>20000||characters>=24000)return;if(node.nodeType===3){const value=String(node.textContent||'').slice(0,24000-characters);parts.push(value);characters+=value.length;return;}if(node.nodeType!==1||excluded.has(node.tagName))return;const style=getComputedStyle(node);if(node.hidden||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return;for(const child of Array.from(node.childNodes||[]))visit(child);if(blocks.has(node.tagName))parts.push(' ');};
   visit(root);result.agreementText=text(parts.join(''),8000);
  }
  return result;
 });
 if(!official(page.url())||!official(frame.url()))throw Error('PORTAL_ORIGIN_INVALID');
 return result;
}
module.exports={inspectPortalPage};
