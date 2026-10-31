#!/usr/bin/env python3
"""Derived Debian/Node validation only. No production state or entrypoint."""
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import traceback

INPUT = Path('/validation-input')
ROOT = Path('/validation-work')
ARTIFACTS = ROOT / 'artifacts'
APP = Path('/app')
NODE = '/opt/node/bin/node'
NPM = '/opt/node/lib/node_modules/npm/bin/npm-cli.js'
COMMIT = '4b39b9d1e93e70147d794a7e9b47a3fc550f41b1'
TREE = 'd39d02285e78dff1d44b2647997e6281eb756fe1'
FINGERPRINT = 'aa3711e6a439b90ecd63f34884948386eef03ce846c0be23261aaa8e70c41448'
NONCE = 'raad-validation-20261031-4b39b9d-05'
BASE_DIGEST = 'sha256:a3bba7dc7dbcc1f37c2856c51fc9a7fac96608f50cb87b1b4e4d8b8c85ae988e'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def durable(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    assert path.read_bytes() == raw


def dump(path, value):
    durable(path, (json.dumps(value, indent=2) + '\n').encode())


def manifest(folder):
    return {str(p.relative_to(folder)): {'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())}
            for p in sorted(folder.rglob('*')) if p.is_file()}


def config():
    info = json.loads((INPUT / 'inputs.json').read_text())
    assert info['functionalCommit'] == COMMIT and info['functionalTree'] == TREE
    assert info['applicationFingerprintSha256'] == FINGERPRINT and len(info['files']) == 418
    assert sha(json.dumps(info['files'], sort_keys=True, separators=(',', ':')).encode()) == FINGERPRINT
    assert info['buildNonce'] == NONCE and info['baseImageDigest'] == BASE_DIGEST
    assert Path('/raad-validation-build-nonce').read_text().strip() == NONCE
    for name, digest in info['toolFiles'].items():
        assert sha((INPUT / name).read_bytes()) == digest, name
    return info


def verify_source(info):
    for name, record in info['files'].items():
        path = APP / name
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == record['bytes'] and sha(path.read_bytes()) == record['sha256'], name


def clean_env(home, temporary):
    return {'PATH': '/opt/node/bin:/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': str(temporary),
            'LANG': 'C.UTF-8', 'TZ': 'UTC', 'NODE_ENV': 'production'}


def run(command, env, log, timeout):
    started = time.monotonic()
    child = subprocess.Popen(command, cwd=APP, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    timed_out = False
    try:
        raw, _ = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: raw, _ = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            raw, _ = child.communicate(timeout=5)
    finally:
        # Do not leave descendants alive merely because their parent exited.
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    assert len(raw) <= 2 * 1024 * 1024, 'VALIDATION_LOG_LIMIT'
    durable(log, raw)
    return {'command': command, 'exitCode': child.returncode, 'timedOut': timed_out,
            'seconds': round(time.monotonic() - started, 3), 'stdoutEof': True,
            'bytes': len(raw), 'sha256': sha(raw)}


def export_evidence(success):
    files = sorted(p for p in ARTIFACTS.rglob('*') if p.is_file())
    for path in files:
        assert not path.is_symlink() and path.suffix in {'.json', '.log', '.jsonl'}
        assert not any(part in {'src', 'node_modules', 'state', 'home', 'work'}
                       for part in path.relative_to(ARTIFACTS).parts)
    dump(ARTIFACTS / 'evidence-index.json', {'files': manifest(ARTIFACTS), 'selfExcluded': True})
    files = sorted(p for p in ARTIFACTS.rglob('*') if p.is_file())
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for path in files:
            raw = path.read_bytes(); member = tarfile.TarInfo(str(path.relative_to(ARTIFACTS)))
            member.mode = 0o600; member.mtime = 0; member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
    compressed = gzip.compress(stream.getvalue(), mtime=0)
    assert 0 < len(compressed) <= 262144
    encoded = base64.b64encode(compressed).decode('ascii')
    chunks = [encoded[index:index + 1024] for index in range(0, len(encoded), 1024)]
    meta = {'tag': 'RAAD_MAIN_NODE26_EVIDENCE', 'event': 'begin', 'success': success,
            'encoding': 'base64+gzip+tar', 'chunks': len(chunks), 'gzipBytes': len(compressed),
            'encodedBytes': len(encoded), 'sha256': sha(compressed), 'functionalCommit': COMMIT,
            'buildNonce': NONCE}
    print(json.dumps(meta), flush=True)
    for index, data in enumerate(chunks, 1):
        print(json.dumps({'tag': meta['tag'], 'event': 'chunk', 'index': index, 'data': data}), flush=True)
        time.sleep(0.03)
    print(json.dumps({**meta, 'event': 'end', 'eof': True}), flush=True)
    return len(compressed), len(chunks), sha(compressed)


def install(info):
    assert not (APP / 'node_modules').exists()
    snapshot = (INPUT / 'source-snapshot.tar.gz').read_bytes()
    assert sha(snapshot) == info['sourceSnapshotSha256']
    APP.mkdir(exist_ok=False); seen = set()
    with tarfile.open(fileobj=io.BytesIO(snapshot), mode='r:gz') as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            assert member.isfile() and not relative.is_absolute() and '..' not in relative.parts
            assert member.name in info['files'] and member.name not in seen
            raw = archive.extractfile(member).read(); expected = info['files'][member.name]
            assert len(raw) == expected['bytes'] and sha(raw) == expected['sha256']
            target = APP / member.name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw); target.chmod(member.mode & 0o777); seen.add(member.name)
    assert seen == set(info['files']); verify_source(info)
    home = ROOT / 'install-home'; cache = ROOT / 'install-cache'; temporary = ROOT / 'install-tmp'
    for directory in [home, cache, temporary]: directory.mkdir(parents=True, exist_ok=False)
    for name in ['user.npmrc', 'global.npmrc']: (ROOT / name).write_text('')
    env = clean_env(home, temporary)
    env.update({'NPM_CONFIG_USERCONFIG': str(ROOT / 'user.npmrc'),
                'NPM_CONFIG_GLOBALCONFIG': str(ROOT / 'global.npmrc'),
                'NPM_CONFIG_CACHE': str(cache), 'NPM_CONFIG_REGISTRY': 'https://registry.npmjs.org/',
                'NPM_CONFIG_STRICT_SSL': 'true', 'npm_config_audit': 'false',
                'npm_config_fund': 'false', 'npm_config_update_notifier': 'false'})
    step = run([NODE, NPM, 'install', '--omit=dev'], env, ARTIFACTS / 'install/npm-install.log', 300)
    result = {'functionalCommit': COMMIT, 'functionalTree': TREE, 'exitCode': step['exitCode'],
              'modelVerified': False, 'sourceMismatchesAfter': [], 'nodeVersion': 'v26.13.0',
              'npmVersion': '11.20.0', 'effectiveCommand': 'npm install --omit=dev',
              'freshCache': True, 'nodeModulesReused': False, 'lifecycleScriptsEnabled': True,
              'tlsVerificationDisabled': False, 'customCertificateAdded': False,
              'credentialsInherited': False, 'registry': 'https://registry.npmjs.org/',
              'packageLockBefore': info['files']['package-lock.json']['sha256'], **step}
    try:
        verify_source(info)
    except AssertionError:
        result['sourceMismatchesAfter'] = ['SOURCE_OR_LOCK_CHANGED']
    model = APP / 'var/mrz-model/mrz.traineddata'
    result['modelVerified'] = model.is_file() and model.stat().st_size == 1452847 and sha(model.read_bytes()) == 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01'
    result['packageLockAfter'] = sha((APP / 'package-lock.json').read_bytes())
    dump(ARTIFACTS / 'install/result.json', result)
    assert step['exitCode'] == 0 and not step['timedOut'] and result['modelVerified']
    assert not result['sourceMismatchesAfter'] and result['packageLockBefore'] == result['packageLockAfter']


def probe(phase):
    home = ROOT / (phase + '-home'); temporary = ROOT / (phase + '-tmp')
    for directory in [home, temporary]: directory.mkdir(exist_ok=False)
    step = run([NODE, str(INPUT / 'native-probe.cjs'), phase], clean_env(home, temporary),
               ARTIFACTS / phase / 'native-probe.log', 90)
    dump(ARTIFACTS / phase / 'step.json', step)
    assert step['exitCode'] == 0 and not step['timedOut']
    raw = (ARTIFACTS / phase / 'native-probe.log').read_bytes()
    result = json.loads(raw.decode().strip().split('\n')[-1])
    expected = ['official-node26-debian12-runtime', 'patched-sharp-native-image', 'pinned-local-mrz-model',
                'application-owned-js-wasm-ocr-child-blank-rejection'] if phase == 'baseline' else [
                'explicit-poppler22-pdf-tools', 'application-two-page-pdf-rasterization',
                'application-passport-and-identity-merge-retains-both-pages']
    assert result['status'] == 'passed' and result['checks'] == expected and result['liveActions'] == 0
    assert result['network']['interfaces'] == ['lo'] and result['network']['allInternal'] is True
    assert result['accuracyClaimed'] is False
    dump(ARTIFACTS / phase / 'result.json', result)
    return result


def baseline(info):
    verify_source(info); result = probe('baseline')
    command = ['python3', str(INPUT / 'verify-main-start.py'), '--source', '/app', '--node', NODE,
               '--npm-cli', NPM, '--install-result', str(ARTIFACTS / 'install/result.json'),
               '--work', str(ROOT / 'startup-work'), '--evidence', str(ARTIFACTS / 'startup')]
    step = run(command, clean_env(ROOT / 'baseline-home', ROOT / 'baseline-tmp'),
               ARTIFACTS / 'startup-driver.log', 90)
    dump(ARTIFACTS / 'startup-step.json', step)
    assert step['exitCode'] == 0 and not step['timedOut']
    startup = json.loads((ARTIFACTS / 'startup/result.json').read_text())
    assert startup['passed'] is True and startup['blockedAttempts'] == 0 and startup['stdoutEof'] is True
    assert startup['observedGlibc'] == '2.36' and startup['platformImageParityClaimed'] is False
    verify_source(info)


def finish(info):
    verify_source(info); pdf = probe('pdf')
    baseline = json.loads((ARTIFACTS / 'baseline/result.json').read_text())
    startup = json.loads((ARTIFACTS / 'startup/result.json').read_text())
    assert len(baseline['checks']) == 4 and len(pdf['checks']) == 3 and startup['passed'] is True
    dump(ARTIFACTS / 'build-provenance.json', {key: info[key] for key in [
        'functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'buildNonce',
        'baseImageDigest', 'sourceSnapshotSha256', 'toolFiles']})
    dump(ARTIFACTS / 'result.json', {'success': True, 'functionalCommit': COMMIT,
        'functionalTree': TREE, 'applicationFingerprintSha256': FINGERPRINT, 'applicationFiles': 418,
        'buildNonce': NONCE, 'baselineChecks': 4, 'pdfChecks': 3, 'startupPassed': True,
        'freshInstallPassed': True, 'lockUnchanged': True, 'fullSuiteRerun': False,
        'validationNetwork': 'Dockerfile RUN --network=none', 'accuracyClaimed': False,
        'scope': 'derived_debian12_validation_not_platform_image_equivalence',
        'releaseReady': False, 'liveActions': 0})
    size, chunks, digest = export_evidence(True)
    summary = {'kind': 'isolated_main_node26_validation', 'functionalCommit': COMMIT,
        'functionalTree': TREE, 'applicationFingerprintSha256': FINGERPRINT, 'applicationFiles': 418,
        'buildNonce': NONCE, 'nodeVersion': 'v26.13.0', 'npmVersion': '11.20.0', 'debianVersion': '12',
        'glibcVersion': '2.36', 'pdfToolsVersion': '22.12.0', 'freshInstallPassed': True,
        'lockUnchanged': True, 'baselineChecks': 4, 'startupPassed': True, 'pdfChecks': 3,
        'baseImageDigest': BASE_DIGEST, 'sourceSnapshotSha256': info['sourceSnapshotSha256'],
        'evidenceSha256': digest, 'evidenceBytes': size, 'evidenceChunks': chunks,
        'scope': 'derived_debian12_validation_not_platform_image_equivalence',
        'fullSuiteRerun': False, 'mrzAccuracyClaimed': False, 'buildOnly': True, 'releaseReady': False, 'liveActions': 0}
    dump(ROOT / 'public/public-summary.json', summary)
    print('RAAD_MAIN_NODE26_GATE_PASSED', flush=True)


if __name__ == '__main__':
    try:
        phase = sys.argv[1]; assert phase in {'install', 'baseline', 'pdf'}
        ROOT.mkdir(exist_ok=True); ARTIFACTS.mkdir(exist_ok=True)
        info = config()
        if phase == 'install': install(info)
        elif phase == 'baseline': baseline(info)
        else: finish(info)
    except Exception:
        try:
            # Private synthetic diagnostics only; never sent by the reporter.
            durable(ARTIFACTS / 'failure-traceback.log', traceback.format_exc().encode())
            dump(ARTIFACTS / 'failure.json', {'success': False, 'phase': sys.argv[1],
                'releaseReady': False, 'liveActions': 0, 'reason': 'MAIN_NODE26_VALIDATION_FAILED'})
            export_evidence(False)
        except Exception:
            print('RAAD_MAIN_NODE26_FAILURE_EVIDENCE_INCOMPLETE', flush=True)
        print('RAAD_MAIN_NODE26_GATE_FAILED', flush=True)
        raise SystemExit(1)
