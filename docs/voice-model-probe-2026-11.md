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

## Current execution evidence

The owner-recorded 10-second synthetic speech sample is still missing. WER and successful dialect transcription remain unmeasured. No audio model is approved by this report. A single recording can be converted locally to the required MP3/OGG pair without customer data.

The existing Render service has Cline and Gemini credentials and `/usr/bin/ffmpeg`. A separate negative probe made 32 real provider requests with generated silence, followed by two requests to the current Gemini model. See `voice-silence-probe-2026-11.md` for every result, including errors and invented speech. Silence rejection does not establish speech accuracy.

The former Gemini default returned HTTP 404. The candidate branch now uses the authenticated model-list-confirmed `gemini-3.8-flash` default while preserving explicit configuration. It is still subject to speech acceptance testing; no production setting has changed.

All incoming audio now passes a bounded, pipe-only local decode before contacting a provider. Silence, invalid decoding and recordings over two minutes are rejected honestly. An actual Render check rejected ten-second MP3 and OGG silence with zero provider calls. The isolated signed-webhook test confirms that rejected silence does not create trip facts or conversation history. The full isolated regression suite passed 2565 tests with zero failures, cancellations or skips.

OGG-to-MP3 conversion remains limited to an approved Cline audio model; converted buffers are wiped and conversion failure can fall back to Gemini. Non-silent music/noise and Arabic speech accuracy remain acceptance-test gaps. Do not merge/deploy or change production model settings until the owner speech probe and measured-result review are complete.
