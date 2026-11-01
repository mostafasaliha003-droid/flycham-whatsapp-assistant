"""Package verified recovery evidence and standalone, non-repository tools.

No network, build, test, government operation or external publication is performed.
The explicit package-inputs.json is the only source of new export paths.
"""
from pathlib import Path, PurePosixPath
import hashlib
import importlib.util
import json
import os
import re
import shutil
import zipfile

ROOT = Path('/workspace/scratch/94d2ed38778f')
RECOVERY = ROOT / 'recovery-v16-20261101'
CONFIG = json.loads((RECOVERY / 'package-inputs.json').read_text())
BASE = ROOT / 'flycham-deployment-checks-2026-10-31.zip'
OUT = RECOVERY / 'flycham-deployment-checks-v16-verified.zip'
PREFIX = 'recovery-v16-20261101'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def row(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def safe(name):
    name = str(name)
    p = PurePosixPath(name)
    assert name and str(p) == name and not p.is_absolute()
    assert '..' not in p.parts and '\\' not in name
    return name


spec = importlib.util.spec_from_file_location(
    'verified_legacy_tap_parser', ROOT / 'ocr-evidence-packaging-20261031/prepare-package.py')
tap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tap)
assert sha(BASE.read_bytes()) == CONFIG['expectedBaseSha256']
with zipfile.ZipFile(BASE) as z:
    assert z.testzip() is None and len(z.namelist()) == len(set(z.namelist())) == 2757
    payload = {safe(n): z.read(n) for n in z.namelist()}
old_raw = payload.pop('evidence-manifest.json')
old = json.loads(old_raw)
assert old['evidence_package_version'] == 15 and len(old['files']) == 2756
assert set(old['files']) == set(payload)
for name, expected in old['files'].items():
    assert row(payload[name]) == expected, name
for name, expected in old['all_tap_streams'].items():
    assert tap.inspect_tap(payload[name]) == expected, name
assert len(old['all_tap_streams']) == 1753
original = dict(payload)
all_taps = dict(old['all_tap_streams'])
incomplete_or_mixed = {}
roles = {}
allowlist_readbacks = []

git_data = json.loads((RECOVERY / 'full-suite/immutable-git-input-blob-check.json').read_text())
assert git_data['tree'] == '1d3511e1ac734f8ce49d8206d28a08478a7569e7'
git_blobs = {x['sha'] for x in git_data['blobs']}
assert len(git_data['blobs']) == 468


def add(name, raw, role):
    name = safe(name)
    if name in payload:
        assert payload[name] == raw, name
        roles.setdefault(name, set()).add(role)
        return
    payload[name] = raw
    roles.setdefault(name, set()).add(role)


def add_local(path, role, expected=None):
    path = Path(path)
    assert path.is_file() and not path.is_symlink(), str(path)
    relative = path.resolve().relative_to(RECOVERY.resolve()).as_posix()
    assert not {'node_modules', '.git', '__pycache__', 'git-ci', 'git-ci-downloads',
                'download-staging', 'work', 'work-state', 'test-build'}.intersection(PurePosixPath(relative).parts)
    raw = path.read_bytes()
    if expected is not None:
        assert row(raw) == {'bytes': expected['bytes'], 'sha256': expected['sha256']}, relative
    if role == 'standalone_toolkit':
        assert path.suffix in {'.py', '.cjs', '.js', '.json', '.md', '.txt'}
        blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        assert blob not in git_blobs, 'Repository-backed item must remain an immutable external input: ' + relative
    else:
        assert path.suffix in {'.json', '.jsonl', '.log', '.tap', '.txt', '.md', '.gz'}, relative
        if path.suffix == '.gz':
            assert sha(raw) == '125cca1b0632d3b0744ca19a5b065d0da1097d92d031cd7f88525f9a8d45ab3d'
    add(PREFIX + '/' + safe(relative), raw, role)


add('history/evidence-manifest-v15.json', old_raw, 'history')
for group in CONFIG['allowlists']:
    path = RECOVERY / safe(group['file'])
    raw = path.read_bytes()
    data = json.loads(raw)
    root = Path(data.get('root') or path.parent)
    root.resolve().relative_to(RECOVERY.resolve())
    files = data.get('files', data.get('allowedFiles'))
    if isinstance(files, dict):
        files = [{'file': n, **v} for n, v in files.items()]
    assert isinstance(files, list)
    for item in files:
        name = safe(item.get('file') or item.get('local') or item.get('relativePath'))
        add_local(root / name, group['role'], item)
    add_local(path, 'export_metadata')
    allowlist_readbacks.append({'file': group['file'], **row(raw), 'listedFilesVerified': len(files),
                               'role': group['role']})
for item in CONFIG['extras']:
    add_local(RECOVERY / safe(item['file']), item['role'], item.get('expected'))

