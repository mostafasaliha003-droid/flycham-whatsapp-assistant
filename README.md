# FlyCham WhatsApp Assistant

Independent quote-request intake MVP. This folder is separate from the hotel booking system.

## Current scope

- Receives WhatsApp Cloud API webhook verification and inbound text messages.
- Verifies `X-Hub-Signature-256` when `WHATSAPP_APP_SECRET` is configured; production mode refuses unsigned webhook requests if the secret is missing.
- Collects origin, destination, departure date, one-way or return, return date when needed, passenger counts, and child/infant ages.
- Accepts Arabic and Western numerals for dates and passenger counts, rejects invalid or past dates and return dates before departure, and supports greeting and cancellation commands.
- Responds with a recap and clearly says that a fare still needs a staff member to check the Fly Cham portal. It does **not** connect to the portal, check a live fare, route a staff handoff, book, issue a ticket, or collect payment.
- Outbound WhatsApp messages are in dry-run mode by default. In dry-run, replies are logged to the server console only.
- Conversation state is held in memory. Restarting the process clears unfinished conversations.

Completed requests are not saved to a database or automatically forwarded to staff yet. The assistant must not be presented as a live fare checker until an authorized portal workflow or Fly Cham API and a staff handoff are implemented.

## Run locally

Requires Node.js 18 or newer. No package installation is needed.

```sh
cp .env.example .env
node src/server.js
```

The app does not load `.env` automatically; export the variables in your shell or use your deployment platform's environment settings. For a quick local health check, set `PORT=3000` if needed and open `http://localhost:3000/health`.

Run tests:

```sh
npm test
```

## Connect a Meta webhook (when credentials are ready)

Expose this service over HTTPS, then configure the Meta WhatsApp webhook callback URL as:

```text
https://YOUR-HOST/webhooks/whatsapp
```

Set the same `WHATSAPP_VERIFY_TOKEN` in Meta and the service. Add the Meta app secret as `WHATSAPP_APP_SECRET` so POST signatures are verified. Subscribe the WhatsApp webhook to the `messages` field. Keep `DRY_RUN=true` until inbound messages, parsing, and responses have been reviewed.

Only after a deliberate live test, set `DRY_RUN=false` and provide `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_GRAPH_API_VERSION` in the hosting platform's secret environment settings. Never put real credentials in source control or send them in chat.

## Render deployment preparation

`render.yaml` describes a separate service named `flycham-whatsapp-assistant`, uses `/health`, keeps automatic deploys off, and leaves credentials to be entered as secrets in Render. To deploy it, put this project in its own GitHub repository and create a Render Blueprint from that repository. Do not point it at the hotel booking repository. The webhook callback URL after deployment is `https://YOUR-RENDER-SERVICE.onrender.com/webhooks/whatsapp`.

## Quote margin configuration

`.env.example` includes `QUOTE_CURRENCY`, `QUOTE_MARGIN_TYPE`, and `QUOTE_MARGIN_VALUE` as placeholders for the later quote workflow. They are not applied yet because the MVP has no fare source. Do not quote a price until the fare has actually been read from the authorized Fly Cham agent portal and the margin rule is agreed and implemented.

Air Arabia has a separate agreed margin of **AED 25 per passenger**, applied once to the complete itinerary total (including a return leg when applicable). `AIR_ARABIA_MARGIN_AED=25` is included in `.env.example` and the proposed Render configuration. It does not define the FlyCham margin or use the generic margin placeholders above.

`src/pricing.js` exports `priceAirArabiaQuote(quote, env)`. Supply the exact itemized portal total for all passengers in AED as `baseTotal`, plus `currency`, `passengerCount`, unique `segmentIds`, and an `ancillaries` array. Every passenger and segment must have both a seat and meal entry with `type`, `passengerIndex` (1-based), `segmentId`, `available: true`, explicit `freeOptionAvailable`, exact AED `cost`, and explicit `includedInBase`.

