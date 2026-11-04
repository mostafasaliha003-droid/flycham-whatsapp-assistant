# Public human Arabic speech diagnostic — 2026-11-04

Status: **not qualified for release**. No production code, model settings or customer messages changed.

Source: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), CC BY 4.0, `ar_eg/test` rows 0, 1 and 2 (IDs 1993, 1730 and 1995), durations 8.16, 14.16 and 16.02 seconds. These are published human recordings with reference transcripts; they are not the owner-recorded Levantine travel phrase. Source WAV hashes are pinned in `scripts/diagnose-public-speech.js`. Audio and reference text were downloaded from the official dataset API; only audio was submitted to providers. Audio stayed in memory during the Render diagnostic and was wiped after use. No customer data was used.

Execution: exact script from commit `1b295f93487ab1aa16e1807782a7b50acbc4b37d`, SHA-256 `2754ac7128c6203a87bda7dd6e513c397c2a3f501c976d113a69cd9b214199c2`, in a temporary directory on the existing Render service. The candidate transcription modules came from commit `343c4f0`. All 15 Cline models and Gemini were first tested on row 0 as MP3 and OGG (32 calls). Gemini then passed through the real transcription pipeline on all three samples in both formats (6 calls). The same normalization and WER threshold <= 15% were retained.

| Sample row | Format | Gemini 3.8 Flash WER | Pipeline latency ms | Pass <= 15% |
|---|---|---:|---:|---|
| 0 | mp3 | 0.0% | 3734 | Yes |
| 0 | ogg | 0.0% | 3745 | Yes |
| 1 | mp3 | 23.3% | 9428 | No |
| 1 | ogg | 23.3% | 9759 | No |
| 2 | mp3 | 0.0% | 4392 | Yes |
| 2 | ogg | 0.0% | 3993 | Yes |

No model qualified across all required samples. The initial Cline calls returned 26 HTTP 500 responses; the four MiMo responses did not transcribe the first spoken sample successfully (100% WER). This is a failure of the tested model/endpoint combination, not evidence that Cline models cannot perform any audio task.

Two supplemental diagnostic calls examined row 1 without changing the measured run. Gemini 3.8 Flash again returned 23.3% WER. Gemini 3.5 Transcribe was tested through the documented Interactions API with inline audio, verbatim mode and `store:false`: status completed, WER 23.3%, 1373 ms. Both outputs rendered the reference clock times `06:30` and `07:30` as `36` and `37`. This is an unresolved mismatch with the published reference; no human listening verification was performed, so label/reading differences cannot be ruled out. The specialized model was not integrated or selected for production.

The two additional calls bring this investigation to 40 provider requests. They do not replace, remove or retry-away any failed benchmark row. No readiness threshold was relaxed.

| Model | Sample | Format | Production pipeline | WER | Latency ms | Error |
|---|---:|---|---|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 0 | mp3 | No | Not measured | 280 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash-1017 | 0 | ogg | No | Not measured | 255 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash | 0 | mp3 | No | Not measured | 288 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash | 0 | ogg | No | Not measured | 243 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4-pro | 0 | mp3 | No | Not measured | 225 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4-pro | 0 | ogg | No | Not measured | 235 | VOICE_HTTP_500 |
| cline-pass/glm-5.3-flash | 0 | mp3 | No | Not measured | 224 | VOICE_HTTP_500 |
| cline-pass/glm-5.3-flash | 0 | ogg | No | Not measured | 263 | VOICE_HTTP_500 |
| cline-pass/glm-5.3 | 0 | mp3 | No | Not measured | 265 | VOICE_HTTP_500 |
| cline-pass/glm-5.3 | 0 | ogg | No | Not measured | 241 | VOICE_HTTP_500 |
| cline-pass/kimi-k3.1-pro | 0 | mp3 | No | Not measured | 210 | VOICE_HTTP_500 |
| cline-pass/kimi-k3.1-pro | 0 | ogg | No | Not measured | 187 | VOICE_HTTP_500 |
| cline-pass/kimi-k3 | 0 | mp3 | No | Not measured | 249 | VOICE_HTTP_500 |
| cline-pass/kimi-k3 | 0 | ogg | No | Not measured | 238 | VOICE_HTTP_500 |
| cline-pass/muse-spark-1.3-contributor | 0 | mp3 | No | Not measured | 239 | VOICE_HTTP_500 |
| cline-pass/muse-spark-1.3-contributor | 0 | ogg | No | Not measured | 231 | VOICE_HTTP_500 |
| cline-pass/minimax-m3.1-flash | 0 | mp3 | No | Not measured | 186 | VOICE_HTTP_500 |
| cline-pass/minimax-m3.1-flash | 0 | ogg | No | Not measured | 205 | VOICE_HTTP_500 |
| cline-pass/minimax-m3 | 0 | mp3 | No | Not measured | 277 | VOICE_HTTP_500 |
| cline-pass/minimax-m3 | 0 | ogg | No | Not measured | 193 | VOICE_HTTP_500 |
| cline-pass/mimo-v2.6-pro | 0 | mp3 | No | 100.0% | 21042 | — |
| cline-pass/mimo-v2.6-pro | 0 | ogg | No | 86.7% | 22654 | — |
| cline-pass/mimo-v2.6-flash | 0 | mp3 | No | 93.3% | 14015 | — |
| cline-pass/mimo-v2.6-flash | 0 | ogg | No | 100.0% | 24613 | — |
| cline-pass/qwen3.7-max | 0 | mp3 | No | Not measured | 230 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-max | 0 | ogg | No | Not measured | 201 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-plus | 0 | mp3 | No | Not measured | 237 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-plus | 0 | ogg | No | Not measured | 192 | VOICE_HTTP_500 |
| cline-pass/qwen3.8-max | 0 | mp3 | No | Not measured | 244 | VOICE_HTTP_500 |
| cline-pass/qwen3.8-max | 0 | ogg | No | Not measured | 193 | VOICE_HTTP_500 |
| gemini-3.8-flash | 0 | mp3 | No | 0.0% | 3368 | — |
| gemini-3.8-flash | 0 | ogg | No | 0.0% | 3467 | — |
| gemini-3.8-flash | 0 | mp3 | Yes | 0.0% | 3734 | — |
| gemini-3.8-flash | 0 | ogg | Yes | 0.0% | 3745 | — |
| gemini-3.8-flash | 1 | mp3 | Yes | 23.3% | 9428 | — |
| gemini-3.8-flash | 1 | ogg | Yes | 23.3% | 9759 | — |
| gemini-3.8-flash | 2 | mp3 | Yes | 0.0% | 4392 | — |
| gemini-3.8-flash | 2 | ogg | Yes | 0.0% | 3993 | — |

Release gate remains closed. Obtain the specified owner recording, verify the spoken words and time expressions against a human-confirmed reference, and rerun MP3/OGG acceptance before merging or deploying. The existing 2565-test isolated regression result still applies to unchanged application code; this follow-up added only a diagnostic script and reports. Script syntax and diff checks passed. The live service health check returned HTTP 200 with `ok:true`; main remains `5871f8c`.

Protocol references: [Gemini audio transcription](https://ai.google.dev/gemini-api/docs/transcribe), [Interactions API](https://ai.google.dev/api/interactions-api).
