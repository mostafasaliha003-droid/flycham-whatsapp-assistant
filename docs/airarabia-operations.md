# Air Arabia quote selection and continuous-operation preparation

## Agreed customer policy

Default requests: inspect the whole seat map and all available meal/baggage options. Choose an eligible free seat first, otherwise the cheapest available paid seat. Choose real free food first, otherwise the cheapest available meal; a no-food option is not a free meal. Confirm the checked and cabin baggage allowance; default to the cheapest weight option or provide separately rechecked weight quotes. Do not ask for a special seat unless the customer requests one. Honor an exact requested number or feature, without silently substituting a different preference.

Ticket margin: AED 25 per passenger, once for the whole itinerary. Default paid seat: supplier cost + AED 10. Explicit customer seat request: supplier seat cost + AED 10, including a zero-cost requested seat. Paid meal with no free food available: supplier cost + AED 5. Default free services receive no extra service margin. Baggage has no newly authorized markup. Costs already in the supplier total must not be counted twice.

A final quote requires complete options and actual availability for every passenger/segment, selected services, verified baggage weights, a fresh final portal review, and reconciliation of every supplier charge. Different weight alternatives must be rechecked individually before their total is represented as final. Test passengers cannot establish the real customer's age/residency/eligibility-dependent fare.

## Prepared code, not a deployed integration

- selection.js: complete option catalogs, cheapest defaults, explicit seat requests, seat uniqueness, real-food filtering, baggage disclosure and final-total reconciliation.
- pricing.js / money.js: integer-fils base, supplier-service costs, and independent ticket/seat/meal margins.
- portal-session.js: a single serialized session; idle-only openSearch after 120 seconds; pre-job authentication verification; one sign-in attempt on expiry; sign-in failure requires operator review; no concurrent heartbeat during a quote; graceful stop.
- test fixture: synthetic names and date of birth only, reserved invalid email, no real contact, nationality or passport. It is deliberately not a live-submittable passenger record.

A portal adapter must implement isAuthenticated, signIn and openSearch with UI-grounded selectors and sanitized failures. It must stop at site challenges and never log credentials. It must detect all seat-map pages, quote expiry, unavailable extras and the actual booking-commit boundary. No unobserved ancillary selectors or raw private endpoints have been invented.

## Continuous operation on Render

The independent assistant's current live web service is on the Free plan (verified 21 October 2026). Render's current documentation states that Free web services spin down after 15 minutes without inbound traffic. An internal timer that clicks the airline portal is outbound activity and does not satisfy that inbound condition. A persistent background worker is the appropriate execution model for a serialized portal job consumer; it must pull from a durable queue rather than receive HTTP calls directly.

Use a separately reviewed always-running compute plan and queue in the independent assistant project. Keep credentials in hosting secrets, separate from the synthetic passenger fixture and source control. Persist job/deduplication state; restart a lost browser and reauthenticate after process restarts. Idle activity does not guarantee a session can never expire. The operator-reported 3–4 minute timeout is not an independently verified supplier timeout. Heartbeats are designed for two idle minutes to leave a buffer, not a promise of uninterrupted authentication or uptime.

Current references read directly from Render documentation:
- https://render.com/docs/service-types
- https://render.com/docs/background-workers
- https://render.com/docs/free

No worker, queue, credentials, plan upgrade, deployment, heartbeat or 24/7 browser process has been created or activated by this draft. The current webhook still has no live portal adapter and remains in dry-run. Live seat, meal and baggage verification is still incomplete because browser control failed after opening the selected fare bundle. No live test passenger or reservation was submitted.
