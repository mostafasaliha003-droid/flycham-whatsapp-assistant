#!/usr/bin/env python3
"""One bounded fresh functional run after loss of the original v16 scratch logs."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, os, stat, subprocess, time

ROOT=Path(__file__).resolve().parent
PIN='4b03f12a2c7d0af6e7c9dc6c1decb8dbbe588f22105fd40ff12dbdd120bb5c3c'
NODE_SHA='0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b'
def sha(raw): return hashlib.sha256(raw).hexdigest()
def save(p,raw):
    p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with p.open('xb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    assert p.read_bytes()==raw
def dump(p,value): save(p,(json.dumps(value,indent=2)+'\n').encode())
def verify(source,freeze):
    raw=freeze.read_bytes();assert sha(raw)==PIN
    f=json.loads(raw);assert f['candidateTree']=='3c67dbdd818448f102395581a8dac32004eca5d2' and len(f['files'])==445
    for n,v in f['files'].items():
        p=source/n;b=p.read_bytes();assert len(b)==v['bytes'] and sha(b)==v['sha256'] and p.is_file() and not p.is_symlink(),n
        assert ('100755' if p.stat().st_mode&0o111 else '100644')==v['mode'],n
    return f
def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['source','freeze','node','base-test','tap-parser','out']:p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();source=a.source.resolve(strict=True);freeze=a.freeze.resolve(strict=True);node=a.node.resolve(strict=True);base=a.base_test.resolve(strict=True)
    assert sha(node.read_bytes())==NODE_SHA
    assert sha(base.read_bytes())=='fc248ad99e999c5b241fb3ee2798affb591af9399be72e67749f15d15e8d900c'
    verify(source,freeze);assert not a.out.exists();a.out.mkdir(parents=True,mode=0o700)
    work=a.out/'synthetic-fixtures';work.mkdir(mode=0o700)
    spec=importlib.util.spec_from_file_location('strict_tap',a.tap_parser.resolve(strict=True));tap=importlib.util.module_from_spec(spec);spec.loader.exec_module(tap)
    helper_hashes={x.name:sha(x.read_bytes()) for x in ROOT.iterdir() if x.is_file() and x.suffix in {'.py','.cjs'}}
    env={'PATH':os.environ['PATH'],'TZ':'UTC','LANG':'C','NODE_ENV':'test','INTEGRATION_LAB_SOURCE':str(source),'INTEGRATION_LAB_FREEZE':str(freeze),'STATE_COMPAT_BASE_TEST':str(base),'STATE_COMPAT_FIXTURES':str(work)}
    rows=[];overall=time.monotonic()
    tasks=[('mrz-containment','mrz-containment-wrapper.test.cjs',None),('financial-seed','financial-restart.test.cjs','seed'),('financial-recover','financial-restart.test.cjs','recover')]
    for name,script,phase in tasks:
        verify(source,freeze);runenv={**env,'STATE_COMPAT_GUARD_LOG':str(a.out/(name+'-guard.jsonl'))}
        if phase:runenv['STATE_COMPAT_PHASE']=phase
        cmd=[str(node),'--require',str(ROOT/'offline-preload.cjs'),'--test','--test-reporter=tap',str(ROOT/script)]
        start=time.monotonic();q=subprocess.run(cmd,env=runenv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=45)
        log=a.out/(name+'.tap');save(log,q.stdout)
        row={'phase':name,'exitCode':q.returncode,'elapsedSeconds':time.monotonic()-start,'stdoutPipeEof':True,'bytes':len(q.stdout),'sha256':sha(q.stdout),'readbackVerified':log.read_bytes()==q.stdout,'command':cmd}
        try:row['strictTap']=tap.inspect_tap(q.stdout)
        except Exception as exc:row['tapInspectionFailure']=str(exc)
        dump(a.out/(name+'.result.json'),row);rows.append(row);verify(source,freeze)
        if q.returncode or 'strictTap' not in row:
            dump(a.out/'failed-run.json',{'rows':rows,'fullRawLogsPreserved':True,'failureIsNotHistoricalV16Reconstruction':True})
            print(json.dumps(row,indent=2));return q.returncode or 1
        assert row['strictTap']['tap_counts']['tests']==row['strictTap']['tap_counts']['pass']==4
        guard=Path(runenv['STATE_COMPAT_GUARD_LOG']);assert not guard.exists() or not guard.read_bytes().strip()
    assert helper_hashes=={x.name:sha(x.read_bytes()) for x in ROOT.iterdir() if x.is_file() and x.suffix in {'.py','.cjs'}}
    controls=[]
    for d in sorted(work.iterdir()):
        control=json.loads((d/'controls.json').read_text());result=json.loads((d/'verified-result.json').read_text());assert result['budgetPairUnchanged']
        assert sha((d/'visa-mrz-budget.enc').read_bytes())==control['pair']['ledger'];assert sha((d/'visa-mrz-budget.enc.anchor').read_bytes())==control['pair']['anchor']
        controls.append({'kind':result['kind'],'verified':result,'budgetPairHashes':control['pair']})
    dump(a.out/'financial-state-readback.json',{'fixtures':controls,'encryptedStateAndFixtureControlsNotExported':True})
    result={'kind':'new_recovery_run_after_lost_v16_logs','passed':True,'sourceCommit':'46963b57c5490afcd2e9da15468cce52234f931a','sourceTree':'3c67dbdd818448f102395581a8dac32004eca5d2','sourceFreezeSha256':PIN,'source445Unchanged':True,'runtime':'26.13.0','nodeSha256':NODE_SHA,'canonicalFunctionalChecks':8,'mrzContainmentChecks':4,'financialRecoveryFixtures':4,'additionalFinancialSetupPoints':4,'completeTapStreams':3,'physicalTapPoints':12,'testsAreNotUniqueHistoricalCoverage':True,'actualWallSeconds':time.monotonic()-overall,'externalGuardCalls':0,'realOtpValueSupplied':False,'historicalV16RawLogsReconstructed':False,'helperFilesSha256':helper_hashes,'rows':rows,'limits':['Configuration/process restart with synthetic explicit interruption checkpoints, not real process kill during I/O.','Source fixture persistence is not an old-image or Render disk restore.','Financial fixtures use actual encrypted AssistantState, Inbox and coordinator APIs but synthetic receipt metadata and fake delivery/cancel acknowledgements.','MRZ and financial fixtures are separate; no claim of a single full customer journey, native OCR accuracy, Meta delivery or comprehensive security review.']}
    dump(a.out/'final-result.json',result);print(json.dumps(result,indent=2));return 0
if __name__=='__main__':raise SystemExit(main())
