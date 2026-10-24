'use strict';
const {aiStatus}=require('./assistant-nlu');
const {GmailOTP,gmailHandler}=require('./gmail-otp');
const handleGmail=gmailHandler(new GmailOTP());


const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { verifyWebhookChallenge, verifySignature, extractIncomingMessages } = require('./whatsapp');
const { AssistantEngine } = require('./assistant-engine');
const {FareCatalog}=require('./fare-catalog');
const {POLICY}=require('./assistant-policy');
const { MessageBatcher } = require('./message-batcher');
const {handleVoucherRequest}=require('./voucher-http');
const { sendImageMessage,sendTextMessage,checkWhatsAppConnection } = require('./graph-api');
const { QuoteJobs, validQueueKey } = require('./quote-jobs');
const {recordDeliveryStatuses,comparisonDeliverySummary}=require('./delivery-status');
const { expandLiveRequests } = require('./live-quote');
const {DeliveryOutbox}=require('./delivery-outbox');
const {recordMetric,metricsSummary}=require('./consultant-metrics');
const {validateSearchCommand}=require('./consultant-tools');
const {updateConsultantStage}=require('./consultant-memory');
const {enabled:consultantEnabled,recommendationFor}=require('./consultant-runtime');
const {offerKey}=require('./quote-comparison');
const {runConsultantSmoke}=require('./consultant-brain');
let consultantSmoke={ran:false,greeting:false,search:false,context:false};
const assistant=new AssistantEngine();
const quoteJobs = new QuoteJobs({store:assistant.store});
const catalog=new FareCatalog({store:assistant.store,enabled:process.env.FARE_CATALOG_ENABLED!=='false'});
const deliveries=new Map();
function orderedDelivery(id,task){const work=(deliveries.get(id)||Promise.resolve()).catch(()=>{}).then(task);deliveries.set(id,work);work.finally(()=>{if(deliveries.get(id)===work)deliveries.delete(id);}).catch(()=>{});return work;}

const outbox=new DeliveryOutbox({store:assistant.store,send:sendTextMessage,report:code=>console.log(code),
 isCurrent:async item=>{await batcher.settled(item.recipient);const c=quoteJobs.comparisons.get(item.metadata.comparisonId);return c?quoteJobs.isComparisonCurrent(c.id)&&c.revision===item.metadata.revision:item.state==='sent';},
 onChunkSent:async(item,index,chunk)=>{
  const state=assistant.state(item.recipient);
  if(chunk.messageId){state.offerMessages||={};state.offerMessages[chunk.messageId]=[...chunk.text.matchAll(/\*الخيار (\d+) —/g)].map(m=>Number(m[1]));state.offerMessages=Object.fromEntries(Object.entries(state.offerMessages).slice(-100));}
  const refs=new Set([...chunk.text.matchAll(/\*الخيار (\d+) —/g)].map(m=>Number(m[1])));
  for(const offer of item.metadata.offers||[])if(refs.has(offer.reference))assistant.progress(item.recipient,{offer},chunk.messageId);
  // progress writes current state; merge just the message map, never an old snapshot.
  const current=assistant.state(item.recipient);current.offerMessages=state.offerMessages;
  if(refs.size){updateConsultantStage(current,'offers_verified');recordMetric(assistant.store,{customer:item.recipient,journey:item.metadata.journey,event:'first_offer'});}
  assistant.store.set(item.recipient,current);
 },
 onComplete:async item=>{
  const m=item.metadata;
  const c=quoteJobs.comparisons.get(m.comparisonId);
  if(c&&c.revision!==m.revision)return;
  const active=assistant.state(item.recipient).activeComparisonId===m.comparisonId;
  quoteJobs.acknowledgeDelivery(m.comparisonId,{final:m.final,offerKeys:m.offerKeys,fingerprint:m.fingerprint});
  if(active){assistant.jobState(item.recipient,m.final?(m.hasOffers?'done':'failed'):'searching');
   if(m.final){if(!m.hasOffers)assistant.proposeSearchExpansion(item.recipient);recordMetric(assistant.store,{customer:item.recipient,journey:m.journey,event:m.hasOffers?'search_completed':'search_failed'});const state=assistant.state(item.recipient);state.queueReady=true;assistant.store.set(item.recipient,state);continueQueuedRequest(item.recipient);}}
  console.log(m.final?'WHATSAPP_COMPARISON_FINAL_ACCEPTED_BY_META':'WHATSAPP_COMPARISON_PARTIAL_ACCEPTED_BY_META');
 }});
