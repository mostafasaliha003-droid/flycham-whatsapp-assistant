#!/usr/bin/env python3
"""Local-only deterministic test context preparation; never run by the app."""
import hashlib
import gzip
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile

root = Path(__file__).resolve().parents[3]
out = Path(__file__).resolve().parent
baseline = json.loads(Path(sys.argv[1]).read_text())
files = baseline['files']
fingerprint = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
assert len(files) == 418 and fingerprint == 'aa3711e6a439b90ecd63f34884948386eef03ce846c0be23261aaa8e70c41448'
blob = io.BytesIO()
with tarfile.open(fileobj=blob, mode='w') as snapshot:
    for name, item in sorted(files.items()):
        path = root/name; raw = path.read_bytes()
        assert len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'], name
        entry = tarfile.TarInfo(name); entry.size = len(raw); entry.mode = path.stat().st_mode & 0o777; entry.mtime = 0
        snapshot.addfile(entry, io.BytesIO(raw))
snapshot_bytes = gzip.compress(blob.getvalue(), mtime=0)
(out/'source-snapshot.tar.gz').write_bytes(snapshot_bytes)
if (out/'source-snapshot.tar').exists():
    (out/'source-snapshot.tar').unlink()
shutil.copytree(root/'.ci/raad-readiness/test-tools', out/'test-tools', dirs_exist_ok=True)
for cache in (out/'test-tools').rglob('__pycache__'):
    shutil.rmtree(cache)
shutil.copyfile(root/'.ci/raad-readiness/container-preflight.cjs', out/'container-preflight.cjs')
original = (root/'Dockerfile.worker').read_text()
first, rest = original.split('\n', 1)
nonce = 'raad-validation-20261031-4b39b9d-04'
worker = first + ' AS worker\n' + '# RAAD_CACHE_BEGIN\n' \
    + 'ARG RAAD_VALIDATION_NONCE=' + nonce + '\n' \
    + 'ENV NPM_CONFIG_CACHE=/validation-npm-cache NPM_CONFIG_USERCONFIG=/validation-npm-user.npmrc NPM_CONFIG_GLOBALCONFIG=/validation-npm-global.npmrc\n' \
    + 'RUN mkdir /validation-npm-cache && touch /validation-npm-user.npmrc /validation-npm-global.npmrc && printf \'%s\\n\' "$RAAD_VALIDATION_NONCE" > /raad-validation-build-nonce\n' \
    + '# RAAD_CACHE_END\n' + rest
base = first.removeprefix('FROM ')
docker = '# syntax=docker/dockerfile:1.7\n# Isolated derived validation; no app deployment.\n# RAAD_WORKER_BEGIN\n' + worker + '# RAAD_WORKER_END\n' + '''
FROM worker AS native-proof
COPY .ci/raad-readiness/render-validation /validation-input
RUN --network=none --mount=type=bind,from=worker,source=/app,target=/app,ro timeout 200s node /validation-input/native-gate.cjs

FROM native-proof AS validation
# Validation tooling only, after exact-worker native checks. Not a worker change.
RUN timeout 600s sh -c 'apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*'
RUN mkdir /validation-work && chown pwuser:pwuser /validation-work
USER pwuser
RUN --network=none timeout 1000s python3 /validation-input/build-gate.py

FROM ''' + base + ''' AS reporter
WORKDIR /report
COPY --from=validation /validation-work/public/public-summary.json /report/public-summary.json
COPY .ci/raad-readiness/render-validation/report-server.cjs /report/report-server.cjs
USER pwuser
EXPOSE 10000
CMD ["node", "/report/report-server.cjs"]
'''
(out/'Dockerfile.validation').write_text(docker)
ignore = (root/'.dockerignore').read_text()
ignore += '\n# Isolated validation inputs only; worker src exclusions above remain intact.\n!.ci/\n!.ci/raad-readiness/\n!.ci/raad-readiness/render-validation/\n!.ci/raad-readiness/render-validation/**\n'
ignore += '\n**/__pycache__/**\n**/*.pyc\n**/.env\n**/.env.*\n**/.npmrc\n**/node_modules/**\n**/.git/**\n**/uploads/**\n**/state/**\n**/*.log\n**/*.tap\n**/*.pem\n**/*.key\n'
(out/'Dockerfile.validation.dockerignore').write_text(ignore)
tool_files = {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(out.rglob('*')) if p.is_file()
              and p.name not in {'source-snapshot.tar.gz', 'inputs.json'} and '__pycache__' not in p.parts}
info = {'functionalCommit': '4b39b9d1e93e70147d794a7e9b47a3fc550f41b1',
        'functionalTree': 'd39d02285e78dff1d44b2647997e6281eb756fe1',
        'applicationFingerprintSha256': fingerprint, 'files': files, 'buildNonce': nonce,
        'workerRecipeSha256': hashlib.sha256(original.encode()).hexdigest(),
        'sourceSnapshotSha256': hashlib.sha256(snapshot_bytes).hexdigest(), 'toolFiles': tool_files}
(out/'inputs.json').write_text(json.dumps(info, indent=2) + '\n')
print(json.dumps({k:v for k,v in info.items() if k not in {'files','toolFiles'}}))
