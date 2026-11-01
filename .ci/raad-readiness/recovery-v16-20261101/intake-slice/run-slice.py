#!/usr/bin/env python3
"""Run one explicit, offline synthetic component slice; no app mutation."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import time

PIN = '4b03f12a2c7d0af6e7c9dc6c1decb8dbbe588f22105fd40ff12dbdd120bb5c3c'
NODE = '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b'
HERE = Path(__file__).resolve().parent
sha = lambda b: hashlib.sha256(b).hexdigest()


def save(path, data):
    raw = (json.dumps(data, indent=2) + '\n').encode() if not isinstance(data, bytes) else data
    part = path.with_name(path.name + '.part')
    with part.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(part, path)
    assert path.read_bytes() == raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--source', type=Path)
    parser.add_argument('--freeze', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.enable:
        print(json.dumps({'enabled': False, 'applicationImported': False, 'network': False}))
        return 0
    assert all([args.source, args.freeze, args.node, args.output]), 'EXPLICIT_INPUTS_REQUIRED'
    source, freeze, node = args.source.resolve(strict=True), args.freeze.resolve(strict=True), args.node.resolve(strict=True)
    assert sha(freeze.read_bytes()) == PIN
    assert sha(node.read_bytes()) == NODE
    binding = json.loads(freeze.read_bytes())
    assert binding['candidateTree'] == '3c67dbdd818448f102395581a8dac32004eca5d2'
    assert len(binding['files']) == 445
    def verify():
        for name, record in binding['files'].items():
            p = source / name
            assert p.is_file() and not p.is_symlink(), name
            raw = p.read_bytes()
            assert len(raw) == record['bytes'] and sha(raw) == record['sha256'], name
            assert ('100755' if p.stat().st_mode & stat.S_IXUSR else '100644') == record['mode'], name
    verify()
    out = args.output.resolve()
    assert not out.exists(), 'NEW_OUTPUT_REQUIRED'
    out.mkdir(mode=0o700, parents=True)
    helpers = {n: sha((HERE/n).read_bytes()) for n in ['run-slice.py', 'intake-slice.test.cjs', 'offline-preload.cjs']}
    cmd = [str(node), '--test', '--test-isolation=none', '--test-reporter=tap', '--require', str(HERE/'offline-preload.cjs'), str(HERE/'intake-slice.test.cjs')]
    env = {'PATH': os.environ['PATH'], 'TZ': 'UTC', 'LANG': 'C', 'SLICE_SOURCE': str(source), 'SLICE_FREEZE': str(freeze), 'SLICE_RESULT_PATH': str(out/'slice-result.json'), 'SLICE_GUARD_LOG': str(out/'blocked-attempts.jsonl')}
    save(out/'execution-plan.json', {'command': cmd, 'sourceTree': binding['candidateTree'], 'sourceCommit': binding['candidateCommit'], 'sourceFreezeSha256': PIN, 'nodeSha256': NODE, 'helperHashes': helpers, 'noInheritedCredentials': True, 'nativeHttpOrMetaClaimed': False, 'newRunAfterPriorEvidenceLoss': True})
    started = time.monotonic()
    try:
        p = subprocess.run(cmd, env=env, cwd=source, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        raw, code, timed_out = p.stdout, p.returncode, False
    except subprocess.TimeoutExpired as error:
        raw, code, timed_out = error.stdout or b'', 124, True
    elapsed = time.monotonic() - started
    save(out/'slice.tap', raw)
    verify()
    assert helpers == {n: sha((HERE/n).read_bytes()) for n in helpers}
    result = {'exitCode': code, 'timedOut': timed_out, 'stdoutPipeEof': not timed_out, 'readbackVerified': (out/'slice.tap').read_bytes() == raw, 'logBytes': len(raw), 'logSha256': sha(raw), 'elapsedWallSeconds': elapsed, 'source445BeforeAfterVerified': True, 'helperHashesUnchanged': True, 'newApplicationRun': True, 'reconstructedHistoricalBytesClaimed': False}
    tap_parser = source/'.ci/raad-readiness/test-tools/tap_log_evidence.py'
    assert sha(tap_parser.read_bytes()) == 'ecd59e282cc3463265f68b8eab4bf3c1c6e4710e5097def471795296075f5827'
    spec = importlib.util.spec_from_file_location('existing_strict_tap', tap_parser)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        result['tap'] = module.inspect_tap_bytes(raw)
    except Exception as error:
        result['tapError'] = str(error)
    blocked = out/'blocked-attempts.jsonl'
    result['blockedAttempts'] = len(blocked.read_text().splitlines()) if blocked.exists() else 0
    save(out/'run-result.json', result)
    print(json.dumps(result, indent=2))
    return code or int('tapError' in result) or int(bool(result['blockedAttempts']))


if __name__ == '__main__':
    raise SystemExit(main())
