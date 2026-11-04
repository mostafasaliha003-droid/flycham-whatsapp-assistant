# Masterstroke CX packages 16–20

Built from `main`, independently of the unmerged packages 12–15 branch.

## Customer profiles

`customerProfiles` lives in the existing encrypted assistant state. It retains only canonical route, trip type, explicit airline preference, baggage weight, adult count, nationality, document type/issuer, applicant count and transport. It never copies document numbers, names, media, travel dates, quotes or payment evidence into a returning journey.

Flight preferences are recorded after a supported, complete non-hypothetical intake; visa preferences after a quoted case. Each service expires independently after 180 days, with at most 2,000 profiles. Both customer deletion paths remove the profile. A returning greeting recalls prior context only for a fresh inquiry; it does not automatically restore old facts, open a paid case or reuse dates.

## Bilingual intake and service switches

English/IATA routes, passenger phrases, baggage and explicit airline restrictions fill missing local fields. English visa intake distinguishes nationality from document issuer and excludes bank statements from payment-method declarations. Negated clauses do not become affirmative local facts, and child/infant requests retain the existing pricing and age checks.

The existing service router decides transitions. A banner names Ahmed or Ismail and describes saved context only when it exists. Neither engine deletes the other service's request; operator ownership, message revisions and financial guards still take precedence.

## Readiness advice

Strict calendar parsing accepts ISO and day/month/year dates, including Arabic digits. Explicit document-expiry dates produce day counts relative to the saved departure date, or today's date in Dubai when departure is unknown. Conflicting dates and dates labelled as travel or issuance are not treated as expiry.

The 180-day passport and 90-day residence thresholds are preliminary checks, not calendar-month equivalences or approval guarantees. Advice does not change the itinerary, document facts or payment evidence. Offer selection warns when the displayed outbound and return airports differ.

## Analytics contract

The protected `GET /internal/assistant/status` response includes `cxAnalytics`; unauthorized access remains rejected and the response is not cacheable. Storage is capped at 1,500 events and 30 days; the default summary covers 168 hours.

Events contain enumerated service, category, reason, language, sentiment and timestamp only. Raw messages, customer identifiers and arbitrary reason strings are rejected. Counts describe events, not unique people. `selfServiceRate` is resolved events divided by resolved plus escalated events. Answered advice/quote turns count as resolved; greetings, intake questions and pending searches do not. Resolution never means payment confirmation, ticket issuance or visa approval. Complaint escalation is recorded once when its acknowledgement is accepted.

Voice categories are supported by the analytics API but are not emitted by the acknowledgement-only voice path on this branch. No speech provider or new external service is enabled by this change.

## Verification

Run the isolated, credential-free test runner:

```sh
node scripts/run-tests.cjs test/masterstroke-cx-summit.test.js test/assistant-engine.test.js test/saudi-visa-engine.test.js test/travel-language.test.js test/travel-followups.test.js test/customer-ux-second.test.js
node scripts/run-tests.cjs test/masterstroke-cx-summit-webhook.test.js
node scripts/run-tests.cjs
```

The signed webhook fixture mocks Graph delivery and verifies both transition directions, unchanged paid-case evidence, validity advice, admin-only analytics and no actual external messages.
