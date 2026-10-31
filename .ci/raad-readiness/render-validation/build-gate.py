#!/usr/bin/env python3
"""Build-time canonical validation, private log export, public aggregate only.

Runs only in the derived Docker stage with RUN --network=none. No Docker daemon,
application deployment, real environment, provider calls or customer state.
"""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import tarfile
import time

INPUT = Path('/validation-input')
ROOT = Path('/validation-work')
COMMIT = '4b39b9d1e93e70147d794a7e9b47a3fc550f41b1'
TREE = 'd39d02285e78dff1d44b2647997e6281eb756fe1'
FINGERPRINT = 'aa3711e6a439b90ecd63f34884948386eef03ce846c0be23261aaa8e70c41448'


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


def run(command, cwd, env, log, timeout=900):
    start = time.monotonic()
    child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    timed_out = False
    try:
        raw, _ = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True; os.killpg(child.pid, signal.SIGTERM)
        try:
            raw, _ = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); raw, _ = child.communicate()
    durable(log, raw)
    return {'exitCode': child.returncode, 'timeout': timed_out, 'seconds': round(time.monotonic()-start, 3),
            'stdoutEof': True, 'bytes': len(raw), 'sha256': sha(raw)}


def archive_evidence(artifacts, success=True):
    # Only files explicitly assembled here. Source, state and dependency trees
    # are never traversed or archived by this exporter.
    names = sorted(p for p in artifacts.rglob('*') if p.is_file())
    for p in names:
        rel = p.relative_to(artifacts)
        assert not p.is_symlink() and p.suffix in {'.json', '.log', '.tap'}
        assert not any(x in {'src', 'test-build', 'node_modules', 'var', 'state', 'home'} for x in rel.parts)
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for p in names:
            raw = p.read_bytes(); entry = tarfile.TarInfo(str(p.relative_to(artifacts)))
            entry.size = len(raw); entry.mode = 0o600; entry.mtime = 0
            archive.addfile(entry, io.BytesIO(raw))
    compressed = gzip.compress(stream.getvalue(), mtime=0)
    assert len(compressed) <= 1024 * 1024, 'EVIDENCE_EXPORT_LIMIT'
    encoded = base64.b64encode(compressed).decode('ascii')
    chunks = [encoded[i:i+1024] for i in range(0, len(encoded), 1024)]
    assert 0 < len(chunks) <= 512
    meta = {'tag': 'RAAD_PRIVATE_EVIDENCE', 'event': 'begin', 'encoding': 'base64+gzip+tar', 'success': success,
            'chunks': len(chunks), 'gzipBytes': len(compressed), 'encodedBytes': len(encoded),
            'sha256': sha(compressed), 'functionalCommit': COMMIT}
    print(json.dumps(meta), flush=True)
    for number, data in enumerate(chunks, 1):
        print(json.dumps({'tag': 'RAAD_PRIVATE_EVIDENCE', 'event': 'chunk', 'index': number, 'data': data}), flush=True)
        time.sleep(0.03)  # Under 40 KiB/s including JSON framing; avoid log clipping.
    print(json.dumps({**meta, 'event': 'end', 'eof': True}), flush=True)
    return len(compressed), len(chunks), sha(compressed)


