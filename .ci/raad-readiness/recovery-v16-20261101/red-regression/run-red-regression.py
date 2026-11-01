#!/usr/bin/env python3
"""One isolated red proof using existing immutable runtime and current tests."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

OLD_PIN = 'dc33bc9ce880ae446729cda9a6232f34b19a9045f9497206cf7c2c1e838536da'
NEW_PIN = '4b03f12a2c7d0af6e7c9dc6c1decb8dbbe588f22105fd40ff12dbdd120bb5c3c'
OLD_TREE = '036355159f736467891c29ec6383b928ae4b6d2d'
NEW_TREE = '3c67dbdd818448f102395581a8dac32004eca5d2'
NODE_PIN = '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b'
GUARD_PIN = '03030eb322796ec0b363c25ca15c2e795c607de9b9751e85158de6499100a44c'
PARSER_PIN = 'b5d0788bbe421fa6c68b17f34c6988e0b60fb4eab506d4a6397e90d93ac6ae37'
TEST = 'test/raad-machine-dossier.test.js'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def item(path):
    assert path.is_file() and not path.is_symlink(), path
    raw = path.read_bytes()
    return {'bytes': len(raw), 'sha256': sha(raw),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
            'mode': '100755' if path.stat().st_mode & stat.S_IXUSR else '100644'}


def verify(root, manifest):
    for name, expected in manifest['files'].items():
        assert item(root / name) == expected, name


def tree_sha(files):
    folders = {}
    for name, value in files.items():
        target = folders
        parts = name.split('/')
        for parent in parts[:-1]:
            target = target.setdefault(parent, {})
        target[parts[-1]] = value

    def encode(folder):
        rows = []
        for name, value in folder.items():
            directory = 'gitBlob' not in value
            rows.append((name + ('/' if directory else ''), name,
                         '40000' if directory else value['mode'],
                         encode(value) if directory else value['gitBlob']))
        raw = b''.join(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(blob)
                       for _, name, mode, blob in sorted(rows))
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()

    return encode(folders)


def durable(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    assert path.read_bytes() == raw


def dump(path, value):
    durable(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode())


parser = argparse.ArgumentParser(description=__doc__)
for name in ['old-source', 'old-freeze', 'new-source', 'new-freeze', 'dependencies',
             'node', 'ordinary-guard', 'tap-parser', 'green-summary', 'out']:
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
old_source, new_source = args.old_source.resolve(strict=True), args.new_source.resolve(strict=True)
old_freeze, new_freeze = args.old_freeze.resolve(strict=True), args.new_freeze.resolve(strict=True)
node, guard = args.node.resolve(strict=True), args.ordinary_guard.resolve(strict=True)
tap_path, deps = args.tap_parser.resolve(strict=True), args.dependencies.resolve(strict=True)
assert sha(old_freeze.read_bytes()) == OLD_PIN and sha(new_freeze.read_bytes()) == NEW_PIN
old, new = json.loads(old_freeze.read_text()), json.loads(new_freeze.read_text())
assert old['candidateTree'] == OLD_TREE and new['candidateTree'] == NEW_TREE
assert len(old['files']) == len(new['files']) == 445
assert tree_sha(old['files']) == OLD_TREE and tree_sha(new['files']) == NEW_TREE
assert sha(node.read_bytes()) == NODE_PIN and sha(guard.read_bytes()) == GUARD_PIN
assert sha(tap_path.read_bytes()) == PARSER_PIN and deps.is_dir()
verify(old_source, old)
verify(new_source, new)
green_summary = args.green_summary.resolve(strict=True)
green = json.loads(green_summary.read_text())
green_row = next(row for row in green['results'] if row['file'] == TEST)
assert green['candidateTree'] == NEW_TREE and green_row['tests'] == green_row['pass'] == 31
green_log = green_summary.parent / green_row['log']
assert sha(green_log.read_bytes()) == green_row['log_sha256']
assert green_row['exit_code'] == 0 and green_row['stdout_eof'] is True and green_row['log_complete'] is True
assert not args.out.exists(), 'Exactly one red run per fresh output directory'
out = args.out.absolute()
out.mkdir(parents=True, mode=0o700)
copy = out / 'old-runtime-current-test'
copy.mkdir(mode=0o700)
for name, value in old['files'].items():
    dest = copy / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(old_source / name, dest)
    os.chmod(dest, int(value['mode'], 8) & 0o777)
(copy / TEST).write_bytes((new_source / TEST).read_bytes())
os.chmod(copy / TEST, int(new['files'][TEST]['mode'], 8) & 0o777)
(copy / 'node_modules').symlink_to(deps, target_is_directory=True)
hybrid = dict(old['files'])
hybrid[TEST] = new['files'][TEST]
verify(copy, {'files': hybrid})
assert {name for name in hybrid if hybrid[name] != old['files'][name]} == {TEST}
assert (copy / TEST).read_bytes() == (new_source / TEST).read_bytes()
flags = {'NODE_ENV': 'test', 'DRY_RUN': 'true', 'SAUDI_VISA_ENABLED': 'false',
         'CONSULTANT_ORCHESTRATOR_ENABLED': 'false', 'RAAD_DOCUMENT_OCR_ENABLED': 'false',
         'RAAD_MRZ_PROVIDER': 'local', 'RAAD_MRZ_PRODUCTION_ENABLED': 'false',
         'RAAD_VISA_AUTOMATION_ENABLED': 'false', 'AIR_ARABIA_QUOTE_QUEUE_ENABLED': 'false',
         'ASSISTANT_AI_PROVIDER': 'disabled', 'ASSISTANT_AI_FALLBACK': 'none'}
guard_log = out / 'network-process-guard.jsonl'
env = {'PATH': str(node.parent) + os.pathsep + os.defpath, 'TZ': 'UTC', 'LANG': 'C.UTF-8',
       'NODE_PATH': str(deps), 'NODE_OPTIONS': '--require=' + str(guard),
       'OFFLINE_GUARD_LOG': str(guard_log), **flags}
command = [str(node), '--test', '--test-isolation=none', '--test-reporter=tap', TEST]
plan = {'kind': 'controlled_new_red_run_not_historical_log_reconstruction',
        'runtimeSourceCommit': '2167d5f87fce8f2cf05de1c96e367a8a57ce7402',
        'testSourceCommit': '46963b57c5490afcd2e9da15468cce52234f931a',
        'oldSourceTree': OLD_TREE, 'newCurrentSourceTree': NEW_TREE,
        'disposableHybridTree': tree_sha(hybrid), 'disposableHybridFiles': hybrid,
        'changedFromOldSourceOnly': [TEST], 'testFileSha256': new['files'][TEST]['sha256'],
        'oldFreezeSha256': OLD_PIN, 'newFreezeSha256': NEW_PIN, 'command': command,
        'nodeSha256': NODE_PIN, 'ordinaryGuardSha256': GUARD_PIN, 'tapParserSha256': PARSER_PIN,
        'initialDisablingFlags': flags, 'externalDependenciesReused': str(deps),
        'credentialsInherited': False, 'noActualCustomerStateCopied': True,
        'greenLogAlreadyCapturedByFullSuite': {'summary': str(green_summary),
            'summarySha256': sha(green_summary.read_bytes()), 'file': TEST,
            'log': str(green_log), 'logSha256': green_row['log_sha256'], 'pass': 31},
        'scope': 'Guarded functional JS; external transports and processes blocked, numeric loopback fake HTTP remains permitted by the approved ordinary guard; not OS network isolation.'}
dump(out / 'execution-plan.json', plan)
started = time.monotonic()
completed = subprocess.run(command, cwd=copy, env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
elapsed = time.monotonic() - started
log = out / 'red-machine-dossier.tap'
durable(log, completed.stdout)
pipe = {'exitCode': completed.returncode, 'stdoutPipeEof': True,
        'bytes': len(completed.stdout), 'sha256': sha(completed.stdout),
        'readbackVerified': log.read_bytes() == completed.stdout, 'elapsedSeconds': elapsed}
dump(out / 'capture-result.json', pipe)
spec = importlib.util.spec_from_file_location('pinned_complete_tap_parser', tap_path)
tap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tap)
red = tap.inspect_tap(completed.stdout)
verify(old_source, old)
verify(new_source, new)
verify(copy, {'files': hybrid})
assert sha(node.read_bytes()) == NODE_PIN and sha(guard.read_bytes()) == GUARD_PIN
guard_calls = guard_log.read_text().splitlines() if guard_log.exists() else []
names = re.findall(r'^not ok \d+ - (.+)$', completed.stdout.decode(), re.MULTILINE)
shape = (completed.returncode == 1 and red['tap_counts']['tests'] == 31 and
         red['tap_counts']['pass'] == 28 and red['tap_counts']['fail'] == 3)
result = {'kind': 'measured_new_red_regression_evidence', 'capture': pipe, 'strictTap': red,
          'expectedRedShapeReproduced': shape, 'measuredFailingTestNames': names,
          'currentGreenReference': plan['greenLogAlreadyCapturedByFullSuite'],
          'identicalCurrentTestFileUsedInRedAndGreen': True,
          'runtimeUnderTestIsOld2167NotCurrentCandidate': True,
          'oldAndCurrent445FilesUnchanged': True, 'disposableHybrid445Unchanged': True,
          'testFileSha256': new['files'][TEST]['sha256'], 'guardEvents': len(guard_calls),
          'newGreenRunPerformed': False, 'newRedRuns': 1,
          'lostHistoricalRedLogBytesReconstructed': False,
          'realMetaGovernmentModelOrPaymentCalls': 0, 'productionActions': 0,
          'limits': plan['scope']}
dump(out / 'final-result.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
