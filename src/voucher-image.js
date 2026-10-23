'use strict';
const QRCode=require('qrcode'),sharp=require('sharp'),logo=require('./remal-logo');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function voucherPNG(voucher,origin,{demo=false}={}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('VOUCHER_HTTPS_ORIGIN_REQUIRED');
 const url=base.origin+'/vouchers/verify/'+voucher.token;
 const qr=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:3,width:270});
 const date=s=>new Intl.DateTimeFormat('ar-AE-u-nu-arab',{timeZone:'Asia/Dubai',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(s));
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1400" height="850" viewBox="0 0 1400 850">
 <rect width="1400" height="850" rx="38" fill="#102632"/><path d="M1000 0H1400V850H1190L950 490Z" fill="#143b45"/><circle cx="1350" cy="40" r="260" fill="#50bebc" opacity=".1"/>
 <rect x="40" y="40" width="1320" height="770" rx="26" fill="none" stroke="#56bfbc" stroke-width="2"/>
 <rect x="80" y="76" width="230" height="230" rx="22" fill="white"/><image x="85" y="80" width="220" height="220" xlink:href="${logo}"/>
 <g font-family="DejaVu Sans, Arial, sans-serif" fill="#fff">
 <text x="1290" y="153" text-anchor="end" font-size="23" fill="#77d8d2">مكافآت مجموعة الرمال</text>
 <text x="1290" y="224" text-anchor="end" font-size="53" font-weight="bold">هديتك لرحلتك القادمة</text>
 <text x="1290" y="275" text-anchor="end" font-size="24" fill="#b9d2d7">استمتع بهديتك على خدمات مجموعة الرمال</text>
 <text x="940" y="400" text-anchor="end" font-size="88" font-weight="bold">${escape(new Intl.NumberFormat('ar-AE-u-nu-arab').format(Number(voucher.value)))}<tspan font-size="43" fill="#76d4cd"> درهم</tspan></text>
 <text x="940" y="453" text-anchor="end" font-size="26" fill="#b9d2d7">قسيمة هدية لخدمات السفر والسياحة</text>
 <text x="940" y="512" text-anchor="end" font-size="21" fill="#77d8d2">أُهديت خصيصًا إلى</text>
 <text x="940" y="565" text-anchor="end" font-size="38">${escape(voucher.customerName)}</text>
 <text x="940" y="625" text-anchor="end" font-size="22" fill="#b9d2d7">تاريخ الإصدار: ${escape(date(voucher.issuedAt))}</text>
 <text x="940" y="666" text-anchor="end" font-size="22" fill="#b9d2d7">صالحة حتى: ${escape(date(voucher.expiresAt))}</text>
 <text x="940" y="716" text-anchor="end" font-size="23">طيران · فنادق · شرائح إنترنت · رسوم تعديل</text>
 <text x="940" y="756" text-anchor="end" font-size="17" fill="#b9d2d7">للاستخدام لاحقًا ولمرة واحدة · يُرجى التحقق من الحالة قبل الاسترداد</text>
 <text x="1170" y="665" text-anchor="middle" font-size="20" fill="#b9d2d7">امسح الرمز للتحقق</text>
 <text x="1170" y="705" text-anchor="middle" font-size="15" fill="#77d8d2">${escape(voucher.id.slice(0,8).toUpperCase())}</text>
 <text x="1170" y="747" text-anchor="middle" font-size="17" fill="#b9d2d7">تواصل معنا عبر واتساب</text>
 <text x="1170" y="778" text-anchor="middle" font-size="18" fill="#77d8d2">+971544908485</text></g>
 <image x="1035" y="345" width="270" height="270" xlink:href="${qr}"/>
 ${demo?'<rect x="1000" y="75" width="290" height="45" rx="14" fill="#b32d40"/><text x="1145" y="105" text-anchor="middle" font-family="DejaVu Sans" fill="white" font-weight="bold" font-size="17">نموذج تجريبي — غير صالح</text>':''}
 </svg>`;
 return sharp(Buffer.from(svg)).png().toBuffer();
}
module.exports={voucherPNG};
