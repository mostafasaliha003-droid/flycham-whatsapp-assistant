# Standalone recovery tools

These tools inspect captured test evidence locally. They do not authenticate, fetch services, start browsers, run the application, submit requests or spend a model allowance.

The owner must first collect the exact read-only Render request/result objects into `raw/` and `requests/`, together with `collection-binding.json` and `terminal-binding.json`. Target identities are deliberately pinned to the original successful v16 build. The normalizer rejects a different target, discontinuous pagination, wrong query scope, duplicate provider rows, out-of-window data or an unscoped/nonempty final tail.

Run `normalize-recovered-pages.py --collection-root PATH` once. It writes only new normalized evidence and a receipt. Next run `decode-original-v16-export.py --normalized-logs PATH/normalized-log-rows.jsonl --output NEW_DECODE_DIRECTORY`. It checks the exact source/nonce, chunk envelope, gzip EOF, regular-member allowlist and all index hashes before writing any extracted artifact. The decoded directory name used by the runtime verifier is `decoded-original`.

Run `verify-original-runtime.py --help` for explicit inputs. Supply the recovered source freeze and an independently materialized immutable CI text directory for commit `7991bf392c38689d4de8bd641a2f26b8d85d2746`, under `.ci/raad-readiness/main-node26-validation/`. Their expected Git blobs, byte sizes and hashes are recorded in the evidence metadata. Do not use a branch tip or substitute the historical application archive. No source archive is needed by the verifier.

Supply `strict_tap.py` and its SHA256 through `--tap-parser` and `--tap-parser-sha256`. Its two pure parser functions were extracted without semantic changes from the previously used evidence helper. A separate metadata record binds that origin. The original recovery proof used the original pinned parser; no claim is made that a new application run occurred.

The optional `--public-observation` input must contain an actual read-only observation `{deployId, ciCommit, url, report}`. The URL is the exact `/report` endpoint of the existing validation service. The tool compares typed JSON with the private proof; it never fills missing observations from expected values.

Outputs are write-once. Keep failed attempt logs and choose a new output filename for a later proof that adds a real public observation. Do not rewrite the original raw objects or pretend these utilities provide security clearance, visual QA, government integration or production restore verification.

Repository-backed CI text files, application source, source archives, dependencies, models, state, credentials and browser screenshots are not part of this standalone toolkit. Use only the separate toolkit allowlist when preparing its private-user artifact; use the evidence allowlist for logs/metadata.
