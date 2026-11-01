from pathlib import Path
import ast
import hashlib
import json
import os
import shutil
import stat

ROOT = Path('/workspace/scratch/94d2ed38778f')
EVIDENCE = ROOT / 'recovery-v16-20261101/source'
BASE = ROOT / 'flycham-ocr-integration-20261031'
DEST = ROOT / 'flycham-fulfilment-mrz-fix-20261031-new-recovery'
BASE_FREEZE = ROOT / 'ocr-integration-evidence-20261031/candidate-source-freeze-v2.json'
INPUT = EVIDENCE / 'download-staging/repository-source-payloads.json'
EXPECTED_COMMIT = '46963b57c5490afcd2e9da15468cce52234f931a'
EXPECTED_TREE = '3c67dbdd818448f102395581a8dac32004eca5d2'
EXPECTED_FINGERPRINT = 'a866c28ea01f64f8fdf90cb58de6953884b570bd3400d61e917eb5e74727ef5d'
CHANGED = {'src/server.js', 'src/visa-fulfilment.js', 'test/raad-machine-dossier.test.js'}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git_blob(raw):
    return hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()


def inspect(path):
    assert path.is_file() and not path.is_symlink(), path
    raw = path.read_bytes()
    return {'bytes': len(raw), 'sha256': sha(raw), 'gitBlob': git_blob(raw),
            'mode': '100755' if path.stat().st_mode & stat.S_IXUSR else '100644'}


def verify_base(freeze):
    for name, expected in freeze['files'].items():
        assert inspect(BASE / name) == expected, name


def dump(name, value):
    path = EVIDENCE / name
    assert not path.exists(), path
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    assert path.read_bytes() == raw
    return {'bytes': len(raw), 'sha256': sha(raw)}


base = json.loads(BASE_FREEZE.read_text())
download = json.loads(INPUT.read_text())
assert len(base['files']) == 445
assert download['commit'] == EXPECTED_COMMIT and download['tree'] == EXPECTED_TREE
git = {item['path']: item for item in download['gitRecords']}
assert len(git) == 445 and set(git) == set(base['files'])
assert {item['path'] for item in download['payloads']} == CHANGED
verify_base(base)
assert not DEST.exists(), 'Fresh source copy only; do not overwrite earlier evidence'
DEST.mkdir(mode=0o700)
for name, expected in base['files'].items():
    target = DEST / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BASE / name, target)
    os.chmod(target, int(expected['mode'], 8) & 0o777)

receipts = []
for item in download['payloads']:
    raw = item['text'].encode('utf-8')
    expected = git[item['path']]
    assert git_blob(raw) == expected['sha'], item['path']
    assert len(raw) == expected['size'], item['path']
    target = DEST / item['path']
    target.write_bytes(raw)
    os.chmod(target, int(expected['mode'], 8) & 0o777)
    receipts.append({'file': item['path'], 'url': item['url'],
                     'bytes': len(raw), 'sha256': sha(raw),
                     'gitBlob': git_blob(raw), 'mode': expected['mode'],
                     'immutableGitBlobAndSizeVerified': True})

files = {name: inspect(DEST / name) for name in sorted(base['files'])}
for name, current in files.items():
    assert current['gitBlob'] == git[name]['sha'] and current['mode'] == git[name]['mode'], name
changed = {name for name in files if files[name] != base['files'][name]}
assert changed == CHANGED, changed

# Load only the pure tree encoder, not the old script's side effects.
module = ast.parse((ROOT / 'ocr-integration-evidence-20261031/freeze-candidate.py').read_text())
function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'tree')
namespace = {'hashlib': hashlib}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<tree-encoder-only>', 'exec'), namespace)
assert namespace['tree'](files) == EXPECTED_TREE
application = {name: {'bytes': value['bytes'], 'sha256': value['sha256']}
               for name, value in files.items() if not name.startswith(('.ci/', '.github/'))}
fingerprint = sha(json.dumps(application, sort_keys=True, separators=(',', ':')).encode())
assert len(application) == 431 and fingerprint == EXPECTED_FINGERPRINT
dependencies = (BASE / 'node_modules').resolve(strict=True)
assert dependencies.is_dir()
(DEST / 'node_modules').symlink_to(dependencies, target_is_directory=True)
verify_base(base)
freeze = {'kind': 'read_only_immutable_git_source_recovery_new_manifest',
          'candidateCommit': EXPECTED_COMMIT, 'candidateTree': EXPECTED_TREE,
          'baseCommit': '2167d5f87fce8f2cf05de1c96e367a8a57ce7402',
          'baseTree': base['candidateTree'], 'applicationFiles': 431,
          'firstPartyFiles': 445, 'applicationFingerprintSha256': fingerprint,
          'files': files, 'changed': sorted(CHANGED), 'added': [], 'removed': [],
          'sourceDirectory': str(DEST), 'sourceRecoveredFromExistingGit': True,
          'oldMissingV16FreezeShaReusedOrInvented': False,
          'original445FilesUnchangedBeforeAndAfter': True,
          'dependenciesReusedExternalSymlink': str(dependencies),
          'dependenciesCopied': False, 'customerStateOrSecretsCopied': False}
freeze_record = dump('candidate-source-freeze.json', freeze)
dump('immutable-source-download-readback.json', {
    'kind': 'actual_immutable_git_get_and_source_readback',
    'commit': EXPECTED_COMMIT, 'tree': EXPECTED_TREE,
    'filesDownloaded': receipts, 'all445GitBlobModeBindingsVerified': True,
    'original445Preserved': True, 'sourceFreeze': freeze_record,
    'applicationFingerprintSha256': fingerprint,
    'sourceDirectory': str(DEST), 'modelOrCustomerDataCopied': False,
    'gitOrRenderMutations': False, 'applicationTestsRerunByRecovery': False,
    'downloadStagingContainsAppSourceExcludedFromEvidence': True})
print(json.dumps({'source': str(DEST), 'freeze': str(EVIDENCE / 'candidate-source-freeze.json'),
                  'freezeSha256': freeze_record['sha256'], 'tree': EXPECTED_TREE,
                  'applicationFingerprintSha256': fingerprint, 'files': 445,
                  'original445Unchanged': True, 'externalDependencies': str(dependencies)}))
