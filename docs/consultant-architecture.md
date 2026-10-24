# Ahmed conversation orchestration

Release: 2026-10-25.consultant.2. Flight assistant only; unrelated hotel services are outside this release.

## Decision and execution

`CONSULTANT_ORCHESTRATOR_ENABLED=true` selects consultant-brain for default model interpretation. The existing direct Cline API and explicit-quota-only Gemma fallback remain the provider transport. Consultant calls use the allowlisted ClinePass GLM-5.3 Flash model by default, with CLINE_CONSULTANT_MODEL as an explicit override; the legacy CLINE_MODEL selection is unchanged. This separates the conversational latency budget from the prior slower extraction model. Prepared interpretation still overlaps the 35-second message collection window. The complete per-customer turn, including knowledge lookup, is serialized.

The model returns validated intent, changed trip fields, option reference and a bounded consultant action/next step. It can propose search, amendment, clarification, status, comparison, knowledge or staff handoff. The application authorizes execution; complete party/direction/date requirements, supported passenger scope, request versions and supplier isolation remain mandatory. Model answer/knowledge/status proposals cannot become searches merely because trip facts happen to be complete. Deterministic known followups retain their validated fast path. Consultant Cline requests share a bounded 35-second transport budget across an initial call and at most one same-provider JSON/schema repair; turn-specific format failures do not block unrelated customers. No malformed generation bypasses validation. legacy extraction retains 20 seconds, and startup smoke cases run serially to avoid competing generations. No low-reasoning mode is applied; the output budget and temperature are unchanged.

No shell, arbitrary URLs, booking, payment, ticket issuance or commission discounts are model tools. Supplier numbers/cards are rendered from vetted metadata and code-calculated prices; optional model prose cannot contain numeric prices, inventory assertions, visa eligibility, technical internals, false urgency or fictitious issuance claims.

## Memory and recommendations

Preferences, bounded objections, stage and explicit preference provenance live in each trip's encrypted state. Explicit customer text is required to write a preference. Model suggestions alone cannot override an airport restriction. Recommendations accept only recent verified one-adult offers with compatible dates, baggage and party; price differences use integer minor units and reveal changed departure airport/date/time. The requested route is preserved until customer choice.

Current verified portal passenger scope remains one adult without children/infants. This release does not manufacture group fares.

## Result delivery

Persistent delivery-outbox stores each comparison message chunk before transmission, records Meta acceptance before callback acknowledgement, and acknowledges only actually sent offer keys. New progress cannot hide offers that were not sent. Confirmed rate-limit rejections retry with bounded delay; ambiguous network outcomes are marked uncertain for review instead of blindly duplicating messages. Superseded comparisons are cancelled before another chunk. Delivered-message reference mappings survive callback replay.

Partial result delivery can advance as fresh offers arrive. One bounded waiting notice is sent when a search has run 90 seconds without a verified offer. Waiting messages distinguish recent progress from merely pending verification.

## Knowledge

Approved company flight policy is exposed through a typed policy tool. `searchKnowledge` is prepared for `BRAVE_SEARCH_API_KEY`, using a fixed provider endpoint and allowlisted official airline/government domains. Without that key it explicitly returns unavailable; no live web capability is claimed. Search snippets are untrusted reference material and never prove visa eligibility or airline inventory.

## Staff and measurement

The protected operations page refreshes status/metrics every 15 seconds while visible. Metrics record qualification, search, first accepted verified offer, selection, handoff, staff claim and confirmed issuance. Only an authenticated staff request with ticketConfirmed=true on an already claimed handoff records issued status; that action does not issue a ticket. Counts do not label interest as a completed sale. Customer/journey identifiers are hashed in metrics.

## Release verification

The full suite passed both default and feature-enabled configurations. Signed synthetic WhatsApp-to-Cline-to-queue tests cover missing passenger count, supplier routing, consistent trip details and verified-card delivery. Outbox tests cover rate rejection, interrupted delivery, callbacks, supersession and restart. A four-case startup Cline smoke sends synthetic data only and exposes boolean greeting/search/context results in health; it uses one realistic future date fixed at startup and checks full trip extraction, a baggage amendment and a one-adult followup without a repeated trip-type question. It makes no portal search or customer send.

## Operations

Only the web service requires this deployment. Portal workers need no restart. Enable by merging the nonsecret feature flag; never replace unrelated Render env vars or copy credential values into source. To disable AI-led conversation selection, set CONSULTANT_ORCHESTRATOR_ENABLED=false and deploy; the legacy interpreter remains available while delivery reliability stays installed. External knowledge remains unavailable until its own provider key is deliberately configured.

## Separate portal recovery fix

The Air Arabia adapter can reacquire a reused trusted named login window or trusted child frame when the supplier emits no new popup event. The login target origin and route are rechecked before credential operations; ambiguous targets and security challenges remain blocked. Ordinary typed navigation/network failures preserve their classification for the existing bounded session retry, while verification failures are never retried automatically. This worker code needs its own deployment to the separate background-worker service; the web deployment cannot revive a previously parked worker.
