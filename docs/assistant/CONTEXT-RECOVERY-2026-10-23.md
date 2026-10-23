# Conversation context repair — prepared, not activated

Scope: only flycham-whatsapp-assistant. No hotel resources, portal worker, prices, commissions or provider credentials are modified.

## Observed failures

- The older screenshot repeats the departure airport while the destination is unresolved. Local parsing already avoided some identical endpoints, but a later model patch could bypass that guard and the repeated-question suppression produced a vague waiting message.
- The newer screenshot supplies Sharjah–Aleppo, next Sunday and one adult, then replies one-way. Render logs place the two answers on distinct instances. Runtime state is memory-only; additional service-update/manual deployments at 15:36 UTC explain the lack of shared context. Successful Cline calls were observed at 15:38:29 and 15:39:45 UTC. Model availability alone does not preserve conversation state.

## Prepared changes

- Reconcile airport direction after model/local patches. A bare repetition confirms a known endpoint and cannot fill the opposite endpoint. Explicit customer direction outranks a conflicting extraction. Canonical equivalent airports never produce a complete same-airport route.
- Resolve confusion with an acknowledgement and one concrete missing fact. Keep dates, party and other details. Refresh Cline instructions accordingly.
- Auto-enable encrypted state only when `/var/data` is an actual dedicated ext4/xfs/btrfs mount. An ordinary ephemeral directory does not count. Snapshot filename is `/var/data/assistant-state.enc`.
- Reuse the configured state key or stable WhatsApp App Secret without reading or distributing its value. Save with restrictive permissions, flush file data, atomically rename, and flush the containing directory on Linux.
- Health reports configured storage separately from detected persistent mount. Existing 55,000ms production debounce remains unchanged.

## Activation pending cost approval

Web service `srv-dbc7hlbrjlhs73b3n3k0` is currently paid 0.5c-512mb with one instance and auto-deploy disabled. Attach a 1GB disk mounted at `/var/data` to this service only. Render's current disk rate is $0.25/GB/month (checked 2026-10-23, https://render.com/pricing). No new compute plan is needed. A disk prevents concurrent rolling instances and entails a brief deploy interruption. Attaching triggers deployment of main; no extra deploy should be triggered.

The code is prepared in main; no new deploy or disk charge has been initiated for this change. Approve storage cost before attaching. Once attached verify the exact new commit is live, `persistentStorageConfigured` and `durableStorageConfirmed` are true, `messageWindowMs` is 55000, and Meta connection check succeeds. Then run a fresh WhatsApp test. Previously lost in-memory conversation cannot be recovered from this patch. Stable encryption key is required across deploys.

## Validation

233 tests pass, including the exact repeated-airport sequence with and without an erroneous model extraction, canonical identical-airport rejection, full latest screenshot sequence, and continuation after clearing runtime sessions and reloading encrypted state. Mount detection rejects overlay/tmpfs/root-only paths; state remains ciphertext and a wrong key fails closed.

Aleppo pricing is still outside the connected pilot. Correctly understanding that request must not be represented as verified Aleppo availability or a confirmed fare.
