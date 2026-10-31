# Local integration lab — disabled by default

This portable helper bundle is outside the 445 frozen application files. It binds commit `2167d5f87fce8f2cf05de1c96e367a8a57ce7402`, tree `036355159f736467891c29ec6383b928ae4b6d2d` and application SHA256 `5fc02e363543161c53a9bc540d05f7bc3cb824825fb3f5dff92d57f60577e756`.

No default checkout, production environment, state path, credential file or provider is loaded. Enabled execution requires explicit absolute source and freeze paths. `verifyApprovedSource` canonicalizes them, checks the pinned freeze SHA256, and checks the 445 listed file bytes, SHA256 and executable modes before application imports. This is a source immutability check, not a source security scan.

```sh
# No activation flag: prints disabled metadata and initializes no app/state/provider.
node run-local.cjs

# Explicit local synthetic scenario; choose the already installed, approved Node26 binary.
INTEGRATION_LAB_LOCAL_ENABLED=true node run-local.cjs \
  --run-local-synthetic --source /absolute/approved/checkout \
  --freeze /absolute/approved-source-freeze.json
```

The launcher passes only explicit path/nonsecret runtime settings to its child, uses the source-bound numeric-loopback fence, and captures/fsyncs/readbacks complete output. It opens ephemeral numeric-loopback routers only; it does not deploy a web service. `approved-source-freeze.json` in this bundle is the exact metadata manifest; no application source copy is needed in the helper bundle.

The NEW `router-gated.test.cjs` scenario uses actual current main and worker HTTP routers with the new session gate and strict loopback transport. A synthetic job is seeded and the existing dispatcher acquires its real lease. A signed, sender/phone/WABA/session/job/challenge-bound synthetic owner reply is admitted to the actual main webhook; its exact OTP request reaches the actual worker once. Wrong sender/job and replay do not enter those routes. The worker reaches its immutable `RAAD_TEST_SUBMISSION_BLOCKED` boundary. Graph responses and the portal flow are injected; browser, government, model, payment and real messaging calls remain zero. This is not a real Meta or government E2E test.

The initial synthetic job is deliberately bootstrapped before the gate is created. The new wired scenario covers the OTP handoff, not intake, payment confirmation or initial job dispatch. Wrong native-challenge and expiry negatives are covered by the boundary tests, not individually through the routers.

The production-shaped new lab session gate is functional only in `local_synthetic` mode and accepts only a clearly labelled synthetic signing fixture. `REAL_META_ENABLED` is a literal `false`; `sendRealMeta` always rejects. There is no real credential loader, Meta webhook subscription, public gateway or live-government adapter. Changing an environment flag cannot enable real sending.

The gate has one ephemeral session and one attempt. It checks actual webhook HMAC verification, the configured synthetic WABA/phone-number metadata, the approved owner, reply message context, case/job/native challenge binding, original deadline and one-use state. Invalid OTPs consume the attempt; uncertainty cannot retry. Snapshots contain no code and cannot be restored; process restart does not resume a pending session. This does not provide a persistent cross-process replay registry or authorize reconstructing an old session by hand.

The strict transport admits only two distinct explicitly configured `http://127.0.0.1:<port>` origins:

| Origin | Allowed requests |
| --- | --- |
| Main | GET `/health`; GET exact-job `/internal/assistant/visa-portal/jobs/<job>/lease`; POST `/webhooks/whatsapp` |
| Worker | GET `/health`; GET exact `/internal/raad/jobs/<job>`; one POST `/internal/raad/jobs`; one exact-job POST `/otp`; POST exact-job `/cancel` |

Worker starts bind the single case/job/applicant; OTP posts bind the original unexpired native challenge. Queries, fragments, encoded path aliases, redirects, other jobs, arbitrary headers/private bearer values, government/model/Meta origins, WebSockets, file URLs and payment paths are rejected before forwarding. Only explicitly labelled synthetic bearer authorization is permitted. Cleanup cancellation remains available.

The constructor gate and transport are wired together in the new loopback scenario. They are not wired to real Meta. Future real-Meta operation needs a separately reviewed runtime gateway, dedicated provider test sender, privately managed test credentials, real sender metadata verification, owner-only admission/egress enforcement, a confirmed service window and explicit cost/operation approval. No production main or Raad configuration should be changed to obtain that test.

Current final local results are **19 boundary tests + 1 new wired-router scenario + 4 disabled-profile recovery tests = 24 passed**. These are separate from the previously recorded 2,764 frozen-application points. The earlier unchanged 4-case router replay is preserved as historical lab evidence and is not counted as new coverage. `portable-run-01/`, `router-gated-run-eSyCN4/` and `rollback/run-03/` hold the final complete logs and hashes. Intermediate failure/pass histories remain present. No old full suite was rerun.

The rollback tests use real encrypted state/media/consent/intake/ledger implementations on synthetic temporary fixtures, injected persistent-mount confirmation, and fake provider responses. They prove current-code profile disable/restart containment. They do not prove an image/code downgrade, a real disk restore or a production mount. The distinct patched-fallback deployment gate remains open.
