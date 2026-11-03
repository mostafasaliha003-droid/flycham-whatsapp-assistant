'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RemalVisaOperatorGuidance=api;})(typeof window==='undefined'?globalThis:window,function(){
 const BASE='https://flycham-whatsapp-assistant.onrender.com/operations';
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 const PHONE=/^[1-9][0-9]{7,14}$/;
 const phases={health:'الإفصاح الصحي',login:'تسجيل الدخول',preflight:'تجهيز التقديم',lookup:'مراجعة الطلب الموجود',personal_info:'بيانات المتقدم',documents:'المستندات',application_sms:'التحقق من الهاتف',save:'حفظ الطلب',insurance:'التأمين',payment:'مراجعة الخطوة الأخيرة'};
 function operationsLink({customer,caseId,jobId}={}){const url=new URL(BASE);url.searchParams.set('view','visas');const phone=String(customer||'').replace(/^\+/,'');if(PHONE.test(phone))url.searchParams.set('customer',phone);if(UUID.test(caseId||''))url.searchParams.set('case',caseId);if(UUID.test(jobId||''))url.searchParams.set('job',jobId);return url.href;}
 function selectionFromSearch(search){const p=new URLSearchParams(search),customer=p.get('customer'),caseId=p.get('case');if(p.get('view')!=='visas'||!PHONE.test(customer||'')||!UUID.test(caseId||''))return null;return{customer,caseId,...(UUID.test(p.get('job')||'')?{jobId:p.get('job')}:{})};}
 function guidanceFor(code,{phase,hasReference=false}={}){
  const where=phases[phase];let summary,action,requiresUserAction=false;
  if(code==='PORTAL_BUTTON_VALIDATION_FAILED'){summary=where?'توقف رعد عند تأكيد زر المتابعة في خطوة '+where+'.':'تعذّر تأكيد زر المتابعة في بوابة التقديم.';action='لا توجد بيانات ناقصة مطلوب منك إدخالها. يلزم إصلاح خطوة المتابعة في النظام لاستئناف نفس الطلب.';}
  else if(['LOGIN_CAPTCHA_TIMEOUT','OPERATOR_CHALLENGE_EXPIRED'].includes(code)){summary='انتهت مهلة جلسة التحقق المرئي.';action='افتح جلسة التحقق من الزر المتاح في ملف الطلب عندما تكون جاهزًا لإكمالها.';requiresUserAction=true;}
  else if(code==='SAVE_UNCERTAIN'){summary='نتيجة حفظ الطلب تحتاج مطابقة مع البوابة.';action='يلزم فحص الطلب الموجود قبل الاستئناف. لا تُنشئ طلبًا جديدًا ولا تعِد الدفع.';}
  else return null;
  return{summary,action,requiresUserAction,...(hasReference?{referenceNote:'يوجد مرجع محفوظ لهذا الطلب؛ تُتابع المعالجة على المرجع نفسه.'}:{})};
 }
 return{operationsLink,selectionFromSearch,guidanceFor};
});
