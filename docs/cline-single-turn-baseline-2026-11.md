# Cline single-turn diagnostic — November 2026

Status: **completed**. Policy: `4da9553c1d44c5f225b5b5eeeb93f3a05dea877ea2c4c8b235131c4071006d67`.

This is a focused diagnostic of explicitly selected models, not a new all-model ranking. The original 15-model batch report remains unchanged. Each request uses the actual consultant instructions, schema, context guide and bounded repair path. Three runs of the same 20 synthetic cases are required per selected model. Latency is measured per individual turn, including a repair when needed.

| Model | Turns | Average | Minimum | Valid | p50 ms | p95 ms | Qualified in this diagnostic |
|---|---:|---:|---:|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 60/60 | 92 | 89.5 | 58/60 | 4705 | 14403 | No |
| cline-pass/kimi-k3 | 60/60 | 90.83 | 83.5 | 57/60 | 8287 | 20221 | No |

Gate unchanged: average >= 90, minimum >= 85, 60/60 valid decisions, p95 <= 15 seconds. All failures count; no timeout is silently retried or removed. This diagnostic does not authorize a production model change.

| Model | Run | Case | Passed checks | Valid | Latency ms | Requests | HTTP | Error |
|---|---:|---|---:|---|---:|---:|---:|---|
| cline-pass/deepseek-v4.1-flash-1017 | 1 | complete_trip | 10/10 | Yes | 3542 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | preserve_week | 10/10 | Yes | 3051 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | inquiry_not_selection | 8/10 | Yes | 3996 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | price_objection | 6/10 | Yes | 14618 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | knowledge_routing | 7/10 | Yes | 7537 | 2 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | waiting_context | 10/10 | Yes | 3643 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | gulf_family | 10/10 | Yes | 6370 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | egyptian_solo | 9/10 | Yes | 4858 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | iraqi_family | 10/10 | Yes | 12903 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | partial_round_trip | 10/10 | Yes | 3832 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | advice_during_search | 10/10 | Yes | 3915 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | frustrated_request | 10/10 | Yes | 12956 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | urgent_request | 10/10 | Yes | 14059 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | sarcasm_not_booking | 9/10 | Yes | 5797 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | indic_digits | 10/10 | Yes | 3023 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | first_friday_next_month | 10/10 | Yes | 4035 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | child_age | 10/10 | Yes | 14164 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | explicit_rejection | 0/10 | No | 9478 | 2 | 200 | NLU_INVALID_SCHEMA_CONSULTANT_ACTION_INTENT_MISMATCH |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | payment_question | 10/10 | Yes | 4860 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 1 | delete_data | 10/10 | Yes | 4843 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | complete_trip | 10/10 | Yes | 3403 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | preserve_week | 10/10 | Yes | 2681 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | inquiry_not_selection | 8/10 | Yes | 3495 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | price_objection | 8/10 | Yes | 15968 | 2 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | knowledge_routing | 7/10 | Yes | 13954 | 2 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | waiting_context | 10/10 | Yes | 14403 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | gulf_family | 10/10 | Yes | 5713 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | egyptian_solo | 10/10 | Yes | 4705 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | iraqi_family | 10/10 | Yes | 4704 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | partial_round_trip | 10/10 | Yes | 2815 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | advice_during_search | 10/10 | Yes | 9596 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | frustrated_request | 10/10 | Yes | 4075 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | urgent_request | 10/10 | Yes | 3358 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | sarcasm_not_booking | 10/10 | Yes | 5549 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | indic_digits | 10/10 | Yes | 2892 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | first_friday_next_month | 10/10 | Yes | 3969 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | child_age | 10/10 | Yes | 5872 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | explicit_rejection | 8/10 | Yes | 10640 | 2 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | payment_question | 10/10 | Yes | 4457 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 2 | delete_data | 10/10 | Yes | 3298 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | complete_trip | 10/10 | Yes | 2689 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | preserve_week | 10/10 | Yes | 3451 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | inquiry_not_selection | 8/10 | Yes | 11249 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | price_objection | 9/10 | Yes | 8443 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | knowledge_routing | 7/10 | Yes | 15378 | 2 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | waiting_context | 10/10 | Yes | 3055 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | gulf_family | 10/10 | Yes | 4151 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | egyptian_solo | 9/10 | Yes | 4558 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | iraqi_family | 10/10 | Yes | 3571 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | partial_round_trip | 10/10 | Yes | 3084 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | advice_during_search | 10/10 | Yes | 5653 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | frustrated_request | 10/10 | Yes | 3244 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | urgent_request | 10/10 | Yes | 3566 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | sarcasm_not_booking | 9/10 | Yes | 5984 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | indic_digits | 10/10 | Yes | 4772 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | first_friday_next_month | 10/10 | Yes | 5480 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | child_age | 10/10 | Yes | 13023 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | explicit_rejection | 0/10 | No | 8543 | 2 | 200 | NLU_INVALID_SCHEMA_CONSULTANT_ACTION_INTENT_MISMATCH |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | payment_question | 10/10 | Yes | 4646 | 1 | 200 | — |
| cline-pass/deepseek-v4.1-flash-1017 | 3 | delete_data | 10/10 | Yes | 6846 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | complete_trip | 10/10 | Yes | 7011 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | preserve_week | 10/10 | Yes | 6623 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | inquiry_not_selection | 10/10 | Yes | 8776 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | price_objection | 8/10 | Yes | 24194 | 2 | 200 | — |
| cline-pass/kimi-k3 | 1 | knowledge_routing | 9/10 | Yes | 6268 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | waiting_context | 10/10 | Yes | 7846 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | gulf_family | 10/10 | Yes | 9143 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | egyptian_solo | 9/10 | Yes | 8570 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | iraqi_family | 10/10 | Yes | 9419 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | partial_round_trip | 10/10 | Yes | 5263 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | advice_during_search | 10/10 | Yes | 8287 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | frustrated_request | 10/10 | Yes | 3642 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | urgent_request | 10/10 | Yes | 8101 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | sarcasm_not_booking | 9/10 | Yes | 8090 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | indic_digits | 10/10 | Yes | 8930 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | first_friday_next_month | 10/10 | Yes | 18326 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | child_age | 10/10 | Yes | 9041 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | explicit_rejection | 10/10 | Yes | 4741 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | payment_question | 10/10 | Yes | 10735 | 1 | 200 | — |
| cline-pass/kimi-k3 | 1 | delete_data | 9/10 | Yes | 13383 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | complete_trip | 10/10 | Yes | 4070 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | preserve_week | 10/10 | Yes | 5604 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | inquiry_not_selection | 8/10 | Yes | 9250 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | price_objection | 0/10 | No | 16436 | 2 | 200 | NLU_INVALID_SCHEMA_CONSULTANT_ACTION_INTENT_MISMATCH |
| cline-pass/kimi-k3 | 2 | knowledge_routing | 7/10 | Yes | 15467 | 2 | 200 | — |
| cline-pass/kimi-k3 | 2 | waiting_context | 10/10 | Yes | 13732 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | gulf_family | 10/10 | Yes | 9097 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | egyptian_solo | 9/10 | Yes | 8333 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | iraqi_family | 10/10 | Yes | 5222 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | partial_round_trip | 10/10 | Yes | 6185 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | advice_during_search | 10/10 | Yes | 11160 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | frustrated_request | 10/10 | Yes | 3623 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | urgent_request | 10/10 | Yes | 3703 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | sarcasm_not_booking | 9/10 | Yes | 7787 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | indic_digits | 4/10 | Yes | 29541 | 2 | 200 | — |
| cline-pass/kimi-k3 | 2 | first_friday_next_month | 10/10 | Yes | 5501 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | child_age | 10/10 | Yes | 5269 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | explicit_rejection | 0/10 | No | 12858 | 2 | 200 | NLU_INVALID_SCHEMA_CONSULTANT_ACTION_INTENT_MISMATCH |
| cline-pass/kimi-k3 | 2 | payment_question | 10/10 | Yes | 14881 | 1 | 200 | — |
| cline-pass/kimi-k3 | 2 | delete_data | 10/10 | Yes | 6676 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | complete_trip | 10/10 | Yes | 3827 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | preserve_week | 10/10 | Yes | 4181 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | inquiry_not_selection | 8/10 | Yes | 20221 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | price_objection | 0/10 | No | 21909 | 2 | 200 | NLU_INVALID_SCHEMA_CONSULTANT_ACTION_INTENT_MISMATCH |
| cline-pass/kimi-k3 | 3 | knowledge_routing | 7/10 | Yes | 14054 | 2 | 200 | — |
| cline-pass/kimi-k3 | 3 | waiting_context | 10/10 | Yes | 10211 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | gulf_family | 10/10 | Yes | 6612 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | egyptian_solo | 9/10 | Yes | 5157 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | iraqi_family | 10/10 | Yes | 7765 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | partial_round_trip | 10/10 | Yes | 8691 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | advice_during_search | 10/10 | Yes | 14138 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | frustrated_request | 10/10 | Yes | 3436 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | urgent_request | 10/10 | Yes | 5471 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | sarcasm_not_booking | 10/10 | Yes | 15876 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | indic_digits | 10/10 | Yes | 4834 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | first_friday_next_month | 10/10 | Yes | 8137 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | child_age | 10/10 | Yes | 7826 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | explicit_rejection | 10/10 | Yes | 8442 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | payment_question | 10/10 | Yes | 9656 | 1 | 200 | — |
| cline-pass/kimi-k3 | 3 | delete_data | 10/10 | Yes | 10142 | 1 | 200 | — |

Synthetic metadata only: no keys, customer data, generated replies or model-setting writes. HTTP 401/402/429 stops the entire run immediately. Partial runs are not qualified. Owner review is required before production configuration changes.

## Execution evidence

Measured in an isolated temporary Render directory with the existing Cline key; no customer state or production settings changed. Source commit: `0013587034c15cb60ae47d8e487cf1427a058128`. The completed sanitized results were read at 2026-11-04T15:39:00.108Z. The production consultant model was verified as `cline-pass/kimi-k3` using allowlisted model metadata only.

A valid row is the final validated application decision, including a safe application fallback after rejected prose; its semantic score still counts all missed checks. Request counts include bounded format repair. This baseline precedes the new wording/action-contract guidance and must not be confused with verification of that fix.
