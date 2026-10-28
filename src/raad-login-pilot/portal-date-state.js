'use strict';
// Date expectations belong to one government form and one application route.
const TRADITIONAL='/SmartForm/TraditionalApp';
const IDS=new Set(['PASSPORT_ISSUE_DATE','PASSPORT_EXPIRY_DATe','BIRTH_DATE','ExpectedEntryDate','TourismEVisaIqamaOrVisaExpiryDate']);
const health=path=>/^\/SmartForm\/HealthInsuranceInfo\/[0-9]{1,20}$/.test(path);
function createPortalDateState(){
 const forms=new Map();
 const validId=(path,id)=>path===TRADITIONAL?IDS.has(id):health(path)&&id==='ExpectedEntryDate';
 const stateFor=path=>{let state=forms.get(path);if(!state){state={pending:new Set(),dates:new Map()};forms.set(path,state);}return state;};
 return {
  begin(path,dates){if(!Array.isArray(dates))return;for(const date of dates)if(validId(path,date?.id))stateFor(path).pending.add(date.id);},
  complete(path,dates){const state=stateFor(path);for(const date of dates){if(!validId(path,date?.id))throw Error('PORTAL_DATES_DATE_UNCONFIRMED');state.dates.set(date.id,{id:date.id,isoDate:date.isoDate});state.pending.delete(date.id);}},
  submission(path){const state=forms.get(path),dates=Array.from(state?.dates.values()||[],date=>({...date}));return {pending:Boolean(state?.pending.size)||health(path)&&!dates.some(date=>date.id==='ExpectedEntryDate'),dates};}
 };
}
module.exports={createPortalDateState};
