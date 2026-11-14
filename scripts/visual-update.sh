#!/usr/bin/env bash
# Regenerate Playwright screenshot baselines in the official Linux Playwright container, the
# same image CI compares in, so baselines match across machines.
#
# Usage:
#   pnpm visual:update        run in local Docker (no files from the container touch your
#                             checkout except the new baselines)
#   pnpm visual:update --ci   no Docker: label this branch's PR `visual-update`, which runs the
#                             "Visual baselines" workflow, then download its baselines here
#
# Either way, commit the result and give the reason for the change in the PR description.
set -euo pipefail
cd "$(dirname "$0")/.."

shots="e2e/tests/__screenshots__"
pw_version=$(node -p 'require("./e2e/package.json").devDependencies["@playwright/test"]')
pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
image="mcr.microsoft.com/playwright:v${pw_version}-noble"

if [[ "${1:-}" == "--ci" ]]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  head=$(git rev-parse HEAD)
  if [[ "$head" != "$(git rev-parse "origin/$branch" 2>/dev/null)" ]]; then
    echo "Push $branch first: the workflow runs on the pushed commit." >&2
    exit 1
  fi
  pr=$(gh pr view "$branch" --json number --jq .number) || { echo "Open a PR for $branch first." >&2; exit 1; }
  label=visual-update
  gh label create "$label" --color BFD4F2 --description "Regenerate Playwright visual baselines" 2>/dev/null || true
  gh pr edit "$pr" --remove-label "$label" >/dev/null 2>&1 || true
  gh pr edit "$pr" --add-label "$label" >/dev/null
  run_id=""
  for _ in $(seq 1 30); do
    # Filter by name rather than --workflow, which only resolves workflows already on main.
    run_id=$(gh run list --commit "$head" --event pull_request --limit 20 --json databaseId,status,workflowName \
      --jq '[.[] | select(.workflowName == "Visual baselines" and .status != "completed")][0].databaseId // empty')
    [[ -n "$run_id" ]] && break
    sleep 3
  done
  [[ -n "$run_id" ]] || { echo "Could not find the workflow run." >&2; exit 1; }
  gh run watch "$run_id" --exit-status
  gh pr edit "$pr" --remove-label "$label" >/dev/null || true
  rm -rf "$shots"
  gh run download "$run_id" --name visual-baselines --dir "$shots"
  git status --short "$shots"
  exit 0
fi

if ! command -v docker >/dev/null; then
  echo "Docker not found. Install it, or run: pnpm visual:update --ci" >&2
  exit 1
fi

# Ship the tracked sources into the container on stdin and get only the baselines back on stdout.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -z --cached --others --exclude-standard | tar -cf - --null -T - |
  docker run --rm -i --ipc=host -e CI=1 -e WRANGLER_SEND_METRICS=false "$image" bash -euc "
    mkdir -p /work && cd /work && tar -xf - >&2
    rm -rf $shots
    { npx -y pnpm@$pnpm_version install --frozen-lockfile && npx -y pnpm@$pnpm_version build &&
      npx -y pnpm@$pnpm_version --dir e2e exec playwright test --grep @visual --update-snapshots=all; } >&2
    tar -cf - -C $shots .
  " >"$tmp/shots.tar"
rm -rf "$shots"
mkdir -p "$shots"
tar -xf "$tmp/shots.tar" -C "$shots"
git status --short "$shots"
