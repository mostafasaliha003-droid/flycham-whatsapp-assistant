#!/usr/bin/env python3
"""Bounded exact npm-start test; install must have succeeded first.

No application source edits, service requests, credentials or live environment.
Only a synthetic native image, localhost GET /health and owned teardown occur.
This script is prepared for peer review; preparing it does not execute startup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.request


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def durable(path, raw):
    temporary = path.with_suffix(path.suffix + '.part')
    with temporary.open('wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    assert path.read_bytes() == raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'node', 'npm-cli', 'install-result', 'work', 'evidence']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    harness = Path(__file__).resolve().parent
    source = args.source.resolve(strict=True)
    node = args.node.resolve(strict=True)
    npm_cli = args.npm_cli.resolve(strict=True)
    runtime = json.loads((harness / 'target-runtime-provenance.json').read_text())
    assert sha(node) == runtime['nodeBinarySha256']
    assert sha(npm_cli) == runtime['npmCliSha256']
    installed = json.loads(args.install_result.read_text())
    assert installed['exitCode'] == 0 and installed['modelVerified'] is True
    assert installed['sourceMismatchesAfter'] == []
    assert installed['nodeVersion'] == 'v26.13.0'
    assert installed['npmVersion'] == '11.20.0'
    manifest = json.loads((harness / 'expected-source-manifest.json').read_text())

    def verify_source():
        for name, record in manifest['files'].items():
            file = source / name
            assert file.stat().st_size == record['bytes'] and sha(file) == record['sha256']

    observed = subprocess.run([str(node), '-p', "process.report.getReport().header.glibcVersionRuntime"],
                              env={'PATH': '/opt/node/bin:/usr/bin:/bin'}, capture_output=True, timeout=5)
    assert observed.returncode == 0 and observed.stdout.strip() == b'2.36'
    verify_source()
    package = json.loads((source / 'package.json').read_text())
    assert package['scripts']['start'] == 'node src/server.js'
    assert 'prestart' not in package['scripts'] and 'poststart' not in package['scripts']
    work = args.work.absolute()
    work.mkdir(mode=0o700, parents=True, exist_ok=False)
    evidence = args.evidence.absolute()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ['home', 'tmp', 'cache', 'bin']:
        (work / name).mkdir(mode=0o700)
    (work / 'bin/node').symlink_to(node)
    for name in ['user.npmrc', 'global.npmrc']:
        (work / name).write_text('')
    state = work / 'synthetic-state.enc'
    assert not state.exists()
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    env = {
        'PATH': str(work / 'bin') + ':/usr/bin:/bin',
        'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'),
        'NODE_ENV': 'production', 'PORT': str(port),
        'DRY_RUN': 'true', 'SAUDI_VISA_ENABLED': 'false',
        'RAAD_VISA_AUTOMATION_ENABLED': 'false', 'FARE_CATALOG_ENABLED': 'false',
        'CONSULTANT_ORCHESTRATOR_ENABLED': 'false',
        'ASSISTANT_STATE_PATH': str(state),
        'ASSISTANT_STATE_KEY': 'synthetic-main-start-state-fixture',
        'MAIN_TEST_STATE_PATH': str(state), 'MAIN_TEST_SOURCE': str(source),
        'MAIN_TEST_PORT': str(port), 'MAIN_TEST_NPM_CLI': str(npm_cli),
        'MAIN_TEST_FENCE_EVENTS': str(evidence / 'fence-events.jsonl'),
        'OFFLINE_GUARD_LOG': str(evidence / 'blocked-attempts.jsonl'),
        'NODE_OPTIONS': '--require ' + str(harness / 'main-start-preload.cjs'),
        'NPM_CONFIG_USERCONFIG': str(work / 'user.npmrc'),
        'NPM_CONFIG_GLOBALCONFIG': str(work / 'global.npmrc'),
        'NPM_CONFIG_CACHE': str(work / 'cache'),
        'npm_config_audit': 'false', 'npm_config_fund': 'false',
        'npm_config_update_notifier': 'false',
    }
    # No inherited proxy/credential/config variables in runtime checks.
    native = subprocess.run([str(node), str(harness / 'main-native-smoke.cjs')],
                            cwd=source, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=20)
    durable(evidence / 'native-smoke.log', native.stdout)
    assert native.returncode == 0
    command = [str(node), str(npm_cli), 'start']
    process = subprocess.Popen(command, cwd=source, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    chunks = []
    reader = threading.Thread(target=lambda: chunks.extend(iter(
        lambda: process.stdout.read(8192), b'')), daemon=True)
    reader.start()
    health = None
    error = None
    started = time.monotonic()
    # Numeric loopback requests deliberately bypass all parent proxy settings.
    class NoHealthRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            raise RuntimeError('HEALTH_REDIRECT_REJECTED')

    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        NoHealthRedirect())
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('NPM_START_EXITED_BEFORE_HEALTH')
            try:
                with client.open('http://127.0.0.1:' + str(port) + '/health', timeout=0.3) as response:
                    assert response.status == 200
                    data = json.loads(response.read(65537))
                assert data['ok'] is True and data['mode'] == 'dry-run'
                assert data['assistant']['saudiVisa']['enabled'] is False
                assert data['assistant']['consultantEnabled'] is False
                health = {'status': 200, 'ok': True, 'mode': data['mode'],
                          'visaEnabled': False, 'consultantEnabled': False}
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        assert health is not None
    except Exception as caught:
        error = type(caught).__name__ + ': ' + str(caught)
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        grace_deadline = time.monotonic() + 6
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            pass
        reader.join(timeout=max(0, grace_deadline - time.monotonic()))
        # Kill the owned process group even if the npm parent already exited.
        # A descendant must not survive merely by retaining stdout or ignoring TERM.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=6)
        reader.join(timeout=3)
        assert not reader.is_alive(), 'STDOUT_EOF_NOT_CONFIRMED'
        durable(evidence / 'npm-start.log', b''.join(chunks))
    blocked_file = evidence / 'blocked-attempts.jsonl'
    blocked = blocked_file.read_text().splitlines() if blocked_file.exists() else []
    events = [json.loads(line) for line in (evidence / 'fence-events.jsonl').read_text().splitlines()]
    assert any(row['event'] == 'allowed-exact-npm-start-child' for row in events)
    assert any(row['event'] == 'main-listen-forced-127.0.0.1' for row in events)
    verify_source()
    result = {
        'passed': error is None and health is not None and not blocked,
        'functionalCommit': manifest['functionalCommit'],
        'applicationFingerprintSha256': manifest['applicationFingerprintSha256'],
        'sourceFilesVerifiedBeforeAndAfter': len(manifest['files']),
        'effectiveCommand': 'npm start', 'nodeVersion': 'v26.13.0',
        'npmVersion': '11.20.0', 'observedGlibc': '2.36', 'mainGlibc': '2.36',
        'derivedDebianValidation': True, 'platformImageParityClaimed': False, 'health': health,
        'onlyHttpAction': 'GET numeric-loopback /health',
        'blockedAttempts': len(blocked), 'syntheticFreshState': True,
        'noInheritedEnvironment': True, 'liveActions': 0, 'servicesChanged': False,
        'stdoutEof': True, 'npmStartControlledStopReturnCode': process.returncode,
        'finalOwnedProcessGroupSigkillAttempted': True,
        'elapsedSeconds': round(time.monotonic() - started, 3), 'error': error,
        'logBytes': (evidence / 'npm-start.log').stat().st_size,
        'logSha256': sha(evidence / 'npm-start.log'),
    }
    durable(evidence / 'result.json', (json.dumps(result, indent=2) + '\n').encode())
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
