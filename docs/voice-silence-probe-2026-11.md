# Voice silence probe — November 2026

Status: **completed**.

Input: ten seconds of generated silence in MP3 and OGG. This probes provider transport and the negative requirement to reject missing speech. It does not measure dialect recognition, WER or owner-sample acceptance, and cannot select an audio model.

| Provider/model | Format | Rejected silence correctly | Latency ms | Error |
|---|---|---|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | mp3 | Not measured | 450 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash-1017 | ogg | Not measured | 227 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash | mp3 | Not measured | 293 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4.1-flash | ogg | Not measured | 234 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4-pro | mp3 | Not measured | 278 | VOICE_HTTP_500 |
| cline-pass/deepseek-v4-pro | ogg | Not measured | 251 | VOICE_HTTP_500 |
| cline-pass/glm-5.3-flash | mp3 | Not measured | 276 | VOICE_HTTP_500 |
| cline-pass/glm-5.3-flash | ogg | Not measured | 217 | VOICE_HTTP_500 |
| cline-pass/glm-5.3 | mp3 | Not measured | 294 | VOICE_HTTP_500 |
| cline-pass/glm-5.3 | ogg | Not measured | 263 | VOICE_HTTP_500 |
| cline-pass/kimi-k3.1-pro | mp3 | Not measured | 243 | VOICE_HTTP_500 |
| cline-pass/kimi-k3.1-pro | ogg | Not measured | 222 | VOICE_HTTP_500 |
| cline-pass/kimi-k3 | mp3 | Not measured | 247 | VOICE_HTTP_500 |
| cline-pass/kimi-k3 | ogg | Not measured | 277 | VOICE_HTTP_500 |
| cline-pass/muse-spark-1.3-contributor | mp3 | Not measured | 248 | VOICE_HTTP_500 |
| cline-pass/muse-spark-1.3-contributor | ogg | Not measured | 205 | VOICE_HTTP_500 |
| cline-pass/minimax-m3.1-flash | mp3 | Not measured | 233 | VOICE_HTTP_500 |
| cline-pass/minimax-m3.1-flash | ogg | Not measured | 210 | VOICE_HTTP_500 |
| cline-pass/minimax-m3 | mp3 | Not measured | 263 | VOICE_HTTP_500 |
| cline-pass/minimax-m3 | ogg | Not measured | 194 | VOICE_HTTP_500 |
| cline-pass/mimo-v2.6-pro | mp3 | Yes | 15771 | — |
| cline-pass/mimo-v2.6-pro | ogg | Yes | 6775 | — |
| cline-pass/mimo-v2.6-flash | mp3 | Not measured | 25032 | VOICE_TIMEOUT |
| cline-pass/mimo-v2.6-flash | ogg | No | 10601 | — |
| cline-pass/qwen3.7-max | mp3 | Not measured | 364 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-max | ogg | Not measured | 200 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-plus | mp3 | Not measured | 230 | VOICE_HTTP_500 |
| cline-pass/qwen3.7-plus | ogg | Not measured | 390 | VOICE_HTTP_500 |
| cline-pass/qwen3.8-max | mp3 | Not measured | 244 | VOICE_HTTP_500 |
| cline-pass/qwen3.8-max | ogg | Not measured | 191 | VOICE_HTTP_500 |
| gemini-2.5-flash | mp3 | Not measured | 209 | VOICE_HTTP_404 |
| gemini-2.5-flash | ogg | Not measured | 129 | VOICE_HTTP_404 |
| gemini-3.8-flash | mp3 | No | 8125 | — |
| gemini-3.8-flash | ogg | No | 5197 | — |

No audio, transcripts, keys or customer records are included in this report. HTTP 401/402/429 stops all remaining requests. No production model or provider settings are changed. The owner-recorded speech probe remains required.

The first 32 requests used commit `0013587034c15cb60ae47d8e487cf1427a058128` and the former Gemini default. After its HTTP 404, the authenticated model listing confirmed `gemini-3.8-flash` with `generateContent`; two isolated calls to that model returned nonempty speech for generated silence. These failures are retained. The subsequent local silence gate blocks near-silent audio before either provider; it does not make these models accurate speech transcribers. No production configuration changed.

Cline results: 26 HTTP 500 responses, one timeout, one incorrect silence result, and two correct silence rejections from `mimo-v2.6-pro`. Correctly rejecting silence alone does not qualify that model for voice-note transcription.
