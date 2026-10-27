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

The free-plan test has at most 90 seconds for the handoff and 110 seconds total;
network latency and manual authentication may exceed that. On Done the session
closes and login remains explicitly unverified. It cannot continue an application
in the same session. A later executor requires a genuinely preserved browser
session, verified reliable login indicators, secure delivery, tests and separate
approval before any applicant information is sent to Browserless.

Verified mocked-node tests do not verify the remote provider, MOFA connectivity,
manual login success, liveURL permissions, browser shutdown or session retention.
Don't deploy this prototype into the live assistant as-is. Never log the token,
private liveURL, portal URLs that contain session data, DOM, credentials, codes,
or client data. Any logs need redaction before reporting or sharing.
