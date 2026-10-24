'use strict';
const {POLICY,capabilityIssue}=require('./assistant-policy');
const {TERMS}=require('./flycham-pricing');
const {formatAED}=require('./money');
const {expandLiveRequests}=require('./live-quote');

const SEARCH_ACTIONS=new Set(['search','amend','plan_search','submit_search']);
const OFFICIAL_DOMAINS=Object.freeze(['airarabia.com','flycham.com','emirates.com','etihad.com','u.ae','icp.gov.ae','gdrfad.gov.ae','mofa.gov.ae','mofa.gov.sa','visa.mofa.gov.sa','visitsaudi.com','nusuk.sa','rop.gov.om','evisa.rop.gov.om','moi.gov.kw','mofa.gov.kw','thaievisa.go.th','mfa.go.th','evisa.gov.tr','mfa.gov.tr','europa.eu','france-visas.gouv.fr','gov.uk','travel.state.gov','iata.org']);
const TOOL_REGISTRY=Object.freeze([
 {name:'get_policy',purpose:'Read approved company policies; no live inventory claims',mutates:false},
 {name:'read_fresh_fares',purpose:'Read verified recent catalog records for the current trip',mutates:false},
 {name:'plan_search',purpose:'Validate a complete quote-only request before queue submission',mutates:false},
 {name:'get_search_status',purpose:'Read actual pending/running/completed search state',mutates:false},
 {name:'compare_verified_offers',purpose:'Compare verified offers and preserve requested airport',mutates:false},
 {name:'search_knowledge',purpose:'Find official public travel sources; snippets require verification',mutates:false},
 {name:'prepare_handoff',purpose:'Prepare a booking staff request; does not book or issue',mutates:false},
]);

function getTravelPolicy(){
 return {
  version:POLICY.version,company:POLICY.company,assistantName:POLICY.name,assistantIsVirtual:true,
  pricingSource:'authenticated_supplier_results',discountAllowed:false,bookingByHumanOnly:true,
  askPassengerCount:true,onePersonMeansOneAdult:true,defaultCheckedBaggageKg:30,
  verifiedPartySupport:{adults:1,children:0,infants:0},
  airarabia:{officeMarginAED:25,seatMarginAED:10,mealMarginAED:5,baggageUpgradeMarginAED:10,actualSupplierAncillaryCostsMustBeIncluded:true,freeThenCheapestSeat:true,freeThenCheapestMeal:true,noMealAllowed:true,portalTotalIsFinal:true},
  flycham:{quoteSource:'verified_first_page',seatOrMealInspectionRequired:false,checkedBaggageKg:30,handBaggageKg:10,oneWayMarginAED:formatAED(TERMS.one_way.margin),roundTripMarginAED:formatAED(TERMS.round_trip.margin),voucher:{oneWayAED:formatAED(TERMS.one_way.voucher),roundTripAED:formatAED(TERMS.round_trip.voucher),validityYears:1,onlyAfterConfirmedTicket:true,discountsCurrentFare:false,services:['future_flights','hotels','esim','applicable_change_fees']}},
  availabilityClaimsRequireVerifiedEvidence:true,searchDoesNotCreateBooking:true,
 };
}

function safeError(code){const e=Error(code);e.code=code;return e;}
function validateSearchCommand({request,requestVersion,expectedVersion,action}={}){
 if(!SEARCH_ACTIONS.has(action))throw safeError('CONSULTANT_SEARCH_ACTION_NOT_ALLOWED');
 if(!Number.isSafeInteger(requestVersion)||requestVersion<1||!Number.isSafeInteger(expectedVersion)||expectedVersion!==requestVersion)throw safeError('CONSULTANT_REQUEST_VERSION_MISMATCH');
 if(!request||typeof request!=='object'||Array.isArray(request))throw safeError('CONSULTANT_REQUEST_INVALID');
 // Explicit party and direction are required; an unmentioned party is never a default adult.
 const party=request.passengers;
 if(!party||party.adults!==1||party.children!==0||party.infants!==0)throw safeError('CONSULTANT_PASSENGERS_NOT_VERIFIED');
 if(request.provider&&!['airarabia','flycham'].includes(request.provider))throw safeError('CONSULTANT_PROVIDER_NOT_ALLOWED');
 if(capabilityIssue(request))throw safeError('CONSULTANT_SEARCH_SCOPE_UNSUPPORTED');
 let requests;
 try{requests=expandLiveRequests(request);}catch{throw safeError('CONSULTANT_SEARCH_SCOPE_UNSUPPORTED');}
 // Copies prevent a caller/model changing an already validated queue command.
 return {request:structuredClone(request),requests:structuredClone(requests),action,requestVersion};
}

