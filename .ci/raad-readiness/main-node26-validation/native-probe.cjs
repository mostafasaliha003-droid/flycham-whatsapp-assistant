'use strict';
// Validation only: runs under Docker RUN --network=none. No customer input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {createRequire} = require('node:module');
const r = createRequire('/app/package.json');
let sharp;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const checks = [];
const data = {syntheticOnly: true, liveActions: 0, accuracyClaimed: false};
async function check(name, operation) {
  await operation(); checks.push(name); console.log('PASS ' + name);
}
function verifyLoopbackOnly(interfaces = os.networkInterfaces()) {
  assert.deepEqual(Object.keys(interfaces), ['lo']);
  assert.ok(Array.isArray(interfaces.lo) && interfaces.lo.length);
  for (const item of interfaces.lo) {
    assert.equal(item.internal, true);
    const family = net.isIP(item.address);
    assert.ok(family === 4 && /^127\./.test(item.address) && ['IPv4', 4].includes(item.family)
      || family === 6 && ['::1', '0:0:0:0:0:0:0:1'].includes(item.address) && ['IPv6', 6].includes(item.family));
  }
  return {method: 'node_os_networkInterfaces', interfaces: ['lo'], allInternal: true};
}
function syntheticPdf() {
  const content = color => `${color} rg 0 0 300 200 re f\n0 0 0 rg 10 10 30 180 re f\n1 1 1 rg 260 10 30 180 re f\n`;
  const red = content('1 0 0'), blue = content('0 0 1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(red)} >>\nstream\n${red}endstream`,
    `<< /Length ${Buffer.byteLength(blue)} >>\nstream\n${blue}endstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 7\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
async function centerColor(bytes, topFraction) {
  const metadata = await sharp(bytes).metadata();
  const left = Math.floor(metadata.width * 0.4), top = Math.floor(metadata.height * topFraction);
  const stats = await sharp(bytes).extract({left, top, width: 8, height: 8}).removeAlpha().stats();
  return stats.channels.slice(0, 3).map(value => value.mean);
}
function assertColor(color, expected) {
  assert.equal(color.length, 3);
  assert.ok(color[expected] > 220 && color.every((value, index) => index === expected || value < 35));
}
async function baseline() {
  await check('official-node26-debian12-runtime', async () => {
    assert.equal(process.version, 'v26.13.0');
    assert.equal(process.report.getReport().header.glibcVersionRuntime, '2.36');
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    assert.match(release, /^ID=debian$/m); assert.match(release, /^VERSION_ID="12"$/m);
    assert.match(release, /^VERSION_CODENAME=bookworm$/m);
    assert.equal(sha(fs.readFileSync(process.execPath)), '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b');
    const npm = cp.execFileSync(process.execPath, ['/opt/node/lib/node_modules/npm/bin/npm-cli.js', '--version'],
      {timeout: 5000, maxBuffer: 1024, encoding: 'utf8'}).trim();
    assert.equal(npm, '11.20.0'); data.runtime = {node: process.version, npm, debian: '12', glibc: '2.36'};
  });
  await check('patched-sharp-native-image', async () => {
    data.sharp = {sharp: sharp.versions.sharp, vips: sharp.versions.vips, rsvg: sharp.versions.rsvg};
    assert.deepEqual(data.sharp, {sharp: '0.35.5', vips: '8.18.7', rsvg: '2.63.2'});
    const image = await sharp({create: {width: 100, height: 80, channels: 3, background: 'white'}}).rotate(90).png().toBuffer();
    const metadata = await sharp(image).metadata(); assert.equal(metadata.width, 80); assert.equal(metadata.height, 100);
  });
  await check('pinned-local-mrz-model', async () => {
    const bytes = fs.readFileSync('/app/var/mrz-model/mrz.traineddata');
    assert.equal(bytes.length, 1452847); assert.equal(sha(bytes), 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01');
    data.model = {bytes: bytes.length, sha256: sha(bytes)};
  });
  await check('application-owned-js-wasm-ocr-child-blank-rejection', async () => {
    const nativeFork = cp.fork; let forks = 0, ready = 0, closes = 0, currentPsm;
    const pending = new Map(), parameters = [], recognitions = [];
    cp.fork = function (file, args, options) {
      assert.equal(path.resolve(file), '/app/src/visa-mrz-optical-worker.js'); forks++;
      const child = nativeFork.call(this, file, args, options);
      const send = child.send;
      child.send = function (message, ...rest) {
        // Observe only operation metadata; never retain image bytes or OCR text.
        if (message.type === 'parameters' || message.type === 'recognize') {
          assert.ok(Number.isSafeInteger(message.id) && !pending.has(message.id));
          const psm = message.type === 'parameters' ? message.parameters?.tessedit_pageseg_mode : currentPsm;
          assert.ok([6, 11].includes(psm)); pending.set(message.id, {operation: message.type, psm});
        } else assert.equal(message.type, 'init');
        return send.call(this, message, ...rest);
      };
      child.on('message', message => {
        if (message?.type === 'ready') { ready++; return; }
        assert.equal(message?.type, 'result'); assert.equal(message.ok, true);
        const request = pending.get(message.id); assert.ok(request); pending.delete(message.id);
        if (request.operation === 'parameters') {
          currentPsm = request.psm; parameters.push(request.psm);
        } else {
          assert.equal(typeof message.text, 'string');
          assert.ok(message.text.trim() === '', 'OCR_BLANK_RESULT_UNCONFIRMED');
          recognitions.push(request.psm);
        }
      });
      child.on('close', () => { closes++; });
      return child;
    };
    try {
      const {createOpticalMrz} = r('/app/src/visa-mrz-optical.js');
      const reader = createOpticalMrz(); assert.equal(reader.status().configured, true);
      const blank = await sharp({create: {width: 1000, height: 600, channels: 3, background: 'white'}}).png().toBuffer();
      await assert.rejects(reader.extract({bytes: blank, mimeType: 'image/png', format: 'TD3', guard: async () => true}),
        error => error.code === 'MRZ_OPTICAL_READ_FAILED');
      assert.equal(forks, 1); assert.equal(ready, 1); assert.equal(closes, 1); assert.equal(pending.size, 0);
      assert.deepEqual(parameters, [6, 11]); assert.deepEqual(recognitions, [6, 11]);
      assert.equal(reader.status().busy, false); assert.equal(reader.status().ready, true);
      data.ocr = {ownedChildCount: forks, readyCount: ready, closedChildCount: closes,
        successfulParameterModes: parameters, successfulRecognitionModes: recognitions,
        retainedTextOrImageBytes: false, rejectedBlank: true, accuracyClaimed: false};
    } finally { cp.fork = nativeFork; }
  });
}
async function pdf() {
  await check('explicit-poppler22-pdf-tools', async () => {
    data.pdfTools = {};
    for (const tool of ['pdfinfo', 'pdftoppm']) {
      const result = cp.spawnSync(tool, ['-v'], {encoding: 'utf8', timeout: 5000, maxBuffer: 8192});
      assert.equal(result.status, 0); assert.equal(result.error, undefined);
      const firstLine = (result.stdout + result.stderr).split('\n')[0];
      assert.equal(firstLine, tool + ' version 22.12.0'); data.pdfTools[tool] = '22.12.0';
    }
  });
  let pages;
  await check('application-two-page-pdf-rasterization', async () => {
    const {rasterizePdfPages} = r('/app/src/raad-pdf.js');
    const rendered = await rasterizePdfPages(syntheticPdf()); assert.equal(rendered.pageCount, 2);
    pages = rendered.pages; assert.deepEqual(pages.map(page => page.pageNumber), [1, 2]);
    for (const page of pages) {
      assert.equal(page.mimeType, 'image/png'); assert.equal(page.orientationVerified, false);
      assert.equal(page.needsVisualReview, true); const metadata = await sharp(page.bytes).metadata();
      assert.equal(metadata.width, 1800); assert.equal(metadata.height, 1200);
    }
    assertColor(await centerColor(pages[0].bytes, 0.5), 0); assertColor(await centerColor(pages[1].bytes, 0.5), 2);
    data.pdf = {syntheticPages: 2, width: 1800, height: 1200, orderedColorMarkers: true};
  });
  await check('application-passport-and-identity-merge-retains-both-pages', async () => {
    const {prepareDocumentImage, prepareResidenceImage} = r('/app/src/raad-attachments.js');
    data.merges = [];
    for (const kind of ['passport', 'residence']) {
      const parts = pages.map(page => ({bytes: page.bytes, mimeType: page.mimeType}));
      const result = kind === 'passport' ? await prepareDocumentImage(parts, {kind}) : await prepareResidenceImage(parts);
      assert.ok(result.bytes.length > 0 && result.bytes.length <= 1000000);
      assert.equal(result.needsVisualReview, true);
      assert.ok(result.transformations.includes('combine_full_parts_on_white_with_gap'));
      const metadata = await sharp(result.bytes).metadata(); assert.ok(['png', 'jpeg'].includes(metadata.format));
      assert.ok(metadata.height > metadata.width); assertColor(await centerColor(result.bytes, 0.25), 0);
      assertColor(await centerColor(result.bytes, 0.75), 2);
      data.merges.push({kind, bytes: result.bytes.length, width: metadata.width, height: metadata.height,
        orderedColorMarkers: true, needsVisualReview: true, sha256: sha(result.bytes)});
    }
  });
}
async function main() {
  const phase = process.argv[2]; assert.ok(['baseline', 'pdf'].includes(phase));
  sharp = r('sharp');
  data.network = verifyLoopbackOnly();
  if (phase === 'baseline') await baseline(); else await pdf();
  console.log(JSON.stringify({status: 'passed', phase, checks, ...data}));
}
module.exports = {verifyLoopbackOnly, syntheticPdf, assertColor};
if (require.main === module) main().catch(() => {console.error('MAIN_NODE26_NATIVE_PROBE_FAILED'); process.exitCode = 1;});
