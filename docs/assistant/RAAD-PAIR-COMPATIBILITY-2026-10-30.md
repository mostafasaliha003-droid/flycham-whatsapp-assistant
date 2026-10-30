# Paired Raad candidate compatibility — 2026-10-30

Status: review drafts only. No merge, deployment, customer message, government SMS, live portal mutation, final submission, or payment was performed.

Independent-review regressions fixed:
- Date provenance is checked at OTP resume, again before SMS, and again before Save after CAPTCHA work. A Dubai-midnight change blocks stale estimates; it never silently recomputes a date after applicant confirmation.
- A saved-application continuation with office-estimate provenance stops with ESTIMATED_ENTRY_DATE_SAVED_VALUE_UNCONFIRMED until a read-only official saved-date observation is available. No new estimate replaces an unknown saved value.
- The current official expected-date label is rechecked before OTP entry. Identifiers alone and unrelated wording do not authorize an estimate.
- Staff conditional questions read current-job collected answers as well as confirmed fields. The other-port detail appears after the actual other choice and stale controller answers cannot authorize it.
- Ready jobs may collect staff questions while human-owned. Once handed back to automation, genuine client answers with message IDs are staged for a new applicant summary confirmation, without re-asking them or starting the portal.
- Legacy machine proofs retain their previous preparation contract. New jobs carry explicit routing requirements, and the dispatcher asks missing transport/arrival-port questions for legacy ready jobs before any browser launch. No office default is promoted into a client answer.
- SMS failure responses carry only sanitized evidence and an explicit not_dispatched/dispatched/uncertain state. The private adapter and production worker preserve it after HTTP 409 and owned cleanup. Missing response verifier has a stable code and a pre-dispatch marker. Ambiguous attempts are never retried automatically.

Verification:
- Main selection: 243 passed, including the existing 18 raad-machine-dossier tests unchanged from e9101071.
- Browser/SMS/date selection: 55 passed.
- Cross-candidate integration: 7 passed using the actual main coordinator/dossier/dispatcher and actual worker/manifest/date code with synthetic documents, accounts and an injected in-memory portal/bridge.
- Combined overlay run: 305 passed, 0 failed. Source trees were overlaid only in the local paired-candidate directory; no repository merge occurred.
- All HTTP tests are local loopback or fake transport. No real portal/provider request is part of the tests.

Reproduce the paired checks:
Overlay the main PR's source tree and the companion PR's src/raad-login-pilot source files in an isolated checkout, then run:
  node --test scripts/raad-paired-candidates-check.cjs
The explicit script filename is intentionally outside automatic test discovery so a single-branch checkout without its companion is not mistaken for the paired candidate.

Still needs genuine portal evidence:
1. The application-SMS endpoint/request correlation and authoritative response semantics (accepted versus rejected). Without that verifier, code stops BEFORE sending SMS. A 2xx, visible challenge, or timeout is not delivery proof.
2. The exact meaning of ADDRESS_HOME and whether the official field and server permit an unspecified stay. not_specified remains an internal truthful status and is blocked before government execution; no hotel or address is fabricated.
3. The actual date stored on an existing application, bound to its passport/reference, before an office-estimate continuation can proceed.
4. Exact current dynamic occupation/religion controls and available choices. Missing answers remain missing.
5. Runtime verification of the actual ExpectedEntryDate label and date acceptance; successful synthetic metadata tests do not prove that the live portal currently exposes that contract.

Coordination: no Ahmed/Ismail, message-batcher or ingress changes are included. The existing tiny staff-answer inbound hook in main server.js still requires coordination with the ingress agent. These review fixes did not edit that main inbound block.
