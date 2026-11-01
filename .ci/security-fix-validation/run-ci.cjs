'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawnSync, execFileSync} = require('node:child_process');
const sharp = require('/app/node_modules/sharp');
const sourceCommit = process.argv[2];
const manifest = require('/report/source-manifest.json');
for (const file of manifest) {
  const bytes = fs.readFileSync(path.join('/app', file.path));
  const actual = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  assert.equal(actual, file.sha, file.path);
}
assert.equal(require('/app/package.json').scripts.test, 'node scripts/run-tests.cjs');
const suite = spawnSync(process.execPath, ['scripts/run-tests.cjs', '--test-reporter=tap'], {
  cwd: '/app', encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 600000
});
process.stdout.write((suite.stdout || '').slice(-2000));
process.stderr.write(suite.stderr || '');
assert.equal(suite.status, 0, 'The complete isolated suite must pass');
const count = name => Number(suite.stdout.match(new RegExp('^# ' + name + ' (\\d+)$', 'm'))?.[1]);
const tests = {total: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped')};
assert.ok(tests.total > 2000);
assert.equal(tests.total, tests.passed);
assert.equal(tests.failed, 0);
assert.equal(tests.skipped, 0);
const image = awaitSharp();
function awaitSharp() {
  return sharp({create: {width: 48, height: 32, channels: 3, background: '#143f3c'}})
    .png().toBuffer().then(bytes => sharp(bytes).rotate(90).resize(64, 64).jpeg().toBuffer())
    .then(async bytes => {
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 64);
      assert.equal(metadata.height, 64);
      assert.equal(metadata.format, 'jpeg');
    });
}
async function finish() {
  await image;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remal-native-'));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 51 >>\nstream\nBT /F1 12 Tf 20 60 Td (SYNTHETIC QA ONLY) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const content = 'BT /F1 12 Tf 20 60 Td (SYNTHETIC QA ONLY) Tj ET\n';
  objects[3] = '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  const input = path.join(temporary, 'synthetic.pdf');
  const output = path.join(temporary, 'page');
  fs.writeFileSync(input, pdf, {mode: 0o600});
  const info = execFileSync('pdfinfo', [input], {encoding: 'utf8', timeout: 30000});
  assert.match(info, /Pages:\s+1/);
  execFileSync('pdftoppm', ['-singlefile', '-scale-to', '256', '-png', input, output], {timeout: 30000});
  const page = await sharp(output + '.png').metadata();
  assert.equal(page.format, 'png');
  assert.ok(page.width > 0 && page.height > 0);
  const audit = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
    cwd: '/app', env: {PATH: process.env.PATH, HOME: temporary, npm_config_cache: path.join(temporary, 'npm-cache')},
    encoding: 'utf8', timeout: 90000
  });
  assert.equal(audit.status, 0, audit.stderr || audit.stdout);
  const auditResult = JSON.parse(audit.stdout);
  assert.equal(auditResult.metadata.vulnerabilities.total, 0);
  const result = {
    ok: true, reportOnly: true, sourceCommit, sourceFilesVerified: manifest.length,
    node: process.version, platform: process.platform, sharp: sharp.versions.sharp, vips: sharp.versions.vips,
    tests, nativeChecks: {image: true, pdf: true}, dependencyAudit: auditResult.metadata.vulnerabilities
  };
  fs.writeFileSync('/report/results.json', JSON.stringify(result));
  console.log('REMAL_SECURITY_FIX_VALIDATION ' + JSON.stringify(result));
}
finish().catch(error => { console.error(error); process.exitCode = 1; });
