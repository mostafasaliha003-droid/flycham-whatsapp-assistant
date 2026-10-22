'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { verifyWebhookChallenge, verifySignature, extractIncomingMessages } = require('./whatsapp');
const { handleMessage } = require('./conversation');
const { sendTextMessage } = require('./graph-api');
const { QuoteJobs, validQueueKey } = require('./quote-jobs');
const { expandLiveRequests } = require('./live-quote');
const quoteJobs = new QuoteJobs();

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
  for (const message of extractIncomingMessages(payload)) {
    try {
      const queueEnabled=process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED==='true';
      if(queueEnabled && !quoteJobs.acceptMessage(message.id))continue;
      const result = handleMessage(message.from, message.text);
      let reply=result.reply;
      if(result.complete && queueEnabled){
        try{
          expandLiveRequests(result.request);
          quoteJobs.enqueue(message.from,result.request);
          reply=`وصل طلبك. المقارنة ${result.request.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'} لشخص بالغ واحد. رح نفحص التواريخ والتواقيت ونرسل الأسعار على دفعات. المقارنة الواسعة قد تستغرق وقتًا، وأي نقص بالفحص رح نوضّحه. هذا استعلام فقط دون حجز.`;
          console.log('WHATSAPP_LIVE_QUOTE_QUEUED');
        }catch{
          reply='البحث الآلي التجريبي يدعم حاليًا الشارقة–دمشق لشخص بالغ واحد، عندما تكون البوابة متصلة. هذا الطلب يحتاج مراجعة موظف؛ لم يُؤكد أي سعر.';
        }
      }
      const delivery=await sendTextMessage(message.from,reply);
      console.log(delivery?.dryRun ? 'WHATSAPP_TEST_REPLY_SUPPRESSED' : 'WHATSAPP_REPLY_ACCEPTED_BY_META');
    } catch (error) {
      console.error('WHATSAPP_REPLY_FAILED');
    }
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if(url.pathname.startsWith('/internal/quotes/')){
      if(process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED!=='true' || !validQueueKey(request.headers.authorization,process.env.AIR_ARABIA_QUOTE_QUEUE_KEY)){
        response.writeHead(401).end('Unauthorized');return;
      }
      if(request.method!=='POST'){response.writeHead(405).end();return;}
      try{
        const data=JSON.parse((await readBody(request)).toString('utf8'));
        if(url.pathname==='/internal/quotes/claim'){
          response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(quoteJobs.claim()||{}));return;
        }
        if(['/internal/quotes/complete','/internal/quotes/progress'].includes(url.pathname)){
          if(typeof data.reply!=='string'||data.reply.length>12000){response.writeHead(400).end();return;}
          const progress=url.pathname.endsWith('/progress');
          const job=progress?quoteJobs.takeProgress(data.id,data.lease,data.seq):quoteJobs.takeResult(data.id,data.lease);
          if(!job){response.writeHead(409).end();return;}
          try{
            for(let i=0;i<data.reply.length;i+=3500)await sendTextMessage(job.recipient,data.reply.slice(i,i+3500));
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
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'flycham-whatsapp-assistant', mode: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false' ? 'dry-run' : 'live' }));
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
        console.error('Webhook request failed:', error.message);
        if (!response.headersSent) response.writeHead(error.statusCode || 500).end('Webhook processing failed');
      }
      return;
    }
    response.writeHead(404).end('Not found');
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`FlyCham WhatsApp Assistant listening on port ${PORT}`));
}

module.exports = { createServer, handleWebhookPost };
