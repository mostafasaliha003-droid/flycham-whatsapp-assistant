# Raad: Saudi tourist visa preparation

Raad is the protected staff preparation desk behind Ismail's Saudi visa intake.
This release prepares and reviews local drafts. Authenticated MOFA access through
an interactive TinyFish saved profile has been verified separately, but the
Render app has **no bound live MOFA session, portal executor, OCR service, OTP
endpoint, CAPTCHA solver, legal-consent action, insurance purchase, government
payment, official PDF capture, or customer PDF
delivery**. `portal.connected` remains false. A ready draft is not a submitted
application, an issued visa, or proof of eligibility.

## Implemented path

1. Select an existing Saudi visa conversation and claim it as staff.
2. Select the applicant; each applicant has an independent, revisioned draft.
3. Enter facts from the original documents and applicant declarations. Pasted
   TD3 MRZ text can be parsed locally; document images are not OCRed. Full dates
   require confirmation against the printed document. Names are not invented or
   split into father/grandfather names automatically. Passport numbers are not
   changed by nationality, and issuing country is separate from nationality.
4. Select the applicant's owned passport, residence and portrait attachments.
   Optionally make protected JPEG/PNG derivatives under 1,000,000 bytes. Two
   residence images can be combined without cropping. Originals are retained;
   derivatives still need visual review. PDF raster conversion is not included.
5. Save the draft and resolve all issues. Current original-case payment and
   document evidence must be verified, and exact selected files are reviewed
   separately for Raad. Their content hashes and expiry invalidate stale review.
6. Confirm the exact saved version's facts, suggestions and selected documents.
   It can then be ready **for portal review**, never marked submitted by Raad.

Unknown marital status, previous nationality, travel history, Umrah intent and
health declarations remain unanswered. There are no "all no" defaults and no
inference from age, sex, companion or insurance price. A minor requires an
explicit father/mother relationship and an already-issued guardian visa reference
reviewed by staff; the reference is not checked against a government system.

Abu Dhabi mission, UAE residence country, Egypt single/90-day versus other
supported tourist multiple/365-day settings, air transport, King Khalid arrival
and entry date +15 days are tentative office suggestions. The actual trip and
current portal options still require confirmation. Unsupported and Umrah-only
cases do not enter this tourist workflow.

## Protected API

All routes use the existing admin authorization; mutations require current staff
ownership, rechecked after body upload and image processing.

- `GET /internal/assistant/raad/:customer?applicantIndex=0`
- `POST /internal/assistant/raad/:customer`
  - `prepare`: save/preview fields and document UUIDs with `expectedRevision`.
  - `review`: confirm exactly `reviewRequiredFields` on the saved revision.
  - `parse_mrz`: parse ephemeral TD3 text, optionally with independently confirmed
    full birth/expiry dates. Never stored in drafts, journal or logs.
  - `prepare_image`: make a reviewed-later derivative of owned source UUIDs.

There is deliberately no submit, pay, accept-all, OTP or arbitrary URL action.
Drafts and media use the encrypted existing store. Draft retention is 30 days;
visa erasure also deletes Raad drafts. Contacts are private runtime configuration
(`RAAD_*` variables or encrypted private configuration's `raad` object), not source
constants. No external AI receives identity or health information through Raad.

## Observed portal access: 27 October 2026

The public SmartForm link initially redirected to the MOFA home page. The visitor
account sign-in page requires authentication and an image CAPTCHA. Subsequently,
an authorized TinyFish run using a saved Browser Context Profile showed the
authenticated welcome header, avatar and account dropdown, and reached SmartForm
My Applications. Its **Add A New Application** link opened the
[agreement page](https://visa.mofa.gov.sa/SmartForm/Agreement), which was read
without accepting it.

Following that link to read the agreement is a read-only inspection step. The
page heading was **VISA Portal Services Agreement**, with **I AGREE**, Back and
Close controls. Its terms state that acceptance is a legally binding signature.
They describe a USD 10 processing fee plus USD 0.50 banking fee per visa, which
are not the total visa or insurance cost; platform fees are nonrefundable once
paid. They also cover information processing and sharing with Saudi government
authorities, and service, warranty and liability limitations.

The consent boundary is clicking **I AGREE**. Explicit action-time approval for
this concrete agreement is the next gate; it cannot authorize a later agreement
that has not yet been read. No agreement was accepted, payment made or application
created during this inspection. Application-form fields beyond the agreement
remain unverified. Do not derive production selectors from a description or
bypass authentication challenges.

The profile's `signed_in_sites` metadata remained empty despite authenticated
page evidence. Neither that metadata nor a generic login link alone proves that
the live browser is logged out. Recheck the actual page and account controls.

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
profile saved through the plugin. Verify this through the profile-list endpoint
before connecting Raad. The plugin connection alone supplies no Render API key.
Keep the key in a server secret and the profile ID in private runtime
configuration; no concrete profile ID or credential belongs in source control.

The minimal next phase is a staff-only, read-only inspection adapter:

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
input or manual CAPTCHA takeover endpoint. Its live stream is documented as a
[preview](https://docs.tinyfish.ai/live-preview), not a human-input channel.
Strict mode and custom step limits require beta access. The separate
[Browser API](https://docs.tinyfish.ai/browser-api/reference) provides CDP control,
but its sessions are isolated and its documented creation request has no profile
parameter; do not assume it resumes an Agent run. Genuine secure human control
must be implemented and verified before claiming an OTP or CAPTCHA gate works.
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
