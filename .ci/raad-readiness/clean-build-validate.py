#!/usr/bin/env python3
"""Local build evidence only. Never deploys, pushes, or contacts customer services.

Run in an authorized environment with npm/model registry access and Docker:
  python clean-build-validate.py /absolute/test-build /absolute/new-evidence-dir

This intentionally runs the inspected production install lifecycle, including
the pinned model download. It ignores inherited credentials, npm config files,
and node_modules. Network access is only needed for build dependencies; runtime
container validation uses Docker --network none.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

MODEL_SHA256 = 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def durable(path, raw):
    temporary = path.with_suffix(path.suffix + '.part')
    with temporary.open('wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if path.read_bytes() != raw:
        raise RuntimeError('LOG_READBACK_FAILED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    evidence = args.evidence.absolute()
    # A new output directory prevents silently mixing old/new evidence.
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    if evidence.is_relative_to(source):
        raise RuntimeError('EVIDENCE_MUST_BE_OUTSIDE_SOURCE')
    stage = evidence / 'source'
    shutil.copytree(source, stage, ignore=shutil.ignore_patterns(
        'node_modules', 'var', '.env', '.env.*', '.git'))
    home = evidence / 'home'
    cache = evidence / 'npm-cache'
    home.mkdir(); cache.mkdir()
    for name in ['user.npmrc', 'global.npmrc']:
        (evidence / name).write_text('')
    env = {
        'PATH': os.environ['PATH'], 'HOME': str(home),
        'NPM_CONFIG_CACHE': str(cache),
        'NPM_CONFIG_USERCONFIG': str(evidence / 'user.npmrc'),
        'NPM_CONFIG_GLOBALCONFIG': str(evidence / 'global.npmrc'),
        'npm_config_audit': 'false', 'npm_config_fund': 'false',
        'npm_config_update_notifier': 'false',
        'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1',
    }
    # Preserve environment network routing without recording its values.
    for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']:
        if key in os.environ:
            env[key] = os.environ[key]
    records = []

    def run(label, command, timeout=900):
        begin = time.monotonic()
        process = subprocess.Popen(command, cwd=stage, env=env,
                                   stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT,
                                   start_new_session=True)
        timed_out = False
        try:
            raw, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            import signal
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                raw, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                raw, _ = process.communicate()
        log = evidence / (label + '.log')
        durable(log, raw)
        records.append({'step': label, 'command': command,
                        'exit_code': process.returncode,
                        'timed_out': timed_out,
                        'duration_seconds': round(time.monotonic()-begin, 3),
                        'stdout_eof': True, 'readback_verified': True,
                        'bytes': len(raw), 'sha256': digest(log)})
        durable(evidence / 'steps.json',
                (json.dumps(records, indent=2) + '\n').encode())
        if process.returncode or timed_out:
            raise RuntimeError(label + '_FAILED; see complete local log')
        return raw

    assert not (stage / 'node_modules').exists()
    package_before = digest(stage / 'package.json')
    lock_before = digest(stage / 'package-lock.json')
    run('node-version', ['node', '--version'])
    run('npm-version', ['npm', '--version'])
    # Frozen lockfile; production lifecycle enabled; no tests or live app start.
    run('production-npm-ci', ['npm', 'ci', '--omit=dev', '--foreground-scripts',
                             '--no-audit', '--no-fund'])
    assert package_before == digest(stage / 'package.json')
    assert lock_before == digest(stage / 'package-lock.json')
    model = stage / 'var/mrz-model/mrz.traineddata'
    assert model.stat().st_size == 1452847 and digest(model) == MODEL_SHA256
    durable(evidence / 'model-verification.json',
            (json.dumps({'verified': True, 'bytes': model.stat().st_size,
                         'sha256': digest(model)}) + '\n').encode())
    # Source is interpreted directly; package.json has no build script.
    for number, path in enumerate(sorted(stage.rglob('*.js'))):
        if 'node_modules' not in path.parts:
            run('syntax-%04d' % number, ['node', '--check', str(path)], 30)
    if not shutil.which('docker'):
        raise RuntimeError('DOCKER_UNAVAILABLE; image build not proven')
    image = 'flycham-validation:local'
    run('container-build', ['docker', 'build', '--pull', '--no-cache',
                           '-f', 'Dockerfile.worker', '-t', image, '.'], 1800)
    run('container-identity', ['docker', 'image', 'inspect',
                              '--format', '{{.Id}}', image], 30)
    harness = Path(__file__).resolve().parent / 'container-preflight.cjs'
    assert harness.is_file()
    run('container-preflight', [
        'docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,size=256m', '--shm-size', '256m',
        '--mount', 'type=bind,src=' + str(harness) + ',dst=/validation.cjs,readonly',
        '--entrypoint', 'node', image, '/validation.cjs'], 180)
    print('Build/container checks passed; release approval and other gates remain required.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
