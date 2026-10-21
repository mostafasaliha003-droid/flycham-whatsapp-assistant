# Air Arabia quote selection and continuous-operation preparation

## Incident update — 21 October 2026

A separate Render worker now exists: `airarabia-portal-keepalive` (`srv-dbcjdhfb9u1s73bsm1s0`), Frankfurt, 1c-2g, on branch `codex/airarabia-fixed-margin`, with auto-deploy off. It is suspended while startup is being diagnosed. Do not modify hotel services.

The live diagnostic deployment reached the login page but timed out waiting for the username field. Public supplier Login.js confirms fullScreen2() opens a named winCC popup and keeps the launcher body hidden. The adapter now follows that popup only when its origin and path match the expected login page. It also avoids the supplier Browser.js innerText override, which includes hidden script/error catalogs, by checking only visible captcha/error elements.

The previous version logged only a generic startup failure, then exited and could be restarted by Render, repeating login. The patched version validates configuration first, uses `domcontentloaded` plus explicit form checks instead of waiting for every page resource, waits for the visible authenticated sign-out control, and reports only allowlisted stage/error codes. It stops before any visible CAPTCHA/verification challenge. Startup or session failure closes the browser and parks without automatic retries. Shutdown remains supported while parked.

Safe diagnostics include `PORTAL_OPEN_LOGIN_PAGE_TIMEOUT`, `PORTAL_LOGIN_FORM_TIMEOUT`, `PORTAL_LOGIN_CONFIRM_MANUAL_VERIFICATION`, `PORTAL_LOGIN_CONFIRM_LOGIN_NOT_CONFIRMED`, `PORTAL_AUTHENTICATED`, and `PORTAL_HEARTBEAT_SEARCH_COMPLETED`. Never print raw browser errors, credentials, page contents, supplier URLs, cookies, or customer data. A successful Render deploy is not proof of portal login or session retention.

The patched version passes 39 local tests. Live portal authentication and the first 15-minute heartbeat search remain unverified. Resume the existing worker and inspect these diagnostics; do not claim 24/7 availability until both authentication and a later heartbeat are confirmed. A challenge or rejected login requires operator review, not bypass or automatic repeated attempts.

The preparation notes below describe the earlier draft and are retained as historical context; their statements that no worker exists are superseded by this incident update.

## Agreed customer policy

Default requests: inspect the whole seat map and all available meal/baggage options. Choose an eligible free seat first, otherwise the cheapest available paid seat. Choose real free food first, otherwise the cheapest available meal; a no-food option is not a free meal. Confirm the checked and cabin baggage allowance; default to the cheapest weight option or provide separately rechecked weight quotes. Do not ask for a special seat unless the customer requests one. Honor an exact requested number or feature, without silently substituting a different preference.

Ticket margin: AED 25 per passenger, once for the whole itinerary. Default paid seat: supplier cost + AED 10. Explicit customer seat request: supplier seat cost + AED 10, including a zero-cost requested seat. Paid meal with no free food available: supplier cost + AED 5. Default free services receive no extra service margin. Baggage has no newly authorized markup. Costs already in the supplier total must not be counted twice.

A final quote requires complete options and actual availability for every passenger/segment, selected services, verified baggage weights, a fresh final portal review, and reconciliation of every supplier charge. Different weight alternatives must be rechecked individually before their total is represented as final. Test passengers cannot establish the real customer's age/residency/eligibility-dependent fare.

## Prepared code, not a deployed integration

- selection.js: complete option catalogs, cheapest defaults, explicit seat requests, seat uniqueness, real-food filtering, baggage disclosure and final-total reconciliation.
- pricing.js / money.js: integer-fils base, supplier-service costs, and independent ticket/seat/meal margins.
- portal-session.js: a single serialized session; after 15 idle minutes it requests one one-way search using a randomized departure date 30–90 days ahead; checks once per minute so the threshold is not missed; pre-job authentication verification; one sign-in attempt on expiry; sign-in failure requires operator review; no concurrent heartbeat during a quote; graceful stop.
- airarabia-worker.js: proposed Playwright UI adapter, fixed to observed SHJ–DAM airport selectors and stopping at results without selecting or booking. Credentials are read only from environment secrets. This driver has passed syntax checks but has not been run against the live portal; selector accuracy, search completion and session renewal remain unverified.
- Dockerfile.worker and render.yaml: proposed Playwright 1.64.0 worker using Render's 1 CPU / 2 GB `1c-2g` plan (currently USD 25/month). The worker is declared disabled and auto-deploy is off. No worker has been created or deployed.
- test fixture: synthetic names and date of birth only, reserved invalid email, no real contact, nationality or passport. It is deliberately not a live-submittable passenger record.

The adapter must stop at site challenges and never log credentials. The heartbeat search must stop after results appear; it must not select a fare or continue to booking. It must detect all seat-map pages, quote expiry, unavailable extras and the actual booking-commit boundary before it can be used for customer quotes. No unobserved ancillary selectors or raw private endpoints have been invented.

## Continuous operation on Render

The independent assistant's current live web service is on the Free plan (verified 21 October 2026). Render's current documentation states that Free web services spin down after 15 minutes without inbound traffic. Outbound portal searches do not keep that web service awake. A persistent background worker is the proposed execution model for the separate portal session; it does not yet consume customer quote jobs.

Keep credentials in hosting secrets, separate from the synthetic passenger fixture and source control. The proposed worker uses 1 CPU / 2 GB for Chromium headroom; verify its actual memory use before production. Idle activity does not guarantee a session can never expire. The 25-minute idle timeout is user-reported and has not been independently verified. A 15-minute search leaves a 10-minute buffer if the portal's timer is activity-based and a search resets it.

Current references read directly from Render documentation:
- https://render.com/docs/service-types
- https://render.com/docs/background-workers
- https://render.com/docs/free

No worker, queue, credentials, plan upgrade, deployment, heartbeat or 24/7 browser process has been created or activated by this draft. The current webhook still has no live quote adapter and remains in dry-run. Live seat, meal and baggage verification is still incomplete because browser control failed after opening the selected fare bundle. No live test passenger or reservation was submitted.
