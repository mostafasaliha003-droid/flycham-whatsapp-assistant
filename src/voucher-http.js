'use strict';
const {configuredStore,durableMount}=require('./vouchers');
const {voucherPNG}=require('./voucher-image');
const {validQueueKey}=require('./quote-jobs');
const fs=require('node:fs'),path=require('node:path');
const hits=new Map();let demoImage;
const states={valid:'صالح للاستخدام',used:'تم الاستخدام',expired:'منتهي الصلاحية',cancelled:'ملغى'};
function ready(env){return Boolean(env.VOUCHER_DB_PATH&&env.VOUCHER_ENCRYPTION_KEY&&durableMount(env.VOUCHER_DB_PATH));}
function send(res,status,body,type='application/json; charset=utf-8') {res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));}
function page(v){const state=v?states[v.state]:'غير صالح',date=v?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dubai'}).format(new Date(v.expiresAt)):'';return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>مجموعة الرمال — التحقق من الفاوجر</title><style>body{font-family:system-ui;background:#102632;color:white;max-width:540px;margin:60px auto;padding:25px}article{border:1px solid #55bdbb;border-radius:20px;padding:28px}h1{color:#80d9d4}p{line-height:1.8}</style><article><p>مجموعة الرمال · REMAL GROUP</p><h1>${state}</h1>${v?`<h2>${v.value} درهم</h2><p>الصلاحية حتى: ${date}<br>المرجع: ${v.id.slice(0,8).toUpperCase()}</p>`:''}<p>مسح الرمز للتحقق فقط ولا يستهلك الفاوجر. الاستخدام لدى موظف مجموعة الرمال المخوّل.</p></article></html>`;}
async function handleVoucherRequest(req,res,url,{readBody,env=process.env,sendImage}={}){
 if(req.method==='GET'&&url.pathname==='/vouchers-demo.png'){demoImage=demoImage||voucherPNG({id:'00000000-0000-0000-0000-000000000000',token:'D'.repeat(32),customerName:'عميل تجريبي',value:'25.00',issuedAt:'2026-10-23T10:00:00Z',expiresAt:'2027-10-23T10:00:00Z'},'https://flycham-whatsapp-assistant.onrender.com',{demo:true}).catch(e=>{demoImage=null;throw e;});send(res,200,await demoImage,'image/png');return true;}
 if(req.method==='GET'&&url.pathname==='/remal-logo.jpeg'){const logo=require('./remal-logo');send(res,200,Buffer.from(logo.split(',')[1],'base64'),'image/jpeg');return true;}
 if(req.method==='GET'&&['/vouchers-admin','/vouchers-admin.js','/vouchers-admin.css'].includes(url.pathname)) {const js=url.pathname.endsWith('.js'),css=url.pathname.endsWith('.css');res.writeHead(200,{'Content-Type':js?'text/javascript; charset=utf-8':css?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}).end(fs.readFileSync(path.join(__dirname,js?'vouchers-admin.js':css?'vouchers-admin.css':'vouchers-admin.html')));return true;}
 const publicMatch=url.pathname.match(/^\/vouchers\/verify\/([A-Za-z0-9_-]{32})$/);
 if(publicMatch&&req.method==='GET'){
  const now=Date.now(),ip=req.socket?.remoteAddress||'unknown';if(hits.size>5000)hits.clear();const h=hits.get(ip)||{at:now,n:0};if(now-h.at>60000){h.at=now;h.n=0;}hits.set(ip,h);if(++h.n>60){send(res,429,'Too many requests','text/plain');return true;}
  try{send(res,200,page(configuredStore(env).lookup(publicMatch[1])),'text/html; charset=utf-8');}catch{send(res,503,'خدمة التحقق غير متاحة مؤقتًا. يرجى التواصل مع مجموعة الرمال.','text/plain; charset=utf-8');}return true;
 }
 if(!url.pathname.startsWith('/internal/vouchers'))return false;
 if(!validQueueKey(req.headers.authorization,env.ASSISTANT_ADMIN_KEY)){send(res,401,{error:'UNAUTHORIZED'});return true;}
 try{
  if(req.method==='GET'&&url.pathname==='/internal/vouchers/status'){send(res,200,{ready:ready(env),issueAfterConfirmedFlyChamTicketOnly:true,validityYears:1});return true;}
  if(req.method==='GET'&&url.pathname==='/internal/vouchers/overview'){if(!ready(env)){send(res,200,{ready:false,updatedAt:new Date().toISOString(),summary:null,items:[]});return true;}send(res,200,configuredStore(env).overview());return true;}
  const s=configuredStore(env);
  const match=url.pathname.match(/^\/internal\/vouchers\/([a-f0-9-]{36})\/(image.png|redeem|cancel|send)$/);
  if(req.method==='POST'&&url.pathname==='/internal/vouchers/issue'){
   const data=JSON.parse((await readBody(req)).toString());const v=s.issue(data);send(res,200,{id:v.id,value:v.value,expiresAt:v.expiresAt,state:v.state,existing:v.existing});return true;
  }
  if(match){const [,id,action]=match;
   if(req.method==='GET'&&action==='image.png'){const v=s.get(id);if(!v){send(res,404,{error:'NOT_FOUND'});return true;}send(res,200,await voucherPNG(v,env.PUBLIC_APP_ORIGIN),'image/png');return true;}
   if(req.method==='POST'&&action==='redeem'){const data=JSON.parse((await readBody(req)).toString());if(data.confirmRedemption!==true)throw Error('VOUCHER_REDEMPTION_CONFIRMATION_REQUIRED');send(res,200,s.redeem(id,data.serviceReference));return true;}
   if(req.method==='POST'&&action==='cancel'){const data=JSON.parse((await readBody(req)).toString());if(data.confirmCancellation!==true)throw Error('VOUCHER_CANCELLATION_CONFIRMATION_REQUIRED');send(res,200,s.cancel(id));return true;}
   if(req.method==='POST'&&action==='send'){const data=JSON.parse((await readBody(req)).toString()),v=s.get(id);if(!v||v.state!=='valid')throw Error('VOUCHER_NOT_SENDABLE');if(!/^\d{8,15}$/.test(data.recipient||'')||data.confirmRecipient!==true)throw Error('VOUCHER_RECIPIENT_CONFIRMATION_REQUIRED');if(!sendImage)throw Error('VOUCHER_DELIVERY_UNAVAILABLE');const result=await sendImage(data.recipient,await voucherPNG(v,env.PUBLIC_APP_ORIGIN),`🎁 رحلتك معها هدية! فاوجر مجموعة الرمال باسم ${v.customerName} بقيمة ${v.value} درهم، صالح لسنة من الإصدار للاستخدام على طلب قادم. مسح الرمز للتحقق لا يستهلك الفاوجر.`,env);send(res,200,{acceptedByMeta:!result.dryRun,dryRun:Boolean(result.dryRun)});return true;}
  }
  send(res,404,{error:'NOT_FOUND'});
 }catch(e){const code=/^VOUCHER_[A-Z_]+$/.test(e.message)?e.message:'VOUCHER_REQUEST_FAILED';send(res,/STORAGE|DELIVERY_UNAVAILABLE/.test(code)?503:409,{error:code});}
 return true;
}
module.exports={handleVoucherRequest,ready};
