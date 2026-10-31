#!/usr/bin/env python3
"""Run each source test in a fresh fenced Node process, without a live environment.

Python owns process isolation because the unchanged Node transport fence forbids
application subprocesses. This is a functional test runner, not a clean install
or container build. It never installs packages, opens a browser or deploys.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from tap_log_evidence import TapEvidenceError, inspect_tap_file, write_log_atomically


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dependencies', required=True,
                        help='Existing local node_modules directory; no install is performed')
    parser.add_argument('--extra-dependencies', action='append', default=[],
                        help='Additional existing approved runtime dependency directory')
    parser.add_argument('--pdf-tools', action='store_true',
                        help='Only for the synthetic raad-pdf test; allow scoped local converters')
    parser.add_argument('--workers', type=int, default=3, choices=(1, 2, 3))
    parser.add_argument('--timeout', type=int, default=45, choices=range(1, 46),
                        metavar='1..45')
    parser.add_argument('--file', action='append', dest='selected',
                        help='Optional exact discovered relative test path; repeat to select files')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    build = root / 'test-build'
    deps = Path(args.dependencies).resolve()
    dependency_roots = [deps, *(Path(p).resolve() for p in args.extra_dependencies)]
    guard = root / 'test-tools' / ('offline-pdf-guard.cjs' if args.pdf_tools else 'offline-loopback-guard.cjs')
    node = shutil.which('node')
    if not node or not all(p.is_dir() for p in dependency_roots) or not build.is_dir() or not guard.is_file():
        raise SystemExit('LOCAL_NODE_BUILD_DEPENDENCIES_AND_GUARD_REQUIRED')
    # Unit factories expect the source's normal local in-memory state. Never
    # let its Render auto-detection read a real mounted production data disk.
    mountinfo=Path('/proc/self/mountinfo')
    if mountinfo.exists():
        for line in mountinfo.read_text().splitlines():
            fields=line.split(' - ')
            if len(fields)==2 and len(fields[0].split())>4 and fields[0].split()[4]=='/var/data' and fields[1].split()[0] in ('ext4','xfs','btrfs'):
                raise SystemExit('UNIT_TESTS_REFUSE_A_REAL_RENDER_DATA_MOUNT')
    guard_sha = hashlib.sha256(guard.read_bytes()).hexdigest()
    files = sorted({str(p.relative_to(build)) for folder in ('test', 'src')
                    for p in (build / folder).rglob('*.test.js')})
    for path in ('scripts/raad-paired-candidates-check.cjs',
                 'scripts/supervisor-end-to-end-check.cjs'):
        if not (build / path).is_file():
            raise SystemExit('PAIRED_CHECK_SCRIPT_REQUIRED')
        files.append(path)
    if args.selected:
        if not set(args.selected).issubset(files):
            raise SystemExit('SELECTED_FILE_NOT_IN_DISCOVERED_TESTS')
        files = sorted(set(args.selected))
    if not files:
        raise SystemExit('NO_TEST_FILES')
    if args.pdf_tools and files != ['test/raad-pdf.test.js']:
        raise SystemExit('PDF_VARIANT_REQUIRES_ONLY_THE_SYNTHETIC_PDF_TEST')
    results = root / 'results'
    results.mkdir(exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='file-suite-', dir=results))
    runtime = Path(tempfile.mkdtemp(prefix='isolated-file-checks-', dir=root))
    summary_path = output / 'summary.json'
    lock = threading.RLock()
    stop = threading.Event()
    processes = {}
    state = {
        'started_at': utc_now(), 'finished_at': None, 'completed': False,
        'source': str(build), 'dependencies': [str(p) for p in dependency_roots], 'node': node,
        'dependency_install': 'existing_local_modules_not_a_clean_lockfile_install',
        'guard': str(guard), 'guard_sha256': guard_sha,
        'workers': args.workers, 'timeout_seconds_per_file': args.timeout,
        'file_count': len(files), 'running': [], 'results': [],
    }

    def save():
        with lock:
            rows = state['results']
            totals = {key: sum(row.get(key, 0) or 0 for row in rows)
                      for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo',
                                  'blocked_attempts')}
            totals.update(files_completed=len(rows),
                          files_passed=sum(row['exit_code'] == 0 for row in rows),
                          files_failed=sum(row['exit_code'] != 0 for row in rows),
                          files_timed_out=sum(row['timeout'] for row in rows),
                          files_without_tap_summary=sum(row['tests'] is None for row in rows))
            state['totals'] = totals
            state['results'].sort(key=lambda row: row['file'])
            temporary = summary_path.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False) + '\n')
            os.replace(temporary, summary_path)

    def kill(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def shutdown(signum, frame):
        stop.set()
        with lock:
            for process in list(processes.values()):
                kill(process)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def run_file(path):
        stem = re.sub(r'[^A-Za-z0-9_.-]+', '_', path) + '-' + hashlib.sha256(path.encode()).hexdigest()[:8]
        local = runtime / stem
        (local / 'home').mkdir(parents=True)
        (local / 'tmp').mkdir()
        log = output / (stem + '.tap')
        blocked = output / (stem + '-blocked.jsonl')
        env = {
            'PATH': os.environ.get('PATH', ''), 'HOME': str(local / 'home'),
            'TMPDIR': str(local / 'tmp'), 'LANG': 'C.UTF-8',
            'NODE_PATH': os.pathsep.join(str(p) for p in dependency_roots), 'NODE_OPTIONS': '--require=' + str(guard),
            'OFFLINE_GUARD_LOG': str(blocked),
            'SAUDI_VISA_PRIVATE_PATH': str(local / 'no-private-config.enc'),
        }
        if args.pdf_tools:
            env['ISOLATED_PDF_ALLOW_LOG'] = str(output / (stem + '-pdf-tools.jsonl'))
        command = [node, '--test', '--test-isolation=none', '--test-reporter=tap', path]
        row = {'file': path, 'started_at': utc_now(), 'finished_at': None,
               'exit_code': 125, 'timeout': False, 'log': str(log.relative_to(output)),
               'blocked_log': str(blocked.relative_to(output))}
        started = time.monotonic()
        captured=b''
        row['stdout_eof']=False
        with lock:
            state['running'].append(path)
            save()
        try:
            if stop.is_set():
                row['runner_error'] = 'RUN_CANCELLED'
            elif hashlib.sha256(guard.read_bytes()).hexdigest() != guard_sha:
                row['runner_error'] = 'TRANSPORT_GUARD_CHANGED'
            else:
                process = subprocess.Popen(command, cwd=build, env=env, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           start_new_session=True)
                with lock:
                    processes[path] = process
                    if stop.is_set():
                        kill(process)
                try:
                    captured,_=process.communicate(timeout=args.timeout)
                    row['stdout_eof']=True
                    row['exit_code']=process.returncode
                except subprocess.TimeoutExpired:
                    row['timeout']=True
                    kill(process)
                    captured,_=process.communicate(timeout=5)
                    row['stdout_eof']=True
                    row['exit_code']=124
        except Exception as error:
            row['runner_error'] = type(error).__name__
        finally:
            with lock:
                processes.pop(path, None)
        row['test_exit_code']=row['exit_code']
        for key in ('tests','suites','pass','fail','cancelled','skipped','todo'):
            row[key]=None
        try:
            evidence=write_log_atomically(log,captured)
            # Re-open the durable file, independent of the captured PIPE bytes.
            persisted=inspect_tap_file(log,evidence)
            row.update(persisted)
            row.update(persisted['tap_counts'])
            row['log_write_verified']=True
        except (TapEvidenceError,OSError) as error:
            row['log_complete']=False
            row['log_write_verified']=False
            row['log_error']=str(error) if isinstance(error,TapEvidenceError) else type(error).__name__
            if row['exit_code']==0:
                row['exit_code']=2
        text=captured.decode('utf-8',errors='replace')
        row['blocked_attempts'] = len(blocked.read_text().splitlines()) if blocked.exists() else 0
        row['environment_block_observed'] = row['blocked_attempts'] > 0
        row['assertion_failure_observed'] = bool(re.search(r'ERR_ASSERTION|AssertionError', text))
        row['seconds'] = round(time.monotonic() - started, 3)
        row['finished_at'] = utc_now()
        with lock:
            state['running'].remove(path)
            state['results'].append(row)
            save()
            print(json.dumps(row, ensure_ascii=False), flush=True)
        return row

    save()
    print(json.dumps({'summary': str(summary_path), 'file_count': len(files),
                      'workers': args.workers, 'timeout': args.timeout}), flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(run_file, path) for path in files]
        for future in as_completed(futures):
            future.result()
    state['finished_at'] = utc_now()
    state['completed'] = len(state['results']) == len(files)
    state['cancelled'] = stop.is_set()
    state['guard_unchanged'] = hashlib.sha256(guard.read_bytes()).hexdigest() == guard_sha
    save()
    print(json.dumps({'summary': str(summary_path), 'totals': state['totals'],
                      'completed': state['completed'], 'guard_unchanged': state['guard_unchanged']}), flush=True)
    return 0 if state['totals']['files_failed'] == 0 and state['guard_unchanged'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
