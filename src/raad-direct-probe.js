'use strict';
const http = require('node:http');
const {chromium} = require('playwright');
let state = {stage:'starting', authenticated:false};
let browser;
const server = http.createServer((req,res) => {
  res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(state));
});
server.listen(process.env.PORT || 10000, '0.0.0.0');
(async () => {
 try {
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const page = await browser.newPage();
  const response = await page.goto('https://visa.mofa.gov.sa/Account/Login/enjazcompany',{waitUntil:'domcontentloaded',timeout:45000});
  const url = new URL(page.url());
  state = {stage:'page_loaded',httpStatus:response?.status() || null,officialHost:url.hostname==='visa.mofa.gov.sa',authenticated:false, startedAt:new Date().toISOString()};
  console.log('MOFA_DIRECT_PROBE '+JSON.stringify(state));
  setTimeout(async()=>{state={...state,stage:'finished',pageOpen:!page.isClosed() && browser.isConnected()};console.log('MOFA_DIRECT_PROBE '+JSON.stringify(state));await browser.close();},120000).unref();
 } catch(e) { state={stage:'failed',reason:e.name === 'TimeoutError'?'timeout':'browser_or_navigation_error',authenticated:false};console.log('MOFA_DIRECT_PROBE '+JSON.stringify(state));if(browser)await browser.close().catch(()=>{}); }
})();
process.on('SIGTERM',async()=>{if(browser)await browser.close().catch(()=>{});server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();});
