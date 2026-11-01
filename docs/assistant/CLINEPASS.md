# ClinePass understanding and document reading

Production uses `cline-pass/qwen3.8-max` for conversation understanding and document reading. Cline receives text understanding requests through the existing minimized/redacted conversation contract. Document requests contain one validated source image and a fixed extraction instruction, without customer conversation, captions or caller prompts.

## Production configuration

On the existing `flycham-whatsapp-assistant` service:

- `CLINE_API_KEY`: existing private key, never printed or committed.
- `ASSISTANT_AI_PROVIDER=cline`
- `CLINE_MODEL=cline-pass/qwen3.8-max`
- `ASSISTANT_AI_FALLBACK=none`
- `RAAD_DOCUMENT_OCR_ENABLED=true`
- `RAAD_DOCUMENT_OCR_MODEL=cline-pass/qwen3.8-max`
- `RAAD_DOCUMENT_OCR_DAILY_LIMIT=20`
- `RAAD_DOCUMENT_OCR_SMOKE_ENABLED=true`

There is no Gemini transport or provider fallback in document reading. The legacy optional Gemma understanding adapter remains in source for backwards compatibility but is disabled by this production configuration. An unavailable provider cannot produce invented supplier facts or silently change providers.

## Images and document trust

The full-page and focused document readers use the fixed `https://api.cline.bot/api/v1/chat/completions` endpoint with inline `image_url` data. The bounded strict extraction schema, ownership guards, document matching, checksum checks, local optical MRZ verification and image preparation remain active. PDF rasterization and passport/ID merging run locally.

Cline refusals, tool calls, multiple choices, incomplete output and malformed JSON cannot become document facts. A 20-request Dubai-day budget is durable across restarts and includes failed requests. This limits calls, not a monetary amount. Validated v17 evidence and terminal failures are retained; rollout does not replay completed customer requests. An explicit bounded reread can use Cline.

Names or dates that are absent or ambiguous stay unknown. Machine consistency is not identity authentication, staff review, applicant consent or official approval. Legal/health answers require applicant confirmation. No model can issue tickets, alter deterministic prices, pay government fees or assert that a visa has been issued.

## Verification

Run `npm test` for the isolated suite. The explicitly enabled startup check runs one fixed synthetic probe per extraction policy, persisting intent before dispatch to prevent replay after restart. Its log contains aggregate results only. Run `node scripts/check-cline-document-reader.js` manually inside the deployed service for one real, fixed synthetic extraction check using the running server's durable budget. It prints only aggregate results and finite diagnostics, never keys or customer fields. A simple image-code success does not establish production passport accuracy; the strict synthetic extraction probe and actual-file review remain separate checks.

References:
- https://docs.cline.bot/getting-started/clinepass
- https://docs.cline.bot/api/chat-completions
- https://docs.cline.bot/api/models
