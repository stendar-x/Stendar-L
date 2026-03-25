#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST_PATH="${1:-$ROOT_DIR/security/collateral-listings/mainnet.json}"
PROGRAM_ID="${STENDAR_PROGRAM_ID:-${SOLANA_PROGRAM_ID:-}}"
if [[ -z "$PROGRAM_ID" ]]; then
  PROGRAM_ID="$(node -e "const fs=require('fs');const p='$ROOT_DIR/target/idl/stendar.json';const idl=JSON.parse(fs.readFileSync(p,'utf8'));const id=idl.address||(idl.metadata&&idl.metadata.address)||'';if(!id){process.exit(1)};process.stdout.write(id);" 2>/dev/null || true)"
fi
if [[ -z "$PROGRAM_ID" ]]; then
  echo "[listing-gate] Unable to resolve program id from env or target/idl/stendar.json" >&2
  exit 1
fi

VALIDATE_EXTRA_ARGS=()
if [[ "${SKIP_FEED_HEALTH_CHECK:-false}" == "true" ]]; then
  VALIDATE_EXTRA_ARGS+=(--skip-feed-health-check)
fi
if [[ "${SKIP_ENV_PARITY:-false}" == "true" ]]; then
  VALIDATE_EXTRA_ARGS+=(--skip-env-parity)
fi
if [[ -n "${MAX_FEED_AGE_SECONDS:-}" ]]; then
  VALIDATE_EXTRA_ARGS+=(--max-feed-age-seconds "$MAX_FEED_AGE_SECONDS")
fi
if [[ -n "${MAX_CONFIDENCE_RATIO:-}" ]]; then
  VALIDATE_EXTRA_ARGS+=(--max-confidence-ratio "$MAX_CONFIDENCE_RATIO")
fi

echo "[listing-gate] Using manifest: $MANIFEST_PATH"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "[listing-gate] Manifest not found: $MANIFEST_PATH" >&2
  exit 1
fi

echo "[listing-gate] 1/5 Checking IDL sync..."
node "$ROOT_DIR/scripts/check-idl-sync.js"

echo "[listing-gate] 2/5 Validating manifest against chain/env parity..."
npx ts-node "$ROOT_DIR/scripts/validate-collateral-listing.ts" \
  --manifest "$MANIFEST_PATH" \
  --registry-source chain \
  --program-id "$PROGRAM_ID" \
  "${VALIDATE_EXTRA_ARGS[@]}"

echo "[listing-gate] 3/5 Running idempotent apply dry-run..."
npx ts-node "$ROOT_DIR/scripts/apply-collateral-manifest.ts" \
  --manifest "$MANIFEST_PATH"

echo "[listing-gate] 4/5 Running backend listing integration checks..."
(
  cd "$ROOT_DIR/app/backend"
  npx jest \
    __tests__/collateral.listing-validation.integration.test.ts \
    __tests__/contracts.create.flow.integration.test.ts \
    --runInBand
)

if [[ "${SKIP_MVP_E2E:-false}" == "true" ]]; then
  echo "[listing-gate] 5/5 Skipping MVP e2e flow (SKIP_MVP_E2E=true)"
else
  echo "[listing-gate] 5/5 Running MVP e2e flow script..."
  "$ROOT_DIR/scripts/run-mvp-e2e-flow.sh"
fi

echo "[listing-gate] Gate passed."
