# Raad automation review — 2026-10-30
Base: main e91010714290734a6fffd1fe8f9ff06be7450d31. Browser base: abcae8218458ea6d03de82adf3c11a400120373f.
Status: local, NOT deployed; no live submission, payment, SMS request or customer message in this repair phase.

Changes:
- Preserve confirmed answers (including nested health answers) across later question rounds.
- Require explicit transport and arrival-port choices; use native WhatsApp buttons/lists. Other ports require a separately collected actual name.
- Ask supported missing contact fields before a portal launch instead of stopping with an opaque document-review error.
- Add an employee-authenticated single-question control for a portal-review job. It requires human ownership, current case/payment context, no active portal run, an open WhatsApp window, and no pending/uncertain question. It never changes portal job state, releases ownership, applies answers automatically, or starts a browser. Answers remain labelled for staff review.
- Bind idempotency to recipient/job/field/revision/signature. Ambiguous delivery and interrupted sends cannot be retried automatically.
- Store an unspecified stay as not_specified and display it as غير محدد. Block government execution until the official field's acceptance of an unspecified stay is established. Do not invent a hotel.
- Compute the default entry estimate at actual dossier/launch time in Dubai, +15 calendar days. Preserve an explicit applicant/staff date. Persist source/reference-day/offset on the portal run and pass it to the browser.
- Require a browser capability for estimated-date verification. The companion browser patch checks the current ExpectedEntryDate label means an expected entry date, and rejects stale or conversation-day estimates.

Validation:
220 selected main/operations/domain/dispatcher tests passed. Includes 24 operations UI tests, synthetic native WhatsApp payloads and employee-route authorization. Full application integration/CI has not run in this partial checkout.
47 selected browser/SMS/date tests passed; all tests use synthetic responses or local loopback. No live provider/portal dispatch.
src/server.js syntax checked.

Deployment blockers:
1. SMS response semantics have not been observed safely. The existing local SMS-proof patch deliberately blocks before dispatch when the portal response verifier is unconfigured. A 2xx/challenge is not delivery proof. Do not deploy this as a working SMS fix until a verified contract is supplied and tested.
2. Whether ADDRESS_HOME is the intended Saudi-stay field and whether it officially permits an unspecified value remain unverified. Unknown accommodation stays blocked; no fake hotel/address is supplied.
3. Some dynamically required job/religion controls still need authoritative portal-derived choices before they can be collected automatically. No answers are invented.
4. This is a partial source snapshot, not a Git checkout. Full regression/CI and review of coordinated main+browser changes are required before deployment.

Coordination:
No Ahmed/Ismail conversation/model changes are part of this Raad candidate. An independent agent owns message batching/ingress.
Existing server integration hunk: import VisaStaffQuestions; instantiate after VisaFulfilment; pass staffQuestions to createVisaFulfilmentHttp; call staffQuestions.handleCustomerMessage before the human-owned automatic-handler guard, then continue only if handled. Merge this minimal hunk with the ingress agent's work rather than replacing their server file.

Companion main draft PR: https://github.com/mostafasaliha003-droid/flycham-whatsapp-assistant/pull/6
This browser candidate includes the prior local SMS proof patch. Its production verifier is intentionally not supplied: unknown portal semantics block BEFORE SMS dispatch.
