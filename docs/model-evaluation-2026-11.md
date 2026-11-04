# Cline understanding evaluation — November 2026

Status: **completed**.

Policy: `730d1bbdf0d55d752755481cb726f03b06e09ac8c00fc0040714972f2afd6a97`. Synthetic cases: 20; required repetitions: 3 per model.

No customer data, credentials or model response text are included. No production model settings were changed.

| Model | Runs | Average | Minimum | Valid cases | p50 ms | p95 ms | Qualified |
|---|---:|---:|---:|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 3/3 | 90 | 87 | 55/60 | 31907 | 35330 | No |
| cline-pass/minimax-m3.1-flash | 3/3 | 31 | 0 | 19/60 | 60003 | 60038 | No |
| cline-pass/minimax-m3 | 3/3 | 0 | 0 | 0/60 | 60002 | 60011 | No |
| cline-pass/glm-5.3-flash | 3/3 | 0 | 0 | 0/60 | 60004 | 60014 | No |
| cline-pass/mimo-v2.6-pro | 3/3 | 0 | 0 | 0/60 | 60018 | 60019 | No |
| cline-pass/deepseek-v4.1-flash | 3/3 | 0 | 0 | 0/60 | 46927 | 60021 | No |
| cline-pass/kimi-k3 | 3/3 | 0 | 0 | 0/60 | 60005 | 60021 | No |
| cline-pass/qwen3.7-plus | 3/3 | 0 | 0 | 0/60 | 60022 | 60028 | No |
| cline-pass/mimo-v2.6-flash | 3/3 | 0 | 0 | 0/60 | 60020 | 60034 | No |
| cline-pass/glm-5.3 | 3/3 | 0 | 0 | 0/60 | 60022 | 60037 | No |
| cline-pass/muse-spark-1.3-contributor | 3/3 | 0 | 0 | 0/60 | 60027 | 60037 | No |
| cline-pass/qwen3.8-max | 3/3 | 0 | 0 | 0/60 | 60011 | 60037 | No |
| cline-pass/deepseek-v4-pro | 3/3 | 0 | 0 | 0/60 | 60023 | 60040 | No |
| cline-pass/kimi-k3.1-pro | 3/3 | 0 | 0 | 0/60 | 60025 | 60041 | No |
| cline-pass/qwen3.7-max | 3/3 | 0 | 0 | 0/60 | 60004 | 60042 | No |

Winner: **none — no measured qualifying model**.

Gate: average >= 90, minimum >= 85, all schema-valid cases, p95 <= 15 seconds; higher average wins, then lower p95. Latency is measured per complete synthetic batch, not per individual customer turn. Three samples are a small readiness screen, not a production performance guarantee.

Run in an authorized shell with the existing CLINE_API_KEY: `node scripts/evaluate-cline-models.js`. The runner stops immediately on HTTP 401, 402 or 429 and never changes CLINE_MODEL.

Owner approval of the measured table is required before a production model change.

## Execution evidence

The real-key run completed on 2026-11-04 in a temporary directory in the existing Render service shell, using Node v26.13.0 and the existing Cline credential. The owner completed secure sign-in; credential presence was checked using booleans only. Production code, customer state and model environment settings were not changed.

The final sanitized log was read at **2026-11-04T14:56:47.666Z**. It contained **45 attempts across all 15 models** and the terminal result `{"state":"completed","winner":null}`.

| Recorded outcome | Attempts |
|---|---:|
| Scored batch response | 4 |
| Invalid batch schema | 2 |
| 60-second request timeout | 38 |
| HTTP rejection | 1 |

A scored batch is not necessarily fully schema-valid. The leading model scored 89.5, 87 and 93.5 (average 90) but had only 55/60 valid decisions and p95 35.33 seconds. MiniMax M3.1 Flash scored 93 in one attempt and timed out twice, giving an average of 31 and 19/60 valid decisions. The remaining models had no scored batch within this run. A timeout receives zero under this fixed readiness policy; it does not establish zero language capability.

The HTTP rejection was not a stop-class 401/402/429, as the runner continued and completed. The progress log did not retain its exact status, so no exact status or cause is claimed.

The evaluator loaded hash-verified files from commit `264bdb5e99211310ce05aa74df0558893b3f6893`; both files are unchanged in the current PR:

| File | SHA-256 |
|---|---|
| src/cline-model-evaluation.js | 1d10e4741b51ed7d451ec73fc5a7a23147804fd2d357a6463b0d50a83e4b3ed2 |
| scripts/evaluate-cline-models.js | be54f019392b05b25c5054ca39e9b623c9dba8a9d04d58f67b4d3705a09e34b4 |

## Release decision

**Do not select a new production understanding model from this run.** None meets the required readiness gate. No CLINE_MODEL or CLINE_AUDIO_MODEL setting was changed. A separately scoped, representative single-turn performance investigation would be needed to explain the batch failures; these batch timings must not be presented as customer-turn latency.

Voice accuracy and Cline audio support remain unmeasured until the requested owner-recorded synthetic MP3/OGG pair is available; see [voice-model-probe-2026-11.md](voice-model-probe-2026-11.md). The PR remains a draft and does not claim 100% readiness.
