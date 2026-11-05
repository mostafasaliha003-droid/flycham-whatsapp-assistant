# Air Arabia Abu Dhabi correction — supplier-tested and released

## Outcome

Abu Dhabi requests no longer force G9-only search. The worker selects an observed explicit 3L option when available, otherwise the actual enabled Search All option, and binds every result to the requested route, dates, party, currency and carrier before quoting. Actual supplier tests on 26 October 2026 confirmed both AUH–DAM and unchanged SHJ–DAM behavior. The worker-only correction was released; no hotel resource, web application release, price margin or infrastructure plan was changed.

## Live supplier checks

All times below in the verification column are Dubai time (UTC+4), on 26 October 2026. Flight timings are reproduced as displayed by the supplier, without an independently asserted timezone conversion. Tests used one adult, one-way, 27 October 2026, default requested checked baggage of at least 30kg. No ticket or payment was created.

| Check | Observed result | Verification |
|---|---|---|
| AUH–DAM discovery | Search All selected and confirmed; response identity confirmed; flight 3L504, 09:15–11:50 | 20:35:52 |
| AUH–DAM quote | Selected-row identity and ancillary calculation passed; computed selling total AED 849.01 | 20:36:30 |
| AUH cleanup | Diagnostic completed and owned browser cleanup confirmed | 20:36:30 |
| SHJ–DAM discovery | G9 matched response; G9433 08:30–11:05 and G9375 11:05–13:40 | 20:44:12 |
| SHJ–DAM quote | Row 1 G9433, checked baggage 30kg for one covered segment, computed selling total AED 730.01 | 20:44:37 |
| SHJ cleanup | Diagnostic completed and owned browser cleanup confirmed | 20:44:37 |

The AUH diagnostic version did not log actual selected weight or a price-component breakdown: it proves that the calculation passed the request for at least 30kg, not that the selected weight was exactly 30kg. The later SHJ diagnostic explicitly logs sanitized `{kg, segmentsCount}` and refuses a confirmed quote below requested weight. The second discovered SHJ flight was not priced in this bounded regression test. Selling totals include current pricing rules; they are not raw supplier base fares. Hand baggage and an independent payment-page final review were not verified. These are quote-only results from supplier result/ancillary screens, not reservations, issued tickets, or a guarantee of future availability.

Successful isolated jobs were `job-dbfo23gu01pc73fu9nmg` (AUH) and `job-dbfo606c6qcc73f2t900` (SHJ), each using the existing worker's successful image/environment snapshot on temporary 2CPU/4GB compute. Reviewed source files were staged only under owned `/tmp`, with per-file SHA-256 verification. No combined worker, queue polling, WhatsApp sends, screenshots or client data were part of those diagnostics.

## Release and production checks

Worker commit: `57618f68984e8481e19c8a8ba76826331b7302e9`, based on existing worker head `36d344db9a87af9cd2629d9ce914688416d4b506`. Only three application files and five associated tests changed. The main/web branch was not merged into the older worker branch; unrelated web-side differences were preserved.

Release `dep-dbfo7v8u01pc73fut1u0` started at 20:46:53 Dubai and became live at 20:47:53. Service: `srv-dbcjdhfb9u1s73bsm1s0`; production compute remains 1CPU/2GB, one instance, auto-deploy disabled. New instance identifier: `jmpns`.

Post-release supplier evidence:

- FlyCham authenticated at 20:47:58; protected navigation completed at 20:48:11 and health confirmed at 20:48:12.
- Air Arabia submitted the Gmail-delivered OTP at 20:48:24, authenticated at 20:48:36, completed its initial protected refresh at 20:48:47 and became idle-controller ready. OTP contents were never printed.
- Normal Air Arabia catalog polling started at 20:48:47 and confirmed a fresh matched G9 search response at 20:49:06. That particular background query returned no verified offer; its unknown dates must not be confused with the successful explicit-date regression tests above.
- New-instance memory readings were 34.30% at 20:48:20, 51.31% at 20:49:20 and 46.60% at 20:50:20. Latest CPU usage was 39.24% of one CPU. These are short observation-window measurements, not a long-term capacity guarantee. Resource instance count remained one; metrics alone do not establish presence or absence of an OOM event.
- No new blocked/session-unavailable condition appeared in the inspected new-instance application logs through 20:49:26. Live deployment status alone was not used as proof of supplier authentication or pricing.

