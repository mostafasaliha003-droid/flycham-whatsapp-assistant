# Fly Cham portal integration — observed workflow

## Scope and status

Inspected the signed-in agent portal on 21 October 2026 using the browser UI. Login and flight search worked. Selecting an economy fare and then an available fare-family button each produced the visible error `Invalid rights`. The Flight Summary total stayed at `0.0 AED`.

This is a blocker for a verified customer quote. The portal does not identify the missing right. Do not infer that search-card prices are a confirmed total, bypass the restriction, or continue to passenger, reservation, ticketing or payment steps.

No booking or ticket was created. No portal credentials, cookies, session IDs, account balance or personal account details are stored in this document.

## Entry and authentication

Use the stable entry path on `https://xhibe.ibsplc.aero/reservation/ibe/agent`. The portal redirects to its login form when required. Let the browser manage all session-specific URLs; never hardcode or persist a shared `jsessionid` or `execution` URL.

Observed login inputs:
- `input[name="agencyCode"]` / `#login-agency-code`
- `input[name="agencyId"]` / `#login-agency-id`
- `input[name="password"]` / `#login-password`
- Visible button: `Sign in`

Authentication was provided through the secure browser form. Those values are not available to the application. Before an application deployment, the operator must separately enter dedicated portal credentials directly into the hosting secret settings; do not put them in chat or source control.

## Observed search controls

- Trip type: `#owTripId` (One Way), `#rtTripId` (Round trip).
- Departure: visible chosen control `#aiRESOrigin0_chosen`.
- Arrival: visible chosen control `#aiRESDestination0_chosen`.
- Initial departure date: `#search-date-outward`; visible format `dd/mm/yyyy`.
- Initial return date: `#search-date-return`.
- Results-page departure date: `#trvDate_1`; return date: `#aiRESReturnDate`.
- Adults / children / infants: `#aiRESAdult_chosen`, `#aiRESChild_chosen`, `#aiRESInfant_chosen`.
- Initial currency: `#search_currency_chosen`; results-page currency: `#currency_cart_chosen`.
- Search button by visible accessible name: `Find flights`. Its ID changes from `proceed` to `changeFltBtn` after search.

**Important:** `#proceed` means `Next` on the results page. Never click it by ID alone. The adapter must stop on the search/results screen.

Observed supported departure labels include DUBAI [DXB], ABU DHABI [AUH] and SHARJAH [SHJ]. After choosing DUBAI, destination choices were ALEPPO [ALP] and DAMASCUS [DAM]. Resolve supported routes through the visible options instead of assuming that every listed airport pair is available.

## Example inspected (search only)

One-way DXB → DAM, 11 November 2026, one adult, no children/infants, AED. The results displayed flight XH728, departure 20:00, arrival 22:20, nonstop, duration 03h20m. These are observations for the test search, not future schedule guarantees.

The Economy card displayed two different monetary figures. Selecting the Economy radio expanded a fare-family table (FLY LIGHT / FLY SMART / FLY ELITE), with hand baggage, checked baggage, seat and fee rows.

Selecting the Economy radio produced `Invalid rights`. Selecting the enabled FLY SMART fare button produced the same error. A later user-requested retry repeated the search and selected the enabled FLY LIGHT 633 AED fare; it again returned `Invalid rights`, with the total still at zero. The summary total never became a valid nonzero total.

## Required quote safeguards

1. Search using only a validated itinerary and passenger counts.
2. Match the displayed route, dates, passengers and currency against the request.
3. Read fare-family-specific baggage and rules; do not combine conditions across fare families.
4. Treat permission errors, session expiry, an incomplete summary or a zero total as a failed quote.
5. Quote only a confirmed total with explicit currency and tax scope; do not use crossed-out, promotional or partial amounts as a final total.
6. Apply the agreed margin only after the fare is verified. No margin has been agreed yet.
7. Keep WhatsApp automatic sends in dry-run until a complete authorized test passes.
8. Do not access booking search, sales reports, profile changes, passenger entry, reservation, ticketing or payments.

## Remaining prerequisites

- Resolve the portal's `Invalid rights` error, or have Fly Cham identify why this agent cannot select a fare and obtain the total.
- Re-test selection and verify the final total, baggage and rules without advancing beyond the results page.
- Confirm margin policy (fixed amount or percentage, currency, per passenger or per request).
- Choose and authorize a hosted browser execution environment and secret-entry method.
- Implement a serialized search adapter, session-expiry handling and request deduplication; test one-way/return, no availability and error cases.
- Update the privacy notice to describe the portal data processing before enabling that integration for real users.

No hosted portal adapter, queue or live fare connection is deployed yet.