function isOfficialURL(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return false;const host=u.hostname.toLowerCase();return OFFICIAL_DOMAINS.some(d=>host===d||host.endsWith('.'+d));}catch{return false;}
}
function safeText(text,max){
 return String(text||'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[\da-f]+);/gi,' ').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
function publicTravelQuery(value){
 if(typeof value!=='string'||value.length<3||value.length>240)return null;
 const q=value.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).trim();
 if(!q||/[\u0000-\u001f\u007f]/.test(q)||/https?:|www\.|@|\b(?:bearer|password|api[_ -]?key|access[_ -]?token|otp)\b|كلمه\s*المرور|كلمة\s*المرور|رمز\s*التحقق/i.test(q))return null;
 if((q.match(/\d/g)||[]).length>=7||/\b[A-Z]{1,3}\d{5,}\b/i.test(q)||/\b(?:site|filetype|inurl|intitle):/i.test(q))return null;
 if(!/travel|visa|passport|airport|flight|baggage|transit|touris|entry|immigration|سفر|تاشير|تأشير|فيزا|جواز|مطار|طيران|رحل|امتعه|أمتعة|عبور|ترانزيت|دخول|سياح|وزن|عمرة|عمره/i.test(q))return null;
 return q.replace(/\s+/g,' ');
}
function unavailable(reason){return {status:'unavailable',sources:[],requiresVerification:true,reason};}
async function searchKnowledge(query,{env=process.env,fetchImpl=fetch,now=Date.now()}={}){
 const q=publicTravelQuery(query);if(!q)return unavailable('invalid_public_query');
 if(!env.BRAVE_SEARCH_API_KEY)return unavailable('not_configured');
 const at=typeof now==='function'?now():now;
 if(!Number.isFinite(at))return unavailable('invalid_clock');
 try{
  const url=new URL('https://api.search.brave.com/res/v1/web/search');
  url.search=new URLSearchParams({q,count:'10',safesearch:'strict',text_decorations:'false'}).toString();
  const response=await fetchImpl(url.href,{method:'GET',headers:{Accept:'application/json','X-Subscription-Token':env.BRAVE_SEARCH_API_KEY},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)return unavailable('search_unavailable');
  const payload=await response.json();if(!Array.isArray(payload?.web?.results))return unavailable('no_official_sources');
  const sources=[],seen=new Set();
  for(const result of payload.web.results.slice(0,20)){
   if(!isOfficialURL(result?.url)||seen.has(result.url))continue;
   const u=new URL(result.url);u.hash='';
   // Links containing credentials/tokens or private IDs are not passed onward.
   if(/[?&](?:token|key|code|secret|email|passport|pnr)=/i.test(u.search))continue;
   const title=safeText(result.title,160),snippet=safeText(result.description,700);
   if(!title||!snippet)continue;
   seen.add(result.url);sources.push({title,url:u.href,snippet,checkedAt:new Date(at).toISOString(),evidenceType:'search_snippet',untrustedContent:true});
   if(sources.length===4)break;
  }
  if(!sources.length)return unavailable('no_official_sources');
  return {status:'available',sources,requiresVerification:true};
 }catch{return unavailable('search_unavailable');}
}
module.exports={getTravelPolicy,validateSearchCommand,searchKnowledge,isOfficialURL,publicTravelQuery,TOOL_REGISTRY};
