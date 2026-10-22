# Air Arabia assistant operations

## Verified live state — 22 October 2026

Independent service: airarabia-portal-keepalive, srv-dbcjdhfb9u1s73bsm1s0, workspace tea-da8acfugekts73clvm7g. Repository mostafasaliha003-droid/flycham-whatsapp-assistant, branch codex/airarabia-fixed-margin, auto-deploy off. Do not modify the hotel services or repository. The existing worker uses the approved USD 25/month plan; no additional paid resources are authorized.

Live runtime evidence (UTC / Dubai UTC+4):
- Operator verification submitted: 00:01:38 / 04:01:38.
- Authentication confirmed: 00:02:02 / 04:02:02.
- Protected-page refresh completed: 00:02:15 / 04:02:15.
- The next deployment also completed verification at 00:10:15 / 04:10:15, refreshed at 00:10:24 / 04:10:24, and confirmed the makeReservation.action search form at 00:10:29 / 04:10:29.
- The OTP route was replaced by showMain. This is stronger evidence than the earlier partial-session sign-out events.

The fully verified 00:31:48 UTC session completed idle refreshes at 00:47:38 UTC and then approximately every sixteen minutes through at least 06:39:39 UTC on 22 October 2026. The filtered app log read showed 23 later refresh events and no session-unavailable, blocked or new-verification event in that range. This establishes more than six hours of observed session retention, not an unlimited uptime guarantee. The implemented heartbeat refreshes a protected page. It is not a flight search. Host uptime alone is never proof of supplier session availability.

## Current search probe change

Inspection now confirmed the actual same-origin makeReservation.action frame and the search controls. Adult/child/infant counts are text inputs, not select menus. The earlier literal iframe selector and selectOption calls for counts were incorrect and have been removed.

Inspection mode now performs one bounded synthetic SHJ-DAM adult one-way search, 30-90 days ahead. It requires an unambiguous One Way control, actual supplier autocomplete selection with matching hidden airport codes, confirmed AED/economy/G9/normal supplier options, and final input checks before clicking the observed input#btnSearch button. Unknown controls/options stop before Search. No hidden airport values or provider enum values are manufactured. Repeated radio IDs require the option's own adjacent/parent label, not a duplicated label-for association.

The probe stops before any result selection, Book, passenger, hold, payment or ticket action. It logs only fixed classifications plus non-sensitive control metadata. A visible result booking control is evidence of a results page only; it is never clicked and is not an ancillary-inclusive customer price. Probe failure does not automatically retry or deliberately close the verified session; normal protected-page keepalive can continue. An authentication failure still stops for operator review.

A successful flight search, actual fare amounts, ancillaries and WhatsApp quote delivery still require live verification. The first live probe authenticated at 00:19:28 UTC, refreshed at 00:19:38, then stopped before Search at 00:19:44 because the one-way label was unconfirmed. No fare was returned. Live enum inspection also confirmed Search G9 uses value AA; NORMAL uses NORMAL and Economy Class uses Y. The label parser now reads adjacent visible DOM text, handles hyphens and duplicate IDs, and the G9 matcher accepts the observed space. The second probe also stopped at the one-way label (00:26:16 UTC). No search has been submitted. A further correction preserves the supplier's existing selected R mode only when the return-date field is confirmed visible and editable, enters a seven-day return date, and runs a synthetic return search without guessing or changing an unconfirmed trip enum. The default-return path is covered by a year-boundary test. The default-return path reached the origin-airport step at 00:32:08 UTC but timed out awaiting the assumed jQuery menu at 00:32:23 UTC. It did not click Search. The new airport selector types normal key events, tries the IATA code then city name in bounded attempts, reads unique visible airport suggestions without relying on a particular widget CSS class, groups split city/code spans inside one semantic option, and verifies the hidden supplier-selected airport code. It never writes hidden airport values. Ambiguous, unrelated, hidden and foreign suggestions stop without a click. The 06:57:01 UTC live probe found a visible airport candidate, but its synthetic DOM click did not establish the supplier-selected code by 06:57:06. Search was not submitted. The selector now returns the actual verified DOM element and uses a complete Playwright pointer click (including mouse-down/up), disposes the element handle, and rechecks the supplier code. Empty, other-airport and other-format code failures are logged only as fixed classifications, never raw values. The pointer-click correction passes 70 local tests; live flight search and fares remain pending. Idle keepalive remains a protected-page refresh, distinct from the one-time search probe. Session work is serialized.

## Verification and recovery

The supplier opens a named login popup. Start from the user-supplied protected portal route and follow only the supplier's own expected-origin login popup. Never manufacture a raw login POST or hidden security tokens.

A same-origin OTP frame blocks authentication even if a header already displays Sign Out. The worker waits at most ten minutes for one operator-provided code. Locator ambiguity was observed; the guarded native-form fallback validates the supplier origin, unique observed controls, visible enabled form and matching submit button, then uses normal input/change/click events. It does not bypass OTP or form validation, resend a code, or fetch one from email.

