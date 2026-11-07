# Air Arabia agent portal — observed search workflow

Inspected on 21 October 2026 for the independent WhatsApp flight assistant. A signed-in search succeeded and displayed a nonzero, itemized fare quote. This proves the search workflow in the current interactive browser session; no hosted adapter or automatic WhatsApp fare response has been implemented or deployed.

## Entry, authentication and frames

- Entry: https://agents.airarabia.com/xbe/
- Signed-in page: https://agents.airarabia.com/xbe/private/showXBEMain.action
- Login popup observed: https://agents.airarabia.com/xbe/public/showLogin.action
- Visible login inputs: input[name="username_txt"] (text) and input[name="j_password"] (password); submit #btnLogin.
- Initial secure-form attempts and page loading were unreliable. The operator completed login manually. Later explicit navigation to the signed-in page restored browser control and the page showed Sign Out and Welcome to Air Arabia.
- Top menu frame: iframe[src="showTop"]. Click its exact visible text Make Reservation to open the search screen.
- Search/results frame: iframe#mainFrame, name main. The rendered frame path became private/makeReservation.action?mc=false.

No login values, cookies, session identifiers, account identity or credit balance are recorded. The application does not have the browser-entered credentials.

## Observed search controls

All search controls below are within iframe#mainFrame.

| Purpose | Observed control |
| --- | --- |
| Origin | #fAirport, editable airport chooser |
| Destination | #tAirport, editable airport chooser |
| Departure | #departureDate, dd/mm/yyyy |
| Return | #returnDate, empty for inspected one-way search |
| Adults / children / infants | #adultCount / #childCount / #infantCount |
| Date flexibility | #departureVariance / #returnVariance |
| Cabin | #classOfService |
| Currency | #selectedCurrency |
| Carrier scope | #selSearchOptions, Search G9 selected |
| Booking type | #bookingType, NORMAL selected |
| Search only | #btnSearch, visible button Search |

The default search type was One way/ Return, with an empty return date. Several radio inputs share id searchType; do not select them by that ID alone.

Filling an airport code did not by itself commit the chooser selection. Pressing ArrowDown opened its visible airport list, and clicking the exact label selected the airport. Verified labels: SHJ - Sharjah and DAM - Damascus. The airport list also contained ALP - Aleppo and LTK - Latakia; their presence alone does not prove route availability.

## Search-only example

- One-way SHJ → DAM, departure 11 November 2026.
- One adult, zero children, zero infants, Economy Class, AED, Search G9.
- Returned available rows:
  - G9433, departure 08:30, arrival 11:05.
  - G9375, departure 10:25, arrival 13:00.
  - G9363, departure 20:15, arrival 22:50.
- The first row G9433 was selected automatically and quoted under the Value fare bundle.
- Its fare-bundle cell displayed a rounded AED 695; the itemized quote displayed the exact total below.

| Quote component | AED |
| --- | ---: |
| Fare | 435.00 |
| Tax | 135.01 |
| Surcharge | 125.00 |
| Handling charge | 0.00 |
| Total for one adult | 695.01 |

The displayed components reconcile: 435.00 + 135.01 + 125.00 + 0.00 = 695.01. No agent margin was added. These are observations of one search, not a future price guarantee or a quote for the other two flights. Baggage allowance and fare conditions have not been inspected.

## Safe stopping boundary

The top-menu Make Reservation opens search. The results-page button with the same visible name, #btnBook, advances into booking and MUST NOT be clicked by a quote-only adapter. Do not open Passengers, Ancillary, Payments or Itinerary. No passenger data, booking, ticket or payment was created during this inspection.

Read the visible selected flight, date, passenger counts, fare bundle, currency and exact itemized total together. Do not quote the rounded fare-bundle amount or carry over a previous quote while another flight is loading. Treat login expiry, missing quote, zero total and UI errors as failed quotes. Do not invent baggage or refund terms.

## Work remaining

- Verify baggage and conditions for each quoted bundle, and test other flight selection and return-trip search.
- Define the margin policy (fixed or percentage; per passenger or per request).
- Choose the hosted browser execution environment and an approved secret-entry method.
- Implement serialized searches, session expiry, deduplication and failure handling; the interactive ChatGPT browser session is not a persistent production integration.
- Update the privacy notice before real portal processing is enabled.
- Keep DRY_RUN=true until the full authorized integration test passes.

The existing FlyCham Invalid rights blocker remains unresolved. Air Arabia can be developed as a separate source; its successful quote does not resolve FlyCham permissions.
