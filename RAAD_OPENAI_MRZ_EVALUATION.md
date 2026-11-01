# Guarded MRZ reader evaluation — not activated

The local optical reader rejected three clear synthetic MRZ fixtures. A bounded
OpenAI Responses evaluation using `gpt-6-astra` read those three fixtures exactly
and preserved invalid printed data in five negative controls. Strict application
parsers rejected all five controls. This is evidence for this small synthetic
set, not a measurement of real passport or identity-document accuracy.

The candidate adds a dormant narrow reader, an explicit evaluation budget, and
a provider-neutral intake seam for isolated dependency-injected tests. The
production server still constructs `createOpticalMrz()`. No production provider
selection, environment change, key creation, backfill, policy migration or
automatic local-to-remote fallback is included.

## Evidence and limits

- Eight actual generation calls and eight token-count requests completed with
  HTTP 200. Three positive fixtures matched every literal MRZ character; five
  controls were safely rejected. The negative controls include an actual printed
  issuer digit `0`, a wrong checksum digit, missing glyphs and a genuinely
  unreadable image.
- Generation latency was 2.034–9.404 seconds, median 7.022 seconds. The serial
  evaluation including token preflights took 57.987 seconds.
- Provider usage was 8,839 input and 1,907 output tokens. At the verified standard
  uncached rates of $10/$50 per million tokens, the generation estimate was
  $0.18374. Token-count endpoint fees were not assumed to be free; the probe
  reserved another $0.12599 for them. These are estimates, not an invoice.
- The request prompt deliberately says "synthetic image" to preserve an exact
  binding to the evaluated request. The module identifies itself as evaluation
  only. A generalized production prompt requires its own evaluation and policy
  fingerprint.
- This MRZ evaluation does not validate whole-page classification, visible
  fields, date interpretation, portraits, document reconciliation, customer
  messages, government submission, payment or the complete WhatsApp flow.

The original native acceptance negative was incorrectly generated with chained
Sharp resizes and was pixel-identical to the clear positive. Its old rejection
does not prove poor-quality-image handling. A corrected, materialized low
resolution fixture was tested separately. The unchanged local optical reader
still scores 5/8 on that corrected native acceptance set. Historical logs are
preserved; this candidate does not conceal or relabel those failures.

## Narrow reader contract

`src/visa-mrz-openai.js` is disabled by default. Constructing it does not send
requests. Even an explicit `RAAD_MRZ_OPENAI_ENABLED=true` cannot make it ready
without the existing OpenAI key and an injected compatible durable budget.
There is no server configuration that activates this reader in this candidate.
Do not add secrets to source, logs, fixtures or chat.

The reader accepts an upright page and applies the existing format-specific
crop once: 5% side margins, lower 30% for TD3 or lower two thirds for TD1,
grayscale PNG, no resize or text repair. TD1 support is explicit and never
pretends that a remote reader is local. Requests use the fixed official
endpoint, `store:false`, no tools, no history and no automatic retries.
`store:false` is not a promise of zero provider retention.

Every read requires a caller-bound attempt key and a stale-state guard. The
intake checkpoint binds the new reader to the case, source, page, input policy
and reader fingerprint. Existing local migration/recovery behavior is retained;
injection of the experimental reader must not start remote reads for historical
jobs. A timeout keeps the process-wide lease while underlying work or budget
settlement remains unresolved.

## Evaluation budget

`src/visa-mrz-budget.js` requires an explicit compatible store declaration:
version 1, durable, synchronous, atomic. It does not infer these properties from
the presence of a `save()` function and does not alter state when constructed.
The adapter reserves and commits up to $0.12 before the first upstream request;
the lifetime evaluation allowance is $1. Reservations are never refunded or
reset automatically, including after uncertain outcomes. Reusing an attempt
does not create another billable read. Settlement must commit before a result
is accepted.

Limits include one active reader lease per process, a 45-second total deadline,
3,000 effective input tokens including schema allowance, 1,024 output tokens,
bounded image/response sizes and strict existing TD3/TD1 checks. The budget
ledger stores opaque bindings, token usage and estimates, not documents,
customer fields, response text, secrets or OTPs.

The store contract is a caller attestation. Unit tests and recorded-response
replays do not prove Render disk persistence, multi-process database atomicity,
rollback-tamper protection or a production billing cap. Those are deployment
gates, not properties implied by a passing unit test.

## Before activation

Keep the existing services and server provider unchanged until the clean build
and container gates, required security scan, isolated complete integration,
independent held-out document evaluation, privacy review, durable store wiring
and rollback/quiescence plan have passed. The state policy transition must be
reviewed explicitly: a global document-policy change can retire historical
state during construction. Never enable this reader by merely substituting a
URL, claiming `local:true`, or changing an existing global fingerprint.

Official API references used for the evaluation:

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/token-counting
