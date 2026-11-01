# Recovered-source state compatibility checks

This is a **fresh run after loss of the previous v16 scratch workspace**, not a recreation of its missing logs. It targets application commit `46963b57c5490afcd2e9da15468cce52234f931a`, tree `3c67dbdd818448f102395581a8dac32004eca5d2`.

The canonical result has eight functional checks: four existing MRZ-containment assertions executed on the corrected source, and four new encrypted financial-state recovery fixtures. Four additional setup test points create those financial fixtures. There are twelve physical TAP points across three complete streams; they are not twelve independent new scenarios or an addition to the application's full-suite total.

The MRZ wrapper reuses the immutable v15 fixture without copying it into the toolkit. It replaces only that fixture's source-verifier import; the four assertions remain unchanged. Source admission verifies the exact new freeze and all 445 source bytes and Git executable modes before any application import and again afterward.

The financial seed and recovery phases execute in two separate Node processes. They use real `AssistantState` encrypted files, real `InboxService` claim/finance/release operations and real `VisaFulfilment` APIs. Four fixtures check accepted payment notice and job idempotency, interrupted sending notices becoming uncertain, and pending/consuming OTP challenges plus browser leases becoming interrupted/review-required. The real dispatcher receives an in-memory bridge that permits only an owned cancellation acknowledgement. It makes no real call, starts no browser and receives no OTP value. Each fixture's separately provisioned synthetic MRZ ledger and anchor remain byte-identical.

The MRZ and financial fixtures are separate. The financial fixtures use synthetic receipt metadata and fake message/cancellation acknowledgements. Interruption checkpoints are written deliberately; this is not a kill during live I/O, production image rollback, Render disk restore, actual browser cleanup, Meta delivery, bank reconciliation, OCR accuracy or a security scan.

## Inputs

Application source, dependencies and runtime are external immutable inputs and are not included in this toolkit. Use the recovered source freeze included with the evidence, and checksum-pinned Node 26.13.0. Retrieve the v15 fixture from the same private repository at commit `0290581f9884da1deabd7f5a64be931935f951b4`, path `.ci/raad-readiness/integration-lab-v15/rollback/rollback.test.cjs`; its SHA256 must be `fc248ad99e999c5b241fb3ee2798affb591af9399be72e67749f15d15e8d900c`.

`inputs/strict-tap-parser.py` is a byte-identical copy of the pre-existing standalone packaging parser actually used by this fresh capture. It is not application source or a replacement for the different Git-backed CI parser. Its SHA256 is `b5d0788bbe421fa6c68b17f34c6988e0b60fb4eab506d4a6397e90d93ac6ae37`; importing it does not run its packaging entry point.

Run `python3 run-state-compat.py --source ABSOLUTE_SOURCE --freeze ABSOLUTE_FREEZE --node ABSOLUTE_PINNED_NODE --base-test ABSOLUTE_V15_FIXTURE --tap-parser ABSOLUTE_TOOLKIT/inputs/strict-tap-parser.py --out NEW_ABSOLUTE_OUTPUT`. The output directory must be new. The runner supplies a clean environment, no inherited credentials, and functional JavaScript fences denying native transports/process creation. Those fences do not constitute OS network isolation.

Keep `synthetic-fixtures/`, encrypted state, ledger files, fixture controls and keys out of exported evidence. Export only the exact evidence allowlist; preserve all three complete TAP logs and pipe-EOF/readback records. No Git or Render write is performed by these helpers.
