# Insurance entry-date follow-up — 2026-10-30

Scope: PR7 only. No live portal operation, SMS, submission, payment, merge or deployment.

The independent review reproduced a valid application expected-date field followed by an insurance control labelled "Confirmed booking date". The former worker filled that second control without checking its meaning.

Fix:
- Verify the CURRENT insurance page's ExpectedEntryDate control and exact expected-entry label before any insurance contact/date write. The earlier page's verification is not reused as authorization.
- Capture the exact submitted entry date immediately before application Save. After the unique passport-row lookup proves the saved reference, bind that submitted date to the saved reference, case signature and applicant index.
- Insurance uses that attested current-run submitted value. It does not use a changed manifest value, re-read the current day or add fifteen days again.
- Unknown/mismatched saved-date evidence blocks with SAVED_ENTRY_DATE_UNCONFIRMED. An existing saved request from another job still needs a genuine bound saved-date observation; a new office estimate cannot replace it.
- The attestation is the verified current-run submission value (the native Save checks date readback), not an independent readback of a historical server-stored date. The worker record remains process-local; no cross-restart reconstruction is claimed.

New regressions:
1. Insurance label "Confirmed booking date": saved/reference remain known; no insurance date/contact write.
2. Correct expected-date field after Dubai midnight: uses the original submitted date.
3. Manifest date changed after Save: cannot replace the submitted date.
4. Resumed insurance evidence is reference/case/applicant-bound; missing, invalid or mismatched evidence cannot fall back to an estimate.
5. Misleading wording containing "Expected entry date" still fails the exact field-meaning check.
The pre-existing native-resume fixture now supplies the real manifest identity and current date-control metadata required by these guards.

Validation:
60 selected browser/SMS/date/insurance tests passed.
Combined overlay: 310 passed (243 main + 60 browser + 7 paired). All data and portal interactions are synthetic or loopback; no genuine government request was made.
Reproduction files: src/raad-login-pilot/insurance-entry-date.test.js and scripts/raad-paired-candidates-check.cjs (paired overlay).

Remaining live-evidence blockers are unchanged: actual SMS response semantics, actual ADDRESS_HOME meaning/unspecified-stay acceptance, historical saved-date evidence, current dynamic occupation choices, and actual runtime date-field semantics. These drafts remain blocked for deployment.
