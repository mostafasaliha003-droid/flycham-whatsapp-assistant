# Standalone full-suite evidence recovery

This toolkit captures a **new** functional run after the earlier session's
temporary raw files became unavailable. It does not reconstruct the bytes of
the historical run or establish a security clearance or live integration.

The application input is the existing immutable private Git commit
`46963b57c5490afcd2e9da15468cce52234f931a`, tree
`3c67dbdd818448f102395581a8dac32004eca5d2`: 445 first-party files,
431 application files, application fingerprint
`a866c28ea01f64f8fdf90cb58de6953884b570bd3400d61e917eb5e74727ef5d`.
No application source, dependency, model, runtime, key or customer state is
included in this toolkit.

`run-recovered-suite.py` requires explicit source, freeze, freeze SHA256,
dependencies, model, Node binary, harness and fresh output directory arguments.
It verifies source bytes/Git executable modes and independently reconstructs
the source tree before tests, then checks the same values again afterward.
The supplied source freeze must match the pinned application version above.
The source/runtime are never modified. A separate disposable execution copy
contains only those frozen files, a link to existing dependencies, and the
separately supplied pinned OCR model.

The eight `harness-template` files are preserved, non-application local
functional harness inputs. `harness-input-freeze.json` records their exact
hashes and origin. The exact repository-backed TAP parser is deliberately
omitted. The wrapper reads its verified bytes from the application at:

`.ci/raad-readiness/test-tools/tap_log_evidence.py`

at the immutable commit above (SHA256
`ecd59e282cc3463265f68b8eab4bf3c1c6e4710e5097def471795296075f5827`).

The wrapper uses checksum-pinned Node **26.13.0**, SHA256
`0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b`,
and the existing 1,452,847-byte OCR model, SHA256
`ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01`.
Dependencies are reused, not freshly installed. No model request or provider
credential is needed. Only synthetic local HTTP is permitted by the inherited
JavaScript fences. Narrowly scoped PDF and local OCR/budget child-process
instrumentation remains explicit. This is functional instrumentation, **not OS
network isolation or exact production launch equivalence**.

The run discovers 217 test/script files and executes each once in a fresh Node
process, with three workers and a 45-second per-file timeout. Each complete TAP
log is written atomically, fsynced, read back and hashed after pipe EOF. The
wrapper also captures the complete driver output and records actual wall-clock
duration. Output directories must not already exist; a new invocation cannot
silently replay or overwrite the same run.

The evidence-only allowlist contains measured logs and metadata. It excludes
the disposable application copy, execution tools/config, dependencies, model,
runtime and temporary synthetic state. Toolkit sources have a separate
standalone allowlist. No Git upload or Render operation is performed.
