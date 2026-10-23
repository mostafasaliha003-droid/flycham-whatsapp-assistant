# ClinePass primary understanding with Gemma fallback

The WhatsApp service can use ClinePass from its official external-app API. Default quality-first candidate: `cline-pass/qwen3.8-max`. Its Arabic travel quality must be measured with live account tests; neither this model nor this implementation is claimed to outperform a human consultant. The NLU handles context, aliases, relative dates, flexible periods, comparisons, corrections, offer selection and booking intent. Verified portal data, pricing, commissions and voucher rules remain in application code.

## Configuration

On **flycham-whatsapp-assistant** only, set these values in Render Environment:

- `CLINE_API_KEY`: user enters the key directly, never in chat/source control.
- `ASSISTANT_AI_PROVIDER=cline`
- `CLINE_MODEL=cline-pass/qwen3.8-max`
- `ASSISTANT_AI_FALLBACK=gemma`
- `GEMINI_API_KEY`: user enters a Google AI Studio key for fallback.
- `GEMINI_MODEL=gemma-4-26b-a4b-it`

Save, rebuild and deploy. If both keys are absent, the local conversation engine still works; AI is not active. A configured key is not evidence of a successful live inference. A Cline key takes automatic priority only when ASSISTANT_AI_PROVIDER is not explicitly set. Existing explicit OpenAI/Gemma selection is retained until changed.

## Quotas and failures

ClinePass has rolling five-hour, weekly and monthly limits. Five hours is not a session expiry, and no reset time is invented. On HTTP rejection, timeout, unavailable model, refusal, truncation or invalid JSON, attempt configured Gemma once. Use Retry-After when provided (bounded to 1 second–5 hours); otherwise use a local 5-minute retry cooldown for 429, 15 minutes for auth/credit/permission/model errors, 30 seconds for other failures. These are local retry policies, not provider reset claims. During cooldown route directly to Gemma. After cooldown allow one recovery probe; do not retry in a loop. Circuit state is per process and resets on restart. Multiple already in-flight normal requests cannot be recalled.

Only the exact allowlisted `cline-pass/...` model IDs are accepted. This chain never selects standard Cline usage-billing models or OpenAI. It does not buy credits, top up balances or rotate credentials. If Gemma also fails or lacks a key, use the local engine without inventing supplier facts. Maximum two provider attempts per message, each with a 15-second timeout. Google adapter is pinned to Gemma; no paid model substitution.

## Data and trust

Cline receives allowlisted trip facts, selected-offer metadata, up to 80 offer references/times/cheapest ranks, the last question, and up to eight redacted conversation turns. Model ranks refer only to shown verified offers. No raw supplier payload, booking record or customer profile is sent. Internal commission amounts are omitted. Gemma fallback omits conversation history and uses the same minimized trip context plus redacted current text. Credentials and passport-related text bypass external understanding. Redaction is heuristic and cannot guarantee detection of arbitrary personal information; identity documents must stay in the staff workflow. Unpaid Google data handling applies.

Model decisions cannot create tickets or change deterministic prices. Invalid decisions fall back to existing parsing. A selected verified offer supplies context for later amendments; a whole-range baggage change keeps all requested dates. Pending acknowledgements and duplicate messages do not launch another search. Booking intent queues staff follow-up and does not claim issuance.

## Validation

Run `npm test`. Automated mocked-provider tests verify the HTTP contract, both non-stream envelopes, invalid/truncated replies, strict model allowlist, failover, Retry-After cooldown, single recovery probe, date-preserving redaction, context preservation and no paid fallback. Live Cline/Gemma and WhatsApp tests remain required after key configuration. Safe operational logs: `ASSISTANT_AI_OK_CLINE`, `ASSISTANT_AI_OK_GEMMA`, sanitized failure categories. Health exposes configured primary/fallback only, not quota/availability claims.

Sources:
- https://docs.cline.bot/getting-started/clinepass
- https://docs.cline.bot/api/chat-completions
- https://docs.cline.bot/api/errors
- https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
- https://ai.google.dev/gemini-api/terms
