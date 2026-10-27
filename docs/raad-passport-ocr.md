# Raad passport-page OCR pilot

This is an **experimental, default-off** local locator for a passport's data page and its right-angle orientation in an automatically prepared PDF. It is not a passport validator, identity check, document binding, application submission, or replacement for a visual review. It currently targets TD3 MRZs (two lines of 44 characters), one or two PDF pages, and rotations of 0, 90, 180, or 270 degrees. A unique candidate must pass all five implemented MRZ check digits; otherwise the result is unavailable, ambiguous, or not found. Never infer missing application fields from the absence of a match.

## Status and deployment prerequisites

* `RAAD_PDF_OCR_ENABLED` is effective only when set to the exact string `true`. Leave it unset or false in production until the checks below are complete. This pilot does not automatically install its dependencies or model.
* The worker requires `tesseract.js` as a direct, version-pinned dependency and an offline `assets/ocr/mrz.traineddata.gz` file. The exact deployment version is **not yet approved**. A local end-to-end trial used Tesseract.js 7.0.0; a separate Render synthetic benchmark used 6.0.1, so those trials do not establish deployment equivalence. Reproducibly lock the selected version and test its complete runtime before use.
* The candidate model is `tessdata_fast/mrz.traineddata` from [DoubangoTelecom/tesseractMRZ](https://github.com/DoubangoTelecom/tesseractMRZ). The expected SHA-256 of the **uncompressed** model is `ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01`; the worker checks it before use. Verify the model's origin and hash independently before packaging it. Do not bundle another model under that name.
* The upstream repository declares the BSD 3-Clause license, reproduced below. Its README says the training data included images sourced from Google and synthetic images; the provenance of the underlying images has not been independently verified. Verify suitability for the intended commercial distribution and reproduce the required license notice when distributing the model.
* Passing unit tests and one actual passport trial is not sufficient to enable this feature. Measure whole-container peak memory, timeout/cleanup and concurrency under representative WhatsApp and portal workloads in a separate environment with the production resource limit. Establish accuracy and false-match rates on a consented, representative set of document formats, page positions, rotations, scan quality and languages. A checksum match only confirms internal consistency, not the authenticity or identity of a holder.

## Privacy and handling

The OCR child is intended to run locally using a packaged model. Do not upload passport images, identity documents, recognized MRZ text, credentials, OTPs or customer data to external inference services, repositories, tickets, logs or test reports. The parent receives a match decision; persisted advisory fields are limited to sanitized status, page number and rotation. A matched result always requires staff review before document selection. Verify behavior in the deployed version rather than assuming this experimental code has been deployed.

PDF conversion uses private temporary files during processing; this is not equivalent to encrypting every intermediate file. Normal cleanup and stale-file recovery are best effort, including after process interruption. Review access controls, retention, cleanup and encryption before processing customer documents at scale. Use synthetic fixtures for routine automated testing; handle any consented real-document samples in a restricted environment and report aggregate results only.

## Safe validation

1. Run the focused MRZ, OCR process, PDF intake and lock tests, then the full project suite. Unit tests with mocks do not prove model accuracy or production provisioning.
2. Validate a version-pinned worker and model completely offline, including both successful and unsuccessful recognition, checksum failures, duplicate candidates, invalid inputs, deadlines, and cleanup after child or image-processing failures. Ensure failures do not return identity text or create a document binding.
3. Use consented representative documents and synthetic fixtures to evaluate the full pipeline, including both pages and all supported rotations. Track false positives and misses; a handful of examples is not a representative benchmark.
4. In isolated staging, measure the peak memory and response latency of the whole service under concurrent workloads. Verify that OCR timeouts do not leave background processing active and that the shared lock is released only after cleanup is confirmed. Keep the feature disabled if results are inconclusive.
5. Review the actual portal workflow separately. A page suggestion does not upload a file, confirm information, accept terms or submit an application.

## Upstream model license notice

The candidate MRZ model is from DoubangoTelecom/tesseractMRZ, whose [LICENSE](https://github.com/DoubangoTelecom/tesseractMRZ/blob/master/LICENSE) states:

```text
BSD 3-Clause License

Copyright (c) 2019, DoubangoTelecom
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