While PORTAL_VERIFICATION_WAITING_FOR_OPERATOR is present, enter the latest code in the same worker's Render Shell:

```bash
bash -c 'read -rs -p "OTP: " AA_CODE && AA_FILE=$(mktemp /tmp/aa-otp.XXXXXX) && printf "%s" "$AA_CODE" > "$AA_FILE" && mv "$AA_FILE" /tmp/airarabia-verification-code; unset AA_CODE AA_FILE'
```

The private file must be newer than the challenge, is consumed once and deleted. Do not store codes in source, logs or Render variables. Rejected verification, expiry or failed startup parks the process without repeated login attempts. Host restarts/deployments can require a new device verification; unattended recovery is not established. Credentials remain only in existing Render secrets.

## Agreed customer policy

Default requests: inspect the whole seat map and all available meal/baggage options. Choose an eligible free seat first, otherwise the cheapest available paid seat. Choose real free food first, otherwise the cheapest available meal; a no-food option is not a free meal. Confirm the checked and cabin baggage allowance; default to the cheapest weight option or provide separately rechecked weight quotes. Do not ask for a special seat unless the customer requests one. Honor an exact requested number or feature, without silently substituting a different preference.

Ticket margin: AED 25 per passenger, once for the whole itinerary. Default paid seat: supplier cost + AED 10. Explicit customer seat request: supplier seat cost + AED 10, including a zero-cost requested seat. Paid meal with no free food available: supplier cost + AED 5. Default free services receive no extra service margin. Baggage has no newly authorized markup. Costs already in the supplier total must not be counted twice.

A final quote requires complete options and actual availability for every passenger/segment, selected services, verified baggage weights, a fresh final portal review, and reconciliation of every supplier charge. Different weight alternatives must be rechecked individually before their total is represented as final. Test passengers cannot establish the real customer's age/residency/eligibility-dependent fare.

## Remaining implementation

The WhatsApp web service currently collects itinerary details only. It has no verified live fare adapter or durable quote queue. The pricing and ancillary selection modules implement the agreed rules, but cannot issue a final quote until live catalogs and final supplier totals are checked. Do not represent a submitted test passenger as a verified fare for a real customer. No real booking, hold, ticket or payment is authorized.

## Seat tooltip inspection

This current synthetic probe supersedes the earlier result-only stopping point
in the historical notes above. The user-authorized result-page Make Reservation
step opens passenger details; the synthetic TEST QUOTE passenger continues only
to ancillary availability, with profile saving disabled. The new hover inspection
runs there and never proceeds to ancillary confirmation or payment.

The synthetic startup probe now opens the supplier's seat tab (`imgTab_2`),
visits every available segment, and uses Playwright pointer hover on each
vacant seat in the selected cabin. It reads `spnTTSeatNo` and `spnTTSeatChg`
only after confirming the tooltip belongs to that seat. It never clicks a
seat, the ancillary Continue button, payment or booking confirmation.

`PORTAL_SEAT_SCAN_SEGMENT_` reports counts, free seats and the cheapest ordinary
seat only for a complete scan. Missing hover targets or unknown prices make
the scan incomplete; absence of a seat map does not mean a free seat exists.
Conditional seats are counted separately. No passenger values, session URLs,
cookies or raw page text are logged. The bounded scan permits only the reviewed
`seatMap.action` and `anciFlexi.action` catalog requests plus supplier static
assets, then removes its request
guard before normal keepalive resumes.

`PORTAL_SEAT_SCAN_COMPLETED` verifies this seat scan only. Meals, baggage and the
supplier's complete itinerary total still need verification before a customer
price can be issued. Tests use a DOM contract fixture; live supplier behavior
must be verified separately after authentication.


## Meal and baggage catalog reader

After the seat scan, the synthetic probe opens only the meal and baggage tabs
and their segment navigation controls. Reviewed read endpoints are anciMeal.action
and anciBaggage.action, in addition to seatMap.action and anciFlexi.action.
It matches supplier catalog names to displayed jqGrid charge cells, checks
stock where returned, and fails completeness on unknown prices or inventory.
No-meal and beverage options are not treated as free food; uncertain food names
remain unconfirmed. Checked weights are parsed only when unambiguous; hand baggage
is not inferred. Shared baggage groups record covered segment indexes once.
Empty passenger-restriction arrays no longer classify ordinary seats as conditional;
the seat result still applies only to the synthetic adult passenger.

The reader records the visible ancillary-stage total separately. This is not
an all-charges-checked final price. It never selects/applies a meal or baggage,
clicks ancillary Continue, blocks seats, confirms a reservation, pays or issues
a ticket. Customer quotation and WhatsApp live fare delivery remain unverified.
