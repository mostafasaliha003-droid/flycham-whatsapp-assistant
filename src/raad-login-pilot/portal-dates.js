'use strict';
const ORIGIN='https://visa.mofa.gov.sa',PATH='/SmartForm/TraditionalApp';
const IDS=new Set(['PASSPORT_ISSUE_DATE','PASSPORT_EXPIRY_DATe','BIRTH_DATE','ExpectedEntryDate','TourismEVisaIqamaOrVisaExpiryDate']);
const CODES=new Set(['PORTAL_DATES_INPUT_INVALID','PORTAL_DATES_UNTRUSTED_PAGE','PORTAL_DATES_FIELD_UNAVAILABLE','PORTAL_DATES_FORM_UNAVAILABLE','PORTAL_DATES_WIDGET_UNAVAILABLE','PORTAL_DATES_WIDGET_CHANGED','PORTAL_DATES_CALENDAR_UNSUPPORTED','PORTAL_DATES_FORMAT_UNAVAILABLE','PORTAL_DATES_DATE_UNCONFIRMED','PORTAL_DATES_BUSY']);
const workingPages=new WeakSet();
function failure(code,filledCount=0){const error=new Error(CODES.has(code)?code:'PORTAL_DATES_DATE_UNCONFIRMED');error.code=error.message;error.filledCount=filledCount;return error;}
function validateDates(dates){
 if(!Array.isArray(dates)||dates.length<1||dates.length>5)throw failure('PORTAL_DATES_INPUT_INVALID');
 const seen=new Set();
 return dates.map(date=>{
  if(!date||typeof date!=='object'||Array.isArray(date)||Object.keys(date).some(key=>!['id','isoDate'].includes(key))||!IDS.has(date.id)||seen.has(date.id)||typeof date.isoDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date.isoDate))throw failure('PORTAL_DATES_INPUT_INVALID');
  const [year,month,day]=date.isoDate.split('-').map(Number),leap=year%4===0&&(year%100!==0||year%400===0),lengths=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>lengths[month-1])throw failure('PORTAL_DATES_INPUT_INVALID');
  seen.add(date.id);return {id:date.id,year,month,day};
 });
}
function checkDateDocument(){return location.origin==='https://visa.mofa.gov.sa'&&location.pathname==='/SmartForm/TraditionalApp'&&window.top===window.self;}
// Browser-side validation and registered-widget APIs only. Retained records hold
// the original input, form and widget references; no selector is used to mutate.
function inspectDateWidgets({dates,records,mode='check',only}){
 const fail=code=>{throw Error(code);};
 if(location.origin!=='https://visa.mofa.gov.sa'||location.pathname!=='/SmartForm/TraditionalApp'||window.top!==window.self)fail('PORTAL_DATES_UNTRUSTED_PAGE');
 const $=window.jQuery;if(typeof $!=='function'||!$.fn)fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
 const visible=el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return rect.width>0&&rect.height>0&&style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&style.opacity!=='0'&&!el.closest('[hidden],[inert],[aria-hidden="true"]');};
 const actionOf=form=>{try{const raw=form.getAttribute('action'),u=new URL(raw||location.href,document.baseURI||location.href);return u.origin==='https://visa.mofa.gov.sa'&&u.pathname==='/SmartForm/TraditionalApp'&&!u.search&&!u.hash&&!u.username&&!u.password?u.href:null;}catch{return null;}};
 const formatterFor=(kind,wrapped,calendar)=>{
  const api=kind==='jquery-ui'?'datepicker':'calendarsPicker';
  let format=wrapped[api]('option','dateFormat');
  if(kind==='calendars-picker'&&(format===null||format===undefined))format=calendar.local?.dateFormat;
  const formatter=kind==='jquery-ui'?$.datepicker?.formatDate:calendar.formatDate;
  if(typeof format!=='string'||!format||format.length>100||typeof formatter!=='function')fail('PORTAL_DATES_FORMAT_UNAVAILABLE');
  const options={};
  for(const key of ['dayNamesShort','dayNames','monthNamesShort','monthNames','calculateWeek','shortYearCutoff']){
   const value=wrapped[api]('option',key);if(value!==undefined&&value!==null)options[key]=value;
  }
  return {format,options};
 };
 const bound=[];let sharedForm=null;
 for(let index=0;index<dates.length;index++){
  const date=dates[index],matches=Array.from(document.querySelectorAll('#'+CSS.escape(date.id)));
  if(matches.length!==1)fail('PORTAL_DATES_FIELD_UNAVAILABLE');
  const old=records?.[index],el=old?old.element:matches[0];
  if(!el||el!==matches[0]||!el.isConnected||el.ownerDocument!==document||el.namespaceURI!=='http://www.w3.org/1999/xhtml'||el.tagName!=='INPUT'||String(el.type).toLowerCase()!=='text'||!visible(el)||el.disabled||el.matches(':disabled')||el.getAttribute('aria-disabled')==='true')fail('PORTAL_DATES_FIELD_UNAVAILABLE');
  const form=el.form,action=form&&actionOf(form);
  if(!form||form.tagName!=='FORM'||!form.isConnected||form.ownerDocument!==document||String(form.method).toLowerCase()!=='post'||!action||sharedForm&&form!==sharedForm||old&&(form!==old.form||action!==old.action))fail('PORTAL_DATES_FORM_UNAVAILABLE');
  sharedForm=form;
  const wrapped=$(el),ui=wrapped.data('datepicker'),picker=wrapped.data('calendarsPicker');
  if(Boolean(ui)===Boolean(picker))fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
  let kind,registration,calendar=null;
  if(ui){
   if(typeof wrapped.datepicker!=='function'||!ui.input||ui.input[0]!==el||!ui.settings||typeof ui.settings!=='object')fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
   for(const candidate of [ui.calendar,ui.settings.calendar])if(candidate&&String(typeof candidate==='string'?candidate:candidate.name).toLowerCase()!=='gregorian')fail('PORTAL_DATES_CALENDAR_UNSUPPORTED');
   if(wrapped.datepicker('isDisabled')!==false)fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
   kind='jquery-ui';registration=ui;
  }else{
   if(typeof wrapped.calendarsPicker!=='function'||!(picker.target?.[0]===el||picker.elem?.[0]===el)||!picker.options||typeof picker.options!=='object')fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
   calendar=picker.options.calendar;
   if(!calendar||String(calendar.name).toLowerCase()!=='gregorian'||typeof calendar.newDate!=='function'||picker.options.rangeSelect||picker.options.multiSelect)fail('PORTAL_DATES_CALENDAR_UNSUPPORTED');
   if(wrapped.calendarsPicker('isDisabled')!==false)fail('PORTAL_DATES_WIDGET_UNAVAILABLE');
   kind='calendars-picker';registration=picker;
  }
  formatterFor(kind,wrapped,calendar);
  if(old&&(old.registration!==registration||old.kind!==kind||old.calendar!==calendar))fail('PORTAL_DATES_WIDGET_CHANGED');
  bound.push(old||{element:el,form,action,registration,kind,calendar});
 }
 if(mode==='bind')return bound;
 const matchesDate=(record,date)=>{
  const wrapped=$(record.element),formatting=formatterFor(record.kind,wrapped,record.calendar);let picked,serialized;
  if(record.kind==='jquery-ui'){
   picked=wrapped.datepicker('getDate');
   if(!(picked instanceof Date)||Number.isNaN(picked.getTime())||picked.getFullYear()!==date.year||picked.getMonth()+1!==date.month||picked.getDate()!==date.day)return false;
   serialized=$.datepicker.formatDate(formatting.format,picked,formatting.options);
  }else{
   const selected=wrapped.calendarsPicker('getDate');if(!Array.isArray(selected)||selected.length!==1)return false;
   picked=selected[0];
   if(!picked||typeof picked.year!=='function'||typeof picked.month!=='function'||typeof picked.day!=='function'||typeof picked.calendar!=='function'||picked.calendar()!==record.calendar||picked.year()!==date.year||picked.month()!==date.month||picked.day()!==date.day)return false;
   serialized=record.calendar.formatDate(formatting.format,picked,formatting.options);
  }
  // Compare the actual submitted text privately with the registered formatter.
  // Neither the input text nor the formatted date is returned to the caller.
  return typeof serialized==='string'&&serialized.length>0&&serialized.length<=300&&record.element.value===serialized;
 };
 if(mode==='verify')return bound.every((record,index)=>matchesDate(record,dates[index]));
 if(mode==='set'){
  if(!Number.isInteger(only)||only<0||only>=bound.length)fail('PORTAL_DATES_INPUT_INVALID');
  const record=bound[only],date=dates[only],wrapped=$(record.element);
  if(record.kind==='jquery-ui'){
   const requested=new Date(date.year,date.month-1,date.day);if(date.year<100)requested.setFullYear(date.year);
   wrapped.datepicker('setDate',requested);
  }else wrapped.calendarsPicker('setDate',[record.calendar.newDate(date.year,date.month,date.day)]);
  if(!matchesDate(record,date))fail('PORTAL_DATES_DATE_UNCONFIRMED');
  record.element.dispatchEvent(new Event('change',{bubbles:true}));
  if(!record.element.isConnected||record.element.ownerDocument!==document||!matchesDate(record,date))fail('PORTAL_DATES_DATE_UNCONFIRMED');
 }
 return true;
}
async function assertOfficial(page){let trusted=false;try{const u=new URL(page.url());trusted=u.origin===ORIGIN&&u.pathname===PATH&&await page.evaluate(checkDateDocument)===true;}catch{}if(!trusted)throw failure('PORTAL_DATES_UNTRUSTED_PAGE');}
async function operateDates(page,input,write){
 let dates;try{dates=validateDates(input?.dates);}catch{throw failure('PORTAL_DATES_INPUT_INVALID');}
 if(!page||typeof page.evaluate!=='function'||typeof page.evaluateHandle!=='function')throw failure('PORTAL_DATES_UNTRUSTED_PAGE');
 if(workingPages.has(page))throw failure('PORTAL_DATES_BUSY');
 workingPages.add(page);let records,filledCount=0;
 try{
  await assertOfficial(page);records=await page.evaluateHandle(inspectDateWidgets,{dates,mode:'bind'});
  await page.evaluate(inspectDateWidgets,{dates,records,mode:'check'});
  if(write)for(let only=0;only<dates.length;only++){
   await assertOfficial(page);
   await page.evaluate(inspectDateWidgets,{dates,records,mode:'set',only});
   await assertOfficial(page);filledCount++;
  }
  await assertOfficial(page);const verified=await page.evaluate(inspectDateWidgets,{dates,records,mode:'verify'})===true;await assertOfficial(page);
  if(!write)return verified;
  if(!verified)throw failure('PORTAL_DATES_DATE_UNCONFIRMED');
  return {filledCount,ids:dates.map(date=>date.id)};
 }catch(error){const code=Array.from(CODES).find(item=>String(error?.message||'').includes(item))||'PORTAL_DATES_DATE_UNCONFIRMED';throw failure(code,filledCount);}
 finally{workingPages.delete(page);if(records)await records.dispose().catch(()=>{});}
}
async function setPortalDates(page,input={}){return operateDates(page,input,true);}
async function verifyPortalDates(page,input={}){try{return await operateDates(page,input,false)===true;}catch{return false;}}
module.exports={setPortalDates,verifyPortalDates};
