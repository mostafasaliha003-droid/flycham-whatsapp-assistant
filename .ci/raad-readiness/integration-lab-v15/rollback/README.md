# Current-candidate feature rollback lab

This is a local-only functional compatibility check for commit `2167d5f87fce8f2cf05de1c96e367a8a57ce7402`, frozen tree `036355159f736467891c29ec6383b928ae4b6d2d`. It does not deploy code, restore live state, access a real ledger, send messages, invoke a model, or constitute a security scan.

The four new tests passed under the existing offline transport/child-process fence. The portable test requires explicit absolute paths in `INTEGRATION_LAB_SOURCE` and `INTEGRATION_LAB_FREEZE`. The shared standard-library source verifier checks the approved freeze hash/tree and all 445 source files before any application or dependency import; there is no inferred checkout or manifest default. They are separate from the previously recorded 2,764 application test points; the old full suite was not rerun. All 445 frozen first-party files matched before and after.

The tests use the actual encrypted `AssistantState`, `VisaMediaStore`, consent helper, profile factory, intake and durable budget implementation. Persistence-mount attestation is an explicit test seam; a temporary directory is not represented as a production persistent mount. A fixture-only ledger starts with synthetic reconciled spending of USD 0.96 and a synthetic USD 1.20 cap. Literal count/generation responses are injected in memory solely to prime a cached result and its real reservation; no network primitive or real API key is used.

| Check | Observed result |
| --- | --- |
| Disable the current profile after one accepted synthetic read | New reads and profile resolution stop; cached evidence becomes `needs_review`; full job binding and page cache stay intact; local-reader fallback is not called. |
| Close and restart while disabled | No allowance is opened or created by the disabled factory; ledger and anchor bytes stay identical; opening the real ledger independently confirms the same spending, sequence, reservations and settlements. |
| Restore an older ordinary encrypted assistant-state fixture only | The separate ledger/anchor are untouched; the stable duplicate attempt is refused before either fake provider transport or local fallback runs; the spent allowance does not return. |
| Start without a ledger | Disabled startup creates no ledger, anchor or lock; later attempted enablement still fails closed and does not provision history. |

`run-01/` preserves the initial local Node 24 execution unchanged. `run-02/` preserves the first pinned Node 26.13.0 run. `run-03/rollback.tap` and `run-03/result.json` record the final pinned Node 26.13.0 run with the required source-and-freeze admission check, complete output, command, binary version/hash, readback hash, source binding and transport boundary. Synthetic state/media are destroyed by the fixture after each test; no recovery helper deletes or resets an existing ledger.

This supports a **feature rollback on the current compatible code**, with `RAAD_MRZ_PRODUCTION_ENABLED=false` and the latest independent ledger/anchor/history preserved. It performs no actual code/image downgrade, real-disk restore or production rollout and does not certify a code downgrade to `4b39` or the older live commits; that compatibility gate remains open. In particular, the older baseline has no awareness of profiled-job consent gates, so it is not an approved state-compatible rollback after profiled evidence has been persisted. Restoring both an old ledger and its matching anchor—or an entire old volume—also remains outside local rollback detection and requires external spending reconciliation.

Reproduction is bounded to the single new test file with a stripped environment, explicit `INTEGRATION_LAB_SOURCE` and `INTEGRATION_LAB_FREEZE` paths, pinned Node 26.13.0 and the shipped offline fence; see the recorded argv and source setting. Do not pass production state paths or credentials to it.
