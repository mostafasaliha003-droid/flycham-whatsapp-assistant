# Ismail conversation upgrade — 2026-11-08

Ismail now distinguishes a price objection, explicit discount request, trust concern, comparison with another agency, approval-guarantee question, hesitation and a request to explain the last question. Reviewed replies acknowledge the concern and suggest one relevant next step. They do not create a discount, payment confirmation, application or approval. Existing company policy remains authoritative.

## Understanding and context

- The semantic instructions cover Syrian, Egyptian, Gulf, Jordanian, Lebanese and Yemeni dialects, multilingual input, code switching, corrections, quoted statements, negation and hypothetical questions. Dialect never determines nationality.
- The understanding request includes the awaited field, existing travel dates and up to sixteen redacted history messages. Documents, credentials and identifiers remain filtered.
- `informationIntents` allows up to six distinct informational topics in one turn. Only approved engine copy supplies the answers; secondary operational actions are rejected. The parser remains compatible with older decisions that omit this field.
- Unicode text and short numeric answers reach understanding. Clear Saudi visa/Umrah entry phrases in Urdu, Hindi, French, Russian and Turkish select the visa service without inferring nationality.
- Local safeguards prevent plural family words from inventing a passenger count, separate each applicant's document from its issuer, and distinguish negative/conditional cancellation and payment statements from requests. A cancellation confirmation must answer the immediately preceding cancellation question.

## Voice

The transcript parser accepts Unicode scripts and single numbers. Instructions require original language and dialect, including corrections and negation. An oversized transcript fails as incomplete instead of silently losing its ending. Understood audio gets a brief acknowledgment without repeating the transcript or requiring another confirmation. An unclear recording still requests clarification.

The existing `VOICE_TRANSCRIPTION` and `VOICE_ACCEPTANCE_APPROVED` rollout gate is unchanged. This commit does not configure providers, enable speech, send customer messages or deploy a service.

## Validation and limits

Tests use synthetic customers, mocked providers and the repository's offline network guard. They cover conversation state, compound questions, payment/cancellation separation, family scope, Unicode routing, voice parsing, privacy and signed webhooks. A pre-existing voice webhook fixture now freezes its clock before constructing the journal, so a fixed November 4 conversation does not expire when tests run later.

These checks establish code behavior, not real ASR accuracy or universal fluency. Customer-facing policy and consultation templates remain Arabic; this release does not provide automatic translation of every reply. Provider quality, noise and supported audio formats still constrain live speech understanding.

For a speech acceptance evaluation, use consented or synthetic recordings in each target dialect, including a noisy note, a single count, a correction at the end, mixed Arabic/English, denial of payment and denial of cancellation. Check the complete transcript and resulting case state, not just a pleasant-sounding response. No customer-facing claim of universal language accuracy should follow from mocked tests.