full = json.loads((RECOVERY / 'full-suite/run-01/final-result.json').read_text())
runtime = json.loads((RECOVERY / 'render/recovered-original-runtime-proof-with-public.json').read_text())
state = json.loads((RECOVERY / 'state-compat/run-01/final-result.json').read_text())
assert full['candidateCommit'] == runtime['functionalCommit'] == '46963b57c5490afcd2e9da15468cce52234f931a'
assert full['candidateTree'] == runtime['functionalTree'] == '3c67dbdd818448f102395581a8dac32004eca5d2'
assert full['totals']['tests'] == full['totals']['pass'] == 2773
assert full['fileCount'] == 217 and full['all217TapLogsReadbackVerified'] and full['all217PipesEof']
assert runtime['runtimeProofVerified'] and runtime['publicSummaryVerified']
assert runtime['targetedTests'] == runtime['targetedPass'] == 275 and len(runtime['targetFiles']) == 12
assert state['canonicalFunctionalChecks'] == 8 and state['additionalFinancialSetupPoints'] == 4

for name, raw in payload.items():
    if name in original or not name.endswith(('.tap', '.log')):
        continue
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        continue
    header_count = len(re.findall(r'^TAP version 13$', text, re.M))
    if header_count == 1:
        try:
            all_taps[name] = tap.inspect_tap(raw)
        except AssertionError as exc:
            incomplete_or_mixed[name] = {**row(raw), 'tapHeaderCount': 1,
                                         'notCanonical': True, 'reason': str(exc)}
    elif header_count > 1:
        incomplete_or_mixed[name] = {**row(raw), 'tapHeaderCount': header_count,
                                     'notCanonical': True, 'reason': 'Combined raw driver; individual canonical streams are separate.'}

canonical_list = json.loads((RECOVERY / 'full-suite/evidence-export-allowlist.json').read_text())['canonicalTapFiles']
canonical = {PREFIX + '/full-suite/' + safe(n): all_taps[PREFIX + '/full-suite/' + safe(n)]
             for n in canonical_list}
assert len(canonical) == 217
assert sum(v['tap_counts']['tests'] for v in canonical.values()) == 2773
assert sum(v['tap_counts']['pass'] for v in canonical.values()) == 2773
assert all(v['tap_counts']['fail'] == v['tap_counts']['skipped'] == v['tap_counts']['cancelled'] == 0
           for v in canonical.values())
control = [name for name, value in all_taps.items() if name.startswith(PREFIX + '/') and
           value['log_sha256'] == 'd207cbd00085bc326f4de6f75b00638b0a693db610ad703244d67dd018f3cc1e']
assert len(control) == 1 and all_taps[control[0]]['tap_counts']['tests'] == 275

toolkit = sorted(name for name, values in roles.items() if 'standalone_toolkit' in values)
toolkit_manifest = {'kind': 'private_user_standalone_recovery_toolkit_not_external_git_publication',
                    'files': {n: row(payload[n]) for n in toolkit},
                    'immutableRepositoryBackedInputsExcluded': True,
                    'applicationSourceDependenciesModelsCustomerStateCredentialsExcluded': True,
                    'notARecoveryOfLost44Helpers': True}
add('standalone-recovery-tools-manifest.json', (json.dumps(toolkit_manifest, indent=2) + '\n').encode(), 'export_metadata')

proposal = {'kind': 'concrete_optional_private_github_update_pending_explicit_approval',
            'repository': 'mostafasaliha003-droid/flycham-whatsapp-assistant',
            'repositoryUrl': 'https://github.com/mostafasaliha003-droid/flycham-whatsapp-assistant',
            'destinationVisibility': 'private', 'prNumber': 9,
            'proposedPrTitle': 'Prepare consent-bound Raad workflow and verified fulfilment handoff',
            'proposedPrBody': CONFIG['proposedPrBody'],
            'toolkitFiles': [{'archivePath': n,
                             'proposedRepositoryPath': '.ci/raad-readiness/recovery-v16-20261101/' + n.removeprefix(PREFIX + '/'),
                             **row(payload[n])} for n in toolkit],
            'productionDeploymentAuthorizedByThisProposal': False,
            'newKeysCustomerStateMessagesGovernmentActionsOrPaymentsIncluded': False,
            'externalUpdatePerformed': False}
add('proposed-private-github-update.json', (json.dumps(proposal, indent=2) + '\n').encode(), 'proposed_update')

