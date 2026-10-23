# Ahmed release 2026-10-23.1 — exact implementation status

This release changes only flycham-whatsapp-assistant and its independent Air Arabia worker. It does not change any hotel system.

## Implemented and test-covered

- Virtual identity Ahmed; count is always requested, never defaulted to one.
- Syrian city aliases, relative Dubai dates, weekly/monthly ranges, return stay duration.
- Per-recipient message burst aggregation (4 seconds) and serialized handling.
- Waiting/status, thanks, greeting, final-price negotiation, goodbye/pause, cancellation and data deletion.
- Separate hypothetical baggage comparison and confirmed amendment; bounded previous versions and undo.
- Quoted-offer reference, numeric offer selection, staff booking-intent queue, claim/release ownership.
- Canonical trip state, bounded history, optional AES-GCM snapshots (requires a genuinely persistent mount).
- Optional OpenAI Responses structured extraction, strict local schema and capability validation, finite timeout, refusal/incomplete handling. No model-generated pricing or supplier facts.
- Stale job leases cannot send after replacement/cancellation; per-flight current-lease checks.
- Read-only availability discovery before ancillary pricing, every selectable pair attempted independently even if another fails.
- Per-date confirmed/partial/no-flight/unverified coverage, finite 45-minute/80-result bounds, finite read retry for timeout/network/frame changes, break after repeated discovery failures.
- Supplier-confirmed inactive seat selection/meal services explicitly disclosed, never called free. Unknown loading states still block a price.
- Displayed supplier total plus unselected verified service costs, ticket margin AED25, requested higher baggage AED10 once per itinerary even if supplier upgrade is free. Existing nonzero ancillary subtotal blocks possible double counting.
- Branded offers show airports, airline, dates, flight numbers, raw supplier departure/arrival strings, checked weight, total and scope limitations. All priced options included, references remain stable.
- Separate admin key for protected status and staff handoff data; operations page with no browser credential persistence; no booking/payment/ticket execution.
- Safe numeric Meta diagnostics; delivery statuses recorded without logging recipient/message contents.

## Runtime configuration dependencies — do not claim these are active without verification

1. OPENAI_API_KEY: needed for general model-based language understanding. Model configurable with OPENAI_MODEL; compatible baseline gpt-4o-mini. Without key, deterministic handling remains available; it is NOT equivalent to an active AI model.
2. ASSISTANT_STATE_PATH on a verified persistent mount and ASSISTANT_STATE_KEY (or existing app signing secret): needed for encrypted restart/redeploy persistence. Memory is the default. A file path alone is NOT proof of durable Render storage. The current free web plan has no attached persistent disk. No paid resource was provisioned by this release.
3. ASSISTANT_ADMIN_KEY (at least 32 characters): required to use /operations and staff ownership endpoints.
4. HUMAN_HANDOFF_RECIPIENT: optional explicitly configured staff WhatsApp recipient. Without it, requests remain pending internally; no claim that an employee has received them. /operations can be used after admin configuration.
5. Supplier OTP may be required after worker deployment; never bypass it. Render live alone does not prove portal authentication.

## Explicitly incomplete / bounded scope

- Actual supplier quote reader still supports one adult, no children/infants, SHJ↔DAM, Air Arabia. Other requests are understood/retained but blocked from speculative pricing. Do not multiply adult fares for groups. Multi-passenger synthetic portal forms and capacity verification need separate implementation and live validation.
- Fly Cham is not connected; user will provide portal integration details later.
- Audio/image interpretation is not implemented; intake is text only. Never claim multimodal understanding.
- Exact seats, baggage piece constraints, total-vs-per-person baggage ambiguities, excluded days and latest-arrival constraints are not supplier-verified by this reader; they must not silently produce a supposedly matching fare.
- No inferred connection durations, local zones, hand baggage, cancellation/refund terms or fare-family inclusions if supplier evidence is absent. Raw supplier clocks are shown as such.
- No automatic booking, holds, payment links, charges or ticket issuance. Booking completion remains with a human.
- No promise of 24/7 availability or complete monthly coverage; queue is bounded and in memory. No durable queue or transactional delivery outbox is active in this release.
- Privacy retention defaults to 30 days for stored customer state. Encryption does not replace access controls or durable storage configuration.
- Staff-facing operational UI is functional only after its admin key is configured. It is not an authenticated multi-user CRM with individual employee accounts.
- NLU/schema tests use mocks; live OpenAI billing, connectivity and model quality need a configured key and controlled end-to-end tests.

## Deployment sequence

Deploy web first (worker metadata is backward-compatible), verify live health/runtime flags without secrets, then deploy worker. Verify authentication and protected-page refresh. Execute a WhatsApp conversation test only after configuration. Run npm test before publishing. Never mark external dependencies or the complete planning backlog as finished just because unit tests pass.

## Required end-to-end acceptance script

Greeting → route/week request without count → ask count → one adult → start quote → waiting does not enqueue duplicate → weight amendment → stale result suppressed → hypothetical lower-weight comparison preserves original → quoted offer selection → booking intent → staff queue/notification (if configured) → staff claim silences bot → staff release resumes. Separately test missing map versus confirmed inactive service, paid and free weight upgrades, partial coverage, failed Meta sending, queue cancellation and restart behavior.


## Conversation extraction fix (2026-10-23)

Structured model fields now update the existing request directly after local parsing. The original message remains available to the local relative-date parser; partially extracted fields no longer replace the whole message. Baggage changes preserve route, dates and party, and ages can update an existing party without repeating the count question. Greeting classifications with travel fields do not discard the request. Both user and assistant turns are retained in bounded conversation context. Missing fields still require clarification; unsupported supplier capabilities remain blocked.

NLU diagnostics report success intent or safe HTTP/error codes only, without message text, keys or provider error messages. Configuration presence is not proof of a successful live model request. No reasoning-effort override, budget cap, or change to the portal worker is included in this fix.