Choose a verified free seat and meal where available. Those services must have zero cost and receive zero service markup. If no free seat is available, or the customer explicitly requests a particular seat or seat feature, add its actual cost plus `AIR_ARABIA_SEAT_MARGIN_AED=10` per paid seat. If no free meal is available, add its actual cost plus `AIR_ARABIA_MEAL_MARGIN_AED=5` per paid meal. Apply service charges per passenger and segment; apply the ticket margin only once per passenger for the full itinerary. Costs already in the portal total (`includedInBase: true`) are not added twice; service margins still apply when the service is paid.

An AED 695.01 portal total becomes **AED 720.01 only when seats and meals are verified free**. A paid AED 20 seat and AED 15 meal, both excluded from that portal total, make the selling total **AED 770.01**: 695.01 + 25 + 20 + 10 + 15 + 5. The earlier base-fare observation does not prove free seat/meal availability.

Missing, unavailable, contradictory or duplicate ancillary checks block final pricing. The helper also rejects zero/malformed totals, unsupported currencies, invalid passenger counts and arithmetic overflow, uses integer fils, and returns separate base, added costs, ticket/service margins and audit lines. The caller must obtain a fresh portal quote and verify actual available options; this helper cannot turn unchecked assumptions into verified availability. Escalate ineligible or unavailable seat/meal cases (including infants where applicable) for review rather than assuming they are free.

The calculation helper is prepared for the future portal adapter; it is not called by the current webhook, does not fetch fares, and does not send automatic price replies. No live environment setting or deployment is changed by this proposal. Live ancillary inspection remains incomplete: opening the selected bundle reset the search frame and subsequent browser recovery could not restore observation. No test passenger, booking, seat or meal reservation, ticket, or payment was submitted. Do not submit fictional passengers to the live system without first establishing that the flow stays in a reversible, uncommitted quote; use a supplier test environment for steps that create a reservation or consume inventory.

## Next implementation stage

1. Choose hosting and connect the Meta WhatsApp Cloud API test number.
2. Verify webhook delivery with `DRY_RUN=true`.
3. Implement a separate, authorized portal quote adapter after portal access and its pages/flows are reviewed. Keep quote calculation auditable and prevent booking/ticketing actions.
4. Add durable session storage and human handoff before production use.

## Cheapest verified options and portal session management

`buildAirArabiaQuote` in `src/selection.js` is the prepared final-pricing entry point. It requires complete seat, meal and baggage catalogs for every passenger and segment, chooses free then cheapest eligible available options, and honors an explicitly requested seat number or feature only when the customer asked. It does not introduce a seat-preference question into intake. A requested seat carries the AED 10 service margin even when its supplier cost is zero; default free seats have no service margin. No-meal is not counted as free food. Seat numbers cannot be allocated to two passengers on the same segment.

The builder exposes the cheapest baggage choice with exact checked and cabin weights plus all verified available baggage weight/cost options. Baggage has no additional margin beyond the agreed ticket margin. Alternate weights need a new portal review before a final price is offered. No weight, availability, eligibility or catalog completeness is inferred. The final portal review must explicitly be complete and its total must reconcile against all selected supplier costs; unexplained extras block the quote. This library cannot itself prove that the review actually took place.

`src/portal-session.js` provides a serialized session coordinator with idle-only search-page heartbeats every 120 seconds, authentication checks, one verified re-login on session expiry, and graceful drain. A heartbeat is skipped during queued or running customer work. Failed sign-in blocks further automatic sign-in until operator review; CAPTCHA or verification needs operator handling. It does not perform random date searches, create a browser, sign in itself, or connect to the webhook. A real portal adapter, durable queue and always-running hosted worker are still required. Nothing in this draft runs 24/7 yet.

`test/fixtures/quote-passenger.json` contains synthetic test-only template data with no real contact or travel-document identifier. It is not a valid live passenger and must not be used to produce a live PNR. Supplier-dependent required test fields must be supplied through an approved test setup. The LIVE BOOKINGS flow still needs inspection to establish where a PNR or inventory hold is created before testing later stages.
