# Fly Cham pricing and REMAL vouchers

## Implemented

- `flycham-first-page.js`: read selected outbound/return flight timings and the **explicit AED total displayed by the supplier**, including the AED equivalent when the base quote is USD. Never computes its own exchange rate, enters passenger details, or opens ancillary/payment tabs. Ambiguous currency or missing return leg fails closed. This adapter has fixture tests; a deployed Fly Cham quote worker is not connected yet.
- `flycham-pricing.js`: one adult only until multi-passenger supplier pricing is validated. One-way adds AED 40 and promises AED 10 future voucher; return adds AED 90 and promises AED 25. The gift does not reduce the current fare. No seat/meal fee checks or margins for Fly Cham. Existing Air Arabia policy unchanged.
- `vouchers.js`: SQLite ledger with a unique confirmed-ticket/passenger source. AES-GCM encrypts name/token and redemption reference; QR contains a random verification token. Issuance restricted to staff-asserted confirmed Fly Cham tickets, not quotes or other airlines. Repeating the same source returns the existing voucher, preventing repeated credit. Calendar-year expiry uses Dubai time, including leap-day handling.
- Atomic conditional redemption prevents two staff sessions redeeming one voucher twice. Cancellation, expiry, used and invalid states are distinct. Scanning the QR is read-only and never consumes the voucher. No partial-use or stacking feature is enabled; those policies have not been agreed.
- `voucher-image.js`: named PNG with original supplied REMAL logo, QR, amount, issue and expiry dates; all assets rendered locally. Preview is marked DEMO — NOT VALID.
- `/vouchers-admin`: staff interface, protected API bearer key, no localStorage. Issue, preview/download, explicitly send PNG to a reviewed WhatsApp number, redeem against a service reference or cancel. Meta acceptance is not delivery confirmation.
- Public `/vouchers/verify/:token` shows only status, value, expiry and short voucher reference, not customer names/contacts, and is rate limited.

## Activation requirements — not configured by this change

1. Node >=22.13 (SQLite built-in).
2. Durable disk attached to the WhatsApp service. The current free web service has no durable disk. Issuance is blocked with `VOUCHER_DURABLE_STORAGE_REQUIRED` until the database path is detected under an actual non-root mounted filesystem. An ephemeral file or merely setting a flag is insufficient. Do not attach any hotel service disk.
3. Configure `VOUCHER_DB_PATH` under that mount, e.g. `/var/data/remal/vouchers.sqlite`.
4. User supplies `VOUCHER_ENCRYPTION_KEY` and `ASSISTANT_ADMIN_KEY` securely in Render; keep encryption key backed up and stable. Losing it makes stored voucher names/tokens unreadable. Use separate random secrets of at least 32 characters.
5. `PUBLIC_APP_ORIGIN=https://flycham-whatsapp-assistant.onrender.com` (or a reviewed HTTPS domain). Existing WhatsApp credentials are used only server-side to upload/send images.
6. Fly Cham worker session/secrets and multi-provider quote routing are still required before automatic Fly Cham WhatsApp quotes work. Cloud Browser login is not a Render worker login; do not copy cookies.

No resource plans, disks, production hotel systems or secrets were changed. Do not claim vouchers are live or promise immediate issuance while durable storage/admin configuration is missing.
