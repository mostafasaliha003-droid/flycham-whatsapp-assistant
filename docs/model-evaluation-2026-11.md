# Cline understanding evaluation — November 2026

Status: **blocked_missing_runtime_credentials**.

Policy: `730d1bbdf0d55d752755481cb726f03b06e09ac8c00fc0040714972f2afd6a97`. Synthetic cases: 20; required repetitions: 3 per model.

No customer data, credentials or model response text are included. No production model settings were changed.

| Model | Runs | Average | Minimum | Valid cases | p50 ms | p95 ms | Qualified |
|---|---:|---:|---:|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/deepseek-v4.1-flash | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/deepseek-v4-pro | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/glm-5.3-flash | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/glm-5.3 | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/kimi-k3.1-pro | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/kimi-k3 | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/muse-spark-1.3-contributor | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/minimax-m3.1-flash | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/minimax-m3 | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/mimo-v2.6-pro | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/mimo-v2.6-flash | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/qwen3.7-max | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/qwen3.7-plus | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |
| cline-pass/qwen3.8-max | 0/3 | Not measured | Not measured | 0/60 | Not measured | Not measured | No |

Winner: **none — no measured qualifying model**.

Gate: average >= 90, minimum >= 85, all schema-valid cases, p95 <= 15 seconds; higher average wins, then lower p95. Latency is measured per complete synthetic batch, not per individual customer turn. Three samples are a small readiness screen, not a production performance guarantee.

Run in an authorized shell with the existing CLINE_API_KEY: `node scripts/evaluate-cline-models.js`. The runner stops immediately on HTTP 401, 402 or 429 and never changes CLINE_MODEL.

Owner approval of the measured table is required before a production model change.

## Execution evidence for this PR

On 2026-11-04 the runner stopped before any provider request because this execution environment has no CLINE_API_KEY. The connected Render tools expose deployment management, but no command execution or secret-read operation. The browser fallback reached the Render sign-in screen; no authenticated shell was available. The production key was neither retrieved nor displayed.

All 15 model rows are unmeasured. Unit tests use injected synthetic provider responses only; those tests are not model accuracy or live latency evidence. The PR remains a draft until the real-key comparison, voice probe and owner model selection review are complete.
