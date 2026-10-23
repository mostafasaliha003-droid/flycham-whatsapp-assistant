'use strict';
const {aiConfigured,aiProvider}=require('./assistant-nlu');


const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { verifyWebhookChallenge, verifySignature, extractIncomingMessages } = require('./whatsapp');
const { AssistantEngine } = require('./assistant-engine');
const { MessageBatcher } = require('./message-batcher');
const {handleVoucherRequest}=require('./voucher-http');
const { sendImageMessage,sendTextMessage,checkWhatsAppConnection } = require('./graph-api');
const { QuoteJobs, validQueueKey } = require('./quote-jobs');
const { expandLiveRequests } = require('./live-quote');
const quoteJobs = new QuoteJobs();
const assistant=new AssistantEngine();
async function processCustomerMessages(sender,messages){
  const result=await assistant.handle(sender,messages.map(m=>m.text).join('، '),{quotedMessageId:messages.at(-1)?.contextId});
  let reply=result.reply;
  if(result.cancel)quoteJobs.cancel(sender);
  if(result.complete&&process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED==='true'){
    try{
      expandLiveRequests(result.request);quoteJobs.enqueue(sender,result.request);assistant.jobState(sender,'queued');
      const r=result.request;
      reply=`${result.comparison?'رح نقارن الخيار الجديد مع الحفاظ على طلبك الأساسي.':result.amendment?'تم تعديل طلبك مع الحفاظ على التفاصيل الأخرى.':'وصل طلبك.'}\nمن مطار ${r.origin} إلى ${r.destination}\nالفترة: ${r.departureRange?`${r.departureRange.start} إلى ${r.departureRange.end}`:r.departureDate}\n${r.passengers.adults} بالغ — ${r.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'}${r.baggageRequest?` — الوزن المطلوب ${r.baggageRequest.checkedWeightKg} كغ`:''}\nعم نفحص الخيارات المتاحة والأسعار والإضافات. أول ما تتأكد نتيجة منرسلها؛ الاستعلام لا ينشئ حجزًا.`;
      console.log('WHATSAPP_LIVE_QUOTE_QUEUED');
    }catch{assistant.jobState(sender,'failed');reply='تفاصيل طلبك محفوظة، لكن البحث غير جاهز الآن أو تعذر التحقق من الفترة المطلوبة. لم يتأكد سعر جديد؛ فينا نعيد المحاولة على نفس التفاصيل.';}
  }
  const delivery=await sendTextMessage(sender,reply);
  if(result.handoff&&process.env.HUMAN_HANDOFF_RECIPIENT){
    try{const s=assistant.state(sender),h=assistant.store.data.handoffs.find(x=>x.id===result.handoff);if(h&&h.state==='pending'){await sendTextMessage(process.env.HUMAN_HANDOFF_RECIPIENT,JSON.stringify({customer:sender,request:h.summary.request,offer:h.summary.offer,needsPriceRecheck:true}));h.state='notified';assistant.store.save();}}catch{console.log('HUMAN_HANDOFF_NOTIFICATION_FAILED');}
  }
  console.log(delivery?.dryRun?'WHATSAPP_TEST_REPLY_SUPPRESSED':'WHATSAPP_REPLY_ACCEPTED_BY_META');
}
const batcher=new MessageBatcher(processCustomerMessages,{delay:process.env.ASSISTANT_DEBOUNCE_MS===undefined?4000:Math.min(5000,Math.max(0,Number(process.env.ASSISTANT_DEBOUNCE_MS)||0))});

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const PRIVACY_PAGE = readFileSync(join(__dirname, 'privacy.html'));

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function handleWebhookPost(request, response) {
  const rawBody = await readBody(request);
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret && process.env.NODE_ENV === 'production') {
    response.writeHead(503).end('Webhook signing secret is not configured');
    return;
  }
  if (appSecret && !verifySignature(rawBody, request.headers['x-hub-signature-256'], appSecret)) {
    response.writeHead(401).end('Invalid signature');
    return;
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { response.writeHead(400).end('Invalid JSON'); return; }

  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ received: true }));
  for(const entry of payload.entry||[])for(const change of entry.changes||[])for(const status of change.value?.statuses||[]){
    if(typeof status.id==='string'&&['sent','delivered','read','failed'].includes(status.status))assistant.store.delivery(status.id,status.status);
  }
  for(const message of extractIncomingMessages(payload)){
    if(!quoteJobs.acceptMessage(message.id))continue;
    try{if(process.env.ASSISTANT_DEBOUNCE_MS==='0')await batcher.serial(message.from,[message]);else await batcher.push(message.from,message);}catch{console.error('WHATSAPP_REPLY_FAILED');}
  }
}

