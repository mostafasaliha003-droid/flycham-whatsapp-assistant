#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-main}
port=${2:-3300}
node_bin=${ISOLATED_NODE:-$(command -v node)}
deps=${ISOLATED_NODE_MODULES:-}
if [[ -z "$deps" ]]; then
  if [[ -d "$root/test-build/node_modules" ]]; then deps="$root/test-build/node_modules";
  else echo 'Set ISOLATED_NODE_MODULES to an existing verified dependency directory, or complete npm ci in test-build first.' >&2; exit 2; fi
fi
runtime=$(mktemp -d "$root/local-runtime-XXXXXX")
mkdir -p "$runtime/home" "$runtime/tmp"
exec env -i PATH="$PATH" HOME="$runtime/home" TMPDIR="$runtime/tmp" \
  NODE_PATH="$deps" NODE_OPTIONS="--require=$root/test-tools/offline-loopback-guard.cjs" \
  OFFLINE_GUARD_LOG="$runtime/blocked.jsonl" NODE_ENV=production \
  DRY_RUN=true SAUDI_VISA_ENABLED=false RAAD_VISA_AUTOMATION_ENABLED=false \
  FARE_CATALOG_ENABLED=false CONSULTANT_ORCHESTRATOR_ENABLED=false \
  ASSISTANT_STATE_PATH="$runtime/assistant-state.enc" ASSISTANT_STATE_KEY=isolated_state_key_not_a_real_secret_123456789 \
  SAUDI_VISA_PRIVATE_PATH="$runtime/no-private-config.enc" PORT="$port" \
  "$node_bin" "$root/test-tools/local-entry.cjs" "$mode"
