# Air Arabia Abu Dhabi search correction — awaiting live validation

The reported customer problem is Abu Dhabi to Damascus returning no Air Arabia quote although the customer sees flights in the supplier portal.

## Findings

- Airport aliases and queue routing preserve AUH and put the requested Abu Dhabi Air Arabia search first. They do not silently replace it with Sharjah.
- `prepareSearch` previously forced Search G9 for all Air Arabia requests. The airline's official Damascus announcement identifies Abu Dhabi flights as 3L504/505. A synthetic DOM reproduction proves that the old code chooses G9 even when a 3L option is offered, or rejects a form offering only 3L. The actual current portal option labels and values still require signed-in observation; the reproduction is not live inventory evidence.
- Separately, production logs show the Air Arabia consumer blocked at 13:02:55 UTC on 25 October after an incomplete cold login. FlyCham continued. A process marked live does not establish a working Air Arabia session. This outage can itself explain missing Air Arabia comparisons.

## Prepared changes

For AUH on either end, select a uniquely enabled observed 3L option. If no explicit 3L label exists, allow only the uniquely observed normal Search All option. Never guess an option enum. Select the carrier before airport autocomplete, then revalidate the selected actual option together with route, dates, currency and passenger counts before Search. Ambiguous or unavailable controls fail as unverified, not as proof that flights are absent. SHJ G9 and FlyCham XH behavior remain covered.

A separate narrow login recovery permits one normal protected-page navigation after partial sign-in, only if the selected trusted popup is fully observable, has visible sign-out evidence and has no visible login, OTP, CAPTCHA, denial, invalid-credentials, password-change or concurrent-session response. Both normal authenticated controls are still required. No credential resubmission, verification bypass or open retry loop is introduced. The original incident included an unavailable child frame; this strict recovery intentionally does not bypass that uncertainty or guarantee recovery for that exact state.

## Validation and release gate

817 automated tests pass, including 32 carrier DOM cases and seven partial-login recovery cases. Focused compatibility tests pass 111/111. Tests cover AUH to Damascus and the reverse, Abu Dhabi to Aleppo, explicit 3L and observed Search All selection, disabled/ambiguous/foreign/reset forms, and unchanged SHJ/FlyCham behavior. They are mocked or synthetic DOM tests, not a completed live supplier search.

Do not merge to a deployed branch or trigger a production rollout until the signed-in portal shows the actual carrier selector and the Abu Dhabi to Damascus query has been exercised. Check actual flight timings and the verified final quote/ancillary flow on dates from the customer's request or an explicitly identified quote-only test. No ticket issuance, payment, changed margins, paid plan, new browser pool or hotel-system change is authorized by this correction.

The post-results carrier and search identity are an additional release blocker: the existing result reader accepts flight rows without explicitly binding them to the completed request's supplier search parameters. A synthetic counterexample accepts a stale SHJ/G9 row paired with an AUH caller request. Pre-submit field validation alone cannot establish that the returned result is AUH/3L or belongs to the requested date. Inspect the real supplier request/response fields while signed in, implement and test that binding, and reject mismatches as unverified before allowing a confirmed price. A broader Search All option is not evidence that every returned row is the intended carrier.

Live verification is currently blocked because the secure browser sign-in request timed out before a confirmed authenticated page. No production changes have been deployed for this correction.
