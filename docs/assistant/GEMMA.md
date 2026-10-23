# Gemma conversation understanding

The independent WhatsApp web service supports Google Gemini API's `gemma-4-26b-a4b-it`. No SDK dependency is required. The model extracts structured intent and trip amendments; the existing engine retains pricing, supplier verification, commissions, voucher rules and booking handoff control.

## Activate in Render

Add `GEMINI_API_KEY` directly in the web service's Environment page, never in chat or source control. Set `ASSISTANT_AI_PROVIDER=gemma` and optionally `GEMINI_MODEL=gemma-4-26b-a4b-it`. Save and deploy. Only this exact Google model is accepted by the adapter. Never change the hotel services or portal worker for this integration.

Without an explicit provider, a Google key takes precedence; otherwise the existing OpenAI setup stays active. An explicitly selected Gemma provider never falls back to OpenAI. Missing keys, timeout, quota limits, blocked responses and invalid JSON use the local conversation engine. Each attempted understanding request has a 15-second timeout, no retry loop, and minimal thinking. Health reports configuration only, not connectivity or conversation quality.

Only allowlisted trip fields, the last question, current status and the redacted current message are sent. Raw history, selected-offer payloads and customer profiles are omitted. Credential/document messages bypass the external model. Regex redaction is not a guarantee of detecting all personal information in free text. Do not send passports or booking records to the free tier. Google free-tier data handling and project quotas apply; free is not unlimited availability.

## Verification

Automated tests cover endpoint/auth format, strict decision validation, thinking-part exclusion, incomplete responses, quota failure and no paid fallback. These use mocked responses, not a live Google account. After setting the key, verify `aiProvider=gemma`, then test a real conversation: route, flexible dates, passenger count, and a later 30kg amendment. Confirm a successful `ASSISTANT_NLU_OK_*` event without printing customer content. Model quality must be assessed separately from portal fare accuracy.

Official references:
- https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits
