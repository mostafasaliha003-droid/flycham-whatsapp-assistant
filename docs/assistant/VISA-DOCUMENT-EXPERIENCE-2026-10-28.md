# Ismail document conversation and upload experience

The current visa conversation keeps its service and subject across greetings, images and follow-up questions. Safe captions are retained after identifier/credential redaction. Questions sent with images are answered alongside the actual media receipt. Relative enquiries remain separate from the primary applicant until an explicit addition, and never imply a promised visa decision.

Document requests (merge, improve, send the prepared copy, reading status and upload link) have a deterministic handler built from actual intake state. It never says that a file was sent before WhatsApp accepts the real media. Missing data and genuine conflicts are reported from fixed issue codes, without exposing extracted identifiers or arbitrary provider explanations.

## Upload page

A customer can ask Ismail for a document-upload link. The existing case receives a two-hour capability URL, with a 256-bit token in the URL fragment. The static page removes the fragment and holds the token only in memory. API requests carry the token in Authorization, not the URL. Only its SHA-256 is stored by the upload service; inbound/outbound journal text masks private upload fragments.

The RTL page has three cards: passport (up to two files), UAE identity (up to two files), personal photo (one file). Every card accepts JPEG, PNG, WEBP or PDF up to 10 MiB. It supports local previews, actual upload progress, removal/replacement, exact-key retry reconciliation, explicit completion and return to the verified business WhatsApp number. Refreshing requires opening the original WhatsApp link again. Previously submitted WhatsApp attachments need not be resent.

Originals are encrypted on receipt but remain staged and excluded from OCR until completion. Completion activates only this session's selected files, binds them to the current case, and queues the existing reader. It does not confirm payment, legal declarations, a client application summary or government submission. Expired, changed, blocked or staff-owned cases cannot continue through an old link. Case erasure revokes sessions and pending deliveries.

Configure `RAAD_DOCUMENT_UPLOAD_WHATSAPP_NUMBER` with the verified business display number, in international digits. It is distinct from the office owner's OTP destination. The upload service uses the configured Render external origin; it never builds links from untrusted Host headers.

## Images and evidence

Document preparation preserves every page edge and the original sources. It corrects orientation, removes metadata, applies measured, limited tonal/sharpening adjustments only when suitable, and composes at most two pages on a white background. No generative reconstruction, invented text, face comparison or upscaling is performed. Portrait pixels are not beautified.

For government dossier evidence, passport pages must have a strong shared identity anchor; fields remain independently checked against MRZ and actual visible dates. Duplicate pages are removed, identity sides are ordered front then back, and prepared files bind every source hash. A preparation-only upgrade reuses OCR checkpoints. Compatible prompt updates preserve valid legible page checkpoints and reread only failed or unreadable supported pages, within existing bounds.

Customer image previews are separate from government dossier evidence. A requested preview may arrange explicitly classified source pages while the application still needs review, but it cannot supply or authorize application facts. Government submission still requires the existing matched dossier, accountant approval and actual client answers/confirmation.

## Verification

Synthetic tests cover signed WhatsApp link creation, private binary upload, encrypted staged storage, idempotent completion, actual intake queueing, captions and bank questions, relative context, bounded composition, two-page source verification, image ownership, delivery uncertainty and data erasure. Browser checks cover 320, 390, 768 and 1440 pixel layouts, five uploads and completion. Real provider diagnostics report only document kind, field counts and fixed schema error codes; raw model output and document values are not logged.

## Reply review — 2026-10-29

A reproduced three-turn conversation (`بدي قدم فيزا السعودية`, `كيف بقدم شو ابعتلك`, `طيب رح ابعتلك`) now advances through document preparation instead of repeating the quote. For a qualified tourist case, Ismail offers the private upload link once, preserves that link during immediate follow-up questions, and acknowledges an intention to send documents briefly. Exact price requests and changed applicant facts still use the pricing policy; unsupported routes are not redirected into this tourist flow.

Document notices wait until the inbound batch and receipt reply finish, then require twelve seconds of quiet. A semantic case/copy guard prevents the same notice from being sent under each new file fingerprint. Accepted duplicates are suppressed for ten minutes; an uncertain delivery is never replayed automatically. A received image whose reading or ownership is unresolved is described as received but unconfirmed, rather than absent.

An unanchored supplementary passport page no longer hides the unique identifiable main page for a sole applicant. Its facts remain separate and unassigned; critical identity, MRZ, validity and client-confirmation requirements are unchanged. Consistent repeated-image readings preserve per-field provenance, while genuine text, MRZ or orientation conflicts remain review blockers. The preparation policy upgrade reuses existing OCR checkpoints.

The WhatsApp return button opens the configured business chat with the fixed draft `تم رفع المستندات`. The customer presses Send; opening the link is not a payment, declaration or application consent.
