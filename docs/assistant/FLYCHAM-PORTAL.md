# FlyCham portal pilot

This is independent of the hotel system. The existing worker allocation runs two isolated browser sessions via combined-worker.js; it does not share airline cookies or apply Air Arabia ancillary scans to FlyCham.

Configuration: enter FLYCHAM_AGENT_USERNAME and FLYCHAM_AGENT_PASSWORD directly in the airarabia-portal-keepalive worker Environment page. The FlyCham adapter reads them from that worker process only. Do not send credentials through the quote queue, an HTTP configuration endpoint, or model context. The WhatsApp web service does not supply supplier credentials to workers. Credentials entered earlier in the web service are not sufficient to authenticate the worker. No secret-distribution endpoint is included.

The worker requires FLYCHAM_PORTAL_ENABLED=true to activate this pilot; the same web flag advertises the supplier capability. No new paid service or compute-plan change is required. Default remains disabled. Authentication is attempted once; unknown forms, verification challenges and rejected login stop without automated retries. A successful login emits FLYCHAM_PORTAL_AUTHENTICATED; only then does the FlyCham consumer poll and advertise readiness. Cloud Browser login is not evidence of server authentication.

Explicit customer references to FlyCham preserve request.provider=flycham. Default requests continue using Air Arabia. Consumers can claim only their own supplier's jobs; an unavailable FlyCham worker cannot silently substitute Air Arabia. This does not yet compare both airlines in a single request.

Scope: one adult, SHJ↔DAM, one way or round trip, individual dates or a range up to 32 days. No passenger entry, seats, meals, ticketing, payments or holds. FlyCham reads the selected first-page itinerary and the explicitly displayed final AED equivalent; no local currency conversion. Primary display may be USD if AED is not a search option, but a quote is rejected without a verified AED total. Route, departure date and return itinerary must match the request. Customer-specific baggage requests stop pending verified allowances; do not infer weight from general knowledge.

Pricing: displayed AED total +40 AED one way / +90 AED return. Future gift 10 /25 AED, one calendar year, issued only after confirmed ticket, usable later across REMAL services. No seat or meal margin. The current pilot verifies only the selected first-page timing per searched date; mark coverage partial and never claim cheapest across all timings. Full timing enumeration remains to be validated against the live portal.

Tests cover supplier isolation/readiness, local credential isolation, request-date matching, exact pricing, gift wording and disabled runtime. Live authentication and an actual search are required before reporting the integration connected. Worker readiness in public health indicates an authenticated consumer heartbeat, not proof that a fare was returned.
