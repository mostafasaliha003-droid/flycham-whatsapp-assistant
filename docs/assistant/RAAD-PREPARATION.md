# Raad: Saudi tourist visa preparation

Raad is the protected staff preparation desk behind Ismail's Saudi visa intake.
This release prepares and reviews local drafts. Authenticated MOFA access through
an interactive TinyFish saved profile has been verified separately, but the
Render app has **no bound live MOFA session, portal executor, OCR service, OTP
endpoint, CAPTCHA solver, legal-consent action, insurance purchase, government
payment, official PDF capture, or customer PDF delivery**. `portal.connected`
remains false. A ready draft is not a submitted application, an issued visa, or
proof of eligibility.

## Implemented path

1. Select an existing Saudi visa conversation and claim it as staff.
2. Select the applicant; each applicant has an independent, revisioned draft.
3. Enter facts from the original documents and applicant declarations. Pasted
   TD3 MRZ text can be parsed locally; document images are not OCRed. Full dates
   require confirmation against the printed document. Names are not invented or
   split into father/grandfather names automatically. Passport numbers are not
   changed by nationality, and issuing country is separate from nationality.
   Separate Arabic father/grandfather names may be recorded when provided; their
   absence never authorizes inference from another name or language.
4. Select the applicant's owned passport, residence and portrait attachments.
   Optionally make protected JPEG/PNG derivatives under 1,000,000 bytes. Two
   residence images can be combined without cropping. Originals are retained;
   derivatives still need visual review. PDF raster conversion is not included.
5. Save the draft and resolve all issues. Current original-case payment and
   document evidence must be verified, and exact selected files are reviewed
   separately for Raad. Their content hashes and expiry invalidate stale review.
6. Confirm the exact saved version's facts, suggestions and selected documents.
   It can then be ready **for portal review**, never marked submitted by Raad.
7. Preview the local field mapping for that saved revision. This is a guarded
   local preview with `canExecute: false`; it does not open or fill the portal.

Unknown marital status, previous nationality, travel history, Umrah intent and
health declarations remain unanswered. There are no "all no" defaults and no
inference from age, sex, companion or insurance price. A minor requires an
explicit father/mother relationship and an already-issued guardian visa reference
reviewed by staff; the reference is not checked against a government system.

The second portal agreement personally asserts that the applicant has not been
deported from Saudi Arabia or another GCC state and has not violated their rules.
Raad therefore requires explicit `priorGccDeportation` and `priorGccRuleViolation`
answers. Neither defaults to false. An affirmative answer keeps preparation in
staff applicability review; it is not a finding of visa rejection, a ban or
ineligibility. Saving or reviewing these facts does not accept the legal pledge.

The agency route always uses Abu Dhabi mission; the live form also exposes a
Dubai option, which is not this agency route. UAE residence country, Egypt
single/90-day versus other supported tourist multiple/365-day settings, air
transport, King Khalid arrival and entry date +15 days remain office suggestions.
Live inspection has not established visa/stay duration or eligibility for a
particular applicant. The actual trip and current portal options still require
confirmation. Unsupported and Umrah-only cases do not enter this tourist workflow.

## Protected API

The case routes use the existing admin authorization; mutations require current
staff ownership, rechecked after body upload and image processing.

- `GET /internal/assistant/raad/:customer?applicantIndex=0`
- `POST /internal/assistant/raad/:customer`
  - `prepare`: save/preview fields and document UUIDs with `expectedRevision`.
  - `review`: confirm exactly `reviewRequiredFields` on the saved revision.
  - `parse_mrz`: parse ephemeral TD3 text, optionally with independently confirmed
    full birth/expiry dates. Never stored in drafts, journal or logs.
  - `prepare_image`: make a reviewed-later derivative of owned source UUIDs.
  - `preview_mapping`: return a local mapping preview for the saved revision,
    guarded by current staff ownership, case state and revision. It always
    returns `canExecute: false`; it sends no applicant data or documents to MOFA
    or TinyFish and provides no portal execution action.