A post-release WhatsApp end-to-end customer conversation has not been exercised by this diagnostic. The actual supplier route tests used the same patched files over the production image's existing dependencies, followed by observed production authentication and queue/search activity.

## Implementation and tests

`portal-search-probe.js` selects carrier before airport autocomplete, reselects the same observed value at most once if the supplier resets it, and revalidates route, date, party, currency, trip mode, Economy and Normal controls before Search. Search All is not treated as proof of flight carrier: raw result rows must still identify 3L for AUH or G9 for SHJ.

`airarabia-search-identity.js` captures timestamp baselines and requires a fresh successful response, same-object search parameters and flight arrays, matching route/dates/party/currency/search-system, source-grounded segment dates/routes/carriers and selected flight references. Only a matched completed empty response can establish no flights. Stale, failed, mismatched or unrecognized models remain unverified. Cached primary supplier code informed the guard; the successful live checks now establish compatibility for the exact tested current rows.

`airarabia-worker.js` wires these guards before reading or pricing results. Its separate partial-login recovery allows one ordinary protected-page navigation only when the selected trusted window is fully observable with sign-out evidence and no login, OTP, CAPTCHA, denial, password-change or concurrent-session response. No verification bypass or automatic login retry loop is introduced.

The full local suite passes 917/917 tests, including 48 diagnostic tests. Focused identity/adapter/carrier tests previously passed 134/134; carrier/airport compatibility 145/145. Tests cover observed 3L/Search All selection/reset, preserved SHJ/FlyCham behavior, result freshness/binding, routes/dates/counts/currency, selected references, login recovery, strict staging, origin allowlist, memory budgets, sanitized output, weight threshold and owned cleanup. Diagnostic additions were frozen before the SHJ run.

Strict limitations remain: mixed/unrecognized carriers or codeshares, unfamiliar dates/references, null flight-array models and other unproven formats fail closed. The tested one-way current models passed; arbitrary return or connecting itineraries are not established by these two checks.

## Diagnostic safety and spend

The user explicitly approved Render CLI access to account resources, local token storage and its seven-day expiry. Login completed for the expected account/workspace. No CLI token was inspected, exposed, or placed in application configuration. The user separately approved up to three additional attempts within a cumulative US$0.10 budget including the initial failed attempt. Two additional attempts were used, both successful; no further attempt is required.

Initial job `job-dbfns54s728c738etr5g` failed during startup at 20:22:19, after 39 seconds, with Dashboard exit 128 and no application logs. A missing explicit shell was a plausible startup explanation, not a proven interpretation of exit 128. The corrected entry uses one-line `node -e`, bounded gzip decoding, SHA-256 verification, exclusive creation of an owned temporary shell file and explicit `/bin/sh` execution. Argument parsing, syntax, source integrity and stubbed exit propagation checks passed before retry.

Each diagnostic has a 12-minute inner deadline, default memory threshold 75% with explicit maximum 85%, and bounded owned-browser cleanup. The corrected entry adds a 750-second outer process cutoff. Unknown memory limits fail closed. Missing cleanup confirmation remains failure even if isolated-container termination eventually releases its processes. No additional production browser was launched beside the combined worker for this verification.

Render bills temporary jobs per second. Compute estimates use the published 2CPU/4GB US$85/month rate and are not exact invoice totals or provider-enforced spending caps; tax/egress can apply. All three temporary jobs have terminated. Their combined billed-runtime window was 288 seconds (39 + 131 + 118); 30-day-prorated compute is approximately US$0.009444 before any tax/egress. Job durations and final statuses are tracked in the operator checkpoint. No recurring paid service or production-plan upgrade was created.
