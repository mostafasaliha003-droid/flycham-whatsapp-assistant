'use strict';
const {createHash}=require('node:crypto');
const {lookupPortalCases}=require('./portal-case-lookup');
const ORIGIN='https://visa.mofa.gov.sa',MAX_PDF=10000000;
const CODES=new Set(['PORTAL_PRINT_INPUT_INVALID','PORTAL_PRINT_UNTRUSTED_PAGE','PORTAL_PRINT_CASE_UNVERIFIED','PORTAL_PRINT_LINK_UNAVAILABLE','PORTAL_PRINT_PASSPORT_MISMATCH','PORTAL_PRINT_PDF_INVALID','PORTAL_PRINT_CANCELLED','PORTAL_PRINT_UNAVAILABLE']);
const finite=code=>Object.assign(new Error(CODES.has(code)?code:'PORTAL_PRINT_UNAVAILABLE'),{code:CODES.has(code)?code:'PORTAL_PRINT_UNAVAILABLE'});
function trustedDocument(path){return location.origin==='https://visa.mofa.gov.sa'&&location.pathname===path&&!location.search&&!location.hash&&window.top===window.self;}
function observedPrintLink(args){
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm'||window.top!==window.self)return null;
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return el.isConnected&&el.ownerDocument===document&&r.width>0&&r.height>0&&s.display!=='none'&&!['hidden','collapse'].includes(s.visibility)&&s.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
 const clean=value=>String(value||'').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'');
 const pass=value=>clean(value).replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)-(c<='\u0669'?0x660:0x6f0))).replace(/\s+/g,'').toUpperCase();
 const heading=value=>clean(value).replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
 const isPassport=value=>/^(?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no)))(?: (?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no))))?$/.test(heading(value));
 const isReference=value=>/^(?:(?:رقم الطلب)|(?:application (?:number|no)))(?: (?:(?:رقم الطلب)|(?:application (?:number|no))))?$/.test(heading(value));
 const tables=Array.from(document.querySelectorAll('table')).filter(visible),owned=[];if(tables.length>10)return null;
 for(const table of tables){const rows=Array.from(table.rows||[]).filter(row=>row.closest('table')===table&&visible(row));if(rows.length>201)return null;const heads=[];
  for(const row of rows){const cells=Array.from(row.cells||[]);if(!cells.length||cells.length>40||!cells.every(cell=>(cell.tagName==='TH'||row.parentElement?.tagName==='THEAD')&&visible(cell)&&(cell.colSpan||1)===1&&(cell.rowSpan||1)===1))continue;const p=cells.flatMap((c,i)=>isPassport(c.textContent)?[i]:[]),r=cells.flatMap((c,i)=>isReference(c.textContent)?[i]:[]);if(p.length===1&&r.length===1&&p[0]!==r[0])heads.push({row,p:p[0],r:r[0],count:cells.length});}
  if(heads.length!==1)continue;const h=heads[0];for(const row of rows){if(row===h.row||['THEAD','TFOOT'].includes(row.parentElement?.tagName))continue;const cells=Array.from(row.cells||[]);if(cells.length!==h.count||cells.some(c=>(c.colSpan||1)!==1||(c.rowSpan||1)!==1))continue;if(visible(cells[h.p])&&visible(cells[h.r])&&pass(cells[h.p].textContent)===args.passportNumber&&clean(cells[h.r].textContent).trim()===args.applicationReference)owned.push({row,table});}
 }
 if(owned.length!==1)return null;const {row,table}=owned[0],links=[];const anchors=Array.from(row.querySelectorAll('a[href]'));if(anchors.length>40)return null;
 for(const anchor of anchors){if(anchor.tagName!=='A'||anchor.namespaceURI!=='http://www.w3.org/1999/xhtml'||!visible(anchor)||anchor.closest('tr')!==row||anchor.closest('table')!==table||['onclick','action','data-action','formaction','download'].some(a=>anchor.hasAttribute(a)))continue;const href=anchor.getAttribute('href');if(typeof href!=='string'||href.length>2048||/[?#]/.test(href))continue;let u;try{u=new URL(href,document.baseURI||location.href);}catch{continue;}const m=u.pathname.match(/^\/SmartForm\/(PrintApplication|EditApplication)\/[0-9]{1,20}$/);if(u.origin!==location.origin||u.username||u.password||u.search||u.hash||!m)continue;links.push({anchor,row,table,href:u.href,path:u.pathname,mode:m[1]==='PrintApplication'?'print':'edit'});}
 const primary=links.filter(link=>link.mode==='print'),eligible=primary.length?primary:links.filter(link=>link.mode==='edit'),unique=new Map(eligible.map(link=>[link.href,link]));if(unique.size!==1)return null;const selected=Array.from(unique.values())[0];if(args.anchor&&(selected.anchor!==args.anchor||selected.row!==args.row||selected.table!==args.table||selected.href!==args.href))return null;return args.anchor?true:selected;
}
function savedEditorMatches({path,passportNumber}){
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!==path||window.top!==window.self)return false;
 const all=Array.from(document.querySelectorAll('#PASSPORTnumber'));if(all.length!==1)return false;const el=all[0];
 if(!el.isConnected||el.ownerDocument!==document||el.tagName!=='INPUT'||!['text','tel'].includes(el.type)||!el.form)return false;
 const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height||s.display==='none'||['hidden','collapse'].includes(s.visibility)||el.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
 try{const action=new URL(el.form.getAttribute('action')||location.href,document.baseURI||location.href);if(action.origin!==location.origin||action.username||action.password)return false;}catch{return false;}
 return String(el.value||'').normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\s]/g,'').toUpperCase()===passportNumber;
}
function escaped(value){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function captureApplicationPdf(page,input={}){
 let applicationReference,passportNumber,guard,signal;try{({applicationReference,passportNumber,guard,signal}=input);if(typeof applicationReference!=='string'||! /^[A-Z]{0,3}[0-9]{3,20}$/.test(applicationReference)||typeof passportNumber!=='string'||! /^[A-Z0-9]{5,12}$/.test(passportNumber)||guard!==undefined&&typeof guard!=='function'||signal!==undefined&&typeof signal?.addEventListener!=='function')throw Error();}catch{throw finite('PORTAL_PRINT_INPUT_INVALID');}
 let raw,anchor,row,table,buffer;
 const active=async path=>{if(signal?.aborted)throw finite('PORTAL_PRINT_CANCELLED');if(guard)await guard();if(signal?.aborted)throw finite('PORTAL_PRINT_CANCELLED');let safe=false;try{const u=new URL(page.url()),main=page.mainFrame();safe=u.origin===ORIGIN&&u.pathname===path&&!u.username&&!u.password&&!u.search&&!u.hash&&main&&main.url()===page.url()&&await page.evaluate(trustedDocument,path)===true;}catch{}if(!safe)throw finite('PORTAL_PRINT_UNTRUSTED_PAGE');};
 try{
  await active('/SmartForm');const lookup=await lookupPortalCases(page,{passportNumber});if(!lookup.lookupSupported||(lookup.matches||[]).filter(item=>item.applicationReference===applicationReference).length!==1)throw finite('PORTAL_PRINT_CASE_UNVERIFIED');await active('/SmartForm');
  raw=await page.evaluateHandle(observedPrintLink,{applicationReference,passportNumber});const info=await raw.evaluate(value=>value?{href:value.href,path:value.path,mode:value.mode}:null);if(!info)throw finite('PORTAL_PRINT_LINK_UNAVAILABLE');
  anchor=await raw.getProperty('anchor');row=await raw.getProperty('row');table=await raw.getProperty('table');
  const target=new URL(info.href);if(target.origin!==ORIGIN||target.pathname!==info.path||target.search||target.hash||target.username||target.password||!/^\/SmartForm\/(?:PrintApplication|EditApplication)\/[0-9]{1,20}$/.test(target.pathname))throw finite('PORTAL_PRINT_LINK_UNAVAILABLE');
  await active('/SmartForm');if(await page.evaluate(observedPrintLink,{applicationReference,passportNumber,anchor,row,table,href:info.href})!==true)throw finite('PORTAL_PRINT_LINK_UNAVAILABLE');
  await active('/SmartForm');await page.goto(info.href,{waitUntil:'domcontentloaded',timeout:30000});await active(info.path);
  if(info.mode==='edit'&&await page.evaluate(savedEditorMatches,{path:info.path,passportNumber})!==true)throw finite('PORTAL_PRINT_PASSPORT_MISMATCH');
  const caption=input.manualCompletion===true?'نسخة الطلب المحفوظ':'نسخة الطلب المحفوظ — الرسوم الحكومية غير مدفوعة',ref=escaped(applicationReference),template='<div style="width:100%;font-family:Arial,sans-serif;font-size:9px;text-align:center;direction:rtl">'+caption+' — '+ref+'</div>';
  await active(info.path);buffer=await page.pdf({format:'A4',printBackground:true,displayHeaderFooter:true,headerTemplate:template,footerTemplate:template,margin:{top:'18mm',bottom:'18mm',left:'12mm',right:'12mm'}});await active(info.path);
  if(info.mode==='edit'&&await page.evaluate(savedEditorMatches,{path:info.path,passportNumber})!==true)throw finite('PORTAL_PRINT_PASSPORT_MISMATCH');
  if(!Buffer.isBuffer(buffer)||buffer.length<8||buffer.length>MAX_PDF||buffer.subarray(0,5).toString('ascii')!=='%PDF-')throw finite('PORTAL_PRINT_PDF_INVALID');
  return {buffer,mimeType:'application/pdf',sha256:createHash('sha256').update(buffer).digest('hex'),byteLength:buffer.length,documentKind:'application',applicationReference};
 }catch(error){if(buffer&&typeof buffer.fill==='function')buffer.fill(0);if(signal?.aborted)throw finite('PORTAL_PRINT_CANCELLED');throw finite(error?.code);}
 finally{for(const handle of [anchor,row,table,raw])if(handle)await handle.dispose().catch(()=>{});passportNumber='';}
}
module.exports={captureApplicationPdf};
