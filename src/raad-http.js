'use strict';
const {validCustomer}=require('./conversation-journal');
const {parseTD3MRZ}=require('./raad-document-validation');
const {buildMofaPreview}=require('./raad-mofa-preview');
const {preparePortalImage,prepareResidenceImage}=require('./raad-attachments');
const ERROR_STATUS={INVALID_CUSTOMER:400,CONVERSATION_NOT_FOUND:404,INVALID_RAAD_ACTION:400,INVALID_RAAD_BODY:400,INVALID_APPLICANT_INDEX:400,CLAIM_REQUIRED:409,VISA_CASE_NOT_FOUND:404,MEDIA_NOT_FOUND:404,MEDIA_CAPACITY_REACHED:409,MEDIA_STORAGE_UNAVAILABLE:503,MEDIA_INVALID:400,MEDIA_CONTENT_INVALID:400,PDF_NEEDS_RASTER_CONVERSION:422,INVALID_IMAGE:422,INVALID_IMAGE_KIND:422,IMAGE_TOO_LARGE:422,IMAGE_TOO_SMALL:422,SIZE_LIMIT_UNACHIEVABLE:422,RAAD_PREPARATION_BUSY:409};
// Short-lived in-process mutex: image work must not compete for the small web
// instance's memory, or race a second edit of the same document review.
let imageBusy=false;
async function handleRaadRequest(request,response,url,{readBody,workflow,inbox,mediaStore,provider}={}){
 const providerStatus=url.pathname==='/internal/assistant/raad-provider',providerCheck=url.pathname==='/internal/assistant/raad-provider/check';
 if(!providerStatus&&!providerCheck&&!url.pathname.startsWith('/internal/assistant/raad/'))return false;
 const reply=(status,data)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));};
 // The server authenticates these global configuration routes before dispatch.
 // No customer data, request body, URL override or credentials enter the check.
 if(providerStatus||providerCheck){
  if(request.method!==(providerStatus?'GET':'POST')){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
  try{const method=providerStatus?'status':'check';if(typeof provider?.[method]!=='function')throw Error('PROVIDER_UNAVAILABLE');reply(200,await provider[method]());}
  catch{reply(503,{ok:false,error:'RAAD_PROVIDER_UNAVAILABLE'});}return true;
 }
 try{
  const raw=url.pathname.slice('/internal/assistant/raad/'.length);let customer;try{customer=decodeURIComponent(raw);}catch{throw Error('INVALID_CUSTOMER');}if(!validCustomer(customer))throw Error('INVALID_CUSTOMER');inbox.requireCustomer(customer);
  const indexValue=url.searchParams.get('applicantIndex')??'0',index=Number(indexValue);if(!/^\d{1,2}$/.test(indexValue)||!Number.isInteger(index)||index<0||index>29)throw Error('INVALID_APPLICANT_INDEX');
  if(request.method==='GET'){reply(200,workflow.get(customer,{applicantIndex:index}));return true;}
  if(request.method!=='POST'){reply(405,{error:'METHOD_NOT_ALLOWED'});return true;}
  if(!inbox.isOperatorOwned(customer))throw Error('CLAIM_REQUIRED');
  const bytes=await readBody(request);if(bytes.length>100000)throw Error('INVALID_RAAD_BODY');let body;try{body=JSON.parse(bytes.toString('utf8'));}catch{throw Error('INVALID_RAAD_BODY');}if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_RAAD_BODY');
  if(!inbox.isOperatorOwned(customer))throw Error('CLAIM_REQUIRED');
  const applicantIndex=body.applicantIndex??index;if(!Number.isInteger(applicantIndex)||applicantIndex<0||applicantIndex>29)throw Error('INVALID_APPLICANT_INDEX');
  if(body.action==='parse_mrz'){
   if(typeof body.mrz!=='string'||body.mrz.length>300)throw Error('INVALID_RAAD_BODY');
   const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value])),referenceDate=parts.year+'-'+parts.month+'-'+parts.day;
   const parsed=parseTD3MRZ(body.mrz,{referenceDate,confirmedBirthDate:body.confirmedBirthDate,confirmedExpiryDate:body.confirmedExpiryDate});
   reply(200,parsed);return true;
  }
  if(body.action==='prepare_image'){
   if(imageBusy)throw Error('RAAD_PREPARATION_BUSY');if(body.confirm!==true||!['passport','residence','photo'].includes(body.kind)||!Array.isArray(body.sourceIds)||body.sourceIds.length<1||body.sourceIds.length>2||new Set(body.sourceIds).size!==body.sourceIds.length||body.kind!=='residence'&&body.sourceIds.length!==1)throw Error('INVALID_RAAD_BODY');
   imageBusy=true;try{const parts=body.sourceIds.map(id=>{const {metadata,bytes}=mediaStore.read(id,{customer});return{bytes,mimeType:metadata.mimeType};});
    const prepared=body.kind==='residence'?await prepareResidenceImage(parts):await preparePortalImage(parts[0].bytes,{mimeType:parts[0].mimeType,kind:body.kind==='photo'?'portrait':'document'});
    // Ownership may have changed while Sharp decoded/resized the input.
    if(!inbox.isOperatorOwned(customer))throw Error('CLAIM_REQUIRED');
    const media=mediaStore.storeDerived(customer,{sourceIds:body.sourceIds,bytes:prepared.bytes,mimeType:prepared.mimeType,kind:body.kind});reply(200,{ok:true,media,needsVisualReview:true,transformations:prepared.transformations});return true;
   }finally{imageBusy=false;}
  }
  if(body.action==='preview_mapping'){
   const draft=workflow.get(customer,{applicantIndex});
   if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==draft.revision)throw Object.assign(Error('RAAD_REVISION_CONFLICT'),{code:'RAAD_REVISION_CONFLICT',statusCode:409});
   reply(200,buildMofaPreview(draft));return true;
  }
  if(!['prepare','review'].includes(body.action))throw Error('INVALID_RAAD_ACTION');
  const result=body.action==='prepare'?workflow.prepare(customer,{...body,applicantIndex}):workflow.review(customer,{...body,applicantIndex});reply(200,result);return true;
 }catch(error){const known=ERROR_STATUS[error?.code||error?.message],provided=Number(error?.statusCode);const code=known?error.code||error.message:/^RAAD_[A-Z_]{1,65}$/.test(error?.code||error?.message||'')?error.code||error.message:'RAAD_UNAVAILABLE';reply(known||(code!=='RAAD_UNAVAILABLE'&&[400,404,409,422,503].includes(provided)?provided:503),{ok:false,error:code});return true;}
}
module.exports={handleRaadRequest};
