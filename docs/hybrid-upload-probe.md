# Browserless hybrid synthetic probe

This is an **isolated, disabled-by-default experiment**, not an application or
production integration. It exercises the documented Browserless `liveURL` /
`liveComplete` flow and then attaches a fixed, one-pixel synthetic PNG to a
network-blocked `about:blank` page in the *same* Playwright/CDP browser session.
It does not open the Saudi visa site, accept an agreement, request credentials,
read a CAPTCHA, or handle customer files.

The caller must supply an API token from its existing secure environment and
an authenticated one-recipient `deliverPrivateLink` function. No HTTP endpoint,
dashboard, credential setup or secure delivery channel is included here. A
`liveURL` is a bearer link granting control of the browser: never log it or
include it in an exception, store it in an ordinary journal, send it in a
group, or expose it in a public endpoint. Expiry does not close the underlying
browser, so this experiment also attempts to close the browser on every exit.

The Node tests use simulated Playwright/CDP objects and do **not** verify
Browserless, authentication, a real browser, or a handoff to any person.
Nothing was deployed or activated. A real synthetic end-to-end test needs an
authorized account/API token and a private delivery mechanism. Verify provider
API quotas, timeouts, session region, retention and consent before sharing any
real credentials or files. The official documentation states the free browser
session limit is two minutes; this can be too short for a manual sign-in.

For a later real implementation, explicitly review a job-bound single-recipient
handoff, state/expiry/replay, confidentiality, access control, browser session
cleanup, actual authentication and document upload, as well as truthful data and
declarations. The person must complete any human verification; do not program
this experiment to read or solve it. A `userDone` event alone is not proof of
successful authentication, and this probe has no login verifier.

Reference: https://docs.browserless.io/baas/monitor-sessions/hybrid-automation
