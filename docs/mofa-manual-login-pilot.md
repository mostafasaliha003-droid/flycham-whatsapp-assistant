# Manual MOFA login pilot (local only)

This opt-in experiment opens the fixed Saudi MOFA individual login page in a
Browserless remote browser and allows an authorized staff member to interact
manually. It never reads the portal DOM, reads or solves CAPTCHA, enters
credentials, uploads an applicant file, sends a form, or submits an application.
It is NOT a government application executor or proof of successful login.

The private link is only returned once through the shared admin-authenticated
endpoint. This is not individual staff identification: the Browserless URL itself
can be reused until it expires and grants its holder control. It must not be
shared. Browserless processes the remote session, potentially including sensitive
login data. Obtain informed authorization before testing with real credentials.
The connection explicitly sets `record=false` and `replay=false`; neither setting
proves a provider does not retain other session data. Investigate contractual
terms, provider controls and retention separately before real personal documents.

The default-off `RAAD_MOFA_LOGIN_PILOT_ENABLED` and synthetic flags are mutually
exclusive: when both are true neither pilot can start. This is not a distributed
lock, and does not protect against multiple instances or old provider sessions
across deployment/restart. The job and in-memory link cannot survive a restart.
Reloading the UI loses the job ID. No re-start should be done until a prior
provider session is confirmed closed if cleanup is uncertain.

## Time limits

The default (`RAAD_MOFA_SESSION_PROFILE` omitted or set to `free`) requests a
120-second provider session, with a 90-second live URL and a 110-second
application deadline. Network latency and manual authentication may consume
part of that time.

Only after an operator has verified a Browserless plan allowing 15-minute
sessions and the user has approved the price may an isolated testing service
set `RAAD_MOFA_SESSION_PROFILE=prototyping_15m`. That profile requests a
900-second provider session, an 840-second live URL, and an 880-second
application deadline. These are upper limits, not guaranteed usable time;
Browserless may enforce shorter values or reject the request. This setting does
not verify, purchase, or upgrade the subscription and may incur usage charges.
Any other profile value fails closed before opening a browser. Never deploy the
paid profile assuming a Free account supports it.

The private link remains a bearer capability for a longer time under the paid
profile; any holder may control the session until expiry. Restrict delivery and
use cancellation promptly. A longer browser session still does not prove login,
preserve a session after closure, restore forms, or automate an application.

After Done the browser stays open until a time-bounded, authenticated admin
check or expiry. The read-only check confirms only that the same browser is
connected and its page remains open on the official hostname; a bounded CDP
layout-metrics command also confirms the remote target responds, discarding
the result. It navigates nowhere, reads no DOM and does not prove login or
page function; it then
closes the browser. The provider URL can still be used until expiry, including
after Done, so no actions on sensitive data should occur during this check.
It cannot continue an application. A later executor requires reliable login
indicators, secure delivery, tests and separate approval before applicant data
is sent to Browserless.

Verified mocked-node tests do not verify the remote provider, MOFA connectivity,
manual login success, liveURL permissions, browser shutdown or session retention.
Don't deploy this prototype into the live assistant as-is. Never log the token,
private liveURL, portal URLs that contain session data, DOM, credentials, codes,
or client data. Any logs need redaction before reporting or sharing.
