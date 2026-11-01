# Regenerated local intake slice

This standalone recovery tool was authored outside the Git-backed application after temporary v16 files disappeared. It does not contain the application, its downloaded source payloads, dependencies, OCR model, customer state, credentials, or browser assets. The scenario was regenerated and run once; it does not reconstruct the missing historical transcript.

Required immutable inputs:

- Application commit `46963b57c5490afcd2e9da15468cce52234f931a`, tree `3c67dbdd818448f102395581a8dac32004eca5d2`, all 445 files.
- The newly recovered metadata-only freeze with SHA256 `4b03f12a2c7d0af6e7c9dc6c1decb8dbbe588f22105fd40ff12dbdd120bb5c3c`, shipped separately as source-recovery evidence. This is not the missing historical freeze.
- Checksum-pinned Node 26.13.0 binary SHA256 `0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b` and separately installed matching application dependencies. The tool does not install or fetch them.
- The application-owned parser `.ci/raad-readiness/test-tools/tap_log_evidence.py` in that commit, SHA256 `ecd59e282cc3463265f68b8eab4bf3c1c6e4710e5097def471795296075f5827`. That Git-backed file is referenced, not duplicated here.

The runner is disabled without `--enable`. Explicit execution:

```sh
python3 run-slice.py --enable --source /absolute/recovered/application --freeze /absolute/candidate-source-freeze.json --node /absolute/pinned/node --output /absolute/new-evidence-directory
python3 project-tap.py --run /absolute/new-evidence-directory --source /absolute/recovered/application
```

Source hashes and Git executable modes are checked before imports and after the run. The child receives a small explicit environment without inherited application credentials. A JavaScript fence rejects external network, native HTTP sockets and child process use; it is not an OS sandbox. All allowed transports are injected callbacks with exact synthetic route checks.

The single scenario composes real upload handling and encrypted media, unpaid intake, accountant HTTP handling and Inbox ownership, the real WhatsApp adapter with fake held acceptance, explicit client questions and confirmation, then the real dispatcher and worker handler. The injected portal flow reaches the immutable `RAAD_TEST_SUBMISSION_BLOCKED` fence, without any browser action. Repeated work does not create another job, OCR read, payment notice or worker start.

The run measured three injected document reads, one upload completion, one finance action, one payment notice, 17 explicit client answers, two confirmation rounds, 20 fake Graph acceptances, one worker start/flow, two coordinator lease checks and one owned close. Repeating the payment approval caused an ordinary second Inbox claim/release but no second finance action or fulfilment job.

The raw Node capture has one real finite diagnostic line inside its TAP output. It remains byte-identical in `slice.tap`; the separate postprocessor indexes that exact line's offset/size/hash and writes the unchanged remaining bytes to `canonical-slice.tap`. Both raw and canonical output plus the projection record are evidence. This does not rerun the application or synthesize any TAP result/footer.

Limits: the initial quoted case is synthetic and already seeded. This is in-process handler composition, not full main-webhook/native-HTTP delivery or a real customer journey. OCR, Graph and portal outputs are fixtures; no actual bank, Meta, SMS, government, provider, model, browser or fee operation occurs. It uses the local unprofiled reader path. It does not establish remote-model accuracy, a production restore, visual QA or security clearance. Source and evidence/toolkit allowlists are separate.
