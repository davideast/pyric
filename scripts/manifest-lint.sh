#!/usr/bin/env bash
# Static packaging-correctness gate for the publishable libraries.
#
# Three checks the consumer-install gate (packaging-test.sh) structurally can't do,
# because a runtime `import()` never looks at the `types` condition and can't see a
# missing export:
#   1. publint   — package.json publishing correctness (exports condition ORDER,
#                  files coverage, missing-file targets, deprecated fields).
#   2. attw      — @arethetypeswrong/cli: every export resolves to types + JS for a
#                  modern ESM consumer (`node16 from ESM`). Run under the `esm-only`
#                  profile: the package is ESM-only by design, so node10 +
#                  CJS-resolution "failures"
#                  are EXPECTED and ignored; a regression in the ESM path still fails.
#   3. check-exports.mjs — exports ↔ dist drift, both directions.
#
# Fast + flake-free (pure static analysis over the built packages — no network, no
# server). Requires the packages to be BUILT first (`bun run build`).
#
# Run: bash scripts/manifest-lint.sh   (or: npm run lint:manifest)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The four publishable libraries. @pyric/studio is embedded into @pyric/cli for
# `pyric dev --ui`, not published as part of this pack gate.
PACKAGES=(pyric pyric-admin pyric-tools ui)
ATTW="$ROOT/node_modules/.bin/attw"
PUBLINT="$ROOT/node_modules/.bin/publint"

for tool in "$ATTW" "$PUBLINT"; do
  [ -x "$tool" ] || { echo "✗ $tool not found — run 'bun install'" >&2; exit 1; }
done
for p in "${PACKAGES[@]}"; do
  [ -d "packages/$p/dist" ] || { echo "✗ packages/$p/dist missing — run 'bun run build' first" >&2; exit 1; }
done

fail=0
LOG="$(mktemp -d)"
trap 'rm -rf "$LOG"' EXIT

# Quiet on success, full detail on failure — a green gate shouldn't bury the log.
echo "━━━ publint (publishing correctness) ━━━"
for p in "${PACKAGES[@]}"; do
  if "$PUBLINT" "packages/$p" > "$LOG/publint-$p.txt" 2>&1; then
    echo "  ✓ $p"
  else
    echo "  ✗ $p"; cat "$LOG/publint-$p.txt"; fail=1
  fi
done

echo ""
echo "━━━ attw (types resolve for ESM consumers; esm-only profile) ━━━"
for p in "${PACKAGES[@]}"; do
  if "$ATTW" --pack "packages/$p" --profile esm-only > "$LOG/attw-$p.txt" 2>&1; then
    echo "  ✓ $p"
  else
    echo "  ✗ $p — types resolution problems:"; cat "$LOG/attw-$p.txt"; fail=1
  fi
done

echo ""
echo "━━━ exports ↔ dist drift ━━━"
node "$ROOT/scripts/lib/check-exports.mjs" --all || fail=1

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✗ manifest-lint FAILED — see above" >&2
  exit 1
fi
echo "✓ manifest-lint PASS — publint + attw + exports drift clean for all ${#PACKAGES[@]} packages"
