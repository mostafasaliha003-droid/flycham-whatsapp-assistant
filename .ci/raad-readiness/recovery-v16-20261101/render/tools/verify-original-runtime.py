#!/usr/bin/env python3
"""Offline readback of recovered original container proof; does not run the app."""
import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(path):
    return json.loads(path.read_text())


def write_once(path, obj):
    raw = (json.dumps(obj, indent=2) + '\n').encode()
    assert not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    assert path.read_bytes() == raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collection-root', type=Path, required=True)
    parser.add_argument('--ci-inputs', type=Path, required=True)
    parser.add_argument('--tap-parser', type=Path, required=True)
    parser.add_argument('--tap-parser-sha256', required=True)
    parser.add_argument('--source-freeze', type=Path, required=True)
    parser.add_argument('--public-observation', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.collection_root.resolve(strict=True)
    normalizer = load_module(root / 'tools/normalize-recovered-pages.py', 'recovered_normalizer')
    decoder = load_module(root / 'tools/decode-original-v16-export.py', 'recovered_decoder')
    assert sha(args.tap_parser.read_bytes()) == args.tap_parser_sha256
    tap = load_module(args.tap_parser, 'strict_recorded_tap_parser')
    binding = read(root / 'terminal-binding.json')
    receipt = read(root / 'pagination-and-window-receipt.json')
    assert receipt['paginationEof'] and receipt['allInitialAndTailScopeIdentityVerified'] and receipt['postTerminalEmptyTailEof']
    deploy_path = root / 'raw/deploy-observation-0002.json'
    assert sha(deploy_path.read_bytes()) == receipt['deployRawSha256']
    deploy = normalizer.payload(deploy_path)
    assert deploy['id'] == binding['deployId'] and deploy['commit']['id'] == binding['ciCommit'] and deploy['status'] == 'live'
    assert deploy['startedAt'] == binding['startedAt'] and deploy['finishedAt'] == binding['finishedAt']
    actual_rows = []
    previous = None
    previous_timestamp = None
    seen = set()
    for page in receipt['pages']:
        raw_path, request_path = root / page['raw'], root / page['request']
        assert raw_path.stat().st_size == page['rawBytes'] and sha(raw_path.read_bytes()) == page['rawSha256']
        assert request_path.stat().st_size == page['requestBytes'] and sha(request_path.read_bytes()) == page['requestSha256']
        query, value = read(request_path), normalizer.payload(raw_path)
        normalizer.check_query(query, binding, receipt['requestLimit'])
        if previous:
            assert previous['hasMore'] is True
            assert query['startTime'] == previous['nextStartTime'] and query['endTime'] == previous['nextEndTime']
        else:
            assert query['startTime'] == binding['startTime'] and query['endTime'] == binding['endTime']
        for index, row in enumerate(value['logs']):
            assert row['id'] not in seen
            seen.add(row['id'])
            labels = {item['name']: item['value'] for item in row['labels']}
            assert labels['resource'] == binding['serviceId']
            stamp = normalizer.ns(row['timestamp'])
            assert previous_timestamp is None or stamp >= previous_timestamp
            previous_timestamp = stamp
            assert normalizer.ns(query['startTime']) <= stamp <= normalizer.ns(query['endTime'])
            assert normalizer.ns(binding['startTime']) <= stamp <= normalizer.ns(binding['finalEndTime'])
            actual_rows.append({'providerId': row['id'], 'timestamp': row['timestamp'], 'message': row['message'],
                                'labels': row['labels'], 'page': page['page'], 'rowIndex': index})
        previous = value
    assert previous['hasMore'] is False and len(actual_rows) == receipt['uniqueRows']
    query = read(root / 'requests/final-tail-page-0001.json')
    tail = normalizer.payload(root / 'raw/final-tail-page-0001.json')
    normalizer.check_query(query, binding, receipt['requestLimit'])
    assert query['startTime'] == previous['nextStartTime'] and query['endTime'] == binding['finalEndTime']
    assert tail['hasMore'] is False and tail['logs'] == []
    normalized = ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in actual_rows).encode()
    assert (root / 'normalized-log-rows.jsonl').read_bytes() == normalized
    assert (root / 'build-complete-derived.log').read_bytes() == ''.join(row['message'] + '\n' for row in actual_rows).encode()
    records = decoder.events_from_logs(actual_rows)
    meta, compressed, archive = decoder.decode_transport(records)
    assert len(compressed) == 19929 and sha(compressed) == '125cca1b0632d3b0744ca19a5b065d0da1097d92d031cd7f88525f9a8d45ab3d'
    assert meta['chunks'] == 26
    files = decoder.archive_members(archive)
    status = decoder.validate_artifacts(meta, files)
    assert status['buildEvidenceSuccess'] and len(files) == 19
    decoded = root / 'decoded-original'
    assert (decoded / 'transport-archive.tar.gz').read_bytes() == compressed
    assert read(decoded / 'transport-records.json') == records
    artifact_root = decoded / 'private-artifacts'
    assert {p.relative_to(artifact_root).as_posix() for p in artifact_root.rglob('*') if p.is_file()} == set(files)
    for name, raw in files.items():
        assert (artifact_root / name).read_bytes() == raw
    index = read(artifact_root / 'evidence-index.json')
    assert len(index['files']) == 18
    result, provenance = read(artifact_root / 'result.json'), read(artifact_root / 'build-provenance.json')
    ci, expected = read(args.ci_inputs / 'inputs.json'), read(args.ci_inputs / 'expected-source-manifest.json')
    for name in ['functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'sourceSnapshotSha256']:
        assert ci[name] == expected[name] == provenance[name] == binding[name]
    assert ci['buildNonce'] == provenance['buildNonce'] == binding['buildNonce']
    assert expected['files'] == ci['files'] and len(ci['files']) == 431
    recovered_freeze = read(args.source_freeze)
    assert recovered_freeze['candidateTree'] == ci['functionalTree']
    restored_application = {name: {'bytes': item['bytes'], 'sha256': item['sha256']}
                            for name, item in recovered_freeze['files'].items()
                            if not name.startswith(('.ci/', '.github/'))}
    assert restored_application == ci['files'] and len(recovered_freeze['files']) == 445
    app_map = {name: {'bytes': item['bytes'], 'sha256': item['sha256']} for name, item in ci['files'].items()}
    assert sha(json.dumps(app_map, sort_keys=True, separators=(',', ':')).encode()) == ci['applicationFingerprintSha256']
    assert provenance['toolFiles'] == ci['toolFiles']
    for name, digest in ci['toolFiles'].items():
        assert sha((args.ci_inputs / name).read_bytes()) == digest
    docker = (args.ci_inputs / 'Dockerfile.validation').read_text()
    assert docker.count('RUN --network=none --mount=type=bind,from=installed,source=/app,target=/app,ro') == 2
    assert ci['baseImageDigest'] in docker
    assert result['profileControlFiles'] == 12 and result['baselineChecks'] == 4 and result['pdfChecks'] == 3
    assert result['fullSuiteRerun'] is False and result['accuracyClaimed'] is False and result['releaseReady'] is False and result['liveActions'] == 0
    install = read(artifact_root / 'install/result.json')
    assert install['functionalCommit'] == binding['functionalCommit'] and install['functionalTree'] == binding['functionalTree']
    assert install['exitCode'] == 0 and install['stdoutEof'] and not install['timedOut']
    assert install['freshCache'] is True and install['nodeModulesReused'] is False and install['credentialsInherited'] is False
    assert install['modelVerified'] is True and install['sourceMismatchesAfter'] == []
    assert install['packageLockBefore'] == install['packageLockAfter'] == ci['files']['package-lock.json']['sha256']
    install_log = files['install/npm-install.log']
    assert len(install_log) == install['bytes'] and sha(install_log) == install['sha256']
    for phase in ['baseline', 'pdf']:
        step = read(artifact_root / phase / 'step.json')
        log = files[phase + '/native-probe.log']
        assert step['exitCode'] == 0 and step['stdoutEof'] and not step['timedOut']
        assert len(log) == step['bytes'] and sha(log) == step['sha256']
        phase_result = read(artifact_root / phase / 'result.json')
        assert json.loads(log.decode().splitlines()[-1]) == phase_result
        assert phase_result['network']['interfaces'] == ['lo'] and phase_result['network']['allInternal'] is True
        assert phase_result['syntheticOnly'] is True and phase_result['liveActions'] == 0 and phase_result['accuracyClaimed'] is False
    baseline, pdf = read(artifact_root / 'baseline/result.json'), read(artifact_root / 'pdf/result.json')
    assert len(baseline['checks']) == 4 and baseline['runtime'] == {'node': 'v26.13.0', 'npm': '11.20.0', 'debian': '12', 'glibc': '2.36'}
    assert baseline['model'] == {'bytes': 1452847, 'sha256': 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01'}
    assert baseline['ocr']['ownedChildCount'] == baseline['ocr']['readyCount'] == baseline['ocr']['closedChildCount'] == 1
    assert baseline['ocr']['rejectedBlank'] is True and baseline['ocr']['retainedTextOrImageBytes'] is False
    assert len(pdf['checks']) == 3 and pdf['pdfTools'] == {'pdfinfo': '22.12.0', 'pdftoppm': '22.12.0'}
    assert pdf['pdf']['syntheticPages'] == 2 and pdf['pdf']['orderedColorMarkers'] is True
    assert [item['kind'] for item in pdf['merges']] == ['passport', 'residence']
    assert all(item['orderedColorMarkers'] and item['needsVisualReview'] for item in pdf['merges'])
    startup = read(artifact_root / 'startup/result.json')
    assert startup['functionalCommit'] == binding['functionalCommit'] and startup['applicationFingerprintSha256'] == binding['applicationFingerprintSha256']
    assert startup['passed'] and startup['effectiveCommand'] == 'npm start' and startup['stdoutEof']
    assert startup['sourceFilesVerifiedBeforeAndAfter'] == 431 and startup['noInheritedEnvironment']
    assert startup['health'] == {'status': 200, 'ok': True, 'mode': 'dry-run', 'visaEnabled': False, 'consultantEnabled': False}
    assert startup['blockedAttempts'] == startup['liveActions'] == 0 and startup['platformImageParityClaimed'] is False
    assert len(files['startup/npm-start.log']) == startup['logBytes'] and sha(files['startup/npm-start.log']) == startup['logSha256']
    assert 'startup/blocked-attempts.jsonl' not in files or not files['startup/blocked-attempts.jsonl'].strip()
    startup_step = read(artifact_root / 'startup-step.json')
    assert startup_step['exitCode'] == 0 and startup_step['stdoutEof'] and not startup_step['timedOut']
    assert len(files['startup-driver.log']) == startup_step['bytes'] and sha(files['startup-driver.log']) == startup_step['sha256']
    smoke = json.loads(files['startup/native-smoke.log'])
    assert smoke['passed'] and smoke['node'] == 'v26.13.0' and smoke['modelVerified'] and smoke['liveActions'] == 0
    controls = read(artifact_root / 'profile-controls/result.json')
    names_ast = next(node for node in ast.walk(ast.parse((args.ci_inputs / 'build-gate.py').read_text()))
                     if isinstance(node, ast.FunctionDef) and node.name == 'profile_controls')
    assignment = next(node for node in names_ast.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'names' for t in node.targets))
    expected_paths = ['test/' + name + '.test.js' for name in ast.literal_eval(assignment.value)]
    assert controls['testFiles'] == expected_paths and len(expected_paths) == len(set(expected_paths)) == 12
    assert controls['command'] == ['/opt/node/bin/node', '--test', '--test-reporter=tap', '--test-concurrency=2', *expected_paths]
    assert controls['exitCode'] == 0 and controls['stdoutEof'] and not controls['timedOut'] and controls['filesInvokedOnceEach'] is True
    strict = tap.inspect_tap(files['profile-controls/test.log'])
    assert strict['log_bytes'] == controls['bytes'] and strict['log_sha256'] == controls['sha256']
    counts = strict['tap_counts']
    assert counts == {'tests': 275, 'suites': 0, 'pass': 275, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
    assert {key: counts[key] for key in controls['counts']} == controls['counts']
    public_verified = False
    if args.public_observation:
        observation = read(args.public_observation)
        assert observation['deployId'] == binding['deployId'] and observation['ciCommit'] == binding['ciCommit']
        report = observation['report']
        assert observation['url'] == 'https://flycham-validation-f019ad0.onrender.com/report'
        expected_public = {'kind': 'isolated_main_node26_validation', **{key: ci[key] for key in ['functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'buildNonce', 'baseImageDigest', 'sourceSnapshotSha256']},
                           'applicationFiles': 431, 'nodeVersion': 'v26.13.0', 'npmVersion': '11.20.0', 'debianVersion': '12', 'glibcVersion': '2.36', 'pdfToolsVersion': '22.12.0',
                           'freshInstallPassed': True, 'lockUnchanged': True, 'baselineChecks': 4, 'startupPassed': True, 'pdfChecks': 3, 'profileControlFiles': 12, 'profileControlsPassed': True,
                           'scope': 'derived_debian12_validation_not_platform_image_equivalence', 'fullSuiteRerun': False, 'mrzAccuracyClaimed': False, 'buildOnly': True, 'releaseReady': False, 'liveActions': 0,
                           'evidenceSha256': sha(compressed), 'evidenceBytes': len(compressed), 'evidenceChunks': meta['chunks']}
        assert json.dumps(report, sort_keys=True) == json.dumps(expected_public, sort_keys=True), 'PUBLIC_PRIVATE_TYPED_COHERENCE'
        public_verified = True
    proof = {'kind': 'recovered_original_v16_container_runtime_proof', 'runtimeProofVerified': True,
             **{key: binding[key] for key in ['functionalCommit', 'functionalTree', 'applicationFingerprintSha256', 'buildNonce', 'ciCommit', 'ciTree', 'deployId', 'sourceSnapshotSha256']},
             'originalBuildDateUtc': '2026-10-31', 'recoveryDateUtc': '2026-11-01', 'newContainerBuildRequested': False,
             'rawProviderPages': len(receipt['pages']), 'rawProviderRows': len(actual_rows), 'sameScopeEmptyTailEofVerified': True,
             'transportChunks': meta['chunks'], 'gzipBytes': len(compressed), 'gzipSha256': sha(compressed), 'archiveMembers': len(files), 'indexedMembers': len(index['files']),
             'targetFiles': expected_paths, 'targetedTests': 275, 'targetedPass': 275, 'strictTargetedTap': strict,
             'nativeBaselineChecks': 4, 'nativePdfChecks': 3, 'freshInstallSourceLockModelProof': True,
             'immutableCiToolHashesVerified': True, 'sourceArchiveBytesDownloadedByRecovery': False,
             'recoveredSource445ToOriginalCi431ManifestBindingVerified': True,
             'historicalBuildSourceFreezeSha256': ci['sourceFreezeSha256'],
             'newRecoverySourceFreezeSha256': sha(args.source_freeze.read_bytes()),
             'publicSummaryVerified': public_verified, 'modelAccuracyEvaluated': False, 'securityScanCompleted': False,
             'realMetaGovernmentIntegrationTested': False, 'visualQaCompleted': False, 'vendorImageParityClaimed': False, 'productionReady': False}
    write_once(args.output, proof)
    print(json.dumps(proof, indent=2))


if __name__ == '__main__':
    main()