async function deliverComparison(id,{partial=false}={}){
 const first=quoteJobs.comparisonResult(id);if(!first)return;
 return orderedDelivery(first.recipient,async()=>{
  await batcher.settled(first.recipient);
  const current=quoteJobs.comparisonResult(id);if(!current)return;
  const final=current.ready;
  if(!final&&(!partial||!current.hasVerifiedOffers||current.partialAlreadyDelivered))return;
  const unresolved=assistant.store.data.outbox.find(item=>item.metadata?.comparisonId===id&&(['pending','sending','uncertain','failed'].includes(item.state)||item.state==='sent'&&!item.completionNotified));
  if(unresolved){if(['uncertain','failed'].includes(unresolved.state)){recordMetric(assistant.store,{customer:current.recipient,journey:unresolved.metadata.journey,event:'delivery_uncertain'});return;}await outbox.flush(unresolved.key);return;}
  const snapshotParent=quoteJobs.comparisons.get(id);
  if(!final&&snapshotParent.lastPartialAt&&Date.now()-snapshotParent.lastPartialAt<60000)return;
  const key='comparison:'+id+':'+(final?'final':current.deliveryFingerprint);
  const existing=outbox.get(key);
  if(existing){await outbox.flush(key);return;}
  const parent=quoteJobs.comparisons.get(id),state=assistant.state(current.recipient);
  let reply=current.reply;
  if(consultantEnabled(process.env)&&current.hasVerifiedOffers){const intro=recommendationFor(current.offers,state,current.request);if(intro)reply=intro+'\n\n'+reply;}
  outbox.enqueue({key,recipient:current.recipient,chunks:messageChunks(reply),metadata:{comparisonId:id,revision:parent.revision,final,fingerprint:current.deliveryFingerprint,offerKeys:current.offers.map(offerKey),offers:current.offers,hasOffers:current.hasVerifiedOffers,journey:state.tripId||id}});
  await outbox.flush(key);
 });
}
async function sendSearchWaiting(id){
 const c=quoteJobs.comparisons.get(id);if(!c||c.waitingNotified||Date.now()-c.createdAt<90000||c.children.some(x=>x.offers?.length)||!quoteJobs.isComparisonCurrent(id))return;
 return orderedDelivery(c.recipient,async()=>{
  await batcher.settled(c.recipient);if(!quoteJobs.isComparisonCurrent(id)||c.waitingNotified||c.children.some(x=>x.offers?.length))return;
  // One status notice per search; avoid repeated spam and unsupported progress claims.
  c.waitingNotified=true;quoteJobs.save();
  const recent=c.lastProgressAt&&Date.now()-c.lastProgressAt<120000;
  const text=recent?'شكرًا لصبرك 🌷 عم نكمّل فحص الخيارات حسب تفاصيل رحلتك. لسه ما تأكد عرض جاهز للإرسال، ومنرسلك أول نتيجة مؤكدة فور توفرها.':'بنعتذر منك على الانتظار 🌷 طلبك ما زال قيد التحقق، لكن لم يتأكد عرض جاهز للإرسال حتى الآن. ما في داعي تعيد تفاصيل الرحلة.';
  try{await sendTextMessage(c.recipient,text);}catch{console.log('WHATSAPP_WAITING_NOTICE_FAILED');}
 });
}

function messageChunks(text){
 const chunks=[];let current='';
 for(const part of text.split('\n\n')){
  if(current&&current.length+part.length+2>3500){chunks.push(current);current='';}
  if(part.length>3500){if(current){chunks.push(current);current='';}for(let i=0;i<part.length;i+=3500)chunks.push(part.slice(i,i+3500));}
  else current+=(current?'\n\n':'')+part;
 }
 if(current)chunks.push(current);return chunks;
}

