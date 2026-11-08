'use strict';
// Display only: approved quote arithmetic and age review belong to policy.
// These helpers never decide eligibility, confirm payment or settle an
// unapproved refund rule for the separate insurance surcharge.
const P=require('./saudi-visa-policy');
const lang=value=>['en','fr'].includes(value)?value:'ar';
const money=value=>Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
const validAge=value=>Number.isInteger(value)&&value>=0&&value<120;
const REFUND_COPY=Object.freeze({
 ar:'رسوم التأشيرة مستردة بالكامل في حال الرفض الرسمي. هالشي التزام من مكتبنا حسب شروط الخدمة.',
 en:'Visa fees are fully refundable following an official refusal, under the service terms.',
 fr:'Les frais de visa sont intégralement remboursables en cas de refus officiel, selon les conditions du service.'
});
const INSURANCE_REFUND_COPY=Object.freeze({
 ar:'شروط استرداد مبلغ التأمين بنراجعها بشكل منفصل قبل الدفع.',
 en:'We review the insurance refund terms separately before payment.',
 fr:'Les conditions de remboursement de l’assurance sont vérifiées séparément avant le paiement.'
});
function visaRefundCopy({insuranceQuestion=false,language='ar',direct=true}={}){
 const l=lang(language),yes={ar:'نعم، ',en:'Yes. ',fr:'Oui. '}[l];
 return (direct?yes:'')+REFUND_COPY[l]+(insuranceQuestion?'\n'+INSURANCE_REFUND_COPY[l]:'');
}
function agePrompt(indices,language){
 const l=lang(language),people=Array.isArray(indices)?indices.filter(n=>Number.isInteger(n)&&n>=1&&n<=30):[];
 if(people.length===1&&people[0]!==1)return {ar:`كم عمر المتقدم ${people[0]} بالسنوات المكتملة؟`,en:`How old is applicant ${people[0]} in completed years?`,fr:`Quel est l’âge du demandeur ${people[0]} en années révolues ?`}[l];
 if(people.length>1){const names=people.join(l==='ar'?'، ':', ');return {ar:`كم عمر كل من المتقدمين ${names} بالسنوات المكتملة؟`,en:`How old are applicants ${names}, in completed years?`,fr:`Quels sont les âges des demandeurs ${names}, en années révolues ?`}[l];}
 return {ar:'كم عمر المتقدم بالسنوات المكتملة؟',en:'How old is the applicant in completed years?',fr:'Quel est l’âge du demandeur en années révolues ?'}[l];
}
function touristPriceOverview({age=null,language='ar',includeNextStep=true}={}){
 if(validAge(age)&&age<18)return null;
 const l=lang(language),base=money(P.PRICES.tourist),surcharge=money(P.TOURIST_INSURANCE_SURCHARGE),threshold=P.TOURIST_AGE_THRESHOLD;
 const lead={ar:`رسوم التأشيرة السياحية الأساسية ${base} درهم للشخص.`,en:`The base tourist visa fee is AED ${base} per person.`,fr:`Les frais de base du visa touristique sont de ${base} AED par personne.`}[l];
 if(age===threshold)return lead+'\n'+{ar:`لعمر ${threshold} سنة، بنراجع قيمة التأمين قبل تأكيد المجموع والدفع.`,en:`For age ${threshold}, we need to check the insurance amount before confirming the total and taking payment.`,fr:`À ${threshold} ans, le montant de l’assurance doit être vérifié avant de confirmer le total et de procéder au paiement.`}[l];
 const rule={ar:`لمن عمره فوق ${threshold} سنة، يضاف ${surcharge} درهم تأمين طبي إلزامي.`,en:`Above age ${threshold}, mandatory medical insurance adds AED ${surcharge}.`,fr:`Au-delà de ${threshold} ans, un supplément obligatoire de ${surcharge} AED s’applique pour l’assurance médicale.`}[l];
 return lead+'\n'+rule+(!validAge(age)&&includeNextStep?'\n'+agePrompt([],l):'');
}
function touristInsuranceCopy({age=null,language='ar',includeNextStep=true}={}){
 if(validAge(age)&&age<18)return null;
 const l=lang(language),surcharge=money(P.TOURIST_INSURANCE_SURCHARGE),threshold=P.TOURIST_AGE_THRESHOLD;
 if(age===threshold)return {ar:`التأمين الطبي إلزامي. لعمر ${threshold} سنة، بنراجع قيمته قبل تأكيد المجموع والدفع.`,en:`Medical insurance is mandatory. For age ${threshold}, we need to check its amount before confirming the total and taking payment.`,fr:`L’assurance médicale est obligatoire. À ${threshold} ans, son montant doit être vérifié avant de confirmer le total et de procéder au paiement.`}[l];
 if(validAge(age)&&age<threshold)return {ar:`لهالعمر ما بتنضاف زيادة التأمين البالغة ${surcharge} درهم، لأنها خاصة بمن عمره فوق ${threshold} سنة.`,en:`The AED ${surcharge} age-related insurance surcharge does not apply at this age; it applies above age ${threshold}.`,fr:`Le supplément d’assurance de ${surcharge} AED lié à l’âge ne s’applique pas à cet âge ; il s’applique au-delà de ${threshold} ans.`}[l];
 const rule={ar:`التأمين الطبي إلزامي، وتضاف ${surcharge} درهم على رسوم السياحية لمن عمره فوق ${threshold} سنة.`,en:`Medical insurance is mandatory, with an additional AED ${surcharge} on tourist visa fees above age ${threshold}.`,fr:`L’assurance médicale est obligatoire, avec un supplément de ${surcharge} AED sur les frais du visa touristique au-delà de ${threshold} ans.`}[l];
 return rule+(!validAge(age)&&includeNextStep?'\n'+agePrompt([],l):'');
}
function reviewCopy(q,{language='ar',includeNextStep=true}={}){
 const l=lang(language),details=Array.isArray(q.ageReviewDetails)?q.ageReviewDetails:[],unknown=details.filter(d=>d.reason==='tourist_age_required').map(d=>d.applicant),boundary=details.filter(d=>d.reason==='tourist_age_53_review').map(d=>d.applicant);
 const fallback=Array.isArray(q.ageReviewApplicants)?q.ageReviewApplicants:[];
 const required=unknown.length?unknown:q.reason==='tourist_age_required'?fallback:[];
 const exact=boundary.length?boundary:q.reason==='tourist_age_53_review'?fallback:[];
 const base=money(q.baseTouristAmount),surcharge=money(q.insuranceSurchargeAmount),threshold=P.TOURIST_AGE_THRESHOLD;
 const lines=[{ar:`رسوم السياحية الأساسية ${base} درهم للشخص.`,en:`The base tourist visa fee is AED ${base} per person.`,fr:`Les frais de base du visa touristique sont de ${base} AED par personne.`}[l]];
 if(required.length)lines.push({ar:`يضاف ${surcharge} درهم تأمين طبي إلزامي لمن عمره فوق ${threshold} سنة؛ نحتاج العمر قبل تأكيد المجموع.`,en:`Mandatory medical insurance adds AED ${surcharge} above age ${threshold}; the age is needed before confirming the total.`,fr:`Une assurance médicale obligatoire de ${surcharge} AED s’ajoute au-delà de ${threshold} ans ; l’âge est nécessaire pour confirmer le total.`}[l]);
 if(exact.length||q.reason==='tourist_age_53_review')lines.push({ar:`حالة عمر ${threshold} سنة تحتاج مراجعة قيمة التأمين قبل تأكيد المجموع والدفع.`,en:`The age-${threshold} case needs an insurance amount review before confirming the total and taking payment.`,fr:`Pour le cas âgé de ${threshold} ans, le montant de l’assurance doit être vérifié avant de confirmer le total et de procéder au paiement.`}[l]);
 if(required.length&&includeNextStep)lines.push(agePrompt(required,l));
 return lines.join('\n');
}
function touristQuoteCopy(q,{language='ar',includeNextStep=true,refundShown=false,includeRefund=true}={}){
 if(!q||typeof q!=='object')return null;
 if(q.requiresReview){
  if(!['tourist_age_required','tourist_age_53_review'].includes(q.reason)||!Number.isFinite(q.baseTouristAmount)||!Number.isFinite(q.insuranceSurchargeAmount))return null;
  return reviewCopy(q,{language,includeNextStep});
 }
 // Legacy, child, Umrah and mixed-group quotes stay on their existing renderer.
 if(!Array.isArray(q.rows)||!q.rows.length||q.rows.length>30||q.rows.some(r=>!['tourist_multi','tourist_single'].includes(r.product)||!Number.isInteger(r.applicant)||r.applicant<1||r.applicant>30||![r.amount,r.baseAmount,r.insuranceSurcharge].every(Number.isFinite))||![q.visaSubtotal,q.insuranceSubtotal,q.subtotal,q.total,q.paymentFee].every(Number.isFinite))return null;
 const l=lang(language),lines=[];
 for(const row of q.rows){
  const base=money(row.baseAmount),insurance=money(row.insuranceSurcharge),sum=money(row.amount),prefix=q.rows.length>1?{ar:`المتقدم ${row.applicant}: `,en:`Applicant ${row.applicant}: `,fr:`Demandeur ${row.applicant} : `}[l]:'';
  const single=row.product==='tourist_single';
  const type={ar:single?'السياحية سفرة واحدة':'السياحية سنة متعددة الدخول',en:single?'Single-entry tourist visa':'One-year multiple-entry tourist visa',fr:single?'Visa touristique à entrée unique':'Visa touristique d’un an à entrées multiples'}[l];
  lines.push(prefix+`*${type}*`);
  lines.push({ar:`${base} درهم رسوم تأشيرة`+(row.insuranceSurcharge?` + ${insurance} درهم تأمين طبي إلزامي`:'')+(q.rows.length>1&&row.insuranceSurcharge?` = ${sum} درهم.`:'.'),en:`AED ${base} visa fee`+(row.insuranceSurcharge?` + AED ${insurance} mandatory medical insurance`:'')+(q.rows.length>1&&row.insuranceSurcharge?` = AED ${sum}.`:'.'),fr:`${base} AED de frais de visa`+(row.insuranceSurcharge?` + ${insurance} AED d’assurance médicale obligatoire`:'')+(q.rows.length>1&&row.insuranceSurcharge?` = ${sum} AED.`:'.')}[l]);
 }
 if(q.paymentFee>0)lines.push({ar:`رسوم وسيلة الدفع: ${money(q.paymentFee)} درهم.`,en:`Payment-method fee: AED ${money(q.paymentFee)}.`,fr:`Frais du moyen de paiement : ${money(q.paymentFee)} AED.`}[l]);
 if(q.feePending)lines.push({ar:`المجموع قبل رسوم وسيلة الدفع: ${money(q.subtotal)} درهم. رسوم وسيلة الدفع بنأكدها قبل الدفع.`,en:`Total before payment-method fees: AED ${money(q.subtotal)}. We confirm those fees before payment.`,fr:`Total hors frais du moyen de paiement : ${money(q.subtotal)} AED. Ces frais sont confirmés avant le paiement.`}[l]);
 else if(q.rows.length>1||q.insuranceSubtotal>0||q.paymentFee>0)lines.push({ar:`*المجموع: ${money(q.total)} درهم.*`,en:`*Total: AED ${money(q.total)}.*`,fr:`*Total : ${money(q.total)} AED.*`}[l]);
 if(q.paymentMethod==='bank'&&!q.paymentFee)lines.push({ar:'التحويل البنكي دون عمولة إضافية من المكتب.',en:'Bank transfer has no additional office commission.',fr:'Le virement bancaire ne comporte pas de commission supplémentaire de notre agence.'}[l]);
 if(includeRefund&&!refundShown)lines.push(visaRefundCopy({insuranceQuestion:q.insuranceSubtotal>0,language:l,direct:false}));
 else if(includeRefund&&q.insuranceSubtotal>0)lines.push(INSURANCE_REFUND_COPY[l]);
 return lines.join('\n');
}
module.exports={touristQuoteCopy,touristPriceOverview,touristInsuranceCopy,visaRefundCopy,REFUND_COPY,INSURANCE_REFUND_COPY};
