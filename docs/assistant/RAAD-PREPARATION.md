# Raad: Saudi tourist visa preparation

Raad is the protected staff preparation desk behind Ismail's Saudi visa intake.
This release prepares and reviews local drafts. It has **no live MOFA session,
portal executor, OCR service, OTP endpoint, CAPTCHA solver, legal-consent action,
insurance purchase, government payment, official PDF capture, or customer PDF
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

## Next portal integration checkpoint

The public SmartForm link redirected to the MOFA home page on 27 October 2026.
The visitor account sign-in page requires authentication and an image CAPTCHA.
An authorized interactive sign-in is needed before inspecting actual form fields.
Do not derive production selectors from a description or bypass that challenge.

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
