# Voice model probe — November 2026

Status: **blocked_missing_synthetic_mp3_and_ogg**.

Synthetic reference: بدي من الشارقة للشام الجمعة الجاية أنا ومرتي بدون عفش

| Provider/model | Format | WER | Latency ms | Supports sample | Error |
|---|---|---:|---:|---|---|


Recommendation: **none — no verified audio result**.

A model qualifies only with WER <= 15%. The runner tests both MP3 and OGG, stops on HTTP 401/402/429, and writes no audio bytes, credentials or returned transcripts. A single sample measures only this phrase. No production settings are changed.

Run with the existing credentials: `node scripts/probe-voice-models.js /path/synthetic.mp3 /path/synthetic.ogg`. Both samples must be the owner-recorded 10-second synthetic phrase above, without customer data.

Production OGG routes to Gemini unless a later approved change adds verified OGG support or a bounded conversion. Cline audio requires an approved CLINE_AUDIO_MODEL. No server-side ffmpeg availability or Cline OGG support has been verified in this run.

Protocol references: [Cline Chat Completions](https://github.com/cline/cline/blob/main/docs/api/chat-completions.mdx), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio). Documentation does not establish support by any particular Cline subscription model.

## Execution evidence for this PR

On 2026-11-04 no owner-recorded synthetic MP3/OGG pair was attached, and no authenticated Render shell was available. No real provider audio request was made. The automated tests inject audio/JSON fixtures to validate routing, WER calculation, redaction and failure handling; they do not establish transcription accuracy or any Cline model's audio support.

Runtime integration uses Gemini for WhatsApp OGG and permits Cline MP3/WAV only when CLINE_AUDIO_MODEL names an approved allowlisted model. No conversion was added because server ffmpeg availability and direct Cline OGG support remain unverified. Production CLINE_MODEL and CLINE_AUDIO_MODEL were not changed.