The provider configuration checker is separate from applicant preparation and
uses global admin authorization:

- `GET /internal/assistant/raad-provider`: local configuration booleans only;
  no network request.
- `POST /internal/assistant/raad-provider/check`: explicitly checks only the
  configured profile's metadata through TinyFish's fixed
  `GET /v1/profiles/{profileId}` endpoint. It cannot start a browser/Agent run,
  inspect MOFA, accept terms, upload files or enter an OTP.

Configure `RAAD_TINYFISH_API_KEY` as a server secret and
`RAAD_TINYFISH_PROFILE_ID` as private runtime configuration, or use encrypted
private configuration's `tinyfishProfileId` for the profile ID. The API key has
no private-file fallback. The checker uses a 15-second deadline, a 200 KiB
response cap, rejects redirects and verifies the documented response shape and
exact configured profile identity. It returns only safe status/reason fields,
never the profile ID, name, domains, cookies, credentials or raw provider errors.
`providerReachable` and `profileAvailable` concern provider metadata access;
`portalAuthenticationChecked` and `executionConnected` always remain false.
An empty `signed_in_sites` list cannot prove a logged-out portal session.
This checker has passed tests with mocked responses only. It has not been live
configured or checked, and does not establish an authenticated Render executor.

There is deliberately no submit, pay, accept-all, OTP or arbitrary URL action.
Drafts and media use the encrypted existing store. Draft retention is 30 days;
visa erasure also deletes Raad drafts. Contacts are private runtime configuration
(`RAAD_*` variables or encrypted private configuration's `raad` object), not source
constants. No external AI receives identity or health information through Raad.

## Observed portal access: 27 October 2026

Authorized interactive TinyFish inspection established a signed-in MOFA session,
reached My Applications, and opened the blank Traditional Application after the
owner separately approved each of the two displayed agreements at action time.
Each agreement was accepted once. No real applicant data was entered, documents
uploaded, application saved/submitted or payment made. Subsequent legal gates
still require approval for the specific agreement and applicant declarations.

The observed controls, navigation and unresolved mappings are recorded in
[MOFA observations](RAAD-MOFA-OBSERVATIONS.md). These are evidence for the local
preview and future validation, not a completed portal adapter. Empty
`signed_in_sites` metadata or a generic login link alone does not invalidate
authenticated page evidence. Do not derive selectors from descriptions or bypass
authentication challenges.

The last focused route inspection failed its selection postconditions: Tourism
and Syrian nationality were shown, but residence was Australia after an unsaved
generic selection and mission remained Select. That result is inconclusive for
the UAE/Abu Dhabi route and establishes no visa validity, stay duration or UAE
restriction. Dates, GCC permit fields and upload behavior remain unverified.

## Next portal integration checkpoint

TinyFish's public [Browser Context Profiles API](https://docs.tinyfish.ai/agent-api/browser-context-profiles)
supports listing saved profiles with `GET /v1/profiles` and starting Agent runs
with `use_profile: true` plus a specific `profile_id`. Setup uses
`POST /v1/profiles/{id}/setup-session`, a controller connected to the returned
`cdp_url`, and `POST /v1/profiles/{id}/save` with `session_id`. Unsaved setup state
is discarded on cancel or timeout. A saved profile can still expire or require
fresh MFA; it does not solve CAPTCHA.

Profiles are [scoped to the TinyFish account and API-key owner](https://docs.tinyfish.ai/key-concepts/browser-context-profiles).
Organization workflow keys cannot use them. The ChatGPT plugin uses OAuth with a
TinyFish account; the [REST API requires an `X-API-Key` header](https://docs.tinyfish.ai/authentication).
It is an inference that a personal REST key for that same account can use the
profile saved through the plugin. Verify access through the implemented
read-only profile-detail checker before connecting Raad. The plugin connection
alone supplies no Render API key.
Keep the key in a server secret and the profile ID in private runtime
configuration; no concrete profile ID or credential belongs in source control.

The provider metadata checker is implemented; a portal inspection adapter is not.
The next phase remains a staff-only, read-only inspection adapter:

1. Provision a same-account personal API key privately and verify access to the
   configured profile without exposing cookies or credentials.
2. Bind each inspection to the staff owner, applicant, reviewed draft revision
   and fingerprint, selected source files and actual live portal session.
3. Use a verified portal URL and a bounded read-only goal with
   `POST https://agent.tinyfish.ai/v1/automation/run-async` or `/run-sse`,
   `use_profile: true`, the configured `profile_id`, and a wall-clock limit via
   `agent_config.max_duration_seconds`. Confirm returned `profile_attached` and
   `profile_id`; record sanitized navigation evidence without copying account or
   application-table contents. Stop at authentication, changed fields, consent,
   OTP, CAPTCHA, submission, insurance purchase or payment.
4. Poll `GET /v1/runs/{id}` or consume the event stream. These endpoints support
   cancellation; synchronous `/run` does not. Optional HTTPS webhooks announce
   terminal states, and sensitive callbacks must be checked by fetching the run.

The [Agent API reference](https://docs.tinyfish.ai/agent-api/reference) documents
creation, polling, cancellation and streaming, but no approval pause/resume, OTP
input, manual CAPTCHA takeover or file/buffer/upload-URL attachment endpoint.
Profile `/upload` accepts cookies and storage, not applicant document files.
Its live stream is documented as a [preview](https://docs.tinyfish.ai/live-preview),
not a human-input channel.
Strict mode and custom step limits require beta access. The separate
[Browser API](https://docs.tinyfish.ai/browser-api/reference) provides CDP control,
but its sessions are isolated and its documented creation request has no profile
parameter; do not assume it resumes an Agent run.

The documented profile setup-session `cdp_url` can be controlled with standard
Playwright/CDP. It is a candidate for a controller that keeps one live browser
through staff gates, not a verified Raad executor. TinyFish does not explicitly
document preloading existing profile state into setup sessions, document-buffer
uploads there, or using setup sessions as a production workflow executor. The
[public schema](https://agent.tinyfish.ai/v1/openapi/main) allows a setup timeout
of 5–86400 seconds capped by the account maximum and returns `expires_at`. Explicit
save captures setup browser state and may clean up the session. Ordinary Agent
writeback of every cookie/storage change is not guaranteed by the documentation;
run-attributed profile-write metadata alone does not prove consent continuity.
Validate authentication reuse, synthetic file uploads, session lifetime and
private one-use job-bound OTP input before transmitting customer documents.
The provider checker is not yet live configured. No upload test, OTP channel or
official PDF capture is present.
Genuine secure human control must be implemented and verified before claiming
an OTP or CAPTCHA gate works.
See also [webhook verification](https://docs.tinyfish.ai/webhooks). This phase
does not implement portal submission, and `portal.connected` remains false until
Raad has a verified executor bound to its own workflow.

A later portal adapter must bind the exact reviewed draft, applicant, source files
and live portal session; stop at changed fields, unsupported eligibility or expired
session. Legal declarations require explicit approval for that concrete version.
OTP entry must use a private, expiring, one-use challenge bound to the correct
job/session and never be persisted or requested in ordinary chat. No placeholder
OTP screen may claim an unconnected browser is waiting.

Insurance choice must use the actual currently available offers and truthful
answers. The local selection helper compares integer USD cents and fails closed
if any available offer cannot be read reliably; the user's historical price list
is not live evidence. Government payment is outside this release.

An official printed PDF must be captured from the matching portal request and
matched against its application reference, passport and current payment/status
evidence before any customer delivery. An unpaid saved form must be labelled as
such. Never generate a local imitation or call it a completed submission.
