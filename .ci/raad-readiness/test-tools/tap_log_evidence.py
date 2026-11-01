"""Validate complete persisted Node TAP output, independently of process exit."""
import hashlib
import os
from pathlib import Path
import re

COUNT_KEYS=('tests','suites','pass','fail','cancelled','skipped','todo')

class TapEvidenceError(ValueError):
    pass

def inspect_tap_bytes(raw, expected=None):
    if not raw:
        raise TapEvidenceError('TAP_LOG_EMPTY')
    try:
        text=raw.decode('utf-8').replace('\r\n','\n')
    except UnicodeDecodeError as error:
        raise TapEvidenceError('TAP_LOG_ENCODING_INVALID') from error
    if len(re.findall(r'^TAP version 13\s*$',text,re.M))!=1:
        raise TapEvidenceError('TAP_HEADER_MISSING_OR_DUPLICATED')
    counts={}
    for key in COUNT_KEYS:
        found=re.findall(r'^# '+key+r' (\d+)\s*$',text,re.M)
        if len(found)!=1:
            raise TapEvidenceError('TAP_FOOTER_INCOMPLETE')
        counts[key]=int(found[0])
    if not re.search(r'^# duration_ms [0-9]+(?:\.[0-9]+)?\s*\Z',text,re.M):
        raise TapEvidenceError('TAP_TERMINAL_DURATION_MISSING')
    plans=re.findall(r'^1\.\.(\d+)\s*$',text,re.M)
    if len(plans)!=1:
        raise TapEvidenceError('TAP_PLAN_MISSING_OR_DUPLICATED')
    plan=int(plans[0])
    points=[int(n) for n in re.findall(r'^(?:not )?ok (\d+)(?:\s|$)',text,re.M)]
    if points!=list(range(1,plan+1)):
        raise TapEvidenceError('TAP_PLAN_RESULTS_MISMATCH')
    all_points=len(re.findall(r'^\s*(?:not )?ok \d+(?:\s|$)',text,re.M))
    if all_points!=counts['tests']+counts['suites']:
        raise TapEvidenceError('TAP_TEST_POINTS_MISMATCH')
    if sum(counts[k] for k in ('pass','fail','cancelled','skipped','todo'))!=counts['tests']:
        raise TapEvidenceError('TAP_COUNT_ARITHMETIC_MISMATCH')
    if expected:
        for key in COUNT_KEYS:
            if expected.get(key) is not None and expected[key]!=counts[key]:
                raise TapEvidenceError('TAP_RECORDED_COUNTS_MISMATCH')
        if expected.get('log_bytes') is not None and expected['log_bytes']!=len(raw):
            raise TapEvidenceError('TAP_RECORDED_SIZE_MISMATCH')
        if expected.get('log_sha256') and expected['log_sha256']!=hashlib.sha256(raw).hexdigest():
            raise TapEvidenceError('TAP_RECORDED_HASH_MISMATCH')
    return {'log_complete':True,'log_bytes':len(raw),'log_sha256':hashlib.sha256(raw).hexdigest(),
            'tap_plan':plan,'tap_result_points':all_points,'tap_counts':counts}

def inspect_tap_file(path, expected=None):
    try:
        return inspect_tap_bytes(Path(path).read_bytes(),expected)
    except FileNotFoundError as error:
        raise TapEvidenceError('TAP_LOG_MISSING') from error

def write_log_atomically(path, raw):
    path=Path(path)
    pending=path.with_name(path.name+'.part')
    with pending.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending,path)
    fd=os.open(path.parent,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    persisted=path.read_bytes()
    if persisted!=raw:
        raise TapEvidenceError('TAP_WRITE_READBACK_MISMATCH')
    return inspect_tap_bytes(persisted)
