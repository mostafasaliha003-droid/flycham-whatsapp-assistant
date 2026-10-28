# Email verification extension

The user observed delivery of an email verification code after visitor login.
That is evidence of an additional challenge, not proof of authenticated access.

The pilot must only use verification controls actually observed on the official
visa.mofa.gov.sa page. Prioritize a visible verification dialog before the login
form beneath it. Send a user-entered code once per pilot session; never read
email, log/store a code, automatically retry it, or infer login success merely
from disappearance of the password input. A deploy resets the in-memory browser.
