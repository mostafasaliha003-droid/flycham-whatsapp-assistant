'use strict';
// Standalone prototype: mount behind the existing HTTPS/admin authentication.
// Never mount in production without reviewing origin, logging and secret handling.
const {validQueueKey}=require('./quote-jobs');
const {openHandoff}=require('./raad-direct-login-handoff');
function createLoginHandler({env=process.env,open=openHandoff}={}){
 let job=null,busy=false;
 const send=(res,status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(type==='application/json'?JSON.stringify(data):data);};
 return async function(req,res,url){
  if(!url.pathname.startsWith('/internal/raad-direct-login/'))return false;
  if(!validQueueKey(req.headers.authorization,env.ASSISTANT_ADMIN_KEY)){send(res,401,{error:'UNAUTHORIZED'});return true;}
  if(req.method!=='POST'||url.search||url.hash||req.headers.origin!==env.RAAD_LOGIN_ALLOWED_ORIGIN||!env.RAAD_LOGIN_ALLOWED_ORIGIN){send(res,403,{error:'FORBIDDEN'});return true;}
  if(busy){send(res,409,{error:'BUSY'});return true;}busy=true;
  try{
   if(url.pathname.endsWith('/start')){if(job)await job.close();job=await open();send(res,200,{ready:true});}
   else if(url.pathname.endsWith('/image')){if(!job){send(res,409,{error:'NOT_READY'});}else send(res,200,await job.image(),'image/png');}
   else if(url.pathname.endsWith('/submit')){if(!job){send(res,409,{error:'NOT_READY'});}else{let n=0,chunks=[];for await(const b of req){n+=b.length;if(n>2048)throw Error('TOO_LARGE');chunks.push(b);}let payload=JSON.parse(Buffer.concat(chunks).toString());chunks=[];const out=await job.submit(payload);payload=null;send(res,200,out);}}
   else if(url.pathname.endsWith('/close')){if(job)await job.close();job=null;send(res,200,{closed:true});}
   else send(res,404,{error:'NOT_FOUND'});
  }catch{if(job)await job.close().catch(()=>{});job=null;send(res,503,{error:'HANDOFF_UNAVAILABLE'});}finally{busy=false;}
  return true;
 };
}
module.exports={createLoginHandler};
