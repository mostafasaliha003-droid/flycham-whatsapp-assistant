'use strict';
// A hint is never an identity assertion, document binding, or portal action.
// Discard arbitrary detector fields so OCR text can never reach durable state.
function safeOcrAdvisory(value,pages=[1,2]){
 if(!value||typeof value!=='object'||Array.isArray(value))return{status:'unavailable'};
 if(value.status==='matched'&&Number.isInteger(value.page)&&pages.includes(value.page)&&[0,90,180,270].includes(value.rotation))return{status:'matched',page:value.page,rotation:value.rotation};
 if(['ambiguous','not_found','timeout','unavailable'].includes(value.status))return{status:value.status};
 return{status:'unavailable'};
}
module.exports={safeOcrAdvisory};
