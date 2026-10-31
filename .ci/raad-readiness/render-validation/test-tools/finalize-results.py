#!/usr/bin/env python3
"""Deduplicate complete per-file runs; keep the latest result for each test file."""
import json
from pathlib import Path
from tap_log_evidence import TapEvidenceError, inspect_tap_file

root=Path(__file__).resolve().parent.parent
rows={}
for summary in sorted((root/'results').glob('file-suite-*/summary.json')):
 data=json.loads(summary.read_text())
 if not data.get('completed') or not data.get('guard_unchanged'): continue
 for row in data['results']:
  previous=rows.get(row['file'])
  if previous and previous['finished_at']>=row['finished_at']: continue
  copy=dict(row)
  copy['evidence_summary']=str(summary.relative_to(root))
  copy['log']=str((summary.parent/row['log']).relative_to(root))
  copy['guard']=row.get('guard') or Path(data['guard']).name
  rows[row['file']]=copy
expected={str(p.relative_to(root/'test-build')) for folder in ('test','src') for p in (root/'test-build'/folder).rglob('*.test.js')}
expected.update(['scripts/raad-paired-candidates-check.cjs','scripts/supervisor-end-to-end-check.cjs'])
missing=sorted(expected-set(rows))
incomplete=[]
for row in rows.values():
 try:
  evidence=inspect_tap_file(root/row['log'],row)
  row.update(evidence)
  row.update(evidence['tap_counts'])
 except (TapEvidenceError,OSError) as error:
  incomplete.append({'file':row['file'],'log':row['log'],'error':str(error)})
  row['recorded_exit_code']=row['exit_code']
  row['exit_code']=2
  row['log_complete']=False
  for key in ('tests','suites','pass','fail','cancelled','skipped','todo'):
   row[key]=None
totals={key:sum(r.get(key) or 0 for r in rows.values()) for key in ('tests','pass','fail','cancelled','skipped','todo','blocked_attempts')}
totals.update(files=len(rows),files_passed=sum(r['exit_code']==0 for r in rows.values()),files_failed=sum(r['exit_code']!=0 for r in rows.values()))
result={'method':'Latest isolated result per file, with each persisted TAP stream independently checked for header, terminal footer, plan, result points, arithmetic, byte size and SHA256. Duplicate reruns are not added.','missing_files':missing,'incomplete_logs':incomplete,'totals':totals,'failed_files':[r for r in rows.values() if r['exit_code']!=0],'results':sorted(rows.values(),key=lambda r:r['file'])}
(root/'results/final-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'totals':totals,'missing_files':missing,'incomplete_logs':incomplete}))
raise SystemExit(1 if missing or incomplete or totals['files_failed'] else 0)
