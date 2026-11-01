'use strict';
// Execute only inside the locally built image using --network none. No real data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const http = require('node:http');
const requireApp = createRequire('/app/package.json');
const sharp = requireApp('sharp');
const checks = [], entrypointChecks = [], pdfTools = {};
let modelVerification;
async function check(name, operation) {
  await operation(); checks.push(name); console.log('PASS ' + name);
}
async function entrypoint(relative, port, pilot) {
  const env = {
    PATH: process.env.PATH, TMPDIR: '/tmp', NODE_ENV: 'test',
    PORT: String(port), DRY_RUN: 'true', SAUDI_VISA_ENABLED: 'false',
    RAAD_VISA_AUTOMATION_ENABLED: 'false', FARE_CATALOG_ENABLED: 'false',
    CONSULTANT_ORCHESTRATOR_ENABLED: 'false',
    RAAD_PILOT_STARTUP_CHECK: 'false',
    RAAD_PILOT_KEY: 'synthetic-container-test-key-000000000000000000000000000000',
    RAAD_PILOT_ORIGIN: 'https://container-test.invalid',
  };
  const child = spawn(process.execPath, ['/app/' + relative], {
    cwd: '/app', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain output but never include unexpected runtime payloads in this report.
  child.stdout.resume(); child.stderr.resume();
  let spawnError; child.once('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    let value;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw Error('ENTRYPOINT_EXITED');
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health', {
          signal: AbortSignal.timeout(500),
        });
        assert.equal(response.status, 200); value = await response.json(); break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(value, 'HEALTH_NOT_READY');
    if (pilot) {
      assert.equal(value.production.enabled, false);
      assert.equal(value.production.activeJob, false);
    } else {
      assert.equal(value.mode, 'dry-run');
      assert.equal(value.assistant.saudiVisa.enabled, false);
    }
    entrypointChecks.push({command:'node '+relative,cwd:'/app',healthStatus:200,kind:pilot?'raad_override':'main_disabled',productionEnabled:pilot?false:null,activeJob:pilot?false:null,mode:pilot?null:'dry-run',harnessSubmittedPortalJobs:0});
  } finally {
    child.kill('SIGTERM');
    const killed = setTimeout(() => child.kill('SIGKILL'), 6000);
    await closed; clearTimeout(killed);
  }
}
async function main() {
  await check('operator-readiness-tool-and-model-notice', async () => {
    await fs.access('/app/scripts/raad-readiness-check.js');
    const notice = await fs.readFile('/app/THIRD_PARTY_MRZ_MODEL.md', 'utf8');
    assert.ok(notice.includes('BSD 3-Clause License'));
  });
  await check('model-size-and-hash', async () => {
    const bytes = await fs.readFile('/app/var/mrz-model/mrz.traineddata');
    assert.equal(bytes.length, 1452847);
    const digest=createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest,'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01');
    const stat=await fs.stat('/app/var/mrz-model/mrz.traineddata');
    assert.equal(stat.size,bytes.length);
    modelVerification={method:'direct_model_read',phase:'original_worker_before_python_overlay',verifiedByUid:process.getuid(),bytes:bytes.length,sha256:digest,fileOwnerUid:stat.uid,fileMode:(stat.mode&0o777).toString(8),permissionsChanged:false};
    assert.equal(modelVerification.verifiedByUid,0);
  });
  await check('sharp-native-image', async () => {
    const png = await sharp({create: {width: 100, height: 80, channels: 3,
      background: 'white'}}).rotate(90).png().toBuffer();
    const info = await sharp(png).metadata();
    assert.equal(info.width, 80); assert.equal(info.height, 100);
  });
  await check('qr-generation', async () => {
    const bytes = await requireApp('qrcode').toBuffer('SYNTHETIC-CONTAINER-TEST');
    assert.ok(bytes.length > 100);
  });
  await check('tesseract-local-mrz-runtime', async () => {
    const worker = await requireApp('tesseract.js').createWorker('mrz', 1, {
      langPath: '/app/var/mrz-model', cachePath: '/tmp', cacheMethod: 'none',
      gzip: false, legacyCore: false, legacyLang: false,
      logger: () => {}, errorHandler: () => {},
    });
    try {
      const blank = await sharp({create: {width: 600, height: 100,
        channels: 3, background: 'white'}}).png().toBuffer();
      const result = await worker.recognize(blank);
      assert.equal(typeof result.data.text, 'string');
      // This checks the native/model runtime, not MRZ accuracy on real documents.
    } finally { await worker.terminate(); }
  });
  await check('application-owned-optical-child-runtime', async () => {
    const {createOpticalMrz} = requireApp('/app/src/visa-mrz-optical.js');
    const optical = createOpticalMrz();
    assert.equal(optical.status().configured, true);
    const blank = await sharp({create: {width: 1000, height: 600,
      channels: 3, background: 'white'}}).png().toBuffer();
    await assert.rejects(optical.extract({bytes: blank, mimeType: 'image/png',
      format: 'TD3', guard: async () => true,
    }), error => error.code === 'MRZ_OPTICAL_READ_FAILED');
    assert.equal(optical.status().busy, false);
    assert.equal(optical.status().ready, true);
    // Expected rejection proves owned child/model operation, not OCR accuracy.
  });
  await check('pdf-tools', async () => {
    for (const tool of ['pdfinfo', 'pdftoppm']) {
      const r=spawnSync(tool,['-v'],{encoding:'utf8',stdio:'pipe',timeout:3000});
      assert.equal(r.status,0);assert.equal(r.error,undefined);
      const first=(r.stdout+r.stderr).split('\n')[0];
      const match=new RegExp('^'+tool+' version ([0-9]+\\.[0-9]+\\.[0-9]+)$').exec(first);
      assert.ok(match);pdfTools[tool]=match[1];
    }
  });
  await check('synthetic-pdf-conversion', async () => {
    const {rasterizePdfPages} = requireApp('/app/src/raad-pdf.js');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
    ];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    for (let index = 0; index < objects.length; index++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += (index+1) + ' 0 obj\n' + objects[index] + '\nendobj\n';
    }
    const xref = Buffer.byteLength(pdf);
    pdf += 'xref\n0 5\n0000000000 65535 f \n';
    for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
    pdf += 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    const result = await rasterizePdfPages(Buffer.from(pdf));
    assert.equal(result.pageCount, 2);
    for (const page of result.pages) assert.ok((await sharp(page.bytes).metadata()).width > 0);
  });
  await check('chromium-local-no-network', async () => {
    const browser = await requireApp('playwright').chromium.launch({headless: true,
      args: ['--no-sandbox']});
    try {
      const context = await browser.newContext();
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      await page.setContent('<title>Synthetic container check</title><p>TEST</p>');
      assert.equal(await page.title(), 'Synthetic container check');
    } finally { await browser.close(); }
  });
  await check('native-chromium-redirect-fence-before-follow', async () => {
    let loginRequests = 0, forbiddenRequests = 0, blocked = 0, fulfills = 0;
    const fixture = http.createServer((request, response) => {
      if (request.url === '/login') {
        loginRequests++;
        response.writeHead(302, {Location: '/forbidden'}).end();
      } else {
        forbiddenRequests++;
        response.writeHead(200).end('FORBIDDEN-SYNTHETIC-TARGET');
      }
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + fixture.address().port + '/login';
    let browser;
    try {
      browser = await requireApp('playwright').chromium.launch({headless: true,
        args: ['--no-sandbox']});
      const context = await browser.newContext({serviceWorkers: 'block'});
      const {createExecutionPolicy} = requireApp('/app/src/raad-login-pilot/execution-policy.js');
      const {installTestBrowserFence} = requireApp('/app/src/raad-login-pilot/test-browser-fence.js');
      // Preserve the native route/request/response objects. Only fetch's target
      // is rewritten to the numeric loopback fixture. --network none prevents
      // any government request even if this test fails.
      const wrapper = {
        routeWebSocket: (...args) => context.routeWebSocket(...args),
        route: (pattern, handler) => context.route(pattern, route => handler({
          request: () => route.request(),
          fetch: options => {
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.maxRetries, 0);
            return route.fetch({...options, url: endpoint});
          },
          abort: () => route.abort(),
          fulfill: options => { fulfills++; return route.fulfill(options); },
        })),
      };
      await installTestBrowserFence(wrapper, createExecutionPolicy({
        RAAD_EXECUTION_MODE: 'non_submitting_test',
      }), {onBlocked: () => {blocked++;}});
      const page = await context.newPage();
      await assert.rejects(page.goto('https://visa.mofa.gov.sa/Account/Loginindividuals',
        {waitUntil: 'domcontentloaded', timeout: 15000}));
      assert.equal(loginRequests, 1);
      assert.equal(forbiddenRequests, 0);
      assert.equal(blocked, 1);
      assert.equal(fulfills, 0);
    } finally {
      try { await browser?.close(); }
      finally {
        fixture.closeAllConnections?.();
        await new Promise(resolve => fixture.close(resolve));
      }
    }
  });
  await check('whatsapp-source-entrypoint-disabled', () => entrypoint('src/server.js', 31001, false));
  // Critical: use explicit Raad entry override, never the default flight worker.
  await check('raad-source-entrypoint-disabled', () => entrypoint('src/raad-login-pilot/server.js', 31002, true));
  console.log(JSON.stringify({status: 'passed', checks, liveActions: 0, entrypointChecks, pdfTools, modelVerification}));
}
main().catch(() => { console.error('CONTAINER_PREFLIGHT_FAILED'); process.exitCode = 1; });
