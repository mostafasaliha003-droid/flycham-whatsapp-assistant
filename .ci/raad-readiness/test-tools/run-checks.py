#!/usr/bin/env python3
"""Run only isolated local checks. No package download, credentials, or deploy."""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

parser=argparse.ArgumentParser()
parser.add_argument('--dependencies',required=True,help='Existing local node_modules directory')
parser.add_argument('--extra-dependencies',action='append',default=[])
parser.add_argument('--full',action='store_true')
args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parent.parent
build=root/'test-build'; results=root/'results'; results.mkdir(exist_ok=True)
deps=pathlib.Path(args.dependencies).resolve()
dependency_roots=[deps,*(pathlib.Path(p).resolve() for p in args.extra_dependencies)]
if not all(p.is_dir() for p in dependency_roots): raise SystemExit('DEPENDENCY_DIRECTORY_REQUIRED')
node=shutil.which('node')
if not node: raise SystemExit('NODE_REQUIRED')
runtime=pathlib.Path(tempfile.mkdtemp(prefix='isolated-checks-',dir=root))
(runtime/'home').mkdir();(runtime/'tmp').mkdir()
base={'PATH':os.environ['PATH'],'HOME':str(runtime/'home'),'TMPDIR':str(runtime/'tmp'),
 'NODE_PATH':os.pathsep.join(str(p) for p in dependency_roots),'NODE_ENV':'production','DRY_RUN':'true',
 'SAUDI_VISA_ENABLED':'false','RAAD_VISA_AUTOMATION_ENABLED':'false',
 'FARE_CATALOG_ENABLED':'false','CONSULTANT_ORCHESTRATOR_ENABLED':'false',
 'ASSISTANT_STATE_PATH':str(runtime/'assistant-state.enc'),
 'ASSISTANT_STATE_KEY':'isolated_state_key_not_a_real_secret_123456789',
 'SAUDI_VISA_PRIVATE_PATH':str(runtime/'no-private-config.enc'),
 'WHATSAPP_APP_SECRET':'isolated_webhook_signing_secret_not_real_123456789',
 'WHATSAPP_VERIFY_TOKEN':'isolated_verify_token_not_real'}

def run(name,arguments,guard,timeout=150):
 env={**base,'NODE_OPTIONS':'--require='+str(root/'test-tools'/guard),
      'OFFLINE_GUARD_LOG':str(results/(name+'-blocked.jsonl'))}
 logfile=results/(name+'.log'); started=time.monotonic()
 with logfile.open('w') as out:
  try:
   completed=subprocess.run([node,*arguments],cwd=build,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=timeout)
   code=completed.returncode
  except subprocess.TimeoutExpired: code=124
 text=logfile.read_text(errors='replace')
 summary={'exit_code':code,'seconds':round(time.monotonic()-started,2),'log':logfile.name}
 for key in ('tests','pass','fail','cancelled','skipped','todo'):
  values=re.findall(r'^# '+key+r' (\d+)\s*$',text,re.M)
  if values: summary[key]=int(values[-1])
 blocked=results/(name+'-blocked.jsonl')
 summary['blocked_attempts']=len(blocked.read_text().splitlines()) if blocked.exists() else 0
 print(json.dumps({name:summary}),flush=True)
 return summary

common=['--test','--test-isolation=none','--test-concurrency=1','--test-timeout=20000','--test-reporter=tap']
groups={}
target=['test/supervisor-contact-runtime.test.js','test/visa-supervisor-route.test.js','test/office-contact-boundary.test.js',
 'src/raad-login-pilot/sms-response-contract.test.js','src/raad-login-pilot/sms-request-proof.test.js',
 'src/raad-login-pilot/visa-route-readiness.test.js','src/raad-login-pilot/production-worker.test.js',
 'scripts/raad-paired-candidates-check.cjs','scripts/supervisor-end-to-end-check.cjs','test/visa-setup-http.test.js']
groups['targeted']=run('targeted',common+target,'offline-guard.cjs')
groups['bridge']=run('bridge',common+['src/raad-login-pilot/production-worker-http.test.js'],'offline-loopback-guard.cjs')
groups['http-smoke']=run('http-smoke',[str(root/'test-tools/local-http-smoke.cjs')],'offline-loopback-guard.cjs',45)
if args.full:
 command=[sys.executable,str(root/'test-tools/run-file-tests.py'),'--dependencies',str(deps)]
 for extra in dependency_roots[1:]: command+=['--extra-dependencies',str(extra)]
 result=subprocess.run(command,cwd=root)
 pdf_command=[*command,'--pdf-tools','--file','test/raad-pdf.test.js']
 pdf_result=subprocess.run(pdf_command,cwd=root)
 final_result=subprocess.run([sys.executable,str(root/'test-tools/finalize-results.py')],cwd=root)
 groups['full-suite']={'exit_code':final_result.returncode,'base_scan_exit_code':result.returncode,'pdf_recheck_exit_code':pdf_result.returncode,'results':'results/final-validation.json; latest result per file.'}
(results/'test-summary.json').write_text(json.dumps(groups,indent=2)+'\n')
print(json.dumps({'summary':str(results/'test-summary.json')}),flush=True)
raise SystemExit(1 if any(group['exit_code'] for group in groups.values()) else 0)
