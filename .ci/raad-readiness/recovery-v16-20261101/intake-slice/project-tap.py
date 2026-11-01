#!/usr/bin/env python3
"""Preserve raw Node output and explicitly index finite diagnostics excluded from TAP."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import re

sha = lambda b: hashlib.sha256(b).hexdigest()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True)
args = parser.parse_args()
run = args.run.resolve(strict=True)
result = json.loads((run/'run-result.json').read_bytes())
raw = (run/'slice.tap').read_bytes()
assert result['exitCode'] == 0 and result['stdoutPipeEof'] and result['readbackVerified']
assert sha(raw) == result['logSha256'] and len(raw) == result['logBytes']
assert not (run/'canonical-slice.tap').exists(), 'NEW_PROJECTION_REQUIRED'
offset = 0
pieces, diagnostics = [], []
for line in raw.splitlines(keepends=True):
    if line.startswith(b'[VISA_PORTAL_DIAGNOSTIC] '):
        value = json.loads(line[len(b'[VISA_PORTAL_DIAGNOSTIC] '):])
        assert set(value) == {'caseHash', 'state', 'code', 'runPhase', 'portalStage', 'saved', 'hasReference'}
        assert re.fullmatch('[a-f0-9]{12}', value['caseHash'])
        assert value['code'] == 'RAAD_TEST_SUBMISSION_BLOCKED' and value['saved'] is False and value['hasReference'] is False
        diagnostics.append({'offset': offset, 'bytes': len(line), 'sha256': sha(line), 'rawUtf8': line.decode(), 'record': value})
    else:
        pieces.append(line)
    offset += len(line)
assert offset == len(raw) and len(diagnostics) == 1
tap = b''.join(pieces)
assert tap.startswith(b'TAP version 13\n')
module_path = args.source.resolve(strict=True)/'.ci/raad-readiness/test-tools/tap_log_evidence.py'
assert sha(module_path.read_bytes()) == 'ecd59e282cc3463265f68b8eab4bf3c1c6e4710e5097def471795296075f5827'
spec = importlib.util.spec_from_file_location('git_backed_strict_tap', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
counts = module.inspect_tap_bytes(tap)
assert counts['tap_counts']['tests'] == counts['tap_counts']['pass'] == 1
with (run/'canonical-slice.tap').open('xb') as stream:
    stream.write(tap)
    stream.flush()
    os.fsync(stream.fileno())
assert (run/'canonical-slice.tap').read_bytes() == tap and (run/'slice.tap').read_bytes() == raw
proof = {'kind': 'explicit_diagnostic_exclusion_projection_not_new_test_run', 'rawLog': 'slice.tap', 'rawBytes': len(raw), 'rawSha256': sha(raw), 'rawPipeEofFromCapture': True, 'excludedLines': diagnostics, 'excludedBytes': sum(x['bytes'] for x in diagnostics), 'canonicalTap': 'canonical-slice.tap', 'canonicalBytes': len(tap), 'canonicalSha256': sha(tap), 'onlyIndexedDiagnosticBytesExcluded': True, 'allRemainingBytesInOriginalOrderUnchanged': True, 'applicationRerun': False, 'strictTap': counts}
(run/'tap-projection.json').write_text(json.dumps(proof, indent=2)+'\n')
assert json.loads((run/'tap-projection.json').read_text()) == proof
print(json.dumps({'projected': True, 'rawBytes': len(raw), 'canonicalBytes': len(tap), 'diagnosticLines': len(diagnostics), 'canonicalSha256': sha(tap), 'applicationRerun': False}))
