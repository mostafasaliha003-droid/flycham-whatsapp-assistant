# Synthetic Browserless hybrid handoff pilot

This experiment is disabled by default and is not a visa application executor.
Only the explicit combination `RAAD_SYNTHETIC_HYBRID_ENABLED=true` and a valid
`BROWSERLESS_API_TOKEN` allows starting it. It does not open MOFA, read or solve
human verification, take applicant data, or upload customer files. All tests
use fake provider responses and a generated one-pixel PNG.

The staff dashboard sends the existing administrator bearer key via HTTPS to
the `/internal/assistant/synthetic-hybrid` endpoints. Each endpoint checks
the same key and returns `no-store`; authentication is mandatory. The existing
key is shared, so this is not an individual staff identity or a single-person
authorization boundary. In a single process at most one test may run. URLs are
held only in memory, never placed in paths or logs, and are returned once by the
authenticated endpoint; the dashboard presents a validated HTTPS link with
`noopener noreferrer` and clears it on logout. The Browserless link itself is a
bearer capability reusable until its provider expiry, not a cryptographic
one-time link. Anyone possessing it can control the test session.

The manager expires/aborts the job after 110 seconds, requires cleanup to be
confirmed before starting another, and is disposed when the server closes. If
cleanup cannot be confirmed, manual intervention or restart is required. A
click on Done is not proof of authentication; this pilot does not verify login.
Actual account connection, private end-to-end link handling, real browser
latency, customer consent, document upload and the MOFA workflow remain
unverified. No CAPTCHA automation is implemented or authorized by this pilot.
The published Browserless free plan limits browser sessions to two minutes;
duration and pricing must be confirmed when making an actual test.

Reference: https://docs.browserless.io/baas/monitor-sessions/hybrid-automation
