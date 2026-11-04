'use strict';
// The assistants answer 24/7. Only actions that need a responsible employee
// (handoff, payment link, pricing review, untrained case) depend on these hours.
const DUBAI_OFFSET_MS=4*3600000; // Asia/Dubai has no daylight saving time.
function staffHours(env=process.env){
 const start=env.STAFF_HOURS_START!==undefined&&String(env.STAFF_HOURS_START).trim()!==''&&Number.isInteger(Number(env.STAFF_HOURS_START))?Number(env.STAFF_HOURS_START):10;
 const end=env.STAFF_HOURS_END!==undefined&&String(env.STAFF_HOURS_END).trim()!==''&&Number.isInteger(Number(env.STAFF_HOURS_END))?Number(env.STAFF_HOURS_END):22;
 return start>=0&&end<=24&&start<end?{start,end}:{start:10,end:22};
}
function dubaiHour(now){const d=new Date(now+DUBAI_OFFSET_MS);return d.getUTCHours()+d.getUTCMinutes()/60;}
function staffAvailable(now=Date.now(),env=process.env){const {start,end}=staffHours(env),h=dubaiHour(now);return h>=start&&h<end;}
function hourText(h){return h===12?'12 الظهر':h===0||h===24?'12 منتصف الليل':h<12?h+' الصبح':(h-12)+' المسا';}
function staffExpectation(now=Date.now(),env=process.env){
 const {start,end}=staffHours(env),h=dubaiHour(now);
 if(h>=start&&h<end)return 'المسؤول المختص متواجد الآن وبيتابع معك بأقرب وقت ممكن 🌷';
 const when=h<start?'اليوم':'بكرا';
 return `فريقنا المسؤول متواجد يومياً من ${hourText(start)} لـ ${hourText(end)} بتوقيت الإمارات، فالمسؤول بيتابع معك ${when} من الساعة ${hourText(start)} 🌷 ملفك محفوظ كامل، وما رح تحتاج تعيد أي معلومة. وأنا موجود هون إذا عندك أي سؤال بهالوقت.`;
}
// Appends the expectation once to a reply that actually involves staff.
function withStaffExpectation(reply,now=Date.now(),env=process.env){
 if(typeof reply!=='string'||!reply.trim())return reply;
 if(/فريقنا المسؤول متواجد يومياً|المسؤول المختص متواجد الآن/.test(reply))return reply;
 return reply+'\n\n'+staffExpectation(now,env);
}
module.exports={staffHours,staffAvailable,staffExpectation,withStaffExpectation};
