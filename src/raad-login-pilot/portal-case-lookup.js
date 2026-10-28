'use strict';
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm';
function failure(code){const error=new Error(code);error.code=code;return error;}
function inspectCases({passportNumber}){
 const empty=(headers=[])=>({lookupSupported:false,matchCount:0,matches:[],headers});
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm'||window.top!==window.self)throw Error('PORTAL_CASE_LOOKUP_UNTRUSTED_PAGE');
 const visible=el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return el.isConnected&&el.ownerDocument===document&&box.width>0&&box.height>0&&style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&style.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
 const bidi=/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
 const digits=text=>text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,char=>String(char.charCodeAt(0)-(char<='\u0669'?0x660:0x6f0)));
 const passport=text=>digits(String(text||'').normalize('NFKC')).replace(bidi,'').replace(/\s+/g,'').toUpperCase();
 const header=text=>String(text||'').normalize('NFKC').replace(bidi,'').replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
 const passportHeader=text=>/^(?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no)))(?: (?:(?:رقم (?:الجواز|جواز السفر|جواز))|(?:passport (?:number|no))))?$/.test(header(text));
 const referenceHeader=text=>/^(?:(?:رقم الطلب)|(?:application (?:number|no)))(?: (?:(?:رقم الطلب)|(?:application (?:number|no))))?$/.test(header(text));
 const continuationCaptions=new Set(['continue','continue application','continue request','resume','resume application','edit','edit application','editapplication','view','view application','complete','complete application','health insurance','health insurance info','health insurance information','healthinsuranceinfo','insurance','insurance info','insurance information','payment details','fee details','بيانات الدفع','تفاصيل الدفع','استكمال','استكمال الطلب','استكمال طلب','استكمال طلب التاشيرة','استكمال بيانات الطلب','استكمال بيانات التامين','استكمال بيانات التامين الصحي','اكمال الطلب','اكمال طلب التاشيرة','متابعة','متابعة الطلب','تعديل','تعديل الطلب','تعديل طلب','تعديل طلب التاشيرة','عرض','عرض الطلب','استعراض','استعراض الطلب','تفاصيل','التفاصيل','بيانات الطلب','التامين الصحي','بيانات التامين الصحي','معلومات التامين الصحي']);
 const continuationsFor=(row,table)=>{
  if(typeof row.querySelectorAll!=='function')return [];
  const anchors=Array.from(row.querySelectorAll('a[href]'));if(anchors.length>40)return [];
  const found=[],seen=new Set();
  for(const anchor of anchors){
   if(anchor.tagName!=='A'||anchor.namespaceURI!=='http://www.w3.org/1999/xhtml'||!visible(anchor)||anchor.closest('tr')!==row||anchor.closest('table')!==table||['action','data-action','formaction','onclick','download'].some(name=>anchor.hasAttribute(name)))continue;
   const raw=anchor.getAttribute('href');if(typeof raw!=='string'||!raw.trim()||raw.length>2048||/[?#]/.test(raw))continue;
   let target;try{target=new URL(raw,document.baseURI||location.href);}catch{continue;}
   if(target.origin!==location.origin||target.username||target.password||target.search||target.hash||!/^\/SmartForm\/(?:HealthInsuranceInfo|EditApplication|PayFee)\/[0-9]{1,20}$/.test(target.pathname))continue;
   const captions=[anchor.getAttribute('aria-label'),anchor.getAttribute('title'),anchor.textContent].map(value=>String(value||'').replace(bidi,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim());
   const caption=captions.find(value=>value.length<=80&&continuationCaptions.has(header(value)));
   if(caption===undefined&&captions.some(Boolean))continue;
   const payment=target.pathname.startsWith('/SmartForm/PayFee/');
   if(payment&&!['بيانات الدفع','تفاصيل الدفع','payment details','fee details'].includes(header(caption||'')))continue;
   if(seen.has(target.pathname))continue;seen.add(target.pathname);found.push({label:caption||'',path:target.pathname,...(payment?{kind:'payment_details'}:{})});if(found.length>8)return [];
  }
  return found;
 };
 const tables=Array.from(document.querySelectorAll('table')).filter(visible);
 if(tables.length>10)return empty();
 const candidates=[],labels=[];
 for(const table of tables){
  const rows=Array.from(table.rows||[]).filter(row=>row.closest('table')===table&&visible(row)),headers=[];
  for(const row of rows){
   const cells=Array.from(row.cells||[]);
   if(!cells.length||cells.length>40||!cells.every(cell=>cell.tagName==='TH'||row.parentElement?.tagName==='THEAD'))continue;
   if(cells.some(cell=>!visible(cell)))continue;
   const texts=cells.map(cell=>String(cell.textContent||'').replace(/\s+/g,' ').trim());
   for(const text of texts){const safe=text.length<=80&&!/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/i.test(text)&&!passport(text).includes(passportNumber)?text:null;if(safe&&labels.length<16&&!labels.includes(safe))labels.push(safe);}
   const passportColumns=texts.flatMap((text,index)=>passportHeader(text)?[index]:[]),referenceColumns=texts.flatMap((text,index)=>referenceHeader(text)?[index]:[]);
   if(passportColumns.length===1&&referenceColumns.length===1&&passportColumns[0]!==referenceColumns[0]&&cells.every(cell=>(cell.colSpan||1)===1&&(cell.rowSpan||1)===1))headers.push({row,count:cells.length,passportColumn:passportColumns[0],referenceColumn:referenceColumns[0]});
  }
  if(headers.length===1)candidates.push({table,rows,header:headers[0]});
  else if(headers.length>1)return empty(labels);
 }
 if(candidates.length!==1)return empty(labels);
 const {table,rows,header:columns}=candidates[0],bodyRows=rows.filter(row=>row!==columns.row&&row.parentElement?.tagName!=='THEAD'&&row.parentElement?.tagName!=='TFOOT');
 if(bodyRows.length>200)return empty(labels);
 let matchCount=0,invalidReference=false;const matches=[];
 for(const row of bodyRows){
  const cells=Array.from(row.cells||[]);
  // A conventional empty-grid message spans the entire table and has no case.
  if(cells.length===1&&(cells[0].colSpan||1)===columns.count)continue;
  if(cells.length!==columns.count||cells.some(cell=>(cell.colSpan||1)!==1||(cell.rowSpan||1)!==1))return {...empty(labels),matchCount,matches};
  const passportCell=cells[columns.passportColumn],referenceCell=cells[columns.referenceColumn];
  if(!visible(passportCell)||!visible(referenceCell))return {...empty(labels),matchCount,matches};
  if(passport(passportCell.textContent)!==passportNumber)continue;
  matchCount++;
  const reference=String(referenceCell.textContent||'').replace(bidi,'').trim();
  if(/^[A-Z]{0,3}[0-9]{3,20}$/.test(reference)){const continuations=continuationsFor(row,table);matches.push({applicationReference:reference,...(continuations.length?{continuations}:{})});}else invalidReference=true;
  if(matchCount===2)break;
 }
 return {lookupSupported:!invalidReference,matchCount,matches};
}
async function lookupPortalCases(page,input={}){
 let passportNumber;try{passportNumber=input?.passportNumber;if(typeof passportNumber!=='string'||!/^[A-Z0-9]{5,12}$/.test(passportNumber))throw Error();}catch{throw failure('PORTAL_CASE_LOOKUP_INPUT_INVALID');}
 try{const url=new URL(page.url());if(url.origin!==ORIGIN||url.pathname!==PATH)throw failure('PORTAL_CASE_LOOKUP_UNTRUSTED_PAGE');const result=await page.evaluate(inspectCases,{passportNumber});const current=new URL(page.url());if(current.origin!==ORIGIN||current.pathname!==PATH)throw failure('PORTAL_CASE_LOOKUP_UNTRUSTED_PAGE');return result;}
 catch(error){throw failure(String(error?.message||'').includes('PORTAL_CASE_LOOKUP_UNTRUSTED_PAGE')?'PORTAL_CASE_LOOKUP_UNTRUSTED_PAGE':'PORTAL_CASE_LOOKUP_UNAVAILABLE');}
}
module.exports={lookupPortalCases};
