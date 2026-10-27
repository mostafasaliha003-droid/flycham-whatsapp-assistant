# Raad local MOFA form prototype

`src/raad-mofa-mock.js` is an isolated synthetic-only Playwright test harness. It is not connected to the server or a government portal. It accepts no URL, refuses any page whose current URL is not `about:blank`, blocks network requests while populating its own fixed HTML fixture, and is disabled unless the caller explicitly passes `enabled: true`.

The test harness accepts only the fixed synthetic field values and three synthetic images returned by its own helper functions. It accepts image buffers in memory and rejects all other data. It does not click agreements, answer health questions, submit a form, save an application, pay, or use an OTP. It must not receive applicant documents or personal details.

Some fixture text IDs reproduce previously observed labels for testing purposes only. The fixture upload IDs (`mock-passport`, `mock-residence`, and `mock-photo`) are invented. **Current portal selectors, control types, option values, document upload behavior, and authenticated session behavior have not been verified by this prototype.** A passing mock test is not evidence of a working MOFA integration or consent to submit.

Run `node --test test/raad-mofa-mock.test.js`. The unit tests use a Page test double; a separate test launches a real local Chromium browser only if Playwright's Chromium executable is installed. On the current development machine that browser test was **skipped** because Chromium is unavailable. Install and validate it in an isolated test environment before treating the Playwright browser path as tested. Do not install software on, or test customer data against, the production service for this purpose.

Before building a real connector, independently verify the actual portal controls and allowed workflow, review applicant-specific facts and documents, and test access control, session expiry, failures and duplicate prevention. Keep this prototype disconnected until those requirements are met.
