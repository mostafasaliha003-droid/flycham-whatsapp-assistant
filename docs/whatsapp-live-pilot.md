# Air Arabia WhatsApp quote pilot

The signed Meta webhook enqueues a supported request. The existing authenticated
browser worker polls a bearer-protected endpoint, claims one lease, runs it through
PortalSession's serialized queue, and posts one result. The web service retains
the WhatsApp recipient; the browser worker receives only trip details.

Supported pilot: one adult, no children/infants, one-way or round-trip dates,
SHJ–DAM or DAM–SHJ. No customer passenger data is entered in the portal. The
operator-authorized synthetic passenger is used only to inspect ancillaries.
Unsupported or unconfirmed requests receive a review-needed response.

The operator confirms the displayed portal total includes taxes and fees. This
pilot accepts that total without inventing tax charges. It requires freshly
complete seat, actual food and checked-weight catalogs, AED amounts and a zero
existing ancillary subtotal before adding unselected supplier option costs.
It adds AED25 once for the passenger, AED10 per paid default seat, AED5 per paid
food choice, and AED10 once for explicitly requested higher baggage weight
across the itinerary. It reports unknown hand baggage as unconfirmed.

The reader does not apply services, hold inventory, press ancillary Continue,
open payment, or issue a ticket. It reports an available fare, not a guaranteed
booking or a proven minimum across every possible flight/fare bundle.

## Configuration

Both services: `AIR_ARABIA_QUOTE_QUEUE_ENABLED=true` and a shared random
`AIR_ARABIA_QUOTE_QUEUE_KEY` (at least 32 characters, never committed).
Worker: `AIR_ARABIA_QUOTE_QUEUE_URL` is the web service origin followed by
`/internal/quotes`. Disable the unrelated random startup search probe.

## Operational limits

This is a bounded in-memory pilot queue (100 jobs, sixty-minute expiry), not durable
production infrastructure. A web-process restart loses pending jobs. Claims and
completion leases are consumed once; ambiguous send failures are not retried to
avoid duplicate customer messages. A persistent job store, delivery outbox and
recovery flow are required before a 24-hour service guarantee. Polls keep the
web service active only while the authenticated worker is running.

No browser credentials or WhatsApp access token are copied between services.
The worker may require operator OTP after deployment. A deploy marked live is
not proof of a working supplier session or a completed WhatsApp fare lookup.

## Conversational dates and timing comparisons

Arabic relative dates use Asia/Dubai calendar days. Next weekday means the next
occurrence strictly after today. Calendar weeks start Monday; the bot states
explicit range boundaries. This/next month and week remain ranges rather than
being replaced with an arbitrary departure date. Round-trip ranges require an
explicit stay duration or return date. Missing origin and destination city are requested. Flexible-date comparisons default to one adult and one-way only when not previously specified; the acknowledgment states this basis. Explicit round trips still require return timing.

Flight clocks are read from the supplier's actual outbound/inbound jqGrid
columns. A different timing is selected through the ordinary flight radio
controls and its fare reference must match the requested selected flights
before inspecting ancillaries. Each round-trip pair is priced independently.
No price is copied from the default flight to other departure times.

Comparisons are bounded to forty-five minutes and eighty successfully priced
options per customer job. Week/month searches can therefore be partial. Any
failure or exhausted budget is explicitly disclosed; the bot never claims
to have found the minimum for the whole month if coverage is incomplete.
Every successfully priced date/timing is sent as a progress message. The final summary highlights three cheapest results already sent. Incomplete coverage is disclosed. Progress uses a sequential, lease-protected at-most-once endpoint. The adapter supports the pilot route and one adult only. One-way search clears the optional return field and verifies that the supplier search has no return date.
