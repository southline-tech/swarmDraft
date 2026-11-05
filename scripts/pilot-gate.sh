#!/usr/bin/env bash
# One-shot pilot gate: jargon, prettier, full CI gate, evidence copy, commit/push, PR create.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${ROOT}/pilot-gate.log"
exec > >(tee -a "$LOG") 2>&1

NODE="${NODE:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE" ] && [ -x /usr/share/cursor/resources/app/resources/helpers/node ]; then
  NODE=/usr/share/cursor/resources/app/resources/helpers/node
fi
if [ -z "$NODE" ]; then
  echo "node not found; install Node 20+ or set NODE=" >&2
  exit 127
fi

if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi

echo "== branch =="
git branch --show-current
git status -sb

echo "== 1 copy jargon =="
"$NODE" scripts/check-copy-jargon.mjs

echo "== 2 prettier on changed files =="
BASE=main
if ! git rev-parse --verify main >/dev/null 2>&1; then
  BASE=origin/main
fi
CHANGED="$(git diff --name-only "${BASE}...HEAD" || true)"
echo "$CHANGED"
if [ -n "$CHANGED" ]; then
  # shellcheck disable=SC2086
  pnpm exec prettier --write $CHANGED
fi

echo "== 3 full gate =="
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
(
  cd apps/desktop/src-tauri
  cargo fmt --check
  cargo clippy -- -D warnings
  cargo test
)

echo "== 4 evidence screenshots =="
"$NODE" scripts/copy-34-41-evidence.mjs
ls -la "$ROOT/pr-evidence/34-41"

echo "== 5 commit and push =="
git add -A
if ! git diff --cached --quiet; then
  git commit -m "$(cat <<'EOF'
Add pilot gate evidence and apply Prettier on branch diff.

Collect release-checklist screenshots under pr-evidence/34-41/ and format changed files for #34 / #41 pilot gate.
EOF
)"
fi
git push -u origin feat/34-41-pilot-gate

echo "== 6 gh pr create (skip if exists) =="
if gh pr view feat/34-41-pilot-gate >/dev/null 2>&1; then
  gh pr view feat/34-41-pilot-gate --json url -q .url
else
  # Fill test-count table in pr-evidence/34-41/PR_BODY.md from step 3 output before create.
  gh pr create \
    --base main \
    --head feat/34-41-pilot-gate \
    --title "Copy deck, jargon CI, release checklist, and pilot gate (#34, #41)" \
    --body-file pr-evidence/34-41/PR_BODY.md
  gh pr view feat/34-41-pilot-gate --json url -q .url
fi