function prepareCustomerMessages(sender,messages){const state=assistant.state(sender);messages=messages.map((m,i)=>({...m,order:i})).sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0)||a.order-b.order);const refs=[...new Set(messages.map(m=>m.contextId).filter(Boolean))];return assistant.prepare(sender,messages.map(m=>m.text).join('، '),{quotedMessageId:refs.length===1?refs[0]:null,turnMessages:messages.map(m=>({text:m.text,quotedOfferReference:state.offers.find(o=>o.messageId===m.contextId)?.reference||null}))});}
function continueQueuedRequest(sender){setTimeout(()=>{batcher.serial(sender,[]).catch(()=>console.log('WHATSAPP_QUEUED_REQUEST_FAILED'));},0).unref();}
async function processCustomerMessages(sender,messages){
  if(!messages.length){const next=assistant.beginNextRequest(sender);if(!next)return;messages=[{text:next.text,timestamp:Math.floor(Date.now()/1000)}];}
  messages=messages.map((m,i)=>({...m,order:i})).sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0)||a.order-b.order);
  const text=messages.map(m=>m.text).join('، ');
  const state=assistant.state(sender),prior=state.base?.request;
  const broad=/سوريا|سوريه|سورية|رحلات|طيران|اسعار|أسعار/.test(text)&&!prior?.departureDate&&!prior?.departureRange&&!/\d|بكرا|بكره|اسبوع|أسبوع|الاثنين|الثلاثاء/.test(text);
  const references=[...new Set(messages.map(m=>m.contextId).filter(Boolean))];
  const turnMessages=messages.map(m=>({text:m.text,quotedOfferReference:state.offers.find(o=>o.messageId===m.contextId)?.reference||null}));
  const result=await assistant.handle(sender,text,{quotedMessageId:references.length===1?references[0]:null,turnMessages});
  if(broad){const request=assistant.state(sender).base?.request||{};const card=catalog.reply(request);if(card&&!result.complete){
   const missing=[];if(!request.departureDate&&!request.departureRange)missing.push('عندك أيام معيّنة ببالك');if(!request.passengers)missing.push('كم عدد المسافرين');if(!request.tripType)missing.push('ذهاب بس أو مع رجعة');
   const reply=(result.introduction?result.introduction+'\n\n':'')+card+(missing.length?'\n'+missing.join('، ')+'؟':'');await sendTextMessage(sender,reply);return;
  }}
  let reply=result.reply;
  if(result.cancel)quoteJobs.cancel(sender);
  if(result.complete&&process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED==='true'){
    try{
      expandLiveRequests(result.request);
      const proposed=assistant.state(sender);
      if(consultantEnabled(process.env)){const version=proposed.consultant?.requestVersion;validateSearchCommand({request:result.request,requestVersion:version,expectedVersion:assistant.state(sender).consultant?.requestVersion,action:result.amendment?'amend':'search'});}
      const providers=result.request.providerExclusive&&result.request.provider?[result.request.provider]:POLICY.providers;
      const seeds=require('./airport-comparison').airportSearchPlan(result.request,providers).requests.flatMap(item=>catalog.find(item.request));
      const comparison=quoteJobs.enqueueComparison(sender,result.request,{providers,seedOffers:seeds,compareFlyChamAirports:true,waitForProviders:true});
      const conversation=assistant.state(sender);conversation.previousComparisonOffers=conversation.offers.slice(-80);conversation.offers=[];conversation.selected=null;conversation.activeComparisonId=comparison.id;conversation.queueReady=false;conversation.status='queued';assistant.store.set(sender,conversation);
      if(comparison.ready)setTimeout(()=>deliverComparison(comparison.id).catch(()=>console.log('WHATSAPP_COMPARISON_DELIVERY_FAILED')),0).unref();
      const r=result.request;
      reply=`*طلب رحلتك قيد البحث ✈️*\n${result.comparison?'رح نقارن الخيار الجديد مع الحفاظ على طلبك الأساسي.':result.amendment?'تم تعديل طلبك مع الحفاظ على التفاصيل الأخرى.':'وصل طلبك.'}\nمن مطار ${r.origin} إلى ${r.destination}\n📅 الفترة: ${r.departureRange?`${r.departureRange.start} إلى ${r.departureRange.end}`:r.departureDate}\n👤 المسافرون: ${r.passengers.adults} بالغ — ${r.tripType==='one_way'?'ذهاب فقط':'ذهاب وعودة'}${r.baggageRequest?` — الوزن المطلوب ${r.baggageRequest.checkedWeightKg} كغ`:''}\nعم نقارن ${require('./airport-comparison').searchPlanText(r,providers)}. أي مطار بديل رح نوضحه ضمن عرضه لتختار المناسب إلك. رح نوضح مطار المغادرة والوزن والسعر النهائي لكل خيار. \n\n⏳ يرجى الانتظار، جاري البحث عن الخيارات المناسبة والتحقق من السعر النهائي. منرسلك العروض مع التواريخ والتواقيت فور تأكيدها.`;
      updateConsultantStage(conversation,'search_started');assistant.store.set(sender,conversation);recordMetric(assistant.store,{customer:sender,journey:conversation.tripId,event:'search_queued'});
      console.log('WHATSAPP_LIVE_QUOTE_QUEUED');
    }catch{assistant.jobState(sender,'failed');reply='تفاصيل طلبك محفوظة، لكن البحث غير جاهز الآن أو تعذر التحقق من الفترة المطلوبة. لم يتأكد سعر جديد؛ فينا نعيد المحاولة على نفس التفاصيل.';}
  }
  if(result.introduction&&!reply.includes(result.introduction))reply=result.introduction+'\n\n'+reply;
  const delivery=await sendTextMessage(sender,reply);
  recordMetric(assistant.store,{customer:sender,journey:assistant.state(sender).tripId,event:'reply_sent'});
  if(result.handoff){const h=assistant.store.data.handoffs.find(x=>x.id===result.handoff);if(h){h.journey=assistant.state(sender).tripId;assistant.store.save();}}
  if(result.handoff&&process.env.HUMAN_HANDOFF_RECIPIENT){
    try{const s=assistant.state(sender),h=assistant.store.data.handoffs.find(x=>x.id===result.handoff);if(h&&h.state==='pending'){await sendTextMessage(process.env.HUMAN_HANDOFF_RECIPIENT,JSON.stringify({customer:sender,request:h.summary.request,offer:h.summary.offer,needsPriceRecheck:true}));h.state='notified';assistant.store.save();}}catch{console.log('HUMAN_HANDOFF_NOTIFICATION_FAILED');}
  }
  console.log(delivery?.dryRun?'WHATSAPP_TEST_REPLY_SUPPRESSED':'WHATSAPP_REPLY_ACCEPTED_BY_META');
}
const batcher=new MessageBatcher(processCustomerMessages,{store:assistant.store,prepare:prepareCustomerMessages,delay:process.env.ASSISTANT_DEBOUNCE_MS===undefined?35000:Math.min(180000,Math.max(0,Number(process.env.ASSISTANT_DEBOUNCE_MS)||0)),maxWait:180000,onError:()=>console.error('WHATSAPP_REPLY_FAILED')});

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
  recordDeliveryStatuses(payload,assistant.store);
  for(const message of extractIncomingMessages(payload)){
    if(!quoteJobs.acceptMessage(message.id))continue;
    quoteJobs.save();
    const fast=!batcher.busy(message.from)&&['searching','queued'].includes(assistant.state(message.from).status)&&/^(?:شكرا|شكراً|ناطر|ناطرين|بانتظاركن|بانتظار|منتظر|شو صار|وين وصلتوا|شكرا ناطرك|تمام|اوكي|حاضر)[؟?!. ]*$/.test(message.text);
    const pending=(process.env.ASSISTANT_DEBOUNCE_MS==='0'||fast)?batcher.serial(message.from,[message]):batcher.push(message.from,message);pending.catch(()=>console.error('WHATSAPP_REPLY_FAILED'));
    if(process.env.ASSISTANT_DEBOUNCE_MS==='0')await pending;
  }
}

