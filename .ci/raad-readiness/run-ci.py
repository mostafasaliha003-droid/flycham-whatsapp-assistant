#!/usr/bin/env python3
"""Build-only CI: exact committed source, fresh install/image, fenced unit suite.

--unit-only --dependencies PATH exercises the identical source staging and log
collector locally without claiming an image build. No deploy/registry push/keys.
"""
import argparse
import hashlib
import importlib.util
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


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def durable(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + '.part')
    with part.open('wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(part, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    assert path.read_bytes() == raw


def dump(path, value):
    durable(path, (json.dumps(value, indent=2) + '\n').encode())


def snapshot(folder):
    files = {}
    for path in sorted(folder.rglob('*')):
        rel = path.relative_to(folder)
        if path.is_symlink() or not path.is_file():
            continue
        if any(piece in {'node_modules', '.git', 'var', '__pycache__'} for piece in rel.parts):
            continue
        raw = path.read_bytes()
        files[str(rel)] = {'bytes': len(raw), 'sha256': sha(raw)}
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workspace', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--unit-only', action='store_true')
    parser.add_argument('--dependencies', type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    output = args.output.absolute()
    assert not output.is_relative_to(workspace), 'OUTPUT_MUST_BE_OUTSIDE_CHECKOUT'
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    artifacts = output/'artifacts'; artifacts.mkdir()
    stage = output/'stage'; stage.mkdir()
    build = stage/'test-build'; build.mkdir()
    home = output/'home'; home.mkdir()
    env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    records = []

    def run(label, command, cwd, timeout):
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        timed_out = False
        try:
            raw, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                raw, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                raw, _ = process.communicate()
        log = artifacts/(label+'.log')
        durable(log, raw)
        entry = {'step': label, 'exit_code': process.returncode, 'timeout': timed_out,
                 'seconds': round(time.monotonic()-started, 3), 'stdout_eof': True,
                 'log_bytes': len(raw), 'log_sha256': sha(raw), 'readback_verified': True}
        records.append(entry); dump(artifacts/'steps.json', records)
        return process.returncode if not timed_out else 124

    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace,
                                       env=env, text=True).strip()
    if os.environ.get('GITHUB_SHA'):
        assert revision == os.environ['GITHUB_SHA'], 'CHECKOUT_COMMIT_MISMATCH'
    archive = subprocess.check_output(['git', 'archive', '--format=tar', 'HEAD'],
                                      cwd=workspace, env=env)
    skipped = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as tree:
        for item in tree:
            rel = PurePosixPath(item.name)
            assert not rel.is_absolute() and '..' not in rel.parts
            if any(piece in {'.git', '.github', '.ci', 'node_modules', 'var', 'uploads', 'state', '__pycache__'} for piece in rel.parts):
                skipped.append(item.name); continue
            if rel.name in {'.env', '.npmrc'} or rel.name.startswith('.env.') and rel.name != '.env.example':
                skipped.append(item.name); continue
            if item.isdir():
                continue
            assert item.isfile(), 'NON_REGULAR_COMMITTED_INPUT'
            target = build/str(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tree.extractfile(item).read())
            target.chmod(item.mode & 0o777)
    tooling = Path(__file__).resolve().parent
    shutil.copytree(tooling/'test-tools', stage/'test-tools')
    source = snapshot(build)
    fingerprint = sha(json.dumps(source, sort_keys=True, separators=(',', ':')).encode())
    dump(artifacts/'source-manifest.json', {'commit': revision, 'files': source,
        'application_fingerprint_sha256': fingerprint, 'archive_sha256': sha(archive),
        'excluded_committed_paths': skipped})
    status = {'commit': revision, 'unit_only': args.unit_only, 'container_build': False,
              'unit_suite': False, 'release_ready': False, 'deployments': 0,
              'customer_messages': 0, 'government_operations': 0, 'keys_created': 0}
    success = False
    try:
        if args.unit_only:
            assert args.dependencies and args.dependencies.is_dir(), 'EXPLICIT_EXISTING_DEPS_REQUIRED'
            deps = args.dependencies.resolve()
        else:
            code = run('build-driver', [sys.executable, str(tooling/'clean-build-validate.py'),
                       str(build), str(output/'build-evidence')], workspace, 2800)
            for file in (output/'build-evidence').glob('*'):
                if file.is_file() and file.suffix in {'.log', '.json'}:
                    durable(artifacts/'build'/file.name, file.read_bytes())
            assert code == 0, 'CLEAN_BUILD_OR_CONTAINER_FAILED'
            status['container_build'] = True
            deps = output/'build-evidence/source/node_modules'
        assert deps.is_dir()
        # Manifest equality binds the fresh installation to this exact candidate.
        if not args.unit_only:
            for name in ['package.json', 'package-lock.json']:
                assert (build/name).read_bytes() == (deps.parent/name).read_bytes()
        code = run('unit-driver', [sys.executable, str(stage/'test-tools/run-checks.py'),
                   '--dependencies', str(deps), '--full'], stage, 900)
        final_path = stage/'results/final-validation.json'
        assert final_path.is_file(), 'FINAL_UNIT_SUMMARY_MISSING'
        final = json.loads(final_path.read_text())
        spec = importlib.util.spec_from_file_location('ci_tap_evidence', stage/'test-tools/tap_log_evidence.py')
        tap = importlib.util.module_from_spec(spec); spec.loader.exec_module(tap)
        index = []
        for row in final['results']:
            src = stage/row['log']
            raw = src.read_bytes()
            evidence = tap.inspect_tap_bytes(raw, row)
            dest = artifacts/'unit/logs'/src.name
            durable(dest, raw)
            assert tap.inspect_tap_bytes(dest.read_bytes(), row) == evidence
            index.append({'file': row['file'], 'log': str(dest.relative_to(artifacts)), **evidence})
        dump(artifacts/'unit/log-index.json', index)
        # Canonical paths refer only to included logs, never private workspaces.
        for row, saved in zip(final['results'], index):
            row['source_run_log'] = row['log']
            row['log'] = saved['log']
        dump(artifacts/'unit/final-validation.json', final)
        groups = stage/'results/test-summary.json'
        if groups.is_file():
            durable(artifacts/'unit/test-summary.json', groups.read_bytes())
        for name in ['targeted.log', 'bridge.log', 'http-smoke.log']:
            file = stage/'results'/name
            if file.is_file():
                durable(artifacts/'unit'/name, file.read_bytes())
        assert code == 0 and not final['missing_files'] and not final['incomplete_logs']
        totals = final['totals']
        assert totals['files'] == len(index) > 0 and totals['files_failed'] == 0
        assert totals['tests'] == totals['pass'] > 0
        assert not any(totals.get(k, 0) for k in ['fail', 'cancelled', 'skipped', 'todo', 'blocked_attempts'])
        assert source == snapshot(build), 'SOURCE_MUTATED_DURING_CHECKS'
        status['unit_suite'] = True
        status['unit_totals'] = totals
        success = True
    except Exception as error:
        status['failure'] = str(error) if str(error).isupper() else type(error).__name__
        # If finalization could not finish, retain only synthetic test diagnostics,
        # without uploading the source/dependency/runtime directories.
        for file in (stage/'results').rglob('*'):
            if file.is_file() and file.suffix in {'.tap', '.log', '.json', '.jsonl'}:
                rel = file.relative_to(stage/'results')
                dest = artifacts/'unit-failure-diagnostics'/str(rel)
                if file.suffix == '.tap':
                    dest = dest.with_suffix('.diagnostic.log')
                durable(dest, file.read_bytes())
        print('CI_VALIDATION_FAILED', file=sys.stderr)
    finally:
        status['success'] = success
        status['application_fingerprint_sha256'] = fingerprint
        dump(artifacts/'result.json', status)
        files = {str(p.relative_to(artifacts)): {'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())}
                 for p in sorted(artifacts.rglob('*')) if p.is_file()}
        dump(artifacts/'evidence-index.json', {'files': files, 'self_excluded': True})
    print(json.dumps(status, indent=2))
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
