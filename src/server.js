'use strict';

const http = require('node:http');
const { verifyWebhookChallenge, verifySignature, extractIncomingMessages } = require('./whatsapp');
const { handleMessage } = require('./conversation');
const { sendTextMessage } = require('./graph-api');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;

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
      const result = handleMessage(message.from, message.text);
      await sendTextMessage(message.from, result.reply);
    } catch (error) {
      console.error(`Could not process inbound message ${message.id ?? '(no id)'}`, error.message);
    }
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
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
