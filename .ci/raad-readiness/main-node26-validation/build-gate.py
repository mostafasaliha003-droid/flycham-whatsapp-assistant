#!/usr/bin/env python3
"""Worker-image targeted validation, after native proof; no live actions."""
from pathlib import Path, PurePosixPath
import base64
import gzip
import hashlib
import io
import json
import os
import re
import signal
import subprocess
import sys
import tarfile
import time
import traceback

INPUT=Path('/validation-input'); ROOT=Path('/validation-work'); ARTIFACTS=ROOT/'artifacts'
COMMIT='ad16a50edb11f859102e3b91bf85db2fab9b5442'
TREE='b9747bfbf28809cf0c1e470148169b192bd040e3'
FP='7e1d7f516f077a26c26843bab5abf2b784af481f5a410f2574c549b14c82b712'
NONCE='raad-validation-20261101-ad16a50-worker-01'

def sha(b):return hashlib.sha256(b).hexdigest()
def durable(p,b):
 p.parent.mkdir(parents=True,exist_ok=True)
 with p.open('wb') as s:s.write(b);s.flush();os.fsync(s.fileno())
 assert p.read_bytes()==b
def dump(p,d):durable(p,(json.dumps(d,indent=2)+'\n').encode())
def manifest(folder):return {str(p.relative_to(folder)):{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(folder.rglob('*')) if p.is_file()}
def verify_source(folder,info):
 for n,r in info['files'].items():
  p=folder/n;assert p.is_file() and not p.is_symlink() and p.stat().st_size==r['bytes'] and sha(p.read_bytes())==r['sha256'],n
def clean_env(tmp):return {'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','TMPDIR':str(tmp),'LANG':'C.UTF-8','TZ':'UTC','NODE_ENV':'test','PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'}
def run(cmd,cwd,env,log,timeout):
 start=time.monotonic();child=subprocess.Popen(cmd,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True);timed=False
 try:raw,_=child.communicate(timeout=timeout)
 except subprocess.TimeoutExpired:
  timed=True
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:raw,_=child.communicate(timeout=5)
  except subprocess.TimeoutExpired:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   raw,_=child.communicate(timeout=5)
 finally:
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 assert len(raw)<2*1024*1024;durable(log,raw)
 return {'command':cmd,'exitCode':child.returncode,'timedOut':timed,'seconds':round(time.monotonic()-start,3),'stdoutEof':True,'bytes':len(raw),'sha256':sha(raw)}
def export(success):
 dump(ARTIFACTS/'evidence-index.json',{'files':manifest(ARTIFACTS),'selfExcluded':True})
 stream=io.BytesIO()
 with tarfile.open(fileobj=stream,mode='w') as archive:
  for p in sorted(ARTIFACTS.rglob('*')):
   if not p.is_file():continue
   rel=p.relative_to(ARTIFACTS);assert not p.is_symlink() and p.suffix in {'.json','.log'}
   assert not any(x in {'src','node_modules','source','state','var','home'} for x in rel.parts)
   b=p.read_bytes();m=tarfile.TarInfo(str(rel));m.mode=0o600;m.mtime=0;m.size=len(b);archive.addfile(m,io.BytesIO(b))
 data=gzip.compress(stream.getvalue(),mtime=0);assert 0<len(data)<=262144
 encoded=base64.b64encode(data).decode();chunks=[encoded[i:i+1024] for i in range(0,len(encoded),1024)]
 meta={'tag':'RAAD_WORKER_IMAGE_EVIDENCE','event':'begin','success':success,'encoding':'base64+gzip+tar','chunks':len(chunks),'gzipBytes':len(data),'encodedBytes':len(encoded),'sha256':sha(data),'functionalCommit':COMMIT,'buildNonce':NONCE}
 print(json.dumps(meta),flush=True)
 for i,b in enumerate(chunks,1):print(json.dumps({'tag':meta['tag'],'event':'chunk','index':i,'data':b}),flush=True);time.sleep(.03)
 print(json.dumps({**meta,'event':'end','eof':True}),flush=True)
 return len(data),len(chunks),sha(data)
def main():
 ARTIFACTS.mkdir(exist_ok=False)
 info=json.loads((INPUT/'inputs.json').read_text())
 assert info['functionalCommit']==COMMIT and info['functionalTree']==TREE and info['applicationFingerprintSha256']==FP and len(info['files'])==431
 assert sha(json.dumps(info['files'],sort_keys=True,separators=(',',':')).encode())==FP
 assert info['buildNonce']==NONCE and Path('/raad-validation-build-nonce').read_text().strip()==NONCE
 for n,s in info['toolFiles'].items():assert sha((INPUT/n).read_bytes())==s,n
 snapshot=(INPUT/'source-snapshot.tar.gz').read_bytes();assert sha(snapshot)==info['sourceSnapshotSha256']
 source=ROOT/'source';source.mkdir(exist_ok=False);seen=set()
 with tarfile.open(fileobj=io.BytesIO(snapshot),mode='r:gz') as tar:
  for m in tar:
   rel=PurePosixPath(m.name);assert m.isfile() and not rel.is_absolute() and '..' not in rel.parts and m.name in info['files'] and m.name not in seen
   b=tar.extractfile(m).read();r=info['files'][m.name];assert len(b)==r['bytes'] and sha(b)==r['sha256']
   p=source/m.name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);p.chmod(m.mode&0o777);seen.add(m.name)
 assert seen==set(info['files']);verify_source(source,info)
 recipe=(source/'Dockerfile.worker').read_text();derived=(INPUT/'Dockerfile.validation').read_text()
 worker=derived.split('# RAAD_WORKER_BEGIN\n',1)[1].split('# RAAD_WORKER_END\n',1)[0];first,rest=worker.split('\n',1)
 assert first.removesuffix(' AS worker')+'\n'+rest.split('# RAAD_CACHE_END\n',1)[1]==recipe
 assert sha(recipe.encode())==info['workerRecipeSha256']
 runtime={}
 for n,r in info['files'].items():
  rel=PurePosixPath(n)
  if n.startswith('src/') and not rel.name.endswith(('.test.js','.test.cjs')) and not any(x in {'test','tests','fixtures'} for x in rel.parts[1:]):runtime[n[4:]]=r
 assert manifest(Path('/app/src'))==runtime,'WORKER_RUNTIME_SOURCE_MISMATCH'
 for n in ['package.json','package-lock.json','scripts/install-mrz-model.js','scripts/raad-readiness-check.js','THIRD_PARTY_MRZ_MODEL.md']:assert (Path('/app')/n).read_bytes()==(source/n).read_bytes(),n
 native_path=Path('/tmp/raad-native-proof');native=json.loads((native_path/'native-proof.json').read_text())
 assert native['passed'] and native['nativeChecks']==12 and native['liveActions']==0 and native['functionalCommit']==COMMIT and native['buildNonce']==NONCE
 assert native['applicationFingerprintSha256']==FP and native['workerRecipeSha256']==info['workerRecipeSha256']
 assert native['method']=='node_os_networkInterfaces' and native['observedInterfaces']==['lo'] and native['allInternal']
 assert native['browserEnvironment']['imageBrowserPath']=='/ms-playwright' and native['browserEnvironment']['pathGuardPassed']
 assert 'raad-source-entrypoint-disabled' in native['checks'] and native['runtimeMetadata']['uid']==0
 raad=[x for x in native['entrypointChecks'] if x['kind']=='raad_override']
 assert len(raad)==1 and raad[0]=={'command':'node src/raad-login-pilot/server.js','cwd':'/app','healthStatus':200,'kind':'raad_override','productionEnabled':False,'activeJob':False,'mode':None,'harnessSubmittedPortalJobs':0}
 assert set(native['pdfTools'])=={'pdfinfo','pdftoppm'} and all(re.fullmatch(r'\d+\.\d+\.\d+',v) for v in native['pdfTools'].values())
 raw=(native_path/'native-preflight.log').read_bytes();assert len(raw)==native['bytes'] and sha(raw)==native['sha256']
 for n in ['native-preflight.log','native-proof.json','browser-environment.json']:durable(ARTIFACTS/'native'/n,(native_path/n).read_bytes())
 node=run(['node','-p','process.execPath'],source,clean_env('/tmp'),ARTIFACTS/'node-path.log',5);assert node['exitCode']==0
 node_path=(ARTIFACTS/'node-path.log').read_text().strip();assert node_path.startswith('/') and len(node_path)<256
 (source/'node_modules').symlink_to('/app/node_modules',target_is_directory=True)
 temporary=ROOT/'test-tmp';temporary.mkdir()
 names=['inbox-automation-transition','visa-document-intake-profiles','visa-mrz-composition','visa-mrz-consent','visa-mrz-durable-budget','visa-mrz-production','visa-mrz-profiles','visa-upload-consent','raad-machine-dossier','visa-upload-ui','visa-fulfilment','visa-fulfilment-http','saudi-visa-engine']
 command=[node_path,'--test','--test-reporter=tap','--test-concurrency=2',*['test/'+n+'.test.js' for n in names]]
 step=run(command,source,clean_env(temporary),ARTIFACTS/'profile-controls/test.log',160)
 text=(ARTIFACTS/'profile-controls/test.log').read_text();counts={n:int(re.findall(r'^# '+n+r' (\d+)$',text,re.M)[-1]) for n in ['tests','pass','fail','cancelled','skipped','todo']}
 dump(ARTIFACTS/'profile-controls/result.json',{**step,'counts':counts,'files':13,'testFiles':['test/'+n+'.test.js' for n in names],'filesInvokedOnceEach':True,'providerTransport':'synthetic','securityScan':False,'liveActions':0})
 assert step['exitCode']==0 and not step['timedOut'] and counts['tests']==counts['pass']==318 and all(counts[n]==0 for n in ['fail','cancelled','skipped','todo'])
 verify_source(source,info);assert manifest(Path('/app/src'))==runtime
 model=Path('/app/var/mrz-model/mrz.traineddata');assert model.stat().st_size==1452847 and sha(model.read_bytes())=='ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01'
 dump(ARTIFACTS/'build-provenance.json',{k:info[k] for k in ['functionalCommit','functionalTree','applicationFingerprintSha256','buildNonce','workerRecipeSha256','baseImageTag','sourceSnapshotSha256','toolFiles']})
 result={'success':True,'functionalCommit':COMMIT,'functionalTree':TREE,'applicationFingerprintSha256':FP,'applicationFiles':431,'buildNonce':NONCE,'workerRecipeSha256':info['workerRecipeSha256'],'baseImageTag':info['baseImageTag'],'baseImageDigestObserved':False,'sourceSnapshotSha256':info['sourceSnapshotSha256'],'freshInstallPassed':True,'lockUnchanged':True,'nativeChecks':12,'raadOverrideHealthPassed':True,'profileControlFiles':13,'profileControlTests':318,'profileControlsPassed':True,'scope':'additive_original_worker_recipe_with_pre_tool_overlay_native_checks','fullSuiteRerun':False,'mrzAccuracyClaimed':False,'buildOnly':True,'releaseReady':False,'liveActions':0}
 result.update({k:native['runtimeMetadata'][k] for k in ['nodeVersion','npmVersion','glibcVersion']})
 dump(ARTIFACTS/'result.json',result)
 size,chunks,digest=export(True)
 summary={k:v for k,v in result.items() if k!='success'};summary['kind']='isolated_worker_image_validation'
 summary.update({'evidenceSha256':digest,'evidenceBytes':size,'evidenceChunks':chunks})
 dump(ROOT/'public/public-summary.json',summary);print('RAAD_WORKER_IMAGE_GATE_PASSED',flush=True)
if __name__=='__main__':
 try:main()
 except Exception:
  try:
   durable(ARTIFACTS/'failure-traceback.log',traceback.format_exc().encode());dump(ARTIFACTS/'failure.json',{'success':False,'reason':'WORKER_IMAGE_VALIDATION_FAILED','liveActions':0,'releaseReady':False});export(False)
  except Exception:print('RAAD_WORKER_IMAGE_FAILURE_EVIDENCE_INCOMPLETE',flush=True)
  print('RAAD_WORKER_IMAGE_GATE_FAILED',flush=True);sys.exit(1)
