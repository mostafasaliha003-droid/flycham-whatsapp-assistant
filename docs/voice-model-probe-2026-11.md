# Voice model probe — November 2026

Status: **blocked_missing_synthetic_mp3_and_ogg**.

Synthetic reference: بدي من الشارقة للشام الجمعة الجاية أنا ومرتي بدون عفش

| Provider/model | Format | WER | Latency ms | Supports sample | Error |
|---|---|---:|---:|---|---|


Recommendation: **none — no verified audio result**.

A model qualifies only with WER <= 15%. The runner tests both MP3 and OGG, stops on HTTP 401/402/429, and writes no audio bytes, credentials or returned transcripts. A single sample measures only this phrase. No production settings are changed.

Run with the existing credentials: `node scripts/probe-voice-models.js /path/synthetic.mp3 /path/synthetic.ogg`. Both samples must be the owner-recorded 10-second synthetic phrase above, without customer data.

Production OGG uses bounded in-memory conversion for an approved CLINE_AUDIO_MODEL, with Gemini as fallback. Direct Cline OGG support remains unverified.

Protocol references: [Cline Chat Completions](https://github.com/cline/cline/blob/main/docs/api/chat-completions.mdx), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio). Documentation does not establish support by any particular Cline subscription model.

## Execution evidence for this PR

The owner-recorded 10-second synthetic MP3/OGG pair has not been attached, so speech accuracy and Cline audio support remain unmeasured. No real provider audio request was made. Tests inject audio/JSON fixtures to validate routing, WER calculation, redaction and failure handling; these do not establish transcription accuracy.

On 2026-11-04 the owner completed secure Google sign-in to Render. The service shell confirmed CLINE_API_KEY and GEMINI_API_KEY are configured using boolean output only. `command -v ffmpeg` returned `/usr/bin/ffmpeg`.

The implementation now includes OGG-to-MP3 conversion with fixed pipe-only ffmpeg arguments, one thread, an eight-second timeout, bounded input/output, no filesystem audio writes and cleanup of converted buffers. Conversion is attempted only when an allowlisted CLINE_AUDIO_MODEL is configured; otherwise OGG goes to Gemini. Conversion failure also falls back to Gemini using the original OGG. No production model setting was changed.

An actual local codec check converted one second of generated silence (395-byte OGG to 6525-byte MP3, ID3 header). This verifies codec plumbing only, not speech recognition. The complete isolated test suite after this addition passed 2556/2556 tests with zero failures, cancellations or skips.
