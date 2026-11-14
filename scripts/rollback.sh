#!/usr/bin/env bash
# Roll production back to an earlier Worker version.
#
# Usage: scripts/rollback.sh [--dry-run] [<version-id>]
#   <version-id>  version to restore; defaults to the one serving before the latest deployment
#   --dry-run     resolve the target and print the rollback command without running it
#
# Needs Cloudflare credentials (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in CI, or `wrangler login`).
set -euo pipefail
cd "$(dirname "$0")/../apps/worker"

dry_run=0
target=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) target="$arg" ;;
  esac
done

if [[ -z "$target" ]]; then
  # Deployments come back oldest first; the target is the 100% version of the one before the latest.
  target=$(pnpm exec wrangler deployments list --json | node -e '
    const deployments = JSON.parse(require("fs").readFileSync(0, "utf8"))
      .sort((a, b) => a.created_on.localeCompare(b.created_on));
    const previous = deployments.at(-2);
    if (!previous) { console.error("No previous deployment to roll back to."); process.exit(1); }
    const top = [...previous.versions].sort((a, b) => b.percentage - a.percentage)[0];
    console.log(top.version_id);
  ')
fi

cmd=(pnpm exec wrangler rollback "$target" --message "Automatic rollback: post-deploy smoke tests failed" --yes)
if [[ "$dry_run" == 1 ]]; then
  echo "[dry run] would roll production back to version $target"
  echo "[dry run] would run: ${cmd[*]}"
else
  echo "Rolling production back to version $target"
  "${cmd[@]}"
fi
