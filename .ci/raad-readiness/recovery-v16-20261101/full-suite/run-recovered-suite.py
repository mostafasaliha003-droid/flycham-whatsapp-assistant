#!/usr/bin/env python3
"""Capture a new, offline-guarded functional run after ephemeral evidence loss.

Existing dependencies and the separately supplied OCR model are reused. This
does not install packages, contact providers, build a container or run an audit.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import time

COMMIT = '46963b57c5490afcd2e9da15468cce52234f931a'
TREE = '3c67dbdd818448f102395581a8dac32004eca5d2'
FINGERPRINT = 'a866c28ea01f64f8fdf90cb58de6953884b570bd3400d61e917eb5e74727ef5d'
NODE_SHA = '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b'
MODEL_SHA = 'ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01'
TEMPLATES = {
    'durable-child-config.json': '99c73b78ca5c966c8876e55a4c2b37522c3f0f62c97ace2270e15615bdf9f2e7',
    'offline-dialogue-optical-guard.cjs': '9f45760d2c3da647fe7b83495a632fa22f94bfb53c47254dcd1bb09863e842f1',
    'offline-durable-budget-guard.cjs': 'cbbbc347c006769ce5f6dac81630a92c9cd7b78cb27e8527baab398989049948',
    'offline-loopback-guard.cjs': '03030eb322796ec0b363c25ca15c2e795c607de9b9751e85158de6499100a44c',
    'offline-optical-child-guard.cjs': '2f6033e58bf0d373fa4bfc8d74596daf65e404fecd9f46578f61f16148fede24',
    'offline-pdf-guard.cjs': 'a675b116ea3453bcd9ac5d6a09a7ab515d4246ef2a28aede816e24d2903dd101',
    'optical-child-config.json': '3893d2aafb2a8b6fbe5b4e72fcd1a326a4eadfd86540a903c2f6af85e3454882',
    'run-file-tests-once.py': '3e4c55b214c947799d9d08e7714de5cd37a41ae9c8bc5f8af3533d0cf7ba26a2',
    'tap_log_evidence.py': 'ecd59e282cc3463265f68b8eab4bf3c1c6e4710e5097def471795296075f5827',
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def record(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def save(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + '.part')
    with partial.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(partial, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    assert path.read_bytes() == raw


def dump(path, value):
    save(path, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode())


def safe(name):
    path = PurePosixPath(name)
    assert name and path.as_posix() == name and not path.is_absolute()
    assert '..' not in path.parts and '\\' not in name
    return name


def inventory(root, files):
    result = {}
    for name, expected in sorted(files.items()):
        path = root / safe(name)
        assert path.is_file() and not path.is_symlink(), name
        raw = path.read_bytes()
        mode = '100755' if path.stat().st_mode & stat.S_IXUSR else '100644'
        value = {**record(raw), 'mode': mode,
                 'gitBlob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()}
        assert value['bytes'] == expected['bytes'] and value['sha256'] == expected['sha256'], name
        assert value['mode'] == expected['mode'], name
        if 'gitBlob' in expected:
            assert value['gitBlob'] == expected['gitBlob'], name
        result[name] = value
    actual = set()
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if {'node_modules', 'var', '.git', '__pycache__'}.intersection(relative.parts):
            continue
        if path.is_file():
            actual.add(relative.as_posix())
    assert actual == set(files), 'UNFROZEN_FIRST_PARTY_FILE'
    return result


def git_tree(files):
    folder = {}
    for path, item in files.items():
        cursor = folder
        parts = path.split('/')
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = item

    def encode(node):
        entries = []
        for name, value in node.items():
            directory = 'gitBlob' not in value
            entries.append((name + ('/' if directory else ''), name,
                            '40000' if directory else value['mode'],
                            encode(value) if directory else value['gitBlob']))
        raw = b''.join(mode.encode() + b' ' + name.encode() + b'\0' + bytes.fromhex(blob)
                       for _, name, mode, blob in sorted(entries))
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    return encode(folder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'freeze', 'dependencies', 'model', 'node', 'harness', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--freeze-sha256', required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    freeze_path = args.freeze.resolve(strict=True)
    dependencies = args.dependencies.resolve(strict=True)
    model = args.model.resolve(strict=True)
    node = args.node.resolve(strict=True)
    harness = args.harness.resolve(strict=True)
    out = args.out.resolve()
    assert not out.exists(), 'ONE_NEW_RUN_ONLY_OUTPUT_EXISTS'
    freeze_raw = freeze_path.read_bytes()
    assert sha(freeze_raw) == args.freeze_sha256
    freeze = json.loads(freeze_raw)
    assert freeze['candidateTree'] == TREE
    assert freeze['applicationFingerprintSha256'] == FINGERPRINT
    files = freeze['files']
    assert len(files) == 445
    before = inventory(source, files)
    assert git_tree(before) == TREE
    app = {name: {'bytes': item['bytes'], 'sha256': item['sha256']}
           for name, item in before.items() if not name.startswith(('.ci/', '.github/'))}
    assert len(app) == 431
    assert sha(json.dumps(app, sort_keys=True, separators=(',', ':')).encode()) == FINGERPRINT
    assert sha(node.read_bytes()) == NODE_SHA
    assert model.stat().st_size == 1452847 and sha(model.read_bytes()) == MODEL_SHA
    assert dependencies.is_dir()
    node_version = subprocess.check_output([str(node), '--version'], env={'PATH': str(node.parent) + ':/usr/bin:/bin'}).decode().strip()
    assert node_version == 'v26.13.0'
    template_paths = {name: harness / name for name in TEMPLATES}
    # This exact parser is already repository-backed; the standalone toolkit
    # references the verified immutable app copy instead of duplicating it.
    if not template_paths['tap_log_evidence.py'].exists():
        template_paths['tap_log_evidence.py'] = source / '.ci/raad-readiness/test-tools/tap_log_evidence.py'
    for name, digest in TEMPLATES.items():
        assert sha(template_paths[name].read_bytes()) == digest, name
    out.mkdir(parents=True)
    execution = out / 'execution'
    build = execution / 'test-build'
    tools = execution / 'test-tools'
    build.mkdir(parents=True)
    tools.mkdir()
    for name, item in files.items():
        path = build / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, path)
        os.chmod(path, int(item['mode'], 8) & 0o777)
    (build / 'node_modules').symlink_to(dependencies, target_is_directory=True)
    staged_model = build / 'var/mrz-model/mrz.traineddata'
    staged_model.parent.mkdir(parents=True)
    shutil.copyfile(model, staged_model)
    for name in TEMPLATES:
        shutil.copyfile(template_paths[name], tools / name)
    config = json.loads((tools / 'durable-child-config.json').read_text())
    config['module'] = str(build / 'src/visa-mrz-durable-budget.js')
    assert sha(Path(config['module']).read_bytes()) == config['moduleSha256']
    (tools / 'durable-child-config.json').write_text(json.dumps(config, indent=2) + '\n')
    config = json.loads((tools / 'optical-child-config.json').read_text())
    config['test'] = str(build / 'test/visa-dialogue-regression.test.js')
    config['worker'] = str(build / 'src/visa-mrz-optical-worker.js')
    config['tesseractWorker'] = str(build / 'node_modules/tesseract.js/src/worker-script/node/index.js')
    for path_key, hash_key in [('test', 'testSha256'), ('worker', 'workerSha256'), ('tesseractWorker', 'tesseractWorkerSha256')]:
        assert sha(Path(config[path_key]).read_bytes()) == config[hash_key]
    (tools / 'optical-child-config.json').write_text(json.dumps(config, indent=2) + '\n')
    runner_path = tools / 'run-file-tests-once.py'
    runner = runner_path.read_text()
    replacements = {
        "'candidateCommit':None": "'candidateCommit':" + repr(COMMIT),
        "'candidateCommitStatus':'local freeze only; prior e441 does not match this fixture-corrected tree'": "'candidateCommitStatus':'existing immutable private Git source; fresh recapture after ephemeral raw-log loss'",
        '036355159f736467891c29ec6383b928ae4b6d2d': TREE,
        '5fc02e363543161c53a9bc540d05f7bc3cb824825fb3f5dff92d57f60577e756': FINGERPRINT,
        'fresh_npm_ci_completed_in_this_isolated_project_before_source_freeze': 'reused_previously_installed_approved_dependencies_no_install_in_this_run',
    }
    for old, new in replacements.items():
        assert runner.count(old) == 1, old
        runner = runner.replace(old, new)
    compile(runner, str(runner_path), 'exec')
    runner_path.write_text(runner)
    before_stage = inventory(build, files)
    assert before_stage == before
    discovered = sorted(str(path.relative_to(build)) for folder in ['test', 'src']
                        for path in (build / folder).rglob('*.test.js'))
    discovered += ['scripts/raad-paired-candidates-check.cjs', 'scripts/supervisor-end-to-end-check.cjs']
    assert len(discovered) == len(set(discovered)) == 217
    tool_hashes = {p.name: record(p.read_bytes()) for p in tools.iterdir() if p.is_file()}
    command = ['python3', str(runner_path), '--dependencies', str(dependencies), '--workers', '3', '--timeout', '45']
    plan = {'kind': 'fresh_functional_run_after_ephemeral_raw_log_loss', 'candidateCommit': COMMIT,
            'candidateTree': TREE, 'applicationFingerprintSha256': FINGERPRINT, 'freezeManifestSha256': args.freeze_sha256,
            'source': str(source), 'isolatedProject': str(build), 'files': before, 'discoveredFiles': discovered,
            'node': str(node), 'nodeSha256': NODE_SHA, 'nodeVersion': node_version,
            'dependencies': str(dependencies), 'dependencyInstallPerformed': False,
            'model': str(model), 'modelSha256': MODEL_SHA, 'modelBytes': 1452847,
            'harnessTemplates': TEMPLATES, 'executionToolHashes': tool_hashes,
            'command': command, 'exactlyOncePerFile': True,
            'reasonForNewRun': 'Prior 2773-run raw files disappeared after interruption. This produces new logs and does not recreate their historical bytes.',
            'scope': 'Guarded functional JavaScript transports and narrowly scoped child-process instrumentation; not OS network isolation, a clean install, vendor image, security scan or real provider integration.',
            'noCustomerStateOrCredentialsCopied': True}
    dump(out / 'execution-plan.json', plan)
    print(json.dumps({'launching': True, 'files': 217, 'commit': COMMIT, 'tree': TREE}), flush=True)
    started = time.monotonic()
    process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             env={'PATH': str(node.parent) + ':' + os.environ['PATH'], 'TZ': 'UTC'})
    wall = time.monotonic() - started
    save(out / 'full-suite-driver.log', process.stdout)
    assert inventory(source, files) == before
    assert inventory(build, files) == before_stage
    assert sha(model.read_bytes()) == sha(staged_model.read_bytes()) == MODEL_SHA
    assert {p.name: record(p.read_bytes()) for p in tools.iterdir() if p.is_file()} == tool_hashes
    summaries = list((execution / 'results').glob('file-suite-*/summary.json'))
    assert len(summaries) == 1
    summary_path = summaries[0]
    summary = json.loads(summary_path.read_text())
    assert len(summary['results']) == 217
    assert {row['file'] for row in summary['results']} == set(discovered)
    assert len({row['file'] for row in summary['results']}) == 217
    spec = importlib.util.spec_from_file_location('tap', tools / 'tap_log_evidence.py')
    tap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tap)
    for row in summary['results']:
        assert row['stdout_eof'] and row['log_complete'] and row['log_write_verified'], row['file']
        tap.inspect_tap_file(summary_path.parent / row['log'], row)
    for path in [summary_path, summary_path.parent]:
        descriptor = os.open(path, os.O_RDONLY | (os.O_DIRECTORY if path.is_dir() else 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    result = {'kind': 'fresh_current_source_functional_evidence', 'candidateCommit': COMMIT,
              'candidateTree': TREE, 'applicationFingerprintSha256': FINGERPRINT,
              'freezeManifestSha256': args.freeze_sha256, 'exitCode': process.returncode,
              'totals': summary['totals'], 'completed': summary['completed'],
              'sourceFilesHashAndGitModesUnchanged': 445, 'sourceAndStageUnchanged': True,
              'guardsUnchanged': summary['guard_unchanged'], 'modelUnchanged': True,
              'exactDiscoveredSetExecutedOnce': True, 'fileCount': 217,
              'all217TapLogsReadbackVerified': True, 'all217PipesEof': True,
              'driver': record(process.stdout), 'driverPipeEof': True, 'driverReadbackVerified': True,
              'summary': str(summary_path), 'actualWallSeconds': wall,
              'nodeVersion': node_version, 'dependenciesReusedNoInstall': True,
              'fullSuiteRunsOnThisRecoveredSource': 1, 'historicalRaw2773LogsRecreated': False,
              'liveMetaGovernmentModelCalls': 0, 'productionActions': 0,
              'boundary': plan['scope']}
    dump(out / 'final-result.json', result)
    allowed = [out / 'execution-plan.json', out / 'final-result.json', out / 'full-suite-driver.log', summary_path]
    allowed += sorted(path for path in summary_path.parent.iterdir() if path.is_file() and path != summary_path)
    allow = {'kind': 'explicit_logs_metadata_only_export_allowlist', 'root': str(out),
             'files': [{'file': str(path.relative_to(out)), **record(path.read_bytes())} for path in allowed],
             'sourceCodeDependenciesRuntimeModelStateExcluded': True,
             'currentTapFiles': [str((summary_path.parent / row['log']).relative_to(out)) for row in summary['results']],
             'physicalTapFiles': 217, 'executedOnce': True, 'helperSourcesNotIncluded': True,
             'allowlistMayBeExported': True}
    dump(out / 'evidence-only-export-allowlist.json', allow)
    print(json.dumps(result, indent=2), flush=True)
    return process.returncode


if __name__ == '__main__':
    raise SystemExit(main())
