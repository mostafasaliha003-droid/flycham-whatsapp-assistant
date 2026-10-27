# Synthetic Browserless persistence probe

This standalone opt-in module is a **mock-tested prototype**, not a deployed
feature and not an implementation for the Saudi visa portal. It makes no MOFA
request, handles no login, and has no CAPTCHA processing or customer documents.

The proposed probe creates a five-minute Browserless Session API record with
`processKeepAlive=0` and `replay=false`. Within the created browser it routes
all network requests: the one fixed `https://persistence-test.invalid/` origin
is served an in-memory HTML fixture, all others are blocked. It writes a fixed
synthetic cookie and localStorage value, closes that browser, opens a second
connection and checks whether both values reappear. Finally it uses the
provider-returned stop URL, only if its path matches the exact returned session
ID, to permanently delete the test session. Result is
only booleans and fixed reason codes; provider exceptions and bearer URLs are
not returned or logged. It is disabled unless the caller opts in explicitly.

`node --test test/persist-probe.test.js` uses fakes, makes no provider calls,
and does not prove persistence works against Browserless. An ambiguous create
request or unconfirmed DELETE reports `CLEANUP_UNCONFIRMED`; this standalone
probe does not implement a lock that survives a process restart. A real provider
test would need a controlled runtime with Playwright installed and a private API
token, plus independent review of timeout races, restart-safe concurrent session
locking, credential handling and cleanup. No standalone service,
dashboard endpoint, retries, automatic scheduling or production integration is
included. The Session API connect and stop URLs contain credentials; never
print or store them in source, logs or messages. A successful DELETE is used as
cleanup confirmation; absence of a valid trusted stop URL is explicitly
reported as cleanup unconfirmed. Session TTL provides eventual expiry but is
not proof of immediate deletion.

Browserless documents that its Free plan provides up to one day of persisted
session storage, while a browser process has a two-minute maximum. Persisted
cookies and localStorage are not the same as a continuously running browser:
open pages, in-memory form inputs and prior page state are not retained after
restarting the browser. It remains unknown whether MOFA accepts a restored
session or whether the user's account permits this feature. Browserless may
process or store private session data; using it with actual account sessions
requires a separate informed decision and design. No private session is created
by this proof.

Official references:
https://docs.browserless.io/baas/session-management/persisting-state
https://docs.browserless.io/baas/session-management/standard-sessions
https://cloud.browserless.io/pricing
