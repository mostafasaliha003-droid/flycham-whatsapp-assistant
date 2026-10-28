# Automatic visa document reading

The existing WhatsApp service now has a dedicated document intake pipeline. It reads actual image pixels through the pinned Gemma vision model, checks the structured result locally, matches each passport to its UAE identity documents, and prepares portal images. Clear, matched dossiers can proceed without a staff document-review flag. Applicant answers, explicit summary authorization and accountant-approved payment remain separate requirements.

## Input and evidence

Only customer-bound original JPEG, PNG, WEBP and PDF attachments enter the reader. Images are decoded, normalized and bounded before inference. PDFs are read sequentially, up to ten pages each; each page is independently classified and checkpointed. Limits are twenty original sources and one hundred pages per current case. Audio, receipts and unrelated pages never supply passport facts.

The dedicated adapter uses `GEMINI_API_KEY`, pins `gemma-4-26b-a4b-it`, and is enabled with `RAAD_DOCUMENT_OCR_ENABLED=true`. It sends one bounded image and a fixed extraction instruction, without conversation history or a caller-provided prompt. There is no paid-model fallback. Provider errors, raw generated text and base64 images are not logged or persisted. Structured evidence is retained in the existing encrypted state; original and prepared media remain encrypted and customer-bound.

Model confidence alone cannot authorize a dossier. Local reconciliation checks TD3 MRZ digits and independently visible full dates, visual/MRZ consistency, printed identity names and birth date, country versus issuer, uniqueness of applicant assignment, passport validity and residence validity. The Emirates ID number's year segment is not treated as a birth date. Unknown father/grandfather or other optional components are not inferred or populated. Whole names can link identity documents without assigning unknown components to application fields.

Missing passport type, issue date or birthplace may be resolved through explicit applicant questions when the identity match is otherwise strong. Genuine identity conflicts, ambiguous applicant assignment and unreadable critical data remain exceptions. A proven applicant may advance independently of another applicant requiring review.

Prepared passport, residence and portrait images must all be real, separate portal-compatible images. An embedded portrait is cropped only from an assigned document with a confident bounded rectangle and sufficient original pixels; no upscaling, face comparison or identity inference is performed. A full passport page cannot be relabelled as a portrait. When no suitable portrait exists, the dossier asks for an appropriate image or review.

## Workflow

Reading results live in `visaDocumentIntake`, outside the paid case facts. They do not alter nationality, applicant count, quote, documents signature, accountant approval or staff-review evidence on the original case. Before payment, a prepared dossier can report `awaitingPayment`. After actual approval, `prepareJob` applies and stages the evidence without another vision call or image conversion.

`RaadVisaWorkflow.applyMachineDossier` and `verifyMachineDossier` validate the exact source and prepared SHA manifests, extraction policy, current case and selected applicant. Existing manual edits are protected. `VisaFulfilment.stageDocumentFacts` stages only verified document facts; personal and medical answers remain explicit. The client receives one combined summary and grants authorization through an actual inbound confirmation.

`portalDossier` is the shared execution resolver for launch, polling, worker lease validation and final PDF storage. It checks current payment, source evidence, prepared bytes, customer authorization, all merged application fields and current ownership. A changed dossier cannot silently continue an older browser run.

Reading/matching is distinct from government verification of document authenticity. The UI states only the checks actually performed and shows unknown values and reasons for exceptions. Fixed WhatsApp status messages contain no extracted full identifiers or arbitrary provider explanations. Old backfilled cases do not receive unsolicited reading notifications: feedback requires current visa conversation activity after feature activation. Known paused notifications reopen only after a real new inbound; uncertain sends are not replayed.

## Operations and checks

The protected visa workflow API includes `documentReview` for the existing operations UI. The bridge-protected setup health reports reader configuration and queue readiness. The accountant-and-bridge-protected `POST /internal/assistant/visa-portal/document-ocr/probe` reads a fixed, clearly synthetic diagnostic image; it never accepts a customer image, prompt, URL or destination from the caller.

Queue checkpoints, source hashes and generation guards prevent erasure, source replacement, case replacement or an interrupted inference from being accepted as current evidence. Reads and conversion are bounded and serial. Private extraction data and queued feedback are removed with visa erasure and expire with their source/case retention. Tests use synthetic documents and mocked external systems; the live diagnostic separately checks actual image extraction without creating a government application.
