# MOFA tourist form observations: 27 October 2026

These observations come from authorized TinyFish inspection of a real blank MOFA
form. They describe a particular page state, not universal eligibility rules or
an implemented Render executor. No real applicant was selected, no customer
documents were uploaded, and no application was saved/submitted or paid.

## Navigation and legal gates

The public SmartForm link initially redirected to the MOFA home page. A saved
TinyFish Browser Context Profile subsequently showed an authenticated welcome
header, avatar and account dropdown and reached My Applications. Its **Add A New
Application** link opened [Agreement](https://visa.mofa.gov.sa/SmartForm/Agreement).
The profile's `signed_in_sites` metadata remained empty; that metadata and a
generic login link alone cannot establish that the browser is logged out.

The first page, **VISA Portal Services Agreement**, had **I AGREE**, Back and Close
controls. It described acceptance as a legally binding signature, USD 10
processing plus USD 0.50 banking fees per visa, nonrefundability of platform fees
once paid, information processing/sharing with Saudi government authorities, and
service, warranty and liability limitations. Those component fees are not the
total visa or insurance cost.

After fresh action-time approval, **I AGREE** was clicked once and opened
[Electronic Agreement](https://visa.mofa.gov.sa/SmartForm/ElectronicAgreement).
Its 11 declarations included biometric consent, truthful-data and prior GCC
deportation/rule-violation pledges, visitor-purpose and departure commitments, and
acknowledgements of applicable rules and penalties. After separate fresh approval,
its **Agree** control was clicked once and opened the blank
[Traditional Application](https://visa.mofa.gov.sa/SmartForm/TraditionalApp).

Reading an agreement is an inspection step; clicking its binding acceptance is
the consent boundary. Approval for those two agreements and a general request to
accept future terms do not replace specific approval for another legal gate or
truthful declarations about a selected applicant.

## Visible tourist controls

Selecting `VisaKind` value `19`, labelled **Tourism Visit**, exposed the tourist
layout. The following control names were actually observed and can inform a
local mapping preview. They still require revalidation against the live state
before any executor uses them.

| Observed control | Meaning or limitation |
| --- | --- |
| `VisaKind` | `19`: Tourism Visit |
| `ddlResidenceCountry` | United Arab Emirates label observed; underlying value not confirmed here |
| `EmbassyCode` | Abu Dhabi `214`; Dubai `230`. Agency policy always selects Abu Dhabi |
| `AFIRSTNAME`, `AFATHER`, `AGRAND`, `AFAMILY` | Separate Arabic name controls; use only separately provided facts |
| `EFIRSTNAME`, `EFATHER`, `EGRAND`, `EFAMILY` | Separate Latin name controls; do not infer father/grandfather components |
| `PASSPORTnumber` | Passport number |
| `BIRTH_PLACE` | Birth place |
| `ADDRESS_HOME` | Visible label: KSA Home Address; do not assume it means UAE residence address |
| `PASSPORT_ISSUE_DATE`, `PASSPORT_EXPIRY_DATe` | Date controls observed; accepted format remains unverified |
| `BIRTH_DATE`, `ExpectedEntryDate` | Date controls observed; accepted format remains unverified |
| `MobileInfo.Mobile` | Phone number control; separate country-prefix behavior remains unverified |

## Unresolved mappings and conditional behavior

- Nationality inspection produced conflicting reports. The actual underlying
  nationality input remains unverified; `ddlNationality` is not a confirmed
  selector.
- A generic nationality inspection showed Single `0` and Multiple `1`, while
  residence and mission still displayed Select. This does not establish the
  result for UAE residence/Abu Dhabi or verify 90/365-day visa validity, stay
  duration, or eligibility. Egypt single/90 versus other supported tourist
  multiple/365 remains office policy pending portal verification.
- The final focused UAE/Syrian/multiple-entry inspection completed without
  satisfying its selection postconditions. Tourism and Syrian nationality were
  displayed, but residence was Australia after an accidental unsaved generic
  choice and mission remained Select. Single `0` and Multiple `1` were visible;
  validity and stay duration were not inspected. This is an inconclusive route
  configuration, not evidence of UAE restrictions or supported durations.
- A GCC category label referred to at least three months of residence. This
  observation is not a complete eligibility assessment for a particular case.
- Upload controls, accepted document types, sizes and portal behavior have not
  been fully verified. JPEG/PNG under 1,000,000 bytes is the existing local
  preparation rule, not a newly proven live portal limit.
- An Unemployed label and `Has_Job` naming had unclear semantics. Neither the
  option mapping nor a default employment answer is established.
- Sponsor, degree and religion controls became hidden after tourism selection
  in one run. That does not prove they are unnecessary for every applicant or
  later conditional state.
- Date formats, phone-prefix semantics, full document upload behavior, OTP,
  insurance, payment, official PDF capture and customer delivery remain
  unverified. No hidden GUIDs or unverified control metadata are retained here.

See [Raad preparation](RAAD-PREPARATION.md) for the local revision/case/staff
guards, the `preview_mapping` action with `canExecute: false`, the separately
implemented read-only provider configuration check, and the remaining TinyFish
integration gaps. Portal inspection ended with the inconclusive configuration
above; dates, GCC permit fields and uploads remain unverified.
