'use strict';
// These are Remal's dated intake rules, NOT guarantees of government eligibility.
const POLICY_VERSION='remal-saudi-2026-10-27';
const PRICES=Object.freeze({tourist:700,touristGroup:650,groupMinimum:3,umrah:850,cancellation:200,courier:35});
const REFUND_BENEFIT='🛡️ *ميزة خاصة لعملائنا: رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي.*\nهذا التزام من مكتبنا، وفق شروط الخدمة الموضحة قبل الدفع.';
const OFFICE_ADDRESS='📍 دائرة السياحة والاقتصاد، نفس البناء الحكومي\nBlock B، مكتب رقم 610\nميناء سعيد، دبي';
function normalize(s){return String(s||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).toLowerCase().trim();}
const COUNTRY_ALIASES={
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
function productFor(person={}){
 const n=canonicalNationality(person.nationality),doc=person.documentType;
 if(['أفغانستان','إيران','تشاد'].includes(n))return {code:'suspended',label:'التقديم متوقف حالياً لدينا',policyVersion:POLICY_VERSION};
 if(doc==='travel_document'||['فلسطين','ليبيا','العراق'].includes(n))return {code:'umrah',label:'تأشيرة عمرة',policyVersion:POLICY_VERSION};
 if(n==='مصر')return {code:'tourist_single',label:'تأشيرة سياحية سفرة واحدة',policyVersion:POLICY_VERSION};
 if(MULTI.has(n))return {code:'tourist_multi',label:'تأشيرة سياحية سنة متعددة الدخول',policyVersion:POLICY_VERSION};
 return {code:'unverified',label:'نوع التأشيرة يحتاج تحققاً',policyVersion:POLICY_VERSION};
}
function calculateQuote(c,{feesEnabled=false}={}){
 const count=c.applicantCount;if(!Number.isInteger(count)||count<1||count>30)return null;
 const people=Array.from({length:count},(_,i)=>c.applicants?.[i]||{}),products=people.map(productFor);
 if(products.some(p=>['suspended','unverified'].includes(p.code))||people.some(p=>!p.documentType))return null;
 // Child pricing and mixed-group discounts have not been authorised.
 if(c.hasMinors||people.some(p=>Number.isFinite(p.age)&&p.age<18))return {requiresReview:true,reason:'child_pricing'};
 const tourist=products.filter(p=>p.code.startsWith('tourist')).length,umrah=products.filter(p=>p.code==='umrah').length;
 const group=tourist>=3&&umrah===0,rows=products.map((p,i)=>({applicant:i+1,product:p.code,label:p.label,amount:p.code==='umrah'?PRICES.umrah:group?PRICES.touristGroup:PRICES.tourist}));
 const subtotal=rows.reduce((s,r)=>s+r.amount,0),rate=feesEnabled?(c.paymentMethod==='link'?0.05:c.paymentMethod==='tabby'?0.09:0):0;
 const fee=Math.round(subtotal*rate*100)/100;
 return {policyVersion:POLICY_VERSION,rows,subtotal,paymentFee:fee,total:Math.round((subtotal+fee)*100)/100,paymentMethod:c.paymentMethod||'bank',groupDiscount:group,mixedGroupReview:tourist>0&&umrah>0,feePending:!feesEnabled&&['link','tabby'].includes(c.paymentMethod),courierIncluded:false,currency:'AED'};
}
const TOURIST_DOCS='للتقديم السياحي أونلاين بنحتاج:\n• نسخة جواز سكانر واضحة، الاسم والباركود كاملين ومن دون فلاش أو انعكاس، وصلاحية 6 أشهر عند السفر.\n• وجه الهوية وخلفها بدقة عالية من تطبيق UAEICP.\n• صورة شخصية حديثة بخلفية بيضاء.';
const UMRAH_DOCS='لتأشيرة العمرة بنحتاج أصل الجواز وأصل الهوية لدخول السفارة، وتاريخ الذهاب والعودة.\nإذا السفر بالطيران: تذكرة مؤكدة. وإذا بالسيارة: الملكية ومنفذ الدخول والخروج.\nوبالنسبة للإقامة: بيانات هوية المستضيف بالسعودية خلال فترة الإقامة، أو حجز الفندق عن طريقنا من خلال نسك. قبول بيانات الاستضافة مرتبط بإجراءات التقديم.';
module.exports={POLICY_VERSION,PRICES,REFUND_BENEFIT,OFFICE_ADDRESS,normalize,nationalities,canonicalNationality,productFor,calculateQuote,TOURIST_DOCS,UMRAH_DOCS};
