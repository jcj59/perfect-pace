#!/usr/bin/env bash
# After a production deploy: wait for the new version to serve, run the @smoke suite against
# production, and if it fails roll back to the previous version and open an issue.
#
# Usage: scripts/post-deploy-smoke.sh <production-url> <deployed-version-id> [<previous-version-id>]
# Env:
#   DRY_RUN=1             print the rollback command and the issue instead of acting
#   PP_FORCE_SMOKE_FAIL=1 make the smoke suite fail on purpose (to exercise this path)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
url="${1:?production url}"
deployed="${2:?deployed version id}"
previous="${3:-}"
dry=()
[[ "${DRY_RUN:-0}" == 1 ]] && dry=(--dry-run)

echo "Waiting for $url to serve version $deployed"
for _ in $(seq 1 24); do
  if curl -fsS "$url/api/health" | grep -q "\"version\":\"$deployed\""; then
    echo "Version $deployed is live"
    break
  fi
  sleep 5
done

if PP_BASE_URL="$url" PP_EXPECT_VERSION="$deployed" pnpm --dir "$root/e2e" exec playwright test --grep @smoke; then
  echo "Production smoke tests passed"
  exit 0
fi

echo "Production smoke tests failed; rolling back"
bash "$root/scripts/rollback.sh" "${dry[@]}" ${previous:+"$previous"}

run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-local}"
title="Production smoke tests failed for version $deployed (rolled back)"
body="The post-deploy smoke suite failed against $url for Worker version \`$deployed\`, so production was rolled back to \`${previous:-the previous version}\`.

Run: $run_url"
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  echo "[dry run] would open issue: $title"
  echo "$body"
else
  gh issue create --title "$title" --body "$body"
fi
exit 1
