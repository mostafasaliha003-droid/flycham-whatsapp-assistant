# Ismail Saudi visa specialist — 2026-10-27

Scope: flycham-whatsapp-assistant web service only. No hotel service, portal worker, supplier account, infrastructure plan, or credentials are changed.

## Runtime

One signed WhatsApp ingress, one customer batch/ordering path, shared staff ownership, separate flight state and visa cases. Saudi specialization is enabled unless SAUDI_VISA_ENABLED=false. Existing flight routes remain handled by Ahmed. Generic new conversations receive a service choice. Intake uses the existing Cline provider adapter with bounded validated extraction and quota-only fallback; official/financial state is never model-authoritative.

Office policy version saudi-visa-2026-10-27 includes tourist AED700; three or more tourist applicants AED650 each; Umrah AED850; cancellation review AED200 per application. No cancellation/refund is executed from customer text. Nationality/document rules are office intake policies, not government approval guarantees. Unknown citizenship, children, mixed groups and changing eligibility are not silently generalized. Payment-method surcharges remain disabled unless SAUDI_VISA_PAYMENT_FEES_ENABLED=true after merchant agreement review. No historical visa prices or cancellation/refund exceptions are automatically imported.

Visa identity, quote and itinerary facts are separately stored. Staff payment/documents/submission/decision confirmations are bound to a case signature; material changes after confirmation become pending amendments and cannot reuse stale approvals. Incoming messages invalidate late automated replies. Staff claim, complaint pause, pending/uncertain native blocks and local automation blocks suppress both assistant domains.

## Media

Images, PDF and voice metadata are accepted. Visa media downloads use authenticated Meta metadata, restricted HTTPS download hosts, bounded bytes/type checks, encrypted persistent files and per-customer access checks. Media require staff review. No OCR, passport verification or speech transcription service is configured; receipt or file arrival does not prove quality, payment or embassy submission. Unknown-service attachments wait for service clarification. Staff-owned visa attachments remain available without an automated reply.

## Complaints

Financial complaints and direct accusations create a durable urgent review and pause automation. One acknowledgment is guarded against staff ownership/block state. Notifications target the privately configured management number, with authenticated dashboard links. Notification acceptance, delivery and staff claim are distinct. Explicit claim accepts the conversation; release resolves the pause. Notification failures and uncertain outcomes are visible; uncertain sends are never retried blindly.

Within the owner's WhatsApp service window, notifications use an ordinary message. Outside that window an approved Meta template is required. Configure SAUDI_VISA_COMPLAINT_TEMPLATE and SAUDI_VISA_COMPLAINT_TEMPLATE_LANGUAGE (default ar). Template body variables: complaint reference, customer number. URL button index0 uses a dynamic customer suffix on https://flycham-whatsapp-assistant.onrender.com/operations?customer={{1}}. No approved template was configured at implementation time; pending notifications remain pending rather than claiming success. Owner inbound messages trigger pending eligible notification delivery.

## Dashboard

Existing admin authentication remains mandatory and memory-only in the page. Service/complaint/block filters, visa records, private attachments, claim/release, staff verification actions, local automation pause and actual WhatsApp block/unblock are available. Native block requires Meta confirmation for the exact target. No customer is blocked automatically for filing a complaint. Ambiguous native outcomes stay paused pending reconciliation; no records or financial rights are erased.

## Verification and limitations

Tests cover signed ingress, isolated services, deterministic money, contextual edits, family/document ambiguities, late replies, privacy, takeover, idempotency, provider fallback, receipt state, file encryption, guarded staff actions and block ambiguity. Mock-provider tests establish integration, not actual live language quality. Live Cline replay must use isolated memory without customer sends. End-to-end government submission, banking confirmation, courier dispatch and phone answering are not automated in this release. They require their own integrations and verification. No unlimited intelligence or sales conversion guarantee is made.

Company bank accounts and the notification recipient are provisioned in a private AES-GCM encrypted configuration on the existing disk, not GitHub source.
