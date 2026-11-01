#!/usr/bin/env python3
"""One pinned current-source offline router case; no source/dependency copy or install."""
from pathlib import Path
import hashlib,json,os,re,subprocess,time
ROOT=Path(__file__).resolve().parent
APP=ROOT.parent/'flycham-family-count-fix-20261101'
FREEZE=ROOT.parent/'readiness-four-checks-20261101/family-fix/candidate-source-freeze.json'
NODE=ROOT.parent/'ocr-integration-local-node26-20261031/runtime/node-v26.13.0-linux-x64/bin/node'
DEPS=ROOT.parent/'flycham-ocr-deps-scjqvece/project/node_modules'
def sha(b):return hashlib.sha256(b).hexdigest()
def verify():
 raw=FREEZE.read_bytes();assert sha(raw)=='b67e5d8e5b6834a9c5b5cbc0d2326460d93a301d030edda18e9432fc86166845'
 d=json.loads(raw);assert d['candidateTree']=='b9747bfbf28809cf0c1e470148169b192bd040e3' and len(d['files'])==445
 for n,v in d['files'].items():
  p=APP/n;b=p.read_bytes();assert p.is_file() and not p.is_symlink() and len(b)==v['bytes'] and sha(b)==v['sha256'] and ('100755' if p.stat().st_mode&0o111 else '100644')==v['mode'],n
 return d
def main():
 d=verify();out=ROOT/'current-router-run-01';out.mkdir(exist_ok=False);(out/'tmp').mkdir()
 guard=APP/'.ci/raad-readiness/test-tools/offline-loopback-guard.cjs'
 env={'PATH':str(NODE.parent)+':/usr/bin:/bin','NODE_PATH':str(DEPS),'TMPDIR':str(out/'tmp'),'LANG':'C.UTF-8','TZ':'UTC','NODE_ENV':'test','NODE_OPTIONS':'--require '+str(guard),'OFFLINE_GUARD_LOG':str(out/'blocked-attempts.jsonl'),'INTEGRATION_LAB_SOURCE':str(APP),'INTEGRATION_LAB_FREEZE':str(FREEZE)}
 command=[str(NODE),'--test','--test-reporter=tap','--test-isolation=none',str(ROOT/'current-router/router-gated.test.cjs')]
 start=time.monotonic();p=subprocess.Popen(command,cwd=APP,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
 timed=False
 try:raw,_=p.communicate(timeout=35)
 except subprocess.TimeoutExpired:
  timed=True;os.killpg(p.pid,9);raw,_=p.communicate(timeout=5)
 (out/'router.tap').write_bytes(raw);assert (out/'router.tap').read_bytes()==raw;verify()
 counts={}
 for k in ['tests','pass','fail','cancelled','skipped','todo']:
  values=re.findall(r'^# '+k+r' (\d+)$',raw.decode(),re.M);counts[k]=int(values[-1]) if values else None
 blocked=out/'blocked-attempts.jsonl';blocked_count=len(blocked.read_text().splitlines()) if blocked.exists() else 0
 passed=p.returncode==0 and not timed and counts=={'tests':1,'pass':1,'fail':0,'cancelled':0,'skipped':0,'todo':0} and blocked_count==0
 result={'kind':'current_actual_routers_offline_replay_not_live_integration','passed':passed,'exitCode':p.returncode,'timedOut':timed,'seconds':round(time.monotonic()-start,6),'counts':counts,'blockedNativeAttempts':blocked_count,'stdoutEof':True,'logBytes':len(raw),'logSha256':sha(raw),'source445VerifiedBeforeAndAfter':True,'sourceTree':d['candidateTree'],'applicationFingerprintSha256':d['applicationFingerprintSha256'],'sourceCommitBinding':'ad16a50edb11f859102e3b91bf85db2fab9b5442 (parent verified remote; local source verified by freeze)','actualMainAndWorkerRouters':True,'transport':'native HTTP numeric loopback only; no TLS','graph':'fake responses','portal':'injected synthetic non-submitting flow','newOwnerBoundaryWiredIntoThisReplay':False,'realMetaRequests':0,'governmentCalls':0,'modelCalls':0,'customerMessages':0,'browserLaunchesExpected':0,'productionActions':0,'sourceModified':False,'fullSuiteRerun':False,'boundary':'JavaScript loopback network instrumentation, not OS isolation or actual provider identity verification'}
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(0 if passed else 1)
if __name__=='__main__':main()