def main():
    start = time.monotonic()
    info = json.loads((INPUT/'inputs.json').read_text())
    assert info['functionalCommit'] == COMMIT and info['functionalTree'] == TREE
    assert info['applicationFingerprintSha256'] == FINGERPRINT and len(info['files']) == 418
    assert sha(json.dumps(info['files'], sort_keys=True, separators=(',', ':')).encode()) == FINGERPRINT
    assert (Path('/raad-validation-build-nonce').read_text().strip() == info['buildNonce'])
    for name, expected in info['toolFiles'].items():
        assert sha((INPUT/name).read_bytes()) == expected, name
    snapshot = (INPUT/'source-snapshot.tar.gz').read_bytes()
    assert sha(snapshot) == info['sourceSnapshotSha256']
    stage = ROOT/'stage'; stage.mkdir(parents=True, exist_ok=False)
    build = stage/'test-build'; build.mkdir()
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(snapshot), mode='r:gz') as source:
        for entry in source:
            rel = PurePosixPath(entry.name)
            assert entry.isfile() and not rel.is_absolute() and '..' not in rel.parts
            assert entry.name in info['files'] and entry.name not in seen
            raw = source.extractfile(entry).read(); expected = info['files'][entry.name]
            assert len(raw) == expected['bytes'] and sha(raw) == expected['sha256']
            target = build/entry.name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw); target.chmod(entry.mode & 0o777); seen.add(entry.name)
    assert seen == set(info['files']) and manifest(build) == info['files']
    original = (build/'Dockerfile.worker').read_text()
    derived = (INPUT/'Dockerfile.validation').read_text()
    worker = derived.split('# RAAD_WORKER_BEGIN\n', 1)[1].split('# RAAD_WORKER_END\n', 1)[0]
    first, rest = worker.split('\n', 1)
    cache_end = rest.index('# RAAD_CACHE_END\n') + len('# RAAD_CACHE_END\n')
    projected = first.removesuffix(' AS worker') + '\n' + rest[cache_end:]
    assert projected == original and sha(original.encode()) == info['workerRecipeSha256'], 'WORKER_RECIPE_MISMATCH'
    shutil.copytree(INPUT/'test-tools', stage/'test-tools')
    # Worker /app was constructed by the original Dockerfile.worker instructions.
    # Its COPY excludes colocated tests exactly as the original ignore rules do.
    runtime = {}
    for name, value in info['files'].items():
        rel = PurePosixPath(name)
        if not name.startswith('src/') or rel.name.endswith(('.test.js', '.test.cjs')):
            continue
        if any(x in {'test', 'tests', 'fixtures'} for x in rel.parts[1:]):
            continue
        runtime[name[4:]] = value
    assert manifest(Path('/app/src')) == runtime, 'WORKER_RUNTIME_SOURCE_MISMATCH'
    for name in ['package.json', 'package-lock.json', 'Dockerfile.worker']:
        assert sha((build/name).read_bytes()) == info['files'][name]['sha256']
    for name in ['package.json', 'package-lock.json']:
        assert (build/name).read_bytes() == (Path('/app')/name).read_bytes()
    native = json.loads(Path('/tmp/raad-native-proof/native-proof.json').read_text())
    assert native['passed'] and native['nativeChecks'] == 12 and native['liveActions'] == 0
    assert native['buildNonce'] == info['buildNonce'] and native['functionalCommit'] == COMMIT
    assert native['applicationFingerprintSha256'] == FINGERPRINT
    assert native['patchedSharpVerified'] is True
    assert native['patchedSharp'] == {'sharp': '0.35.5', 'vips': '8.18.7', 'rsvg': '2.63.2'}
    native_raw = Path('/tmp/raad-native-proof/native-preflight.log').read_bytes()
    assert len(native_raw) == native['bytes'] and sha(native_raw) == native['sha256']
    artifacts = ROOT/'artifacts'; artifacts.mkdir()
    for name in ['native-preflight.log', 'native-proof.json']:
        durable(artifacts/'native'/name, (Path('/tmp/raad-native-proof')/name).read_bytes())
    dump(artifacts/'source-manifest.json', {key: info[key] for key in
         ['functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'sourceSnapshotSha256', 'files']})
    dump(artifacts/'build-provenance.json', {key: info[key] for key in
         ['functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'buildNonce', 'workerRecipeSha256', 'sourceSnapshotSha256', 'toolFiles']})
    home = ROOT/'test-home'; home.mkdir()
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    step = run(['python3', str(stage/'test-tools/run-checks.py'), '--dependencies', '/app/node_modules', '--full'],
               stage, env, artifacts/'unit-driver.log')
    dump(artifacts/'steps.json', [step])
    final = json.loads((stage/'results/final-validation.json').read_text())
    spec = importlib.util.spec_from_file_location('tap_evidence', stage/'test-tools/tap_log_evidence.py')
    tap = importlib.util.module_from_spec(spec); spec.loader.exec_module(tap)
    index = []
    for row in final['results']:
        path = stage/row['log']; raw = path.read_bytes(); evidence = tap.inspect_tap_bytes(raw, row)
        target = artifacts/'unit/logs'/path.name; durable(target, raw)
        assert tap.inspect_tap_bytes(target.read_bytes(), row) == evidence
        row['source_run_log'] = row['log']; row['log'] = str(target.relative_to(artifacts))
        index.append({'file': row['file'], 'log': row['log'], **evidence})
    dump(artifacts/'unit/final-validation.json', final); dump(artifacts/'unit/log-index.json', index)
    for name in ['test-summary.json', 'targeted.log', 'bridge.log', 'http-smoke.log']:
        if (stage/'results'/name).is_file():
            durable(artifacts/'unit'/name, (stage/'results'/name).read_bytes())
    assert step['exitCode'] == 0 and not step['timeout']
    assert not final['missing_files'] and not final['incomplete_logs']
    totals = final['totals']
    assert totals['tests'] == totals['pass'] == 2633 and totals['files'] == totals['files_passed'] == len(index) == 209
    assert not any(totals.get(k, 0) for k in ['fail', 'cancelled', 'skipped', 'todo', 'blocked_attempts', 'files_failed'])
    assert manifest(build) == info['files'], 'SOURCE_MUTATED_DURING_TESTS'
    assert time.monotonic()-start < 1000, 'VALIDATION_ELAPSED_LIMIT'
    dump(artifacts/'result.json', {'success': True, 'functionalCommit': COMMIT,
         'applicationFingerprintSha256': FINGERPRINT, 'unitTotals': totals, 'nativeChecks': 12,
         'validationNetwork': 'Dockerfile RUN --network=none', 'derivedWorkerRecipe': True,
         'patchedSharpVerified': True, 'patchedSharpVersions': native['patchedSharp'],
         'releaseReady': False, 'liveActions': 0})
    dump(artifacts/'evidence-index.json', {'files': manifest(artifacts), 'selfExcluded': True})
    evidence_bytes, chunks, digest = archive_evidence(artifacts)
    public = {'kind': 'isolated_build_validation', 'functionalCommit': COMMIT, 'functionalTree': TREE,
              'applicationFingerprintSha256': FINGERPRINT, 'applicationFiles': 418,
              'unitTests': 2633, 'unitPassed': 2633, 'unitFiles': 209, 'nativeChecks': 12,
              'patchedSharpVerified': True, 'sharpVersion': native['patchedSharp']['sharp'],
              'vipsVersion': native['patchedSharp']['vips'], 'rsvgVersion': native['patchedSharp']['rsvg'],
              'workerRecipeSha256': info['workerRecipeSha256'], 'sourceSnapshotSha256': info['sourceSnapshotSha256'],
              'evidenceSha256': digest, 'evidenceBytes': evidence_bytes, 'evidenceChunks': chunks,
              'buildNonce': info['buildNonce'], 'buildOnly': True, 'releaseReady': False, 'liveActions': 0}
    dump(ROOT/'public/public-summary.json', public)
    print('RAAD_ISOLATED_BUILD_GATE_PASSED', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # A failed build never produces a public report/startable final image.
        # Preserve private synthetic diagnostics, including incomplete logs,
        # explicitly named diagnostic.log instead of canonical complete TAP.
        artifacts = ROOT/'artifacts'
        if artifacts.exists():
            try:
                for file in (ROOT/'stage/results').rglob('*'):
                    if file.is_file() and file.suffix in {'.tap', '.log', '.json', '.jsonl'}:
                        rel = file.relative_to(ROOT/'stage/results')
                        target = artifacts/'failure-diagnostics'/str(rel)
                        if target.suffix in {'.tap', '.jsonl'}:
                            target = target.with_suffix('.diagnostic.log')
                        durable(target, file.read_bytes())
                dump(artifacts/'failure.json', {'success': False, 'releaseReady': False,
                     'liveActions': 0, 'reason': 'BUILD_OR_VALIDATION_FAILURE'})
                dump(artifacts/'failure-evidence-index.json', {'files': manifest(artifacts), 'selfExcluded': True})
                archive_evidence(artifacts, success=False)
            except Exception:
                print('RAAD_PRIVATE_FAILURE_EVIDENCE_INCOMPLETE', flush=True)
        print('RAAD_ISOLATED_BUILD_GATE_FAILED', flush=True)
        raise SystemExit(1)
