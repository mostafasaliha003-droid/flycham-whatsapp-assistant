'use strict';
const QRCode=require('qrcode'),sharp=require('sharp'),logo=require('./remal-logo');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function voucherPNG(voucher,origin,{demo=false}={}){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('VOUCHER_HTTPS_ORIGIN_REQUIRED');
 const url=base.origin+'/vouchers/verify/'+voucher.token;
 const qr=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:3,width:270});
 const date=s=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai',day:'2-digit',month:'short',year:'numeric'}).format(new Date(s));
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1400" height="850" viewBox="0 0 1400 850">
 <rect width="1400" height="850" rx="38" fill="#102632"/><path d="M1000 0H1400V850H1190L950 490Z" fill="#143b45"/><circle cx="1350" cy="40" r="260" fill="#50bebc" opacity=".1"/>
 <rect x="40" y="40" width="1320" height="770" rx="26" fill="none" stroke="#56bfbc" stroke-width="2"/>
 <rect x="80" y="76" width="230" height="230" rx="22" fill="white"/><image x="85" y="80" width="220" height="220" xlink:href="${logo}"/>
 <g font-family="DejaVu Sans, Arial, sans-serif" fill="#fff"><text x="350" y="125" font-size="18" letter-spacing="5" fill="#77d8d2">REMAL REWARDS</text>
 <text x="350" y="195" font-size="38" font-weight="bold">A GIFT FOR YOUR NEXT JOURNEY</text>
 <text x="350" y="242" font-size="23" fill="#b9d2d7">A little gift. A world of possibilities.</text>
 <text x="95" y="420" font-size="110" font-weight="bold">${escape(voucher.value.replace('.00',''))}<tspan font-size="44" fill="#76d4cd"> AED</tspan></text>
 <text x="100" y="456" font-size="22" fill="#b9d2d7">TRAVEL &amp; LIFESTYLE GIFT VOUCHER</text>
 <text x="100" y="515" font-size="18" fill="#77d8d2">EXCLUSIVELY FOR</text>
 <text x="100" y="566" font-size="34">${escape(voucher.customerName)}</text>
 <text x="100" y="640" font-size="17" fill="#b9d2d7">ISSUED ${escape(date(voucher.issuedAt))}  ·  VALID UNTIL ${escape(date(voucher.expiresAt))}</text>
 <text x="100" y="690" font-size="19">Flights · Hotels · eSIM · Amendment fees</text>
 <text x="100" y="728" font-size="16" fill="#b9d2d7">Future REMAL services · One-time use · Status verified before redemption</text>
 <text x="100" y="766" font-size="17" fill="#77d8d2">WhatsApp +971 54 475 7578</text>
 <text x="1170" y="668" text-anchor="middle" font-size="18" fill="#b9d2d7">SCAN TO VERIFY</text>
 <text x="1170" y="702" text-anchor="middle" font-size="15" fill="#77d8d2">${escape(voucher.id.slice(0,8).toUpperCase())}</text></g>
 <image x="1035" y="345" width="270" height="270" xlink:href="${qr}"/>
 ${demo?'<rect x="1000" y="75" width="290" height="45" rx="14" fill="#b32d40"/><text x="1145" y="105" text-anchor="middle" font-family="DejaVu Sans" fill="white" font-weight="bold" font-size="18">DEMO — NOT VALID</text>':''}
 </svg>`;
 return sharp(Buffer.from(svg)).png().toBuffer();
}
module.exports={voucherPNG};
