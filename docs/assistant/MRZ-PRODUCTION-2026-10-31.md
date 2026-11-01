# Optional OpenAI MRZ profile — 2026-10-31

This profile is disabled by default. It adds literal MRZ transcription to newly completed, explicitly opted-in customer uploads. It does not enable visa submission, payment, WhatsApp sending, or general AI sales conversations. Do not create a second Raad service.

## Activation and data handling

The WhatsApp application's intake owns document processing. The worker must reject stale or revoked profiled evidence when accepting a dossier. Deploy a compatible reviewed pair before enabling the profile; the feature flags below belong to the main application. Default-off startup does not open or provision the separate budget ledger, create consent records, or call OpenAI.

Activation requires all of the following, managed privately in the existing service environment:

| Setting or prerequisite | Required value |
| --- | --- |
| `RAAD_MRZ_PROVIDER` | `openai` |
| `RAAD_MRZ_PRODUCTION_ENABLED` | `true` |
| `RAAD_MRZ_PRODUCTION_POLICY_SHA256` | `a70431e5ed8b897e4674e15a2734cf3fc61436b34e9010a8af4149c32b7ca461` |
| `RAAD_MRZ_PRODUCTION_BUDGET_USD` | Explicitly approved total USD cap, including reconciled historical spending; must match the existing ledger exactly |
| `RAAD_MRZ_PRODUCTION_BUDGET_PATH` | Optional absolute path beside the existing encrypted assistant state; defaults to `visa-mrz-budget.enc` |
| Provider credential | Existing privately managed `OPENAI_API_KEY`; never committed, logged, requested in chat, or created by this change |
| Storage | Confirmed persistent mount, existing encrypted state key, and reconciled ledger plus commit anchor |
| Customer authorization | Unchecked optional upload-page consent, bound to the completed session, selected document, customer, case signature and exact reader policy |

Only current passport/residence uploads can receive a grant. Portraits, historical WhatsApp documents, backfills, completion retries, duplicate existing jobs and local-reader failures do not acquire a grant or upgrade a job. A later environment change never upgrades existing jobs. Grants expire with the upload session and can be stopped from the completed upload page. Staff ownership/block transitions revoke the customer's grants. Revocation cannot undo a provider request already transmitted; the UI makes no provider-deletion guarantee.

The new reader crops the MRZ from an already upright page, uses fixed `gpt-6-astra` with strict structured output and literal/checksum validation, and refuses uncertainty or inferred repairs. It sends no conversation history or tools and uses `store:false` and standard service tier. `store:false` does not promise zero retention; provider monitoring/data policies still apply. Existing separately configured Google Gemini whole-page processing remains a distinct path described in the privacy notice.

## Spending and durable state

Runtime only opens an existing budget; it never creates an allowance, resets history, refunds reservations, or breaks stale locks automatically. Every provider attempt first commits a reservation of at most USD 0.12. The stable billing identity includes customer, case ID, original source checksum, page index/checksum, format and reader policy. It excludes media UUID, mutable case signature, consent reference and reread generation, so these changes cannot silently buy another attempt for the same input. Ambiguous outcomes retain their full reservation and require review.

The ledger is independently encrypted using a purpose-specific derivation of the existing state key. Its sibling `.anchor` must agree with the ledger's commit sequence and checksum. A `.lock` protects single-process ownership. Missing, corrupt, partially written or separately rolled-back state fails closed. Close cannot release ownership while an operation or provider lease remains pending.

The earlier eight-call evaluation conservatively reserved USD 0.96 of its USD 1 cap; USD 0.04 is insufficient for another USD 0.12 attempt. This change grants no extra allowance. The production prompt differs from the evaluation prompt and has not been validated by a new live-model evaluation.

An offline operator may use the exported `provisionDurableMrzBudgetOffline` function only while every application/worker owner is stopped and after separate owner approval of a total cap and reconciliation of all historical spending. Required arguments are `file`, the existing state `key`, `policyFingerprint`, `capUsd`, `persistentStateConfirmed:true`, `ownerApproved:true`, `historyReconciled:true`, a SHA-256 `historyEvidenceSha256`, and `historicalSpentUsd` of at least 0.96. These booleans are caller attestations, not proof of identity or provider billing. No application startup or HTTP route calls this function. It refuses an existing or partial ledger/anchor pair; never delete existing state to obtain a fresh allowance.

The cost calculation is a conservative application bound using counted input, an additional schema allowance, bounded output and conservative published rates. It is not an invoice guarantee. Reconcile actual provider usage before changing rates or increasing the cap.

## Recovery and rollback

Stop new work and let in-flight provider requests settle before shutdown. Server shutdown uses a bounded 25-second drain; if it times out or consent persistence is uncertain, the lock stays held and recovery requires offline reconciliation. A timeout keeps the provider lease until the underlying request and settlement finish. On storage uncertainty, stale lock, mismatch or exhausted cap, leave the profile disabled and route the affected case to staff. A staff member must confirm all processes are stopped and reconcile durable evidence before any manual recovery; do not automatically remove locks or reconstruct partial files.

Preserve the latest ledger and anchor together independently of ordinary assistant-state backups. Restoring only one is detected; restoring both together, or an entire old volume, cannot be detected using these local files alone. Recovery must reconcile externally retained spending history. Rolling back application code must not restore an older spending allowance. Disable `RAAD_MRZ_PRODUCTION_ENABLED` first; do not downgrade a profiled job into a local job or accept cached evidence without its live consent guard.

Before production activation, record the exact source commit, existing main and Raad service IDs, compatible worker revision, clean build/install results, complete functional test logs, independent security-scan result, and approved synthetic model-quality evaluation. Inspect upload consent/revocation in an isolated browser. A safe transport test must keep customer messaging, government submission and fees disabled. Local fake-provider tests do not establish model reading accuracy, latency, sales quality, or live WhatsApp delivery.
