'use strict';
// These are Remal's dated intake rules, NOT guarantees of government eligibility.
const POLICY_VERSION='remal-saudi-2026-10-27';
const PRICES=Object.freeze({tourist:640,touristGroup:640,groupMinimum:3,umrah:850,cancellation:200,courier:35});
const AGE_PRICING_POLICY_VERSION='remal-saudi-2026-11-08-age-insurance';
const TOURIST_AGE_THRESHOLD=53;
const TOURIST_INSURANCE_SURCHARGE=190;
const REFUND_BENEFIT='🛡️ *ميزة خاصة لعملائنا: رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي.*\nالميزة تشمل السياحية والعمرة، وهي التزام من مكتبنا وفق شروط الخدمة الموضحة قبل الدفع.';
const OFFICE_ADDRESS='📍 دائرة السياحة والاقتصاد، نفس البناء الحكومي\nBlock B، مكتب رقم 610\nميناء سعيد، دبي';
function normalize(s){return String(s||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).toLowerCase().trim();}
const COUNTRY_ALIASES={
 'المغرب':['المغرب','مغربي','مغربيه','morocco','moroccan'],
 'تونس':['تونس','تونسي','تونسيه','tunisia','tunisian'],
 'الجزائر':['الجزائر','جزائري','جزائريه','algeria','algerian'],
 'موريتانيا':['موريتانيا','موريتاني','موريتانيه','mauritania','mauritanian'],
 'تركيا':['تركيا','تركي','تركيه','turkey','turkish'],
 'روسيا':['روسيا','روسي','روسيه','russia','russian'],
 'أستراليا':['استراليا','استرالي','استراليه','australia','australian'],
 'نيوزيلندا':['نيوزيلندا','نيوزيلندي','new zealand'],
 'سوريا':['سوريا','سوري','سوريه','syrian','syria'], 'الأردن':['الاردن','اردني','اردنيه','jordan','jordanian'],
 'لبنان':['لبنان','لبناني','لبنانيه','lebanon','lebanese'], 'جزر القمر':['جزر القمر','قمري','comoros'],
 'اليمن':['اليمن','يمني','يمنيه','yemen','yemeni'], 'السودان':['السودان','سوداني','سودانيه','sudan','sudanese'],
 'مصر':['مصر','مصري','مصريه','egypt','egyptian'], 'فلسطين':['فلسطين','فلسطيني','فلسطينيه','palestine','palestinian'],
 'ليبيا':['ليبيا','ليبي','ليبيه','libya','libyan'], 'العراق':['العراق','عراقي','عراقيه','iraq','iraqi'],
 'أفغانستان':['افغانستان','افغاني','افغان','afghanistan','afghan'], 'إيران':['ايران','ايراني','ايرانيه','iran','iranian'],
 'تشاد':['تشاد','تشادي','تشاديه','chad','chadian'], 'ماليزيا':['ماليزيا','ماليزي','malaysia','malaysian'],
 'إندونيسيا':['اندونيسيا','اندونيسي','اندونيسيه','indonesia','indonesian'], 'الهند':['الهند','هندي','هنديه','india','indian'],
 'باكستان':['باكستان','باكستاني','باكستانيه','pakistan','pakistani'], 'بنغلاديش':['بنغلاديش','بنغالي','بنغلادش','bangladesh','bangladeshi'],
 'الولايات المتحدة':['امريكا','اميركا','امريكي','اميركي','united states','american','usa'],
 'كندا':['كندا','كندي','كنديه','canada','canadian'], 'بريطانيا':['بريطانيا','بريطاني','بريطانيه','المملكه المتحده','united kingdom','british'],
 'فرنسا':['فرنسا','فرنسي','فرنسيه','france','french'], 'ألمانيا':['المانيا','الماني','المانيه','germany','german'],
 'إيطاليا':['ايطاليا','ايطالي','italy','italian'], 'إسبانيا':['اسبانيا','اسباني','spain','spanish'],
 'هولندا':['هولندا','هولندي','netherlands','dutch'], 'السويد':['السويد','سويدي','sweden','swedish'],
 'النرويج':['النرويج','نرويجي','norway','norwegian'], 'الدنمارك':['الدنمارك','دنماركي','denmark','danish'],
 'سويسرا':['سويسرا','سويسري','switzerland','swiss'], 'البرتغال':['البرتغال','برتغالي','portugal','portuguese'],
 'النمسا':['النمسا','نمساوي','austria','austrian'], 'بلجيكا':['بلجيكا','بلجيكي','belgium','belgian'],
 'اليونان':['اليونان','يوناني','greece','greek'], 'أيرلندا':['ايرلندا','ايرلندي','ireland','irish'],
 'فنلندا':['فنلندا','فنلندي','finland','finnish'], 'بولندا':['بولندا','بولندي','poland','polish'],
 'رومانيا':['رومانيا','روماني','romania','romanian'], 'بلغاريا':['بلغاريا','بلغاري','bulgaria','bulgarian'],
 'دومينيكا':['دومينيكا','dominica'], 'سانت كيتس ونيفيس':['سانت كيتس','saint kitts','st kitts'],
 'أنتيغوا وباربودا':['انتيغوا','antigua'], 'غرينادا':['غرينادا','جرينادا','grenada'], 'سانت لوسيا':['سانت لوسيا','saint lucia','st lucia']
};
const MULTI=new Set(Object.keys(COUNTRY_ALIASES).filter(n=>!['مصر','فلسطين','ليبيا','العراق','أفغانستان','إيران','تشاد'].includes(n)));
function boundaryFind(text,word){const a=normalize(word),pattern=new RegExp('(^|[^\\p{L}])'+a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^\\p{L}])','u');return pattern.test(text);}
function nationalities(text){const n=normalize(text);return Object.entries(COUNTRY_ALIASES).filter(([k,a])=>a.some(x=>boundaryFind(n,x)||/[ي]$/.test(normalize(x))&&boundaryFind(n,x+'ين'))).map(([k])=>k);}
function canonicalNationality(value){const n=normalize(value);for(const [country,aliases]of Object.entries(COUNTRY_ALIASES))if(normalize(country)===n||aliases.some(a=>normalize(a)===n))return country;return typeof value==='string'?value.trim().slice(0,70):null;}
const ISSUER_CITY_ALIASES=Object.freeze({
 'سوريا':['دمشق','الشام','حلب','حمص','حماه','اللاذقيه','طرطوس'],
 'لبنان':['بيروت','صيدا','طرابلس','صور'],
 'مصر':['القاهره','اسكندريه','الاسكندريه','الجيزه'],
 'الأردن':['عمان','اربد','الزرقاء'],
 'العراق':['بغداد','البصره','اربيل']
});
function canonicalIssuer(value,{exact=false}={}){
 const n=normalize(value);if(!n)return null;
 if(exact){
  const country=canonicalNationality(n);
  if(Object.hasOwn(COUNTRY_ALIASES,country))return country;
  return Object.entries(ISSUER_CITY_ALIASES).find(([,cities])=>cities.includes(n))?.[0]||null;
 }
 const ns=nationalities(n),matches=Object.entries(ISSUER_CITY_ALIASES).filter(([country,cities])=>ns.includes(country)||cities.some(city=>boundaryFind(n,city)&&(city!=='صور'||n==='صور'||/(?:من|في)\s+صور(?=$|[^\p{L}])/u.test(n)))).map(([country])=>country);
 // Do not guess between cities/countries, including Tripoli in Libya or Oman.
 if(matches.length===1&&!/سلطنه عمان/.test(n)&&!ns.some(country=>country!=='فلسطين'&&country!==matches[0]))return matches[0];
 if(!matches.length&&ns.length===1)return ns[0];
 return typeof value==='string'&&value.trim()?value.trim().slice(0,70):null;
}
function productFor(person={}){
 const n=canonicalNationality(person.nationality),doc=person.documentType;
 if(['أفغانستان','إيران','تشاد'].includes(n))return {code:'suspended',label:'التقديم متوقف حالياً لدينا',policyVersion:POLICY_VERSION};
 if(doc==='travel_document'||['فلسطين','ليبيا','العراق'].includes(n))return {code:'umrah',label:'تأشيرة عمرة',policyVersion:POLICY_VERSION};
 if(n==='مصر')return {code:'tourist_single',label:'تأشيرة سياحية سفرة واحدة',policyVersion:POLICY_VERSION};
 if(MULTI.has(n))return {code:'tourist_multi',label:'تأشيرة سياحية سنة متعددة الدخول',policyVersion:POLICY_VERSION};
 return {code:'unverified',label:'نوع التأشيرة يحتاج تحققاً',policyVersion:POLICY_VERSION};
}
function touristAgeReviewReason(person={}){
 if(!productFor(person).code.startsWith('tourist'))return null;
 if(!Number.isInteger(person.age)||person.age<0||person.age>=120)return 'tourist_age_required';
 return person.age===TOURIST_AGE_THRESHOLD?'tourist_age_53_review':null;
}
function touristAgeNeedsReview(person={}){return touristAgeReviewReason(person)!==null;}
function touristInsuranceApplies(person={}){return productFor(person).code.startsWith('tourist')&&Number.isInteger(person.age)&&person.age>TOURIST_AGE_THRESHOLD&&person.age<120;}
function calculateQuote(c,{feesEnabled=false,agePricing=false}={}){
 const count=c.applicantCount;if(!Number.isInteger(count)||count<1||count>30)return null;
 const people=Array.from({length:count},(_,i)=>c.applicants?.[i]||{}),products=people.map(productFor);
 if(products.some(p=>['suspended','unverified'].includes(p.code))||people.some(p=>!p.documentType))return null;
 // Child pricing and mixed-group discounts have not been authorised.
 if(c.hasMinors||people.some(p=>Number.isFinite(p.age)&&p.age<18))return {requiresReview:true,reason:'child_pricing',...(count>1&&products[0]?{adultReferenceAmount:products[0].code==='umrah'?PRICES.umrah:PRICES.tourist,adultLabel:products[0].label}:{})};
 if(agePricing){
  const ageReviewDetails=people.map((person,i)=>({applicant:i+1,reason:touristAgeReviewReason(person)})).filter(item=>item.reason);
  // Unknown ages and the unconfirmed boundary cannot produce a payable total.
  // The engine may explain the base price while obtaining/reviewing the age.
  if(ageReviewDetails.length)return {policyVersion:AGE_PRICING_POLICY_VERSION,requiresReview:true,reason:ageReviewDetails.some(item=>item.reason==='tourist_age_required')?'tourist_age_required':'tourist_age_53_review',ageReviewApplicants:ageReviewDetails.map(item=>item.applicant),ageReviewDetails,baseTouristAmount:PRICES.tourist,insuranceSurchargeAmount:TOURIST_INSURANCE_SURCHARGE};
 }
 const tourist=products.filter(p=>p.code.startsWith('tourist')).length,umrah=products.filter(p=>p.code==='umrah').length;
 const group=tourist>=3&&umrah===0,rows=products.map((p,i)=>{
  const baseAmount=p.code==='umrah'?PRICES.umrah:group?PRICES.touristGroup:PRICES.tourist,insuranceSurcharge=agePricing&&touristInsuranceApplies(people[i])?TOURIST_INSURANCE_SURCHARGE:0;
  return {applicant:i+1,product:p.code,label:p.label,amount:baseAmount+insuranceSurcharge,...(agePricing?{baseAmount,insuranceSurcharge}:{})};
 });
 const subtotal=rows.reduce((s,r)=>s+r.amount,0),rate=feesEnabled?(c.paymentMethod==='link'?0.05:c.paymentMethod==='tabby'?0.09:0):0;
 const fee=Math.round(subtotal*rate*100)/100;
 const quote={policyVersion:agePricing?AGE_PRICING_POLICY_VERSION:POLICY_VERSION,rows,subtotal,paymentFee:fee,total:Math.round((subtotal+fee)*100)/100,paymentMethod:c.paymentMethod||'bank',groupDiscount:group&&PRICES.touristGroup<PRICES.tourist,mixedGroupReview:tourist>0&&umrah>0,feePending:!feesEnabled&&['link','tabby'].includes(c.paymentMethod),courierIncluded:false,currency:'AED'};
 if(agePricing){
  quote.visaSubtotal=rows.reduce((sum,row)=>sum+row.baseAmount,0);quote.insuranceSubtotal=rows.reduce((sum,row)=>sum+row.insuranceSurcharge,0);
  if(quote.insuranceSubtotal>0)quote.insuranceRefundPolicy='pending_confirmation';
 }
 return quote;
}
const TOURIST_DOCS='للتقديم السياحي أونلاين بنحتاج:\n• نسخة جواز سكانر واضحة، الاسم والباركود كاملين ومن دون فلاش أو انعكاس، وصلاحية 6 أشهر عند السفر.\n• وجه الهوية وخلفها بدقة عالية من تطبيق UAEICP.\n• صورة شخصية حديثة بخلفية بيضاء.';
const UMRAH_ROUTE='المسار المتاح لهالحالة ضمن إجراءات التقديم عندنا هو تأشيرة العمرة، وليس التقديم السياحي أونلاين.';
const UMRAH_DOCS='بمسار العمرة اللي منقدّمه لهالحالة، التقديم ما بيكتمل أونلاين؛ لازم أصل الجواز وأصل الهوية لتقديمهما للسفارة.\n\nبالبداية منحتاج:\n• أصل الجواز وأصل الهوية.\n• تاريخ الذهاب والعودة.\n\nوبعد مراجعة الملف منرتب تفاصيل الرحلة: إذا السفر بالطيران منحتاج تذكرة مؤكدة، وإذا بالسيارة منحتاج الملكية ومنفذ الدخول والخروج. وللسكن: بيانات هوية المستضيف بالسعودية أو حجز الفندق عن طريقنا من خلال نسك، حسب متطلبات التقديم.';
function umrahConsultation(person={}, {objection=false}={}) {
 const who=person.nationality==='فلسطين'?'لحامل الجنسية الفلسطينية أو وثيقة السفر الفلسطينية، ':'لهذه الوثيقة أو الحالة، ';
 const lead=objection?'بفهم إنك بتفضّل السياحية. ما بننصحك بالمجازفة بتقديم غير مناسب لهالحالة، حتى ما تعرّض رسومك للخسارة. إذا بدك مراجعة استثناء، منتحقق مع المسؤول قبل أي دفع؛ ما فينا نضمن قبول أو رفض مسبق.':who+UMRAH_ROUTE;
 return [lead,'الخيار اللي منقدّمه إلك هو تأشيرة عمرة بتكلفة '+PRICES.umrah+' درهم للشخص. بهالمسار لازم أصل الجواز وأصل الهوية للسفارة؛ الصور لحالها ما بتكفي لإنهاء التقديم.',REFUND_BENEFIT,'دون ضمان للموافقة أو موعد الصدور.','شو تاريخ السفر اللي عم تخطط له؟'].join('\n\n');
}
function umrahQuestion(text){return /ليش.{0,15}(?:عمره|سياح)|(?:مافينا|ما فينا|ممكن|فينا|نجرب|نحاول|نقدم|نقدمه|نقدمها|بدي).{0,25}سياح|ليش ما.{0,15}سياح/.test(normalize(text));}

module.exports={UMRAH_ROUTE,umrahConsultation,umrahQuestion,POLICY_VERSION,AGE_PRICING_POLICY_VERSION,TOURIST_AGE_THRESHOLD,TOURIST_INSURANCE_SURCHARGE,touristAgeReviewReason,touristAgeNeedsReview,touristInsuranceApplies,PRICES,REFUND_BENEFIT,OFFICE_ADDRESS,normalize,nationalities,canonicalNationality,canonicalIssuer,productFor,calculateQuote,TOURIST_DOCS,UMRAH_DOCS};
