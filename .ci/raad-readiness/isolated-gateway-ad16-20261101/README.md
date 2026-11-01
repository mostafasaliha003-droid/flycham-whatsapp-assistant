# Isolated test components — current ad16 source

This is reviewable, default-disabled preparation. It is **not a running gateway or a completed real WhatsApp-to-Raad integration**. Nothing here opens a port or loads credentials from the environment. No service was changed.

## Implemented and measured

- `owner-test-boundary.cjs`: an **offline-injected-only** owner admission state machine. It checks the signature over raw bytes, expected WABA/phone/owner, opening message, session/job/applicant/challenge binding, reply context, timestamp and original five-minute lifetime. It serializes ingress, bounds raw bytes and pending work, consumes a correlated attempt once, keeps cancellation terminal and limits outbound attempts to two. Unknown outcomes are charged and halted without retry.
- `pinned-meta-transport.cjs`: a separate, **unwired** low-level HTTPS adapter. Default disabled; explicit activation and a current operator assertion of dedicated test identity and zero-cost eligibility are required. The destination, owner and two allowed texts are fixed; TLS verification stays enabled, redirects and automatic retries are not followed, responses and absolute lifetime are bounded. **The assertion is not provider verification.** Real provider identity, eligibility and TLS execution were not measured.
- Final boundary tests: **29/29**, with injected transports and JavaScript no-egress instrumentation. This is not OS network isolation or a security audit. The initial 21-case and reviewed 28-case passing logs are retained separately; they predate the final validated-clock regression.
- Current router replay: **1/1**, using actual ad16 `src/server.createServer` and `createPilot` in a scrubbed child. The existing fixture's logic is unchanged; a new copied boundary helper changes only its source freeze SHA and tree pins. Every one of the 445 source files was verified before and after.
- The router replay uses **native numeric-loopback HTTP, fake Graph responses and an injected synthetic portal flow** that reaches `RAAD_TEST_SUBMISSION_BLOCKED`. It does not use HTTPS, real Meta, a government portal, browser, real OTP or a model. This is separate from the new owner boundary: **the new boundary is not wired into this router replay**.

## Still required for a real isolated run

1. A protected public ingress/runtime and private operator setup/teardown. None is deployed or listening here.
2. Actual dedicated Meta test identity/subscription and zero-cost eligibility verification with securely accessible existing test configuration.
3. Wiring the admission boundary and bounded HTTPS sender to a safe opening-window bootstrap and the actual current application handoff, including native HTTPS main/worker routing.
4. Separate main/worker environments, a synthetic worker flow and unconditional government/payment/model denial in the host. The capability object supplied to an injected adapter is advisory; this module cannot measure or constrain arbitrary code inside an adapter. Snapshot fields describe implemented capabilities rather than inventing zero global side-effect counters.
5. The outstanding security, permitted visual QA and actual model-quality release gates.

Codes are disposable test values held in memory. The component does not log or persist them; it clears its code buffer on consume, cancel or when expiry is next checked by an operation. Expiry checking is lazy; no background expiry timer is implemented. JavaScript strings returned to a private operator or supplied by the caller cannot be guaranteed zeroized; the caller must not log or retain raw webhook bodies or codes. Sessions cannot be restored after restart.

## Local verification

Use the pinned Node 26.13.0 runtime documented in the evidence. The standalone case is:

```sh
node --require ./no-egress-preload.cjs --test --test-isolation=none --test-reporter=tap ./owner-test-boundary.test.cjs
```

The actual-router replay launcher `run-current-router.py` requires the already available source, freeze, Node and dependency paths. It performs no install or source copy and refuses to overwrite its `current-router-run-01` evidence directory. The prior v15 helper originals remain unchanged. No production state or credential values are read.

Source/test helpers belong in the private Git review branch, not in a report archive. The evidence-only allowlist deliberately excludes their code bytes. These components must not be exposed as a live test gateway on the strength of offline passes.