function claimJob(){const j=quoteJobs.claim();if(j)assistant.jobState(quoteJobs.jobs.get(j.id).recipient,'searching');return j||{};}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if(await handleVoucherRequest(request,response,url,{readBody,sendImage:sendImageMessage}))return;
    if(url.pathname.startsWith('/internal/quotes/')){
      if(process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED!=='true' || !validQueueKey(request.headers.authorization,process.env.AIR_ARABIA_QUOTE_QUEUE_KEY)){
        response.writeHead(401).end('Unauthorized');return;
      }
      if(request.method!=='POST'){response.writeHead(405).end();return;}
      try{
        const data=JSON.parse((await readBody(request)).toString('utf8'));
        if(url.pathname==='/internal/quotes/claim'){
          response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(claimJob()));return;
        }
        if(url.pathname==='/internal/quotes/current'){
          response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({current:quoteJobs.current(data.id,data.lease)}));return;
        }
        if(['/internal/quotes/complete','/internal/quotes/progress'].includes(url.pathname)){
          if(typeof data.reply!=='string'||data.reply.length>60000){response.writeHead(400).end();return;}
          const progress=url.pathname.endsWith('/progress');
          const job=progress?quoteJobs.takeProgress(data.id,data.lease,data.seq):quoteJobs.takeResult(data.id,data.lease);
          if(!job){response.writeHead(409).end();return;}
          try{
            let delivery;for(let i=0;i<data.reply.length;i+=3500)delivery=await sendTextMessage(job.recipient,data.reply.slice(i,i+3500));
            if(progress)assistant.progress(job.recipient,data.metadata||{},delivery?.messages?.[0]?.id);else{assistant.progress(job.recipient,{coverage:data.coverage||[]});assistant.jobState(job.recipient,data.outcome==='failed'?'failed':'done');}
            console.log(progress?'WHATSAPP_QUOTE_PROGRESS_ACCEPTED_BY_META':'WHATSAPP_LIVE_QUOTE_REPLY_ACCEPTED_BY_META');
            response.writeHead(200,{'Content-Type':'application/json'}).end('{"accepted":true}');
          }catch{
            console.log('WHATSAPP_LIVE_QUOTE_REPLY_FAILED');response.writeHead(502).end();
          }finally{if(!progress)quoteJobs.finish(data.id);}
          return;
        }
        response.writeHead(404).end();
      }catch{if(!response.headersSent)response.writeHead(400).end();}
      return;
    }
    if(request.method==='GET'&&['/operations','/operations.js'].includes(url.pathname)){
      response.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}).end(readFileSync(join(__dirname,url.pathname.endsWith('.js')?'operations.js':'operations.html')));return;
    }
    if(url.pathname.startsWith('/internal/assistant/')){
      if(!validQueueKey(request.headers.authorization,process.env.ASSISTANT_ADMIN_KEY)){response.writeHead(401).end();return;}
      if(url.pathname==='/internal/assistant/status'){response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(assistant.status()));return;}
      if(url.pathname==='/internal/assistant/handoffs'&&request.method==='GET'){response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(assistant.store.data.handoffs));return;}
      const action=url.pathname.match(/^\/internal\/assistant\/handoffs\/([a-f0-9-]+)\/(claim|release)$/);
      if(action&&request.method==='POST'){const h=assistant.store.data.handoffs.find(h=>h.id===action[1]);if(!h){response.writeHead(404).end();return;}const s=assistant.state(h.customer);s.humanOwned=action[2]==='claim';h.state=s.humanOwned?'claimed':'released';assistant.store.set(h.customer,s);response.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;}
      response.writeHead(404).end();return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/privacy') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': PRIVACY_PAGE.length,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Cache-Control': 'public, max-age=300'
      });
      response.end(request.method === 'HEAD' ? undefined : PRIVACY_PAGE);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'flycham-whatsapp-assistant', assistant:{version:'2026-10-23.1',aiConfigured:aiConfigured(process.env),aiProvider:aiProvider(process.env),persistentStorageConfigured:Boolean(process.env.ASSISTANT_STATE_PATH),humanRoutingConfigured:Boolean(process.env.HUMAN_HANDOFF_RECIPIENT)}, mode: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false' ? 'dry-run' : 'live' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/webhooks/whatsapp') {
      const challenge = verifyWebhookChallenge(url.searchParams, process.env.WHATSAPP_VERIFY_TOKEN);
      if (challenge === null) { response.writeHead(403).end('Verification failed'); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
      try { await handleWebhookPost(request, response); }
      catch (error) {
        console.error('WHATSAPP_WEBHOOK_PROCESSING_FAILED');
        if (!response.headersSent) response.writeHead(error.statusCode || 500).end('Webhook processing failed');
      }
      return;
    }
    response.writeHead(404).end('Not found');
  });
}

if (require.main === module) {
  checkWhatsAppConnection().then(code=>console.log(code));
  console.log('ASSISTANT_RUNTIME_'+JSON.stringify(assistant.status()));
  createServer().listen(PORT, () => console.log(`FlyCham WhatsApp Assistant listening on port ${PORT}`));
}

module.exports = { createServer, handleWebhookPost };
