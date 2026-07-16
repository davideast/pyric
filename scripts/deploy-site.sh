#!/usr/bin/env bash
# Build the composed static Pyric site and deploy only Firebase Hosting.
#
# Uses the repo's firebase.json / .firebaserc configuration:
#   project: pyric-site
#   hosting site: pyric-site
#   public directory: dist/site

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIREBASE="$ROOT/node_modules/.bin/firebase"
SITE_ENTRYPOINT="$ROOT/dist/site/index.html"

if [ "$#" -ne 0 ]; then
  echo "usage: bash scripts/deploy-site.sh" >&2
  exit 2
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "deploy-site: bun is required" >&2
  exit 1
fi

if [ ! -x "$FIREBASE" ]; then
  echo "deploy-site: Firebase CLI is missing at $FIREBASE" >&2
  echo "Run \`bun install\` from the repo root first." >&2
  exit 1
fi

if [ ! -f "$ROOT/firebase.json" ]; then
  echo "deploy-site: missing $ROOT/firebase.json" >&2
  exit 1
fi

cd "$ROOT"

echo "━━━ Phase 1: build packages ━━━"
bun run build --packages-only

echo ""
echo "━━━ Phase 2: compose static site ━━━"
bash scripts/build-site.sh

if [ ! -f "$SITE_ENTRYPOINT" ]; then
  echo "deploy-site: build did not produce $SITE_ENTRYPOINT; refusing to deploy" >&2
  exit 1
fi

echo ""
echo "━━━ Phase 3: deploy Firebase Hosting ━━━"
"$FIREBASE" deploy --only hosting