function claimJob(provider,{includeCatalog=true}={}){const j=quoteJobs.claim(provider);if(j)assistant.jobState(quoteJobs.jobs.get(j.id).recipient,'searching');const waiting=[...quoteJobs.jobs.values()].some(job=>job.state==='pending'&&(job.request.provider||'airarabia')===(provider||'airarabia'));return j||(includeCatalog&&!waiting?catalog.claim(provider||'airarabia'):null)||{};}

function createServer() {
  const server=http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if(await handleGmail(request,response,url,{readBody}))return;
    if(await handleVoucherRequest(request,response,url,{readBody,sendImage:sendImageMessage}))return;
    if(url.pathname.startsWith('/internal/quotes/')){
      if(process.env.AIR_ARABIA_QUOTE_QUEUE_ENABLED!=='true' || !validQueueKey(request.headers.authorization,process.env.AIR_ARABIA_QUOTE_QUEUE_KEY)){
        response.writeHead(401).end('Unauthorized');return;
      }
      if(request.method!=='POST'){response.writeHead(405).end();return;}
      try{
        const data=JSON.parse((await readBody(request)).toString('utf8'));
        if(url.pathname==='/internal/quotes/heartbeat'){
          if(!['airarabia','flycham'].includes(data.provider)){response.writeHead(400).end();return;}
          const at=data.ready===false?0:Date.now();quoteJobs.providerAt.set(data.provider,at);if(data.provider==='airarabia')quoteJobs.workerAt=at;
          response.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;
        }
        if(url.pathname==='/internal/quotes/claim'){
          response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(claimJob(data.provider,{includeCatalog:data.includeCatalog!==false})));return;
        }
        if(url.pathname==='/internal/quotes/current'){
          response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({current:String(data.id).startsWith('catalog-')?catalog.current(data.id,data.lease)&&![...quoteJobs.jobs.values()].some(j=>['pending','claimed'].includes(j.state)&&(j.request.provider||'airarabia')===(catalog.leases.get(data.id)?.request.provider)):quoteJobs.current(data.id,data.lease)}));return;
        }
        if(['/internal/quotes/complete','/internal/quotes/progress'].includes(url.pathname)){
          if(typeof data.reply!=='string'||data.reply.length>60000){response.writeHead(400).end();return;}
          const progress=url.pathname.endsWith('/progress');
          if(String(data.id).startsWith('catalog-')){
            const ok=progress?catalog.progress(data.id,data.lease,data.metadata):catalog.finish(data.id,data.lease,data.outcome,data.coverage);
            response.writeHead(ok?200:409,{'Content-Type':'application/json'}).end(JSON.stringify({accepted:ok}));return;
          }
          const candidate=quoteJobs.jobs.get(data.id);
          if(!candidate||candidate.lease!==data.lease||candidate.state!=='claimed'){response.writeHead(409).end();return;}
          if(progress){
            if(!quoteJobs.takeProgress(data.id,data.lease,data.seq)){response.writeHead(409).end();return;}
            if(data.metadata?.offer)catalog.acceptOffer(data.metadata.offer,candidate.request.provider||'airarabia');
          }
          if(candidate.comparisonId){
            let comparison;
            if(progress){quoteJobs.comparisonProgress(data.id,data.lease,data.metadata||{});comparison=quoteJobs.comparisonResult(candidate.comparisonId);}
            else comparison=quoteJobs.completeComparisonChild(data.id,data.lease,data);
            response.writeHead(200,{'Content-Type':'application/json'}).end('{"accepted":true,"deferred":true}');
            if(comparison?.ready)deliverComparison(candidate.comparisonId).catch(()=>console.log('WHATSAPP_COMPARISON_DELIVERY_FAILED'));
            return;
          }
          const deliver=()=>orderedDelivery(candidate.recipient,async()=>{
            await batcher.settled(candidate.recipient);
            if(!quoteJobs.current(data.id,data.lease))return;
            if(progress){assistant.progress(candidate.recipient,data.metadata||{});return;}
            const job=quoteJobs.takeResult(data.id,data.lease);if(!job)return;
            try{
              let delivery;for(let i=0;i<data.reply.length;i+=3500)delivery=await sendTextMessage(job.recipient,data.reply.slice(i,i+3500));
              assistant.progress(job.recipient,{coverage:data.coverage||[]});assistant.jobState(job.recipient,data.outcome==='failed'?'failed':'done');
              console.log('WHATSAPP_LIVE_QUOTE_REPLY_ACCEPTED_BY_META');
            }catch{console.log('WHATSAPP_LIVE_QUOTE_REPLY_FAILED');}finally{quoteJobs.finish(data.id);}
          });
          if(batcher.busy(candidate.recipient)){response.writeHead(200,{'Content-Type':'application/json'}).end('{"accepted":true,"deferred":true}');deliver().catch(()=>console.log('WHATSAPP_LIVE_QUOTE_REPLY_FAILED'));}
          else{await deliver();response.writeHead(200,{'Content-Type':'application/json'}).end('{"accepted":true}');}
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
      if(url.pathname==='/internal/assistant/status'){response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...assistant.status(),catalog:catalog.status(),messageWindowMs:batcher.delay,consultant:{enabled:consultantEnabled(process.env),webResearchConfigured:Boolean(process.env.BRAVE_SEARCH_API_KEY),outbox:outbox.stats(),metrics:metricsSummary(assistant.store)}}));return;}
      if(url.pathname==='/internal/assistant/handoffs'&&request.method==='GET'){response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(assistant.store.data.handoffs));return;}
      const issued=url.pathname.match(/^\/internal\/assistant\/handoffs\/([a-f0-9-]+)\/issued$/);
      if(issued&&request.method==='POST'){const data=JSON.parse((await readBody(request)).toString());const h=assistant.store.data.handoffs.find(x=>x.id===issued[1]);if(!h||h.state!=='claimed'||data.ticketConfirmed!==true){response.writeHead(409).end();return;}h.state='issued';h.issuedAt=Date.now();const s=assistant.state(h.customer);updateConsultantStage(s,{type:'ticket_issued',verified:true});s.humanOwned=false;s.status='done';s.handoffId=null;assistant.store.set(h.customer,s);recordMetric(assistant.store,{customer:h.customer,journey:h.journey||s.tripId,event:'issued'});response.writeHead(200).end('{"ok":true}');return;}
      const action=url.pathname.match(/^\/internal\/assistant\/handoffs\/([a-f0-9-]+)\/(claim|release)$/);
      if(action&&request.method==='POST'){const h=assistant.store.data.handoffs.find(h=>h.id===action[1]);if(!h){response.writeHead(404).end();return;}const s=assistant.state(h.customer);s.humanOwned=action[2]==='claim';h.state=s.humanOwned?'claimed':'released';recordMetric(assistant.store,{customer:h.customer,journey:h.journey||s.tripId,event:s.humanOwned?'claimed':'released'});assistant.store.set(h.customer,s);response.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;}
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
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'flycham-whatsapp-assistant', assistant:{version:'2026-10-25.airport-routing.1',configuredProviders:POLICY.providers,consultantEnabled:consultantEnabled(process.env),consultantSmoke,webResearchConfigured:Boolean(process.env.BRAVE_SEARCH_API_KEY),...aiStatus(process.env),messageWindowMs:batcher.delay,messageMaxWaitMs:batcher.maxWait,defaultCheckedBaggageKg:30,catalog:catalog.status(),persistentStorageConfigured:Boolean(assistant.store.file),durableStorageConfirmed:assistant.store.status().durableStorageConfirmed,humanRoutingConfigured:Boolean(process.env.HUMAN_HANDOFF_RECIPIENT),flychamCredentialsConfigured:Boolean(process.env.FLYCHAM_AGENT_USERNAME&&process.env.FLYCHAM_AGENT_PASSWORD),airarabiaWorkerReady:quoteJobs.ready('airarabia'),flychamWorkerReady:quoteJobs.ready('flycham'),comparisonEnabled:true,nearbyAlternativeDays:3}, mode: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false' ? 'dry-run' : 'live' }));
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
  const sweep=setInterval(()=>{
   for(const [sender,state] of Object.entries(assistant.store.data.customers))if(state.queueReady&&['done','failed'].includes(state.status)&&state.pendingRequests?.length&&!batcher.busy(sender))continueQueuedRequest(sender);
   for(const key of outbox.due())outbox.flush(key).catch(()=>console.log('OUTBOX_SWEEP_FAILED'));
   for(const c of quoteJobs.comparisons.values())sendSearchWaiting(c.id).catch(()=>console.log('WHATSAPP_WAITING_NOTICE_FAILED'));
   for(const result of quoteJobs.dueComparisons())deliverComparison(result.id).catch(()=>console.log('WHATSAPP_COMPARISON_DELIVERY_FAILED'));
   for(const c of quoteJobs.comparisons.values())if(!c.delivered&&Date.now()-c.createdAt>=60000)deliverComparison(c.id,{partial:true}).catch(()=>console.log('WHATSAPP_COMPARISON_DELIVERY_FAILED'));
  },5000);sweep.unref();server.once('close',()=>clearInterval(sweep));return server;
}

if (require.main === module) {
  if(consultantEnabled(process.env))runConsultantSmoke({env:process.env}).then(result=>{consultantSmoke=result;console.log('CONSULTANT_SMOKE_'+JSON.stringify(result));}).catch(()=>console.log('CONSULTANT_SMOKE_UNAVAILABLE'));
  checkWhatsAppConnection().then(code=>console.log(code));
  console.log('ASSISTANT_RUNTIME_'+JSON.stringify({...assistant.status(),catalog:catalog.status(),messageWindowMs:batcher.delay,consultant:{enabled:consultantEnabled(process.env),webResearchConfigured:Boolean(process.env.BRAVE_SEARCH_API_KEY),outbox:outbox.stats(),metrics:metricsSummary(assistant.store)}}));
  console.log('WHATSAPP_COMPARISON_DELIVERY_HISTORY_'+JSON.stringify(comparisonDeliverySummary(assistant.store)));
  createServer().listen(PORT, () => console.log(`FlyCham WhatsApp Assistant listening on port ${PORT}`));
}

module.exports = { createServer, handleWebhookPost };