manifest = {
    'kind': 'recovered_container_and_new_functional_evidence_not_production_release',
    'evidence_package_version': 16,
    'currentReport': PREFIX + '/CURRENT-STATUS-v16.txt',
    'candidateCommit': full['candidateCommit'], 'candidateTree': full['candidateTree'],
    'applicationFingerprintSha256': full['applicationFingerprintSha256'],
    'applicationFiles': 431, 'firstPartyFiles': 445,
    'newRecoveryFreezeSha256': full['freezeManifestSha256'],
    'historicalContainerFreezeSha256': runtime['historicalBuildSourceFreezeSha256'],
    'distinctManifestHashesDoNotMeanSourceDrift': True,
    'currentUnitTotals': full['totals'], 'currentUnitFileCount': 217,
    'currentCanonicalTapStreams': canonical,
    'localFullSuiteIsNewReplacementRunAfterEvidenceLoss': True,
    'historicalLostLocal2773RawBytesReconstructed': False,
    'newLocalFullSuiteNode': full['nodeVersion'],
    'localDependenciesReused': True, 'localActualWallSeconds': full['actualWallSeconds'],
    'ciCommit': runtime['ciCommit'], 'ciTree': runtime['ciTree'],
    'containerDeploy': runtime['deployId'], 'containerTargetedTests': 275,
    'containerTargetedPass': 275, 'containerTargetedFiles': 12,
    'currentContainerControlTap': control[0],
    'containerEvidenceRestoredFromOriginal20261031Build': True,
    'newContainerBuildRequestedDuringRecovery': False,
    'containerTestsSubsetOfLocalFullSuite': True,
    'containerNativeBaselineChecks': 4, 'containerPdfChecks': 3,
    'currentSourceContainerBuilt': True, 'currentSourceContainerVerified': True,
    'runtimePublicPrivateSummaryMatched': True, 'vendorImageEqualityClaimed': False,
    'stateFunctionalChecks': 8, 'stateAdditionalFixtureSetupPoints': 4,
    'statePhysicalTapPoints': 12, 'stateLabIsConfigurationRestartNotProductionRestore': True,
    'intakeScenario': CONFIG['intakeScenario'], 'redRegression': CONFIG['redRegression'],
    'standaloneNonRepositoryToolkitFiles': len(toolkit),
    'standaloneToolkitIsPrivateUserDeliveryNotExternalGitPublication': True,
    'previous44HelperTreeRecoveredOrPublished': False,
    'additionalExternalGitPublicationAndPrDescriptionUpdatePendingApproval': True,
    'externalGitOrRenderMutationsDuringRecovery': False,
    'productionDeployed': False, 'productionMutations': False,
    'readyForDeployment': False, 'comprehensiveSecurityScanCompleted': False,
    'liveWhatsAppIntegrationCompleted': False, 'visualBrowserQaCompleted': False,
    'newProductionPromptModelAccuracyEvaluated': False,
    'realOtpModelGovernmentCustomerMessageOrPaymentActions': 0,
    'previousV15Manifest': 'history/evidence-manifest-v15.json',
    'previousV15ArchiveSha256': CONFIG['expectedBaseSha256'],
    'previousV15PayloadsPreservedUnchanged': len(original),
    'previousV15ManifestPreservedVerbatim': True,
    'allowlistReadbacks': allowlist_readbacks,
    'all_tap_streams': all_taps,
    'physicalCompleteTapStreams': len(all_taps),
    'physicalStreamsAreNotUniqueTestCounts': True,
    'combinedOrNoncanonicalLogsPreserved': incomplete_or_mixed,
    'newPayloadRoles': {n: sorted(v) for n, v in sorted(roles.items())},
    'files': {n: row(raw) for n, raw in sorted(payload.items())},
    'selfExcluded': True,
    'excluded': ['application source and source snapshots', 'repository-backed code copies',
                 'dependencies and models', 'runtime binaries', 'customer files and state',
                 'browser screenshots and application fixtures', 'keys and credentials']}
add('evidence-manifest.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode(), 'manifest')
assert not OUT.exists(), 'Do not overwrite an already frozen recovery archive'
with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, raw in sorted(payload.items()):
        z.writestr(name, raw)
with zipfile.ZipFile(OUT) as z:
    assert z.testzip() is None and len(z.namelist()) == len(set(z.namelist())) == len(payload)
    assert set(z.namelist()) == set(payload)
    for name, raw in payload.items():
        assert z.read(name) == raw, name
    for name, raw in original.items():
        assert z.read(name) == raw, name
    assert z.read('history/evidence-manifest-v15.json') == old_raw

audit = {'version': 16, 'zip': str(OUT), 'bytes': OUT.stat().st_size, 'sha256': sha(OUT.read_bytes()),
         'entries': len(payload), 'indexedPayloads': len(payload) - 1,
         'originalV15PayloadsUnchanged': len(original), 'oldManifestVerbatim': True,
         'allZipCrcAndPayloadHashesReadbackVerified': True,
         'canonicalTests': 2773, 'canonicalFiles': 217, 'restoredContainerTests': 275,
         'physicalCompleteTapStreams': len(all_taps), 'standaloneToolkitFiles': len(toolkit),
         'repositoryBackedAppAndHelperCopiesExcludedFromNewToolkit': True,
         'manifestSha256': sha(payload['evidence-manifest.json']), 'releaseReady': False}
(RECOVERY / 'package-audit-v16.json').write_text(json.dumps(audit, indent=2) + '\n')
backup = RECOVERY / 'previous-v15.zip'
assert not backup.exists()
shutil.copyfile(BASE, backup)
part = BASE.with_name(BASE.name + '.v16-part')
shutil.copyfile(OUT, part)
with part.open('rb') as stream:
    os.fsync(stream.fileno())
os.replace(part, BASE)
assert sha(BASE.read_bytes()) == audit['sha256']
print(json.dumps(audit, indent=2))
