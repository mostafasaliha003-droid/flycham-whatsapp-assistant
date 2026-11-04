# Cline single-turn diagnostic — November 2026

Status: **completed**. Policy: `eb7cd36887c85cb9790d815e44ef73df56f4148b082da416c2cb5637a537e082`.

This is a focused diagnostic of explicitly selected models, not a new all-model ranking. The original 15-model batch report remains unchanged. Each request uses the actual consultant instructions, schema, context guide and bounded repair path. Three runs of the same 20 synthetic cases are required per selected model. Latency is measured per individual turn, including a repair when needed.

| Model | Turns | Average | Minimum | Valid | p50 ms | p95 ms | Qualified in this diagnostic |
|---|---:|---:|---:|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 60/60 | 96 | 95 | 60/60 | 3778 | 11486 | Yes |
| cline-pass/kimi-k3 | 60/60 | 98.5 | 98 | 60/60 | 7489 | 12752 | Yes |

Gate unchanged: average >= 90, minimum >= 85, 60/60 valid decisions, p95 <= 15 seconds. All failures count; no timeout is silently retried or removed. This diagnostic does not authorize a production model change.

| Model | Run | Case | Passed checks | Valid | Latency ms | Requests | HTTP | Error |
|---|---:|---|---:|---|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 1 | complete_trip | 10/10 | Yes | 3168 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | preserve_week | 10/10 | Yes | 3115 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | inquiry_not_selection | 8/10 | Yes | 3197 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | price_objection | 10/10 | Yes | 6261 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | knowledge_routing | 10/10 | Yes | 3033 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | waiting_context | 10/10 | Yes | 3910 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | gulf_family | 10/10 | Yes | 3690 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | egyptian_solo | 8/10 | Yes | 5354 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | iraqi_family | 9/10 | Yes | 4343 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | partial_round_trip | 10/10 | Yes | 3469 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | advice_during_search | 10/10 | Yes | 3329 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | frustrated_request | 10/10 | Yes | 3834 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | urgent_request | 10/10 | Yes | 2675 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | sarcasm_not_booking | 9/10 | Yes | 4342 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | indic_digits | 10/10 | Yes | 5954 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | first_friday_next_month | 10/10 | Yes | 4337 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | child_age | 10/10 | Yes | 3427 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | explicit_rejection | 10/10 | Yes | 2811 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | payment_question | 10/10 | Yes | 4230 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | delete_data | 8/10 | Yes | 4086 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | complete_trip | 10/10 | Yes | 3143 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | preserve_week | 10/10 | Yes | 2623 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | inquiry_not_selection | 8/10 | Yes | 3562 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | price_objection | 10/10 | Yes | 6586 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | knowledge_routing | 10/10 | Yes | 2152 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | waiting_context | 10/10 | Yes | 3608 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | gulf_family | 9/10 | Yes | 3682 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | egyptian_solo | 8/10 | Yes | 6156 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | iraqi_family | 10/10 | Yes | 3886 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | partial_round_trip | 10/10 | Yes | 3455 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | advice_during_search | 10/10 | Yes | 3747 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | frustrated_request | 10/10 | Yes | 4761 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | urgent_request | 10/10 | Yes | 3376 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | sarcasm_not_booking | 9/10 | Yes | 5643 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | indic_digits | 10/10 | Yes | 2984 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | first_friday_next_month | 10/10 | Yes | 11545 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | child_age | 10/10 | Yes | 3927 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | explicit_rejection | 10/10 | Yes | 2663 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | payment_question | 9/10 | Yes | 9102 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | delete_data | 7/10 | Yes | 5375 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | complete_trip | 10/10 | Yes | 3079 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | preserve_week | 10/10 | Yes | 5635 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | inquiry_not_selection | 8/10 | Yes | 3106 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | price_objection | 10/10 | Yes | 8128 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | knowledge_routing | 10/10 | Yes | 2595 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | waiting_context | 10/10 | Yes | 2981 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | gulf_family | 10/10 | Yes | 6995 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | egyptian_solo | 8/10 | Yes | 13736 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | iraqi_family | 9/10 | Yes | 3301 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | partial_round_trip | 10/10 | Yes | 8496 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | advice_during_search | 10/10 | Yes | 7579 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | frustrated_request | 10/10 | Yes | 2695 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | urgent_request | 10/10 | Yes | 11486 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | sarcasm_not_booking | 9/10 | Yes | 3881 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | indic_digits | 10/10 | Yes | 10331 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | first_friday_next_month | 10/10 | Yes | 3977 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | child_age | 10/10 | Yes | 2789 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | explicit_rejection | 10/10 | Yes | 3042 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | payment_question | 10/10 | Yes | 11875 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | delete_data | 10/10 | Yes | 3778 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | complete_trip | 10/10 | Yes | 4006 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | preserve_week | 10/10 | Yes | 6847 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | inquiry_not_selection | 10/10 | Yes | 7489 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | price_objection | 10/10 | Yes | 10624 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | knowledge_routing | 10/10 | Yes | 4209 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | waiting_context | 10/10 | Yes | 14543 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | gulf_family | 10/10 | Yes | 9650 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | egyptian_solo | 9/10 | Yes | 9502 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | iraqi_family | 10/10 | Yes | 6575 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | partial_round_trip | 10/10 | Yes | 4938 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | advice_during_search | 10/10 | Yes | 11001 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | frustrated_request | 10/10 | Yes | 6087 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | urgent_request | 10/10 | Yes | 4466 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | sarcasm_not_booking | 10/10 | Yes | 16404 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | indic_digits | 10/10 | Yes | 7784 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | first_friday_next_month | 10/10 | Yes | 12752 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | child_age | 10/10 | Yes | 5542 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | explicit_rejection | 10/10 | Yes | 5739 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | payment_question | 10/10 | Yes | 10194 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | delete_data | 7/10 | Yes | 9764 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | complete_trip | 10/10 | Yes | 4294 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | preserve_week | 10/10 | Yes | 8776 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | inquiry_not_selection | 10/10 | Yes | 7887 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | price_objection | 10/10 | Yes | 12425 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | knowledge_routing | 9/10 | Yes | 3581 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | waiting_context | 10/10 | Yes | 5299 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | gulf_family | 10/10 | Yes | 6968 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | egyptian_solo | 8/10 | Yes | 10354 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | iraqi_family | 10/10 | Yes | 6262 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | partial_round_trip | 10/10 | Yes | 4181 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | advice_during_search | 10/10 | Yes | 10923 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | frustrated_request | 10/10 | Yes | 3777 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | urgent_request | 10/10 | Yes | 10020 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | sarcasm_not_booking | 10/10 | Yes | 9367 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | indic_digits | 10/10 | Yes | 9838 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | first_friday_next_month | 10/10 | Yes | 8941 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | child_age | 10/10 | Yes | 6549 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | explicit_rejection | 10/10 | Yes | 7666 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | payment_question | 10/10 | Yes | 7721 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | delete_data | 10/10 | Yes | 8399 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | complete_trip | 10/10 | Yes | 4528 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | preserve_week | 10/10 | Yes | 11730 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | inquiry_not_selection | 10/10 | Yes | 7209 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | price_objection | 10/10 | Yes | 7199 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | knowledge_routing | 9/10 | Yes | 4505 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | waiting_context | 10/10 | Yes | 5829 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | gulf_family | 10/10 | Yes | 6436 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | egyptian_solo | 9/10 | Yes | 8243 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | iraqi_family | 10/10 | Yes | 12157 | 2 | 200 | — |
| cline-pass/kimi-k3 | 3 | partial_round_trip | 10/10 | Yes | 5053 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | advice_during_search | 10/10 | Yes | 6979 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | frustrated_request | 10/10 | Yes | 5904 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | urgent_request | 10/10 | Yes | 6741 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | sarcasm_not_booking | 10/10 | Yes | 9193 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | indic_digits | 10/10 | Yes | 8812 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | first_friday_next_month | 10/10 | Yes | 6746 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | child_age | 10/10 | Yes | 7130 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | explicit_rejection | 10/10 | Yes | 8950 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | payment_question | 10/10 | Yes | 8901 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | delete_data | 10/10 | Yes | 18806 | 1 | 200 | — |

Synthetic metadata only: no keys, customer data, generated replies or model-setting writes. HTTP 401/402/429 stops the entire run immediately. Partial runs are not qualified. Owner review is required before production configuration changes.

Captured from the completed Render temporary diagnostic at `2026-11-04T16:03:56.734Z`. Consultant source: commit `4213fe0e1a463786d435dc6710a5624a16914e16` (SHA-256 `cb95ec2f5f6e0dd925cecc8f76101e15ef624a4e6447952fef5985322571ec3a`). The unchanged pre-fix run is in `cline-single-turn-baseline-2026-11.md`. The prompt now states the same action/intent pairs that the validator has always enforced, and routes unsupported knowledge answers to application-owned copy. No validation rule or readiness threshold was relaxed.
