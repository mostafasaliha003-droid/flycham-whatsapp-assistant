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

`src/pricing.js` exports `priceAirArabiaQuote({ currency, baseTotal, passengerCount }, env)`. Supply the exact itemized total for all passengers, in AED, after verifying the portal quote and itinerary. The helper returns separate base, margin and selling totals as two-decimal strings and rejects zero/malformed totals, unsupported currencies, invalid passenger counts and arithmetic overflow. It uses integer fils to preserve precision.

For example, an AED 695.01 portal total for one passenger becomes **AED 720.01**. Three passengers incur a total margin of AED 75. This calculation helper is prepared for the future portal adapter; it is not called by the current webhook, does not fetch fares, and does not send automatic price replies. No live environment setting or deployment is changed by this proposal.

## Next implementation stage

1. Choose hosting and connect the Meta WhatsApp Cloud API test number.
2. Verify webhook delivery with `DRY_RUN=true`.
3. Implement a separate, authorized portal quote adapter after portal access and its pages/flows are reviewed. Keep quote calculation auditable and prevent booking/ticketing actions.
4. Add durable session storage and human handoff before production use.
