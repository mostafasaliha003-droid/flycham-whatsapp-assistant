'use strict';
const {normalize}=require('./arabic-dates');
const {city}=require('./travel-language');

// Resolve short references against saved facts before asking the model again.
// This recognises a request to CHECK availability, never availability itself.
function knownTripFollowup(raw,request){
 if(!request)return null;
 const t=normalize(raw).toLowerCase().replace(/[؟?!،,.]+$/g,'').trim();
 const lead='(?:(?:اي|نعم|تمام|طيب|لو سمحت|بدي|بدنا|اريد|في|فيه|موجود|عندكن|عندك|هل|رحله|رحلة|رحلات|طيران)\\s+)*';
 const same=new RegExp('^'+lead+'(?:على\\s+)?نفس\\s+(?:التواريخ|تواريخ|التاريخ|تاريخ|الموعد|موعد|الايام|ايام|الفتر[هة]|الرحل[هة]|التفاصيل)(?:\\s+(?:نفسها|بس|تماما))?$');
 if(same.test(t)&&(request.departureDate||request.departureRange))return{fields:{},sameDates:true};
 const tail=t.replace(new RegExp('^'+lead),'');
 if(!/^(?:من|from)\s+/.test(tail)){
  const bare=city(t);return bare&&bare===city(request.origin)?{fields:{origin:bare},sameDates:true}:null;
 }
 const parts=tail.replace(/^(?:من|from)\s+/,'').split(' ');
 for(let count=1;count<=Math.min(5,parts.length);count++){
  const origin=city(parts.slice(0,count).join(' '));if(!origin)continue;
  const rest=parts.slice(count).join(' ');
  if(!rest)return{fields:{origin},sameDates:true};
  const to=rest.match(/^(?:الي\s+|الى\s+|علي\s+|على\s+|to\s+|لل|ل)(.+)$/);
  if(!to)continue;
  const destination=city(to[1]);
  if(destination)return{fields:{origin,destination},sameDates:true};
  // A country reference can retain an already known Syrian destination;
  // a new request that says only Syria still needs its destination city.
  if(/^سوري[اةه]$/.test(to[1])&&['دمشق','حلب','اللاذقية'].includes(city(request.destination)))return{fields:{origin},sameDates:true};
 }
 return null;
}
module.exports={knownTripFollowup};
